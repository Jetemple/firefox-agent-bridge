#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createRelay, DEFAULT_PORT, DEFAULT_HOST, DEFAULT_TIMEOUT_MS } from "./ws-relay.mjs";
import { createBridge } from "./bridge.mjs";
import { createBridgeHttpServer } from "./http-server.mjs";
import { sseInsecureWarning } from "./sse-auth.mjs";
import { loadOrCreateToken, DEFAULT_TOKEN_PATH } from "../scripts/secure-config.mjs";
import { execSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
// stdout is reserved exclusively for the MCP StdioServerTransport. Any stray
// stdout write corrupts the JSON-RPC stream, so route accidental console.log /
// console.info to stderr. Explicit diagnostics use logErr().
console.log = (...args) => console.error(...args);
console.info = (...args) => console.error(...args);

function logErr(message) {
  process.stderr.write(`[firefox-mcp-bridge] ${message}\n`);
}

function killStaleBridge(port) {
  try {
    const out = execSync(`lsof -tiTCP:${port} -sTCP:LISTEN`, { encoding: "utf8" });
    const pids = out
      .trim()
      .split("\n")
      .map(Number)
      .filter((p) => p && p !== process.pid);
    for (const pid of pids) {
      try {
        process.kill(pid, "SIGTERM");
        logErr(`killed stale bridge PID ${pid}`);
      } catch {}
    }
    return pids.length > 0;
  } catch {
    return false;
  }
}

// Ownership = BOTH ports. A WS-only bridge would be invisible to /health
// probes and would get killed by the next instance as a "zombie", so if the
// HTTP port can't be bound the instance must not own the relay either.
export async function startOwner(config, fileToken, { startedAt = Date.now(), log = () => {} } = {}) {
  const relay = createRelay({
    port: config.port,
    host: config.host,
    timeoutMs: config.timeoutMs,
    allowAnyOrigin: config.allowAnyOrigin,
    log,
  });
  await relay.ready; // rejects with code EADDRINUSE when the WS port is taken
  const { server, closeAllSessions } = createBridgeHttpServer({
    relay,
    startedAt,
    fileToken,
    envToken: config.sseToken,
    log,
  });
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(config.ssePort, config.sseHost, resolve);
    });
  } catch (err) {
    await relay.close();
    const e = new Error(
      `cannot bind HTTP port ${config.ssePort} (${err?.code ?? err}); ` +
        `ownership requires both ports — free it or set FIREFOX_BRIDGE_SSE_PORT`,
    );
    e.code = "HTTP_BIND_FAILED";
    throw e;
  }
  return {
    relay,
    server,
    closeAllSessions,
    close: async () => {
      await closeAllSessions();
      await new Promise((r) => server.close(r));
      await relay.close();
    },
  };
}

export function readConfig(env = process.env) {
  const port = env.FIREFOX_BRIDGE_WS_PORT ? Number(env.FIREFOX_BRIDGE_WS_PORT) : DEFAULT_PORT;
  const host = env.FIREFOX_BRIDGE_WS_HOST || DEFAULT_HOST;
  const timeoutMs = env.FIREFOX_BRIDGE_WS_TIMEOUT_MS
    ? Number(env.FIREFOX_BRIDGE_WS_TIMEOUT_MS)
    : DEFAULT_TIMEOUT_MS;
  const ssePort = env.FIREFOX_BRIDGE_SSE_PORT ? Number(env.FIREFOX_BRIDGE_SSE_PORT) : 3003;
  // Bind loopback by default: the SSE endpoint can drive the logged-in browser,
  // so it must not be reachable from the network unless deliberately exposed
  // (FIREFOX_BRIDGE_SSE_HOST=0.0.0.0) and protected with a token.
  const sseHost = env.FIREFOX_BRIDGE_SSE_HOST || "127.0.0.1";
  const sseToken = env.FIREFOX_BRIDGE_SSE_TOKEN || null;
  // Escape hatch: re-allow web-page Origins on the WS relay (default: blocked).
  const allowAnyOrigin =
    env.FIREFOX_BRIDGE_WS_ALLOW_ANY_ORIGIN === "1" ||
    env.FIREFOX_BRIDGE_WS_ALLOW_ANY_ORIGIN === "true";
  const tokenFile = env.FIREFOX_BRIDGE_TOKEN_FILE || DEFAULT_TOKEN_PATH;
  return { port, host, timeoutMs, ssePort, sseHost, sseToken, allowAnyOrigin, tokenFile };
}

async function main() {
  const config = readConfig();
  // The local token is ALWAYS provisioned: /dispatch requires it even in
  // loopback-only mode (a web page can fire no-preflight POSTs at localhost;
  // it cannot read this 0600 file). The env token (sseToken) governs /mcp only.
  const fileToken = loadOrCreateToken({ tokenPath: config.tokenFile });
  const standalone = !!process.env.FIREFOX_BRIDGE_STANDALONE || process.stdin.isTTY === true;
  // startedAt must be fixed before startOwner: it seeds the /health uptime.
  const startedAt = Date.now();

  // Interim ownership (follower mode arrives in Task 5): keep bindOrRetry's
  // kill-then-retry semantics, but through startOwner so BOTH ports are claimed
  // together. Only a WS-port EADDRINUSE triggers the retry; an HTTP bind failure
  // (HTTP_BIND_FAILED, WS already released) is fatal with an actionable message.
  let owner;
  try {
    owner = await startOwner(config, fileToken, { startedAt, log: logErr });
  } catch (err) {
    if (err?.code !== "EADDRINUSE") {
      logErr(`fatal: ${err?.message ?? err}`);
      process.exit(1);
    }
    logErr("port in use — killing stale bridge instance");
    killStaleBridge(config.port);
    await delay(800);
    try {
      owner = await startOwner(config, fileToken, { startedAt, log: logErr });
    } catch (err2) {
      logErr(`fatal: ${err2?.message ?? err2}`);
      process.exit(1);
    }
  }
  const relay = owner.relay;
  logErr(`listening on ws://${config.host}:${relay.port} (per-request timeout ${config.timeoutMs}ms)`);
  logErr(`HTTP endpoint at http://${config.sseHost}:${config.ssePort} (/mcp, /health, /dispatch)`);
  const warning = sseInsecureWarning({ sseHost: config.sseHost, sseToken: config.sseToken });
  if (warning) logErr(`⚠ ${warning}`);

  // standalone gates only the stdio transport now; HTTP is mandatory for everyone.
  let server = null;
  let transport = null;
  if (!standalone) {
    server = createBridge({ relay, startedAt });
    transport = new StdioServerTransport();
  }

  let shuttingDown = false;
  async function shutdown(reason) {
    if (shuttingDown) return;
    shuttingDown = true;
    logErr(`shutting down (${reason})`);
    setTimeout(() => process.exit(0), 1000).unref();
    try {
      await owner.close();
      if (server) await server.close();
    } catch (err) {
      logErr(`error during shutdown: ${err?.message ?? err}`);
    }
    process.exit(0);
  }

  if (!standalone) {
    process.stdin.on("end", () => shutdown("stdin end"));
    process.stdin.on("close", () => shutdown("stdin close"));
    transport.onclose = () => shutdown("transport close");
    await server.connect(transport);
  }

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGHUP", () => shutdown("SIGHUP"));

  if (standalone) {
    logErr("standalone mode — running HTTP only, Ctrl+C to stop");
    await new Promise(() => {});
  }
}

// Only start the bridge when run as a script (`node index.mjs`). When imported
// by tests, expose the helpers below without binding any port or spawning main.
function invokedDirectly() {
  try {
    return (
      !!process.argv[1] &&
      realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
    );
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  main().catch((err) => {
    logErr(`fatal: ${err?.stack ?? err}`);
    process.exit(1);
  });
}

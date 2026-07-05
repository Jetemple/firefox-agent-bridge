#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createRelay, DEFAULT_PORT, DEFAULT_HOST, DEFAULT_TIMEOUT_MS } from "./ws-relay.mjs";
import { createBridge, SERVER_VERSION } from "./bridge.mjs";
import { createBridgeHttpServer, HEALTH_NAME } from "./http-server.mjs";
import { createRemoteRelay, createSwitchableRelay } from "./remote-relay.mjs";
import { sseInsecureWarning } from "./sse-auth.mjs";
import { loadOrCreateToken, DEFAULT_TOKEN_PATH } from "../scripts/secure-config.mjs";
import { execSync } from "node:child_process";
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

// Enumerate the processes listening on `port`, pairing each lsof PID with its
// full `ps` command line so callers can tell a bridge instance apart from an
// unrelated program that happens to hold the port.
export function inspectPortHolders(port, { execFn = execSync } = {}) {
  let out = "";
  try {
    out = String(execFn(`lsof -tiTCP:${port} -sTCP:LISTEN`, { encoding: "utf8" }));
  } catch {
    return [];
  }
  const pids = out
    .trim()
    .split("\n")
    .map(Number)
    .filter((p) => p && p !== process.pid);
  return pids.map((pid) => {
    let command = "";
    try {
      command = String(execFn(`ps -o command= -p ${pid}`, { encoding: "utf8" })).trim();
    } catch {
      /* pid vanished */
    }
    return { pid, command };
  });
}

// Only ever SIGTERM a process we can prove is another bridge instance.
export function isBridgeCommand(command) {
  return /firefox-mcp-bridge[/\\]index\.mjs/.test(command ?? "");
}

export function killStaleBridge(
  port,
  { execFn = execSync, killFn = (pid, sig) => process.kill(pid, sig), log = () => {} } = {},
) {
  const killed = [];
  const foreign = [];
  for (const { pid, command } of inspectPortHolders(port, { execFn })) {
    if (isBridgeCommand(command)) {
      try {
        killFn(pid, "SIGTERM");
        killed.push(pid);
        log(`killed stale bridge PID ${pid}`);
      } catch {
        /* already gone */
      }
    } else {
      foreign.push(pid);
    }
  }
  return { killed, foreign };
}

export async function probeBridgeHealth({ ssePort, sseHost = "127.0.0.1", fetchFn = fetch } = {}) {
  try {
    const res = await fetchFn(`http://${sseHost}:${ssePort}/health`, {
      signal: AbortSignal.timeout(1500),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
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

  // shuttingDown is hoisted above requestPromotion so a poll tick that fires
  // during shutdown can't kick off a doomed promotion.
  let shuttingDown = false;
  let ownerParts = null;
  let role = null;
  let requestPromotion = () => {}; // bound after the façade exists

  // Claim BOTH ports and start serving as the owner. Also used by promotion.
  async function becomeOwner() {
    ownerParts = await startOwner(config, fileToken, { startedAt, log: logErr });
    role = "owner";
    logErr(
      `listening on ws://${config.host}:${ownerParts.relay.port} (per-request timeout ${config.timeoutMs}ms)`,
    );
    logErr(`HTTP endpoint at http://${config.sseHost}:${config.ssePort} (/mcp, /health, /dispatch)`);
    const warning = sseInsecureWarning({ sseHost: config.sseHost, sseToken: config.sseToken });
    if (warning) logErr(`⚠ ${warning}`);
    return ownerParts.relay;
  }

  let inner;
  try {
    inner = await becomeOwner();
  } catch (err) {
    if (err?.code === "HTTP_BIND_FAILED") {
      logErr(err.message);
      process.exit(1);
    }
    if (err?.code !== "EADDRINUSE") {
      logErr(`fatal: ${err?.message ?? err}`);
      process.exit(1);
    }
    // WS port is taken. Probe /health: a healthy bridge means we follow it; an
    // unresponsive one means the holder is stale (kill it) or foreign (bail).
    const health = await probeBridgeHealth({ ssePort: config.ssePort, sseHost: "127.0.0.1" });
    if (health?.name === HEALTH_NAME) {
      if (standalone) {
        logErr(`bridge already running (pid ${health.pid}) — nothing to do`);
        process.exit(0);
      }
      if (health.version !== SERVER_VERSION) {
        logErr(
          `⚠ owner is version ${health.version}, this instance is ${SERVER_VERSION} — tool lists may drift`,
        );
      }
      role = "follower";
      inner = createRemoteRelay({
        ssePort: config.ssePort,
        token: fileToken,
        onConnectionLost: () => requestPromotion(),
        log: logErr,
      });
      await inner.probe(); // seed extensionConnected so clientCount() is honest immediately
      logErr(`following existing bridge (pid ${health.pid})`);
    } else {
      // Never kill on startup: the holder may be an older live bridge, a
      // bridge whose HTTP side failed, or a foreign process. Only an explicit
      // `ff start --replace` may SIGTERM a positively identified bridge PID.
      const holders = inspectPortHolders(config.port);
      const held = holders.length
        ? holders.map(({ pid, command }) => `pid ${pid} (${command || "unknown"})`).join(", ")
        : "an unknown process";
      logErr(
        `port ${config.port} is in use by ${held} but no bridge answered on ` +
          `http://127.0.0.1:${config.ssePort}/health — refusing to kill it. ` +
          "Run `ff start --replace` to replace a stale bridge, free the port, " +
          "or set FIREFOX_BRIDGE_WS_PORT",
      );
      process.exit(1);
    }
  }

  // createBridge and the (owner) HTTP server both close over this façade, so
  // promotion can swap RemoteRelay -> local WS relay without touching sessions.
  const relay = createSwitchableRelay(inner);

  // Promote a follower to owner once the previous owner disappears. Idempotent:
  // onConnectionLost can fire many times per outage (per failed dispatch + per
  // poll tick), so guard on `promoting`, the current role, and shutdown.
  let promoting = false;
  requestPromotion = async () => {
    if (promoting || role === "owner" || shuttingDown) return;
    promoting = true;
    try {
      const newRelay = await becomeOwner(); // throws EADDRINUSE if another follower won
      const old = relay.swap(newRelay);
      try {
        await old.close();
      } catch {
        /* ignore */
      }
      logErr("promoted to owner — waiting for the extension to reconnect");
    } catch (err) {
      if (err?.code !== "EADDRINUSE") logErr(`promotion failed: ${err?.message ?? err}`);
      // Lost the race (or transient) — stay follower. RemoteRelay targets the
      // fixed port, so the new owner is reached automatically on the next poll.
    } finally {
      promoting = false;
    }
  };

  // standalone gates only the stdio transport now; HTTP is mandatory for everyone.
  let server = null;
  let transport = null;
  if (!standalone) {
    server = createBridge({ relay, startedAt });
    transport = new StdioServerTransport();
  }

  async function shutdown(reason) {
    if (shuttingDown) return;
    shuttingDown = true;
    logErr(`shutting down (${reason})`);
    setTimeout(() => process.exit(0), 1000).unref();
    try {
      // Reflect post-promotion state: an owner (original or promoted) owns
      // ownerParts; a follower only holds the RemoteRelay behind the façade.
      if (role === "owner" && ownerParts) await ownerParts.close();
      else await relay.close();
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

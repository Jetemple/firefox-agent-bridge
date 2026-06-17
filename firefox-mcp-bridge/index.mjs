#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createRelay, DEFAULT_PORT, DEFAULT_HOST, DEFAULT_TIMEOUT_MS } from "./ws-relay.mjs";
import { createBridge } from "./bridge.mjs";
import { execSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
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

async function bindOrRetry(port, host, timeoutMs) {
  let relay = createRelay({ port, host, timeoutMs, log: logErr });
  try {
    await relay.ready;
    return relay;
  } catch (err) {
    if (!err || err.code !== "EADDRINUSE") throw err;
  }

  logErr("port in use — killing stale bridge instance");
  killStaleBridge(port);
  await delay(800);

  relay = createRelay({ port, host, timeoutMs, log: logErr });
  await relay.ready;
  return relay;
}

function readConfig(env = process.env) {
  const port = env.FIREFOX_BRIDGE_WS_PORT ? Number(env.FIREFOX_BRIDGE_WS_PORT) : DEFAULT_PORT;
  const host = env.FIREFOX_BRIDGE_WS_HOST || DEFAULT_HOST;
  const timeoutMs = env.FIREFOX_BRIDGE_WS_TIMEOUT_MS
    ? Number(env.FIREFOX_BRIDGE_WS_TIMEOUT_MS)
    : DEFAULT_TIMEOUT_MS;
  const ssePort = env.FIREFOX_BRIDGE_SSE_PORT ? Number(env.FIREFOX_BRIDGE_SSE_PORT) : 3003;
  const sseHost = env.FIREFOX_BRIDGE_SSE_HOST || "0.0.0.0";
  return { port, host, timeoutMs, ssePort, sseHost };
}

async function main() {
  const { port, host, timeoutMs, ssePort, sseHost } = readConfig();
  const standalone = !!process.env.FIREFOX_BRIDGE_STANDALONE || process.stdin.isTTY === true;

  let relay;
  try {
    relay = await bindOrRetry(port, host, timeoutMs);
    logErr(`listening on ws://${host}:${relay.port} (per-request timeout ${timeoutMs}ms)`);
  } catch (err) {
    logErr(`WebSocket server failed to start: ${err?.message ?? err}`);
    process.exit(1);
  }

  const startedAt = Date.now();
  let server = null;
  let transport = null;

  if (!standalone) {
    server = createBridge({ relay, startedAt });
    transport = new StdioServerTransport();
  }

  let sseServer = null;
  let sseTransport = null;
  let sseHttpServer = null;

  try {
    sseTransport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
    });
    sseServer = createBridge({ relay, startedAt });
    await sseServer.connect(sseTransport);

    sseHttpServer = createServer((req, res) => {
      sseTransport.handleRequest(req, res);
    });

    await new Promise((resolve, reject) => {
      sseHttpServer.once("error", reject);
      sseHttpServer.listen(ssePort, sseHost, resolve);
    });

    logErr(`SSE endpoint at http://${sseHost}:${ssePort}/mcp`);
  } catch (err) {
    if (sseHttpServer) {
      try { sseHttpServer.close(); } catch {}
      sseHttpServer = null;
    }
    if (err?.code === "EADDRINUSE") {
      logErr(`SSE port ${ssePort} in use — running without SSE transport`);
    } else {
      logErr(`SSE transport failed: ${err?.message ?? err} — running without SSE`);
    }
    sseServer = null;
    sseTransport = null;
    if (standalone) {
      logErr("standalone mode requires SSE, exiting");
      process.exit(1);
    }
  }

  let shuttingDown = false;
  async function shutdown(reason) {
    if (shuttingDown) return;
    shuttingDown = true;
    logErr(`shutting down (${reason})`);
    setTimeout(() => process.exit(0), 1000).unref();
    try {
      if (sseTransport) await sseTransport.close();
      if (sseHttpServer) await new Promise((r) => sseHttpServer.close(r));
      if (sseServer) await sseServer.close();
      await relay.close();
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
    logErr("standalone mode — running SSE only, Ctrl+C to stop");
    await new Promise(() => {});
  }
}

main().catch((err) => {
  logErr(`fatal: ${err?.stack ?? err}`);
  process.exit(1);
});

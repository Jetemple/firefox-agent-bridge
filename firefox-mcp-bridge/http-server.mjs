import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { TOOLS } from "./tools.mjs";
import { isSseAuthorized } from "./sse-auth.mjs";
import { isAllowedWsOrigin } from "./ws-relay.mjs";
import { createBridge, SERVER_VERSION } from "./bridge.mjs";

export const HEALTH_NAME = "firefox-mcp-bridge";
export const MAX_DISPATCH_TIMEOUT_MS = 120000;
const MAX_BODY_BYTES = 2 * 1024 * 1024;

// Zod validators per dispatchable tool. ping_firefox is bridge-local (answered
// by createBridge, never relayed), so it is deliberately absent — /dispatch
// callers use /health + get_tabs_summary instead.
const DISPATCH_SCHEMAS = new Map(
  TOOLS.filter((t) => t.name !== "ping_firefox").map((t) => [
    t.name,
    t.inputSchema ? z.object(t.inputSchema) : z.object({}),
  ]),
);

export function isLoopbackAddress(addr) {
  return addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1";
}

// /dispatch defenses, layered. Loopback-only is NOT sufficient on its own: a
// web page can fire a no-preflight "simple" POST (text/plain) at localhost,
// and the browser itself is a loopback caller. Hence: token always (the 0600
// file is unreadable to pages), Origin guard, strict JSON content type, and
// loopback source as defense in depth.
export function checkDispatchAccess(req, { fileToken, envToken = null } = {}) {
  if (!isLoopbackAddress(req.socket?.remoteAddress)) {
    return { ok: false, status: 403, message: "dispatch is loopback-only; remote clients must use /mcp" };
  }
  if (!isAllowedWsOrigin(req.headers?.origin)) {
    return { ok: false, status: 403, message: "web-page origins may not call /dispatch" };
  }
  const ct = String(req.headers?.["content-type"] ?? "").split(";")[0].trim().toLowerCase();
  if (ct !== "application/json") {
    return { ok: false, status: 415, message: "content-type must be application/json" };
  }
  const authorized =
    (fileToken ? isSseAuthorized(fileToken, req) : false) ||
    (envToken ? isSseAuthorized(envToken, req) : false);
  if (!authorized) {
    return { ok: false, status: 401, message: "missing or invalid token" };
  }
  return { ok: true };
}

export function validateDispatchBody(body) {
  const tool = body?.tool;
  const schema = typeof tool === "string" ? DISPATCH_SCHEMAS.get(tool) : undefined;
  if (!schema) return { ok: false, message: `unknown tool: ${String(tool)}` };
  const parsed = schema.safeParse(body?.args ?? {});
  if (!parsed.success) {
    return { ok: false, message: `invalid args for ${tool}: ${parsed.error.issues.map((i) => i.message).join("; ")}` };
  }
  let timeoutMs;
  if (body?.timeoutMs != null) {
    const n = Number(body.timeoutMs);
    if (!Number.isFinite(n) || n < 1) return { ok: false, message: "timeoutMs must be a positive number" };
    timeoutMs = Math.min(n, MAX_DISPATCH_TIMEOUT_MS);
  }
  return { ok: true, tool, args: parsed.data, timeoutMs };
}

function sendJson(res, status, obj) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

// One HTTP server for /health, /dispatch, and per-session /mcp. `relay` may be
// the local WS relay or the SwitchableRelay façade — same interface.
export function createBridgeHttpServer({ relay, startedAt = Date.now(), fileToken, envToken = null, log = () => {} }) {
  if (!fileToken) throw new Error("createBridgeHttpServer requires a non-empty fileToken");
  const sessions = new Map(); // mcp-session-id -> StreamableHTTPServerTransport

  async function handleDispatch(req, res) {
    const access = checkDispatchAccess(req, { fileToken, envToken });
    if (!access.ok) return sendJson(res, access.status, { error: { code: "FORBIDDEN", message: access.message } });
    let body;
    try {
      body = JSON.parse(await readBody(req));
    } catch {
      return sendJson(res, 400, { error: { code: "BAD_REQUEST", message: "body must be JSON" } });
    }
    const v = validateDispatchBody(body);
    if (!v.ok) return sendJson(res, 400, { error: { code: "BAD_REQUEST", message: v.message } });
    try {
      const result = await relay.dispatch(v.tool, v.args, v.timeoutMs ? { timeoutMs: v.timeoutMs } : undefined);
      return sendJson(res, 200, { result });
    } catch (err) {
      // Tool-level failures (NO_CLIENT, WS_TIMEOUT, extension errors) are 200
      // with { error } — the transport worked; the tool call didn't.
      return sendJson(res, 200, {
        error: { code: err?.code ?? "INTERNAL", message: err?.message ?? String(err) },
      });
    }
  }

  async function handleMcp(req, res) {
    if (!isSseAuthorized(envToken, req)) {
      return sendJson(res, 401, { error: "unauthorized" });
    }
    let body;
    if (req.method === "POST") {
      try {
        body = JSON.parse(await readBody(req));
      } catch {
        return sendJson(res, 400, {
          jsonrpc: "2.0",
          error: { code: -32700, message: "Parse error" },
          id: null,
        });
      }
    }
    const sessionId = req.headers["mcp-session-id"];
    if (sessionId) {
      const transport = sessions.get(sessionId);
      if (!transport) {
        return sendJson(res, 400, {
          jsonrpc: "2.0",
          error: { code: -32000, message: "Unknown or expired session" },
          id: null,
        });
      }
      return transport.handleRequest(req, res, body);
    }
    if (req.method === "POST" && isInitializeRequest(body)) {
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        // Register only once the id exists — avoids the race where a follow-up
        // request arrives before initialization completes.
        onsessioninitialized: (id) => {
          sessions.set(id, transport);
          log(`MCP session ${id} opened (${sessions.size} active)`);
        },
      });
      transport.onclose = () => {
        for (const [id, t] of sessions) {
          if (t === transport) {
            sessions.delete(id);
            log(`MCP session ${id} closed (${sessions.size} active)`);
          }
        }
      };
      const server = createBridge({ relay, startedAt });
      await server.connect(transport);
      return transport.handleRequest(req, res, body);
    }
    return sendJson(res, 400, {
      jsonrpc: "2.0",
      error: { code: -32000, message: "Bad request: no session and not an initialize request" },
      id: null,
    });
  }

  const server = createServer((req, res) => {
    let path;
    try {
      path = new URL(req.url ?? "/", "http://localhost").pathname;
    } catch {
      // Malformed request-target (e.g. an absolute-form URL with an unbalanced
      // IPv6 bracket) can pass Node's HTTP parser but isn't a valid URL — fail
      // closed with 400 rather than letting the throw escape unguarded.
      return sendJson(res, 400, { error: "bad request" });
    }
    const route =
      path === "/health" && req.method === "GET"
        ? () =>
            sendJson(res, 200, {
              name: HEALTH_NAME,
              version: SERVER_VERSION,
              pid: process.pid,
              startedAt,
              extensionConnected: relay.clientCount() > 0,
            })
        : path === "/dispatch" && req.method === "POST"
          ? () => handleDispatch(req, res)
          : path === "/mcp"
            ? () => handleMcp(req, res)
            : () => sendJson(res, 404, { error: "not found" });
    Promise.resolve(route()).catch((err) => {
      log(`HTTP handler error: ${err?.message ?? err}`);
      if (!res.headersSent) sendJson(res, 500, { error: "internal error" });
    });
  });

  async function closeAllSessions() {
    for (const transport of [...sessions.values()]) {
      try {
        await transport.close();
      } catch {
        /* ignore */
      }
    }
    sessions.clear();
  }

  return { server, closeAllSessions, sessionCount: () => sessions.size };
}

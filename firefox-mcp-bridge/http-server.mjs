import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { TOOLS, WS_TOOL_NAMES } from "./tools.mjs";
import { isSseAuthorized } from "./sse-auth.mjs";
import { isAllowedWsOrigin } from "./ws-relay.mjs";
import { createBridge, SERVER_VERSION } from "./bridge.mjs";
import { createSessionStore } from "./sessions.mjs";

export const HEALTH_NAME = "firefox-mcp-bridge";
export const MAX_DISPATCH_TIMEOUT_MS = 120000;
const MAX_BODY_BYTES = 2 * 1024 * 1024;

// Zod validators per dispatchable tool. ping_firefox is bridge-local (answered
// by createBridge, never relayed), so it is deliberately absent — /dispatch
// callers use /health + get_tabs_summary instead. Membership is derived from
// WS_TOOL_NAMES (tools.mjs) so this allowlist and the CLI parity test share
// one source of truth instead of duplicating the filter.
const WS_TOOLS = new Set(WS_TOOL_NAMES);
// /dispatch also accepts tabId "active" (`ff --here`: the tab the user is
// viewing). It stays out of the MCP schema so the tool list costs no more
// tokens; MCP clients pass the numeric id from get_tabs_summary instead.
const DISPATCH_TAB_ID = z.union([z.number(), z.literal("active")]).optional();
const DISPATCH_SCHEMAS = new Map(
  TOOLS.filter((t) => WS_TOOLS.has(t.name)).map((t) => [
    t.name,
    !t.inputSchema
      ? z.object({}).strict()
      : z.object("tabId" in t.inputSchema ? { ...t.inputSchema, tabId: DISPATCH_TAB_ID } : t.inputSchema).strict(),
  ]),
);

const NAME_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
// set_profile_name is dispatchable (the CLI names profiles with it) but is
// deliberately NOT in TOOLS: it must not appear in the MCP tool list.
DISPATCH_SCHEMAS.set("set_profile_name", z.object({ name: z.string().regex(NAME_RE) }));

// Bridge pseudo-tools: answered locally, never forwarded to the extension.
export const BRIDGE_TOOL_SCHEMAS = new Map([
  ["session_bind", z.object({ name: z.string().regex(NAME_RE), tabId: z.number() })],
  ["session_list", z.object({})],
  ["session_remove", z.object({ name: z.string() })],
  ["profiles_list", z.object({})],
]);

// Session targeting only makes sense for tools that accept a tabId.
export const SESSION_TARGETABLE = new Set(
  TOOLS.filter((t) => t.inputSchema && "tabId" in t.inputSchema).map((t) => t.name),
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
  const isBridgeTool = typeof tool === "string" && BRIDGE_TOOL_SCHEMAS.has(tool);
  const schema = isBridgeTool
    ? BRIDGE_TOOL_SCHEMAS.get(tool)
    : typeof tool === "string"
      ? DISPATCH_SCHEMAS.get(tool)
      : undefined;
  if (!schema) return { ok: false, message: `unknown tool: ${String(tool)}` };
  const parsed = schema.safeParse(body?.args ?? {});
  if (!parsed.success) {
    return { ok: false, message: `invalid args for ${tool}: ${parsed.error.issues.map((i) => i.message).join("; ")}` };
  }
  const session = body?.session;
  const profile = body?.profile;
  if (session != null && typeof session !== "string") return { ok: false, message: "session must be a string" };
  if (profile != null && typeof profile !== "string") return { ok: false, message: "profile must be a string" };
  if (session != null && profile != null) {
    return { ok: false, code: "DISPATCH_CONFLICT", message: "session and profile are mutually exclusive (a session owns its profile)" };
  }
  if (session != null && parsed.data.tabId != null) {
    return { ok: false, code: "DISPATCH_CONFLICT", message: "session and args.tabId are mutually exclusive" };
  }
  if (session != null && !SESSION_TARGETABLE.has(tool)) {
    return { ok: false, code: "DISPATCH_CONFLICT", message: `tool ${tool} does not target a tab, so it cannot take a session` };
  }
  let timeoutMs;
  if (body?.timeoutMs != null) {
    const n = Number(body.timeoutMs);
    if (!Number.isFinite(n) || n < 1) return { ok: false, message: "timeoutMs must be a positive number" };
    timeoutMs = Math.min(n, MAX_DISPATCH_TIMEOUT_MS);
  }
  return { ok: true, tool, args: parsed.data, timeoutMs, session: session ?? null, profile: profile ?? null, isBridgeTool };
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
export function createBridgeHttpServer({
  relay,
  sessions = createSessionStore({ filePath: null }),
  startedAt = Date.now(),
  fileToken,
  envToken = null,
  log = () => {},
}) {
  if (!fileToken) throw new Error("createBridgeHttpServer requires a non-empty fileToken");
  const mcpSessions = new Map(); // mcp-session-id -> StreamableHTTPServerTransport

  function toolError(res, code, message) {
    return sendJson(res, 200, { error: { code, message } });
  }

  function resolveProfileEntry(explicit) {
    const profiles = relay.profiles();
    if (explicit != null) {
      const p = profiles.find((x) => x.name === explicit);
      if (!p) {
        throw {
          code: "PROFILE_NOT_CONNECTED",
          message: `profile "${explicit}" is not connected (connected: ${profiles.map((x) => x.name).join(", ") || "none"})`,
        };
      }
      return p;
    }
    if (profiles.length === 0) throw { code: "NO_CLIENT", message: "No Firefox extension connected" };
    if (profiles.length > 1) {
      throw {
        code: "PROFILE_REQUIRED",
        message: `multiple Firefox profiles connected (${profiles.map((x) => x.name).join(", ")}) — pass --profile`,
      };
    }
    return profiles[0];
  }

  async function handleBridgeTool(v) {
    if (v.tool === "profiles_list") return { profiles: relay.profiles() };
    if (v.tool === "session_remove") return { removed: sessions.remove(v.args.name) };
    if (v.tool === "session_list") {
      const profiles = relay.profiles();
      const tabsByProfile = new Map();
      const out = [];
      for (const rec of sessions.list()) {
        const p = profiles.find((x) => x.name === rec.profile);
        let live = false;
        let currentUrl = null;
        if (p && p.runId != null && p.runId === rec.runId) {
          if (!tabsByProfile.has(rec.profile)) {
            try {
              const s = await relay.dispatch("get_tabs_summary", {}, { profile: rec.profile });
              tabsByProfile.set(rec.profile, s?.tabs ?? []);
            } catch {
              tabsByProfile.set(rec.profile, []);
            }
          }
          const tab = tabsByProfile.get(rec.profile).find((t) => t.id === rec.tabId);
          if (tab) {
            live = true;
            currentUrl = tab.url ?? null;
          }
        }
        out.push({ name: rec.name, profile: rec.profile, tabId: rec.tabId, live, url: live ? currentUrl : (rec.url ?? null) });
      }
      return { sessions: out };
    }
    // session_bind
    const p = resolveProfileEntry(v.profile);
    if (p.runId == null) {
      throw {
        code: "EXTENSION_OUTDATED",
        message: `profile "${p.name}" runs an extension without session support — reload/update the Firefox extension`,
      };
    }
    const summary = await relay.dispatch("get_tabs_summary", {}, { profile: p.name });
    const tab = (summary?.tabs ?? []).find((t) => t.id === v.args.tabId);
    if (!tab) {
      throw { code: "TAB_NOT_FOUND", message: `tab ${v.args.tabId} not found in profile "${p.name}" — run \`ff tabs\`` };
    }
    const previous = sessions.bind(v.args.name, { profile: p.name, tabId: tab.id, runId: p.runId, url: tab.url ?? null });
    return { name: v.args.name, profile: p.name, tabId: tab.id, url: tab.url ?? null, previous };
  }

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
    if (!v.ok) return sendJson(res, 400, { error: { code: v.code ?? "BAD_REQUEST", message: v.message } });

    try {
      if (v.isBridgeTool) return sendJson(res, 200, { result: await handleBridgeTool(v) });

      let profile = v.profile;
      let args = v.args;
      if (v.tool === "set_profile_name") {
        // NAME_IN_USE preflight: without it, newest-wins-within-name would let
        // one profile silently steal another's identity. Held by a DIFFERENT
        // connection is the conflict; renaming a profile to its own current
        // name (self-rename) is a harmless no-op and must proceed.
        const target = resolveProfileEntry(v.profile);
        if (v.args.name !== target.name && relay.profiles().some((p) => p.name === v.args.name)) {
          return toolError(res, "NAME_IN_USE", `profile name "${v.args.name}" is already connected — pick another`);
        }
      }
      if (v.session) {
        const rec = sessions.get(v.session);
        if (!rec) return toolError(res, "SESSION_NOT_FOUND", `no session "${v.session}" — run \`ff sessions\``);
        const live = relay.profiles().find((p) => p.name === rec.profile);
        if (!live || live.runId == null || live.runId !== rec.runId) {
          return toolError(
            res,
            "SESSION_STALE",
            `session "${v.session}" is stale (Firefox restarted or profile "${rec.profile}" disconnected) — rebind with \`ff open <url> --as ${v.session}\` or \`ff bind\``,
          );
        }
        profile = rec.profile;
        args = { ...v.args, tabId: rec.tabId };
      }
      const opts = { ...(v.timeoutMs ? { timeoutMs: v.timeoutMs } : {}), ...(profile ? { profile } : {}) };
      const result = await relay.dispatch(v.tool, args, opts);
      if (v.session && v.tool === "close_tab") sessions.remove(v.session);
      return sendJson(res, 200, { result });
    } catch (err) {
      // Tool-level failures (NO_CLIENT, WS_TIMEOUT, extension errors) are 200
      // with { error } — the transport worked; the tool call didn't.
      if (v.session && err?.code === "TAB_NOT_FOUND") {
        return toolError(res, "SESSION_STALE", `session "${v.session}" points at a closed tab — rebind with \`ff open <url> --as ${v.session}\``);
      }
      return sendJson(res, 200, { error: { code: err?.code ?? "INTERNAL", message: err?.message ?? String(err) } });
    }
  }

  async function handleMcp(req, res) {
    // Same DNS-rebinding/Origin defense as /dispatch: a browser page sends an
    // http(s) Origin and is rejected before the token check ever runs; a
    // curl/Node MCP client sends no Origin at all and passes through to the
    // (still-enforced) token check below.
    if (!isAllowedWsOrigin(req.headers?.origin)) {
      return sendJson(res, 403, { error: { code: "FORBIDDEN", message: "web-page origins may not call /mcp" } });
    }
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
      const transport = mcpSessions.get(sessionId);
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
          mcpSessions.set(id, transport);
          log(`MCP session ${id} opened (${mcpSessions.size} active)`);
        },
      });
      transport.onclose = () => {
        for (const [id, t] of mcpSessions) {
          if (t === transport) {
            mcpSessions.delete(id);
            log(`MCP session ${id} closed (${mcpSessions.size} active)`);
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
        ? () => {
            if (!isLoopbackAddress(req.socket?.remoteAddress)) {
              return sendJson(res, 403, { error: { code: "FORBIDDEN", message: "health is loopback-only" } });
            }
            return sendJson(res, 200, {
              name: HEALTH_NAME,
              version: SERVER_VERSION,
              pid: process.pid,
              startedAt,
              extensionConnected: relay.clientCount() > 0,
            });
          }
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
    for (const transport of [...mcpSessions.values()]) {
      try {
        await transport.close();
      } catch {
        /* ignore */
      }
    }
    mcpSessions.clear();
  }

  return { server, closeAllSessions, sessionCount: () => mcpSessions.size };
}

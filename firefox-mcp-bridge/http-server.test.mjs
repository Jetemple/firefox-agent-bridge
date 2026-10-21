import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import {
  HEALTH_NAME,
  MAX_DISPATCH_TIMEOUT_MS,
  isLoopbackAddress,
  checkDispatchAccess,
  validateDispatchBody,
  createBridgeHttpServer,
} from "./http-server.mjs";
import { createSessionStore } from "./sessions.mjs";

const TOKEN = "tok-file-secret";

function fakeReq({ remote = "127.0.0.1", origin, contentType = "application/json", token = TOKEN, url = "/dispatch", method = "GET" } = {}) {
  const headers = {};
  if (origin !== undefined) headers.origin = origin;
  if (contentType) headers["content-type"] = contentType;
  if (token) headers.authorization = `Bearer ${token}`;
  return { url, method, headers, socket: { remoteAddress: remote } };
}

// Minimal http.ServerResponse stand-in for exercising the server's `request`
// listener directly (server.emit-style), without a real socket — needed for
// /health's loopback check, where the live-server tests below (real fetch
// against 127.0.0.1) can never produce a non-loopback remoteAddress.
function fakeRes() {
  const res = {
    statusCode: null,
    headers: null,
    headersSent: false,
    body: null,
    writeHead(status, headers) {
      res.statusCode = status;
      res.headers = headers;
      res.headersSent = true;
    },
    end(body) {
      res.body = body;
    },
  };
  return res;
}

// `results` (per-tool overrides, keyed by tool name) supports the dispatch
// envelope tests below without disturbing the plain `result`/`error` shape
// the pre-existing tests rely on (they never populate `results`, so
// `tool in results` is always false and the old fallback path runs
// unchanged). `profiles` backs the new session/profile resolution paths;
// plain dispatch tests never call it.
function stubRelay({ result = { ok: true }, error = null, connected = true, profiles = [], results = {} } = {}) {
  const calls = [];
  return {
    calls,
    clientCount: () => (connected ? 1 : 0),
    profiles: () => profiles,
    dispatch: async (tool, args, opts) => {
      calls.push({ tool, args, opts });
      if (tool in results) {
        const r = results[tool];
        if (r instanceof Error) throw { code: r.message, message: r.message };
        return r;
      }
      if (error) throw error;
      return result;
    },
  };
}

async function listen(parts) {
  await new Promise((r) => parts.server.listen(0, "127.0.0.1", r));
  const { port } = parts.server.address();
  return { port, close: () => new Promise((r) => parts.server.close(r)) };
}

async function startServer({ relay, sessions, fileToken = TOKEN } = {}) {
  const parts = createBridgeHttpServer({ relay, sessions, fileToken, envToken: null });
  const { port, close } = await listen(parts);
  return { url: `http://127.0.0.1:${port}`, close, parts };
}

async function postDispatch(url, body, { token = TOKEN } = {}) {
  const headers = { "content-type": "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(`${url}/dispatch`, { method: "POST", headers, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
}

// --- isLoopbackAddress ---

test("isLoopbackAddress accepts v4/v6 loopback and rejects LAN addresses", () => {
  assert.equal(isLoopbackAddress("127.0.0.1"), true);
  assert.equal(isLoopbackAddress("::1"), true);
  assert.equal(isLoopbackAddress("::ffff:127.0.0.1"), true);
  assert.equal(isLoopbackAddress("192.168.1.20"), false);
  assert.equal(isLoopbackAddress(undefined), false);
});

// --- checkDispatchAccess: each defense separately ---

test("dispatch access: happy path passes", () => {
  assert.deepEqual(checkDispatchAccess(fakeReq(), { fileToken: TOKEN, envToken: null }), { ok: true });
});

test("dispatch access: non-loopback source is rejected 403", () => {
  const r = checkDispatchAccess(fakeReq({ remote: "192.168.1.9" }), { fileToken: TOKEN, envToken: null });
  assert.equal(r.ok, false);
  assert.equal(r.status, 403);
});

test("dispatch access: web Origin is rejected 403 (extension/no-origin passes)", () => {
  const web = checkDispatchAccess(fakeReq({ origin: "https://evil.example" }), { fileToken: TOKEN, envToken: null });
  assert.equal(web.status, 403);
  const ext = checkDispatchAccess(fakeReq({ origin: "moz-extension://abc" }), { fileToken: TOKEN, envToken: null });
  assert.equal(ext.ok, true);
});

test("dispatch access: text/plain content type (CSRF simple request) is rejected 415", () => {
  const r = checkDispatchAccess(fakeReq({ contentType: "text/plain" }), { fileToken: TOKEN, envToken: null });
  assert.equal(r.status, 415);
});

test("dispatch access: missing or wrong token is rejected 401 even on loopback", () => {
  assert.equal(checkDispatchAccess(fakeReq({ token: null }), { fileToken: TOKEN, envToken: null }).status, 401);
  assert.equal(checkDispatchAccess(fakeReq({ token: "nope" }), { fileToken: TOKEN, envToken: null }).status, 401);
});

test("dispatch access: the env-configured token is also accepted", () => {
  const r = checkDispatchAccess(fakeReq({ token: "env-tok" }), { fileToken: TOKEN, envToken: "env-tok" });
  assert.equal(r.ok, true);
});

test("dispatch access: a falsy fileToken does not fail open (isSseAuthorized(falsy) would return true)", () => {
  const r = checkDispatchAccess(fakeReq({ token: null }), { fileToken: "", envToken: null });
  assert.equal(r.ok, false);
  assert.equal(r.status, 401);
});

// --- validateDispatchBody ---

test("validateDispatchBody accepts a known tool with valid args and clamps timeout", () => {
  const r = validateDispatchBody({ tool: "navigate", args: { url: "x.com" }, timeoutMs: 999999 });
  assert.equal(r.ok, true);
  assert.equal(r.tool, "navigate");
  assert.deepEqual(r.args, { url: "x.com" });
  assert.equal(r.timeoutMs, MAX_DISPATCH_TIMEOUT_MS);
});

test("validateDispatchBody rejects unknown tools (including bridge-local ping_firefox)", () => {
  assert.equal(validateDispatchBody({ tool: "rm_rf", args: {} }).ok, false);
  assert.equal(validateDispatchBody({ tool: "ping_firefox", args: {} }).ok, false);
});

test("validateDispatchBody rejects args failing the tool's schema", () => {
  assert.equal(validateDispatchBody({ tool: "click", args: { x: "left", y: 2 } }).ok, false);
  assert.equal(validateDispatchBody({ tool: "navigate", args: {} }).ok, false);
});

test('validateDispatchBody accepts tabId "active" (ff --here) and rejects other strings', () => {
  const r = validateDispatchBody({ tool: "get_page_text", args: { tabId: "active" } });
  assert.equal(r.ok, true);
  assert.equal(r.args.tabId, "active");
  assert.equal(validateDispatchBody({ tool: "get_page_text", args: { tabId: "mine" } }).ok, false);
  assert.equal(validateDispatchBody({ tool: "get_page_text", args: { tabId: "active" }, session: "s" }).ok, false);
});

test("validateDispatchBody passes open_tab's marker label through (ff open --as)", () => {
  const r = validateDispatchBody({ tool: "open_tab", args: { url: "x.com", active: false, label: "research" } });
  assert.equal(r.ok, true);
  assert.equal(r.args.label, "research");
  assert.equal(validateDispatchBody({ tool: "open_tab", args: { url: "x.com", label: "Bad Name" } }).ok, false);
});

test("validateDispatchBody defaults args to {} for no-schema tools", () => {
  const r = validateDispatchBody({ tool: "get_tabs_summary" });
  assert.equal(r.ok, true);
  assert.deepEqual(r.args, {});
});

// --- createBridgeHttpServer: fileToken is mandatory ---

test("createBridgeHttpServer throws if fileToken is missing or empty", () => {
  const relay = stubRelay();
  assert.throws(() => createBridgeHttpServer({ relay, fileToken: undefined }), /non-empty fileToken/);
  assert.throws(() => createBridgeHttpServer({ relay, fileToken: "" }), /non-empty fileToken/);
});

// --- live server: /health and /dispatch ---

test("/health reports identity without auth and emits no CORS headers", async () => {
  const relay = stubRelay({ connected: true });
  const parts = createBridgeHttpServer({ relay, startedAt: 123, fileToken: TOKEN, envToken: null });
  const { port, close } = await listen(parts);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("access-control-allow-origin"), null);
    const j = await res.json();
    assert.equal(j.name, HEALTH_NAME);
    assert.equal(j.pid, process.pid);
    assert.equal(j.extensionConnected, true);
    assert.equal(typeof j.version, "string");
  } finally {
    await close();
  }
});

test("/health refuses a non-loopback source address with 403 FORBIDDEN", async () => {
  const relay = stubRelay({ connected: true });
  const parts = createBridgeHttpServer({ relay, startedAt: 0, fileToken: TOKEN, envToken: null });
  const req = fakeReq({ remote: "192.168.1.9", url: "/health", method: "GET" });
  const res = fakeRes();
  parts.server.emit("request", req, res);
  assert.equal(res.statusCode, 403);
  assert.deepEqual(JSON.parse(res.body), { error: { code: "FORBIDDEN", message: "health is loopback-only" } });
});

test("/health still answers for loopback sources via the same request path", async () => {
  const relay = stubRelay({ connected: true });
  const parts = createBridgeHttpServer({ relay, startedAt: 5, fileToken: TOKEN, envToken: null });
  const req = fakeReq({ remote: "127.0.0.1", url: "/health", method: "GET" });
  const res = fakeRes();
  parts.server.emit("request", req, res);
  assert.equal(res.statusCode, 200);
  assert.equal(JSON.parse(res.body).name, HEALTH_NAME);
});

test("/dispatch forwards a valid call and returns the relay result", async () => {
  const relay = stubRelay({ result: { tabs: [] } });
  const parts = createBridgeHttpServer({ relay, startedAt: 0, fileToken: TOKEN, envToken: null });
  const { port, close } = await listen(parts);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/dispatch`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ tool: "get_tabs_summary" }),
    });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { result: { tabs: [] } });
    assert.equal(relay.calls[0].tool, "get_tabs_summary");
  } finally {
    await close();
  }
});

test("/dispatch maps relay rejections to { error } and bad input to 400/401", async () => {
  const relay = stubRelay({ error: { code: "NO_CLIENT", message: "No Firefox extension connected" } });
  const parts = createBridgeHttpServer({ relay, startedAt: 0, fileToken: TOKEN, envToken: null });
  const { port, close } = await listen(parts);
  try {
    const ok = await fetch(`http://127.0.0.1:${port}/dispatch`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ tool: "get_tabs_summary" }),
    });
    assert.equal(ok.status, 200);
    assert.deepEqual((await ok.json()).error, { code: "NO_CLIENT", message: "No Firefox extension connected" });

    const badTool = await fetch(`http://127.0.0.1:${port}/dispatch`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ tool: "nope" }),
    });
    assert.equal(badTool.status, 400);

    const noTok = await fetch(`http://127.0.0.1:${port}/dispatch`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tool: "get_tabs_summary" }),
    });
    assert.equal(noTok.status, 401);
  } finally {
    await close();
  }
});

// A malformed absolute-form request-target (unbalanced IPv6 bracket) passes
// Node's HTTP parser but throws out of `new URL(...)`. Confirmed empirically
// on this Node version (v26.3.0) via a raw socket: req.url arrives as the
// literal string "http://[::1" and `new URL(req.url, "http://localhost")`
// throws a synchronous TypeError, which — pre-fix — is unhandled inside the
// createServer callback and crashes the process (verified with a standalone
// repro server: uncaught ERR_INVALID_URL, exit code 1).
test("malformed absolute-form request-target does not crash the process; server keeps serving after", async () => {
  const relay = stubRelay({ connected: true });
  const parts = createBridgeHttpServer({ relay, startedAt: 0, fileToken: TOKEN, envToken: null });
  const { port, close } = await listen(parts);
  try {
    const responseLine = await new Promise((resolve) => {
      const sock = net.connect(port, "127.0.0.1", () => {
        sock.write("GET http://[::1 HTTP/1.1\r\nHost: x\r\n\r\n");
      });
      // Resolve as soon as *some* response comes back (proof the server didn't
      // crash) rather than waiting on socket close, which can ride out a
      // keep-alive idle timeout.
      sock.once("data", (chunk) => {
        sock.destroy();
        resolve(chunk.toString().split("\r\n")[0]);
      });
      sock.on("error", () => {});
    });
    assert.equal(responseLine, "HTTP/1.1 400 Bad Request");
    // If the process survived the malformed request, it should still be able
    // to serve a normal request.
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    assert.equal(res.status, 200);
  } finally {
    await close();
  }
});

// --- dispatch envelope: sessions, profiles, bridge pseudo-tools ---

test("session dispatch injects the bound tabId and routes to the session's profile", async () => {
  const relay = stubRelay({
    profiles: [{ name: "work", runId: "run-1", connectedAt: 1 }],
    results: { get_page_text: { text: "hi" } },
  });
  const sessions = createSessionStore({ filePath: null });
  sessions.bind("research", { profile: "work", tabId: 42, runId: "run-1", url: "https://x.com" });
  const { url, close } = await startServer({ relay, sessions });
  const res = await postDispatch(url, { tool: "get_page_text", session: "research" });
  assert.deepEqual(res.body.result, { text: "hi" });
  assert.deepEqual(relay.calls[0], {
    tool: "get_page_text",
    args: { tabId: 42 },
    opts: { profile: "work" },
  });
  await close();
});

test("session dispatch fails safe: SESSION_NOT_FOUND, runId mismatch, TAB_NOT_FOUND wrap", async () => {
  const relay = stubRelay({
    profiles: [{ name: "work", runId: "run-2", connectedAt: 1 }], // Firefox restarted
    results: { get_page_text: new Error("TAB_NOT_FOUND") },
  });
  const sessions = createSessionStore({ filePath: null });
  sessions.bind("research", { profile: "work", tabId: 42, runId: "run-1", url: null });
  const { url, close } = await startServer({ relay, sessions });

  let res = await postDispatch(url, { tool: "get_page_text", session: "ghost" });
  assert.equal(res.body.error.code, "SESSION_NOT_FOUND");

  res = await postDispatch(url, { tool: "get_page_text", session: "research" });
  assert.equal(res.body.error.code, "SESSION_STALE");
  assert.equal(relay.calls.length, 0, "stale session must never dispatch");

  sessions.bind("research", { profile: "work", tabId: 42, runId: "run-2", url: null });
  res = await postDispatch(url, { tool: "get_page_text", session: "research" });
  assert.equal(res.body.error.code, "SESSION_STALE", "TAB_NOT_FOUND wraps to SESSION_STALE");
  await close();
});

test("DISPATCH_CONFLICT: session+profile, session+args.tabId, session on a non-tab tool", async () => {
  const { url, close } = await startServer({ relay: stubRelay(), sessions: createSessionStore({ filePath: null }) });
  for (const body of [
    { tool: "get_page_text", session: "s", profile: "p" },
    { tool: "get_page_text", session: "s", args: { tabId: 1 } },
    { tool: "open_tab", session: "s", args: { url: "https://x.com" } },
  ]) {
    const res = await postDispatch(url, body);
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, "DISPATCH_CONFLICT");
  }
  await close();
});

test("session_bind validates the tab, records runId, and close_tab removes the session", async () => {
  const relay = stubRelay({
    profiles: [{ name: "work", runId: "run-1", connectedAt: 1 }],
    results: {
      get_tabs_summary: { tabs: [{ id: 42, url: "https://x.com", title: "X" }] },
      close_tab: { closed: true, tabId: 42 },
    },
  });
  const sessions = createSessionStore({ filePath: null });
  const { url, close } = await startServer({ relay, sessions });

  let res = await postDispatch(url, { tool: "session_bind", args: { name: "research", tabId: 42 } });
  assert.deepEqual(res.body.result, {
    name: "research", profile: "work", tabId: 42, url: "https://x.com", previous: null,
  });

  res = await postDispatch(url, { tool: "session_bind", args: { name: "bad", tabId: 999 } });
  assert.equal(res.body.error.code, "TAB_NOT_FOUND");

  res = await postDispatch(url, { tool: "close_tab", session: "research" });
  assert.equal(res.body.result.closed, true);
  assert.equal(sessions.get("research"), undefined, "close_tab via session removes the record");
  await close();
});

test("session_list computes liveness and current url; profiles_list lists connections", async () => {
  const relay = stubRelay({
    profiles: [{ name: "work", runId: "run-1", connectedAt: 1 }],
    results: { get_tabs_summary: { tabs: [{ id: 42, url: "https://now.example", title: "" }] } },
  });
  const sessions = createSessionStore({ filePath: null });
  sessions.bind("live-one", { profile: "work", tabId: 42, runId: "run-1", url: "https://old.example" });
  sessions.bind("dead-one", { profile: "gone", tabId: 7, runId: "run-9", url: "https://dead.example" });
  const { url, close } = await startServer({ relay, sessions });

  let res = await postDispatch(url, { tool: "session_list" });
  const byName = Object.fromEntries(res.body.result.sessions.map((s) => [s.name, s]));
  assert.equal(byName["live-one"].live, true);
  assert.equal(byName["live-one"].url, "https://now.example", "live sessions show the CURRENT url");
  assert.equal(byName["dead-one"].live, false);

  res = await postDispatch(url, { tool: "profiles_list" });
  assert.deepEqual(res.body.result.profiles, [{ name: "work", runId: "run-1", connectedAt: 1 }]);
  await close();
});

test("set_profile_name renaming a profile to its OWN current name is a harmless no-op, not NAME_IN_USE", async () => {
  const relay = stubRelay({
    profiles: [
      { name: "work", runId: "run-1", connectedAt: 1 },
      { name: "personal", runId: "run-2", connectedAt: 2 },
    ],
    results: { set_profile_name: { name: "work" } },
  });
  const sessions = createSessionStore({ filePath: null });
  const { url, close } = await startServer({ relay, sessions });
  try {
    // Routed AT "work": renaming "work" to "work" must dispatch through, not NAME_IN_USE.
    let res = await postDispatch(url, { tool: "set_profile_name", args: { name: "work" }, profile: "work" });
    assert.equal(res.body.error, undefined, JSON.stringify(res.body));
    assert.deepEqual(res.body.result, { name: "work" });
    assert.equal(relay.calls.length, 1);
    assert.deepEqual(relay.calls[0], { tool: "set_profile_name", args: { name: "work" }, opts: { profile: "work" } });

    // Routed AT "personal": naming it "work" collides with the OTHER connection.
    res = await postDispatch(url, { tool: "set_profile_name", args: { name: "work" }, profile: "personal" });
    assert.equal(res.body.error.code, "NAME_IN_USE");
  } finally {
    await close();
  }
});

test("set_profile_name preflights NAME_IN_USE and old-extension binds get EXTENSION_OUTDATED", async () => {
  const relay = stubRelay({
    profiles: [
      { name: "work", runId: "run-1", connectedAt: 1 },
      { name: "default", runId: null, connectedAt: 2 }, // legacy extension
    ],
  });
  const sessions = createSessionStore({ filePath: null });
  const { url, close } = await startServer({ relay, sessions });
  let res = await postDispatch(url, { tool: "set_profile_name", args: { name: "work" }, profile: "default" });
  assert.equal(res.body.error.code, "NAME_IN_USE");
  res = await postDispatch(url, { tool: "session_bind", args: { name: "s", tabId: 1 }, profile: "default" });
  assert.equal(res.body.error.code, "EXTENSION_OUTDATED");
  await close();
});

// --- per-session /mcp ---

async function mcpInitialize(port, { sessionId } = {}) {
  const headers = { "content-type": "application/json", accept: "application/json, text/event-stream" };
  if (sessionId) headers["mcp-session-id"] = sessionId;
  return fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "t", version: "0" },
      },
    }),
  });
}

test("/mcp supports two concurrent sessions and rejects unknown session ids", async () => {
  const relay = stubRelay();
  const parts = createBridgeHttpServer({ relay, startedAt: 0, fileToken: TOKEN, envToken: null });
  const { port, close } = await listen(parts);
  try {
    const a = await mcpInitialize(port);
    const b = await mcpInitialize(port);
    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
    const sidA = a.headers.get("mcp-session-id");
    const sidB = b.headers.get("mcp-session-id");
    assert.ok(sidA && sidB && sidA !== sidB, "two initializes must yield two distinct sessions");
    assert.equal(parts.sessionCount(), 2);

    const unknown = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-session-id": "no-such-session",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
    });
    assert.equal(unknown.status, 400);

    await parts.closeAllSessions();
    assert.equal(parts.sessionCount(), 0);
  } finally {
    await close();
  }
});

test("/mcp still enforces the env token when configured", async () => {
  const relay = stubRelay();
  const parts = createBridgeHttpServer({ relay, startedAt: 0, fileToken: TOKEN, envToken: "env-secret" });
  const { port, close } = await listen(parts);
  try {
    const noAuth = await mcpInitialize(port);
    // The Origin guard runs first, but this request has no Origin header, so
    // it must fall through to (and be rejected by) the token check — not the
    // guard — confirming the ordering doesn't break existing token enforcement.
    assert.equal(noAuth.status, 401);
  } finally {
    await close();
  }
});

test("/mcp rejects a web-page Origin with 403 before the token check", async () => {
  const relay = stubRelay();
  const parts = createBridgeHttpServer({ relay, startedAt: 0, fileToken: TOKEN, envToken: "env-secret" });
  const { port, close } = await listen(parts);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        origin: "https://evil.example",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "0" } },
      }),
    });
    assert.equal(res.status, 403);
    const body = await res.json();
    assert.equal(body.error.code, "FORBIDDEN");
  } finally {
    await close();
  }
});

test("/mcp initialize with no Origin header still succeeds (curl/Node MCP clients)", async () => {
  const relay = stubRelay();
  const parts = createBridgeHttpServer({ relay, startedAt: 0, fileToken: TOKEN, envToken: null });
  const { port, close } = await listen(parts);
  try {
    const res = await mcpInitialize(port);
    assert.equal(res.status, 200);
    assert.ok(res.headers.get("mcp-session-id"));
  } finally {
    await close();
  }
});

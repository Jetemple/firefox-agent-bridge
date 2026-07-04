import test from "node:test";
import assert from "node:assert/strict";
import {
  HEALTH_NAME,
  MAX_DISPATCH_TIMEOUT_MS,
  isLoopbackAddress,
  checkDispatchAccess,
  validateDispatchBody,
  createBridgeHttpServer,
} from "./http-server.mjs";

const TOKEN = "tok-file-secret";

function fakeReq({ remote = "127.0.0.1", origin, contentType = "application/json", token = TOKEN, url = "/dispatch" } = {}) {
  const headers = {};
  if (origin !== undefined) headers.origin = origin;
  if (contentType) headers["content-type"] = contentType;
  if (token) headers.authorization = `Bearer ${token}`;
  return { url, headers, socket: { remoteAddress: remote } };
}

function stubRelay({ result = { ok: true }, error = null, connected = true } = {}) {
  const calls = [];
  return {
    calls,
    clientCount: () => (connected ? 1 : 0),
    dispatch: (tool, args, opts) => {
      calls.push({ tool, args, opts });
      return error ? Promise.reject(error) : Promise.resolve(result);
    },
  };
}

async function listen(parts) {
  await new Promise((r) => parts.server.listen(0, "127.0.0.1", r));
  const { port } = parts.server.address();
  return { port, close: () => new Promise((r) => parts.server.close(r)) };
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

test("validateDispatchBody defaults args to {} for no-schema tools", () => {
  const r = validateDispatchBody({ tool: "get_tabs_summary" });
  assert.equal(r.ok, true);
  assert.deepEqual(r.args, {});
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

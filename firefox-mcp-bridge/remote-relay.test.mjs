import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createRemoteRelay, createSwitchableRelay } from "./remote-relay.mjs";

const TOKEN = "remote-tok";

// Minimal owner stub: /health + /dispatch with the Task 2 response shapes.
function stubOwner({ extensionConnected = true, onDispatch, rawDispatchResponse } = {}) {
  const requests = [];
  const server = createServer(async (req, res) => {
    const path = new URL(req.url, "http://localhost").pathname;
    if (path === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ name: "firefox-mcp-bridge", version: "0.1.0", pid: 42, startedAt: 0, extensionConnected }));
      return;
    }
    if (path === "/dispatch") {
      let raw = "";
      for await (const c of req) raw += c;
      const body = JSON.parse(raw);
      requests.push({ headers: req.headers, body });
      res.writeHead(200, { "content-type": "application/json" });
      if (rawDispatchResponse !== undefined) {
        res.end(rawDispatchResponse);
      } else {
        const out = onDispatch ? onDispatch(body) : { result: { echoed: body.tool } };
        res.end(JSON.stringify(out));
      }
      return;
    }
    res.writeHead(404).end();
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({ port: server.address().port, requests, close: () => new Promise((r) => server.close(r)) });
    });
  });
}

test("RemoteRelay dispatches over HTTP with the bearer token and returns result", async () => {
  const owner = await stubOwner();
  const relay = createRemoteRelay({ ssePort: owner.port, token: TOKEN, pollMs: 60_000 });
  try {
    const out = await relay.dispatch("navigate", { url: "x.com" }, { timeoutMs: 5000 });
    assert.deepEqual(out, { echoed: "navigate" });
    assert.equal(owner.requests[0].headers.authorization, `Bearer ${TOKEN}`);
    assert.deepEqual(owner.requests[0].body, { tool: "navigate", args: { url: "x.com" }, timeoutMs: 5000 });
  } finally {
    await relay.close();
    await owner.close();
  }
});

test("RemoteRelay rejects with the owner's error object", async () => {
  const owner = await stubOwner({ onDispatch: () => ({ error: { code: "NO_CLIENT", message: "nope" } }) });
  const relay = createRemoteRelay({ ssePort: owner.port, token: TOKEN, pollMs: 60_000 });
  try {
    await assert.rejects(relay.dispatch("navigate", { url: "x" }), { code: "NO_CLIENT", message: "nope" });
  } finally {
    await relay.close();
    await owner.close();
  }
});

test("RemoteRelay rejects malformed dispatch responses with BAD_RESPONSE and does not fire onConnectionLost", async () => {
  const owner = await stubOwner({ rawDispatchResponse: "not-json{" });
  let lost = 0;
  const relay = createRemoteRelay({ ssePort: owner.port, token: TOKEN, pollMs: 60_000, onConnectionLost: () => lost++ });
  try {
    await assert.rejects(relay.dispatch("navigate", { url: "x" }), (e) => e.code === "BAD_RESPONSE");
    assert.equal(lost, 0);
  } finally {
    await relay.close();
    await owner.close();
  }
});

test("RemoteRelay fires onConnectionLost and rejects OWNER_GONE when the owner is down", async () => {
  const owner = await stubOwner();
  await owner.close(); // port is now dead
  let lost = 0;
  const relay = createRemoteRelay({ ssePort: owner.port, token: TOKEN, pollMs: 60_000, onConnectionLost: () => lost++ });
  try {
    await assert.rejects(relay.dispatch("navigate", { url: "x" }), (e) => e.code === "OWNER_GONE");
    assert.equal(lost, 1);
  } finally {
    await relay.close();
  }
});

test("RemoteRelay clientCount reflects the last /health probe, synchronously", async () => {
  const owner = await stubOwner({ extensionConnected: true });
  const relay = createRemoteRelay({ ssePort: owner.port, token: TOKEN, pollMs: 60_000 });
  try {
    assert.equal(relay.clientCount(), 0); // no probe yet
    await relay.probe();
    assert.equal(relay.clientCount(), 1);
  } finally {
    await relay.close();
    await owner.close();
  }
});

test("RemoteRelay clientCount goes stale-safe (0) after a probe against a degraded owner (503, not a network failure)", async () => {
  // A reachable-but-degraded owner: /health answers, just not with 2xx. This
  // is NOT a connection loss (the TCP/HTTP round-trip succeeded), so
  // onConnectionLost must not fire — but clientCount() must not keep
  // reporting a stale "connected" reading from a prior healthy probe.
  let healthy = true;
  const server = createServer((req, res) => {
    const path = new URL(req.url, "http://localhost").pathname;
    if (path === "/health") {
      if (healthy) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ name: "firefox-mcp-bridge", version: "0.1.0", pid: 42, startedAt: 0, extensionConnected: true }));
      } else {
        res.writeHead(503, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "unavailable" }));
      }
      return;
    }
    res.writeHead(404).end();
  });
  const owner = await new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({ port: server.address().port }));
  });
  let lost = 0;
  const relay = createRemoteRelay({ ssePort: owner.port, token: TOKEN, pollMs: 60_000, onConnectionLost: () => lost++ });
  try {
    await relay.probe();
    assert.equal(relay.clientCount(), 1); // healthy first

    healthy = false;
    await relay.probe();
    assert.equal(relay.clientCount(), 0);
    assert.equal(lost, 0);
  } finally {
    await relay.close();
    await new Promise((r) => server.close(r));
  }
});

test("SwitchableRelay delegates and swap() redirects future calls", async () => {
  const a = { dispatch: async () => "from-a", clientCount: () => 1, close: async () => {} };
  const b = { dispatch: async () => "from-b", clientCount: () => 0, close: async () => {} };
  const sw = createSwitchableRelay(a);
  assert.equal(await sw.dispatch("t", {}), "from-a");
  assert.equal(sw.clientCount(), 1);
  const prev = sw.swap(b);
  assert.equal(prev, a);
  assert.equal(await sw.dispatch("t", {}), "from-b");
  assert.equal(sw.clientCount(), 0);
  assert.equal(sw.target, b);
});

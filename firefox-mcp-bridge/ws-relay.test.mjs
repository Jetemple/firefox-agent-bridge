import test from "node:test";
import assert from "node:assert/strict";
import { WebSocket } from "ws";
import { createRelay, isAllowedWsOrigin } from "./ws-relay.mjs";

// --- helpers -------------------------------------------------------------

async function startRelay(opts = {}) {
  const relay = createRelay({ host: "127.0.0.1", port: 0, ...opts });
  const { port } = await relay.ready;
  return { relay, port };
}

function connect(port, onMessage) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  if (onMessage) ws.on("message", (data) => onMessage(JSON.parse(data.toString()), ws));
  return new Promise((resolve, reject) => {
    ws.on("open", () => resolve(ws));
    ws.on("error", reject);
  });
}

async function waitUntil(fn, { timeout = 1000, interval = 5 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, interval));
  }
  throw new Error("waitUntil timed out");
}

// Resolves true if the socket opens, false if the server refuses the upgrade.
function tryConnect(port, { origin } = {}) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`, origin ? { origin } : undefined);
  return new Promise((resolve) => {
    ws.on("open", () => {
      ws.close();
      resolve(true);
    });
    ws.on("error", () => resolve(false));
  });
}

// --- tests ---------------------------------------------------------------

test("isAllowedWsOrigin rejects web origins, allows the extension and origin-less clients", () => {
  assert.equal(isAllowedWsOrigin(undefined), true);
  assert.equal(isAllowedWsOrigin(""), true);
  assert.equal(isAllowedWsOrigin("moz-extension://abc-123"), true);
  assert.equal(isAllowedWsOrigin("chrome-extension://abc"), true);
  assert.equal(isAllowedWsOrigin("https://evil.example"), false);
  assert.equal(isAllowedWsOrigin("http://localhost:8080"), false);
  assert.equal(isAllowedWsOrigin("wss://evil.example"), false);
});

test("the relay refuses a WebSocket connection from a web-page origin", async () => {
  const { relay, port } = await startRelay();
  try {
    assert.equal(await tryConnect(port, { origin: "https://evil.example" }), false, "web origin must be refused");
    assert.equal(await tryConnect(port, { origin: "moz-extension://abc" }), true, "extension origin must be allowed");
    assert.equal(await tryConnect(port), true, "an origin-less (non-browser) client must be allowed");
  } finally {
    await relay.close();
  }
});

test("allowAnyOrigin disables the origin guard (escape hatch)", async () => {
  const { relay, port } = await startRelay({ allowAnyOrigin: true });
  try {
    assert.equal(await tryConnect(port, { origin: "https://evil.example" }), true);
  } finally {
    await relay.close();
  }
});

test("dispatch with no connected client rejects NO_CLIENT", async () => {
  const { relay } = await startRelay();
  try {
    await assert.rejects(relay.dispatch("get_tabs_summary", {}), (e) => {
      assert.equal(e.code, "NO_CLIENT");
      return true;
    });
    assert.equal(relay.clientCount(), 0);
  } finally {
    await relay.close();
  }
});

test("dispatch round-trips a request to the connected client and resolves its result", async () => {
  const { relay, port } = await startRelay();
  const client = await connect(port, (msg, ws) => {
    ws.send(JSON.stringify({ id: msg.id, result: { echoed: msg.tool, args: msg.args } }));
  });
  try {
    await waitUntil(() => relay.clientCount() === 1);
    const result = await relay.dispatch("navigate", { url: "https://example.com" });
    assert.deepEqual(result, { echoed: "navigate", args: { url: "https://example.com" } });
  } finally {
    client.close();
    await relay.close();
  }
});

test("extension {error} replies reject with the same code and message", async () => {
  const { relay, port } = await startRelay();
  const client = await connect(port, (msg, ws) => {
    ws.send(JSON.stringify({ id: msg.id, error: { code: "TAB_NOT_FOUND", message: "Tab 999 not found" } }));
  });
  try {
    await waitUntil(() => relay.clientCount() === 1);
    await assert.rejects(relay.dispatch("click", { x: 1, y: 1 }), (e) => {
      assert.equal(e.code, "TAB_NOT_FOUND");
      assert.equal(e.message, "Tab 999 not found");
      return true;
    });
  } finally {
    client.close();
    await relay.close();
  }
});

test("a per-call timeoutMs overrides the relay default", { timeout: 2000 }, async () => {
  // Relay default is long; the per-call override must make this reject fast.
  const { relay, port } = await startRelay({ timeoutMs: 60000 });
  const client = await connect(port, () => {}); // never replies
  try {
    await waitUntil(() => relay.clientCount() === 1);
    const started = Date.now();
    await assert.rejects(relay.dispatch("ping", {}, { timeoutMs: 60 }), (e) => {
      assert.equal(e.code, "WS_TIMEOUT");
      return true;
    });
    assert.ok(Date.now() - started < 1000, "must time out via the per-call budget, not the relay default");
  } finally {
    client.close();
    await relay.close();
  }
});

test("a client that never responds causes WS_TIMEOUT", async () => {
  const { relay, port } = await startRelay({ timeoutMs: 50 });
  const client = await connect(port, () => {}); // swallow, never reply
  try {
    await waitUntil(() => relay.clientCount() === 1);
    await assert.rejects(relay.dispatch("get_page_text", {}), (e) => {
      assert.equal(e.code, "WS_TIMEOUT");
      return true;
    });
  } finally {
    client.close();
    await relay.close();
  }
});

test("client disconnecting mid-request rejects CLIENT_DISCONNECTED (not WS_TIMEOUT)", async () => {
  const { relay, port } = await startRelay({ timeoutMs: 5000 });
  const client = await connect(port, (_msg, ws) => ws.close()); // close instead of replying
  try {
    await waitUntil(() => relay.clientCount() === 1);
    await assert.rejects(relay.dispatch("screenshot", {}), (e) => {
      assert.equal(e.code, "CLIENT_DISCONNECTED");
      return true;
    });
  } finally {
    await relay.close();
  }
});

test("a newer client adoption rejects the previous client's in-flight requests", async () => {
  const { relay, port } = await startRelay({ timeoutMs: 5000 });
  const clientA = await connect(port, () => {}); // never replies
  try {
    await waitUntil(() => relay.clientCount() === 1);
    const inflight = relay.dispatch("type", { text: "hi" });
    // Attach the rejection handler BEFORE triggering adoption, so the
    // rejection is never momentarily unhandled.
    const expectRejection = assert.rejects(inflight, (e) => {
      assert.equal(e.code, "CLIENT_DISCONNECTED");
      return true;
    });
    const clientB = await connect(port); // adoption drains A
    await expectRejection;
    clientB.close();
  } finally {
    await relay.close();
  }
});

test("a late or unknown response id is ignored without crashing the relay", async () => {
  const { relay, port } = await startRelay();
  const client = await connect(port, (msg, ws) => {
    ws.send(JSON.stringify({ id: msg.id, result: { ok: true } }));
  });
  try {
    await waitUntil(() => relay.clientCount() === 1);
    // unsolicited / unknown id — must be dropped silently
    client.send(JSON.stringify({ id: "no-such-id", result: { stray: true } }));
    client.send("not even json");
    // relay still works afterward
    const result = await relay.dispatch("get_tabs_summary", {});
    assert.deepEqual(result, { ok: true });
  } finally {
    client.close();
    await relay.close();
  }
});

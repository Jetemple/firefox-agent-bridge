// Tests for firefox-extension/background.js, evaluated in a vm with stubbed
// WebExtension globals (background.js is a plain script, not a module).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";

const SOURCE = readFileSync(new URL("../firefox-extension/background.js", import.meta.url), "utf8");

class FakeWebSocket {
  static instances = [];
  constructor(url) {
    this.url = url;
    this.readyState = 1; // OPEN
    this.sent = [];
    this.listeners = {};
    FakeWebSocket.instances.push(this);
  }
  addEventListener(type, fn) {
    (this.listeners[type] ??= []).push(fn);
  }
  send(data) {
    this.sent.push(JSON.parse(data));
  }
  close() {}
  fire(type, event = {}) {
    for (const fn of this.listeners[type] ?? []) fn(event);
  }
}
FakeWebSocket.OPEN = 1;

function loadBackground({ tabs = {}, storageData = {}, WebSocketCtor } = {}) {
  const listeners = () => ({ addListener: () => {} });
  const stored = { ...storageData };
  const sandbox = {
    console,
    setTimeout: () => 0,
    clearTimeout: () => {},
    crypto: { randomUUID: () => "test-run-id" },
    WebSocket:
      WebSocketCtor ??
      class {
        constructor() {
          throw new Error("no network in tests");
        }
      },
    browser: {
      storage: {
        local: {
          set: async (obj) => Object.assign(stored, obj),
          get: async (key) => (key in stored ? { [key]: stored[key] } : {}),
        },
      },
      runtime: {
        sendMessage: () => Promise.resolve(),
        getManifest: () => ({ version: "0.0-test" }),
        onStartup: listeners(),
        onInstalled: listeners(),
        onMessage: listeners(),
      },
      alarms: { create: () => {}, onAlarm: listeners() },
      tabs,
    },
  };
  createContext(sandbox);
  runInContext(SOURCE, sandbox, { filename: "background.js" });
  return { FF: sandbox.FFBridge, stored };
}

test("resolveTab throws TAB_NOT_FOUND for an explicit stale tabId — never the active tab", async () => {
  let queried = false;
  const { FF } = loadBackground({
    tabs: {
      get: async () => {
        throw new Error("Invalid tab ID: 99999");
      },
      query: async () => {
        queried = true;
        return [{ id: 191, active: true }];
      },
    },
  });
  await assert.rejects(FF.resolveTab(99999), (err) => {
    assert.equal(err.code, "TAB_NOT_FOUND");
    assert.match(err.message, /99999/);
    return true;
  });
  assert.equal(queried, false, "must not silently substitute the active tab");
});

test("resolveTab falls back to the active tab only when tabId is omitted", async () => {
  const active = { id: 7, active: true };
  const { FF } = loadBackground({
    tabs: {
      get: async () => {
        throw new Error("should not be called");
      },
      query: async () => [active],
    },
  });
  assert.equal(await FF.resolveTab(undefined), active);
  assert.equal(await FF.resolveTab(null), active);
});

test("resolveTab returns the requested tab when the explicit tabId is live", async () => {
  const tab = { id: 42, active: false };
  const { FF } = loadBackground({
    tabs: {
      get: async (id) => {
        assert.equal(id, 42);
        return tab;
      },
      query: async () => {
        throw new Error("should not query when the id resolves");
      },
    },
  });
  assert.equal(await FF.resolveTab(42), tab);
});

test("hello is the first frame on open, carrying stored profileName and a stable runId", async () => {
  FakeWebSocket.instances = [];
  loadBackground({ storageData: { profileName: "work" }, WebSocketCtor: FakeWebSocket });
  const sock = FakeWebSocket.instances[0];
  sock.fire("open");
  await new Promise((r) => setImmediate(r));
  assert.equal(sock.sent.length >= 1, true, "hello sent on open");
  assert.deepEqual(sock.sent[0], {
    type: "hello",
    profileName: "work",
    runId: "test-run-id",
    version: "0.0-test",
  });
});

test("hello sends profileName null when none is stored", async () => {
  FakeWebSocket.instances = [];
  loadBackground({ WebSocketCtor: FakeWebSocket });
  const sock = FakeWebSocket.instances[0];
  sock.fire("open");
  await new Promise((r) => setImmediate(r));
  assert.equal(sock.sent[0].profileName, null);
});

test("set_profile_name persists, re-sends hello BEFORE the tool reply, and validates", async () => {
  FakeWebSocket.instances = [];
  const { stored } = loadBackground({ WebSocketCtor: FakeWebSocket });
  const sock = FakeWebSocket.instances[0];
  sock.fire("open");
  await new Promise((r) => setImmediate(r));
  sock.sent.length = 0;

  sock.fire("message", { data: JSON.stringify({ id: "1", tool: "set_profile_name", args: { name: "research" } }) });
  await new Promise((r) => setImmediate(r));

  assert.equal(sock.sent[0].type, "hello", "hello must precede the reply");
  assert.equal(sock.sent[0].profileName, "research");
  assert.deepEqual(sock.sent[1], { id: "1", result: { ok: true, name: "research" } });
  assert.equal(stored.profileName, "research");

  // invalid names are rejected with BAD_NAME and nothing is persisted
  sock.sent.length = 0;
  sock.fire("message", { data: JSON.stringify({ id: "2", tool: "set_profile_name", args: { name: "default" } }) });
  await new Promise((r) => setImmediate(r));
  assert.equal(sock.sent[0].error.code, "BAD_NAME");
  assert.equal(stored.profileName, "research");
});

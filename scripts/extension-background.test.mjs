// Tests for firefox-extension/background.js, evaluated in a vm with stubbed
// WebExtension globals (background.js is a plain script, not a module).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";

const SOURCE = readFileSync(new URL("../firefox-extension/background.js", import.meta.url), "utf8");

function loadBackground({ tabs }) {
  const listeners = () => ({ addListener: () => {} });
  const sandbox = {
    console,
    // scheduleReconnect arms a timer after the WebSocket stub throws; never fire it.
    setTimeout: () => 0,
    clearTimeout: () => {},
    WebSocket: class {
      constructor() {
        throw new Error("no network in tests");
      }
    },
    browser: {
      storage: { local: { set: async () => {} } },
      runtime: {
        sendMessage: () => Promise.resolve(),
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
  return sandbox.FFBridge;
}

test("resolveTab throws TAB_NOT_FOUND for an explicit stale tabId — never the active tab", async () => {
  let queried = false;
  const FF = loadBackground({
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
  const FF = loadBackground({
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
  const FF = loadBackground({
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

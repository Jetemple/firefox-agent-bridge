// Behavior tests for the background tab tools (close_tab, activate_tab, reload,
// back, forward). These call browser.tabs.* directly (no script injection), so
// we load them into a sandbox with a stubbed `browser` + FF.resolveTab and
// assert the exact WebExtension calls.
import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const EXT = resolve(dirname(fileURLToPath(import.meta.url)), "../firefox-extension");

const TAB_FILES = [
  "restricted.js",
  "marker.js",
  "tools/close-tab.js",
  "tools/activate-tab.js",
  "tools/reload.js",
  "tools/back.js",
  "tools/forward.js",
  "tools/tabs-summary.js",
];

// Handlers run inside a vm sandbox, so objects they create live in another realm
// — deepStrictEqual rejects cross-realm objects even when their structure
// matches. Normalize via JSON before comparing (same constraint the injected
// tool tests work around).
const j = (v) => JSON.parse(JSON.stringify(v));

// Load the tab-tool files with a stubbed browser. FF.resolveTab / FF.bridgeError
// are owned by background.js, so we stub them here (dependency injection via the
// shared FFBridge namespace). resolveTab returns id 99 for the "active tab" case.
function loadTabTools(browserStub) {
  const sandbox = { browser: browserStub, console };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  for (const file of TAB_FILES) {
    vm.runInContext(readFileSync(resolve(EXT, file), "utf8"), sandbox, { filename: file });
  }
  const FF = sandbox.FFBridge;
  FF.bridgeError = (code, message) => Object.assign(new Error(message), { code });
  FF.resolveTab = async (tabId) => ({ id: tabId ?? 99, windowId: 10 });
  return FF;
}

test("close_tab removes the resolved tab", async () => {
  const calls = [];
  const FF = loadTabTools({ tabs: { remove: async (id) => calls.push(["remove", id]) } });
  const res = await FF.tools.close_tab({ tabId: 5 });
  assert.deepEqual(calls, [["remove", 5]]);
  assert.deepEqual(j(res), { closed: true, tabId: 5 });
});

test("close_tab defaults to the active tab when no tabId is given", async () => {
  const calls = [];
  const FF = loadTabTools({ tabs: { remove: async (id) => calls.push(["remove", id]) } });
  const res = await FF.tools.close_tab({});
  assert.deepEqual(calls, [["remove", 99]]);
  assert.equal(res.tabId, 99);
});

test("activate_tab activates the tab and focuses its window", async () => {
  const calls = [];
  const FF = loadTabTools({
    tabs: { update: async (id, info) => calls.push(["tabs.update", id, info]) },
    windows: { update: async (id, info) => calls.push(["windows.update", id, info]) },
  });
  const res = await FF.tools.activate_tab({ tabId: 7 });
  assert.deepEqual(j(calls), [
    ["tabs.update", 7, { active: true }],
    ["windows.update", 10, { focused: true }],
  ]);
  assert.equal(res.activated, true);
  assert.equal(res.tabId, 7);
});

test("reload reloads the tab, passing bypassCache through", async () => {
  const calls = [];
  const FF = loadTabTools({ tabs: { reload: async (id, opts) => calls.push([id, opts]) } });
  await FF.tools.reload({ tabId: 3, bypassCache: true });
  await FF.tools.reload({ tabId: 3 });
  assert.deepEqual(j(calls), [
    [3, { bypassCache: true }],
    [3, { bypassCache: false }],
  ]);
});

test("get_tabs_summary strips the agent marker so agents read clean titles", async () => {
  const FF = loadTabTools({
    tabs: {
      query: async () => [
        { id: 1, url: "https://x.com", title: "🤖 airbnb · Airbnb — Rentals", active: true, pinned: false, windowId: 1 },
        { id: 2, url: "https://y.com", title: "🤖 Plain agent tab", active: false, pinned: false, windowId: 1 },
        { id: 3, url: "https://z.com", title: "Untouched user tab", active: false, pinned: false, windowId: 1 },
      ],
    },
  });
  const res = await FF.tools.get_tabs_summary();
  assert.deepEqual(
    res.tabs.map((t) => t.title),
    ["Airbnb — Rentals", "Plain agent tab", "Untouched user tab"],
  );
  // Other fields pass through untouched.
  assert.equal(res.tabs[0].id, 1);
  assert.equal(res.tabs[0].url, "https://x.com");
});

test("back and forward drive tabs.goBack / tabs.goForward", async () => {
  const calls = [];
  const FF = loadTabTools({
    tabs: {
      goBack: async (id) => calls.push(["back", id]),
      goForward: async (id) => calls.push(["forward", id]),
    },
  });
  assert.equal((await FF.tools.back({ tabId: 2 })).navigated, "back");
  assert.equal((await FF.tools.forward({ tabId: 2 })).navigated, "forward");
  assert.deepEqual(calls, [["back", 2], ["forward", 2]]);
});

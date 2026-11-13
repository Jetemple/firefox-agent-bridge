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
  "tools/containers.js",
  "tools/close-tab.js",
  "tools/close-agent-tabs.js",
  "tools/activate-tab.js",
  "tools/reload.js",
  "tools/back.js",
  "tools/forward.js",
  "tools/tabs-summary.js",
  "tools/screenshot.js",
  "tools/find-element.js",
  "tools/get-page-text.js",
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

test("close_tab keeps the agent window alive when closing its last tab", async () => {
  const calls = [];
  const FF = loadTabTools({
    tabs: {
      query: async (q) => (calls.push(["query", q.windowId]), [{ id: 5, windowId: 10 }]),
      create: async (opts) => (calls.push(["create", opts.windowId, opts.url, opts.active]), { id: 6 }),
      remove: async (id) => calls.push(["remove", id]),
    },
  });
  FF.agentWindowId = 10;
  const res = await FF.tools.close_tab({ tabId: 5 });
  assert.deepEqual(calls, [["query", 10], ["create", 10, "about:blank", false], ["remove", 5]]);
  assert.deepEqual(j(res), { closed: true, tabId: 5 });
});

test("close_tab adds no placeholder when the agent window has other tabs", async () => {
  const calls = [];
  const FF = loadTabTools({
    tabs: {
      query: async () => [{ id: 5 }, { id: 7 }],
      create: async () => calls.push(["create"]),
      remove: async (id) => calls.push(["remove", id]),
    },
  });
  FF.agentWindowId = 10;
  await FF.tools.close_tab({ tabId: 5 });
  assert.deepEqual(calls, [["remove", 5]]);
});

test("close_tab adds no placeholder outside the agent window", async () => {
  const calls = [];
  const FF = loadTabTools({
    tabs: {
      query: async () => [{ id: 5 }],
      create: async () => calls.push(["create"]),
      remove: async (id) => calls.push(["remove", id]),
    },
  });
  FF.agentWindowId = 42;
  await FF.tools.close_tab({ tabId: 5 });
  assert.deepEqual(calls, [["remove", 5]]);
});

test("get_page_text marks a result read from a background tab", async () => {
  const FF = loadTabTools({});
  FF.inject = async () => ({ text: "", truncated: false, length: 0 });
  FF.injectChildFrames = async () => [];
  assert.equal((await FF.tools.get_page_text({}, { id: 5, active: false })).background, true);
  assert.equal((await FF.tools.get_page_text({}, { id: 5, active: true })).background, undefined);
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

test("activate_tab with focusWindow false fronts the tab but leaves the window alone", async () => {
  const calls = [];
  const FF = loadTabTools({
    tabs: { update: async (id, info) => calls.push(["tabs.update", id, info]) },
    windows: { update: async (id, info) => calls.push(["windows.update", id, info]) },
  });
  const res = await FF.tools.activate_tab({ tabId: 7, focusWindow: false });
  assert.deepEqual(j(calls), [["tabs.update", 7, { active: true }]]);
  assert.equal(res.activated, true);
  assert.equal(res.windowFocused, false);
});

test("activate_tab with focusWindow false warns when the window is minimized", async () => {
  const FF = loadTabTools({
    tabs: { update: async () => {} },
    windows: { update: async () => assert.fail("must not focus"), get: async (id) => ({ id, state: "minimized" }) },
  });
  const res = await FF.tools.activate_tab({ tabId: 7, focusWindow: false });
  assert.match(res.warning, /minimized/);
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

test("get_tabs_summary flags only the agent tab with agent: true", async () => {
  const FF = loadTabTools({
    tabs: {
      query: async () => [
        { id: 3, url: "https://a.com", title: "A", active: true, pinned: false, windowId: 1 },
        { id: 12, url: "https://b.com", title: "B", active: false, pinned: false, windowId: 1 },
      ],
    },
  });
  FF.agentTabId = 12;
  const res = await FF.tools.get_tabs_summary();
  assert.equal("agent" in res.tabs[0], false);
  assert.equal(res.tabs[1].agent, true);
});

test("get_tabs_summary names the container of tabs inside one, and only those", async () => {
  const FF = loadTabTools({
    contextualIdentities: { query: async () => [{ name: "Gmail", cookieStoreId: "firefox-container-7" }] },
    tabs: {
      query: async () => [
        { id: 1, url: "https://mail.google.com", title: "Inbox", cookieStoreId: "firefox-container-7", windowId: 1 },
        { id: 2, url: "https://x.com", title: "X", cookieStoreId: "firefox-default", windowId: 1 },
      ],
    },
  });
  const res = await FF.tools.get_tabs_summary();
  assert.equal(res.tabs[0].container, "Gmail");
  assert.equal("container" in res.tabs[1], false);
});

test("screenshot captures a background tab in place — no tab activation, no window focus", async () => {
  const captured = [];
  const FF = loadTabTools({
    tabs: {
      captureTab: async (id, opts) => (captured.push([id, opts]), "data:image/png;base64,AA=="),
      update: async () => {
        throw new Error("must not activate the tab");
      },
    },
    windows: {
      update: async () => {
        throw new Error("must not focus the window");
      },
    },
  });
  FF.inject = async () => ({ w: 800, h: 600 });
  const res = await FF.tools.screenshot({ tabId: 12, format: "jpeg", quality: 50 }, { id: 12, active: false, windowId: 1 });
  assert.deepEqual(j(captured), [[12, { format: "jpeg", quality: 50 }]]);
  assert.equal(res.dataUrl, "data:image/png;base64,AA==");
  assert.equal(res.width, 800);
});

test("find_element rejects a call with neither text nor selector", async () => {
  const FF = loadTabTools({});
  FF.inject = async () => {
    throw new Error("must not inject");
  };
  for (const args of [{}, { text: "" }, { selector: "" }]) {
    await assert.rejects(FF.tools.find_element(args, { id: 1 }), (err) => err.code === "INVALID_ARGS");
  }
});

test("find_element looks in child frames only after the top frame misses, and names the frame", async () => {
  const FF = loadTabTools({});
  const miss = { found: false, count: 1, hidden: 1 };
  FF.inject = async () => miss;
  FF.injectChildFrames = async () => [
    { frameId: 5, result: { found: false, count: 2, hidden: 2 } },
    { frameId: 6, result: { found: true, count: 1, x: 3, y: 4, ref: "r" } },
  ];
  const res = await FF.tools.find_element({ text: "Send" }, { id: 1 });
  assert.equal(res.found, true);
  assert.equal(res.frameId, 6);

  FF.injectChildFrames = async () => [{ frameId: 5, result: { found: false, count: 2, hidden: 2 } }];
  const none = await FF.tools.find_element({ text: "Send" }, { id: 1 });
  assert.equal(none.found, false);
  assert.equal(none.count, 3);
  assert.equal(none.hidden, 3);

  FF.inject = async () => ({ found: true, count: 1 });
  FF.injectChildFrames = async () => {
    throw new Error("must not search frames after a top-frame hit");
  };
  assert.equal((await FF.tools.find_element({ text: "Send" }, { id: 1 })).found, true);
});

test("get_page_text joins frame text under headers and applies maxLength to the whole", async () => {
  const FF = loadTabTools({});
  FF.inject = async () => ({ text: "top", truncated: false, length: 3 });
  FF.injectChildFrames = async () => [
    { frameId: 5, result: { text: "chat", truncated: false, length: 4, url: "https://x/chat" } },
    { frameId: 6, result: { text: "   ", truncated: false, length: 3, url: "https://x/ad" } },
  ];
  const all = await FF.tools.get_page_text({}, { id: 1 });
  assert.equal(all.text, "top\n\n[frame: https://x/chat]\nchat");
  assert.equal(all.truncated, false);
  assert.equal(all.length, all.text.length);

  const cut = await FF.tools.get_page_text({ maxLength: 10 }, { id: 1 });
  assert.equal(cut.text.length, 10);
  assert.equal(cut.truncated, true);
  assert.equal(cut.length, all.text.length);
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

test("close_agent_tabs closes the agent's background tabs and leaves the one you're viewing", async () => {
  const removed = [];
  const FF = loadTabTools({
    tabs: {
      query: async () => [
        { id: 1, active: false },
        { id: 2, active: true },
        { id: 3, active: false },
        { id: 4, active: false },
      ],
      remove: async (ids) => removed.push(...ids),
    },
  });
  FF.expectedCloses = new Set();
  FF.markedTabs.set(1, "a");
  FF.markedTabs.set(2, null);
  FF.agentTabId = 3;

  const dry = await FF.tools.close_agent_tabs({ dryRun: true });
  assert.deepEqual(j(dry), { closed: [], wouldClose: [1, 3], kept: [2] });
  assert.deepEqual(removed, [], "a dry run closes nothing");

  const res = await FF.tools.close_agent_tabs({});
  assert.deepEqual(j(res), { closed: [1, 3], kept: [2] });
  assert.deepEqual(removed, [1, 3], "tab 4 was never the agent's");
  assert.deepEqual([...FF.expectedCloses].sort(), [1, 3], "closes are deliberate, not container reopens");
});

test("close_agent_tabs closes agent-window tabs even in front, leaving a blank tab so the window survives", async () => {
  const calls = [];
  const FF = loadTabTools({
    tabs: {
      query: async (q) =>
        q?.windowId === 10
          ? [{ id: 5, windowId: 10 }, { id: 6, windowId: 10 }]
          : [
              { id: 5, windowId: 10, active: true },
              { id: 6, windowId: 10, active: false },
              { id: 7, windowId: 3, active: true },
            ],
      create: async (opts) => (calls.push(["create", opts.windowId, opts.url]), { id: 8 }),
      remove: async (ids) => calls.push(["remove", ids]),
    },
  });
  FF.expectedCloses = new Set();
  FF.agentWindowId = 10;
  for (const id of [5, 6, 7]) FF.markedTabs.set(id, null);
  const res = await FF.tools.close_agent_tabs({});
  assert.deepEqual(j(res), { closed: [5, 6], kept: [7] });
  assert.deepEqual(j(calls), [["create", 10, "about:blank"], ["remove", [5, 6]]]);
});

test("get_tabs_summary flags every agent-opened tab with opened: true", async () => {
  const FF = loadTabTools({
    tabs: { query: async () => [{ id: 1, title: "a" }, { id: 2, title: "b" }, { id: 3, title: "c" }] },
  });
  FF.markedTabs.set(1, null);
  FF.agentTabId = 2;
  const { tabs } = j(await FF.tools.get_tabs_summary());
  assert.deepEqual(tabs.map((t) => [t.id, !!t.opened, !!t.agent]), [[1, true, false], [2, true, true], [3, false, false]]);
});

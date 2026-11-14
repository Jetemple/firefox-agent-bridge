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
  "focus-gate.js",
  "tools/containers.js",
  "tools/close-tab.js",
  "tools/close-agent-tabs.js",
  "tools/open-tab.js",
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
// focusAllowed: the user's "let agents take focus" setting, which lives in the
// extension page's localStorage.
function loadTabTools(browserStub, { focusAllowed = false } = {}) {
  const sandbox = {
    browser: browserStub,
    console,
    localStorage: { getItem: (key) => (key === "allowWindowFocus" && focusAllowed ? "true" : null) },
  };
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

test("close_tab closes the tab resolveTab picks when no tabId is given", async () => {
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

test("the blank tab close_tab leaves behind is an agent-window tab", async () => {
  const FF = loadTabTools({
    tabs: {
      query: async () => [{ id: 5, windowId: 10 }],
      create: async () => ({ id: 6 }),
      remove: async () => {},
    },
  });
  FF.agentWindowId = 10;
  await FF.tools.close_tab({ tabId: 5 });
  assert.equal(FF.agentWindowTabs.has(6), true, "so later tabs can be fronted over it");
});

test("two closes at once on the agent window's last two tabs still leave a blank tab", async () => {
  const open = new Set([5, 6]);
  const created = [];
  const FF = loadTabTools({
    tabs: {
      query: async () => [...open].map((id) => ({ id, windowId: 10 })),
      create: async (opts) => (created.push(opts.url), open.add(7), { id: 7 }),
      remove: async (id) => {
        await new Promise((r) => setTimeout(r, 2));
        open.delete(id);
      },
    },
  });
  FF.agentWindowId = 10;
  await Promise.all([FF.tools.close_tab({ tabId: 5 }), FF.tools.close_tab({ tabId: 6 })]);
  assert.deepEqual(created, ["about:blank"]);
  assert.deepEqual([...open], [7]);
});

test("close_tab keeps the agent window alive right after an extension reload", async () => {
  // The in-memory window id is gone after a reload; the window's tag is not.
  const created = [];
  const FF = loadTabTools({
    sessions: { getWindowValue: async (id, key) => id === 10 && key === "ffAgentWindow" },
    windows: { getAll: async () => [{ id: 1 }, { id: 10 }], get: async (id) => ({ id, state: "normal" }) },
    tabs: {
      query: async () => [{ id: 5, windowId: 10 }],
      create: async (opts) => (created.push(opts.windowId), { id: 6 }),
      remove: async () => {},
    },
  });
  assert.equal(FF.agentWindowId, null);
  await FF.tools.close_tab({ tabId: 5 });
  assert.deepEqual(created, [10]);
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

// Tab 7 sits in window 10. agentWindow: window 10 is the agent window, tab 7
// was placed there by it, and another agent tab (8) is in front.
function activateSetup({ focusAllowed = false, agentWindow = false, focused = false, state = "normal" } = {}) {
  const calls = [];
  const FF = loadTabTools(
    {
      tabs: {
        update: async (id, info) => calls.push(["tabs.update", id, info]),
        query: async () => [{ id: 8, windowId: 10, active: true }],
      },
      windows: {
        update: async (id, info) => calls.push(["windows.update", id, info]),
        get: async (id) => ({ id, state, focused }),
      },
    },
    { focusAllowed },
  );
  if (agentWindow) {
    FF.agentWindowId = 10;
    FF.agentWindowTabs = new Set([7, 8]);
  }
  return { FF, calls };
}

test("activate_tab does not switch a tab in the user's window unless the user allowed it", async () => {
  const { FF, calls } = activateSetup();
  for (const args of [{ tabId: 7 }, { tabId: 7, focusWindow: false }]) {
    const res = await FF.tools.activate_tab(args);
    assert.equal(res.activated, false);
    assert.equal(res.windowFocused, false);
    assert.match(res.note, /extension panel/);
  }
  assert.deepEqual(j(calls), [], "neither the tab nor the window was touched");
});

test("activate_tab fronts an agent tab inside the agent window but does not focus the window unless the user allowed it", async () => {
  const { FF, calls } = activateSetup({ agentWindow: true });
  const res = await FF.tools.activate_tab({ tabId: 7 });
  assert.deepEqual(j(calls), [["tabs.update", 7, { active: true }]]);
  assert.equal(res.activated, true);
  assert.equal(res.windowFocused, false);
  assert.match(res.note, /extension panel/);
});

test("activate_tab leaves the agent window alone while the user is in it", async () => {
  const { FF, calls } = activateSetup({ agentWindow: true, focused: true });
  FF.onWindowFocusChanged(FF.agentWindowId); // the user clicked into it
  const res = await FF.tools.activate_tab({ tabId: 7 });
  assert.equal(res.activated, false);
  assert.deepEqual(j(calls), []);
});

test("activate_tab leaves the agent window alone while a tab the agent didn't place is in front", async () => {
  const { FF, calls } = activateSetup({ agentWindow: true });
  FF.agentWindowTabs = new Set([7]); // front tab 8 is the user's
  const res = await FF.tools.activate_tab({ tabId: 7 });
  assert.equal(res.activated, false);
  assert.deepEqual(j(calls), []);
});

test("activate_tab activates the tab and focuses its window when the user allowed it", async () => {
  const { FF, calls } = activateSetup({ focusAllowed: true });
  const res = await FF.tools.activate_tab({ tabId: 7 });
  assert.deepEqual(j(calls), [
    ["tabs.update", 7, { active: true }],
    ["windows.update", 10, { focused: true }],
  ]);
  assert.equal(res.activated, true);
  assert.equal(res.tabId, 7);
});

test("activate_tab with focusWindow false fronts the tab but leaves the window alone", async () => {
  const { FF, calls } = activateSetup({ agentWindow: true });
  const res = await FF.tools.activate_tab({ tabId: 7, focusWindow: false });
  assert.deepEqual(j(calls), [["tabs.update", 7, { active: true }]]);
  assert.equal(res.activated, true);
  assert.equal(res.windowFocused, false);
});

test("activate_tab with focusWindow false warns when the window is minimized", async () => {
  const { FF } = activateSetup({ agentWindow: true, state: "minimized" });
  const res = await FF.tools.activate_tab({ tabId: 7, focusWindow: false });
  assert.match(res.warning, /minimized/);
});

test("the focus setting can't be switched on through browser.storage, and is off when it can't be read", async () => {
  // javascript_tool code runs as a content script, which can write
  // browser.storage.local: that must not be where the setting is read from.
  const viaStorage = loadTabTools({ storage: { local: { get: async () => ({ allowWindowFocus: true }) } } });
  assert.equal(await viaStorage.windowFocusAllowed(), false);
  const sandbox = { browser: {}, console };
  vm.createContext(sandbox);
  vm.runInContext(readFileSync(resolve(EXT, "focus-gate.js"), "utf8"), sandbox);
  assert.equal(await sandbox.FFBridge.windowFocusAllowed(), false, "no localStorage at all");
  sandbox.localStorage = { getItem: () => { throw new Error("blocked"); } };
  assert.equal(await sandbox.FFBridge.windowFocusAllowed(), false, "localStorage throws");
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

test("get_tabs_summary says which closed tab ids an open tab stands in for", async () => {
  const FF = loadTabTools({
    tabs: { query: async () => [{ id: 9, url: "https://a.com/", title: "A" }, { id: 2, url: "https://b.com/", title: "B" }] },
  });
  FF.tabAliases = new Map([[5, 7], [7, 9]]); // reopened twice: 5 -> 7 -> 9
  FF.followTab = (id) => { while (FF.tabAliases.has(id)) id = FF.tabAliases.get(id); return id; };
  const res = await FF.tools.get_tabs_summary();
  assert.deepEqual(JSON.parse(JSON.stringify(res.tabs.map((t) => t.replaces ?? null))), [[5, 7], null]);
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
  // Placed by open_tab agentWindow.
  FF.agentWindowTabs = new Set([5, 6]);
  for (const id of [5, 6, 7]) FF.markedTabs.set(id, null);
  const res = await FF.tools.close_agent_tabs({});
  assert.deepEqual(j(res), { closed: [5, 6], kept: [7] });
  assert.deepEqual(j(calls), [["create", 10, "about:blank"], ["remove", [5, 6]]]);
});

test("close_agent_tabs spares a front tab in the agent window that the agent window didn't place", async () => {
  // The remembered agent window is really the user's: tab 5 (a navigate tab) is what they're viewing.
  const removed = [];
  const FF = loadTabTools({
    tabs: {
      query: async () => [
        { id: 5, windowId: 10, active: true },
        { id: 6, windowId: 10, active: false },
      ],
      remove: async (ids) => removed.push(...ids),
    },
  });
  FF.expectedCloses = new Set();
  FF.agentWindowId = 10;
  FF.agentWindowTabs = new Set();
  for (const id of [5, 6]) FF.markedTabs.set(id, null);
  const res = await FF.tools.close_agent_tabs({});
  assert.deepEqual(j(res), { closed: [6], kept: [5] });
  assert.deepEqual(removed, [6]);
});

test("close_agent_tabs with a label closes only that session's tabs", async () => {
  const removed = [];
  const FF = loadTabTools({
    tabs: {
      query: async () => [
        { id: 1, active: false },
        { id: 2, active: false },
        { id: 3, active: false },
        { id: 4, active: false },
        { id: 5, active: false },
      ],
      remove: async (ids) => removed.push(...ids),
    },
  });
  FF.expectedCloses = new Set();
  FF.markedTabs.set(1, "probe");
  FF.markedTabs.set(2, "other-agent");
  FF.markedTabs.set(3, null);
  FF.markedTabs.set(5, "relabeled");
  FF.agentTabId = 3; // the shared agent tab is not this session's
  // tabId: the session's bound tab (5, opened under another label); tab 4 was
  // bound by the user with ff bind and was never the agent's.
  const res = await FF.tools.close_agent_tabs({ label: "probe", tabId: 5 });
  assert.deepEqual(j(res), { closed: [1, 5], kept: [] });
  assert.deepEqual(removed, [1, 5]);
  const userTab = await FF.tools.close_agent_tabs({ label: "probe", tabId: 4, dryRun: true });
  assert.deepEqual(j(userTab).wouldClose, [1], "a session bound to a user tab never closes it");
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

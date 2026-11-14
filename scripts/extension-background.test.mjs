// Tests for firefox-extension/background.js, evaluated in a vm with stubbed
// WebExtension globals (background.js is a plain script, not a module).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";

const SOURCE = readFileSync(new URL("../firefox-extension/background.js", import.meta.url), "utf8");
const NAVIGATE_SOURCE = readFileSync(new URL("../firefox-extension/tools/navigate.js", import.meta.url), "utf8");
const OPEN_TAB_SOURCE = readFileSync(new URL("../firefox-extension/tools/open-tab.js", import.meta.url), "utf8");
const CONTAINERS_SOURCE = readFileSync(new URL("../firefox-extension/tools/containers.js", import.meta.url), "utf8");
const TAB_GROUPS_SOURCE = readFileSync(new URL("../firefox-extension/tools/tab-groups.js", import.meta.url), "utf8");
const RESTRICTED_SOURCE = readFileSync(new URL("../firefox-extension/restricted.js", import.meta.url), "utf8");
const MARKER_SOURCE = readFileSync(new URL("../firefox-extension/marker.js", import.meta.url), "utf8");
const FOCUS_GATE_SOURCE = readFileSync(new URL("../firefox-extension/focus-gate.js", import.meta.url), "utf8");

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

// The sandbox stubs setTimeout, so FF.sleep would never resolve. Swap in a
// fake clock that a sleep advances: wait loops (settleTab, awaitReplacement)
// then run to their deadline instantly instead of hanging the test.
function fakeClock(FF) {
  let t = 0;
  FF.now = () => t;
  FF.sleep = async (ms) => {
    t += ms;
  };
}

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
  fakeClock(sandbox.FFBridge);
  return { FF: sandbox.FFBridge, stored };
}

const AGENT_WINDOW = 900;

function loadWithTools({ tabs = {}, storageData = {}, WebSocketCtor, contextualIdentities, tabGroups, windows, sessions, focusAllowed = false } = {}) {
  const listeners = () => ({ addListener: () => {} });
  const runtimeListeners = {}; // startup / installed, so a test can fire them
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
    // The user's "let agents take focus" setting (focus-gate.js).
    localStorage: { getItem: (key) => (key === "allowWindowFocus" && focusAllowed ? "true" : null) },
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
        onStartup: { addListener: (fn) => (runtimeListeners.startup = fn) },
        onInstalled: { addListener: (fn) => (runtimeListeners.installed = fn) },
        onMessage: listeners(),
      },
      alarms: { create: () => {}, onAlarm: listeners() },
      tabs,
      ...(contextualIdentities ? { contextualIdentities } : {}),
      ...(tabGroups ? { tabGroups } : {}),
      // Agent tabs open in the agent window. Tests that aren't about that
      // window get one that already exists (id AGENT_WINDOW), so open_tab
      // just adds a tab to it; pass `windows` to control it instead.
      windows: windows ?? { get: async (id) => ({ id, state: "normal" }), onRemoved: listeners() },
      ...(sessions ? { sessions } : {}),
    },
  };
  createContext(sandbox);
  // restricted.js + marker.js load first in the real manifest; open-tab.js and
  // background.js's onUpdated listener depend on FF.markedTabs / FF.isRestricted.
  runInContext(RESTRICTED_SOURCE, sandbox, { filename: "restricted.js" });
  runInContext(MARKER_SOURCE, sandbox, { filename: "marker.js" });
  runInContext(FOCUS_GATE_SOURCE, sandbox, { filename: "focus-gate.js" });
  runInContext(SOURCE, sandbox, { filename: "background.js" });
  runInContext(NAVIGATE_SOURCE, sandbox, { filename: "navigate.js" });
  runInContext(CONTAINERS_SOURCE, sandbox, { filename: "containers.js" });
  runInContext(TAB_GROUPS_SOURCE, sandbox, { filename: "tab-groups.js" });
  runInContext(OPEN_TAB_SOURCE, sandbox, { filename: "open-tab.js" });
  if (!windows) sandbox.FFBridge.agentWindowId = AGENT_WINDOW;
  // `sandbox` is the vm's global: setting sandbox.document lets a test drive
  // FF.pageStamp, whose free `document` reference resolves to it.
  fakeClock(sandbox.FFBridge);
  return { FF: sandbox.FFBridge, stored, sandbox, runtimeListeners };
}

// loadWithTools + a captured FF.inject, for the tab-marker paths (open_tab
// registration and the onUpdated re-stamp). Real FF.inject would need
// browser.scripting; we only care which (tabId, prefix) it's asked to apply.
function loadMarked(opts = {}) {
  const ctx = loadWithTools(opts);
  ctx.injectCalls = [];
  ctx.FF.inject = async (tabId, fn, args) => {
    ctx.injectCalls.push({ tabId, args });
  };
  return ctx;
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

test("resolveTab never falls back to the user's active tab when tabId is omitted and no agent tab exists", async () => {
  let queried = false;
  const { FF } = loadBackground({
    tabs: {
      get: async () => {
        throw new Error("should not be called");
      },
      query: async () => ((queried = true), [{ id: 7, active: true }]),
    },
  });
  for (const tabId of [undefined, null]) {
    await assert.rejects(FF.resolveTab(tabId), (err) => {
      assert.equal(err.code, "NO_AGENT_TAB");
      assert.match(err.message, /tabId "active" \(ff --here\)/);
      return true;
    });
  }
  assert.equal(queried, false, "must not even look up the active tab");
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

test("open_tab creates a background tab with a normalized url", async () => {
  const created = [];
  const { FF } = loadWithTools({
    tabs: {
      create: async (opts) => {
        created.push(opts);
        return { id: 55, windowId: 2 };
      },
    },
  });
  const result = await FF.tools.open_tab({ url: "example.com" });
  assert.equal(created.length, 1);
  assert.equal(created[0].url, "https://example.com");
  assert.equal(created[0].active, false);
  assert.equal(result.tabId, 55);
  assert.equal(result.windowId, 2);
  assert.equal(result.url, "https://example.com");
});

test("open_tab activates when asked and the user allowed it", async () => {
  const created = [];
  const { FF } = loadWithTools({
    focusAllowed: true,
    tabs: { create: async (opts) => (created.push(opts), { id: 1, windowId: 1 }) },
  });
  await FF.tools.open_tab({ url: "https://x.com", active: true });
  assert.equal(created[0].active, true);
});

test("open_tab opens in the agent window by default, not the user's window", async () => {
  const created = [];
  const { FF } = loadWithTools({
    tabs: { create: async (opts) => (created.push(opts), { id: 1, windowId: opts.windowId }) },
  });
  const result = await FF.tools.open_tab({ url: "https://x.com" });
  assert.equal(created[0].windowId, AGENT_WINDOW);
  assert.equal(result.windowId, AGENT_WINDOW);
  assert.equal(result.agentWindow, true);
});

test("open_tab allowed in front opens in the user's window", async () => {
  const created = [];
  const { FF } = loadWithTools({
    focusAllowed: true,
    tabs: { create: async (opts) => (created.push(opts), { id: 1, windowId: 1 }) },
  });
  const result = await FF.tools.open_tab({ url: "https://x.com", active: true });
  assert.equal(created[0].windowId, undefined);
  assert.equal(result.agentWindow, undefined);
});

test("open_tab active stays in the background unless the user allowed it", async () => {
  const created = [];
  const { FF } = loadWithTools({
    tabs: { create: async (opts) => (created.push(opts), { id: 1, windowId: 1 }) },
  });
  const result = await FF.tools.open_tab({ url: "https://x.com", active: true });
  assert.equal(created[0].active, false);
  assert.match(result.note, /extension panel/);
});

// --- agent window ----------------------------------------------------------

// Cross-realm objects from the vm fail deepStrictEqual; compare via JSON.
const j = (v) => JSON.parse(JSON.stringify(v));

// A fake windows API: `existing` maps window id -> window; create() makes a new
// one (focused as `focusOnCreate` says) holding a single tab.
function fakeWindows({ existing = {}, focusOnCreate = false, lastFocused = { id: 1 } } = {}) {
  const calls = [];
  const wins = new Map(Object.entries(existing).map(([id, w]) => [Number(id), { id: Number(id), state: "normal", ...w }]));
  let removed = null;
  const api = {
    calls,
    wins,
    fireRemoved: (id) => removed?.(id),
    get: async (id) => {
      calls.push(["get", id]);
      if (!wins.has(id)) throw new Error(`Invalid window ID: ${id}`);
      return wins.get(id);
    },
    getLastFocused: async () => lastFocused,
    create: async (opts) => {
      calls.push(["create", opts]);
      const id = 100 + calls.filter((c) => c[0] === "create").length;
      const win = { id, state: "normal", focused: focusOnCreate, tabs: [{ id: id * 10, windowId: id }] };
      wins.set(id, win);
      return win;
    },
    update: async (id, info) => calls.push(["update", id, info]),
    onRemoved: { addListener: (fn) => (removed = fn) },
  };
  return api;
}

test("open_tab agentWindow creates an unfocused window the first time, then opens background tabs in it", async () => {
  const created = [];
  const windows = fakeWindows();
  const { FF } = loadWithTools({
    windows,
    tabs: {
      create: async (opts) => (created.push(opts), { id: 7, windowId: opts.windowId }),
      // The window's own first tab (the agent's) is in front.
      query: async () => [{ id: 1010, windowId: 101 }],
    },
  });
  const first = await FF.tools.open_tab({ url: "x.com", agentWindow: true });
  assert.deepEqual(j(windows.calls.find((c) => c[0] === "create")), ["create", { url: "https://x.com", focused: false }]);
  assert.equal(created.length, 0, "the new window's own tab is used, not an extra one");
  assert.equal(first.tabId, 1010);
  assert.equal(first.windowId, 101);
  assert.equal(first.agentWindow, true);
  assert.equal(first.warning, undefined);
  assert.equal(FF.agentWindowId, 101);

  const second = await FF.tools.open_tab({ url: "youtube.com", agentWindow: true, active: true });
  // Front tab of the agent window from the start, so pages that render only
  // when visible load right away; the window itself is never focused.
  assert.deepEqual(j(created), [{ url: "https://youtube.com", active: true, windowId: 101 }]);
  assert.equal(second.tabId, 7);
  assert.equal(windows.calls.filter((c) => c[0] === "create").length, 1);
  assert.ok(!windows.calls.some((c) => c[0] === "update"), "never touches window focus");
});

test("Firefox startup creates the agent window when there is none", async () => {
  const windows = fakeWindows();
  const { FF } = loadWithTools({ windows, tabs: {} });
  await FF.onStartup();
  assert.deepEqual(j(windows.calls.filter((c) => c[0] === "create")), [["create", { url: "about:blank", focused: false }]]);
  assert.equal(FF.agentWindowId, 101);
});

test("Firefox startup leaves an existing agent window alone", async () => {
  const windows = fakeWindows({ existing: { 50: {} } });
  const { FF } = loadWithTools({ windows, tabs: {} });
  FF.agentWindowId = 50;
  await FF.onStartup();
  assert.equal(windows.calls.filter((c) => c[0] === "create").length, 0);
});

test("the browser's startup event is what creates the agent window", async () => {
  const windows = fakeWindows();
  const { FF, runtimeListeners } = loadWithTools({ windows, tabs: {} });
  await runtimeListeners.startup();
  assert.equal(windows.calls.filter((c) => c[0] === "create").length, 1);
  assert.equal(FF.agentWindowId, 101);
});

test("a first install creates the agent window; an update does not", async () => {
  const updated = fakeWindows();
  await loadWithTools({ windows: updated, tabs: {} }).runtimeListeners.installed({ reason: "update" });
  assert.equal(updated.calls.filter((c) => c[0] === "create").length, 0);
  const installed = fakeWindows();
  await loadWithTools({ windows: installed, tabs: {} }).runtimeListeners.installed({ reason: "install" });
  assert.equal(installed.calls.filter((c) => c[0] === "create").length, 1);
});

test("two opens at the same moment share one new agent window", async () => {
  const windows = fakeWindows();
  const create = windows.create;
  windows.create = async (opts) => {
    await new Promise((r) => setTimeout(r, 5)); // the second open arrives meanwhile
    return create(opts);
  };
  const made = [];
  const { FF } = loadWithTools({
    windows,
    tabs: { create: async (opts) => (made.push(opts), { id: 7, windowId: opts.windowId }) },
  });
  const [a, b] = await Promise.all([FF.tools.open_tab({ url: "a.com" }), FF.tools.open_tab({ url: "b.com" })]);
  assert.equal(windows.calls.filter((c) => c[0] === "create").length, 1);
  assert.deepEqual([a.windowId, b.windowId], [101, 101]);
});

test("an open racing the startup creation does not make a second window", async () => {
  const windows = fakeWindows();
  const create = windows.create;
  windows.create = async (opts) => {
    await new Promise((r) => setTimeout(r, 5));
    return create(opts);
  };
  const { FF } = loadWithTools({ windows, tabs: { create: async (opts) => ({ id: 7, windowId: opts.windowId }) } });
  const [, opened] = await Promise.all([FF.onStartup(), FF.tools.open_tab({ url: "a.com" })]);
  assert.equal(windows.calls.filter((c) => c[0] === "create").length, 1);
  assert.equal(opened.windowId, 101);
});

test("the agent window is kept when it is the only window and holds only agent tabs", async () => {
  // No user window open (macOS), or only a private one the extension can't see.
  const windows = fakeWindows();
  windows.getAll = async () => [...windows.wins.values()];
  const made = [];
  const { FF } = loadWithTools({
    windows,
    tabs: {
      create: async (opts) => (made.push(opts), { id: 7, windowId: opts.windowId }),
      query: async () => [{ id: 1010, windowId: 101 }],
    },
  });
  await FF.tools.open_tab({ url: "a.com" }); // creates window 101 with tab 1010
  const second = await FF.tools.open_tab({ url: "b.com" });
  assert.equal(windows.calls.filter((c) => c[0] === "create").length, 1, "no second window");
  assert.equal(second.windowId, 101);
});

test("nothing is fronted in the agent window while it is the focused window", async () => {
  const windows = fakeWindows({ existing: { 50: { state: "normal", focused: true } } });
  const made = [];
  const { FF } = loadWithTools({
    windows,
    tabs: {
      create: async (opts) => (made.push(opts), { id: 7, windowId: opts.windowId }),
      query: async () => [{ id: 6, windowId: 50 }],
    },
  });
  FF.agentWindowId = 50;
  FF.agentWindowTabs.add(6);
  FF.onWindowFocusChanged(50); // the user clicked into the agent window
  await FF.tools.open_tab({ url: "a.com" });
  assert.equal(made[0].active, false, "open behind what they see");
  FF.onWindowFocusChanged(3); // and went back to their own window
  await FF.tools.open_tab({ url: "b.com" });
  assert.equal(made[1].active, true);
});

test("an agent window restored after startup made a new one replaces it; no duplicate stays", async () => {
  const removed = [];
  const untagged = [];
  const { FF } = loadWithTools({
    windows: { get: async (id) => ({ id, state: "normal" }), remove: async (id) => removed.push(id) },
    sessions: {
      getWindowValue: async (id) => id === 70 || id === 71,
      removeWindowValue: async (id) => untagged.push(id),
    },
    tabs: { query: async ({ windowId }) => (windowId === 60 ? [{ id: 600, url: "about:blank" }] : [{ id: 610, url: "https://x.com/" }]) },
  });
  FF.sleep = async () => {};
  FF.agentWindowId = 60; // made at startup, still blank
  await FF.onWindowCreated({ id: 70 }); // the restored agent window arrives
  assert.deepEqual(removed, [60]);
  assert.equal(FF.agentWindowId, 70);
  await FF.onWindowCreated({ id: 5 }); // an ordinary window: nothing happens
  await FF.onWindowCreated({ id: 71 }); // another tagged one, but ours is in use now
  assert.deepEqual(removed, [60]);
  assert.deepEqual(untagged, [71]);
  assert.equal(FF.agentWindowId, 70);
});

test("the focus a new agent window gets by being created is not the user being in it", async () => {
  // Firefox focuses a new window despite focused:false; found in a real run,
  // where agents then never fronted their tabs.
  const windows = fakeWindows({ focusOnCreate: true });
  const made = [];
  const { FF } = loadWithTools({
    windows,
    tabs: {
      create: async (opts) => (made.push(opts), { id: 7, windowId: opts.windowId }),
      query: async () => [{ id: 1010, windowId: 101 }],
    },
  });
  await FF.tools.open_tab({ url: "a.com" }); // creates window 101, focused
  FF.onWindowFocusChanged(101); // the focus event creation itself causes
  await FF.tools.open_tab({ url: "b.com" });
  assert.equal(made[0].active, true, "fronted over the window's own first tab");
});

test("a container reopen of an agent-window tab stays an agent-window tab", () => {
  const { FF } = loadWithTools();
  FF.markedTabs.set(20, null);
  FF.agentWindowTabs.add(20);
  FF.onTabRemoved(20, { windowId: AGENT_WINDOW });
  FF.onTabCreated({ id: 21, windowId: AGENT_WINDOW });
  assert.equal(FF.followTab(20), 21);
  assert.equal(FF.agentWindowTabs.has(21), true, "or nothing in the window is fronted again");
  assert.equal(FF.agentWindowTabs.has(20), false);
});

// Multi-Account Containers opens its copy with no windowId, so the copy lands in
// whichever window is current: the user's, not the agent window.
for (const order of ["closed first", "copy first"]) {
  test(`a container copy of an agent-window tab that opened in the user's window is followed and moved back (${order})`, async () => {
    const moves = [];
    // Copied: an object made inside the extension's sandbox never deep-equals one made here.
    const { FF } = loadWithTools({ tabs: { move: async (id, props) => moves.push([id, { ...props }]) } });
    FF.markedTabs.set(20, "rt");
    FF.agentWindowTabs.add(20);
    const copy = { id: 21, windowId: 1, cookieStoreId: "firefox-container-1" };
    if (order === "copy first") FF.onTabCreated(copy);
    FF.onTabRemoved(20, { windowId: AGENT_WINDOW });
    if (order === "closed first") FF.onTabCreated(copy);
    assert.equal(await FF.awaitReplacement(20), 21, "the session's tab id follows the copy");
    assert.deepEqual(moves, [[21, { windowId: AGENT_WINDOW, index: -1 }]]);
    assert.equal(FF.agentWindowTabs.has(21), true);
    assert.equal(FF.markedTabs.get(21), "rt");
  });
}

test("a tab the user opens in their own window is never taken for an agent-window tab's copy", async () => {
  const moves = [];
  const { FF } = loadWithTools({ tabs: { move: async (id, props) => moves.push([id, props]) } });
  FF.markedTabs.set(20, null);
  FF.agentWindowTabs.add(20);
  FF.onTabRemoved(20, { windowId: AGENT_WINDOW });
  FF.onTabCreated({ id: 21, windowId: 1, cookieStoreId: "firefox-default" });
  FF.onTabCreated({ id: 22, windowId: 1, cookieStoreId: "firefox-private" });
  assert.equal(FF.followTab(20), 20, "only a container tab can be a container extension's copy");
  assert.deepEqual(moves, []);
});

test("an agent tab outside the agent window is not followed into another window", () => {
  const { FF } = loadWithTools();
  FF.markedTabs.set(20, null);
  FF.onTabRemoved(20, { windowId: 1 });
  FF.onTabCreated({ id: 21, windowId: 2, cookieStoreId: "firefox-container-1" });
  assert.equal(FF.followTab(20), 20);
});

test("a tool waits until the copy is back in the agent window before it touches the tab", async () => {
  let moved;
  const { FF } = loadWithTools({ tabs: { move: () => new Promise((resolve) => (moved = resolve)) } });
  FF.markedTabs.set(20, null);
  FF.agentWindowTabs.add(20);
  FF.onTabRemoved(20, { windowId: AGENT_WINDOW });
  FF.onTabCreated({ id: 21, windowId: 1, cookieStoreId: "firefox-container-1" });
  let resolved = false;
  const waiting = FF.awaitReplacement(20).then(() => (resolved = true));
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(resolved, false, "or the tool would bring it to the front of the user's window");
  moved();
  await waiting;
});

test("a closed tab is no longer an agent-window tab", () => {
  const { FF } = loadWithTools();
  FF.agentWindowTabs.add(20);
  FF.expectedCloses.add(20);
  FF.onTabRemoved(20, { windowId: AGENT_WINDOW });
  assert.equal(FF.agentWindowTabs.has(20), false, "Firefox can reuse the id for a tab of the user's");
});

test("a tab id remembered from before Firefox restarted is refused, not acted on", async () => {
  FakeWebSocket.instances = [];
  let ran = 0;
  const { FF } = loadWithTools({
    WebSocketCtor: FakeWebSocket,
    tabs: { get: async (id) => ({ id, windowId: 1, active: false, url: "https://x.com", status: "complete" }) },
  });
  FF.tools.get_page_text = async (args) => (ran++, { text: "ok", sawTabRun: "tabRun" in args });
  const sock = FakeWebSocket.instances[0];
  sock.fire("message", { data: JSON.stringify({ id: "1", tool: "get_page_text", args: { tabId: 5, tabRun: "an-earlier-run" } }) });
  sock.fire("message", { data: JSON.stringify({ id: "2", tool: "get_page_text", args: { tabId: 5, tabRun: FF.runId } }) });
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(sock.sent.find((m) => m.id === "1").error.code, "TAB_NOT_FOUND");
  assert.deepEqual(sock.sent.find((m) => m.id === "2").result, { text: "ok", sawTabRun: false });
  assert.equal(ran, 1);
});

test("a tool that fronted its tab sees it as the front tab", async () => {
  FakeWebSocket.instances = [];
  const windows = fakeWindows({ existing: { 50: { state: "normal" } } });
  const { FF } = loadWithTools({
    WebSocketCtor: FakeWebSocket,
    windows,
    tabs: {
      get: async (id) => ({ id, windowId: 50, active: false, url: "https://x.com", status: "complete" }),
      update: async (id) => ({ id }),
      query: async () => [{ id: 6, windowId: 50 }],
    },
  });
  FF.agentWindowId = 50;
  FF.agentWindowTabs.add(5);
  FF.agentWindowTabs.add(6);
  FF.sleep = async () => {};
  FF.tools.get_page_text = async (args, tab) => ({ active: tab.active });
  const sock = FakeWebSocket.instances[0];
  sock.fire("message", { data: JSON.stringify({ id: "1", tool: "get_page_text", args: { tabId: 5 } }) });
  await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(sock.sent.find((m) => m.id === "1").result, { active: true });
});

test("a tool whose tab Firefox refused to front still sees it as a background tab", async () => {
  FakeWebSocket.instances = [];
  const windows = fakeWindows({ existing: { 50: { state: "normal" } } });
  const { FF } = loadWithTools({
    WebSocketCtor: FakeWebSocket,
    windows,
    tabs: {
      get: async (id) => ({ id, windowId: 50, active: false, url: "https://x.com", status: "complete" }),
      update: async (id) => ({ id, active: false }), // no error, but the front tab didn't change
      query: async () => [{ id: 6, windowId: 50 }],
    },
  });
  FF.agentWindowId = 50;
  FF.agentWindowTabs.add(5);
  FF.agentWindowTabs.add(6);
  FF.sleep = async () => {};
  FF.tools.get_page_text = async (args, tab) => ({ active: tab.active });
  const sock = FakeWebSocket.instances[0];
  sock.fire("message", { data: JSON.stringify({ id: "1", tool: "get_page_text", args: { tabId: 5 } }) });
  await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(sock.sent.find((m) => m.id === "1").result, { active: false, frontBlocked: true });
});

test("navigate passes on the agent window's warning and, for ownTab, the run id", async () => {
  const windows = fakeWindows({ focusOnCreate: true });
  const { FF } = loadWithTools({ windows, tabs: {} });
  const own = await FF.tools.navigate({ url: "example.com", ownTab: true });
  assert.match(own.warning, /focused the new agent window/);
  assert.equal(own.runId, FF.runId);
  assert.equal(typeof own.runId, "string");
});

test("open_tab agentWindow recreates the window after the user closes it", async () => {
  const windows = fakeWindows();
  const { FF } = loadWithTools({ windows, tabs: { create: async (opts) => ({ id: 7, windowId: opts.windowId }) } });
  await FF.tools.open_tab({ url: "x.com", agentWindow: true });
  // Closed and reported: the listener forgets it.
  windows.wins.delete(101);
  windows.fireRemoved(101);
  assert.equal(FF.agentWindowId, null);
  const res = await FF.tools.open_tab({ url: "x.com", agentWindow: true });
  assert.equal(res.windowId, 102);
  // Closed without the event (e.g. missed while asleep): windows.get fails, recreate.
  windows.wins.delete(102);
  const again = await FF.tools.open_tab({ url: "x.com", agentWindow: true });
  assert.equal(again.windowId, 103);
  assert.equal(FF.agentWindowId, 103);
});

test("open_tab agentWindow finds its window again after an extension reload, instead of making a new one", async () => {
  // Firefox keeps session values on a window across extension reloads; the
  // extension's in-memory id does not survive. A new window steals focus on macOS.
  const values = new Map();
  const sessions = {
    setWindowValue: async (id, key, v) => values.set(`${id}:${key}`, v),
    getWindowValue: async (id, key) => values.get(`${id}:${key}`),
  };
  // The user's own window 1 is open too.
  const windows = fakeWindows({ existing: { 1: { state: "normal" } } });
  windows.getAll = async () => [...windows.wins.values()];
  const tabs = { create: async (opts) => ({ id: 7, windowId: opts.windowId }) };
  const first = loadWithTools({ windows, sessions, tabs }).FF;
  await first.tools.open_tab({ url: "x.com", agentWindow: true });
  assert.equal(first.agentWindowId, 101);

  const reloaded = loadWithTools({ windows, sessions, tabs }).FF;
  assert.equal(reloaded.agentWindowId, null);
  const res = await reloaded.tools.open_tab({ url: "youtube.com", agentWindow: true });
  assert.equal(res.windowId, 101);
  assert.equal(windows.calls.filter((c) => c[0] === "create").length, 1, "no second window");
});

test("open_tab agentWindow warns when the agent window is minimized", async () => {
  const windows = fakeWindows({ existing: { 50: { state: "minimized" } } });
  const { FF } = loadWithTools({ windows, tabs: { create: async (opts) => ({ id: 7, windowId: opts.windowId }) } });
  FF.agentWindowId = 50;
  const res = await FF.tools.open_tab({ url: "x.com", agentWindow: true });
  assert.equal(res.windowId, 50);
  assert.match(res.warning, /agent window is minimized/);
  assert.ok(!windows.calls.some((c) => c[0] === "update"), "doesn't restore (and so raise) the window itself");
});

test("open_tab agentWindow never focuses the user's window, even if Firefox focused the new one", async () => {
  // Refocusing "the window the user was in" raises the user's main Firefox
  // window over whatever app they were actually using: worse than the steal.
  const windows = fakeWindows({ focusOnCreate: true, lastFocused: { id: 3 } });
  const { FF } = loadWithTools({ windows, tabs: {} });
  const res = await FF.tools.open_tab({ url: "x.com", agentWindow: true });
  assert.deepEqual(j(windows.calls.filter((c) => c[0] === "update")), []);
  assert.match(res.warning, /focused the new agent window/);
});

test("open_tab agentWindow: two opens at once share one new window", async () => {
  const windows = fakeWindows();
  const { FF } = loadWithTools({ windows, tabs: { create: async (opts) => ({ id: 7, windowId: opts.windowId }) } });
  const [a, b] = await Promise.all([
    FF.tools.open_tab({ url: "x.com", agentWindow: true }),
    FF.tools.open_tab({ url: "youtube.com", agentWindow: true }),
  ]);
  assert.equal(windows.calls.filter((c) => c[0] === "create").length, 1);
  assert.equal(a.windowId, 101);
  assert.equal(b.windowId, 101);
});

test("a tool on a tab in a minimized agent window fails with WINDOW_MINIMIZED instead of reading nothing", async () => {
  FakeWebSocket.instances = [];
  const windows = fakeWindows({ existing: { 50: { state: "minimized" } } });
  const { FF } = loadWithTools({
    WebSocketCtor: FakeWebSocket,
    windows,
    tabs: { get: async (id) => ({ id, windowId: 50, url: "https://x.com", status: "complete" }) },
  });
  FF.agentWindowId = 50;
  FF.tools.get_page_text = async () => ({ text: "" });
  const sock = FakeWebSocket.instances[0];
  sock.fire("message", { data: JSON.stringify({ id: "1", tool: "get_page_text", args: { tabId: 5 } }) });
  await new Promise((r) => setImmediate(r));
  const reply = sock.sent.find((m) => m.id === "1");
  assert.equal(reply.error.code, "WINDOW_MINIMIZED");
  assert.match(reply.error.message, /Restore it/);

  // Restored: the same call goes through.
  windows.wins.get(50).state = "normal";
  sock.fire("message", { data: JSON.stringify({ id: "2", tool: "get_page_text", args: { tabId: 5 } }) });
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(sock.sent.find((m) => m.id === "2").result, { text: "" });
});

test("a tool on a background tab of the agent window fronts it first, without focusing the window", async () => {
  FakeWebSocket.instances = [];
  const windows = fakeWindows({ existing: { 50: { state: "normal" } } });
  const updates = [];
  const { FF } = loadWithTools({
    WebSocketCtor: FakeWebSocket,
    windows,
    tabs: {
      get: async (id) => ({ id, windowId: 50, active: id === 6, url: "https://x.com", status: "complete" }),
      update: async (id, info) => (updates.push([id, info]), { id }),
      query: async () => [{ id: 6, windowId: 50 }],
    },
  });
  FF.agentWindowId = 50;
  // Both tabs were placed in the agent window by open_tab agentWindow.
  FF.agentWindowTabs.add(5);
  FF.agentWindowTabs.add(6);
  FF.sleep = async () => {};
  FF.tools.get_page_text = async () => ({ text: "ok" });
  const sock = FakeWebSocket.instances[0];
  sock.fire("message", { data: JSON.stringify({ id: "1", tool: "get_page_text", args: { tabId: 5 } }) });
  await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(sock.sent.find((m) => m.id === "1").result, { text: "ok" });
  assert.deepEqual(j(updates), [[5, { active: true }]]);
  assert.ok(!windows.calls.some((c) => c[0] === "update"), "never focuses the window");

  // Already in front: nothing to do.
  sock.fire("message", { data: JSON.stringify({ id: "2", tool: "get_page_text", args: { tabId: 6 } }) });
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(updates.length, 1);
});

// The bug these guard against: the remembered agent window had become the
// user's own window, so every read of an agent tab there switched their view.
function frontingHarness({ frontTabId, agentTabs = [] }) {
  FakeWebSocket.instances = [];
  const updates = [];
  const { FF } = loadWithTools({
    WebSocketCtor: FakeWebSocket,
    windows: fakeWindows({ existing: { 50: { state: "normal" } } }),
    tabs: {
      get: async (id) => ({ id, windowId: 50, active: id === frontTabId, url: "https://x.com", status: "complete" }),
      update: async (id, info) => (updates.push([id, info]), { id }),
      query: async ({ active, windowId }) => (active && windowId === 50 ? [{ id: frontTabId, windowId: 50 }] : []),
    },
  });
  FF.agentWindowId = 50;
  FF.sleep = async () => {};
  for (const id of agentTabs) FF.agentWindowTabs.add(id);
  FF.tools.get_page_text = async () => ({ text: "ok" });
  const call = async (id, tabId) => {
    const sock = FakeWebSocket.instances[0];
    sock.fire("message", { data: JSON.stringify({ id, tool: "get_page_text", args: { tabId } }) });
    await new Promise((r) => setTimeout(r, 5));
    return sock.sent.find((m) => m.id === id);
  };
  return { FF, updates, call };
}

test("a tab in the agent window that the agent window didn't place (e.g. a navigate tab) is never fronted", async () => {
  // Tab 112 came from navigate/open_tab into the user's current window, which
  // the extension wrongly remembers as the agent window.
  const { updates, call } = frontingHarness({ frontTabId: 110 });
  assert.deepEqual((await call("1", 112)).result, { text: "ok" });
  assert.deepEqual(updates, []);
});

test("an agent-window tab is not fronted while a tab the agent doesn't own is in front of that window", async () => {
  // The user is working in (or has taken over) the agent window.
  const { updates, call } = frontingHarness({ frontTabId: 99, agentTabs: [5] });
  assert.deepEqual((await call("1", 5)).result, { text: "ok" });
  assert.deepEqual(updates, []);
});

test("open_tab agentWindow drops a tagged window that is the user's only window and makes a new one", async () => {
  // How the bug arises: the user closed their own window and kept working in
  // the agent window, which still carries the tag.
  const values = new Map([["50:ffAgentWindow", true]]);
  const sessions = {
    setWindowValue: async (id, key, v) => values.set(`${id}:${key}`, v),
    getWindowValue: async (id, key) => values.get(`${id}:${key}`),
    removeWindowValue: async (id, key) => values.delete(`${id}:${key}`),
  };
  const windows = fakeWindows({ existing: { 50: { state: "normal" } } });
  windows.getAll = async () => [...windows.wins.values()];
  const created = [];
  const { FF } = loadWithTools({
    windows,
    sessions,
    tabs: {
      create: async (opts) => (created.push(opts), { id: 7, windowId: opts.windowId }),
      // Tab 99 is one the user opened there; the agent window never placed it.
      query: async (q) => (q.windowId === 50 ? [{ id: 99, windowId: 50 }] : []),
    },
  });
  const res = await FF.tools.open_tab({ url: "x.com", agentWindow: true });
  assert.equal(created.length, 0, "no tab opened in the user's window");
  assert.equal(res.windowId, 101, "a fresh agent window");
  assert.equal(FF.agentWindowId, 101);
  assert.equal(values.has("50:ffAgentWindow"), false, "the user's window is untagged");
  assert.equal(values.get("101:ffAgentWindow"), true);
});

test("open_tab agentWindow opens in the background when a tab the agent doesn't own is in front of the agent window", async () => {
  const windows = fakeWindows({ existing: { 50: { state: "normal" } } });
  const created = [];
  const { FF } = loadWithTools({
    windows,
    tabs: {
      create: async (opts) => (created.push(opts), { id: 7, windowId: opts.windowId }),
      query: async () => [{ id: 99, windowId: 50 }],
    },
  });
  FF.agentWindowId = 50;
  await FF.tools.open_tab({ url: "x.com", agentWindow: true });
  assert.equal(created[0].active, false);
  assert.ok(FF.agentWindowTabs.has(7), "still the agent's tab");
});

test("agent-window tab membership survives an extension reload", async () => {
  // Session tab values outlive the extension's memory, like the window tag.
  const values = new Map();
  const sessions = {
    setWindowValue: async (id, key, v) => values.set(`w${id}:${key}`, v),
    getWindowValue: async (id, key) => values.get(`w${id}:${key}`),
    setTabValue: async (id, key, v) => values.set(`t${id}:${key}`, v),
    getTabValue: async (id, key) => values.get(`t${id}:${key}`),
  };
  const windows = fakeWindows();
  const first = loadWithTools({ windows, sessions, tabs: {} }).FF;
  await first.tools.open_tab({ url: "x.com", agentWindow: true });
  const reloaded = loadWithTools({ windows, sessions, tabs: {} }).FF;
  assert.equal(reloaded.agentWindowTabs.has(1010), false);
  assert.equal(await reloaded.isAgentWindowTab(1010), true);
  assert.equal(await reloaded.isAgentWindowTab(1011), false);
});

test("a background tab outside the agent window is never fronted", async () => {
  FakeWebSocket.instances = [];
  const updates = [];
  const { FF } = loadWithTools({
    WebSocketCtor: FakeWebSocket,
    windows: fakeWindows(),
    tabs: {
      get: async (id) => ({ id, windowId: 3, active: false, url: "https://x.com", status: "complete" }),
      update: async (id, info) => updates.push([id, info]),
    },
  });
  FF.agentWindowId = 50;
  FF.tools.get_page_text = async () => ({ text: "ok" });
  const sock = FakeWebSocket.instances[0];
  sock.fire("message", { data: JSON.stringify({ id: "1", tool: "get_page_text", args: { tabId: 5 } }) });
  await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(sock.sent.find((m) => m.id === "1").result, { text: "ok" });
  assert.equal(updates.length, 0);
});

test("a tab open_tab created is never another tab's replacement (issue #5)", async () => {
  // Agent A's tab 1 closes unexpectedly; agent B's open_tab creates tab 2 in the
  // same window before B has marked it, so it looks like 1's replacement.
  const { FF } = loadWithTools({ tabs: { create: async () => ({ id: 2, windowId: 3 }) } });
  FF.markedTabs.set(1, "agent-a");
  FF.onTabRemoved(1, { windowId: 3 });
  FF.onTabCreated({ id: 2, windowId: 3 });
  assert.equal(FF.followTab(1), 2, "adopted before B could claim it");
  await FF.tools.open_tab({ url: "x.com", label: "agent-b" });
  assert.equal(FF.followTab(1), 1, "B's open claims tab 2, so A's stale id no longer points at it");
  assert.equal(FF.markedTabs.get(2), "agent-b");
});

// --- containers ------------------------------------------------------------

const CONTAINERS = [
  { name: "Personal", cookieStoreId: "firefox-container-1", color: "blue", icon: "fingerprint" },
  { name: "Gmail", cookieStoreId: "firefox-container-7", color: "red", icon: "circle" },
];
const identities = (list = CONTAINERS) => ({ query: async () => list });

test("open_tab --container opens the tab in that container, matched by name case-insensitively", async () => {
  const created = [];
  const { FF } = loadWithTools({
    contextualIdentities: identities(),
    tabs: {
      create: async (opts) => (created.push(opts), { id: 55, windowId: 2, cookieStoreId: opts.cookieStoreId }),
    },
  });
  const result = await FF.tools.open_tab({ url: "mail.google.com", container: "gmail" });
  assert.equal(created[0].cookieStoreId, "firefox-container-7");
  assert.equal(created[0].active, false);
  assert.equal(result.container, "Gmail");
});

test("open_tab --container accepts a cookieStoreId", async () => {
  const created = [];
  const { FF } = loadWithTools({
    contextualIdentities: identities(),
    tabs: { create: async (opts) => (created.push(opts), { id: 5, windowId: 1, cookieStoreId: opts.cookieStoreId }) },
  });
  await FF.tools.open_tab({ url: "x.com", container: "firefox-container-1" });
  assert.equal(created[0].cookieStoreId, "firefox-container-1");
});

test("open_tab with an unknown container fails listing the real ones, and opens nothing", async () => {
  const created = [];
  const { FF } = loadWithTools({
    contextualIdentities: identities(),
    tabs: { create: async (opts) => (created.push(opts), { id: 1, windowId: 1 }) },
  });
  await assert.rejects(FF.tools.open_tab({ url: "x.com", container: "Work" }), (err) => {
    assert.equal(err.code, "INVALID_ARGS");
    assert.match(err.message, /No container named "Work"\. Containers: Personal, Gmail/);
    return true;
  });
  assert.equal(created.length, 0);
});

test("open_tab with a container fails clearly when containers are turned off", async () => {
  const { FF } = loadWithTools({
    contextualIdentities: { query: async () => { throw new Error("Contextual identities are currently disabled"); } },
    tabs: { create: async () => assert.fail("must not open a tab") },
  });
  await assert.rejects(FF.tools.open_tab({ url: "x.com", container: "Gmail" }), /containers are turned off/);
});

test("open_tab refuses an ambiguous container name", async () => {
  const dupes = [...CONTAINERS, { name: "gmail", cookieStoreId: "firefox-container-9" }];
  const { FF } = loadWithTools({
    contextualIdentities: identities(dupes),
    tabs: { create: async () => assert.fail("must not open a tab") },
  });
  await assert.rejects(FF.tools.open_tab({ url: "x.com", container: "Gmail" }), /firefox-container-7, firefox-container-9/);
});

test("open_tab reports the container the tab really landed in, not the one asked for", async () => {
  // A Multi-Account Containers "always open in" rule can move the tab.
  const { FF } = loadWithTools({
    contextualIdentities: identities(),
    tabs: { create: async () => ({ id: 3, windowId: 1, cookieStoreId: "firefox-container-1" }) },
  });
  const result = await FF.tools.open_tab({ url: "x.com", container: "Gmail" });
  assert.equal(result.container, "Personal");
});

test("open_tab without a container adds no cookieStoreId and no container field", async () => {
  const created = [];
  const { FF } = loadWithTools({
    contextualIdentities: identities(),
    tabs: { create: async (opts) => (created.push(opts), { id: 4, windowId: 1, cookieStoreId: "firefox-default" }) },
  });
  const result = await FF.tools.open_tab({ url: "x.com" });
  assert.equal("cookieStoreId" in created[0], false);
  assert.equal("container" in result, false);
});

test("get_containers lists name, id, color and icon", async () => {
  const { FF } = loadWithTools({ contextualIdentities: identities() });
  const res = await FF.tools.get_containers({});
  assert.deepEqual(JSON.parse(JSON.stringify(res)), { containers: CONTAINERS });
});

test("get_containers answers an empty list when containers are off or the API is missing", async () => {
  const { FF } = loadWithTools();
  assert.deepEqual(JSON.parse(JSON.stringify(await FF.tools.get_containers({}))), { containers: [] });
});

// --- tab marker ------------------------------------------------------------

test("open_tab registers the opened tab for marking, carrying the session label", async () => {
  const { FF } = loadMarked({ tabs: { create: async () => ({ id: 55, windowId: 2 }) } });
  await FF.tools.open_tab({ url: "example.com", label: "airbnb" });
  assert.equal(FF.markedTabs.get(55), "airbnb");
});

test("open_tab with no label registers an emoji-only mark (null)", async () => {
  const { FF } = loadMarked({ tabs: { create: async () => ({ id: 7, windowId: 1 }) } });
  await FF.tools.open_tab({ url: "example.com" });
  assert.equal(FF.markedTabs.has(7), true);
  assert.equal(FF.markedTabs.get(7), null);
});

test("onTabUpdated stamps a marked tab on load-complete with the session prefix", async () => {
  const ctx = loadMarked();
  ctx.FF.markedTabs.set(55, "airbnb");
  await ctx.FF.onTabUpdated(55, { status: "complete" }, { url: "https://x.com" });
  assert.equal(ctx.injectCalls.length, 1);
  assert.equal(ctx.injectCalls[0].tabId, 55);
  // args = [regexSource, prefix]; the prefix carries the label.
  assert.equal(ctx.injectCalls[0].args[1], "🤖 airbnb · ");
  assert.equal(ctx.injectCalls[0].args[0], ctx.FF.markerRegexSource());
});

test("onTabUpdated re-stamps on a title change (SPA/late title write)", async () => {
  const ctx = loadMarked();
  ctx.FF.markedTabs.set(7, null);
  await ctx.FF.onTabUpdated(7, { title: "New Route" }, { url: "https://x.com" });
  assert.equal(ctx.injectCalls.length, 1);
  assert.equal(ctx.injectCalls[0].args[1], "🤖 "); // emoji-only prefix
});

test("onTabUpdated ignores unmarked tabs", async () => {
  const ctx = loadMarked();
  await ctx.FF.onTabUpdated(999, { status: "complete" }, { url: "https://x.com" });
  assert.equal(ctx.injectCalls.length, 0);
});

test("onTabUpdated ignores changes that are neither title nor load-complete", async () => {
  const ctx = loadMarked();
  ctx.FF.markedTabs.set(7, "airbnb");
  await ctx.FF.onTabUpdated(7, { favIconUrl: "x" }, { url: "https://x.com" });
  await ctx.FF.onTabUpdated(7, { status: "loading" }, { url: "https://x.com" });
  assert.equal(ctx.injectCalls.length, 0);
});

test("onTabUpdated skips restricted / unknown urls", async () => {
  const ctx = loadMarked();
  ctx.FF.markedTabs.set(7, "airbnb");
  await ctx.FF.onTabUpdated(7, { status: "complete" }, { url: "about:blank" });
  await ctx.FF.onTabUpdated(7, { status: "complete" }, {}); // no url → treated as restricted
  assert.equal(ctx.injectCalls.length, 0);
});

test("onTabUpdated swallows injection failures (transient load races)", async () => {
  const ctx = loadWithTools();
  ctx.FF.markedTabs.set(7, "airbnb");
  ctx.FF.inject = async () => {
    throw ctx.FF.bridgeError("SCRIPT_FAILED", "executeScript failed");
  };
  await assert.doesNotReject(ctx.FF.onTabUpdated(7, { status: "complete" }, { url: "https://x.com" }));
});

test("onTabRemoved drops the mark", () => {
  const ctx = loadMarked();
  ctx.FF.markedTabs.set(7, "airbnb");
  ctx.FF.onTabRemoved(7);
  assert.equal(ctx.FF.markedTabs.has(7), false);
});

test("pageStamp (in-page) stamps, is idempotent, and re-stamps a page-changed title", () => {
  const ctx = loadWithTools();
  const re = ctx.FF.markerRegexSource();
  const prefix = ctx.FF.markerPrefix("airbnb");
  ctx.sandbox.document = { title: "Airbnb — Rentals" };

  ctx.FF.pageStamp(re, prefix);
  assert.equal(ctx.sandbox.document.title, "🤖 airbnb · Airbnb — Rentals");

  // Idempotent — running again writes the identical string (no double-stamp,
  // no runaway onUpdated loop).
  ctx.FF.pageStamp(re, prefix);
  assert.equal(ctx.sandbox.document.title, "🤖 airbnb · Airbnb — Rentals");

  // The page (SPA) replaces the title → strip finds no marker, prepend applies.
  ctx.sandbox.document.title = "New Route";
  ctx.FF.pageStamp(re, prefix);
  assert.equal(ctx.sandbox.document.title, "🤖 airbnb · New Route");

  // pageStamp's write matches buildTitle exactly — no format drift.
  assert.equal(ctx.sandbox.document.title, ctx.FF.buildTitle("New Route", "airbnb"));
});

// --- agent tab ---------------------------------------------------------------

test("resolveTab prefers the agent tab over the active tab once it exists", async () => {
  const agent = { id: 12, active: false };
  const { FF } = loadBackground({
    tabs: {
      get: async (id) => {
        assert.equal(id, 12);
        return agent;
      },
      query: async () => {
        throw new Error("must not fall back to the active tab");
      },
    },
  });
  FF.agentTabId = 12;
  assert.equal(await FF.resolveTab(undefined), agent);
});

test("resolveTab throws when the agent tab was closed — never the active tab", async () => {
  let queried = false;
  const { FF } = loadBackground({
    tabs: {
      get: async () => {
        throw new Error("Invalid tab ID: 12");
      },
      query: async () => {
        queried = true;
        return [{ id: 3, active: true }];
      },
    },
  });
  FF.agentTabId = 12;
  await assert.rejects(FF.resolveTab(undefined), (err) => {
    assert.equal(err.code, "TAB_NOT_FOUND");
    assert.match(err.message, /agent tab was closed/);
    return true;
  });
  assert.equal(queried, false, "a closed agent tab must not redirect into the user's tab");
});

test('resolveTab("active") returns the viewed tab even when an agent tab exists', async () => {
  const active = { id: 3, active: true };
  const { FF } = loadBackground({
    tabs: {
      get: async () => {
        throw new Error("should not look up the agent tab");
      },
      query: async () => [active],
    },
  });
  FF.agentTabId = 12;
  assert.equal(await FF.resolveTab("active"), active);
});

test("navigate and open_tab reject a blank url instead of loading https://", async () => {
  const { FF } = loadWithTools({
    tabs: {
      create: async () => {
        throw new Error("must not open a tab");
      },
    },
  });
  for (const url of ["", "   "]) {
    await assert.rejects(FF.tools.navigate({ url }), (err) => err.code === "INVALID_ARGS");
    await assert.rejects(FF.tools.open_tab({ url }), (err) => err.code === "INVALID_ARGS");
  }
});

test("navigate with no tabId opens a background agent tab and marks it", async () => {
  const created = [];
  const { FF } = loadWithTools({
    tabs: { create: async (opts) => (created.push(opts), { id: 12, windowId: 1 }) },
  });
  const result = await FF.tools.navigate({ url: "example.com" });
  assert.equal(created.length, 1);
  assert.equal(created[0].active, false, "must not switch the user's view");
  assert.equal(created[0].url, "https://example.com");
  assert.equal(result.tabId, 12);
  assert.equal(FF.agentTabId, 12);
  assert.equal(FF.markedTabs.get(12), null);
});

test("navigate ownTab opens a fresh background tab for that MCP connection and leaves the shared agent tab alone", async () => {
  const created = [];
  const { FF } = loadWithTools({
    tabs: {
      create: async (opts) => (created.push(opts), { id: 13, windowId: 1 }),
      update: async () => {
        throw new Error("must not reuse another agent's tab");
      },
    },
  });
  FF.agentTabId = 12; // some other agent's (or the CLI's) tab
  const result = await FF.tools.navigate({ url: "example.com", ownTab: true });
  assert.equal(created[0].active, false, "must not switch the user's view");
  assert.equal(result.tabId, 13);
  assert.equal(FF.agentTabId, 12, "the shared agent tab is unchanged");
  assert.equal(FF.markedTabs.get(13), null, "still an agent tab (marked, closable)");
});

test("navigate opens its tabs in the agent window, not the user's window", async () => {
  const created = [];
  const { FF } = loadWithTools({
    tabs: { create: async (opts) => (created.push(opts), { id: 20 + created.length, windowId: opts.windowId }) },
  });
  await FF.tools.navigate({ url: "example.com" });
  await FF.tools.navigate({ url: "example.org", ownTab: true });
  assert.deepEqual(
    created.map((c) => c.windowId),
    [AGENT_WINDOW, AGENT_WINDOW],
  );
});

test("navigate reuses the agent tab in place, without activating it", async () => {
  const updates = [];
  const { FF } = loadWithTools({
    tabs: {
      create: async () => {
        throw new Error("must reuse the agent tab");
      },
      update: async (id, props) => (updates.push([id, props]), { id }),
    },
  });
  FF.agentTabId = 12;
  const result = await FF.tools.navigate({ url: "https://other.com" });
  assert.equal(result.tabId, 12);
  assert.equal(updates.length, 1);
  assert.equal(updates[0][0], 12);
  assert.equal(updates[0][1].url, "https://other.com");
  assert.equal(updates[0][1].active, undefined, "update must not activate");
});

// Multi-Account Containers cancels the load and opens a copy beside the tab,
// which Firefox refuses unless the tab's window is the current one. In the agent
// window nothing would open at all, so the extension makes the copy itself.
function loadWithContainersAddon(assignment, tab) {
  const calls = { created: [], removed: [], updated: [], asked: [] };
  const loaded = loadWithTools({
    tabs: {
      get: async (id) => ({ ...tab, id }),
      create: async (props) => (calls.created.push({ ...props }), { id: 41, windowId: props.windowId }),
      update: async (id, props) => (calls.updated.push([id, { ...props }]), { ...tab, id }),
      remove: async (id) => calls.removed.push(id),
    },
  });
  loaded.sandbox.browser.runtime.sendMessage = async (addon, message) => {
    calls.asked.push([addon, { ...message }]);
    return assignment;
  };
  return { ...loaded, calls };
}

test("navigate moves an agent-window tab to the container its site is assigned to, itself", async () => {
  const tab = { windowId: AGENT_WINDOW, index: 2, active: true, cookieStoreId: "firefox-default", url: "https://a.example/" };
  const { FF, calls } = loadWithContainersAddon({ userContextId: "3", neverAsk: false }, tab);
  FF.markedTabs.set(40, "work");
  FF.agentWindowTabs.add(40);
  const result = await FF.tools.navigate({ url: "https://mail.example/", tabId: 40 });
  assert.deepEqual(calls.asked, [["@testpilot-containers", { method: "getAssignment", url: "https://mail.example/" }]]);
  assert.deepEqual(calls.created, [
    { url: "https://mail.example/", cookieStoreId: "firefox-container-3", windowId: AGENT_WINDOW, index: 3, active: true },
  ]);
  assert.deepEqual(calls.removed, [40]);
  assert.deepEqual(calls.updated, [], "the add-on would cancel a load in the old tab");
  assert.equal(result.tabId, 41);
  assert.equal(FF.followTab(40), 41, "the session's old tab id keeps working");
  assert.equal(FF.markedTabs.get(41), "work");
  assert.equal(FF.agentWindowTabs.has(41), true);
  assert.equal(FF.expectedCloses.has(40), true, "our own close is not a tab going missing");
});

test("navigate loads in place when the site has no container, or the tab is already in it", async () => {
  const tab = { windowId: AGENT_WINDOW, index: 2, active: false, cookieStoreId: "firefox-container-3", url: "https://a.example/" };
  for (const assignment of [null, undefined, { userContextId: "3", neverAsk: true }]) {
    const { FF, calls } = loadWithContainersAddon(assignment, tab);
    FF.agentWindowTabs.add(40);
    const result = await FF.tools.navigate({ url: "https://mail.example/", tabId: 40 });
    assert.deepEqual(calls.created, []);
    assert.equal(calls.updated.length, 1);
    assert.equal(result.tabId, 40);
  }
});

test("navigate never swaps a tab outside the agent window: the add-on handles the user's windows", async () => {
  const tab = { windowId: 1, index: 0, active: true, cookieStoreId: "firefox-default", url: "https://a.example/" };
  const { FF, calls } = loadWithContainersAddon({ userContextId: "3", neverAsk: true }, tab);
  await FF.tools.navigate({ url: "https://mail.example/", tabId: 40 });
  assert.deepEqual(calls.created, []);
  assert.deepEqual(calls.asked, []);
  assert.equal(calls.updated.length, 1);
});

test("navigate loads in place when the containers add-on is not installed", async () => {
  const tab = { windowId: AGENT_WINDOW, index: 2, active: false, cookieStoreId: "firefox-default", url: "https://a.example/" };
  const { FF, calls, sandbox } = loadWithContainersAddon(null, tab);
  sandbox.browser.runtime.sendMessage = async () => {
    throw new Error("Could not establish connection. Receiving end does not exist.");
  };
  FF.agentWindowTabs.add(40);
  const result = await FF.tools.navigate({ url: "https://mail.example/", tabId: 40 });
  assert.equal(result.tabId, 40);
  assert.equal(calls.updated.length, 1);
});

test("navigate opens a fresh agent tab when the old one was closed", async () => {
  const created = [];
  const { FF } = loadWithTools({
    tabs: {
      update: async () => {
        throw new Error("Invalid tab ID: 12");
      },
      create: async (opts) => (created.push(opts), { id: 13, windowId: 1 }),
    },
  });
  FF.agentTabId = 12;
  const result = await FF.tools.navigate({ url: "example.com" });
  assert.equal(result.tabId, 13);
  assert.equal(created[0].active, false);
  assert.equal(FF.agentTabId, 13);
});

test('navigate with tabId "active" loads the viewed tab and leaves the agent tab alone', async () => {
  const updates = [];
  const { FF } = loadWithTools({
    tabs: {
      query: async () => [{ id: 3, active: true }],
      update: async (id, props) => (updates.push([id, props]), { id }),
    },
  });
  FF.agentTabId = 12;
  const result = await FF.tools.navigate({ url: "example.com", tabId: "active" });
  assert.equal(result.tabId, 3);
  assert.equal(updates[0][0], 3);
  assert.equal(FF.agentTabId, 12);
});

// --- replaced tabs (container extensions reopen a tab under a new id) -------

test("an agent tab closed right after a sibling opened is followed to that sibling", async () => {
  const { FF } = loadMarked({ tabs: { create: async () => ({ id: 864, windowId: 3 }) } });
  await FF.tools.open_tab({ url: "reddit.com", label: "rt" });
  FF.onTabCreated({ id: 865, windowId: 3 });
  FF.onTabRemoved(864, { windowId: 3 });
  assert.equal(FF.followTab(864), 865);
  assert.equal(FF.markedTabs.get(865), "rt");
  assert.equal(FF.markedTabs.has(864), false);
});

test("a replacement that opens just after the close is adopted too", () => {
  const { FF } = loadWithTools();
  FF.agentTabId = 20;
  FF.onTabRemoved(20, { windowId: 1 });
  FF.onTabCreated({ id: 21, windowId: 1 });
  assert.equal(FF.followTab(20), 21);
  assert.equal(FF.agentTabId, 21);
});

test("openerTabId picks the replacement among several new tabs", () => {
  const { FF } = loadWithTools();
  FF.markedTabs.set(30, null);
  FF.onTabCreated({ id: 31, windowId: 1 });
  FF.onTabCreated({ id: 32, windowId: 1, openerTabId: 30 });
  FF.onTabRemoved(30, { windowId: 1 });
  assert.equal(FF.followTab(30), 32);
});

test("ambiguous, other-window, unowned and deliberate closes are never followed", () => {
  const { FF } = loadWithTools();
  // two candidates, no opener
  FF.markedTabs.set(40, null);
  FF.onTabCreated({ id: 41, windowId: 1 });
  FF.onTabCreated({ id: 42, windowId: 1 });
  FF.onTabRemoved(40, { windowId: 1 });
  assert.equal(FF.followTab(40), 40);

  const other = loadWithTools().FF;
  other.markedTabs.set(50, null);
  other.onTabCreated({ id: 51, windowId: 2 });
  other.onTabRemoved(50, { windowId: 1 });
  assert.equal(other.followTab(50), 50);

  const unowned = loadWithTools().FF;
  unowned.onTabCreated({ id: 61, windowId: 1 });
  unowned.onTabRemoved(60, { windowId: 1 });
  assert.equal(unowned.followTab(60), 60);

  const closed = loadWithTools().FF;
  closed.markedTabs.set(70, null);
  closed.expectedCloses.add(70);
  closed.onTabCreated({ id: 71, windowId: 1 });
  closed.onTabRemoved(70, { windowId: 1 });
  assert.equal(closed.followTab(70), 70);
});

test("a stale new tab outside the window is not adopted", () => {
  const { FF } = loadWithTools();
  let t = 1000;
  FF.now = () => t;
  FF.markedTabs.set(80, null);
  FF.onTabCreated({ id: 81, windowId: 1 });
  t += 5000;
  FF.onTabRemoved(80, { windowId: 1 });
  assert.equal(FF.followTab(80), 80);
});

test("dispatch rewrites a replaced tabId before the tool runs", async () => {
  FakeWebSocket.instances = [];
  const updates = [];
  const { FF } = loadWithTools({
    WebSocketCtor: FakeWebSocket,
    tabs: { update: async (id, props) => (updates.push(id), { id }) },
  });
  FF.markedTabs.set(90, null);
  FF.onTabCreated({ id: 91, windowId: 1 });
  FF.onTabRemoved(90, { windowId: 1 });
  const sock = FakeWebSocket.instances[0];
  sock.fire("message", { data: JSON.stringify({ id: "1", tool: "navigate", args: { url: "x.com", tabId: 90 } }) });
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(updates, [91]);
  assert.equal(sock.sent.at(-1).result.tabId, 91);
});

test("resolveTab waits out the replacement window for a just-orphaned agent tab", async () => {
  let t = 0;
  const { FF } = loadWithTools({
    tabs: { get: async (id) => (id === 101 ? { id: 101, url: "https://x.com" } : Promise.reject(new Error("gone"))) },
  });
  FF.now = () => t;
  FF.sleep = async (ms) => {
    t += ms;
    if (t === 300) FF.onTabCreated({ id: 101, windowId: 1 });
  };
  FF.agentTabId = 100;
  FF.onTabRemoved(100, { windowId: 1 });
  const tab = await FF.resolveTab(undefined);
  assert.equal(tab.id, 101);
});

test("open_tab reports the URL the tab actually landed on", async () => {
  const { FF } = loadWithTools({
    tabs: {
      create: async () => ({ id: 55, windowId: 2, url: "about:blank" }),
      get: async (id) => ({ id, windowId: 2, url: "https://example.com/en/" }),
    },
  });
  const result = await FF.tools.open_tab({ url: "example.com" });
  assert.equal(result.tabId, 55);
  assert.equal(result.url, "https://example.com/en/");
});

test("open_tab reports the replacement when a container extension reopens the tab", async () => {
  const { FF } = loadWithTools({
    tabs: {
      create: async () => ({ id: 70, windowId: 1, url: "about:blank" }),
      get: async (id) => {
        if (id === 70) {
          // The container extension swaps the tab before its page commits.
          FF.onTabCreated({ id: 71, windowId: 1, openerTabId: 70 });
          FF.onTabRemoved(70, { windowId: 1 });
          throw new Error("Invalid tab ID: 70");
        }
        return { id, windowId: 1, url: "https://old.reddit.com/r/sportsbook/" };
      },
    },
  });
  const result = await FF.tools.open_tab({ url: "https://www.reddit.com/r/sportsbook/", label: "rs" });
  assert.equal(result.tabId, 71);
  assert.equal(result.url, "https://old.reddit.com/r/sportsbook/");
  assert.equal(FF.markedTabs.get(71), "rs", "the session label follows the tab");
});

test("navigate waits for the new page instead of reporting the old one", async () => {
  let gets = 0;
  const { FF } = loadWithTools({
    tabs: {
      update: async (id) => ({ id, url: "https://before.example/" }),
      get: async (id) => ({ id, url: ++gets < 3 ? "https://before.example/" : "https://after.example/landed" }),
    },
  });
  const result = await FF.tools.navigate({ url: "https://after.example/", tabId: 9 });
  assert.deepEqual({ ...result }, { tabId: 9, url: "https://after.example/landed" });
});

test("navigate falls back to the requested URL when the page never changes", async () => {
  const { FF } = loadWithTools({
    tabs: {
      update: async (id) => ({ id, url: "https://before.example/" }),
      get: async (id) => ({ id, url: "https://before.example/" }),
    },
  });
  const result = await FF.tools.navigate({ url: "https://files.example/report.pdf", tabId: 9 });
  assert.equal(result.url, "https://files.example/report.pdf");
});

test("a tool on a just-opened about:blank tab waits for its page, then explains if it never loads", async () => {
  FakeWebSocket.instances = [];
  let url = "about:blank";
  const { FF } = loadWithTools({
    WebSocketCtor: FakeWebSocket,
    tabs: { get: async (id) => ({ id, url, status: "loading" }) },
  });
  FF.tools.get_page_text = async (args, tab) => ({ tabId: tab.id, url: tab.url });
  const sleep = FF.sleep;
  FF.sleep = async (ms) => {
    await sleep(ms);
    if (FF.now() === 500) url = "https://example.com/";
  };
  const sock = FakeWebSocket.instances[0];
  sock.fire("message", { data: JSON.stringify({ id: "1", tool: "get_page_text", args: { tabId: 12 } }) });
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(sock.sent.at(-1).result, { tabId: 12, url: "https://example.com/" });

  FF.sleep = sleep;
  url = "about:blank";
  sock.fire("message", { data: JSON.stringify({ id: "2", tool: "get_page_text", args: { tabId: 12 } }) });
  await new Promise((r) => setImmediate(r));
  const err = sock.sent.at(-1).error;
  assert.equal(err.code, "RESTRICTED_URL");
  assert.match(err.message, /Tab 12 hasn't started loading/);
});

test("injectChildFrames drops the top frame, errors and nulls, and survives a failed call", async () => {
  const { FF, sandbox } = loadWithTools();
  sandbox.browser.scripting = {
    executeScript: async (opts) => {
      assert.equal(opts.target.allFrames, true);
      assert.equal(opts.injectImmediately, true);
      return [
        { frameId: 9, result: "b" },
        { frameId: 0, result: "top" },
        { frameId: 3, result: "a" },
        { frameId: 4, error: new Error("nope") },
        { frameId: 5, result: null },
      ];
    },
  };
  const got = await FF.injectChildFrames(1, () => {});
  assert.deepEqual(got.map((r) => r.frameId), [3, 9]);
  sandbox.browser.scripting.executeScript = async () => {
    throw new Error("restricted");
  };
  assert.equal((await FF.injectChildFrames(1, () => {})).length, 0);
});

test("injectDescending replays in the named frame with the new args and reports that frame", async () => {
  const { FF, sandbox } = loadWithTools();
  const calls = [];
  sandbox.browser.scripting = {
    executeScript: async ({ target, args }) => {
      calls.push([target.frameIds?.[0] ?? null, args[0]]);
      return target.frameIds ? [{ result: { clicked: true } }] : [{ result: { descend: { frameId: 8, args: ["inner"] } } }];
    },
  };
  const res = await FF.injectDescending(1, () => {}, ["outer"]);
  assert.deepEqual(calls, [[null, "outer"], [8, "inner"]]);
  assert.equal(res.clicked, true);
  assert.equal(res.frameId, 8);

  sandbox.browser.scripting.executeScript = async () => [{ result: { descend: { frameId: 8 } } }];
  await assert.rejects(FF.injectDescending(1, () => {}, []), (err) => err.code === "SCRIPT_FAILED");
});

// --- tab groups on open_tab -----------------------------------------------

function groupingTabs(extra = {}) {
  const calls = [];
  const tab = { id: 61, windowId: 3, pinned: false, groupId: -1 };
  return {
    calls,
    tabs: {
      create: async (opts) => (calls.push(["create", opts]), { ...tab }),
      get: async () => ({ ...tab, url: "https://x.com/", status: "complete" }),
      group: async (opts) => (calls.push(["group", opts]), 200),
      remove: async (id) => calls.push(["remove", id]),
      ...extra,
    },
    tabGroups: {
      query: async () => [],
      get: async () => ({ id: 200, title: "", color: "grey" }),
      update: async (id, props) => (calls.push(["update", id, props]), { id, title: props.title, color: props.color ?? "grey" }),
    },
  };
}

test("open_tab --group opens the tab and puts it in a new group titled that name", async () => {
  const g = groupingTabs();
  const { FF } = loadWithTools({ tabs: g.tabs, tabGroups: g.tabGroups });
  const result = await FF.tools.open_tab({ url: "x.com", group: "TV hunt", groupColor: "orange" });
  assert.deepEqual(g.calls.map((c) => c[0]), ["create", "group", "update"]);
  assert.deepEqual(JSON.parse(JSON.stringify(g.calls[1][1])), { tabIds: [61], createProperties: { windowId: 3 } });
  assert.deepEqual(JSON.parse(JSON.stringify(g.calls[2][2])), { title: "TV hunt", color: "orange" });
  assert.equal(result.group, "TV hunt");
  assert.equal(result.tabId, 61);
});

test("open_tab with a bad group color opens nothing", async () => {
  const g = groupingTabs();
  const { FF } = loadWithTools({ tabs: g.tabs, tabGroups: g.tabGroups });
  await assert.rejects(FF.tools.open_tab({ url: "x.com", group: "TV", groupColor: "teal" }), /Unknown group color/);
  assert.equal(g.calls.length, 0);
});

test("open_tab --group on a Firefox without tab groups opens nothing", async () => {
  const g = groupingTabs();
  delete g.tabs.group;
  const { FF } = loadWithTools({ tabs: g.tabs });
  await assert.rejects(FF.tools.open_tab({ url: "x.com", group: "TV" }), /Firefox 139/);
  assert.equal(g.calls.length, 0);
});

test("open_tab closes the tab it opened when grouping it fails", async () => {
  const g = groupingTabs({ group: async () => { throw new Error("group exploded"); } });
  const { FF } = loadWithTools({ tabs: g.tabs, tabGroups: g.tabGroups });
  await assert.rejects(FF.tools.open_tab({ url: "x.com", group: "TV" }), /group exploded/);
  assert.deepEqual(g.calls.map((c) => c[0]), ["create", "remove"]);
  assert.equal(g.calls[1][1], 61);
});

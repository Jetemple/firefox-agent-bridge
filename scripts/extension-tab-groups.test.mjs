// Tab groups (tools/tab-groups.js): group_tabs, ungroup_tabs, get_tab_groups,
// and the group label in get_tabs_summary. Loaded into a sandbox with a
// stubbed browser that keeps a tiny in-memory model of tabs and groups.
import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const EXT = resolve(dirname(fileURLToPath(import.meta.url)), "../firefox-extension");
const FILES = ["restricted.js", "marker.js", "tools/containers.js", "tools/tab-groups.js", "tools/tabs-summary.js"];
const j = (v) => JSON.parse(JSON.stringify(v));

// A fake Firefox: tabs carry groupId (-1 = none); groups have id/title/color/
// collapsed/windowId. tabs.group / ungroup / tabGroups.update mutate it.
function fakeFirefox({ tabs = [], groups = [], withApi = true } = {}) {
  const state = { tabs: tabs.map((t) => ({ groupId: -1, windowId: 1, pinned: false, ...t })), groups: [...groups], calls: [] };
  let nextGroup = 100;
  const browser = {
    tabs: {
      query: async () => state.tabs,
      get: async (id) => state.tabs.find((t) => t.id === id) ?? Promise.reject(new Error("no tab")),
      ...(withApi
        ? {
            group: async (opts) => {
              state.calls.push(["group", opts]);
              let id = opts.groupId;
              if (id == null) {
                id = nextGroup++;
                state.groups.push({ id, title: "", color: "blue", collapsed: false, windowId: opts.createProperties?.windowId });
              }
              const g = state.groups.find((x) => x.id === id);
              for (const t of state.tabs) if (opts.tabIds.includes(t.id)) Object.assign(t, { groupId: id, windowId: g.windowId });
              return id;
            },
            ungroup: async (ids) => {
              state.calls.push(["ungroup", ids]);
              for (const t of state.tabs) if (ids.includes(t.id)) t.groupId = -1;
            },
          }
        : {}),
    },
    ...(withApi
      ? {
          tabGroups: {
            query: async () => state.groups,
            get: async (id) => state.groups.find((g) => g.id === id),
            update: async (id, props) => {
              state.calls.push(["update", id, props]);
              return Object.assign(state.groups.find((g) => g.id === id), props);
            },
          },
        }
      : {}),
  };
  const sandbox = { browser, console };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  for (const f of FILES) vm.runInContext(readFileSync(resolve(EXT, f), "utf8"), sandbox, { filename: f });
  const FF = sandbox.FFBridge;
  FF.bridgeError = (code, message) => Object.assign(new Error(message), { code });
  FF.resolveTab = async (id) => {
    const tab = state.tabs.find((t) => t.id === (id ?? 99));
    if (!tab) throw FF.bridgeError("TAB_NOT_FOUND", `Tab ${id} not found`);
    return tab;
  };
  return { FF, state };
}

test("group_tabs creates and titles a group when none has that name", async () => {
  const { FF, state } = fakeFirefox({ tabs: [{ id: 5, windowId: 2 }, { id: 6, windowId: 2 }] });
  const res = await FF.tools.group_tabs({ group: "TV hunt", tabIds: [5, 6], color: "green" });
  assert.deepEqual(j(state.calls[0]), ["group", { tabIds: [5, 6], createProperties: { windowId: 2 } }]);
  assert.deepEqual(j(state.calls[1]), ["update", 100, { title: "TV hunt", color: "green" }]);
  assert.deepEqual(j(res), { group: "TV hunt", groupId: 100, color: "green", collapsed: false, created: true, tabIds: [5, 6] });
});

test("group_tabs joins an existing group by title, case-insensitively, without renaming it", async () => {
  const { FF, state } = fakeFirefox({
    tabs: [{ id: 5 }, { id: 7, groupId: 3 }],
    groups: [{ id: 3, title: "Research", color: "purple", collapsed: false, windowId: 1 }],
  });
  const res = await FF.tools.group_tabs({ group: "research", tabId: 5 });
  assert.deepEqual(j(state.calls), [["group", { tabIds: [5], groupId: 3 }]]);
  assert.equal(res.group, "Research");
  assert.equal(res.created, false);
  assert.equal(state.tabs[0].groupId, 3);
});

test("group_tabs prefers the same-titled group in the tab's own window", async () => {
  const { FF, state } = fakeFirefox({
    tabs: [{ id: 5, windowId: 2 }],
    groups: [
      { id: 3, title: "Work", windowId: 1 },
      { id: 4, title: "Work", windowId: 2 },
    ],
  });
  await FF.tools.group_tabs({ group: "Work", tabId: 5 });
  assert.equal(state.calls[0][1].groupId, 4);
});

test("group_tabs defaults to the agent tab and can collapse the group", async () => {
  const { FF, state } = fakeFirefox({ tabs: [{ id: 99 }], groups: [{ id: 3, title: "Research", windowId: 1 }] });
  const res = await FF.tools.group_tabs({ group: "Research", collapsed: true });
  assert.deepEqual(j(state.calls), [["group", { tabIds: [99], groupId: 3 }], ["update", 3, { collapsed: true }]]);
  assert.equal(res.collapsed, true);
});

test("group_tabs refuses pinned tabs, unknown colors and empty names before touching anything", async () => {
  const { FF, state } = fakeFirefox({ tabs: [{ id: 5, pinned: true }, { id: 6 }] });
  await assert.rejects(FF.tools.group_tabs({ group: "x", tabIds: [6, 5] }), /Pinned tabs can't join a group: 5/);
  await assert.rejects(FF.tools.group_tabs({ group: "x", tabId: 6, color: "magenta" }), /Unknown group color "magenta"/);
  await assert.rejects(FF.tools.group_tabs({ group: "  ", tabId: 6 }), /non-empty name/);
  await assert.rejects(FF.tools.group_tabs({ group: "x", tabIds: [6, 42] }), /Tab 42 not found/);
  assert.equal(state.calls.length, 0);
});

test("tab group tools fail clearly on a Firefox without tab groups", async () => {
  const { FF } = fakeFirefox({ tabs: [{ id: 5 }], withApi: false });
  await assert.rejects(FF.tools.group_tabs({ group: "x", tabId: 5 }), (err) => err.code === "UNSUPPORTED" && /Firefox 139/.test(err.message));
  await assert.rejects(FF.tools.get_tab_groups({}), /Firefox 139/);
  // The tab list still works, just without group labels.
  const res = await FF.tools.get_tabs_summary();
  assert.equal("group" in res.tabs[0], false);
});

test("ungroup_tabs takes grouped tabs out and reports the ones that weren't grouped", async () => {
  const { FF, state } = fakeFirefox({ tabs: [{ id: 5, groupId: 3 }, { id: 6 }], groups: [{ id: 3, title: "g", windowId: 1 }] });
  const res = await FF.tools.ungroup_tabs({ tabIds: [5, 6] });
  assert.deepEqual(j(state.calls), [["ungroup", [5]]]);
  assert.deepEqual(j(res), { ungrouped: [5], notGrouped: [6] });
});

test("get_tab_groups lists each group with its tabs", async () => {
  const { FF } = fakeFirefox({
    tabs: [{ id: 5, groupId: 3 }, { id: 6 }, { id: 7, groupId: 3 }],
    groups: [{ id: 3, title: "TV", color: "cyan", collapsed: true, windowId: 1 }],
  });
  assert.deepEqual(j(await FF.tools.get_tab_groups({})), {
    groups: [{ id: 3, title: "TV", color: "cyan", collapsed: true, windowId: 1, tabIds: [5, 7] }],
  });
});

test("get_tabs_summary names the group of grouped tabs, and only those", async () => {
  const { FF } = fakeFirefox({
    tabs: [{ id: 5, groupId: 3, url: "u", title: "t" }, { id: 6, url: "u", title: "t" }],
    groups: [{ id: 3, title: "TV", windowId: 1 }],
  });
  const res = await FF.tools.get_tabs_summary();
  assert.equal(res.tabs[0].group, "TV");
  assert.equal("group" in res.tabs[1], false);
});

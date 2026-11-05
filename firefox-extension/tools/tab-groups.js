// Firefox's native tab groups (Firefox 139+): get_tab_groups lists them,
// group_tabs puts tabs in a group by name (joining one with that title, or
// creating it), ungroup_tabs takes tabs out. open_tab and get_tabs_summary use
// the helpers here to group a new tab and to name a tab's group.
{
  const FF = (globalThis.FFBridge ??= {});
  FF.tools ??= {};

  const NO_GROUP = -1;
  const COLORS = ["grey", "blue", "red", "yellow", "green", "pink", "purple", "cyan", "orange"];

  function requireApi() {
    if (typeof browser.tabs?.group !== "function" || !browser.tabGroups?.query) {
      throw FF.bridgeError("UNSUPPORTED", "Tab groups need Firefox 139 or newer");
    }
  }

  async function queryGroups() {
    try {
      return (await browser.tabGroups?.query({})) ?? [];
    } catch {
      return [];
    }
  }

  // groupId → title, for labelling tabs. Untitled groups read as "".
  FF.groupNames = async () => new Map((await queryGroups()).map((g) => [g.id, g.title ?? ""]));

  // The tabs to act on: an explicit list, or the one tab tabId resolves to
  // (the agent tab when omitted). Every id must exist; nothing moves otherwise.
  async function targetTabs(args) {
    const ids = Array.isArray(args.tabIds) && args.tabIds.length ? args.tabIds : [args.tabId];
    const tabs = [];
    for (const id of ids) tabs.push(await FF.resolveTab(id));
    return tabs;
  }

  function checkColor(color) {
    if (color != null && !COLORS.includes(color)) {
      throw FF.bridgeError("INVALID_ARGS", `Unknown group color "${color}". Colors: ${COLORS.join(", ")}`);
    }
  }

  // Put tabs in the group titled `name` (case-insensitive), creating it in the
  // first tab's window if there is none. With several matches, the one in that
  // window wins. Returns what the group looks like afterwards.
  // Fails before anything changes: open_tab calls this before opening a tab.
  FF.checkGroupArgs = ({ name, color } = {}) => {
    requireApi();
    if (!String(name ?? "").trim()) throw FF.bridgeError("INVALID_ARGS", "group must be a non-empty name");
    checkColor(color);
  };

  FF.groupTabs = async (tabs, { name, color, collapsed } = {}) => {
    FF.checkGroupArgs({ name, color });
    const title = String(name).trim();
    const pinned = tabs.filter((t) => t.pinned).map((t) => t.id);
    if (pinned.length) throw FF.bridgeError("INVALID_ARGS", `Pinned tabs can't join a group: ${pinned.join(", ")}`);

    const windowId = tabs[0].windowId;
    const matches = (await queryGroups()).filter((g) => (g.title ?? "").toLowerCase() === title.toLowerCase());
    const existing = matches.find((g) => g.windowId === windowId) ?? matches[0];
    const tabIds = tabs.map((t) => t.id);
    const groupId = existing
      ? await browser.tabs.group({ tabIds, groupId: existing.id })
      : await browser.tabs.group({ tabIds, createProperties: { windowId } });

    const update = {};
    if (!existing) update.title = title;
    if (color != null) update.color = color;
    if (collapsed != null) update.collapsed = collapsed;
    const updated = Object.keys(update).length ? await browser.tabGroups.update(groupId, update) : existing;
    const group = updated ?? (await browser.tabGroups.get(groupId));
    return {
      group: group.title ?? title,
      groupId,
      color: group.color,
      collapsed: !!group.collapsed,
      created: !existing,
      tabIds,
    };
  };

  FF.tools.group_tabs = async (args) => {
    const tabs = await targetTabs(args);
    return FF.groupTabs(tabs, { name: args.group, color: args.color, collapsed: args.collapsed });
  };

  FF.tools.ungroup_tabs = async (args) => {
    requireApi();
    const tabs = await targetTabs(args);
    const grouped = tabs.filter((t) => t.groupId != null && t.groupId !== NO_GROUP).map((t) => t.id);
    if (grouped.length) await browser.tabs.ungroup(grouped);
    return { ungrouped: grouped, notGrouped: tabs.map((t) => t.id).filter((id) => !grouped.includes(id)) };
  };

  FF.tools.get_tab_groups = async () => {
    requireApi();
    const [groups, tabs] = await Promise.all([queryGroups(), browser.tabs.query({})]);
    return {
      groups: groups.map((g) => ({
        id: g.id,
        title: g.title ?? "",
        color: g.color,
        collapsed: !!g.collapsed,
        windowId: g.windowId,
        tabIds: tabs.filter((t) => t.groupId === g.id).map((t) => t.id),
      })),
    };
  };
}

// close_agent_tabs — close the tabs agents opened (open_tab / navigate) during
// this extension run, so finished work doesn't pile up in the strip. With a
// label/tabId (from a session), only that session's tabs; without, every agent's.
// A tab the user is looking at (active in a window other than the agent window)
// is left open even if the agent opened it. dryRun reports what would close without closing anything.
{
  const FF = (globalThis.FFBridge ??= {});
  FF.tools ??= {};

  FF.tools.close_agent_tabs = async (args = {}) => {
    const isAgents = (id) => FF.markedTabs?.has(id) || FF.agentTabId === id;
    let owned;
    if (args.label != null || args.tabId != null) {
      // One session's tabs: those opened under its label, plus its bound tab
      // if an agent opened it (a session bound to a user's tab never closes it).
      owned = new Set([...(FF.markedTabs ?? [])].filter(([, label]) => label === args.label).map(([id]) => id));
      if (args.tabId != null && isAgents(args.tabId)) owned.add(args.tabId);
    } else {
      owned = new Set(FF.markedTabs?.keys() ?? []);
      if (FF.agentTabId != null) owned.add(FF.agentTabId);
    }
    const mine = (await browser.tabs.query({})).filter((t) => owned.has(t.id));
    // The agent window's front tab is the agent's, not one the user is viewing.
    // A front tab is spared unless the agent window placed it there: a tab in
    // front anywhere else may be the one the user is looking at.
    const agentWindowId = (await FF.knownAgentWindowId?.()) ?? FF.agentWindowId;
    const inAgentWindow = (t) =>
      agentWindowId != null && t.windowId === agentWindowId && !!FF.agentWindowTabs?.has(t.id);
    const viewing = (t) => t.active && !inAgentWindow(t);
    const kept = mine.filter(viewing).map((t) => t.id);
    const closingTabs = mine.filter((t) => !viewing(t));
    const closing = closingTabs.map((t) => t.id);
    if (args.dryRun || closing.length === 0) return { closed: [], wouldClose: closing, kept };
    await FF.closeTabs(closingTabs);
    return { closed: closing, kept };
  };
}

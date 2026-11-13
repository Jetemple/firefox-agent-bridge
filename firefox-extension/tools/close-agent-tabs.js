// close_agent_tabs — close every tab the agent opened (open_tab / navigate)
// during this extension run, so finished work doesn't pile up in the strip.
// A tab the user is looking at (active in a window other than the agent window)
// is left open even if the agent opened it. dryRun reports what would close without closing anything.
{
  const FF = (globalThis.FFBridge ??= {});
  FF.tools ??= {};

  FF.tools.close_agent_tabs = async (args = {}) => {
    const owned = new Set(FF.markedTabs?.keys() ?? []);
    if (FF.agentTabId != null) owned.add(FF.agentTabId);
    const mine = (await browser.tabs.query({})).filter((t) => owned.has(t.id));
    // The agent window's front tab is the agent's, not one the user is viewing.
    const inAgentWindow = (t) => FF.agentWindowId != null && t.windowId === FF.agentWindowId;
    const viewing = (t) => t.active && !inAgentWindow(t);
    const kept = mine.filter(viewing).map((t) => t.id);
    const closingTabs = mine.filter((t) => !viewing(t));
    const closing = closingTabs.map((t) => t.id);
    if (args.dryRun || closing.length === 0) return { closed: [], wouldClose: closing, kept };
    for (const id of closing) FF.expectedCloses?.add(id);
    await FF.keepAgentWindow?.(closingTabs);
    await browser.tabs.remove(closing);
    return { closed: closing, kept };
  };
}

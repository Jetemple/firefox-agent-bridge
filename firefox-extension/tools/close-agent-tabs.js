// close_agent_tabs — close every tab the agent opened (open_tab / navigate)
// during this extension run, so finished work doesn't pile up in the strip.
// A tab the user is looking at (active in its window) is left open even if the
// agent opened it. dryRun reports what would close without closing anything.
{
  const FF = (globalThis.FFBridge ??= {});
  FF.tools ??= {};

  FF.tools.close_agent_tabs = async (args = {}) => {
    const owned = new Set(FF.markedTabs?.keys() ?? []);
    if (FF.agentTabId != null) owned.add(FF.agentTabId);
    const mine = (await browser.tabs.query({})).filter((t) => owned.has(t.id));
    const kept = mine.filter((t) => t.active).map((t) => t.id);
    const closing = mine.filter((t) => !t.active).map((t) => t.id);
    if (args.dryRun || closing.length === 0) return { closed: [], wouldClose: closing, kept };
    for (const id of closing) FF.expectedCloses?.add(id);
    await browser.tabs.remove(closing);
    return { closed: closing, kept };
  };
}

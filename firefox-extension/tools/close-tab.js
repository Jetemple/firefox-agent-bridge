// close_tab — close a tab (defaults to the active tab).
{
  const FF = (globalThis.FFBridge ??= {});
  FF.tools ??= {};

  // Closing every tab of the agent window would destroy it, and creating a new
  // one brings Firefox to the front on macOS. Before closing `tabs`, leave a
  // blank tab behind if they are all the agent window has.
  FF.keepAgentWindow = async (tabs) => {
    const winId = FF.agentWindowId;
    if (winId == null) return;
    const closing = new Set(tabs.filter((t) => t.windowId === winId).map((t) => t.id));
    if (!closing.size) return;
    const left = (await browser.tabs.query({ windowId: winId })).filter((t) => !closing.has(t.id));
    if (!left.length) await browser.tabs.create({ url: "about:blank", windowId: winId, active: false });
  };

  FF.tools.close_tab = async (args) => {
    const tab = await FF.resolveTab(args.tabId);
    // A deliberate close, not a container reopen: don't follow it.
    FF.expectedCloses?.add(tab.id);
    await FF.keepAgentWindow([tab]);
    await browser.tabs.remove(tab.id);
    return { closed: true, tabId: tab.id };
  };
}

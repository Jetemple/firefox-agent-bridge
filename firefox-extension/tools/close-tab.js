// close_tab — close a tab (defaults to the agent tab; "active" for the viewed tab).
{
  const FF = (globalThis.FFBridge ??= {});
  FF.tools ??= {};

  // Closing every tab of the agent window would destroy it, and creating a new
  // one brings Firefox to the front on macOS. Before closing `tabs`, leave a
  // blank tab behind if they are all the agent window has.
  FF.keepAgentWindow = async (tabs) => {
    const winId = (await FF.knownAgentWindowId?.()) ?? FF.agentWindowId;
    if (winId == null) return;
    const closing = new Set(tabs.filter((t) => t.windowId === winId).map((t) => t.id));
    if (!closing.size) return;
    const left = (await browser.tabs.query({ windowId: winId })).filter((t) => !closing.has(t.id));
    if (left.length) return;
    const keeper = await browser.tabs.create({ url: "about:blank", windowId: winId, active: false });
    if (keeper?.id != null) await FF.markAgentWindowTab?.(keeper.id);
  };

  // Close tabs, one batch at a time: two closes running together would each
  // see the other's tab still open, leave no blank tab, and lose the window.
  let closing = Promise.resolve();
  FF.closeTabs = (tabs, removeArg = tabs.map((t) => t.id)) => {
    const run = closing.then(async () => {
      // A deliberate close, not a container reopen: don't follow it.
      for (const t of tabs) FF.expectedCloses?.add(t.id);
      await FF.keepAgentWindow(tabs);
      await browser.tabs.remove(removeArg);
    });
    closing = run.catch(() => {});
    return run;
  };

  FF.tools.close_tab = async (args) => {
    const tab = await FF.resolveTab(args.tabId);
    await FF.closeTabs([tab], tab.id);
    return { closed: true, tabId: tab.id };
  };
}

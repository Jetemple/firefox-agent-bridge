// close_tab — close a tab (defaults to the active tab).
{
  const FF = (globalThis.FFBridge ??= {});
  FF.tools ??= {};

  FF.tools.close_tab = async (args) => {
    const tab = await FF.resolveTab(args.tabId);
    // A deliberate close, not a container reopen: don't follow it.
    FF.expectedCloses?.add(tab.id);
    await browser.tabs.remove(tab.id);
    return { closed: true, tabId: tab.id };
  };
}

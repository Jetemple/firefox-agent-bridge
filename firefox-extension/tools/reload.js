// reload — reload a tab, optionally bypassing the cache.
{
  const FF = (globalThis.FFBridge ??= {});
  FF.tools ??= {};

  FF.tools.reload = async (args) => {
    const tab = await FF.resolveTab(args.tabId);
    const bypassCache = Boolean(args.bypassCache);
    await browser.tabs.reload(tab.id, { bypassCache });
    return { reloaded: true, tabId: tab.id, bypassCache };
  };
}

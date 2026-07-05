// open_tab — open a new tab WITHOUT stealing focus (active defaults false).
{
  const FF = (globalThis.FFBridge ??= {});
  FF.tools ??= {};

  FF.tools.open_tab = async (args) => {
    const url = FF.normalizeUrl(args.url);
    const tab = await browser.tabs.create({ url, active: args.active === true });
    return { tabId: tab.id, windowId: tab.windowId, url };
  };
}

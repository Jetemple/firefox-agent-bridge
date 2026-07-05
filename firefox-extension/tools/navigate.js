// navigate — update an existing tab or open a new one.
{
  const FF = (globalThis.FFBridge ??= {});
  FF.tools ??= {};

  function normalizeUrl(input) {
    const u = String(input).trim();
    if (/^(https?|file|ftp|about|moz-extension|view-source|data):/i.test(u)) return u;
    if (u.startsWith("//")) return "https:" + u;
    return "https://" + u;
  }

  FF.normalizeUrl = normalizeUrl;

  FF.tools.navigate = async (args) => {
    const url = normalizeUrl(args.url);
    if (args.tabId != null) {
      let tab;
      try {
        tab = await browser.tabs.update(args.tabId, { url });
      } catch {
        throw FF.bridgeError("TAB_NOT_FOUND", `Tab ${args.tabId} not found`);
      }
      return { tabId: tab.id, url };
    }
    const tab = await browser.tabs.create({ url });
    return { tabId: tab.id, url };
  };
}

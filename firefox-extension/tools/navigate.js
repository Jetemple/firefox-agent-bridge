// navigate — load a URL in a tab without ever switching the user's view.
// No tabId drives the agent tab (reused while open, else a fresh background
// tab); an explicit tabId or "active" updates that tab in place.
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
      const tabId = args.tabId === "active" ? (await FF.resolveTab("active")).id : args.tabId;
      let tab;
      try {
        tab = await browser.tabs.update(tabId, { url });
      } catch {
        throw FF.bridgeError("TAB_NOT_FOUND", `Tab ${tabId} not found`);
      }
      return { tabId: tab.id, url };
    }
    if (FF.agentTabId != null) {
      try {
        const tab = await browser.tabs.update(FF.agentTabId, { url });
        return { tabId: tab.id, url };
      } catch {
        /* agent tab was closed — open a new one below */
      }
    }
    const tab = await browser.tabs.create({ url, active: false });
    FF.agentTabId = tab.id;
    // `?.` keeps this a no-op in harnesses without marker.js loaded.
    FF.markedTabs?.set(tab.id, null);
    return { tabId: tab.id, url };
  };
}

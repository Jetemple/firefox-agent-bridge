// navigate — load a URL in a tab without ever switching the user's view.
// No tabId drives the agent tab (reused while open, else a fresh background
// tab); an explicit tabId or "active" updates that tab in place.
{
  const FF = (globalThis.FFBridge ??= {});
  FF.tools ??= {};

  function normalizeUrl(input) {
    const u = String(input).trim();
    if (!u) throw FF.bridgeError("INVALID_ARGS", "url is empty");
    if (/^(https?|file|ftp|about|moz-extension|view-source|data):/i.test(u)) return u;
    if (u.startsWith("//")) return "https:" + u;
    return "https://" + u;
  }

  FF.normalizeUrl = normalizeUrl;

  // Wait for the tab to land (see FF.settleTab) and report the tab id and URL
  // that will stay valid; fall back to what we asked for if it never does.
  async function landed(tabId, url, fromUrl) {
    const from = fromUrl === url ? undefined : fromUrl;
    const tab = FF.isRestricted(url) ? null : await FF.settleTab?.(tabId, from);
    if (tab && !FF.isRestricted(tab.url) && tab.url !== from) return { tabId: tab.id, url: tab.url };
    return { tabId: FF.followTab?.(tabId) ?? tabId, url };
  }

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
      return landed(tab.id, url, tab.url);
    }
    if (FF.agentTabId != null) {
      let tab = null;
      try {
        tab = await browser.tabs.update(await FF.awaitReplacement(FF.agentTabId), { url });
      } catch {
        /* agent tab was closed — open a new one below */
      }
      if (tab) return landed(tab.id, url, tab.url);
    }
    const tab = await browser.tabs.create({ url, active: false });
    FF.agentTabId = tab.id;
    // `?.` keeps this a no-op in harnesses without marker.js loaded.
    FF.markedTabs?.set(tab.id, null);
    return landed(tab.id, url);
  };
}

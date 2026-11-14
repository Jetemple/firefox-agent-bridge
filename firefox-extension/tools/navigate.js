// navigate — load a URL in a tab without ever switching the user's view.
// No tabId drives the agent tab (reused while open, else a fresh tab in the
// agent window); ownTab always opens a fresh one there (the MCP bridge's
// per-connection tab); an explicit tabId or "active" updates that tab in place.
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

  // Multi-Account Containers moves a tab to the container its site is assigned
  // to by cancelling the load and opening a copy beside it. Firefox refuses
  // that copy unless the tab's window is the current one, so in the agent
  // window nothing opens and the tab stays where it was. For an agent-window
  // tab, ask the add-on where the site belongs and make the copy here: the
  // add-on then finds the tab already in the right container and leaves it.
  const CONTAINERS_ADDON = "@testpilot-containers";
  async function moveToAssignedContainer(tabId, url) {
    try {
      if (!(await FF.isAgentWindowTab?.(tabId))) return null;
      const site = await browser.runtime.sendMessage(CONTAINERS_ADDON, { method: "getAssignment", url });
      if (site?.userContextId == null) return null;
      const assigned = Number(site.userContextId);
      const cookieStoreId = assigned === 0 ? "firefox-default" : `firefox-container-${assigned}`;
      const tab = await browser.tabs.get(tabId);
      if (tab.cookieStoreId === cookieStoreId) return null;
      const copy = await browser.tabs.create({ url, cookieStoreId, windowId: tab.windowId, index: tab.index + 1, active: tab.active });
      FF.swapTab(tab, copy);
      await browser.tabs.remove(tab.id).catch(() => {});
      return copy;
    } catch {
      return null; // no such add-on, or no such container: load in place
    }
  }

  // Load a URL in a tab that exists; throws if the tab is gone.
  async function loadInTab(tabId, url) {
    const copy = await moveToAssignedContainer(tabId, url);
    if (copy) return landed(copy.id, url);
    const tab = await browser.tabs.update(tabId, { url });
    return landed(tab.id, url, tab.url);
  }

  FF.tools.navigate = async (args) => {
    const url = normalizeUrl(args.url);
    if (args.tabId != null) {
      const tabId = args.tabId === "active" ? (await FF.resolveTab("active")).id : args.tabId;
      try {
        return await loadInTab(tabId, url);
      } catch {
        throw FF.bridgeError("TAB_NOT_FOUND", `Tab ${tabId} not found`);
      }
    }
    // ownTab: the MCP bridge asking for a connection's own tab, so agents on
    // separate connections never share (and clobber) the one agent tab.
    if (args.ownTab) {
      const { tab, warning } = await FF.openInAgentWindow(url);
      FF.markedTabs?.set(tab.id, null);
      // runId: the bridge remembers this tab id and sends the runId back with
      // it (tabRun), so a stale id is refused after a Firefox restart.
      return { ...(await landed(tab.id, url)), runId: FF.runId, ...(warning ? { warning } : {}) };
    }
    if (FF.agentTabId != null) {
      try {
        return await loadInTab(await FF.awaitReplacement(FF.agentTabId), url);
      } catch {
        /* agent tab was closed — open a new one below */
      }
    }
    const { tab, warning } = await FF.openInAgentWindow(url);
    FF.agentTabId = tab.id;
    // `?.` keeps this a no-op in harnesses without marker.js loaded.
    FF.markedTabs?.set(tab.id, null);
    return { ...(await landed(tab.id, url)), ...(warning ? { warning } : {}) };
  };
}

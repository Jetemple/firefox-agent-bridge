// open_tab — open a new tab WITHOUT stealing focus (active defaults false).
{
  const FF = (globalThis.FFBridge ??= {});
  FF.tools ??= {};

  FF.tools.open_tab = async (args) => {
    const url = FF.normalizeUrl(args.url);
    // Resolve the container before creating anything: an unknown name fails
    // instead of opening the page in the default container.
    const cookieStoreId = args.container != null ? await FF.resolveContainer(args.container) : undefined;
    const tab = await browser.tabs.create({
      url,
      active: args.active === true,
      ...(cookieStoreId ? { cookieStoreId } : {}),
    });
    // Mark this agent-opened tab so the strip shows the 🤖 stamp. The actual
    // document.title write is deferred to background.js's tabs.onUpdated handler
    // (injecting here races the still-loading / about:blank tab). `label` may be
    // undefined → emoji-only. `?.` keeps this a no-op in harnesses without
    // marker.js loaded.
    FF.markedTabs?.set(tab.id, args.label ?? null);
    // Report the tab that will stay valid (a container extension may reopen it
    // under a new id) and the URL it actually landed on.
    const landed = FF.isRestricted(url) ? null : await FF.settleTab?.(tab.id);
    if (landed && !FF.isRestricted(landed.url)) {
      return { tabId: landed.id, windowId: landed.windowId, url: landed.url, ...(await containerOf(landed)) };
    }
    return { tabId: FF.followTab?.(tab.id) ?? tab.id, windowId: tab.windowId, url, ...(await containerOf(tab)) };
  };

  // The container the tab really ended up in, read back from the tab itself: a
  // container extension's "always open in" rule can move it somewhere else.
  // Omitted for tabs outside any container.
  async function containerOf(tab) {
    if (!tab.cookieStoreId || tab.cookieStoreId === "firefox-default" || !FF.containerNames) return {};
    const name = (await FF.containerNames()).get(tab.cookieStoreId);
    return name ? { container: name } : {};
  }
}

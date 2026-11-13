// open_tab — open a new tab WITHOUT stealing focus (active defaults false).
// agentWindow: true opens it in the dedicated, unfocused agent window instead.
{
  const FF = (globalThis.FFBridge ??= {});
  FF.tools ??= {};

  FF.tools.open_tab = async (args) => {
    const url = FF.normalizeUrl(args.url);
    // Resolve the container before creating anything: an unknown name fails
    // instead of opening the page in the default container.
    const cookieStoreId = args.container != null ? await FF.resolveContainer(args.container) : undefined;
    // Same for the group: a bad name or color, or a Firefox without tab
    // groups, fails before a tab exists.
    const grouping = args.group != null ? { name: args.group, color: args.groupColor } : null;
    if (grouping) FF.checkGroupArgs(grouping);
    const placed = args.agentWindow === true ? await openInAgentWindow(url, cookieStoreId) : null;
    const tab =
      placed?.tab ??
      (await browser.tabs.create({
        url,
        active: args.active === true,
        ...(cookieStoreId ? { cookieStoreId } : {}),
      }));
    // Mark this agent-opened tab so the strip shows the 🤖 stamp. The actual
    // document.title write is deferred to background.js's tabs.onUpdated handler
    // (injecting here races the still-loading / about:blank tab). `label` may be
    // undefined → emoji-only. `?.` keeps this a no-op in harnesses without
    // marker.js loaded.
    FF.claimOpenedTab?.(tab.id);
    FF.markedTabs?.set(tab.id, args.label ?? null);
    // Report the tab that will stay valid (a container extension may reopen it
    // under a new id) and the URL it actually landed on.
    const landed = FF.isRestricted(url) ? null : await FF.settleTab?.(tab.id);
    const final = landed && !FF.isRestricted(landed.url) ? landed : null;
    const result = final
      ? { tabId: final.id, windowId: final.windowId, url: final.url, ...(await containerOf(final)) }
      : { tabId: FF.followTab?.(tab.id) ?? tab.id, windowId: tab.windowId, url, ...(await containerOf(tab)) };
    if (placed) {
      result.agentWindow = true;
      if (placed.warning) result.warning = placed.warning;
    }
    if (grouping) {
      try {
        const grouped = await FF.groupTabs([await browser.tabs.get(result.tabId)], grouping);
        result.group = grouped.group;
      } catch (err) {
        // Don't leave a tab behind that the caller never got an id for.
        FF.expectedCloses?.add(result.tabId);
        await browser.tabs.remove(result.tabId).catch(() => {});
        throw err;
      }
    }
    return result;
  };

  // --- agent window ---------------------------------------------------------
  //
  // A dedicated window for agent tabs, so a tab can be the front tab of ITS
  // window (some sites, e.g. X and YouTube, only render the front tab) without
  // touching the window the user works in. Created unfocused. The id is cached
  // in memory and the window is also tagged with a session value, which Firefox
  // keeps across extension reloads (and restarts that restore the session), so
  // a reload finds the window again instead of making one: creating a window
  // raises Firefox on macOS.
  FF.agentWindowId ??= null;

  // Covered by other apps the window keeps rendering; minimized it doesn't.
  FF.MINIMIZED_WARNING =
    "The agent window is minimized, so pages that only render in a visible window (X, YouTube) come back empty. Restore it and leave it behind other windows instead.";

  // The agent window if it still exists, else null (closed, or never made).
  const AGENT_WINDOW_KEY = "ffAgentWindow";

  async function findTaggedWindow() {
    if (!browser.sessions?.getWindowValue || !browser.windows?.getAll) return null;
    for (const win of await browser.windows.getAll().catch(() => [])) {
      const tagged = await browser.sessions.getWindowValue(win.id, AGENT_WINDOW_KEY).catch(() => undefined);
      if (tagged) return win.id;
    }
    return null;
  }

  FF.getAgentWindow = async function getAgentWindow() {
    FF.agentWindowId ??= await findTaggedWindow();
    if (FF.agentWindowId == null) return null;
    try {
      return await browser.windows.get(FF.agentWindowId);
    } catch {
      FF.agentWindowId = null;
      return null;
    }
  };

  // Resolves to { tab, warning? }: a new tab in the existing agent window, or
  // the first tab of a newly created one.
  async function openInAgentWindow(url, cookieStoreId) {
    const existing = await FF.getAgentWindow();
    if (existing) {
      // Front tab of the agent window (some pages render only when visible);
      // activating a tab never focuses its window, so the user isn't disturbed.
      const tab = await browser.tabs.create({
        url,
        active: true,
        windowId: existing.id,
        ...(cookieStoreId ? { cookieStoreId } : {}),
      });
      return existing.state === "minimized" ? { tab, warning: FF.MINIMIZED_WARNING } : { tab };
    }
    // Two agents opening at once must share one new window, not make two.
    if (creating) {
      await creating.catch(() => {});
      return openInAgentWindow(url, cookieStoreId);
    }
    creating = createAgentWindow(url, cookieStoreId);
    try {
      return await creating;
    } finally {
      creating = null;
    }
  }
  let creating = null;

  async function createAgentWindow(url, cookieStoreId) {
    const win = await browser.windows.create({
      url,
      focused: false,
      ...(cookieStoreId ? { cookieStoreId } : {}),
    });
    FF.agentWindowId = win.id;
    await browser.sessions?.setWindowValue?.(win.id, AGENT_WINDOW_KEY, true).catch(() => {});
    const tab = win.tabs?.[0] ?? (await browser.tabs.query({ windowId: win.id }))[0];
    // macOS raises Firefox for a new window despite focused:false. Never
    // "hand focus back": refocusing the user's Firefox window would raise it
    // over the app they are actually in. Say so; the window is made only once
    // (it is tagged and found again after reloads).
    if (win.focused) {
      return { tab, warning: "Firefox focused the new agent window; switch back to your app. This happens only when the agent window is first created." };
    }
    return { tab };
  }

  // `?.` so test sandboxes without a windows event hub still load.
  browser.windows?.onRemoved?.addListener((windowId) => {
    if (windowId === FF.agentWindowId) FF.agentWindowId = null;
  });

  // The container the tab really ended up in, read back from the tab itself: a
  // container extension's "always open in" rule can move it somewhere else.
  // Omitted for tabs outside any container.
  async function containerOf(tab) {
    if (!tab.cookieStoreId || tab.cookieStoreId === "firefox-default" || !FF.containerNames) return {};
    const name = (await FF.containerNames()).get(tab.cookieStoreId);
    return name ? { container: name } : {};
  }
}

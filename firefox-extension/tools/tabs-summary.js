// get_tabs_summary — list open tabs.
{
  const FF = (globalThis.FFBridge ??= {});
  FF.tools ??= {};

  FF.tools.get_tabs_summary = async () => {
    const tabs = await browser.tabs.query({});
    const containers = (await FF.containerNames?.()) ?? new Map();
    const groups = (await FF.groupNames?.()) ?? new Map();
    // Closed agent tabs each open tab stands in for (a container extension
    // closes a tab and reopens it under a new id), so the bridge can move a
    // session from the old id to the new one.
    const replaces = new Map();
    for (const oldId of FF.tabAliases?.keys() ?? []) {
      const now = FF.followTab(oldId);
      replaces.set(now, [...(replaces.get(now) ?? []), oldId]);
    }
    return {
      tabs: tabs.map((t) => ({
        id: t.id,
        url: t.url,
        // Strip the agent marker: the human sees "🤖 …" in the strip, but the
        // agent reads the real title back (marker.js is loaded before this).
        title: FF.stripMarker(t.title),
        active: t.active,
        pinned: t.pinned,
        windowId: t.windowId,
        // Only on tabs inside a container (Firefox's contextual identities).
        ...(containers.has(t.cookieStoreId) ? { container: containers.get(t.cookieStoreId) } : {}),
        // Only on tabs inside a native tab group (Firefox 139+).
        ...(groups.has(t.groupId) ? { group: groups.get(t.groupId) } : {}),
        // Only on agent tabs, to keep the common case's payload unchanged:
        // `agent` is the tab un-targeted commands drive, `opened` any tab the
        // agent opened (what close_agent_tabs would close).
        ...(t.id === FF.agentTabId ? { agent: true } : {}),
        ...(replaces.has(t.id) ? { replaces: replaces.get(t.id) } : {}),
        ...(FF.markedTabs?.has(t.id) || t.id === FF.agentTabId ? { opened: true } : {}),
      })),
    };
  };
}

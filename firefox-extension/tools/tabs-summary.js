// get_tabs_summary — list open tabs.
{
  const FF = (globalThis.FFBridge ??= {});
  FF.tools ??= {};

  FF.tools.get_tabs_summary = async () => {
    const tabs = await browser.tabs.query({});
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
        // Only on the agent tab, to keep the common case's payload unchanged.
        ...(t.id === FF.agentTabId ? { agent: true } : {}),
      })),
    };
  };
}

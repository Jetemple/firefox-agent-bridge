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
        title: t.title,
        active: t.active,
        pinned: t.pinned,
        windowId: t.windowId,
      })),
    };
  };
}

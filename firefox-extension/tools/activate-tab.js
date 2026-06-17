// activate_tab — bring a tab to the foreground and focus its window.
{
  const FF = (globalThis.FFBridge ??= {});
  FF.tools ??= {};

  FF.tools.activate_tab = async (args) => {
    const tab = await FF.resolveTab(args.tabId);
    await browser.tabs.update(tab.id, { active: true });
    if (tab.windowId != null) {
      await browser.windows.update(tab.windowId, { focused: true });
    }
    return { activated: true, tabId: tab.id, windowId: tab.windowId ?? null };
  };
}

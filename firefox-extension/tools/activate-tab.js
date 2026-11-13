// activate_tab — bring a tab to the foreground and focus its window.
// focusWindow: false fronts the tab inside its window but leaves the window
// (and the user's OS focus) alone.
{
  const FF = (globalThis.FFBridge ??= {});
  FF.tools ??= {};

  const MINIMIZED =
    "The tab's window is minimized, so pages that only render in a visible window (X, YouTube) come back empty. Restore it and leave it behind other windows instead.";

  FF.tools.activate_tab = async (args) => {
    const tab = await FF.resolveTab(args.tabId);
    await browser.tabs.update(tab.id, { active: true });
    const focusWindow = args.focusWindow !== false && tab.windowId != null;
    if (focusWindow) {
      await browser.windows.update(tab.windowId, { focused: true });
    }
    const result = { activated: true, tabId: tab.id, windowId: tab.windowId ?? null, windowFocused: focusWindow };
    // Fronting a tab in a minimized window still leaves it unrendered.
    if (!focusWindow && tab.windowId != null && browser.windows.get) {
      const win = await browser.windows.get(tab.windowId).catch(() => null);
      if (win?.state === "minimized") result.warning = MINIMIZED;
    }
    return result;
  };
}

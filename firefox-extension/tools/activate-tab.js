// activate_tab — make a tab the front tab of its window, and raise the window.
// Both take the user's focus, so both need the user's setting (focus-gate.js).
// The one thing allowed without it: fronting an agent tab inside the agent
// window while another agent tab is in front there, which the user never sees.
{
  const FF = (globalThis.FFBridge ??= {});
  FF.tools ??= {};

  const MINIMIZED =
    "The tab's window is minimized, so pages that only render in a visible window (X, YouTube) come back empty. Restore it and leave it behind other windows instead.";

  const FOCUS_OFF =
    "Window focus is off, so the tab was fronted inside its window only. The user turns it on in the extension panel.";
  const SWITCH_OFF =
    "Not switched: taking focus is off, and this would change the tab the user is viewing. The user turns it on in the extension panel.";

  // An agent tab in the agent window, with another agent tab in front of it.
  async function hiddenFromUser(tab) {
    if (tab.windowId == null || (await FF.knownAgentWindowId?.()) !== tab.windowId) return false;
    return (await FF.isAgentWindowTab(tab.id)) && (await FF.agentOwnsFront(tab.windowId));
  }

  FF.tools.activate_tab = async (args) => {
    const tab = await FF.resolveTab(args.tabId);
    const allowed = await FF.windowFocusAllowed();
    if (!allowed && !(await hiddenFromUser(tab))) {
      return { activated: false, tabId: tab.id, windowId: tab.windowId ?? null, windowFocused: false, note: SWITCH_OFF };
    }
    await browser.tabs.update(tab.id, { active: true });
    const wanted = args.focusWindow !== false && tab.windowId != null;
    const focusWindow = wanted && allowed;
    if (focusWindow) {
      await browser.windows.update(tab.windowId, { focused: true });
    }
    const result = { activated: true, tabId: tab.id, windowId: tab.windowId ?? null, windowFocused: focusWindow };
    if (wanted && !focusWindow) result.note = FOCUS_OFF;
    // Fronting a tab in a minimized window still leaves it unrendered.
    if (!focusWindow && tab.windowId != null && browser.windows.get) {
      const win = await browser.windows.get(tab.windowId).catch(() => null);
      if (win?.state === "minimized") result.warning = MINIMIZED;
    }
    return result;
  };
}

// open_tab — open a new tab in the agent window, never in front of the user.
// active: true opens it in front in the user's window, if the user allowed that.
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
    // Opening in front switches the tab the user is viewing: same user-only
    // setting as raising the window (focus-gate.js). Off unless they set it.
    const wantsFront = args.active === true && args.agentWindow !== true;
    const front = wantsFront && (await FF.windowFocusAllowed());
    // Agent tabs live in the agent window, so the user's window is left alone.
    // Only a tab the user let open in front goes in their window.
    const placed = front ? null : await openInAgentWindow(url, cookieStoreId);
    const tab =
      placed?.tab ??
      (await browser.tabs.create({
        url,
        active: front,
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
    if (wantsFront && !front) {
      result.note = "Opened in the background: taking focus is off. The user turns it on in the extension panel.";
    }
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

  // Tabs this code placed in the agent window. Only these are ever fronted
  // automatically: the window id alone is not proof, because the user can end
  // up working in the agent window. Mirrored into a session tab value so it
  // survives extension reloads, like the window tag.
  const AGENT_TAB_KEY = "ffAgentWindowTab";
  FF.agentWindowTabs ??= new Set();

  FF.markAgentWindowTab = async function markAgentWindowTab(tabId) {
    FF.agentWindowTabs.add(tabId);
    await browser.sessions?.setTabValue?.(tabId, AGENT_TAB_KEY, true).catch(() => {});
  };

  FF.isAgentWindowTab = async function isAgentWindowTab(tabId) {
    if (FF.agentWindowTabs.has(tabId)) return true;
    const tagged = await browser.sessions?.getTabValue?.(tabId, AGENT_TAB_KEY).catch(() => undefined);
    if (tagged) FF.agentWindowTabs.add(tabId);
    return !!tagged;
  };

  // Whether the user moved focus into the agent window themselves. A window
  // that has just been created is focused too (Firefox focuses it despite
  // focused:false), and nobody chose that, so focus arriving within the grace
  // period after creation doesn't count.
  const CREATION_FOCUS_GRACE_MS = 3000;
  FF.userInAgentWindow = false;
  FF.agentWindowCreatedAt = 0;
  FF.onWindowFocusChanged = function onWindowFocusChanged(windowId, now = Date.now()) {
    FF.userInAgentWindow =
      windowId === FF.agentWindowId && now - FF.agentWindowCreatedAt > CREATION_FOCUS_GRACE_MS;
  };
  browser.windows?.onFocusChanged?.addListener((windowId) => FF.onWindowFocusChanged(windowId));

  // True only when the window's front tab is one the agent window placed and
  // the user hasn't clicked into the window. Anything else (a user tab, an
  // unknown tab, no answer) means the user may be looking at that window, so
  // nothing there gets switched.
  FF.agentOwnsFront = async function agentOwnsFront(windowId) {
    const win = await (browser.windows?.get?.(windowId) ?? Promise.resolve(null)).catch(() => null);
    if (win?.focused && FF.userInAgentWindow) return false;
    const [front] = await (browser.tabs.query?.({ active: true, windowId }) ?? Promise.resolve([])).catch(() => []);
    return front ? FF.isAgentWindowTab(front.id) : false;
  };

  // A tagged window that is the only normal window AND holds a tab the agent
  // didn't put there is the user's now (they closed their own and kept working
  // in it): untag it. With only agent tabs in it, it is still the agent window:
  // the user simply has no window open, or only ones we can't see (private).
  async function isUsersOnlyWindow(windowId) {
    if (!browser.windows?.getAll) return false;
    const normal = await browser.windows.getAll({ windowTypes: ["normal"] }).catch(() => null);
    if (normal == null || normal.length !== 1 || normal[0].id !== windowId) return false;
    const tabs = await (browser.tabs.query?.({ windowId }) ?? Promise.resolve([])).catch(() => []);
    for (const t of tabs) if (!(await FF.isAgentWindowTab(t.id))) return true;
    return false;
  }

  async function disownAgentWindow(windowId) {
    await browser.sessions?.removeWindowValue?.(windowId, AGENT_WINDOW_KEY).catch(() => {});
    if (FF.agentWindowId === windowId) FF.agentWindowId = null;
  }

  async function findTaggedWindow() {
    if (!browser.sessions?.getWindowValue || !browser.windows?.getAll) return null;
    for (const win of await browser.windows.getAll().catch(() => [])) {
      const tagged = await browser.sessions.getWindowValue(win.id, AGENT_WINDOW_KEY).catch(() => undefined);
      if (tagged) return win.id;
    }
    return null;
  }

  FF.getAgentWindow = async function getAgentWindow() {
    if (FF.agentWindowId == null) {
      const found = await findTaggedWindow();
      FF.agentWindowId ??= found; // a window made meanwhile wins
    }
    if (FF.agentWindowId == null) return null;
    let win;
    try {
      win = await browser.windows.get(FF.agentWindowId);
    } catch {
      FF.agentWindowId = null;
      return null;
    }
    if (await isUsersOnlyWindow(win.id)) {
      await disownAgentWindow(win.id);
      return null;
    }
    return win;
  };

  // The agent window's id, looking for a tagged window once after an
  // extension reload (the in-memory id is gone then, the window is not).
  let looked = false;
  FF.knownAgentWindowId = async function knownAgentWindowId() {
    if (FF.agentWindowId == null && !looked) {
      looked = true;
      await FF.getAgentWindow().catch(() => null);
    }
    return FF.agentWindowId;
  };

  // One at a time: two agents opening at once (or an open racing the startup
  // creation) must share one window, not find none each and make two.
  let queue = Promise.resolve();
  function oneAtATime(fn) {
    const run = queue.then(fn, fn);
    queue = run.catch(() => {});
    return run;
  }

  // Resolves to { tab, warning? }: a new tab in the existing agent window, or
  // the first tab of a newly created one.
  function openInAgentWindow(url, cookieStoreId) {
    return oneAtATime(() => openInAgentWindowNow(url, cookieStoreId));
  }

  async function openInAgentWindowNow(url, cookieStoreId) {
    const existing = await FF.getAgentWindow();
    if (existing) {
      // Front tab of the agent window (some pages render only when visible);
      // activating a tab never focuses its window, so the user isn't disturbed.
      // Unless a tab the agent doesn't own is in front: then the user may be
      // looking at this window, so open behind it.
      const tab = await browser.tabs.create({
        url,
        active: await FF.agentOwnsFront(existing.id),
        windowId: existing.id,
        ...(cookieStoreId ? { cookieStoreId } : {}),
      });
      await FF.markAgentWindowTab(tab.id);
      return existing.state === "minimized" ? { tab, warning: FF.MINIMIZED_WARNING } : { tab };
    }
    return createAgentWindow(url, cookieStoreId);
  }
  FF.openInAgentWindow = openInAgentWindow; // navigate.js opens its tabs here too

  // Make the agent window if there is none. Called when Firefox starts and
  // when the extension is first installed: Firefox is in front then anyway, so
  // the raise a new window causes on macOS doesn't land later, over whatever
  // app the user is in.
  FF.ensureAgentWindow = function ensureAgentWindow() {
    return oneAtATime(async () => {
      if (!(await FF.getAgentWindow())) await createAgentWindow("about:blank");
    });
  };

  async function createAgentWindow(url, cookieStoreId) {
    const win = await browser.windows.create({
      url,
      focused: false,
      ...(cookieStoreId ? { cookieStoreId } : {}),
    });
    FF.agentWindowId = win.id;
    FF.agentWindowCreatedAt = Date.now();
    FF.userInAgentWindow = false;
    await browser.sessions?.setWindowValue?.(win.id, AGENT_WINDOW_KEY, true).catch(() => {});
    const tab = win.tabs?.[0] ?? (await browser.tabs.query({ windowId: win.id }))[0];
    if (tab) await FF.markAgentWindowTab(tab.id);
    // macOS raises Firefox for a new window despite focused:false. Never
    // "hand focus back": refocusing the user's Firefox window would raise it
    // over the app they are actually in. Say so; the window is tagged and found
    // again after reloads, so this only repeats if it gets closed.
    if (win.focused) {
      return { tab, warning: "Firefox focused the new agent window; switch back to your app. This happens only when the agent window is created: at Firefox startup, or again if it was closed." };
    }
    return { tab };
  }

  // `?.` so test sandboxes without a windows event hub still load.
  browser.windows?.onRemoved?.addListener((windowId) => {
    if (windowId === FF.agentWindowId) FF.agentWindowId = null;
  });

  // A second tagged window showing up means session restore brought the old
  // agent window back after startup had already made a new one. Keep one: if
  // ours is still just blank tabs, close it and use the restored window;
  // otherwise the restored one becomes an ordinary window.
  const RESTORE_TAG_WAIT_MS = 500; // a restored window's tag isn't there at once
  FF.onWindowCreated = async function onWindowCreated(win) {
    await FF.sleep?.(RESTORE_TAG_WAIT_MS);
    const ours = FF.agentWindowId;
    if (ours == null || win.id === ours) return;
    const tagged = await browser.sessions?.getWindowValue?.(win.id, AGENT_WINDOW_KEY).catch(() => undefined);
    if (!tagged) return;
    const tabs = await browser.tabs.query({ windowId: ours }).catch(() => null);
    if (tabs?.every((t) => t.url === "about:blank")) {
      FF.agentWindowId = win.id;
      await browser.windows.remove(ours).catch(() => {});
    } else {
      await browser.sessions.removeWindowValue?.(win.id, AGENT_WINDOW_KEY).catch(() => {});
    }
  };
  browser.windows?.onCreated?.addListener((win) => FF.onWindowCreated(win).catch(() => {}));

  // The container the tab really ended up in, read back from the tab itself: a
  // container extension's "always open in" rule can move it somewhere else.
  // Omitted for tabs outside any container.
  async function containerOf(tab) {
    if (!tab.cookieStoreId || tab.cookieStoreId === "firefox-default" || !FF.containerNames) return {};
    const name = (await FF.containerNames()).get(tab.cookieStoreId);
    return name ? { container: name } : {};
  }
}

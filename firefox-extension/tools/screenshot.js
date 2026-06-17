// screenshot — capture a tab's visible viewport.
//
// captureVisibleTab only captures the active visible tab of a window, so when a
// specific tabId is requested we activate + focus it first. Dimensions come
// from the device-pixel viewport (matches the PNG size); new Image() is not
// available in the MV3 background.
{
  const FF = (globalThis.FFBridge ??= {});
  FF.tools ??= {};
  FF.injected ??= {};

  function viewportSize() {
    return {
      w: Math.round(window.innerWidth * window.devicePixelRatio),
      h: Math.round(window.innerHeight * window.devicePixelRatio),
    };
  }
  FF.injected.viewportSize = viewportSize;

  // Resolves after two animation frames — i.e. once the activated tab has
  // actually painted — so captureVisibleTab does not grab a stale frame.
  function awaitPaint() {
    return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  }

  FF.tools.screenshot = async (args, tab) => {
    const format = args.format === "jpeg" ? "jpeg" : "png";
    const options = { format };
    if (format === "jpeg" && typeof args.quality === "number") {
      options.quality = args.quality;
    }

    // Only activate when the target isn't already the visible tab (avoids
    // needless focus-stealing). captureVisibleTab only captures the active tab.
    if (args.tabId != null && tab.active !== true) {
      await browser.tabs.update(tab.id, { active: true });
      if (tab.windowId != null) {
        await browser.windows.update(tab.windowId, { focused: true });
      }
      // Wait for the newly-activated tab to paint before capturing.
      try {
        await FF.inject(tab.id, awaitPaint, []);
      } catch {
        /* best-effort; proceed to capture */
      }
    }

    let dataUrl;
    try {
      dataUrl =
        tab.windowId != null
          ? await browser.tabs.captureVisibleTab(tab.windowId, options)
          : await browser.tabs.captureVisibleTab(options);
    } catch (e) {
      throw FF.bridgeError("CAPTURE_FAILED", `captureVisibleTab failed: ${e?.message ?? e}`);
    }

    let width = null;
    let height = null;
    try {
      const size = await FF.inject(tab.id, viewportSize, []);
      if (size) {
        width = size.w;
        height = size.h;
      }
    } catch {
      // dimensions are best-effort (e.g. restricted page); the image still returns.
    }

    return { dataUrl, format, width, height };
  };
}

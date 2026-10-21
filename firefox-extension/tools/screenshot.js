// screenshot — capture a tab's visible viewport.
//
// tabs.captureTab (Firefox-only) renders any tab, visible or not, so a
// screenshot never switches the user's tab or raises the window. Dimensions
// come from the in-page device-pixel viewport (matches the PNG size).
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

  FF.tools.screenshot = async (args, tab) => {
    const format = args.format === "jpeg" ? "jpeg" : "png";
    const options = { format };
    if (format === "jpeg" && typeof args.quality === "number") {
      options.quality = args.quality;
    }

    let dataUrl;
    try {
      dataUrl = await browser.tabs.captureTab(tab.id, options);
    } catch (e) {
      throw FF.bridgeError("CAPTURE_FAILED", `captureTab failed: ${e?.message ?? e}`);
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

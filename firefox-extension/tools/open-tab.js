// open_tab — open a new tab WITHOUT stealing focus (active defaults false).
{
  const FF = (globalThis.FFBridge ??= {});
  FF.tools ??= {};

  FF.tools.open_tab = async (args) => {
    const url = FF.normalizeUrl(args.url);
    const tab = await browser.tabs.create({ url, active: args.active === true });
    // Mark this agent-opened tab so the strip shows the 🤖 stamp. The actual
    // document.title write is deferred to background.js's tabs.onUpdated handler
    // (injecting here races the still-loading / about:blank tab). `label` may be
    // undefined → emoji-only. `?.` keeps this a no-op in harnesses without
    // marker.js loaded.
    FF.markedTabs?.set(tab.id, args.label ?? null);
    return { tabId: tab.id, windowId: tab.windowId, url };
  };
}

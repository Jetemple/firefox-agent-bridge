// get_page_text — extract visible page text, truncated in-page so the oversized
// payload never crosses the WebSocket. `length` is the original (pre-truncation)
// character count.
{
  const FF = (globalThis.FFBridge ??= {});
  FF.tools ??= {};
  FF.injected ??= {};

  function extractPageText(maxLength) {
    const full = document.body?.innerText ?? document.documentElement?.innerText ?? "";
    const truncated = maxLength != null && full.length > maxLength;
    return {
      text: truncated ? full.slice(0, maxLength) : full,
      truncated,
      length: full.length,
    };
  }

  FF.injected.extractPageText = extractPageText;

  FF.tools.get_page_text = async (args, tab) => {
    return FF.inject(tab.id, extractPageText, [args.maxLength ?? null]);
  };
}

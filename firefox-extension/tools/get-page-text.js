// get_page_text — extract visible page text, truncated in-page so the oversized
// payload never crosses the WebSocket. `length` is the original (pre-truncation)
// character count. Shadow root text follows the document's, then each child
// frame's under a `[frame: url]` header.
{
  const FF = (globalThis.FFBridge ??= {});
  FF.tools ??= {};
  FF.injected ??= {};

  function extractPageText(maxLength, inFrame) {
    // A frame with no viewport (tracker, closed widget) has nothing to read.
    if (inFrame && !(window.innerWidth > 0 && window.innerHeight > 0)) return null;
    const parts = [document.body?.innerText ?? document.documentElement?.innerText ?? ""];
    // innerText skips shadow content, and a shadow root has no innerText of its
    // own. checkVisibility drops its <style> and anything display:none, whose
    // innerText would be raw source.
    (function collectShadowText(root) {
      for (const el of root.querySelectorAll("*")) {
        const shadow = el.openOrClosedShadowRoot ?? el.shadowRoot;
        if (!shadow) continue;
        for (const node of shadow.childNodes) {
          if (node.nodeType === 3) parts.push(node.textContent);
          else if (node.checkVisibility?.()) parts.push(node.innerText);
        }
        collectShadowText(shadow);
      }
    })(document);
    const full = parts.filter((p) => p && p.trim()).join("\n");
    const truncated = maxLength != null && full.length > maxLength;
    return {
      text: truncated ? full.slice(0, maxLength) : full,
      truncated,
      length: full.length,
      ...(inFrame ? { url: location.href.split(/[?#]/)[0] } : {}),
    };
  }

  FF.injected.extractPageText = extractPageText;

  FF.tools.get_page_text = async (args, tab) => {
    const max = args.maxLength ?? null;
    // Some sites render nothing in a tab that isn't the front tab of its
    // window; say so, so a near-empty read can be explained.
    const bg = tab.active === false ? { background: true } : {};
    const top = { ...(await FF.inject(tab.id, extractPageText, [max])), ...bg };
    const frames = await FF.injectChildFrames(tab.id, extractPageText, [max, true]);
    const texts = frames.map((f) => f.result).filter((r) => r.text.trim());
    if (!texts.length) return top;
    const header = (r) => `\n\n[frame: ${r.url}]\n`;
    const text = texts.reduce((all, r) => all + header(r) + r.text, top.text);
    const length = texts.reduce((n, r) => n + header(r).length + r.length, top.length);
    return { text: max != null ? text.slice(0, max) : text, truncated: max != null && length > max, length, ...bg };
  };
}

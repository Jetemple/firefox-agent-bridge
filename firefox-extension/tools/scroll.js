// scroll — scroll the window by a pixel delta, or bring an element into view.
{
  const FF = (globalThis.FFBridge ??= {});
  FF.tools ??= {};
  FF.injected ??= {};

  function performScroll(dx, dy, selector) {
    if (selector) {
      const el = document.querySelector(selector);
      if (!el) return { scrolled: false, reason: "no element matches " + selector };
      el.scrollIntoView({ block: "center", inline: "nearest" });
      return { scrolled: true, into: selector, x: window.scrollX, y: window.scrollY };
    }
    window.scrollBy(dx || 0, dy || 0);
    return { scrolled: true, x: window.scrollX, y: window.scrollY };
  }

  FF.injected.performScroll = performScroll;

  FF.tools.scroll = async (args, tab) =>
    FF.inject(tab.id, performScroll, [args.dx ?? 0, args.dy ?? 0, args.selector ?? null]);
}

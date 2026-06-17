// find_element — locate the first visible element matching a CSS selector and/or
// visible text, returning its center coordinates so a follow-up click/hover can
// target it. Searches common interactive elements when only text is given.
{
  const FF = (globalThis.FFBridge ??= {});
  FF.tools ??= {};
  FF.injected ??= {};

  function findElement(text, selector) {
    function describe(el) {
      const id = el.id ? "#" + el.id : "";
      const cls = el.classList && el.classList.length ? "." + Array.from(el.classList).join(".") : "";
      return el.tagName.toLowerCase() + id + cls;
    }
    function centerOf(el) {
      const r = el.getBoundingClientRect();
      return {
        x: Math.round(r.left + r.width / 2),
        y: Math.round(r.top + r.height / 2),
        rect: { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) },
      };
    }
    const base = selector
      ? Array.from(document.querySelectorAll(selector))
      : Array.from(
          document.querySelectorAll(
            "a, button, input, textarea, select, [role='button'], [role='link'], [onclick], label, summary",
          ),
        );
    const needle = text != null ? String(text).toLowerCase() : null;
    const matches = base.filter((el) => {
      if (!needle) return true;
      const aria = el.getAttribute ? el.getAttribute("aria-label") : null;
      const t = (el.innerText || el.textContent || el.value || aria || "").toLowerCase();
      return t.includes(needle);
    });
    const visible = matches.filter((el) => {
      const r = el.getBoundingClientRect();
      return r && r.width > 0 && r.height > 0;
    });
    const pick = visible[0] || matches[0] || null;
    if (!pick) return { found: false, count: 0, text: text ?? null, selector: selector ?? null };
    const c = centerOf(pick);
    return {
      found: true,
      count: matches.length,
      element: describe(pick),
      text: (pick.innerText || pick.textContent || pick.value || "").trim().slice(0, 120),
      x: c.x,
      y: c.y,
      rect: c.rect,
    };
  }

  FF.injected.findElement = findElement;

  FF.tools.find_element = async (args, tab) =>
    FF.inject(tab.id, findElement, [args.text ?? null, args.selector ?? null]);
}

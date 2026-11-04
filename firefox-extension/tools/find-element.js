// find_element — locate the first visible element matching a CSS selector and/or
// visible text, returning its center coordinates so a follow-up click/hover can
// target it. Searches common interactive elements when only text is given, in
// the top frame's document and shadow roots, then in child frames. x/y are
// relative to the frame named by `frameId` (omitted for the top frame). `ref` is
// a tag on the element, kept in the extension's world where the page can't see
// it, that lets a follow-up click tell whether it reached this element.
{
  const FF = (globalThis.FFBridge ??= {});
  FF.tools ??= {};
  FF.injected ??= {};

  function findElement(text, selector, ref, inFrame) {
    // A frame with no viewport (tracker, closed widget) has nothing to act on.
    if (inFrame && !(window.innerWidth > 0 && window.innerHeight > 0)) return null;
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
    function deepQuery(root, css) {
      const out = Array.from(root.querySelectorAll(css));
      for (const el of root.querySelectorAll("*")) {
        const shadow = el.openOrClosedShadowRoot ?? el.shadowRoot;
        if (shadow) out.push(...deepQuery(shadow, css));
      }
      return out;
    }
    const base = deepQuery(
      document,
      selector || "a, button, input, textarea, select, [role='button'], [role='link'], [onclick], label, summary",
    );
    const needle = text != null ? String(text).toLowerCase() : null;
    const matches = base.filter((el) => {
      if (!needle) return true;
      const aria = el.getAttribute ? el.getAttribute("aria-label") : null;
      const placeholder = el.getAttribute ? el.getAttribute("placeholder") : null;
      // Separate checks: a filled field's value must not hide its own label.
      const fields = [el.innerText || el.textContent || el.value, aria, placeholder];
      return fields.some((t) => t && t.toLowerCase().includes(needle));
    });
    const visible = matches.filter((el) => {
      const r = el.getBoundingClientRect();
      return r && r.width > 0 && r.height > 0;
    });
    // Only visible elements count: a hidden match's coordinates would send a
    // follow-up click somewhere else entirely. Echoed queries are capped so an
    // oversized probe can't bloat the reply.
    const pick = visible[0] || null;
    if (!pick) {
      return {
        found: false,
        count: matches.length,
        hidden: matches.length,
        text: text != null ? String(text).slice(0, 120) : null,
        selector: selector != null ? String(selector).slice(0, 120) : null,
      };
    }
    const c = centerOf(pick);
    if (ref) pick.__ffRef = ref;
    return {
      found: true,
      ...(ref ? { ref } : {}),
      count: matches.length,
      element: describe(pick),
      text: (pick.innerText || pick.textContent || pick.value || "").trim().slice(0, 120),
      x: c.x,
      y: c.y,
      rect: c.rect,
    };
  }

  FF.injected.findElement = findElement;

  FF.tools.find_element = async (args, tab) => {
    // With neither, the search matches every interactive element and returns
    // an arbitrary one as found.
    if (!args.text && !args.selector) {
      throw FF.bridgeError("INVALID_ARGS", "find_element needs text, selector, or both");
    }
    const call = [args.text ?? null, args.selector ?? null, Math.random().toString(36).slice(2)];
    const top = await FF.inject(tab.id, findElement, call);
    if (top.found) return top;
    const frames = await FF.injectChildFrames(tab.id, findElement, [...call, true]);
    const hit = frames.find((f) => f.result.found);
    if (hit) return { ...hit.result, frameId: hit.frameId };
    const sum = (key) => frames.reduce((n, f) => n + f.result[key], top[key]);
    return { ...top, count: sum("count"), hidden: sum("hidden") };
  };
}

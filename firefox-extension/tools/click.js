// click — dispatch a synthetic click at viewport coordinates (x, y).
{
  const FF = (globalThis.FFBridge ??= {});
  FF.tools ??= {};
  FF.injected ??= {};

  function performClick(x, y) {
    // SVG/MathML-safe element descriptor (el.className is not a string there).
    function describe(el) {
      const id = el.id ? "#" + el.id : "";
      const cls = el.classList && el.classList.length ? "." + Array.from(el.classList).join(".") : "";
      return el.tagName.toLowerCase() + id + cls;
    }

    const el = document.elementFromPoint(x, y);
    if (!el) return { clicked: false, reason: "no element at coordinates", x, y };

    // Build the descriptor BEFORE dispatching, so a descriptor failure can never
    // misreport an already-dispatched click.
    const element = describe(el);

    const rect = el.getBoundingClientRect();
    const opts = {
      bubbles: true,
      cancelable: true,
      view: window,
      clientX: rect.left + rect.width / 2,
      clientY: rect.top + rect.height / 2,
    };
    el.dispatchEvent(new PointerEvent("pointerdown", opts));
    el.dispatchEvent(new MouseEvent("mousedown", opts));
    el.dispatchEvent(new PointerEvent("pointerup", opts));
    el.dispatchEvent(new MouseEvent("mouseup", opts));
    el.dispatchEvent(new MouseEvent("click", opts));

    // Focus a focusable target so a following `type` has a deterministic element.
    const focusable =
      el.isContentEditable ||
      (el.matches && el.matches("input, textarea, select, [contenteditable], [tabindex]"));
    if (focusable && typeof el.focus === "function") {
      try {
        el.focus();
      } catch {
        /* ignore */
      }
    }

    return { clicked: true, element, x, y };
  }

  FF.injected.performClick = performClick;

  FF.tools.click = async (args, tab) => {
    return FF.inject(tab.id, performClick, [args.x, args.y]);
  };
}

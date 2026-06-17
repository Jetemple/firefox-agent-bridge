// hover — dispatch pointer/mouse over + move at viewport coordinates.
{
  const FF = (globalThis.FFBridge ??= {});
  FF.tools ??= {};
  FF.injected ??= {};

  function performHover(x, y) {
    function describe(el) {
      const id = el.id ? "#" + el.id : "";
      const cls = el.classList && el.classList.length ? "." + Array.from(el.classList).join(".") : "";
      return el.tagName.toLowerCase() + id + cls;
    }
    const el = document.elementFromPoint(x, y);
    if (!el) return { hovered: false, reason: "no element at coordinates", x, y };
    const element = describe(el);
    const opts = { bubbles: true, cancelable: true, clientX: x, clientY: y };
    el.dispatchEvent(new PointerEvent("pointerover", opts));
    el.dispatchEvent(new MouseEvent("mouseover", opts));
    el.dispatchEvent(new PointerEvent("pointermove", opts));
    el.dispatchEvent(new MouseEvent("mousemove", opts));
    return { hovered: true, element, x, y };
  }

  FF.injected.performHover = performHover;

  FF.tools.hover = async (args, tab) => FF.inject(tab.id, performHover, [args.x, args.y]);
}

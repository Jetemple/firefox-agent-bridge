// right_click — dispatch a context-menu (button 2) sequence at coordinates.
{
  const FF = (globalThis.FFBridge ??= {});
  FF.tools ??= {};
  FF.injected ??= {};

  function performRightClick(x, y) {
    function describe(el) {
      const id = el.id ? "#" + el.id : "";
      const cls = el.classList && el.classList.length ? "." + Array.from(el.classList).join(".") : "";
      return el.tagName.toLowerCase() + id + cls;
    }
    const el = document.elementFromPoint(x, y);
    if (!el) return { rightClicked: false, reason: "no element at coordinates", x, y };
    const element = describe(el);
    const opts = { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 2, buttons: 2 };
    el.dispatchEvent(new PointerEvent("pointerdown", opts));
    el.dispatchEvent(new MouseEvent("mousedown", opts));
    el.dispatchEvent(new MouseEvent("contextmenu", opts));
    el.dispatchEvent(new PointerEvent("pointerup", opts));
    el.dispatchEvent(new MouseEvent("mouseup", opts));
    return { rightClicked: true, element, x, y };
  }

  FF.injected.performRightClick = performRightClick;

  FF.tools.right_click = async (args, tab) => FF.inject(tab.id, performRightClick, [args.x, args.y]);
}

// double_click — two full click sequences plus a dblclick at coordinates.
{
  const FF = (globalThis.FFBridge ??= {});
  FF.tools ??= {};
  FF.injected ??= {};

  function performDoubleClick(x, y) {
    function describe(el) {
      const id = el.id ? "#" + el.id : "";
      const cls = el.classList && el.classList.length ? "." + Array.from(el.classList).join(".") : "";
      return el.tagName.toLowerCase() + id + cls;
    }
    const el = document.elementFromPoint(x, y);
    if (!el) return { doubleClicked: false, reason: "no element at coordinates", x, y };
    const element = describe(el);
    const opts = { bubbles: true, cancelable: true, clientX: x, clientY: y };
    for (let i = 0; i < 2; i++) {
      el.dispatchEvent(new PointerEvent("pointerdown", opts));
      el.dispatchEvent(new MouseEvent("mousedown", opts));
      el.dispatchEvent(new PointerEvent("pointerup", opts));
      el.dispatchEvent(new MouseEvent("mouseup", opts));
      el.dispatchEvent(new MouseEvent("click", opts));
    }
    el.dispatchEvent(new MouseEvent("dblclick", opts));
    return { doubleClicked: true, element, x, y };
  }

  FF.injected.performDoubleClick = performDoubleClick;

  FF.tools.double_click = async (args, tab) => FF.inject(tab.id, performDoubleClick, [args.x, args.y]);
}

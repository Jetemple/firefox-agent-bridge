// drag — press at the source point, move, and release at the destination point.
{
  const FF = (globalThis.FFBridge ??= {});
  FF.tools ??= {};
  FF.injected ??= {};

  function performDrag(fromX, fromY, toX, toY) {
    function describe(el) {
      if (!el) return null;
      const id = el.id ? "#" + el.id : "";
      const cls = el.classList && el.classList.length ? "." + Array.from(el.classList).join(".") : "";
      return el.tagName.toLowerCase() + id + cls;
    }
    const from = document.elementFromPoint(fromX, fromY);
    if (!from) return { dragged: false, reason: "no element at source", fromX, fromY };
    const down = { bubbles: true, cancelable: true, clientX: fromX, clientY: fromY };
    const move = { bubbles: true, cancelable: true, clientX: toX, clientY: toY };
    from.dispatchEvent(new PointerEvent("pointerdown", down));
    from.dispatchEvent(new MouseEvent("mousedown", down));
    from.dispatchEvent(new PointerEvent("pointermove", move));
    from.dispatchEvent(new MouseEvent("mousemove", move));
    const to = document.elementFromPoint(toX, toY) || from;
    to.dispatchEvent(new PointerEvent("pointerup", move));
    to.dispatchEvent(new MouseEvent("mouseup", move));
    return { dragged: true, from: describe(from), to: describe(to), fromX, fromY, toX, toY };
  }

  FF.injected.performDrag = performDrag;

  FF.tools.drag = async (args, tab) =>
    FF.inject(tab.id, performDrag, [args.fromX, args.fromY, args.toX, args.toY]);
}

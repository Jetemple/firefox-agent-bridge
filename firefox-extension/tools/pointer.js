// click, hover, double_click, right_click — dispatch a synthetic pointer
// sequence at viewport coordinates, relative to the frame given by args.frameId
// (top frame by default). One injected function, because each action needs the
// same hit test: through shadow roots, into iframes, and against find_element's
// target when the caller passes its ref.
{
  const FF = (globalThis.FFBridge ??= {});
  FF.tools ??= {};
  FF.injected ??= {};

  function performPointer(action, x, y, ref) {
    const P = PointerEvent;
    const M = MouseEvent;
    const CLICK = [["pointerdown", P], ["mousedown", M], ["pointerup", P], ["mouseup", M], ["click", M]];
    const ACTIONS = {
      click: { done: "clicked", events: CLICK, focus: true },
      hover: {
        done: "hovered",
        events: [["pointerover", P], ["mouseover", M], ["pointermove", P], ["mousemove", M]],
      },
      double_click: { done: "doubleClicked", events: [...CLICK, ...CLICK, ["dblclick", M]] },
      right_click: {
        done: "rightClicked",
        events: [["pointerdown", P], ["mousedown", M], ["contextmenu", M], ["pointerup", P], ["mouseup", M]],
        init: { button: 2, buttons: 2 },
      },
    };
    const spec = ACTIONS[action];

    // SVG/MathML-safe element descriptor (el.className is not a string there).
    function describe(el) {
      const id = el.id ? "#" + el.id : "";
      const cls = el.classList && el.classList.length ? "." + Array.from(el.classList).join(".") : "";
      return el.tagName.toLowerCase() + id + cls;
    }

    // elementFromPoint stops at the outermost shadow host.
    let el = document.elementFromPoint(x, y);
    for (let root; el && (root = el.openOrClosedShadowRoot ?? el.shadowRoot); ) {
      const inner = root.elementFromPoint(x, y);
      if (!inner || inner === el) break;
      el = inner;
    }
    if (!el) return { [spec.done]: false, reason: "no element at coordinates", x, y };

    if (ref) {
      // The target counts as hit when the point lands on it, inside it, or on a
      // <label> for it. Anything else would get events meant for the target.
      let node = el;
      while (node && node.__ffRef !== ref && node.control?.__ffRef !== ref) node = node.parentNode ?? node.host;
      if (!node) return { [spec.done]: false, reason: "target covered", hit: describe(el), x, y };
    } else if (el.tagName === "IFRAME" || el.tagName === "FRAME") {
      const r = el.getBoundingClientRect();
      const args = [action, x - r.left - el.clientLeft, y - r.top - el.clientTop, null];
      return { descend: { frameId: browser.runtime.getFrameId(el), args } };
    }

    // Build the descriptor BEFORE dispatching, so a descriptor failure can never
    // misreport an already-dispatched click.
    const element = describe(el);

    // composed: real pointer events cross shadow boundaries, and listeners on
    // the host or document never see one that doesn't.
    const opts = { bubbles: true, cancelable: true, composed: true, view: window, clientX: x, clientY: y, ...spec.init };
    for (const [type, Ctor] of spec.events) el.dispatchEvent(new Ctor(type, opts));

    // Focus a focusable target so a following `type` has a deterministic element.
    const focusable =
      el.isContentEditable ||
      (el.matches && el.matches("input, textarea, select, [contenteditable], [tabindex]"));
    if (spec.focus && focusable && typeof el.focus === "function") {
      try {
        el.focus();
      } catch {
        /* ignore */
      }
    }

    // Pages that wait on rAF or a visible document can ignore a dispatched event.
    const hidden = document.visibilityState === "hidden" ? { tabHidden: true } : {};
    return { [spec.done]: true, element, x, y, ...hidden };
  }

  FF.injected.performPointer = performPointer;

  for (const action of ["click", "hover", "double_click", "right_click"]) {
    FF.tools[action] = async (args, tab) =>
      FF.injectDescending(tab.id, performPointer, [action, args.x, args.y, args.ref ?? null], args.frameId);
  }
}

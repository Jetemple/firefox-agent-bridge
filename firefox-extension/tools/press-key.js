// press_key — dispatch a synthetic KeyboardEvent (keydown[/keypress]/keyup) on
// the focused element. Synthetic (untrusted) events drive page JS listeners; they
// do not trigger the browser's own native shortcuts/defaults.
{
  const FF = (globalThis.FFBridge ??= {});
  FF.tools ??= {};
  FF.injected ??= {};

  function performPressKey(key, mods) {
    function describe(el) {
      if (!el || !el.tagName) return null;
      const id = el.id ? "#" + el.id : "";
      const cls = el.classList && el.classList.length ? "." + Array.from(el.classList).join(".") : "";
      return el.tagName.toLowerCase() + id + cls;
    }
    const m = mods || {};
    // activeElement stops at the shadow host, and at the <iframe> holding focus.
    let active = document.activeElement;
    for (let root; active && (root = active.openOrClosedShadowRoot ?? active.shadowRoot) && root.activeElement; ) {
      active = root.activeElement;
    }
    if (active && (active.tagName === "IFRAME" || active.tagName === "FRAME")) {
      return { descend: { frameId: browser.runtime.getFrameId(active) } };
    }
    const target = active && active !== document.body ? active : document.body || document.documentElement;
    const opts = {
      key,
      bubbles: true,
      cancelable: true,
      composed: true,
      ctrlKey: !!m.ctrl,
      altKey: !!m.alt,
      shiftKey: !!m.shift,
      metaKey: !!m.meta,
    };
    target.dispatchEvent(new KeyboardEvent("keydown", opts));
    if (key.length === 1) target.dispatchEvent(new KeyboardEvent("keypress", opts));
    target.dispatchEvent(new KeyboardEvent("keyup", opts));
    return { pressed: true, key, target: describe(target) };
  }

  FF.injected.performPressKey = performPressKey;

  FF.tools.press_key = async (args, tab) =>
    FF.injectDescending(tab.id, performPressKey, [
      args.key,
      { ctrl: !!args.ctrl, alt: !!args.alt, shift: !!args.shift, meta: !!args.meta },
    ]);
}

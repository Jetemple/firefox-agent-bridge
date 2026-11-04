// type — insert text into the focused element.
//
// Two distinct paths: form controls use the native value setter + a real
// InputEvent (so React/Vue controlled inputs update from the ISOLATED world);
// contenteditable uses the editing-host insertion model. Non-editable targets
// are never mutated.
{
  const FF = (globalThis.FFBridge ??= {});
  FF.tools ??= {};
  FF.injected ??= {};

  async function performType(text, clearFirst) {
    // NOTE: executeScript serializes only this function's source — it must be
    // fully self-contained. Every constant/helper it uses is declared inside.
    const FORM_INPUT_TYPES = ["text", "email", "password", "search", "number", "tel", "url", ""];

    // Give the page's own handlers a moment to accept or undo the insert: check
    // once microtasks flush (Lexical commits there), then poll until ok() holds
    // or ~1.5s pass. A deadline, not a count: background tabs throttle timers to
    // 1s+. No retry on failure; a second insert racing a slow editor could put
    // the text in twice.
    async function settle(ok) {
      await Promise.resolve();
      const deadline = Date.now() + 1500;
      while (!ok() && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }

    // Editors split text into paragraphs and swap spaces for nbsp; input masks
    // add "(", "-" and spaces. Compare letters, digits and symbols only.
    const squash = (s) => String(s ?? "").replace(/[^\p{L}\p{N}\p{S}]+/gu, "");
    // Landed = the text is there now, and when appending, the content grew by
    // it (text already in the box before the insert doesn't count).
    const landed = (before, after, want, cleared) =>
      squash(after).includes(squash(want)) &&
      (cleared || squash(after).length - squash(before).length >= squash(want).length);

    // focus() on a <p> inside a contenteditable does nothing; the editing host
    // is the outermost contenteditable ancestor.
    function editingHost(node) {
      let host = node;
      while (host.parentElement && host.parentElement.isContentEditable) host = host.parentElement;
      return host;
    }

    function describe(el) {
      const id = el.id ? "#" + el.id : "";
      const cls = el.classList && el.classList.length ? "." + Array.from(el.classList).join(".") : "";
      return el.tagName.toLowerCase() + id + cls;
    }

    // activeElement stops at the shadow host, and at the <iframe> holding focus.
    let el = document.activeElement;
    for (let root; el && (root = el.openOrClosedShadowRoot ?? el.shadowRoot) && root.activeElement; ) {
      el = root.activeElement;
    }
    if (el && (el.tagName === "IFRAME" || el.tagName === "FRAME")) {
      return { descend: { frameId: browser.runtime.getFrameId(el) } };
    }
    if (!el || el === document.body || el === document.documentElement) {
      return { typed: false, reason: "no focused editable element" };
    }

    const tag = el.tagName;
    const isFormField =
      tag === "TEXTAREA" ||
      (tag === "INPUT" && FORM_INPUT_TYPES.includes((el.type || "").toLowerCase()));

    if (isFormField) {
      const proto = tag === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
      const next = clearFirst ? text : el.value + text;
      const before = el.value;
      setter.call(el, next); // bypasses framework value trackers
      el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      // A controlled input can reject the write (React resets it, a mask
      // reformats it). Read the field back; "typed" means the text is there.
      await settle(() => landed(before, el.value, text, clearFirst));
      if (!landed(before, el.value, text, clearFirst)) {
        const secret = (el.type || "").toLowerCase() === "password";
        return {
          typed: false,
          reason: "text did not stick: the field rejected it",
          fieldNow: secret ? `(${el.value.length} chars)` : el.value.slice(0, 200),
          targetElement: describe(el),
        };
      }
      return { typed: true, text, targetElement: describe(el) };
    }

    if (el.isContentEditable) {
      // Rich editors (Lexical, Draft, ProseMirror) keep their own model and
      // render it back to the DOM a tick later, so check after they settle.
      // A stuck or still-loading editor swallows the insert without an error.
      const host = editingHost(el);
      host.focus();
      const before = clearFirst ? "" : host.textContent;
      if (clearFirst) {
        document.execCommand("selectAll", false, null);
        document.execCommand("delete", false, null);
      }
      document.execCommand("insertText", false, text);
      await settle(() => landed(before, host.textContent, text, clearFirst));
      if (!landed(before, host.textContent, text, clearFirst)) {
        return {
          typed: false,
          reason: "text did not stick: the editor did not accept it (is it loaded and focused?)",
          fieldNow: (host.textContent || "").slice(0, 200),
          targetElement: describe(host),
        };
      }
      return { typed: true, text, targetElement: describe(host) };
    }

    return { typed: false, reason: "focused element is not editable", targetElement: describe(el) };
  }

  FF.injected.performType = performType;

  FF.tools.type = async (args, tab) => {
    return FF.injectDescending(tab.id, performType, [args.text, Boolean(args.clearFirst)]);
  };
}

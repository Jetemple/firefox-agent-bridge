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

  function performType(text, clearFirst) {
    // NOTE: executeScript serializes only this function's source — it must be
    // fully self-contained. Every constant/helper it uses is declared inside.
    const FORM_INPUT_TYPES = ["text", "email", "password", "search", "number", "tel", "url", ""];

    function describe(el) {
      const id = el.id ? "#" + el.id : "";
      const cls = el.classList && el.classList.length ? "." + Array.from(el.classList).join(".") : "";
      return el.tagName.toLowerCase() + id + cls;
    }

    const el = document.activeElement;
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
      setter.call(el, next); // bypasses framework value trackers
      el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return { typed: true, text, targetElement: describe(el) };
    }

    if (el.isContentEditable) {
      el.focus();
      if (clearFirst) {
        document.execCommand("selectAll", false, null);
        document.execCommand("delete", false, null);
      }
      document.execCommand("insertText", false, text);
      return { typed: true, text, targetElement: describe(el) };
    }

    return { typed: false, reason: "focused element is not editable", targetElement: describe(el) };
  }

  FF.injected.performType = performType;

  FF.tools.type = async (args, tab) => {
    return FF.inject(tab.id, performType, [args.text, Boolean(args.clearFirst)]);
  };
}

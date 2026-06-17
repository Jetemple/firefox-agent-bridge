// set_checkbox — set a checkbox/radio's checked state. Idempotent: input/change
// only fire when the state actually changes.
{
  const FF = (globalThis.FFBridge ??= {});
  FF.tools ??= {};
  FF.injected ??= {};

  function performSetCheckbox(selector, checked) {
    function describe(el) {
      const id = el.id ? "#" + el.id : "";
      const cls = el.classList && el.classList.length ? "." + Array.from(el.classList).join(".") : "";
      return el.tagName.toLowerCase() + id + cls;
    }
    const el = document.querySelector(selector);
    if (!el) return { set: false, reason: "no element matches " + selector };
    if (el.type !== "checkbox" && el.type !== "radio") {
      return { set: false, reason: "element is not a checkbox or radio", element: describe(el) };
    }
    if (el.checked !== checked) {
      el.checked = checked;
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    }
    return { set: true, checked: el.checked, element: describe(el) };
  }

  FF.injected.performSetCheckbox = performSetCheckbox;

  FF.tools.set_checkbox = async (args, tab) =>
    FF.inject(tab.id, performSetCheckbox, [args.selector, Boolean(args.checked)]);
}

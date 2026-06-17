// select_option — choose an <option> in a <select> by value or visible label.
{
  const FF = (globalThis.FFBridge ??= {});
  FF.tools ??= {};
  FF.injected ??= {};

  function performSelectOption(selector, value, label) {
    function describe(el) {
      const id = el.id ? "#" + el.id : "";
      const cls = el.classList && el.classList.length ? "." + Array.from(el.classList).join(".") : "";
      return el.tagName.toLowerCase() + id + cls;
    }
    const el = document.querySelector(selector);
    if (!el) return { selected: false, reason: "no element matches " + selector };
    if (el.tagName !== "SELECT") {
      return { selected: false, reason: "element is not a <select>", element: describe(el) };
    }
    const options = Array.from(el.options || []);
    let chosen = null;
    if (value != null) chosen = options.find((o) => o.value === value) || null;
    if (!chosen && label != null) chosen = options.find((o) => (o.textContent || "").trim() === label) || null;
    if (!chosen) return { selected: false, reason: "no matching option", element: describe(el) };
    el.value = chosen.value;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return { selected: true, value: el.value, element: describe(el) };
  }

  FF.injected.performSelectOption = performSelectOption;

  FF.tools.select_option = async (args, tab) =>
    FF.inject(tab.id, performSelectOption, [args.selector, args.value ?? null, args.label ?? null]);
}

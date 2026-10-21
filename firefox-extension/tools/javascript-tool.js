// javascript_tool — evaluate a code string in the page and return the result.
//
// world "ISOLATED" (default) runs in the content-script sandbox, immune to the
// page CSP; "MAIN" runs in the page's own context (Firefox 128+) where the
// page CSP may block eval. Non-cloneable return values surface as SCRIPT_FAILED.
// Output is capped in-page (like get_page_text) so a huge result never crosses
// the WebSocket: past maxLength chars, `result` becomes the truncated string
// (JSON text for non-strings) with truncated/length alongside.
{
  const FF = (globalThis.FFBridge ??= {});
  FF.tools ??= {};
  FF.injected ??= {};

  const DEFAULT_MAX_LENGTH = 50000;

  async function runUserCode(code, maxLength) {
    // Indirect eval: evaluate the expression/statements and return the value.
    const evaluate = eval;
    const result = await evaluate(code);
    let text = result;
    if (typeof result !== "string") {
      try {
        text = JSON.stringify(result);
      } catch {
        text = undefined; // cyclic etc. — return as-is; cloning decides
      }
    }
    if (typeof text !== "string" || text.length <= maxLength) return { result };
    return { result: text.slice(0, maxLength), truncated: true, length: text.length };
  }
  FF.injected.runUserCode = runUserCode;

  FF.tools.javascript_tool = async (args, tab) => {
    const world = args.world === "MAIN" ? "MAIN" : "ISOLATED";
    return FF.inject(tab.id, runUserCode, [args.code, args.maxLength ?? DEFAULT_MAX_LENGTH], world);
  };
}

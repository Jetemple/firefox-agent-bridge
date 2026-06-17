// javascript_tool — evaluate a code string in the page and return the result.
//
// world "ISOLATED" (default) runs in the content-script sandbox, immune to the
// page CSP; "MAIN" runs in the page's own context (Firefox 128+) where the
// page CSP may block eval. Non-cloneable return values surface as SCRIPT_FAILED.
{
  const FF = (globalThis.FFBridge ??= {});
  FF.tools ??= {};
  FF.injected ??= {};

  function runUserCode(code) {
    // Indirect eval: evaluate the expression/statements and return the value.
    const evaluate = eval;
    return evaluate(code);
  }
  FF.injected.runUserCode = runUserCode;

  FF.tools.javascript_tool = async (args, tab) => {
    const world = args.world === "MAIN" ? "MAIN" : "ISOLATED";
    const result = await FF.inject(tab.id, runUserCode, [args.code], world);
    return { result };
  };
}

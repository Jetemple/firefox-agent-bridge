// get_tables — extract tables as arrays of rows of cell text.
{
  const FF = (globalThis.FFBridge ??= {});
  FF.tools ??= {};
  FF.injected ??= {};

  function getTables(max) {
    const tables = Array.from(document.querySelectorAll("table"));
    const limit = max != null ? max : tables.length;
    const out = [];
    for (let i = 0; i < tables.length && out.length < limit; i++) {
      const rows = Array.from(tables[i].querySelectorAll("tr")).map((tr) =>
        Array.from(tr.querySelectorAll("th, td")).map((c) => (c.innerText || c.textContent || "").trim()),
      );
      out.push(rows);
    }
    return { tables: out, count: tables.length, truncated: out.length < tables.length };
  }

  FF.injected.getTables = getTables;

  FF.tools.get_tables = async (args, tab) => FF.inject(tab.id, getTables, [args.max ?? null]);
}

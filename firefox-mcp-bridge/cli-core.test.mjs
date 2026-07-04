import test from "node:test";
import assert from "node:assert/strict";
import { parseCli, formatResult, usageText } from "./cli-core.mjs";
import { WS_TOOL_NAMES } from "./tools.mjs";

function steps(argv) {
  const p = parseCli(argv);
  assert.equal(p.ok, true, p.error);
  assert.equal(p.kind, "steps");
  return p;
}

// --- simple 1:1 commands ---

test("ff tabs → get_tabs_summary with empty args", () => {
  assert.deepEqual(steps(["tabs"]).steps, [{ tool: "get_tabs_summary", args: {} }]);
});

test("ff nav builds navigate args (with --tab)", () => {
  assert.deepEqual(steps(["nav", "example.com"]).steps, [
    { tool: "navigate", args: { url: "example.com" } },
  ]);
  assert.deepEqual(steps(["nav", "example.com", "--tab", "7"]).steps, [
    { tool: "navigate", args: { url: "example.com", tabId: 7 } },
  ]);
});

test("ff text / links / tables / js / key / scroll / drag / select / check map to schema-shaped args", () => {
  assert.deepEqual(steps(["text", "--max", "500"]).steps, [{ tool: "get_page_text", args: { maxLength: 500 } }]);
  assert.deepEqual(steps(["links", "--max", "10"]).steps, [{ tool: "get_links", args: { max: 10 } }]);
  assert.deepEqual(steps(["tables"]).steps, [{ tool: "get_tables", args: {} }]);
  assert.deepEqual(steps(["js", "1+1"]).steps, [{ tool: "javascript_tool", args: { code: "1+1" } }]);
  assert.deepEqual(steps(["key", "Enter", "--meta"]).steps, [{ tool: "press_key", args: { key: "Enter", meta: true } }]);
  assert.deepEqual(steps(["scroll", "--dy", "600"]).steps, [{ tool: "scroll", args: { dy: 600 } }]);
  assert.deepEqual(steps(["scroll", "--into", "#footer"]).steps, [{ tool: "scroll", args: { selector: "#footer" } }]);
  assert.deepEqual(steps(["drag", "--from", "10,20", "--to", "30,40"]).steps, [
    { tool: "drag", args: { fromX: 10, fromY: 20, toX: 30, toY: 40 } },
  ]);
  assert.deepEqual(steps(["select", "#lang", "en"]).steps, [
    { tool: "select_option", args: { selector: "#lang", value: "en" } },
  ]);
  assert.deepEqual(steps(["select", "#lang", "English", "--by-text"]).steps, [
    { tool: "select_option", args: { selector: "#lang", label: "English" } },
  ]);
  assert.deepEqual(steps(["check", "#tos"]).steps, [{ tool: "set_checkbox", args: { selector: "#tos", checked: true } }]);
  assert.deepEqual(steps(["uncheck", "#tos"]).steps, [
    { tool: "set_checkbox", args: { selector: "#tos", checked: false } },
  ]);
});

test("ff tab close/activate, reload --hard, back, forward", () => {
  assert.deepEqual(steps(["tab", "close", "--tab", "3"]).steps, [{ tool: "close_tab", args: { tabId: 3 } }]);
  assert.deepEqual(steps(["tab", "activate", "--tab", "3"]).steps, [{ tool: "activate_tab", args: { tabId: 3 } }]);
  assert.deepEqual(steps(["reload", "--hard"]).steps, [{ tool: "reload", args: { bypassCache: true } }]);
  assert.deepEqual(steps(["back"]).steps, [{ tool: "back", args: {} }]);
  assert.deepEqual(steps(["forward"]).steps, [{ tool: "forward", args: {} }]);
});

// --- composites ---

test("ff click <query> plans find_element then click at the found center", () => {
  const p = steps(["click", "Sign in"]);
  assert.equal(p.steps.length, 2);
  assert.deepEqual(p.steps[0], { tool: "find_element", args: { text: "Sign in" } });
  assert.equal(p.steps[1].tool, "click");
  assert.deepEqual(p.steps[1].buildArgs({ found: true, x: 10, y: 20 }), { x: 10, y: 20 });
  assert.equal(p.steps[1].buildArgs({ found: false }), null);
});

test("ff click --css scopes the find; --at skips it; both propagate --tab", () => {
  const scoped = steps(["click", "Save", "--css", "button", "--tab", "5"]);
  assert.deepEqual(scoped.steps[0], { tool: "find_element", args: { text: "Save", selector: "button", tabId: 5 } });
  assert.deepEqual(scoped.steps[1].buildArgs({ found: true, x: 1, y: 2 }), { x: 1, y: 2, tabId: 5 });

  const at = steps(["click", "--at", "100,200"]);
  assert.deepEqual(at.steps, [{ tool: "click", args: { x: 100, y: 200 } }]);
});

test("hover/dblclick/rclick share the composite shape", () => {
  assert.equal(steps(["hover", "Menu"]).steps[1].tool, "hover");
  assert.equal(steps(["dblclick", "Cell"]).steps[1].tool, "double_click");
  assert.equal(steps(["rclick", "File"]).steps[1].tool, "right_click");
});

test("ff type <query> <text> plans find → click → type; --focused skips targeting", () => {
  const p = steps(["type", "Email", "me@x.com", "--clear"]);
  assert.equal(p.steps.length, 3);
  assert.deepEqual(p.steps[0], { tool: "find_element", args: { text: "Email" } });
  assert.equal(p.steps[1].tool, "click");
  assert.deepEqual(p.steps[2].args, { text: "me@x.com", clearFirst: true });

  const focused = steps(["type", "hello world", "--focused"]);
  assert.deepEqual(focused.steps, [{ tool: "type", args: { text: "hello world" } }]);
});

test("ff find maps text and --css", () => {
  assert.deepEqual(steps(["find", "Log out", "--css", "a"]).steps, [
    { tool: "find_element", args: { text: "Log out", selector: "a" } },
  ]);
});

// --- errors, lifecycle, help ---

test("unknown command / missing args / bad --at are usage errors", () => {
  assert.equal(parseCli(["frobnicate"]).ok, false);
  assert.equal(parseCli(["nav"]).ok, false);
  assert.equal(parseCli(["click"]).ok, false); // needs query, --css, or --at
  assert.equal(parseCli(["click", "--at", "nope"]).ok, false);
  assert.equal(parseCli(["scroll"]).ok, false); // needs --dx/--dy/--into
});

test("lifecycle and help parse", () => {
  assert.deepEqual(parseCli(["status"]).kind, "lifecycle");
  assert.deepEqual(parseCli(["start"]).kind, "lifecycle");
  assert.deepEqual(parseCli(["stop"]).kind, "lifecycle");
  assert.deepEqual(parseCli(["ping"]).kind, "lifecycle");
  assert.equal(parseCli(["--help"]).kind, "help");
  assert.equal(parseCli([]).kind, "help");
});

test("global flags: --json and --timeout are extracted", () => {
  const p = steps(["tabs", "--json", "--timeout", "5000"]);
  assert.equal(p.flags.json, true);
  assert.equal(p.flags.timeout, 5000);
});

// --- formatting ---

test("formatResult renders tabs, text, find, and links as plain text", () => {
  const tabs = formatResult("tabs", [
    { tool: "get_tabs_summary", result: { tabs: [{ id: 1, title: "A", url: "http://a", active: true }] } },
  ], { json: false });
  assert.match(tabs, /1\*.*A.*http:\/\/a/);

  const text = formatResult("text", [{ tool: "get_page_text", result: { text: "hello" } }], { json: false });
  assert.equal(text, "hello");

  const find = formatResult("find", [
    { tool: "find_element", result: { found: true, element: "button#go", text: "Go", x: 5, y: 6 } },
  ], { json: false });
  assert.match(find, /button#go.*\(5, 6\)/);

  const links = formatResult("links", [
    { tool: "get_links", result: { links: [{ text: "Home", href: "http://h" }] } },
  ], { json: false });
  assert.match(links, /Home — http:\/\/h/);
});

test("formatResult --json emits the last step result as JSON", () => {
  const out = formatResult("tabs", [{ tool: "get_tabs_summary", result: { tabs: [] } }], { json: true });
  assert.deepEqual(JSON.parse(out), { tabs: [] });
});

// --- coverage: every relayed tool is reachable from the CLI ---

test("every WS tool is reachable through some CLI command", () => {
  const reachable = new Set();
  const invocations = [
    ["tabs"], ["nav", "x.com"], ["text"], ["screenshot"],
    ["click", "--at", "1,2"], ["type", "t", "--focused"], ["js", "1"],
    ["tab", "close"], ["tab", "activate", "--tab", "1"], ["reload"], ["back"], ["forward"],
    ["key", "Enter"], ["scroll", "--dy", "1"], ["click", "q"], ["dblclick", "q"], ["rclick", "q"], ["hover", "q"],
    ["drag", "--from", "1,2", "--to", "3,4"], ["select", "#s", "v"], ["check", "#c"],
    ["find", "q"], ["links"], ["tables"],
  ];
  for (const argv of invocations) {
    const p = parseCli(argv);
    assert.equal(p.ok, true, `${argv.join(" ")}: ${p.error}`);
    for (const s of p.steps) reachable.add(s.tool);
  }
  for (const tool of WS_TOOL_NAMES) {
    assert.ok(reachable.has(tool), `tool not reachable from CLI: ${tool}`);
  }
});

test("usageText is one screen and mentions every command", () => {
  const u = usageText();
  assert.ok(u.split("\n").length <= 45, "help must stay one screen");
  for (const cmd of ["tabs", "nav", "text", "screenshot", "click", "type", "key", "scroll", "drag",
                     "select", "check", "uncheck", "find", "links", "tables", "js", "tab", "reload",
                     "back", "forward", "status", "start", "stop", "ping"]) {
    assert.ok(u.includes(cmd), `usage missing: ${cmd}`);
  }
});

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

test("--replace parses as a boolean flag on start", () => {
  const p = parseCli(["start", "--replace"]);
  assert.equal(p.ok, true);
  assert.equal(p.kind, "lifecycle");
  assert.equal(p.command, "start");
  assert.equal(p.flags.replace, true);
  assert.equal(parseCli(["start"]).flags.replace, false);
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

test("formatResult unwraps js results: string raw, non-string as JSON, wrapper only with --json", () => {
  const jsRes = (v) => [{ tool: "javascript_tool", result: { result: v } }];
  // strings print raw — no {"result":...} wrapper to strip
  assert.equal(formatResult("js", jsRes("hello world"), { json: false }), "hello world");
  // primitives stringify to their bare form
  assert.equal(formatResult("js", jsRes(42), { json: false }), "42");
  assert.equal(formatResult("js", jsRes(null), { json: false }), "null");
  // objects/arrays pretty-print as JSON
  assert.equal(formatResult("js", jsRes({ a: 1 }), { json: false }), JSON.stringify({ a: 1 }, null, 2));
  // --json still emits the full wrapper
  assert.deepEqual(JSON.parse(formatResult("js", jsRes("x"), { json: true })), { result: "x" });
});

test("--wait-for and --wait-timeout parse into global flags", () => {
  const p = steps(["nav", "x.com", "--wait-for", ".card", "--wait-timeout", "3000"]);
  assert.equal(p.flags.waitFor, ".card");
  assert.equal(p.flags.waitTimeout, 3000);
  // navigate step itself is unchanged by the wait flags
  assert.deepEqual(p.steps, [{ tool: "navigate", args: { url: "x.com" } }]);
});

// --- sessions / profiles ---

test("global flags parse before or after the command, -s aliases --session", () => {
  for (const argv of [
    ["-s", "research", "text"],
    ["--session", "research", "text"],
    ["text", "-s", "research"],
    ["--session=research", "text"],
  ]) {
    const p = parseCli(argv);
    assert.equal(p.ok, true, JSON.stringify(argv));
    assert.equal(p.flags.session, "research");
    assert.deepEqual(p.steps[0], { tool: "get_page_text", args: {} });
  }
  const q = parseCli(["--profile", "work", "nav", "https://x.com"]);
  assert.equal(q.flags.profile, "work");
});

test("session conflicts are usage errors", () => {
  assert.equal(parseCli(["text", "-s", "a", "--tab", "3"]).ok, false);
  assert.equal(parseCli(["text", "-s", "a", "--profile", "p"]).ok, false);
  assert.match(parseCli(["text", "-s", "a", "--tab", "3"]).error, /--tab/);
});

test("--here targets the viewed tab (tabId \"active\") and conflicts with --tab / -s", () => {
  assert.deepEqual(steps(["text", "--here"]).steps, [{ tool: "get_page_text", args: { tabId: "active" } }]);
  assert.deepEqual(steps(["--here", "nav", "x.com"]).steps, [{ tool: "navigate", args: { url: "x.com", tabId: "active" } }]);
  const click = steps(["click", "Go", "--here"]).steps;
  assert.equal(click[0].args.tabId, "active");
  assert.equal(click[1].buildArgs({ found: true, x: 1, y: 2 }).tabId, "active");
  assert.match(parseCli(["text", "--here", "--tab", "3"]).error, /--here/);
  assert.match(parseCli(["text", "--here", "-s", "a"]).error, /--here/);
});

test("ff js --max maps to maxLength", () => {
  assert.deepEqual(steps(["js", "1+1", "--max", "100"]).steps, [
    { tool: "javascript_tool", args: { code: "1+1", maxLength: 100 } },
  ]);
});

test("formatResult marks the agent tab in ff tabs", () => {
  const out = formatResult("tabs", [
    { tool: "get_tabs_summary", result: { tabs: [
      { id: 3, title: "Mine", url: "http://a", active: true },
      { id: 12, title: "Agent's", url: "http://b", active: false, agent: true },
    ] } },
  ], { json: false });
  assert.deepEqual(out.split("\n"), ["3*  Mine — http://a", "12   🤖 Agent's — http://b"]);
});

test("-s/--session/--profile with no following value is a usage error, in leading and trailing position", () => {
  for (const argv of [["-s"], ["--session"], ["--profile"]]) {
    const p = parseCli(argv);
    assert.equal(p.ok, false, JSON.stringify(argv));
    assert.match(p.error, /missing value for/);
  }
  assert.match(parseCli(["-s"]).error, /-s\/--session/);
  assert.match(parseCli(["--session"]).error, /-s\/--session/);
  assert.match(parseCli(["--profile"]).error, /--profile/);

  for (const argv of [["text", "-s"], ["text", "--session"], ["text", "--profile"]]) {
    const p = parseCli(argv);
    assert.equal(p.ok, false, JSON.stringify(argv));
    assert.match(p.error, /missing value for/);
  }
  assert.match(parseCli(["text", "-s"]).error, /-s\/--session/);
  assert.match(parseCli(["text", "--session"]).error, /-s\/--session/);
  assert.match(parseCli(["text", "--profile"]).error, /--profile/);
});

test("open builds open_tab; --foreground activates; --as passes the label to the tab marker", () => {
  const p = parseCli(["open", "https://x.com", "--as", "research", "--foreground"]);
  // --as flows into the open_tab args as `label` so the extension can stamp
  // the session name onto the tab title; it's also captured on flags for the
  // post-open session_bind that cli.mjs issues.
  assert.deepEqual(p.steps, [{ tool: "open_tab", args: { url: "https://x.com", active: true, label: "research" } }]);
  assert.equal(p.flags.as, "research");
  assert.equal(parseCli(["open"]).ok, false);
  // No --as → no label key at all (emoji-only stamp), and background by default.
  const bg = parseCli(["open", "https://x.com"]);
  assert.deepEqual(bg.steps, [{ tool: "open_tab", args: { url: "https://x.com", active: false } }]);
});

test("sessions / session rm / bind / profiles build the pseudo-tool steps", () => {
  assert.deepEqual(parseCli(["sessions"]).steps, [{ tool: "session_list", args: {} }]);
  assert.deepEqual(parseCli(["session", "rm", "research"]).steps, [{ tool: "session_remove", args: { name: "research" } }]);
  assert.equal(parseCli(["session"]).ok, false);
  assert.deepEqual(parseCli(["bind", "research", "--tab", "42"]).steps, [{ tool: "session_bind", args: { name: "research", tabId: 42 } }]);
  assert.equal(parseCli(["bind", "research"]).ok, false, "bind requires --tab");
  assert.deepEqual(parseCli(["profiles"]).steps, [{ tool: "profiles_list", args: {} }]);
});

test("profiles name NEW targets the sole connection; OLD NEW routes via profile", () => {
  const one = parseCli(["profiles", "name", "work"]);
  assert.deepEqual(one.steps, [{ tool: "set_profile_name", args: { name: "work" } }]);
  assert.equal(one.flags.profile, undefined);
  const two = parseCli(["profiles", "name", "default", "work"]);
  assert.deepEqual(two.steps, [{ tool: "set_profile_name", args: { name: "work" } }]);
  assert.equal(two.flags.profile, "default");
});

test("formatResult renders sessions, profiles, open, and bind", () => {
  const sessions = formatResult("sessions", [{ tool: "session_list", result: { sessions: [
    { name: "research", profile: "work", tabId: 42, live: true, url: "https://x.com" },
    { name: "old", profile: "work", tabId: 7, live: false, url: null },
  ] } }], {});
  assert.match(sessions, /research\s+work\s+tab 42\s+live\s+https:\/\/x\.com/);
  assert.match(sessions, /old\s+work\s+tab 7\s+STALE/);

  const profiles = formatResult("profiles", [{ tool: "profiles_list", result: { profiles: [{ name: "work", runId: "r", connectedAt: 1 }] } }], {});
  assert.match(profiles, /work/);

  assert.match(formatResult("open", [{ tool: "open_tab", result: { tabId: 55, windowId: 2, url: "https://x.com" } }], {}), /tab 55/);
  assert.match(
    formatResult("bind", [{ tool: "session_bind", result: { name: "research", profile: "work", tabId: 42, url: null, previous: null } }], {}),
    /research.*tab 42.*work/,
  );
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
    ["find", "q"], ["links"], ["tables"], ["open", "https://x.com"],
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
                     "back", "forward", "status", "start", "stop", "ping",
                     "open", "sessions", "session", "bind", "profiles"]) {
    assert.ok(u.includes(cmd), `usage missing: ${cmd}`);
  }
});

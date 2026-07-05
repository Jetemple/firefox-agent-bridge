import test from "node:test";
import assert from "node:assert/strict";
import { TOOLS, WS_TOOL_NAMES } from "./tools.mjs";

const EXPECTED = [
  // original 8
  "ping_firefox",
  "get_tabs_summary",
  "navigate",
  "open_tab",
  "screenshot",
  "get_page_text",
  "click",
  "type",
  "javascript_tool",
  // group A — tab tools
  "close_tab",
  "activate_tab",
  "reload",
  "back",
  "forward",
  // group B — injected interaction tools
  "press_key",
  "scroll",
  "hover",
  "double_click",
  "right_click",
  "drag",
  "select_option",
  "set_checkbox",
  // group C — injected query tools
  "find_element",
  "get_links",
  "get_tables",
];

test("TOOLS defines exactly the expected spec tools", () => {
  assert.equal(TOOLS.length, EXPECTED.length);
  assert.deepEqual(
    TOOLS.map((t) => t.name).sort(),
    [...EXPECTED].sort(),
  );
});

test("every tool has a non-empty description", () => {
  for (const t of TOOLS) {
    assert.equal(typeof t.description, "string");
    assert.ok(t.description.length > 0, `${t.name} needs a description`);
  }
});

test("no-arg tools omit inputSchema (registerTool throws on empty JSON schema)", () => {
  const ping = TOOLS.find((t) => t.name === "ping_firefox");
  const tabs = TOOLS.find((t) => t.name === "get_tabs_summary");
  assert.equal(ping.inputSchema, undefined);
  assert.equal(tabs.inputSchema, undefined);
});

test("navigate inputSchema is a Zod raw shape with a usable url field", () => {
  const navigate = TOOLS.find((t) => t.name === "navigate");
  assert.equal(typeof navigate.inputSchema, "object");
  // Zod schema: has .parse and accepts a string
  assert.equal(navigate.inputSchema.url.parse("https://example.com"), "https://example.com");
  // tabId is optional
  assert.equal(navigate.inputSchema.tabId.parse(undefined), undefined);
});

test("click inputSchema requires numeric x and y", () => {
  const click = TOOLS.find((t) => t.name === "click");
  assert.equal(click.inputSchema.x.parse(10), 10);
  assert.equal(click.inputSchema.y.parse(20), 20);
  assert.throws(() => click.inputSchema.x.parse("nope"));
});

test("WS_TOOL_NAMES is every tool except the bridge-only ping_firefox", () => {
  assert.equal(WS_TOOL_NAMES.length, EXPECTED.length - 1);
  assert.ok(!WS_TOOL_NAMES.includes("ping_firefox"));
  assert.ok(WS_TOOL_NAMES.includes("get_tabs_summary"));
});

const byName = Object.fromEntries(TOOLS.map((t) => [t.name, t]));

test("group A tab tools take an optional tabId; reload adds optional bypassCache", () => {
  for (const n of ["close_tab", "activate_tab", "reload", "back", "forward"]) {
    assert.ok(byName[n], `${n} missing from TOOLS`);
    assert.equal(byName[n].inputSchema.tabId.parse(undefined), undefined);
    assert.equal(byName[n].inputSchema.tabId.parse(7), 7);
  }
  assert.equal(byName.reload.inputSchema.bypassCache.parse(true), true);
  assert.equal(byName.reload.inputSchema.bypassCache.parse(undefined), undefined);
});

test("group B interaction tools expose their coordinate / key / selector inputs", () => {
  for (const n of ["hover", "double_click", "right_click"]) {
    assert.equal(byName[n].inputSchema.x.parse(3), 3);
    assert.equal(byName[n].inputSchema.y.parse(4), 4);
  }
  assert.equal(byName.drag.inputSchema.fromX.parse(1), 1);
  assert.equal(byName.drag.inputSchema.toY.parse(2), 2);
  assert.equal(byName.press_key.inputSchema.key.parse("Enter"), "Enter");
  assert.equal(byName.press_key.inputSchema.ctrl.parse(undefined), undefined);
  assert.equal(byName.scroll.inputSchema.dy.parse(100), 100);
  assert.equal(byName.scroll.inputSchema.selector.parse(undefined), undefined);
  assert.equal(byName.select_option.inputSchema.selector.parse("#s"), "#s");
  assert.equal(byName.set_checkbox.inputSchema.checked.parse(true), true);
});

test("group C query tools expose their selector / text / max inputs", () => {
  assert.equal(byName.find_element.inputSchema.text.parse(undefined), undefined);
  assert.equal(byName.find_element.inputSchema.selector.parse("a.cta"), "a.cta");
  assert.equal(byName.get_links.inputSchema.max.parse(10), 10);
  assert.equal(byName.get_links.inputSchema.max.parse(undefined), undefined);
  assert.equal(byName.get_tables.inputSchema.max.parse(undefined), undefined);
});

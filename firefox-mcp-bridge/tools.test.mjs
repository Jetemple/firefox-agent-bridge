import test from "node:test";
import assert from "node:assert/strict";
import { TOOLS, WS_TOOL_NAMES } from "./tools.mjs";

const EXPECTED = [
  "ping_firefox",
  "get_tabs_summary",
  "navigate",
  "screenshot",
  "get_page_text",
  "click",
  "type",
  "javascript_tool",
];

test("TOOLS defines exactly the 8 spec tools", () => {
  assert.equal(TOOLS.length, 8);
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

test("WS_TOOL_NAMES are the 7 tools dispatched to the extension (ping is bridge-only)", () => {
  assert.equal(WS_TOOL_NAMES.length, 7);
  assert.ok(!WS_TOOL_NAMES.includes("ping_firefox"));
  assert.ok(WS_TOOL_NAMES.includes("get_tabs_summary"));
});

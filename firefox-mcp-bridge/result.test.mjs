import test from "node:test";
import assert from "node:assert/strict";
import { toCallToolResult, toErrorResult } from "./result.mjs";

test("text tools wrap the WS result as a JSON text content block", () => {
  const r = toCallToolResult("get_tabs_summary", { tabs: [{ id: 1 }] });
  assert.deepEqual(r, {
    content: [{ type: "text", text: JSON.stringify({ tabs: [{ id: 1 }] }) }],
  });
  assert.equal(r.isError, undefined);
});

test("screenshot returns an MCP image content block with the data: prefix stripped", () => {
  const r = toCallToolResult("screenshot", {
    dataUrl: "data:image/png;base64,AAAABBBB",
    format: "png",
    width: 800,
    height: 600,
  });
  const image = r.content[0];
  assert.equal(image.type, "image");
  assert.equal(image.data, "AAAABBBB"); // prefix stripped
  assert.equal(image.mimeType, "image/png");
  // sibling text block carries the metadata
  assert.deepEqual(JSON.parse(r.content[1].text), { format: "png", width: 800, height: 600 });
});

test("screenshot jpeg maps to image/jpeg", () => {
  const r = toCallToolResult("screenshot", {
    dataUrl: "data:image/jpeg;base64,ZZZZ",
    format: "jpeg",
    width: 1,
    height: 1,
  });
  assert.equal(r.content[0].mimeType, "image/jpeg");
  assert.equal(r.content[0].data, "ZZZZ");
});

test("screenshot tolerates a bare base64 string with no data: prefix", () => {
  const r = toCallToolResult("screenshot", { dataUrl: "RAWBASE64", format: "png", width: 1, height: 1 });
  assert.equal(r.content[0].data, "RAWBASE64");
});

test("a malformed screenshot payload (missing dataUrl) yields a descriptive INTERNAL error, not a TypeError", () => {
  const r = toCallToolResult("screenshot", { format: "png" }); // no dataUrl
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /^INTERNAL: /);
  assert.match(r.content[0].text, /dataUrl/);
  // also tolerate a null payload entirely
  const r2 = toCallToolResult("screenshot", null);
  assert.equal(r2.isError, true);
});

test("toErrorResult builds an isError text result of the form 'CODE: message'", () => {
  const r = toErrorResult("NO_CLIENT", "No Firefox extension connected");
  assert.equal(r.isError, true);
  assert.equal(r.content[0].type, "text");
  assert.equal(r.content[0].text, "NO_CLIENT: No Firefox extension connected");
});

import test from "node:test";
import assert from "node:assert/strict";
import { approxTokens, parseArgs, recordFromResult, renderSummary } from "./browser-cli-surface.mjs";

test("approxTokens uses the documented bytes / 4 rule", () => {
  assert.equal(approxTokens(0), 0);
  assert.equal(approxTokens(1), 1);
  assert.equal(approxTokens(4), 1);
  assert.equal(approxTokens(5), 2);
});

test("parseArgs handles tools, target, out, and repeat", () => {
  assert.deepEqual(parseArgs(["--tools", "ff,playwright", "--target", "local", "--out", "x.jsonl", "--repeat", "2"]), {
    tools: ["ff", "playwright"],
    target: "local",
    out: "x.jsonl",
    repeat: 2,
  });
});

test("recordFromResult captures byte and token counts", () => {
  const started = 1000n;
  const ended = 5_001_000n;
  const record = recordFromResult({
    tool: "ff",
    operation: "text",
    target: "local",
    command: "ff text",
    result: { code: 0, stdout: "hello", stderr: "" },
    started,
    ended,
    ok: true,
    notes: "",
  });
  assert.equal(record.duration_ms, 5);
  assert.equal(record.stdout_bytes, 5);
  assert.equal(record.stderr_bytes, 0);
  assert.equal(record.approx_stdout_tokens, 2);
  assert.equal(record.ok, true);
});

test("renderSummary creates a compact markdown table", () => {
  const md = renderSummary([
    { tool: "ff", operation: "text", target: "local", ok: true, duration_ms: 12, stdout_bytes: 20, approx_stdout_tokens: 5, notes: "" },
  ]);
  assert.match(md, /\| Tool \| Operation \| Target \| OK \| Duration/);
  assert.match(md, /\| ff \| text \| local \| yes \| 12/);
});

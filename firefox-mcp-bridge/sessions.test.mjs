import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSessionStore } from "./sessions.mjs";

const REC = { profile: "work", tabId: 42, runId: "run-1", url: "https://x.com" };

test("bind/get/list/remove round-trip in memory", () => {
  const store = createSessionStore({ filePath: null });
  assert.equal(store.bind("research", REC), null);
  assert.equal(store.get("research").tabId, 42);
  assert.equal(store.list().length, 1);
  const prev = store.bind("research", { ...REC, tabId: 7 });
  assert.equal(prev.tabId, 42, "rebind returns the previous binding");
  assert.equal(store.remove("research"), true);
  assert.equal(store.remove("research"), false);
});

test("persists atomically with 0600 file in a 0700 dir and loads back", () => {
  const dir = join(mkdtempSync(join(tmpdir(), "ff-sess-")), "deep");
  const file = join(dir, "sessions.json");
  const store = createSessionStore({ filePath: file });
  store.bind("research", REC);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(statSync(dir).mode & 0o777, 0o700);
  assert.equal(existsSync(`${file}.tmp`), false, "tmp file renamed away");

  const reloaded = createSessionStore({ filePath: file });
  reloaded.load();
  assert.equal(reloaded.get("research").url, "https://x.com");
});

test("load tolerates a missing or corrupt file", () => {
  const dir = mkdtempSync(join(tmpdir(), "ff-sess-"));
  const missing = createSessionStore({ filePath: join(dir, "nope.json") });
  missing.load();
  assert.equal(missing.list().length, 0);
});

test("bind rejects invalid session names with BAD_NAME", () => {
  const store = createSessionStore({ filePath: null });
  for (const bad of ["", "-x", "UPPER", "a".repeat(33), "sp ace"]) {
    assert.throws(() => store.bind(bad, REC), (e) => e.code === "BAD_NAME");
  }
});

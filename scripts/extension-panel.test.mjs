// The panel's "bring Firefox to the front" toggle: it shows the stored
// setting and writes it back. Loaded in a sandbox with a stubbed document
// and browser, like the other extension tests.
import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const PANEL = resolve(dirname(fileURLToPath(import.meta.url)), "../firefox-extension/panel.js");

async function loadPanel(stored) {
  const elements = new Map();
  const element = (sel) => {
    if (!elements.has(sel)) {
      const el = { listeners: {}, addEventListener: (type, fn) => (el.listeners[type] = fn) };
      elements.set(sel, el);
    }
    return elements.get(sel);
  };
  const writes = [];
  const sandbox = {
    document: { querySelector: element },
    // The setting lives in the extension page's localStorage (focus-gate.js).
    localStorage: { getItem: (key) => stored[key] ?? null, setItem: (key, value) => writes.push([key, value]) },
    browser: {
      runtime: { sendMessage: async () => ({ state: "connected" }), onMessage: { addListener: () => {} } },
      storage: { local: { get: async () => assert.fail("not browser.storage"), set: async () => assert.fail("not browser.storage") } },
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(readFileSync(PANEL, "utf8"), sandbox, { filename: "panel.js" });
  return { focusEl: element("#allow-focus"), writes };
}

test("the focus toggle is off when nothing is stored", async () => {
  const { focusEl } = await loadPanel({});
  assert.equal(focusEl.checked, false);
});

test("the focus toggle shows a stored true", async () => {
  const { focusEl } = await loadPanel({ allowWindowFocus: "true" });
  assert.equal(focusEl.checked, true);
});

test("changing the focus toggle stores the new value", async () => {
  const { focusEl, writes } = await loadPanel({});
  focusEl.checked = true;
  focusEl.listeners.change();
  assert.deepEqual(JSON.parse(JSON.stringify(writes)), [["allowWindowFocus", "true"]]);
});

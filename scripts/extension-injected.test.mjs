// Regression tests for the Firefox extension's injected tool functions.
//
// browser.scripting.executeScript serializes ONLY a function's source (via
// Function.prototype.toString) and re-parses it in the page — the background
// page's module scope is NOT carried along. So an injected function that
// references any outer-scope identifier throws ReferenceError in the page.
//
// These tests reproduce that exactly: each injected function is read from its
// tool file, re-evaluated from source in a fresh context containing ONLY DOM
// stubs, then executed. A leaked free identifier fails the test.
import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const EXT = resolve(dirname(fileURLToPath(import.meta.url)), "../firefox-extension");

// Load the tool files into a sandbox to collect globalThis.FFBridge.injected.*
function loadInjected() {
  const sandbox = { browser: {} };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  for (const file of [
    "tools/type.js",
    "tools/click.js",
    "tools/get-page-text.js",
    "tools/screenshot.js",
    "tools/javascript-tool.js",
  ]) {
    vm.runInContext(readFileSync(resolve(EXT, file), "utf8"), sandbox, { filename: file });
  }
  return sandbox.FFBridge.injected;
}

// Re-evaluate a function purely from its source string in a fresh context —
// mirroring executeScript. Free identifiers resolve only against `globals`.
function reserialize(fn, globals) {
  const ctx = vm.createContext(globals);
  return vm.runInContext(`(${fn.toString()})`, ctx);
}

const injected = loadInjected();

class FakeEvent {
  constructor(type, opts) {
    this.type = type;
    Object.assign(this, opts);
  }
}

function valueClass() {
  class C {}
  Object.defineProperty(C.prototype, "value", {
    configurable: true,
    get() {
      return this.__v ?? "";
    },
    set(v) {
      this.__v = v;
    },
  });
  return C;
}

test("performType is self-contained and types into a text <input> (regression for FORM_INPUT_TYPES leak)", () => {
  const HTMLInputElement = valueClass();
  const HTMLTextAreaElement = valueClass();
  const el = Object.create(HTMLInputElement.prototype);
  Object.assign(el, {
    tagName: "INPUT",
    type: "text",
    id: "q",
    classList: { length: 0 },
    dispatchEvent: () => true,
    focus: () => {},
    isContentEditable: false,
  });

  const fn = reserialize(injected.performType, {
    document: { activeElement: el },
    HTMLInputElement,
    HTMLTextAreaElement,
    InputEvent: FakeEvent,
    Event: FakeEvent,
  });

  const res = fn("hello", false);
  assert.equal(res.typed, true);
  assert.equal(res.targetElement, "input#q");
  assert.equal(el.value, "hello");
});

test("performType appends vs clears, and writes into a <textarea>", () => {
  const HTMLInputElement = valueClass();
  const HTMLTextAreaElement = valueClass();
  const el = Object.create(HTMLTextAreaElement.prototype);
  Object.assign(el, {
    tagName: "TEXTAREA",
    id: "",
    classList: { length: 0 },
    dispatchEvent: () => true,
    focus: () => {},
    isContentEditable: false,
  });
  el.value = "abc";

  const ctx = () => ({
    document: { activeElement: el },
    HTMLInputElement,
    HTMLTextAreaElement,
    InputEvent: FakeEvent,
    Event: FakeEvent,
  });

  assert.equal(reserialize(injected.performType, ctx())("X", false).typed, true);
  assert.equal(el.value, "abcX");
  reserialize(injected.performType, ctx())("Y", true);
  assert.equal(el.value, "Y");
});

test("performType inserts into contenteditable and refuses non-editable targets", () => {
  const editable = { tagName: "DIV", id: "", classList: { length: 0 }, isContentEditable: true, focus: () => {} };
  let inserted = null;
  const editableFn = reserialize(injected.performType, {
    document: {
      activeElement: editable,
      execCommand: (cmd, _ui, val) => {
        if (cmd === "insertText") inserted = val;
        return true;
      },
    },
  });
  assert.equal(editableFn("note", false).typed, true);
  assert.equal(inserted, "note");

  const plain = { tagName: "DIV", id: "", classList: { length: 0 }, isContentEditable: false };
  const plainFn = reserialize(injected.performType, { document: { activeElement: plain } });
  assert.equal(plainFn("x", false).typed, false);
});

test("performClick is self-contained, describes the element, and dispatches", () => {
  let dispatched = 0;
  const target = {
    tagName: "BUTTON",
    id: "go",
    classList: { length: 1, 0: "primary" },
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 10, height: 10 }),
    dispatchEvent: () => {
      dispatched += 1;
      return true;
    },
    matches: () => false,
    isContentEditable: false,
    focus: () => {},
  };
  const fn = reserialize(injected.performClick, {
    window: {},
    document: { elementFromPoint: () => target },
    PointerEvent: FakeEvent,
    MouseEvent: FakeEvent,
  });
  const res = fn(5, 6);
  assert.equal(res.clicked, true);
  assert.equal(res.element, "button#go.primary");
  assert.equal(dispatched, 5); // pointerdown, mousedown, pointerup, mouseup, click
});

test("performClick reports when there is no element at the coordinates", () => {
  const fn = reserialize(injected.performClick, {
    window: {},
    document: { elementFromPoint: () => null },
    PointerEvent: FakeEvent,
    MouseEvent: FakeEvent,
  });
  assert.equal(fn(1, 1).clicked, false);
});

test("extractPageText truncates in-page and reports the original length", () => {
  // Compare fields (objects come from another realm, so no deepEqual).
  const fn = (globals) => reserialize(injected.extractPageText, globals);
  const ctx = { document: { body: { innerText: "Hello World" } } };
  const t = fn(ctx)(5);
  assert.equal(t.text, "Hello");
  assert.equal(t.truncated, true);
  assert.equal(t.length, 11);
  const u = fn(ctx)(null);
  assert.equal(u.text, "Hello World");
  assert.equal(u.truncated, false);
  assert.equal(u.length, 11);
});

test("viewportSize is self-contained and returns device-pixel dimensions", () => {
  const fn = reserialize(injected.viewportSize, {
    window: { innerWidth: 800, innerHeight: 600, devicePixelRatio: 2 },
  });
  const r = fn();
  assert.equal(r.w, 1600);
  assert.equal(r.h, 1200);
});

test("runUserCode is self-contained and evaluates the code string", () => {
  const fn = reserialize(injected.runUserCode, {});
  assert.equal(fn("40 + 2"), 42);
  const obj = fn("({ a: 1, b: 2 })");
  assert.equal(obj.a, 1);
  assert.equal(obj.b, 2);
});

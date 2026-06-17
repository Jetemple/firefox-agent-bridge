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
    "tools/press-key.js",
    "tools/scroll.js",
    "tools/hover.js",
    "tools/double-click.js",
    "tools/right-click.js",
    "tools/drag.js",
    "tools/select-option.js",
    "tools/set-checkbox.js",
    "tools/find-element.js",
    "tools/get-links.js",
    "tools/get-tables.js",
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

// --- group B: injected interaction tools ------------------------------------

test("performPressKey dispatches keydown/keyup on the active element with modifiers", () => {
  const events = [];
  const el = { tagName: "INPUT", id: "q", classList: { length: 0 }, dispatchEvent: (e) => events.push(e) };
  const fn = reserialize(injected.performPressKey, {
    document: { activeElement: el, body: {} },
    KeyboardEvent: FakeEvent,
  });
  const res = fn("Enter", { ctrl: true });
  assert.equal(res.pressed, true);
  assert.equal(res.key, "Enter");
  assert.deepEqual(events.map((e) => e.type), ["keydown", "keyup"]); // multi-char key → no keypress
  assert.equal(events[0].ctrlKey, true);
});

test("performPressKey emits keypress for a single printable character", () => {
  const events = [];
  const el = { tagName: "INPUT", id: "", classList: { length: 0 }, dispatchEvent: (e) => events.push(e) };
  const fn = reserialize(injected.performPressKey, {
    document: { activeElement: el, body: {} },
    KeyboardEvent: FakeEvent,
  });
  fn("a", {});
  assert.deepEqual(events.map((e) => e.type), ["keydown", "keypress", "keyup"]);
});

test("performScroll scrolls the window by a delta", () => {
  let by = null;
  const fn = reserialize(injected.performScroll, {
    window: { scrollX: 0, scrollY: 500, scrollBy: (x, y) => (by = [x, y]) },
  });
  const res = fn(0, 500, null);
  assert.deepEqual(by, [0, 500]);
  assert.equal(res.scrolled, true);
  assert.equal(res.y, 500);
});

test("performScroll scrolls an element into view when given a selector", () => {
  let scrolled = null;
  const el = { scrollIntoView: () => (scrolled = true) };
  const fn = reserialize(injected.performScroll, {
    window: { scrollX: 0, scrollY: 0 },
    document: { querySelector: (s) => (s === "#target" ? el : null) },
  });
  const res = fn(0, 0, "#target");
  assert.equal(scrolled, true);
  assert.equal(res.into, "#target");
});

test("performHover dispatches mouseover at the element under the point", () => {
  const events = [];
  const target = { tagName: "A", id: "lnk", classList: { length: 0 }, dispatchEvent: (e) => events.push(e.type) };
  const fn = reserialize(injected.performHover, {
    document: { elementFromPoint: () => target },
    PointerEvent: FakeEvent,
    MouseEvent: FakeEvent,
  });
  const res = fn(10, 20);
  assert.equal(res.hovered, true);
  assert.equal(res.element, "a#lnk");
  assert.ok(events.includes("mouseover"));
});

test("performHover reports when nothing is at the coordinates", () => {
  const fn = reserialize(injected.performHover, {
    document: { elementFromPoint: () => null },
    PointerEvent: FakeEvent,
    MouseEvent: FakeEvent,
  });
  assert.equal(fn(1, 1).hovered, false);
});

test("performDoubleClick fires two click sequences and a dblclick", () => {
  const events = [];
  const target = { tagName: "BUTTON", id: "", classList: { length: 0 }, dispatchEvent: (e) => events.push(e.type) };
  const fn = reserialize(injected.performDoubleClick, {
    document: { elementFromPoint: () => target },
    PointerEvent: FakeEvent,
    MouseEvent: FakeEvent,
  });
  const res = fn(5, 6);
  assert.equal(res.doubleClicked, true);
  assert.equal(events.filter((t) => t === "click").length, 2);
  assert.equal(events.filter((t) => t === "dblclick").length, 1);
});

test("performRightClick dispatches a contextmenu with button 2", () => {
  const events = [];
  const target = { tagName: "DIV", id: "", classList: { length: 0 }, dispatchEvent: (e) => events.push(e) };
  const fn = reserialize(injected.performRightClick, {
    document: { elementFromPoint: () => target },
    PointerEvent: FakeEvent,
    MouseEvent: FakeEvent,
  });
  const res = fn(3, 4);
  assert.equal(res.rightClicked, true);
  const ctx = events.find((e) => e.type === "contextmenu");
  assert.ok(ctx);
  assert.equal(ctx.button, 2);
});

test("performDrag presses at the source and releases at the destination", () => {
  const events = [];
  const from = { tagName: "DIV", id: "a", classList: { length: 0 }, dispatchEvent: (e) => events.push(["from", e.type, e.clientX, e.clientY]) };
  const to = { tagName: "DIV", id: "b", classList: { length: 0 }, dispatchEvent: (e) => events.push(["to", e.type, e.clientX, e.clientY]) };
  const fn = reserialize(injected.performDrag, {
    document: { elementFromPoint: (x) => (x === 0 ? from : to) },
    PointerEvent: FakeEvent,
    MouseEvent: FakeEvent,
  });
  const res = fn(0, 0, 100, 200);
  assert.equal(res.dragged, true);
  assert.equal(res.from, "div#a");
  assert.equal(res.to, "div#b");
  assert.ok(events.some(([who, type]) => who === "from" && type === "mousedown"));
  assert.ok(events.some(([who, type, cx, cy]) => who === "to" && type === "mouseup" && cx === 100 && cy === 200));
});

test("performSelectOption sets a <select> value by option value", () => {
  const events = [];
  const select = {
    tagName: "SELECT",
    id: "s",
    classList: { length: 0 },
    options: [{ value: "a", textContent: "Apple" }, { value: "b", textContent: "Banana" }],
    value: "a",
    dispatchEvent: (e) => events.push(e.type),
  };
  const fn = reserialize(injected.performSelectOption, {
    document: { querySelector: () => select },
    Event: FakeEvent,
  });
  const res = fn("#s", "b", null);
  assert.equal(res.selected, true);
  assert.equal(select.value, "b");
  assert.ok(events.includes("change"));
});

test("performSelectOption matches by visible label when value is omitted", () => {
  const select = {
    tagName: "SELECT",
    id: "",
    classList: { length: 0 },
    options: [{ value: "1", textContent: "One" }, { value: "2", textContent: "Two" }],
    value: "1",
    dispatchEvent: () => {},
  };
  const fn = reserialize(injected.performSelectOption, {
    document: { querySelector: () => select },
    Event: FakeEvent,
  });
  assert.equal(fn("#s", null, "Two").value, "2");
});

test("performSelectOption refuses a non-select element", () => {
  const div = { tagName: "DIV", id: "", classList: { length: 0 } };
  const fn = reserialize(injected.performSelectOption, {
    document: { querySelector: () => div },
    Event: FakeEvent,
  });
  assert.equal(fn("#x", "a", null).selected, false);
});

test("performSetCheckbox checks an unchecked box and fires change", () => {
  const events = [];
  const box = { type: "checkbox", tagName: "INPUT", id: "c", classList: { length: 0 }, checked: false, dispatchEvent: (e) => events.push(e.type) };
  const fn = reserialize(injected.performSetCheckbox, {
    document: { querySelector: () => box },
    Event: FakeEvent,
  });
  const res = fn("#c", true);
  assert.equal(res.set, true);
  assert.equal(box.checked, true);
  assert.ok(events.includes("change"));
});

test("performSetCheckbox is a no-op when already in the desired state", () => {
  const events = [];
  const box = { type: "checkbox", tagName: "INPUT", id: "", classList: { length: 0 }, checked: true, dispatchEvent: (e) => events.push(e.type) };
  const fn = reserialize(injected.performSetCheckbox, {
    document: { querySelector: () => box },
    Event: FakeEvent,
  });
  fn("#c", true);
  assert.deepEqual(events, []);
});

test("performSetCheckbox refuses a non-checkbox element", () => {
  const txt = { type: "text", tagName: "INPUT", id: "", classList: { length: 0 } };
  const fn = reserialize(injected.performSetCheckbox, {
    document: { querySelector: () => txt },
    Event: FakeEvent,
  });
  assert.equal(fn("#t", true).set, false);
});

// --- group C: injected query tools ------------------------------------------

// Injected functions return objects from the vm realm; normalize before deep
// comparison (primitive field reads are fine as-is).
const plain = (v) => JSON.parse(JSON.stringify(v));

test("findElement locates the first visible text match and returns center coords", () => {
  const make = (tag, txt, rect) => ({
    tagName: tag,
    id: "",
    classList: { length: 0 },
    innerText: txt,
    getBoundingClientRect: () => rect,
  });
  const a = make("A", "Sign up", { left: 10, top: 20, width: 100, height: 40 });
  const b = make("BUTTON", "Log in", { left: 0, top: 0, width: 50, height: 20 });
  const fn = reserialize(injected.findElement, {
    document: { querySelectorAll: () => [a, b] },
  });
  const res = fn("sign up", null);
  assert.equal(res.found, true);
  assert.equal(res.element, "a");
  assert.equal(res.x, 60); // 10 + 100/2
  assert.equal(res.y, 40); // 20 + 40/2
  assert.equal(res.count, 1);
});

test("findElement reports not found when nothing matches", () => {
  const fn = reserialize(injected.findElement, { document: { querySelectorAll: () => [] } });
  assert.equal(fn("nope", null).found, false);
});

test("getLinks returns anchor text and href, honoring max", () => {
  const mk = (t, h) => ({ innerText: t, textContent: t, href: h });
  const anchors = [mk("Home", "https://x/"), mk("Docs", "https://x/docs"), mk("API", "https://x/api")];
  const fn = reserialize(injected.getLinks, { document: { querySelectorAll: () => anchors } });
  const res = fn(2);
  assert.equal(res.links.length, 2);
  assert.deepEqual(plain(res.links[0]), { text: "Home", href: "https://x/" });
  assert.equal(res.count, 3);
  assert.equal(res.truncated, true);
});

test("getTables extracts rows of cell text", () => {
  const cell = (t) => ({ innerText: t, textContent: t });
  const row = (cells) => ({ querySelectorAll: () => cells.map(cell) });
  const table = { querySelectorAll: (sel) => (sel === "tr" ? [row(["A", "B"]), row(["1", "2"])] : []) };
  const fn = reserialize(injected.getTables, {
    document: { querySelectorAll: (sel) => (sel === "table" ? [table] : []) },
  });
  const res = fn(null);
  assert.equal(res.count, 1);
  assert.deepEqual(plain(res.tables[0]), [["A", "B"], ["1", "2"]]);
});

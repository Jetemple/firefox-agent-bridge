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
    "tools/pointer.js",
    "tools/get-page-text.js",
    "tools/screenshot.js",
    "tools/javascript-tool.js",
    "tools/press-key.js",
    "tools/scroll.js",
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

test("performPointer is self-contained, describes the element, and dispatches", () => {
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
  const fn = reserialize(injected.performPointer, {
    window: {},
    document: { elementFromPoint: () => target },
    PointerEvent: FakeEvent,
    MouseEvent: FakeEvent,
  });
  const res = fn("click", 5, 6);
  assert.equal(res.clicked, true);
  assert.equal(res.element, "button#go.primary");
  assert.equal(dispatched, 5); // pointerdown, mousedown, pointerup, mouseup, click
});

test("performPointer reports when there is no element at the coordinates", () => {
  const fn = reserialize(injected.performPointer, {
    window: {},
    document: { elementFromPoint: () => null },
    PointerEvent: FakeEvent,
    MouseEvent: FakeEvent,
  });
  assert.equal(fn("click", 1, 1).clicked, false);
});

test("extractPageText truncates in-page and reports the original length", () => {
  // Compare fields (objects come from another realm, so no deepEqual).
  const fn = (globals) => reserialize(injected.extractPageText, globals);
  const ctx = { document: { body: { innerText: "Hello World" }, querySelectorAll: () => [] } };
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

test("runUserCode is self-contained and evaluates the code string", async () => {
  const fn = reserialize(injected.runUserCode, {});
  assert.deepEqual(plain(await fn("40 + 2", 100)), { result: 42 });
  const { result: obj } = await fn("({ a: 1, b: 2 })", 100);
  assert.equal(obj.a, 1);
  assert.equal(obj.b, 2);
  assert.equal((await fn("Promise.resolve(7)", 100)).result, 7, "awaits promises like executeScript did");
});

test("runUserCode caps oversized results: strings sliced, non-strings as JSON text", async () => {
  const fn = reserialize(injected.runUserCode, {});
  assert.deepEqual(plain(await fn("'x'.repeat(10)", 4)), { result: "xxxx", truncated: true, length: 10 });
  assert.deepEqual(plain(await fn("[1,2,3,4,5]", 5)), { result: "[1,2,", truncated: true, length: 11 });
  // Values JSON can't serialize pass through untouched (cloning decides, as before).
  const cyclic = await fn("(() => { const o = {}; o.self = o; return o; })()", 5);
  assert.equal(cyclic.truncated, undefined);
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

test("performPointer hover dispatches mouseover at the element under the point", () => {
  const events = [];
  const target = { tagName: "A", id: "lnk", classList: { length: 0 }, dispatchEvent: (e) => events.push(e.type) };
  const fn = reserialize(injected.performPointer, {
    window: {},
    document: { elementFromPoint: () => target },
    PointerEvent: FakeEvent,
    MouseEvent: FakeEvent,
  });
  const res = fn("hover", 10, 20);
  assert.equal(res.hovered, true);
  assert.equal(res.element, "a#lnk");
  assert.ok(events.includes("mouseover"));
});

test("performPointer hover reports when nothing is at the coordinates", () => {
  const fn = reserialize(injected.performPointer, {
    window: {},
    document: { elementFromPoint: () => null },
    PointerEvent: FakeEvent,
    MouseEvent: FakeEvent,
  });
  assert.equal(fn("hover", 1, 1).hovered, false);
});

test("performPointer double_click fires two click sequences and a dblclick", () => {
  const events = [];
  const target = { tagName: "BUTTON", id: "", classList: { length: 0 }, dispatchEvent: (e) => events.push(e.type) };
  const fn = reserialize(injected.performPointer, {
    window: {},
    document: { elementFromPoint: () => target },
    PointerEvent: FakeEvent,
    MouseEvent: FakeEvent,
  });
  const res = fn("double_click", 5, 6);
  assert.equal(res.doubleClicked, true);
  assert.equal(events.filter((t) => t === "click").length, 2);
  assert.equal(events.filter((t) => t === "dblclick").length, 1);
});

test("performPointer right_click dispatches a contextmenu with button 2", () => {
  const events = [];
  const target = { tagName: "DIV", id: "", classList: { length: 0 }, dispatchEvent: (e) => events.push(e) };
  const fn = reserialize(injected.performPointer, {
    window: {},
    document: { elementFromPoint: () => target },
    PointerEvent: FakeEvent,
    MouseEvent: FakeEvent,
  });
  const res = fn("right_click", 3, 4);
  assert.equal(res.rightClicked, true);
  const ctx = events.find((e) => e.type === "contextmenu");
  assert.ok(ctx);
  assert.equal(ctx.button, 2);
});

// A fake element for hit-testing: `over` is what the point resolves to inside its
// shadow root, `parent` its light-DOM parent.
function pointerEl(tagName, extra = {}) {
  return {
    tagName,
    id: "",
    classList: { length: 0 },
    events: [],
    dispatchEvent(e) {
      this.events.push(e);
    },
    ...extra,
  };
}

function pointerFn(hit, extraGlobals = {}, documentExtra = {}) {
  return reserialize(injected.performPointer, {
    window: {},
    document: { elementFromPoint: () => hit, ...documentExtra },
    PointerEvent: FakeEvent,
    MouseEvent: FakeEvent,
    ...extraGlobals,
  });
}

test("performPointer refuses to dispatch when something covers find_element's target", () => {
  const cover = pointerEl("DIV", { id: "cover" });
  const res = pointerFn(cover)("click", 5, 6, "ref1");
  assert.equal(res.clicked, false);
  assert.equal(res.hit, "div#cover");
  assert.equal(cover.events.length, 0);
});

test("performPointer counts a hit on the target, inside it, across a shadow boundary, or on its label", () => {
  const target = pointerEl("BUTTON", { __ffRef: "r" });
  assert.equal(pointerFn(target)("click", 1, 1, "r").clicked, true);

  const child = pointerEl("SPAN", { parentNode: target });
  assert.equal(pointerFn(child)("click", 1, 1, "r").clicked, true);
  assert.equal(child.events.length, 5); // dispatched on what the point hit

  const host = pointerEl("CHAT-WIDGET", { __ffRef: "r" });
  const inShadow = pointerEl("SPAN", { parentNode: { host } });
  assert.equal(pointerFn(inShadow)("click", 1, 1, "r").clicked, true);

  const label = pointerEl("LABEL", { control: { __ffRef: "r" } });
  assert.equal(pointerFn(label)("click", 1, 1, "r").clicked, true);
});

test("performPointer ignores a stale ref's absence when no ref is given", () => {
  assert.equal(pointerFn(pointerEl("DIV"))("click", 1, 1, null).clicked, true);
});

test("performPointer hit-tests through shadow roots and sends composed events at the given point", () => {
  const inner = pointerEl("BUTTON", { id: "go" });
  const host = pointerEl("X-APP", { shadowRoot: { elementFromPoint: () => inner } });
  const res = pointerFn(host)("click", 7, 8);
  assert.equal(res.element, "button#go");
  assert.equal(host.events.length, 0);
  assert.equal(inner.events[0].composed, true);
  assert.equal(inner.events[0].clientX, 7);
  assert.equal(inner.events[0].clientY, 8);
});

test("performPointer stops at a shadow host whose root hit-tests back to itself", () => {
  const host = pointerEl("X-APP");
  host.shadowRoot = { elementFromPoint: () => host };
  assert.equal(pointerFn(host)("click", 1, 1).element, "x-app");
});

test("performPointer asks to descend when the point lands on an iframe", () => {
  const frame = pointerEl("IFRAME", {
    clientLeft: 5,
    clientTop: 5,
    getBoundingClientRect: () => ({ left: 10, top: 100 }),
  });
  const browser = { runtime: { getFrameId: (el) => (el === frame ? 42 : -1) } };
  const res = pointerFn(frame, { browser })("click", 50, 200);
  assert.equal(res.descend.frameId, 42);
  assert.deepEqual(Array.from(res.descend.args), ["click", 35, 95, null]);
  assert.equal(frame.events.length, 0);
});

test("performPointer does not descend for a ref: an iframe over the target is a miss", () => {
  const frame = pointerEl("IFRAME");
  const res = pointerFn(frame)("click", 1, 1, "r");
  assert.equal(res.clicked, false);
  assert.equal(res.hit, "iframe");
});

test("performPointer flags a background tab", () => {
  assert.equal(pointerFn(pointerEl("A"), {}, { visibilityState: "hidden" })("click", 1, 1).tabHidden, true);
  assert.equal(pointerFn(pointerEl("A"), {}, { visibilityState: "visible" })("click", 1, 1).tabHidden, undefined);
});

test("performType and performPressKey follow focus into shadow roots and iframes", () => {
  const frame = pointerEl("IFRAME");
  const browser = { runtime: { getFrameId: () => 9 } };
  const shadowed = pointerEl("X-APP", { shadowRoot: { activeElement: frame } });
  const doc = { activeElement: shadowed, body: {}, documentElement: {} };
  const type = reserialize(injected.performType, { document: doc, browser });
  assert.equal(type("hi", false).descend.frameId, 9);
  const key = reserialize(injected.performPressKey, { document: doc, browser, KeyboardEvent: FakeEvent });
  assert.equal(key("Enter", {}).descend.frameId, 9);

  // A host with no focus inside it stays the target.
  const events = [];
  const host = pointerEl("X-APP", { shadowRoot: { activeElement: null }, dispatchEvent: (e) => events.push(e.type) });
  const key2 = reserialize(injected.performPressKey, {
    document: { activeElement: host, body: {} },
    KeyboardEvent: FakeEvent,
  });
  assert.equal(key2("Enter", {}).target, "x-app");
  assert.deepEqual(events, ["keydown", "keyup"]);
});

test("extractPageText appends shadow root text and skips what isn't rendered", () => {
  const text = { nodeType: 3, textContent: "bare text" };
  const style = { nodeType: 1, checkVisibility: () => false, innerText: ".a{color:red}" };
  const para = { nodeType: 1, checkVisibility: () => true, innerText: "in shadow" };
  const nested = { shadowRoot: { childNodes: [para], querySelectorAll: () => [] } };
  const host = { shadowRoot: { childNodes: [text, style], querySelectorAll: () => [nested] } };
  const fn = reserialize(injected.extractPageText, {
    document: { body: { innerText: "light" }, querySelectorAll: () => [host] },
  });
  assert.equal(fn(null).text, "light\nbare text\nin shadow");
});

test("extractPageText skips a frame with no viewport and names the frame it read", () => {
  const document = { body: { innerText: "chat line" }, querySelectorAll: () => [] };
  const location = { href: "https://x.test/chat?token=secret#end" };
  const zero = reserialize(injected.extractPageText, { document, location, window: { innerWidth: 0, innerHeight: 0 } });
  assert.equal(zero(null, true), null);
  const sized = reserialize(injected.extractPageText, { document, location, window: { innerWidth: 300, innerHeight: 200 } });
  assert.equal(sized(null, true).url, "https://x.test/chat");
});

test("findElement searches shadow roots, matches placeholders, and tags its pick with the ref", () => {
  const input = {
    tagName: "INPUT",
    id: "",
    classList: { length: 0 },
    getAttribute: (name) => (name === "placeholder" ? "Type a message" : null),
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 10, height: 10 }),
  };
  const host = { shadowRoot: { querySelectorAll: (css) => (css === "*" ? [] : [input]) } };
  const fn = reserialize(injected.findElement, {
    document: { querySelectorAll: (css) => (css === "*" ? [host] : []) },
  });
  const res = fn("type a message", null, "tok");
  assert.equal(res.found, true);
  assert.equal(res.ref, "tok");
  assert.equal(input.__ffRef, "tok");
});

test("findElement still matches a filled field by its label", () => {
  const input = {
    tagName: "TEXTAREA",
    id: "",
    classList: { length: 0 },
    value: "already typed",
    getAttribute: (name) => (name === "aria-label" ? "Message" : null),
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 10, height: 10 }),
  };
  const fn = reserialize(injected.findElement, {
    document: { querySelectorAll: (css) => (css === "*" ? [] : [input]) },
  });
  assert.equal(fn("message", null).found, true);
  assert.equal(fn("already", null).found, true);
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

test("findElement never returns a hidden match, and caps the echoed query", () => {
  const hidden = {
    tagName: "BUTTON",
    id: "",
    classList: { length: 0 },
    innerText: "Delete",
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 0, height: 0 }),
  };
  const fn = reserialize(injected.findElement, { document: { querySelectorAll: () => [hidden] } });
  const res = fn("delete", null);
  assert.equal(res.found, false);
  assert.equal(res.hidden, 1);
  assert.equal(fn("q".repeat(5000), null).text.length, 120);
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

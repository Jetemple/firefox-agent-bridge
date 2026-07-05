// Regression test for background-script loading.
//
// MV3 `background.scripts` load as classic scripts that SHARE one top-level
// lexical scope. A top-level `const`/`let` declared in two of them throws
// "redeclaration" and aborts the later script on load — which silently breaks
// the whole extension (e.g. the onMessage listener never registers, and the
// popup gets "Could not establish connection. Receiving end does not exist.").
//
// Concatenating the scripts reproduces that shared scope, so this test catches
// the bug class. web-ext lint does NOT (it lints files independently).
import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { WS_TOOL_NAMES } from "../firefox-mcp-bridge/tools.mjs";

const EXT = resolve(dirname(fileURLToPath(import.meta.url)), "../firefox-extension");

function backgroundScripts() {
  const manifest = JSON.parse(readFileSync(resolve(EXT, "manifest.json"), "utf8"));
  return manifest.background.scripts;
}

function concatenatedSource() {
  return backgroundScripts()
    .map((s) => readFileSync(resolve(EXT, s), "utf8"))
    .join("\n;\n");
}

test("background scripts parse together with no top-level redeclaration", () => {
  assert.doesNotThrow(
    () => new vm.Script(concatenatedSource()),
    "background.scripts share one lexical scope; a top-level const/let collision aborts loading",
  );
});

test("background scripts fully load: every WS tool handler + onMessage listener register", () => {
  const sandbox = {
    WebSocket: class {
      constructor(url) {
        this.url = url;
        this.readyState = 0;
      }
      addEventListener() {}
      close() {}
      send() {}
    },
    setTimeout: () => 0,
    clearTimeout: () => {},
    console,
    crypto: { randomUUID: () => "test-run-id" },
    browser: {
      runtime: {
        onStartup: { addListener() {} },
        onInstalled: { addListener() {} },
        onMessage: {
          addListener(fn) {
            sandbox.__onMessage = fn;
          },
        },
        sendMessage: () => Promise.resolve(),
        getManifest: () => ({ version: "0.0-test" }),
      },
      alarms: { create() {}, onAlarm: { addListener() {} } },
      storage: { local: { set: () => Promise.resolve(), get: () => Promise.resolve({}) } },
      tabs: {},
      windows: {},
      scripting: {},
    },
  };
  sandbox.WebSocket.OPEN = 1;
  sandbox.WebSocket.CONNECTING = 0;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);

  assert.doesNotThrow(() => vm.runInContext(concatenatedSource(), sandbox), "background load must not throw");

  // The extension must implement exactly the tools the bridge dispatches over
  // MCP, plus set_profile_name — a bridge-only management tool (see Task 2)
  // that the relay calls directly and that is never listed for MCP clients.
  assert.deepEqual(
    Object.keys(sandbox.FFBridge.tools).sort(),
    [...WS_TOOL_NAMES, "set_profile_name"].sort(),
  );
  assert.equal(typeof sandbox.__onMessage, "function", "onMessage listener must register");
});

test("the popup status request gets a response (no 'receiving end does not exist')", async () => {
  // Minimal re-load to grab the registered onMessage handler, then call it.
  const sandbox = {
    WebSocket: class {
      constructor(url) {
        this.url = url;
        this.readyState = 0;
      }
      addEventListener() {}
      close() {}
      send() {}
    },
    setTimeout: () => 0,
    clearTimeout: () => {},
    console,
    crypto: { randomUUID: () => "test-run-id" },
    browser: {
      runtime: {
        onStartup: { addListener() {} },
        onInstalled: { addListener() {} },
        onMessage: {
          addListener(fn) {
            sandbox.__onMessage = fn;
          },
        },
        sendMessage: () => Promise.resolve(),
        getManifest: () => ({ version: "0.0-test" }),
      },
      alarms: { create() {}, onAlarm: { addListener() {} } },
      storage: { local: { set: () => Promise.resolve(), get: () => Promise.resolve({}) } },
      tabs: {},
      windows: {},
      scripting: {},
    },
  };
  sandbox.WebSocket.OPEN = 1;
  sandbox.WebSocket.CONNECTING = 0;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(concatenatedSource(), sandbox);

  const status = await Promise.resolve(sandbox.__onMessage({ type: "GET_BRIDGE_STATUS" }));
  assert.ok(status, "GET_BRIDGE_STATUS must return a status object, not undefined");
  assert.equal(typeof status.state, "string");
});

// WebSocket client + tool dispatcher for the Claude Firefox Bridge.
//
// Connects to the owned MCP bridge on ws://127.0.0.1:3002, receives
// {id, tool, args} requests, executes them with browser.* APIs, and replies
// {id, result} or {id, error:{code,message}}.

// `var`, not `const`: background.scripts share one top-level lexical scope and
// restricted.js also binds FF, so `const` would throw "redeclaration of const
// FF" and abort this script on load (which silently breaks the whole extension:
// the onMessage listener below never registers).
var FF = (globalThis.FFBridge ??= {});
FF.tools ??= {};

const WS_URL = "ws://127.0.0.1:3002";
const MIN_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 5000;

let socket = null;
let backoffMs = MIN_BACKOFF_MS;
let reconnectTimer = null;
let status = { state: "disconnected", message: "Not connected", updatedAt: new Date().toISOString() };

// --- status (persisted for the panel) ------------------------------------

async function setStatus(next) {
  status = { ...next, updatedAt: new Date().toISOString() };
  try {
    await browser.storage.local.set({ bridgeStatus: status });
  } catch {
    /* storage best-effort */
  }
  browser.runtime.sendMessage({ type: "BRIDGE_STATUS", status }).catch(() => {});
}

// --- error helpers --------------------------------------------------------

function bridgeError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}
FF.bridgeError = bridgeError;

function toWireError(err) {
  if (err && err.code) return { code: err.code, message: err.message ?? String(err) };
  return { code: "INTERNAL", message: err instanceof Error ? err.message : String(err) };
}

// --- script injection helper ---------------------------------------------

// Runs `func(...args)` in the page and returns its single result, mapping any
// failure to SCRIPT_FAILED. `world` is "ISOLATED" (default) or "MAIN".
FF.inject = async function inject(tabId, func, args = [], world) {
  let results;
  try {
    results = await browser.scripting.executeScript({
      target: { tabId },
      func,
      args,
      ...(world ? { world } : {}),
    });
  } catch (e) {
    throw bridgeError("SCRIPT_FAILED", `executeScript failed: ${e?.message ?? e}`);
  }
  const first = results?.[0];
  if (!first) throw bridgeError("SCRIPT_FAILED", "executeScript returned no result");
  if (first.error) throw bridgeError("SCRIPT_FAILED", String(first.error));
  return first.result;
};

// --- tab resolution + dispatch -------------------------------------------

async function resolveTab(tabId) {
  if (tabId != null) {
    try {
      return await browser.tabs.get(tabId);
    } catch {
      // An explicitly supplied id must never silently become the active tab —
      // a stale id + close_tab would destroy whatever the user is looking at.
      throw bridgeError("TAB_NOT_FOUND", `Tab ${tabId} not found — call get_tabs_summary for fresh ids`);
    }
  }
  const [active] = await browser.tabs.query({ active: true, currentWindow: true });
  if (!active) throw bridgeError("TAB_NOT_FOUND", "No active tab");
  return active;
}
FF.resolveTab = resolveTab;

// Tools that need no tab resolution.
const NO_TAB = new Set([
  "get_tabs_summary",
  "navigate",
  "close_tab",
  "activate_tab",
  "reload",
  "back",
  "forward",
]);
// Tools that need the resolved tab (for windowId/activation) but are allowed on
// restricted URLs (captureVisibleTab does not inject script).
const SKIP_RESTRICTED = new Set(["screenshot"]);

async function runTool(tool, args) {
  const handler = FF.tools[tool];
  if (typeof handler !== "function") throw bridgeError("UNKNOWN_TOOL", `Unknown tool: ${tool}`);

  if (NO_TAB.has(tool)) return handler(args);

  const tab = await resolveTab(args.tabId);
  if (!SKIP_RESTRICTED.has(tool) && FF.isRestricted(tab.url)) {
    throw bridgeError("RESTRICTED_URL", `Tab URL is restricted: ${tab.url}`);
  }
  return handler(args, tab);
}

// --- WebSocket wiring ------------------------------------------------------

function send(obj) {
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(obj));
  }
}

async function handleMessage(data) {
  let msg;
  try {
    // Bridge sends text frames; tolerate a Blob defensively.
    const text = typeof data === "string" ? data : await data.text();
    msg = JSON.parse(text);
  } catch {
    return; // not JSON — ignore
  }
  const { id, tool, args } = msg ?? {};
  if (id == null || !tool) return;
  try {
    const result = await runTool(tool, args ?? {});
    send({ id, result });
  } catch (err) {
    send({ id, error: toWireError(err) });
  }
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  const base = Math.min(MAX_BACKOFF_MS, backoffMs);
  const jitter = base * 0.2 * (Math.random() * 2 - 1); // +/-20%
  const delay = Math.max(MIN_BACKOFF_MS, Math.round(base + jitter));
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, delay);
  backoffMs = Math.min(MAX_BACKOFF_MS, backoffMs * 2);
}

function connect() {
  if (socket && (socket.readyState === WebSocket.CONNECTING || socket.readyState === WebSocket.OPEN)) {
    return;
  }

  let ws;
  try {
    ws = new WebSocket(WS_URL);
  } catch {
    scheduleReconnect();
    return;
  }

  // Regression guard: default MV3 CSP would upgrade ws:// to wss:// via
  // upgrade-insecure-requests. The manifest drops that directive; verify it.
  if (!ws.url.startsWith("ws://")) {
    setStatus({
      state: "error",
      message: `Connection upgraded to ${ws.url}. Remove upgrade-insecure-requests from manifest CSP.`,
    });
    try {
      ws.close();
    } catch {
      /* ignore */
    }
    scheduleReconnect();
    return;
  }

  socket = ws;

  ws.addEventListener("open", () => {
    backoffMs = MIN_BACKOFF_MS;
    setStatus({ state: "connected", message: `Connected to ${WS_URL}` });
  });

  ws.addEventListener("message", (event) => {
    handleMessage(event.data);
  });

  ws.addEventListener("close", () => {
    if (socket === ws) socket = null;
    setStatus({ state: "disconnected", message: "Bridge connection closed; reconnecting" });
    scheduleReconnect();
  });

  ws.addEventListener("error", () => {
    // 'error' is always followed by 'close'; let close drive the reconnect.
    setStatus({ state: "error", message: "WebSocket error (is the bridge running?)" });
  });
}

// --- lifecycle -------------------------------------------------------------

browser.runtime.onStartup.addListener(() => connect());
browser.runtime.onInstalled.addListener(() => connect());

browser.runtime.onMessage.addListener((message) => {
  if (message?.type === "GET_BRIDGE_STATUS") {
    return Promise.resolve(status);
  }
  return undefined;
});

// Keepalive: Firefox MV3 non-persistent event pages suspend after idle,
// dropping the socket. A periodic alarm reliably wakes the page and
// reconnects if the socket is down.
const KEEPALIVE_ALARM = "ff-bridge-keepalive";
browser.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 0.25 });
browser.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === KEEPALIVE_ALARM) connect();
});

// Connect on background (event-page) load / wake.
connect();

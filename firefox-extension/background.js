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

// Identity for the multiplexing relay. runId is per background-script
// lifetime (in memory only): a Firefox restart or extension reload issues a
// new one, which the bridge uses to fail sessions safe instead of acting on
// reissued tab ids.
const runId = crypto.randomUUID();
let profileName = null;
let profileNameLoaded = null;

function loadProfileName() {
  profileNameLoaded ??= browser.storage.local
    .get("profileName")
    .then((r) => {
      profileName = typeof r?.profileName === "string" ? r.profileName : null;
    })
    .catch(() => {});
  return profileNameLoaded;
}

async function sendHello() {
  await loadProfileName();
  send({
    type: "hello",
    profileName,
    runId,
    version: browser.runtime.getManifest().version,
  });
}

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

// --- tab marker ----------------------------------------------------------

// Injected into the page: strip any existing marker, then prepend the fresh
// prefix. Self-contained — runs in page scope with no access to FF, so the
// format is passed in as pre-computed strings from marker.js (single source of
// truth). The `!==` guard makes the write a no-op when already stamped, so the
// onUpdated event it triggers doesn't loop.
FF.pageStamp = function pageStamp(regexSource, prefix) {
  const bare = (document.title || "").replace(new RegExp(regexSource), "");
  const next = prefix + bare;
  if (document.title !== next) document.title = next;
};

// Re-apply the stamp whenever a marked tab finishes loading or changes its
// title (SPA route changes, late document.title writes). Restricted / unknown
// URLs are skipped (isRestricted(undefined) === true) — a later event with a
// real URL restamps. Injection failures are swallowed: a transient about:blank
// mid-load resolves on the next event.
FF.onTabUpdated = async function onTabUpdated(tabId, changeInfo, tab) {
  if (!FF.markedTabs.has(tabId)) return;
  if (changeInfo.title === undefined && changeInfo.status !== "complete") return;
  if (FF.isRestricted(tab && tab.url)) return;
  const label = FF.markedTabs.get(tabId);
  try {
    await FF.inject(tabId, FF.pageStamp, [FF.markerRegexSource(), FF.markerPrefix(label)]);
  } catch {
    /* transient (tab still loading, gone) — next onUpdated retries */
  }
};

FF.onTabRemoved = function onTabRemoved(tabId) {
  FF.markedTabs.delete(tabId);
};

// `?.` so test sandboxes that stub browser.tabs without event hubs still load.
browser.tabs.onUpdated?.addListener((tabId, changeInfo, tab) => FF.onTabUpdated(tabId, changeInfo, tab));
browser.tabs.onRemoved?.addListener((tabId) => FF.onTabRemoved(tabId));

// --- tab resolution + dispatch -------------------------------------------

// The agent's own tab: what `navigate` drives when no tabId is given, and what
// every un-targeted tool acts on, so an agent works in a background tab instead
// of whatever the user is looking at. In-memory (persistent background page);
// an extension reload or Firefox restart forgets it. Deliberately NOT cleared
// when the tab closes — see resolveTab.
FF.agentTabId ??= null;

async function activeTab() {
  const [active] = await browser.tabs.query({ active: true, currentWindow: true });
  if (!active) throw bridgeError("TAB_NOT_FOUND", "No active tab");
  return active;
}

// tabId: a number (explicit), "active" (the tab the user is viewing), or
// omitted (the agent tab; the active tab only before the first navigate).
async function resolveTab(tabId) {
  if (tabId === "active") return activeTab();
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

const PROFILE_NAME_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;

// Management tool (bridge-only; not in the MCP tool list): names this profile
// for the multiplexing relay. Hello is re-sent BEFORE the reply so the relay
// has re-keyed by the time the caller sees success.
FF.tools.set_profile_name = async (args) => {
  const name = String(args?.name ?? "");
  if (name === "default" || !PROFILE_NAME_RE.test(name)) {
    throw bridgeError("BAD_NAME", `profile name must match ${PROFILE_NAME_RE} ("default" is reserved)`);
  }
  await browser.storage.local.set({ profileName: name });
  profileName = name;
  await sendHello();
  return { ok: true, name };
};

// Tools that need no tab resolution.
const NO_TAB = new Set([
  "get_tabs_summary",
  "navigate",
  "close_tab",
  "activate_tab",
  "reload",
  "back",
  "forward",
  "set_profile_name",
  "open_tab",
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

  ws.addEventListener("open", async () => {
    backoffMs = MIN_BACKOFF_MS;
    await sendHello(); // must be the first frame: the relay keys this connection off it
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

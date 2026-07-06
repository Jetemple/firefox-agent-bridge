import { WebSocketServer, WebSocket } from "ws";
import { randomUUID } from "node:crypto";

export const DEFAULT_PORT = 3002;
export const DEFAULT_HOST = "127.0.0.1";
export const DEFAULT_TIMEOUT_MS = 15000;
export const HELLO_GRACE_MS = 2000;
const PROFILE_NAME_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;

// The relay binds loopback, but a browser still lets web pages open
// ws://127.0.0.1:3002. A page always presents an http(s)/ws(s)/ftp Origin;
// reject those so a malicious site can't hijack the relay (displace the real
// extension and feed the model fabricated page data). The Firefox extension
// connects from a moz-extension:// origin (or none), so it is unaffected.
export function isAllowedWsOrigin(origin) {
  if (!origin) return true;
  if (/^(https?|wss?|ftp):\/\//i.test(origin)) return false;
  return true;
}

// createRelay starts a WebSocket server bound to host:port and relays MCP tool
// calls to Firefox extension clients, multiplexed by profile name. Each
// extension connection announces itself with a `hello` control frame
// ({ type: "hello", profileName, runId, version }); until it does (or the
// grace period expires), the connection is unclassified and not routable.
// Within a profile name, the newest connection wins — the previous one is
// drained so its in-flight requests reject immediately instead of hanging.
//
// Returns:
//   dispatch(tool, args, { timeoutMs?, profile? }) -> Promise<result>
//                                               (rejects with { code, message })
//   profiles() -> Array<{ name, runId, connectedAt }>  (open, classified connections)
//   clientCount() -> number                    (open, classified connections)
//   ready: Promise<{ port }>                   (resolves once listening)
//   port: number | undefined                   (actual bound port)
//   close() -> Promise<void>                   (rejects pending, terminates sockets)
export function createRelay({
  port = DEFAULT_PORT,
  host = DEFAULT_HOST,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  allowAnyOrigin = false,
  helloGraceMs = HELLO_GRACE_MS,
  WebSocketServerCtor = WebSocketServer,
  uuid = randomUUID,
  log = () => {},
} = {}) {
  const verifyClient = allowAnyOrigin
    ? undefined
    : (info) => {
        const ok = isAllowedWsOrigin(info.origin);
        if (!ok) log(`rejected WS connection from web origin: ${info.origin}`);
        return ok;
      };
  const wss = new WebSocketServerCtor({ host, port, verifyClient });
  const pending = new Map(); // id -> { resolve, reject, timer, socket }
  const connections = new Map(); // profileName -> ws (classified, may be stale until 'close')
  const perSocket = new Map(); // ws -> { profile, runId, connectedAt, graceTimer }

  const ready = new Promise((resolve, reject) => {
    wss.once("listening", () => resolve({ port: wss.address().port }));
    wss.once("error", reject);
  });

  // Durable server-level error handler. Without this, a server error that
  // arrives AFTER `listening` (the once() above is already spent) would be an
  // 'error' event with no listener, which Node throws on — crashing the bridge.
  wss.on("error", (err) => {
    log(`WebSocket server error: ${err?.message ?? err}`);
  });

  function rejectPendingForSocket(socket, code, message) {
    for (const [id, p] of pending) {
      if (p.socket === socket) {
        clearTimeout(p.timer);
        pending.delete(id);
        p.reject({ code, message });
      }
    }
  }

  function isOpen(socket) {
    return Boolean(socket) && socket.readyState === WebSocket.OPEN;
  }

  function drain(socket, reason) {
    rejectPendingForSocket(socket, "CLIENT_DISCONNECTED", reason);
    try {
      socket.close(1000, reason);
    } catch {
      /* ignore */
    }
  }

  // Classify a connection under a profile name. Called on `hello` (immediate
  // for new extensions, repeated on rename) or on grace expiry (legacy
  // extensions that never send hello -> "default"). Newest-wins only within
  // the same name: that is a reconnect. Cross-profile theft is prevented at
  // naming time by the bridge's NAME_IN_USE preflight, not here.
  function classify(ws, helloMsg) {
    const info = perSocket.get(ws);
    if (!info || ws.readyState !== WebSocket.OPEN) return;
    clearTimeout(info.graceTimer);
    const raw = helloMsg?.profileName;
    // A hello with an explicit profileName: "default" (e.g. after `ff profiles
    // name X default`) intentionally lands in the same bucket as a hello-less
    // legacy connection — "default" is the shared fallback name either way, so
    // no special-casing is needed here to tell the two apart.
    const name = typeof raw === "string" && PROFILE_NAME_RE.test(raw) ? raw : "default";
    if (info.profile && connections.get(info.profile) === ws) connections.delete(info.profile);
    const incumbent = connections.get(name);
    if (incumbent && incumbent !== ws) {
      log(`profile "${name}" reconnected — draining the previous connection`);
      drain(incumbent, `replaced by a newer "${name}" connection`);
    }
    connections.set(name, ws);
    info.profile = name;
    info.runId = typeof helloMsg?.runId === "string" ? helloMsg.runId : null;
    log(`Firefox extension connected as profile "${name}"`);
  }

  wss.on("connection", (ws) => {
    const info = { profile: null, runId: null, connectedAt: Date.now(), graceTimer: null };
    perSocket.set(ws, info);
    // Pre-hello grace: not routable, drains nobody. New extensions hello
    // immediately; legacy ones classify as "default" when the grace expires.
    info.graceTimer = setTimeout(() => classify(ws, null), helloGraceMs);
    info.graceTimer.unref?.();

    ws.on("message", (data) => {
      let msg;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return; // not JSON — ignore
      }
      if (msg?.type === "hello") {
        classify(ws, msg);
        return;
      }
      if (msg?.type != null) return; // unknown control frame — ignore
      const p = pending.get(msg?.id);
      if (!p) return; // late, unknown, or unsolicited id
      if (p.socket !== ws) return; // response from a non-owning socket
      clearTimeout(p.timer);
      pending.delete(msg.id);
      if (msg.error) {
        p.reject({
          code: msg.error.code ?? "INTERNAL",
          message: msg.error.message ?? "Firefox extension error",
        });
      } else {
        p.resolve(msg.result);
      }
    });

    const onGone = () => {
      const meta = perSocket.get(ws);
      if (meta) {
        clearTimeout(meta.graceTimer);
        if (meta.profile && connections.get(meta.profile) === ws) {
          connections.delete(meta.profile);
          log(`Firefox extension disconnected (profile "${meta.profile}")`);
        }
        perSocket.delete(ws);
      }
      rejectPendingForSocket(ws, "CLIENT_DISCONNECTED", "Firefox extension disconnected mid-request");
    };
    ws.on("close", onGone);
    ws.on("error", onGone);
  });

  function openProfileNames() {
    return [...connections.entries()].filter(([, ws]) => isOpen(ws)).map(([name]) => name);
  }

  function clientCount() {
    return openProfileNames().length;
  }

  function profiles() {
    return openProfileNames().map((name) => {
      const info = perSocket.get(connections.get(name));
      return { name, runId: info?.runId ?? null, connectedAt: info?.connectedAt ?? 0 };
    });
  }

  function resolveSocket(profile) {
    if (profile != null) {
      const s = connections.get(profile);
      if (isOpen(s)) return { socket: s };
      const names = openProfileNames();
      return {
        error: {
          code: "PROFILE_NOT_CONNECTED",
          message: `profile "${profile}" is not connected (connected: ${names.join(", ") || "none"})`,
        },
      };
    }
    const open = openProfileNames();
    if (open.length === 0) {
      return { error: { code: "NO_CLIENT", message: "No Firefox extension connected" } };
    }
    if (open.length > 1) {
      return {
        error: {
          code: "PROFILE_REQUIRED",
          message: `multiple Firefox profiles connected (${open.join(", ")}) — specify --profile or use a session`,
        },
      };
    }
    return { socket: connections.get(open[0]) };
  }

  function dispatch(tool, args, { timeoutMs: callTimeoutMs = timeoutMs, profile } = {}) {
    const resolved = resolveSocket(profile);
    if (resolved.error) return Promise.reject(resolved.error);
    const socket = resolved.socket;
    const id = uuid();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject({ code: "WS_TIMEOUT", message: `Tool '${tool}' timed out after ${callTimeoutMs}ms` });
      }, callTimeoutMs);
      pending.set(id, { resolve, reject, timer, socket });
      socket.send(JSON.stringify({ id, tool, args: args ?? {} }));
    });
  }

  function close() {
    for (const [id, p] of pending) {
      clearTimeout(p.timer);
      pending.delete(id);
      p.reject({ code: "INTERNAL", message: "Bridge shutting down" });
    }
    return new Promise((resolve) => {
      for (const ws of wss.clients) {
        try {
          ws.terminate();
        } catch {
          /* ignore */
        }
      }
      wss.close(() => resolve());
    });
  }

  return {
    dispatch,
    clientCount,
    profiles,
    close,
    ready,
    get port() {
      return wss.address()?.port;
    },
  };
}

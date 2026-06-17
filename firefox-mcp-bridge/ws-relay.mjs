import { WebSocketServer, WebSocket } from "ws";
import { randomUUID } from "node:crypto";

export const DEFAULT_PORT = 3002;
export const DEFAULT_HOST = "127.0.0.1";
export const DEFAULT_TIMEOUT_MS = 15000;

// createRelay starts a WebSocket server bound to host:port and relays MCP tool
// calls to the most-recently-connected Firefox extension client.
//
// Returns:
//   dispatch(tool, args) -> Promise<result>   (rejects with { code, message })
//   clientCount() -> 0 | 1
//   ready: Promise<{ port }>                   (resolves once listening)
//   port: number | undefined                   (actual bound port)
//   close() -> Promise<void>                   (rejects pending, terminates sockets)
export function createRelay({
  port = DEFAULT_PORT,
  host = DEFAULT_HOST,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  WebSocketServerCtor = WebSocketServer,
  uuid = randomUUID,
  log = () => {},
} = {}) {
  const wss = new WebSocketServerCtor({ host, port });
  const pending = new Map(); // id -> { resolve, reject, timer, socket }
  let activeClient = null;

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

  wss.on("connection", (ws) => {
    // Newest connection wins. Drain the previous client so its in-flight
    // requests reject immediately instead of hanging until WS_TIMEOUT.
    if (activeClient && activeClient !== ws) {
      rejectPendingForSocket(
        activeClient,
        "CLIENT_DISCONNECTED",
        "Replaced by a newer Firefox connection",
      );
      try {
        activeClient.close(1000, "replaced by newer connection");
      } catch {
        /* ignore */
      }
    }
    activeClient = ws;
    log(`Firefox extension connected`);

    ws.on("message", (data) => {
      let msg;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return; // not JSON — ignore
      }
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
      rejectPendingForSocket(
        ws,
        "CLIENT_DISCONNECTED",
        "Firefox extension disconnected mid-request",
      );
      if (activeClient === ws) {
        activeClient = null;
        log(`Firefox extension disconnected`);
      }
    };
    ws.on("close", onGone);
    ws.on("error", onGone);
  });

  function clientCount() {
    return isOpen(activeClient) ? 1 : 0;
  }

  function dispatch(tool, args, { timeoutMs: callTimeoutMs = timeoutMs } = {}) {
    const socket = activeClient;
    if (!isOpen(socket)) {
      return Promise.reject({ code: "NO_CLIENT", message: "No Firefox extension connected" });
    }
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
    close,
    ready,
    get port() {
      return wss.address()?.port;
    },
  };
}

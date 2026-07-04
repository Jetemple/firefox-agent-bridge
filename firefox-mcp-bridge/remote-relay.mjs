// Follower-side relays. A follower instance serves full MCP on its own stdio
// but forwards tool calls to the owner bridge over /dispatch. The
// SwitchableRelay façade is what createBridge() closes over, so promotion can
// swap RemoteRelay -> local relay without touching live MCP sessions.

export const HEALTH_POLL_MS = 10000;

export function createRemoteRelay({
  ssePort,
  sseHost = "127.0.0.1",
  token,
  fetchFn = fetch,
  pollMs = HEALTH_POLL_MS,
  onConnectionLost = () => {},
  log = () => {},
} = {}) {
  const base = `http://${sseHost}:${ssePort}`;
  let extensionConnected = false;
  let closed = false;

  async function probe() {
    try {
      const res = await fetchFn(`${base}/health`, { signal: AbortSignal.timeout(1500) });
      if (!res.ok) return null;
      const health = await res.json();
      extensionConnected = !!health.extensionConnected;
      return health;
    } catch {
      extensionConnected = false;
      if (!closed) onConnectionLost();
      return null;
    }
  }

  const timer = setInterval(probe, pollMs);
  timer.unref?.();

  async function dispatch(tool, args, { timeoutMs } = {}) {
    let res;
    try {
      res = await fetchFn(`${base}/dispatch`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({ tool, args: args ?? {}, ...(timeoutMs ? { timeoutMs } : {}) }),
      });
    } catch (err) {
      log(`owner unreachable: ${err?.message ?? err}`);
      if (!closed) onConnectionLost();
      throw { code: "OWNER_GONE", message: "bridge owner unreachable — takeover in progress, retry shortly" };
    }
    const body = await res.json().catch(() => null);
    if (!res.ok) {
      throw {
        code: body?.error?.code ?? `HTTP_${res.status}`,
        message: body?.error?.message ?? `dispatch failed with HTTP ${res.status}`,
      };
    }
    if (body?.error) throw body.error;
    if (body === null) {
      throw { code: "BAD_RESPONSE", message: "owner returned an unparseable dispatch response" };
    }
    return body.result;
  }

  return {
    dispatch,
    probe,
    clientCount: () => (extensionConnected ? 1 : 0),
    close: async () => {
      closed = true;
      clearInterval(timer);
    },
  };
}

export function createSwitchableRelay(initial) {
  let target = initial;
  return {
    dispatch: (...args) => target.dispatch(...args),
    clientCount: () => target.clientCount(),
    close: () => target.close(),
    swap(next) {
      const previous = target;
      target = next;
      return previous;
    },
    get target() {
      return target;
    },
  };
}

import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import { runCli } from "./cli.mjs";

const INDEX = resolve(dirname(fileURLToPath(import.meta.url)), "index.mjs");

// A fake Firefox extension: connects, announces itself with a `hello` control
// frame, then answers the two tools this e2e exercises. The bridge sends
// { id, tool, args }; a reply is { id, result } or { id, error }.
function fakeExtension({ wsPort, profile, runId, tabs }) {
  const sock = new WebSocket(`ws://127.0.0.1:${wsPort}`);
  sock.on("error", () => {}); // a drained/replaced socket emits 'error' on close — ignore
  sock.on("open", () =>
    sock.send(JSON.stringify({ type: "hello", profileName: profile, runId, version: "e2e" })),
  );
  sock.on("message", (data) => {
    const msg = JSON.parse(data.toString());
    const reply = (payload) => {
      if (sock.readyState === WebSocket.OPEN) sock.send(JSON.stringify({ id: msg.id, ...payload }));
    };
    if (msg.tool === "get_tabs_summary") return reply({ result: { tabs } });
    if (msg.tool === "get_page_text") {
      const known = tabs.some((t) => t.id === msg.args.tabId) || msg.args.tabId == null;
      return known
        ? reply({ result: { text: `text:${profile}:${msg.args.tabId ?? "active"}` } })
        : reply({ error: { code: "TAB_NOT_FOUND", message: `Tab ${msg.args.tabId} not found` } });
    }
    return reply({ error: { code: "UNKNOWN_TOOL", message: msg.tool } });
  });
  return sock;
}

async function waitFor(cond, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await cond();
    if (v) return v;
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 50));
  }
}

// Grab a free port by binding :0 and releasing it (same trick as
// index-singleton.test.mjs — ephemeral, hermetic, no fixed port collisions).
function freePort() {
  return new Promise((res, rej) => {
    const srv = createServer();
    srv.once("error", rej);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => res(port));
    });
  });
}

test("sessions + profiles end-to-end against a real bridge", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ff-e2e-"));
  const tokenFile = join(dir, "token");
  writeFileSync(tokenFile, "e2e-token\n", { mode: 0o600 });
  const wsPort = await freePort();
  const ssePort = await freePort();
  const env = {
    ...process.env,
    FIREFOX_BRIDGE_STANDALONE: "1",
    FIREFOX_BRIDGE_WS_PORT: String(wsPort),
    FIREFOX_BRIDGE_SSE_PORT: String(ssePort),
    FIREFOX_BRIDGE_TOKEN_FILE: tokenFile,
    FIREFOX_BRIDGE_SESSIONS_FILE: join(dir, "sessions.json"),
    // Pin autostart logs (should never fire — /health is already up) into the
    // tmpdir so the test can never touch the real ~/.firefox-mcp.
    FIREFOX_BRIDGE_LOG_DIR: dir,
  };
  const child = spawn(process.execPath, [INDEX], { env, stdio: ["ignore", "pipe", "pipe"] });
  // Drain the child's pipes: prevents the OS pipe buffer from filling (which
  // would block the bridge) and captures its logs for failure diagnostics.
  let childErr = "";
  child.stdout.on("data", () => {});
  child.stderr.on("data", (d) => (childErr += d));

  const sockets = [];
  try {
    await waitFor(async () => {
      try {
        const res = await fetch(`http://127.0.0.1:${ssePort}/health`);
        return res.ok;
      } catch {
        return false;
      }
    });

    const workTabs = [{ id: 42, url: "https://work.example", title: "W", active: true }];
    let work = fakeExtension({ wsPort, profile: "work", runId: "run-A", tabs: workTabs });
    const personal = fakeExtension({
      wsPort,
      profile: "personal",
      runId: "run-B",
      tabs: [{ id: 7, url: "https://me.example", title: "P", active: true }],
    });
    sockets.push(work, personal);
    // /health.extensionConnected counts CLASSIFIED connections; both fakes hello
    // immediately, but the sockets connect async — poll until both are up.
    await waitFor(async () => {
      const health = await (await fetch(`http://127.0.0.1:${ssePort}/health`)).json();
      return health.extensionConnected;
    });

    // ff runs against the e2e bridge via env overrides; fresh out/err each call.
    async function ff(...argv) {
      const out = [];
      const err = [];
      const code = await runCli(argv, {
        env,
        stdout: (s) => out.push(s),
        stderr: (s) => err.push(s),
      });
      return { code, out: out.join(""), err: err.join("") };
    }

    let r = await ff("profiles");
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /work/);
    assert.match(r.out, /personal/);

    r = await ff("text");
    assert.equal(r.code, 1);
    assert.match(r.err, /PROFILE_REQUIRED/);

    r = await ff("text", "--profile", "work");
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /text:work:active/);

    r = await ff("bind", "research", "--tab", "42", "--profile", "work");
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /research → tab 42/);

    r = await ff("-s", "research", "text");
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /text:work:42/, "session injected tab 42 and routed to work");

    // Firefox "restart": same profile reconnects with a new runId.
    work.close();
    work = fakeExtension({ wsPort, profile: "work", runId: "run-A2", tabs: workTabs });
    sockets.push(work);
    // Wait for the NEW runId specifically — matching on the name alone could
    // race the old connection's close and dispatch into a dying socket.
    await waitFor(async () => {
      const p = await ff("--json", "profiles");
      return p.code === 0 && p.out.includes("run-A2");
    });

    r = await ff("-s", "research", "text");
    assert.equal(r.code, 1);
    assert.match(r.err, /SESSION_STALE/);

    r = await ff("bind", "research", "--tab", "42", "--profile", "work");
    assert.equal(r.code, 0, r.err);
    r = await ff("-s", "research", "text");
    assert.equal(r.code, 0, `rebinding revives the session (stderr: ${r.err}; bridge: ${childErr})`);
    assert.match(r.out, /text:work:42/);
  } finally {
    for (const s of sockets) {
      try {
        s.close();
      } catch {
        /* ignore */
      }
    }
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      await Promise.race([
        new Promise((r) => child.once("exit", r)),
        new Promise((r) => setTimeout(r, 8000)),
      ]);
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

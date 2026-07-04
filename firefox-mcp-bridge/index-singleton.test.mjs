import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { inspectPortHolders, isBridgeCommand, killStaleBridge, probeBridgeHealth } from "./index.mjs";

const INDEX = resolve(dirname(fileURLToPath(import.meta.url)), "index.mjs");

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

function tmpToken() {
  return join(mkdtempSync(join(tmpdir(), "ffmcp-")), "token");
}

// --- pid verification (pure, injected exec) ---

test("isBridgeCommand matches only the bridge entrypoint", () => {
  assert.equal(isBridgeCommand("node /Users/x/code/firefox-mcp/firefox-mcp-bridge/index.mjs"), true);
  assert.equal(isBridgeCommand("/usr/local/bin/node ./firefox-mcp-bridge/index.mjs"), true);
  assert.equal(isBridgeCommand("postgres -D /usr/local/var"), false);
  assert.equal(isBridgeCommand("node /some/other/index.mjs"), false);
  assert.equal(isBridgeCommand(""), false);
});

test("inspectPortHolders pairs lsof pids with ps command lines", () => {
  const execFn = (cmd) => {
    if (cmd.startsWith("lsof")) return "111\n222\n";
    if (cmd.includes("-p 111")) return "node /repo/firefox-mcp-bridge/index.mjs\n";
    if (cmd.includes("-p 222")) return "postgres -D /data\n";
    throw new Error(`unexpected: ${cmd}`);
  };
  assert.deepEqual(inspectPortHolders(3002, { execFn }), [
    { pid: 111, command: "node /repo/firefox-mcp-bridge/index.mjs" },
    { pid: 222, command: "postgres -D /data" },
  ]);
});

test("killStaleBridge kills only verified bridge pids and reports foreign ones", () => {
  const killed = [];
  const origKill = process.kill;
  process.kill = (pid, sig) => killed.push({ pid, sig });
  try {
    const execFn = (cmd) => {
      if (cmd.startsWith("lsof")) return "111\n222\n";
      if (cmd.includes("-p 111")) return "node /repo/firefox-mcp-bridge/index.mjs\n";
      if (cmd.includes("-p 222")) return "somed --serve\n";
      throw new Error(`unexpected: ${cmd}`);
    };
    const out = killStaleBridge(3002, { execFn });
    assert.deepEqual(out.killed, [111]);
    assert.deepEqual(out.foreign, [222]);
    assert.deepEqual(killed, [{ pid: 111, sig: "SIGTERM" }]);
  } finally {
    process.kill = origKill;
  }
});

// --- e2e: follower + promotion, real child processes on ephemeral ports ---

function spawnBridge({ wsPort, ssePort, tokenFile }) {
  const child = spawn(process.execPath, [INDEX], {
    env: {
      ...process.env,
      FIREFOX_BRIDGE_WS_PORT: String(wsPort),
      FIREFOX_BRIDGE_SSE_PORT: String(ssePort),
      FIREFOX_BRIDGE_TOKEN_FILE: tokenFile,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (d) => (stderr += d));
  return { child, stderr: () => stderr };
}

async function waitFor(fn, { timeout = 8000, interval = 50 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, interval));
  }
  throw new Error("waitFor timed out");
}

test("second instance follows a healthy owner instead of killing it, then promotes when the owner dies", async () => {
  const wsPort = await freePort();
  const ssePort = await freePort();
  const tokenFile = tmpToken();

  const owner = spawnBridge({ wsPort, ssePort, tokenFile });
  await waitFor(async () => (await probeBridgeHealth({ ssePort })) !== null);
  const ownerHealth = await probeBridgeHealth({ ssePort });
  assert.equal(ownerHealth.pid, owner.child.pid);

  const follower = spawnBridge({ wsPort, ssePort, tokenFile });
  await waitFor(() => follower.stderr().includes("following existing bridge"));
  // Owner must still be alive and still own /health.
  assert.equal((await probeBridgeHealth({ ssePort })).pid, owner.child.pid);

  // Kill the owner; the follower must promote and take over /health.
  owner.child.kill("SIGKILL");
  await waitFor(async () => {
    const h = await probeBridgeHealth({ ssePort });
    return h !== null && h.pid === follower.child.pid;
  }, { timeout: 15000 });
  assert.ok(follower.stderr().includes("promoted to owner"));

  follower.child.kill("SIGTERM");
  await new Promise((r) => follower.child.once("exit", r));
});

test("standalone instance exits 0 when a healthy bridge already runs", async () => {
  const wsPort = await freePort();
  const ssePort = await freePort();
  const tokenFile = tmpToken();

  const owner = spawnBridge({ wsPort, ssePort, tokenFile });
  await waitFor(async () => (await probeBridgeHealth({ ssePort })) !== null);

  const dupe = spawn(process.execPath, [INDEX], {
    env: {
      ...process.env,
      FIREFOX_BRIDGE_STANDALONE: "1",
      FIREFOX_BRIDGE_WS_PORT: String(wsPort),
      FIREFOX_BRIDGE_SSE_PORT: String(ssePort),
      FIREFOX_BRIDGE_TOKEN_FILE: tokenFile,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const code = await new Promise((r) => dupe.once("exit", r));
  assert.equal(code, 0);

  owner.child.kill("SIGTERM");
  await new Promise((r) => owner.child.once("exit", r));
});

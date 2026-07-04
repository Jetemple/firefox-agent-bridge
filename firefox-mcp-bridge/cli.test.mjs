import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "./cli.mjs";

const TOKEN = "cli-tok";

function tmpDir() {
  return mkdtempSync(join(tmpdir(), "ffcli-"));
}

// Stub owner with scripted /dispatch results per tool.
function stubOwner({ results = {}, extensionConnected = true, healthPid = process.pid } = {}) {
  const requests = [];
  const server = createServer(async (req, res) => {
    const path = new URL(req.url, "http://localhost").pathname;
    res.setHeader("content-type", "application/json");
    if (path === "/health") {
      res.end(JSON.stringify({ name: "firefox-mcp-bridge", version: "0.1.0", pid: healthPid, startedAt: 0, extensionConnected }));
      return;
    }
    if (path === "/dispatch") {
      let raw = "";
      for await (const c of req) raw += c;
      const body = JSON.parse(raw);
      requests.push({ auth: req.headers.authorization, body });
      const out = results[body.tool] ?? { result: { ok: true } };
      res.end(JSON.stringify(out));
      return;
    }
    res.statusCode = 404;
    res.end("{}");
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () =>
      resolve({ port: server.address().port, requests, close: () => new Promise((r) => server.close(r)) }),
    );
  });
}

function ctx(owner, { tokenFile } = {}) {
  const dir = tmpDir();
  const tf = tokenFile ?? join(dir, "token");
  writeFileSync(tf, `${TOKEN}\n`);
  const out = [];
  const err = [];
  return {
    dir,
    out,
    err,
    opts: {
      env: {
        FIREFOX_BRIDGE_SSE_PORT: String(owner.port),
        FIREFOX_BRIDGE_TOKEN_FILE: tf,
        FIREFOX_BRIDGE_LOG_DIR: dir,
      },
      stdout: (s) => out.push(s),
      stderr: (s) => err.push(s),
      spawnFn: () => {
        throw new Error("must not spawn when the bridge is up");
      },
    },
  };
}

test("ff tabs prints the tab list and sends the bearer token", async () => {
  const owner = await stubOwner({
    results: { get_tabs_summary: { result: { tabs: [{ id: 4, title: "T", url: "u", active: true }] } } },
  });
  const c = ctx(owner);
  try {
    const code = await runCli(["tabs"], c.opts);
    assert.equal(code, 0);
    assert.match(c.out.join(""), /4\*.*T.*u/);
    assert.equal(owner.requests[0].auth, `Bearer ${TOKEN}`);
  } finally {
    await owner.close();
  }
});

test("ff click runs the composite and aborts cleanly when nothing matches", async () => {
  const found = await stubOwner({
    results: {
      find_element: { result: { found: true, element: "a#x", text: "Go", x: 9, y: 8, count: 1 } },
      click: { result: { clicked: true } },
    },
  });
  const c1 = ctx(found);
  try {
    const code = await runCli(["click", "Go"], c1.opts);
    assert.equal(code, 0);
    assert.deepEqual(found.requests.map((r) => r.body.tool), ["find_element", "click"]);
    assert.deepEqual(found.requests[1].body.args, { x: 9, y: 8 });
  } finally {
    await found.close();
  }

  const missing = await stubOwner({ results: { find_element: { result: { found: false, count: 0 } } } });
  const c2 = ctx(missing);
  try {
    const code = await runCli(["click", "Nope"], c2.opts);
    assert.equal(code, 1);
    assert.match(c2.err.join(""), /no matching element/i);
    assert.deepEqual(missing.requests.map((r) => r.body.tool), ["find_element"]);
  } finally {
    await missing.close();
  }
});

test("tool errors surface on stderr with exit 1", async () => {
  const owner = await stubOwner({
    results: { get_tabs_summary: { error: { code: "NO_CLIENT", message: "No Firefox extension connected" } } },
  });
  const c = ctx(owner);
  try {
    const code = await runCli(["tabs"], c.opts);
    assert.equal(code, 1);
    assert.match(c.err.join(""), /NO_CLIENT.*No Firefox extension connected/);
  } finally {
    await owner.close();
  }
});

test("usage errors exit 2 with the message", async () => {
  const owner = await stubOwner();
  const c = ctx(owner);
  try {
    assert.equal(await runCli(["nav"], c.opts), 2);
    assert.match(c.err.join(""), /usage: ff nav/);
    assert.equal(await runCli(["frobnicate"], c.opts), 2);
  } finally {
    await owner.close();
  }
});

test("ff screenshot writes the decoded image to disk", async () => {
  const png = Buffer.from("fakepng");
  const owner = await stubOwner({
    results: {
      screenshot: { result: { dataUrl: `data:image/png;base64,${png.toString("base64")}`, format: "png", width: 1, height: 1 } },
    },
  });
  const c = ctx(owner);
  const out = join(c.dir, "shot.png");
  try {
    const code = await runCli(["screenshot", "-o", out], c.opts);
    assert.equal(code, 0);
    assert.deepEqual(readFileSync(out), png);
    assert.match(c.out.join(""), new RegExp(out.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  } finally {
    await owner.close();
  }
});

test("ff status reports the running bridge; exit 1 when it is down", async () => {
  const owner = await stubOwner({ extensionConnected: false });
  const c = ctx(owner);
  try {
    assert.equal(await runCli(["status"], c.opts), 0);
    assert.match(c.out.join(""), /running.*extension: not connected/i);
  } finally {
    await owner.close();
  }
  // Owner closed → status must fail without spawning (autostart is for tool commands).
  const c2 = ctx({ port: owner.port });
  assert.equal(await runCli(["status"], c2.opts), 1);
  assert.match(c2.err.join(""), /not running/i);
});

test("auto-start spawns a detached standalone bridge when /health is dead", async () => {
  const owner = await stubOwner();
  await owner.close(); // dead port
  const c = ctx({ port: owner.port });
  let spawned = null;
  c.opts.spawnFn = (cmd, args, opts) => {
    spawned = { cmd, args, opts };
    return { unref: () => {}, pid: 999 };
  };
  // Health never comes up → runCli fails after its startup poll, but must have TRIED to spawn.
  const code = await runCli(["tabs"], { ...c.opts, autostartPollMs: 10, autostartTimeoutMs: 100 });
  assert.equal(code, 1);
  assert.ok(spawned, "should spawn the bridge");
  assert.equal(spawned.opts.detached, true);
  assert.match(spawned.args.join(" "), /index\.mjs/);
  assert.equal(spawned.opts.env.FIREFOX_BRIDGE_STANDALONE, "1");
});

test("--no-autostart fails fast instead of spawning", async () => {
  const owner = await stubOwner();
  await owner.close();
  const c = ctx({ port: owner.port });
  c.opts.spawnFn = () => {
    throw new Error("must not spawn");
  };
  const code = await runCli(["tabs", "--no-autostart"], c.opts);
  assert.equal(code, 1);
  assert.match(c.err.join(""), /not running/i);
});

import { spawn as realSpawn } from "node:child_process";
import { createServer as createNetServer } from "node:net";

function freePort() {
  return new Promise((res, rej) => {
    const srv = createNetServer();
    srv.once("error", rej);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => res(port));
    });
  });
}

test("ff stop handles a stale bridge pid gracefully (process already dead)", async () => {
  // Spawn a short-lived child to get a genuinely dead pid.
  const child = realSpawn(process.execPath, ["-e", "setTimeout(() => {}, 100)"]);
  const deadPid = child.pid;
  await new Promise((r) => child.once("exit", r));

  // Stub owner reports that (now-dead) pid in its health response.
  const owner = await stubOwner({ healthPid: deadPid });
  const c = ctx(owner);
  try {
    const code = await runCli(["stop"], c.opts);
    assert.equal(code, 0);
    assert.match(c.out.join(""), /already stopped/);
  } finally {
    await owner.close();
  }
});

test("smoke: ff status + ff tabs against a real standalone bridge (no extension)", async () => {
  const wsPort = await freePort();
  const ssePort = await freePort();
  const dir = tmpDir();
  const tokenFile = join(dir, "token");
  const INDEX = new URL("./index.mjs", import.meta.url).pathname;
  const bridge = realSpawn(process.execPath, [INDEX], {
    env: {
      ...process.env,
      FIREFOX_BRIDGE_STANDALONE: "1",
      FIREFOX_BRIDGE_WS_PORT: String(wsPort),
      FIREFOX_BRIDGE_SSE_PORT: String(ssePort),
      FIREFOX_BRIDGE_TOKEN_FILE: tokenFile,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  try {
    const opts = {
      env: { FIREFOX_BRIDGE_SSE_PORT: String(ssePort), FIREFOX_BRIDGE_TOKEN_FILE: tokenFile },
      stdout: () => {},
      stderr: () => {},
      spawnFn: () => {
        throw new Error("bridge is already up");
      },
    };
    // Wait for the bridge, then: status works; tabs fails with NO_CLIENT (no extension).
    const deadline = Date.now() + 8000;
    let statusCode = 1;
    while (Date.now() < deadline && statusCode !== 0) {
      statusCode = await runCli(["status"], opts);
      if (statusCode !== 0) await new Promise((r) => setTimeout(r, 100));
    }
    assert.equal(statusCode, 0);

    const err = [];
    const tabsCode = await runCli(["tabs"], { ...opts, stderr: (s) => err.push(s) });
    assert.equal(tabsCode, 1);
    assert.match(err.join(""), /NO_CLIENT/);
  } finally {
    bridge.kill("SIGTERM");
    await new Promise((r) => bridge.once("exit", r));
  }
});

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
function stubOwner({ results = {}, resultsFn, extensionConnected = true, healthPid = process.pid } = {}) {
  const requests = [];
  const dispatchBodies = [];
  let down = false;
  const server = createServer(async (req, res) => {
    if (down) {
      req.socket.destroy(); // simulate a dead bridge without freeing the port
      return;
    }
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
      dispatchBodies.push(body);
      // resultsFn (a function of the whole request body) takes priority so a
      // test can vary the answer by envelope (e.g. by body.profile) rather
      // than just by tool name.
      let out = resultsFn ? resultsFn(body) : results[body.tool];
      if (out === undefined) out = { result: { ok: true } };
      // Scripted result may be a function of the per-tool call count, so a test
      // can return "not found" for the first N polls and "found" afterwards.
      if (typeof out === "function") {
        const nth = requests.filter((r) => r.body.tool === body.tool).length - 1;
        out = out(nth, body);
      }
      // A scripted entry shaped as { status, body } drives a non-2xx HTTP
      // response (e.g. 400 with an { error } body) — distinct from the
      // always-200 shapes below, which only vary the JSON payload.
      if (out && typeof out === "object" && "status" in out && "body" in out) {
        res.statusCode = out.status;
        res.end(JSON.stringify(out.body));
        return;
      }
      // A scripted entry that is a bare tool-result payload (no top-level
      // `result`/`error` — i.e. what the tool would actually return, not the
      // HTTP envelope) is auto-wrapped as a success response. Entries already
      // shaped like the envelope (the pre-existing convention) pass through.
      if (out && typeof out === "object" && !("result" in out) && !("error" in out)) {
        out = { result: out };
      }
      res.end(JSON.stringify(out));
      return;
    }
    res.statusCode = 404;
    res.end("{}");
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () =>
      resolve({
        port: server.address().port,
        requests,
        dispatchBodies,
        setDown: (v) => (down = v),
        close: () => new Promise((r) => server.close(r)),
      }),
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

// stubOwner + ctx combined for the envelope/session/profile tests below: spins
// up a stub bridge plus runCli overrides in one call, and exposes the parsed
// /dispatch bodies directly (not the {auth, body} wrapper `requests` uses)
// since those tests assert on envelope fields like `.session`/`.profile`.
// Owners are closed automatically once the whole file's tests finish (these
// tests don't hold a `close()` themselves — see pendingOwnerCloses below).
const pendingOwnerCloses = [];
async function stubOwnerContext(options) {
  const owner = await stubOwner(options);
  pendingOwnerCloses.push(owner.close);
  const c = ctx(owner);
  return { dispatchBodies: owner.dispatchBodies, out: c.out, err: c.err, overrides: c.opts };
}
test.after(async () => {
  await Promise.all(pendingOwnerCloses.splice(0).map((close) => close()));
});

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

test("ff js prints a string result raw (no {\"result\":...} wrapper)", async () => {
  const owner = await stubOwner({ results: { javascript_tool: { result: { result: "42 rooms" } } } });
  const c = ctx(owner);
  try {
    const code = await runCli(["js", "'x'"], c.opts);
    assert.equal(code, 0);
    assert.equal(c.out.join("").trim(), "42 rooms");
  } finally {
    await owner.close();
  }
});

test("ff js -f <file> loads code from a file instead of argv", async () => {
  const owner = await stubOwner({ results: { javascript_tool: { result: { result: "ok" } } } });
  const c = ctx(owner);
  const script = join(c.dir, "extract.js");
  writeFileSync(script, 'document.querySelectorAll("a").length + "\\n"');
  try {
    const code = await runCli(["js", "-f", script, "--tab", "21"], c.opts);
    assert.equal(code, 0);
    const call = owner.requests.find((r) => r.body.tool === "javascript_tool");
    assert.equal(call.body.args.code, 'document.querySelectorAll("a").length + "\\n"');
    assert.equal(call.body.args.tabId, 21);
  } finally {
    await owner.close();
  }
});

test("ff -s NAME js -f <file> loads the file with leading globals (regression: -f sent as code)", async () => {
  const owner = await stubOwner({ results: { javascript_tool: { result: { result: "ok" } } } });
  const c = ctx(owner);
  const script = join(c.dir, "extract.js");
  writeFileSync(script, "1 + 1");
  try {
    const code = await runCli(["-s", "mine", "js", "-f", script], c.opts);
    assert.equal(code, 0);
    const call = owner.requests.find((r) => r.body.tool === "javascript_tool");
    assert.equal(call.body.args.code, "1 + 1");
    assert.equal(call.body.session, "mine");
  } finally {
    await owner.close();
  }
});

test("ff click passes find_element's ref and frameId through, and a covered target exits 1", async () => {
  const hit = await stubOwner({
    results: {
      find_element: { result: { found: true, element: "a", text: "Go", x: 9, y: 8, count: 1, ref: "r1", frameId: 77 } },
      click: { result: { clicked: true, frameId: 77 } },
    },
  });
  const c1 = ctx(hit);
  try {
    assert.equal(await runCli(["click", "Go"], c1.opts), 0);
    assert.deepEqual(hit.requests[1].body.args, { x: 9, y: 8, ref: "r1", frameId: 77 });
  } finally {
    await hit.close();
  }

  const covered = await stubOwner({
    results: {
      find_element: { result: { found: true, element: "a", text: "Go", x: 9, y: 8, count: 1, ref: "r1" } },
      click: { result: { clicked: false, reason: "target covered", hit: "div#cover", x: 9, y: 8 } },
    },
  });
  const c2 = ctx(covered);
  try {
    assert.equal(await runCli(["click", "Go"], c2.opts), 1);
    assert.match(c2.err.join(""), /target covered \(covered by div#cover/);
  } finally {
    await covered.close();
  }
});

test("ff type stops before typing when its click missed", async () => {
  const owner = await stubOwner({
    results: {
      find_element: { result: { found: true, element: "input", text: "", x: 1, y: 2, count: 1, ref: "r" } },
      click: { result: { clicked: false, reason: "target covered", hit: "div", x: 1, y: 2 } },
    },
  });
  const c = ctx(owner);
  try {
    assert.equal(await runCli(["type", "Email", "me@x.com"], c.opts), 1);
    assert.deepEqual(owner.requests.map((r) => r.body.tool).filter((t) => t), ["find_element", "click"]);
  } finally {
    await owner.close();
  }
});

test("ff type exits nonzero when the text didn't land", async () => {
  const owner = await stubOwner({
    results: {
      type: { result: { typed: false, reason: "text did not stick: the editor did not accept it", fieldNow: "" } },
    },
  });
  const c = ctx(owner);
  try {
    assert.equal(await runCli(["type", "hello", "--focused"], c.opts), 1);
    assert.match(c.err.join(""), /type failed: text did not stick.*box now holds: ""/);
  } finally {
    await owner.close();
  }
});

test("ff tabs marks the tabs live sessions own", async () => {
  const owner = await stubOwner({
    results: {
      get_tabs_summary: { result: { tabs: [
        { id: 1, title: "Mine", url: "http://a", opened: true },
        { id: 2, title: "Gone", url: "http://b" },
        { id: 3, title: "Unnamed", url: "http://c", opened: true },
        { id: 4, title: "Agent", url: "http://d", agent: true, opened: true },
      ] } },
      session_list: { result: { sessions: [
        { name: "refund", profile: "default", tabId: 1, live: true },
        { name: "stale", profile: "default", tabId: 2, live: false },
      ] } },
    },
  });
  const c = ctx(owner);
  try {
    assert.equal(await runCli(["tabs"], c.opts), 0);
    const lines = c.out.join("").trim().split("\n");
    assert.match(lines[0], /^1\s+\[refund\] Mine/);
    assert.match(lines[1], /^2\s+Gone/);
    assert.match(lines[2], /^3\s+\[opened\] Unnamed/);
    assert.match(lines[3], /^4\s+🤖 Agent/);
  } finally {
    await owner.close();
  }
});

test("ff js - reads code from stdin", async () => {
  const owner = await stubOwner({ results: { javascript_tool: { result: { result: "ok" } } } });
  const c = ctx(owner);
  try {
    const code = await runCli(["js", "-"], { ...c.opts, readStdin: async () => "1 + 1" });
    assert.equal(code, 0);
    const call = owner.requests.find((r) => r.body.tool === "javascript_tool");
    assert.equal(call.body.args.code, "1 + 1");
  } finally {
    await owner.close();
  }
});

test("ff js -f on a missing file exits 2 without dispatching", async () => {
  const owner = await stubOwner({});
  const c = ctx(owner);
  try {
    const code = await runCli(["js", "-f", join(c.dir, "nope.js")], c.opts);
    assert.equal(code, 2);
    assert.equal(owner.requests.length, 0);
    assert.match(c.err.join(""), /nope\.js/);
  } finally {
    await owner.close();
  }
});

test("ff nav --wait-for polls find_element until the selector appears", async () => {
  const owner = await stubOwner({
    results: {
      navigate: { result: { tabId: 21, url: "https://x" } },
      // not found on the first two polls, then found on the third
      find_element: (nth) => ({ result: nth < 2 ? { found: false } : { found: true, element: "div.card", x: 1, y: 2 } }),
    },
  });
  const c = ctx(owner);
  try {
    const code = await runCli(["nav", "https://x", "--wait-for", "div.card"], { ...c.opts, waitPollMs: 1 });
    assert.equal(code, 0);
    const finds = owner.requests.filter((r) => r.body.tool === "find_element");
    assert.equal(finds.length, 3);
    // polls the tab that navigate returned, with the given selector
    assert.equal(finds[0].body.args.tabId, 21);
    assert.equal(finds[0].body.args.selector, "div.card");
  } finally {
    await owner.close();
  }
});

test("ff nav --wait-for keeps polling through transient errors while the new tab is still about:blank", async () => {
  const owner = await stubOwner({
    results: {
      navigate: { result: { tabId: 21, url: "https://x" } },
      // a freshly-created tab is about:blank until the load starts → RESTRICTED_URL;
      // the poll must absorb that and keep going, not abort.
      find_element: (nth) =>
        nth < 2 ? { error: { code: "RESTRICTED_URL", message: "Tab URL is restricted: about:blank" } } : { result: { found: true } },
    },
  });
  const c = ctx(owner);
  try {
    const code = await runCli(["nav", "https://x", "--wait-for", "h1"], { ...c.opts, waitPollMs: 1 });
    assert.equal(code, 0);
    assert.equal(owner.requests.filter((r) => r.body.tool === "find_element").length, 3);
  } finally {
    await owner.close();
  }
});

test("ff nav --wait-for times out with exit 1 when the selector never appears", async () => {
  const owner = await stubOwner({
    results: {
      navigate: { result: { tabId: 21, url: "https://x" } },
      find_element: { result: { found: false } },
    },
  });
  const c = ctx(owner);
  try {
    const code = await runCli(["nav", "https://x", "--wait-for", ".card", "--wait-timeout", "20"], { ...c.opts, waitPollMs: 1 });
    assert.equal(code, 1);
    assert.match(c.err.join(""), /wait-for.*\.card/);
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

test("ff screenshot omits dimensions when the extension could not measure them", async () => {
  // Restricted pages (about:*) allow capture but not the viewport-size probe,
  // so width/height come back null — the CLI must not print "(nullxnull)".
  const png = Buffer.from("fakepng");
  const owner = await stubOwner({
    results: {
      screenshot: { result: { dataUrl: `data:image/png;base64,${png.toString("base64")}`, format: "png", width: null, height: null } },
    },
  });
  const c = ctx(owner);
  const out = join(c.dir, "shot.png");
  try {
    const code = await runCli(["screenshot", "-o", out], c.opts);
    assert.equal(code, 0);
    assert.deepEqual(readFileSync(out), png);
    assert.doesNotMatch(c.out.join(""), /null/);
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

test("ff start --replace SIGTERMs the advertised pid, waits for death, then starts fresh", async () => {
  const owner = await stubOwner({ healthPid: 4242 });
  const c = ctx(owner);
  const killed = [];
  let spawned = false;
  c.opts.killFn = (pid, sig) => {
    killed.push({ pid, sig });
    owner.setDown(true); // the killed bridge stops answering /health
  };
  c.opts.execFn = () => {
    throw new Error("lsof: no holders"); // ports free once the pid dies
  };
  c.opts.spawnFn = () => {
    spawned = true;
    owner.setDown(false); // fresh bridge comes up healthy
    return { unref: () => {}, pid: 555 };
  };
  c.opts.autostartPollMs = 10;
  c.opts.autostartTimeoutMs = 2000;
  try {
    const code = await runCli(["start", "--replace"], c.opts);
    assert.equal(code, 0, c.err.join(""));
    assert.deepEqual(killed, [{ pid: 4242, sig: "SIGTERM" }]);
    assert.ok(spawned, "should spawn a fresh bridge after killing the old one");
    assert.match(c.out.join(""), /bridge running/);
  } finally {
    await owner.close();
  }
});

test("ff start --replace kills a positively identified stale bridge holding the WS port", async () => {
  const owner = await stubOwner();
  owner.setDown(true); // /health never answers — the stale-holder scenario
  const c = ctx(owner);
  c.opts.env.FIREFOX_BRIDGE_WS_PORT = "3999";
  const killed = [];
  let staleAlive = true;
  let spawned = false;
  c.opts.execFn = (cmd) => {
    if (cmd.startsWith("lsof") && cmd.includes("3999")) {
      if (staleAlive) return "777\n";
      throw new Error("no holders");
    }
    if (cmd.startsWith("lsof")) throw new Error("no holders"); // SSE port is free
    if (cmd.includes("-p 777")) return "node /repo/firefox-mcp-bridge/index.mjs\n";
    throw new Error(`unexpected exec: ${cmd}`);
  };
  c.opts.killFn = (pid, sig) => {
    killed.push({ pid, sig });
    staleAlive = false;
  };
  c.opts.spawnFn = () => {
    spawned = true;
    owner.setDown(false);
    return { unref: () => {}, pid: 555 };
  };
  c.opts.autostartPollMs = 10;
  c.opts.autostartTimeoutMs = 2000;
  try {
    const code = await runCli(["start", "--replace"], c.opts);
    assert.equal(code, 0, c.err.join(""));
    assert.deepEqual(killed, [{ pid: 777, sig: "SIGTERM" }]);
    assert.ok(spawned);
  } finally {
    await owner.close();
  }
});

test("ff start --replace refuses to kill a foreign process holding the WS port", async () => {
  const owner = await stubOwner();
  owner.setDown(true);
  const c = ctx(owner);
  c.opts.env.FIREFOX_BRIDGE_WS_PORT = "3999";
  const killed = [];
  c.opts.execFn = (cmd) => {
    if (cmd.startsWith("lsof") && cmd.includes("3999")) return "888\n";
    if (cmd.startsWith("lsof")) throw new Error("no holders");
    if (cmd.includes("-p 888")) return "postgres -D /data\n";
    throw new Error(`unexpected exec: ${cmd}`);
  };
  c.opts.killFn = (pid, sig) => killed.push({ pid, sig });
  try {
    const code = await runCli(["start", "--replace"], c.opts);
    assert.equal(code, 1);
    assert.match(c.err.join(""), /refusing to kill/i);
    assert.deepEqual(killed, [], "must not signal a foreign pid");
  } finally {
    await owner.close();
  }
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

test("ff -s research text sends the session in the dispatch body", async () => {
  const c = await stubOwnerContext({ results: { get_page_text: { text: "hi" } } });
  const code = await runCli(["-s", "research", "text"], c.overrides);
  assert.equal(code, 0);
  assert.equal(c.dispatchBodies[0].session, "research");
  assert.equal(c.dispatchBodies[0].tool, "get_page_text");
});

test("ff open --as binds a session after opening and prints the binding", async () => {
  const c = await stubOwnerContext({
    results: {
      open_tab: { tabId: 55, windowId: 2, url: "https://x.com" },
      session_bind: { name: "research", profile: "work", tabId: 55, url: "https://x.com", previous: null },
    },
  });
  const code = await runCli(["open", "https://x.com", "--as", "research"], c.overrides);
  assert.equal(code, 0);
  assert.deepEqual(c.dispatchBodies.map((b) => b.tool), ["open_tab", "session_bind"]);
  assert.deepEqual(c.dispatchBodies[1].args, { name: "research", tabId: 55 });
  assert.match(c.out.join(""), /session research → tab 55 \(profile work\)/);
});

test("ff open --container on an extension without container support fails before opening anything", async () => {
  const c = await stubOwnerContext({
    results: {
      get_containers: { error: { code: "UNKNOWN_TOOL", message: "Unknown tool: get_containers" } },
      open_tab: { tabId: 55, windowId: 2, url: "https://x.com" },
    },
  });
  const code = await runCli(["open", "https://x.com", "--container", "Gmail"], c.overrides);
  assert.equal(code, 1);
  assert.deepEqual(c.dispatchBodies.map((b) => b.tool), ["get_containers"]);
  assert.match(c.err.join(""), /predates container support: reload it/);
});

test("ff open --container --as prints the container the session's tab landed in", async () => {
  const c = await stubOwnerContext({
    results: {
      get_containers: { containers: [{ name: "Gmail", cookieStoreId: "firefox-container-7" }] },
      open_tab: { tabId: 55, windowId: 2, url: "https://mail.google.com", container: "Gmail" },
      session_bind: { name: "mail", profile: "default", tabId: 55, url: "https://mail.google.com", previous: null },
    },
  });
  const code = await runCli(["open", "mail.google.com", "--container", "Gmail", "--as", "mail"], c.overrides);
  assert.equal(code, 0);
  assert.deepEqual(c.dispatchBodies.map((b) => b.tool), ["get_containers", "open_tab", "session_bind"]);
  assert.match(c.out.join(""), /session mail → tab 55 \(profile default\) in container Gmail/);
});

test("ff --profile work nav routes the envelope profile", async () => {
  const c = await stubOwnerContext({ results: { navigate: { tabId: 3, url: "https://x.com" } } });
  await runCli(["--profile", "work", "nav", "https://x.com"], c.overrides);
  assert.equal(c.dispatchBodies[0].profile, "work");
});

test("ff tabs fans out per profile when the bridge answers PROFILE_REQUIRED", async () => {
  const c = await stubOwnerContext({
    resultsFn: (body) => {
      if (body.tool === "get_tabs_summary" && !body.profile) {
        return { error: { code: "PROFILE_REQUIRED", message: "multiple (work, personal)" } };
      }
      if (body.tool === "profiles_list") {
        return { result: { profiles: [{ name: "work", runId: "r1", connectedAt: 1 }, { name: "personal", runId: "r2", connectedAt: 2 }] } };
      }
      return { result: { tabs: [{ id: 1, title: `t-${body.profile}`, url: `https://${body.profile}.example`, active: false }] } };
    },
  });
  const code = await runCli(["tabs"], c.overrides);
  assert.equal(code, 0);
  const out = c.out.join("");
  assert.match(out, /\[work\]/);
  assert.match(out, /\[personal\]/);
  assert.match(out, /t-work/);
});

test("ff tabs --json fans out per profile as parseable JSON ({profiles:[{name,tabs}]})", async () => {
  const c = await stubOwnerContext({
    resultsFn: (body) => {
      if (body.tool === "get_tabs_summary" && !body.profile) {
        return { error: { code: "PROFILE_REQUIRED", message: "multiple (work, personal)" } };
      }
      if (body.tool === "profiles_list") {
        return { result: { profiles: [{ name: "work", runId: "r1", connectedAt: 1 }, { name: "personal", runId: "r2", connectedAt: 2 }] } };
      }
      return { result: { tabs: [{ id: 1, title: `t-${body.profile}`, url: `https://${body.profile}.example`, active: false }] } };
    },
  });
  const code = await runCli(["tabs", "--json"], c.overrides);
  assert.equal(code, 0);
  const parsed = JSON.parse(c.out.join(""));
  assert.deepEqual(parsed, {
    profiles: [
      { name: "work", tabs: [{ id: 1, title: "t-work", url: "https://work.example", active: false }] },
      { name: "personal", tabs: [{ id: 1, title: "t-personal", url: "https://personal.example", active: false }] },
    ],
  });
});

test("ff open --as --json prints the session_bind result as JSON, not the human line", async () => {
  const c = await stubOwnerContext({
    results: {
      open_tab: { tabId: 55, windowId: 2, url: "https://x.com" },
      session_bind: { name: "research", profile: "work", tabId: 55, url: "https://x.com", previous: null },
    },
  });
  const code = await runCli(["open", "https://x.com", "--as", "research", "--json"], c.overrides);
  assert.equal(code, 0);
  const parsed = JSON.parse(c.out.join(""));
  assert.deepEqual(parsed, { name: "research", profile: "work", tabId: 55, url: "https://x.com", previous: null });
});

test("dispatch renders CODE: message when the bridge returns a non-2xx status with an error code", async () => {
  const owner = await stubOwner({
    results: {
      get_tabs_summary: {
        status: 400,
        body: { error: { code: "DISPATCH_CONFLICT", message: "session and profile are mutually exclusive" } },
      },
    },
  });
  const c = ctx(owner);
  try {
    const code = await runCli(["tabs"], c.opts);
    assert.equal(code, 1);
    assert.match(c.err.join(""), /DISPATCH_CONFLICT: session and profile are mutually exclusive/);
  } finally {
    await owner.close();
  }
});

test("SESSION_STALE from the bridge is rendered actionably and exits 1", async () => {
  const c = await stubOwnerContext({
    resultsFn: () => ({ error: { code: "SESSION_STALE", message: 'session "research" is stale — rebind' } }),
  });
  const code = await runCli(["-s", "research", "text"], c.overrides);
  assert.equal(code, 1);
  assert.match(c.err.join(""), /SESSION_STALE.*rebind/);
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

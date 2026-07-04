#!/usr/bin/env node
// ff — drive the logged-in Firefox from the shell. Thin HTTP client over the
// bridge's /health + /dispatch; see cli-core.mjs for the command table.
import { spawn } from "node:child_process";
import { mkdirSync, openSync, writeFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadOrCreateToken, DEFAULT_TOKEN_PATH } from "../scripts/secure-config.mjs";
import { parseCli, formatResult, usageText } from "./cli-core.mjs";

const INDEX = resolve(dirname(fileURLToPath(import.meta.url)), "index.mjs");

// Overridable so tests never touch the real home directory.
function logDir(env) {
  return env.FIREFOX_BRIDGE_LOG_DIR || join(homedir(), ".firefox-mcp");
}

function stripDataUrlPrefix(dataUrl) {
  const comma = dataUrl.indexOf(",");
  return comma === -1 ? dataUrl : dataUrl.slice(comma + 1);
}

class CliError extends Error {
  constructor(message, code = 1) {
    super(message);
    this.exitCode = code;
  }
}

function readSettings(env) {
  return {
    ssePort: env.FIREFOX_BRIDGE_SSE_PORT ? Number(env.FIREFOX_BRIDGE_SSE_PORT) : 3003,
    tokenFile: env.FIREFOX_BRIDGE_TOKEN_FILE || DEFAULT_TOKEN_PATH,
    envToken: env.FIREFOX_BRIDGE_SSE_TOKEN || null,
  };
}

async function getHealth(settings, fetchFn) {
  try {
    const res = await fetchFn(`http://127.0.0.1:${settings.ssePort}/health`, { signal: AbortSignal.timeout(1500) });
    if (!res.ok) return null;
    const health = await res.json();
    return health?.name === "firefox-mcp-bridge" ? health : null;
  } catch {
    return null;
  }
}

async function ensureBridge(settings, { fetchFn, spawnFn, stderr, noAutostart, pollMs, timeoutMs, env }) {
  let health = await getHealth(settings, fetchFn);
  if (health) return health;
  if (noAutostart) throw new CliError("bridge not running (auto-start disabled; run `ff start`)");
  const dir = logDir(env);
  stderr(`bridge not running — starting it (logs: ${join(dir, "bridge.log")})\n`);
  mkdirSync(dir, { recursive: true });
  const logFd = openSync(join(dir, "bridge.log"), "a");
  const child = spawnFn(process.execPath, [INDEX], {
    detached: true,
    stdio: ["ignore", logFd, logFd],
    env: { ...env, FIREFOX_BRIDGE_STANDALONE: "1" },
  });
  child.unref();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, pollMs));
    health = await getHealth(settings, fetchFn);
    if (health) return health;
  }
  throw new CliError(`bridge failed to start — see ${join(dir, "bridge.log")}`);
}

async function dispatch(settings, token, fetchFn, tool, args, timeout) {
  let res;
  try {
    res = await fetchFn(`http://127.0.0.1:${settings.ssePort}/dispatch`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ tool, args, ...(timeout ? { timeoutMs: timeout } : {}) }),
    });
  } catch {
    throw new CliError("lost connection to the bridge mid-call");
  }
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new CliError(body?.error?.message ?? `bridge rejected the call (HTTP ${res.status})`);
  if (body?.error) throw new CliError(`${body.error.code}: ${body.error.message}`);
  return body.result;
}

async function runLifecycle(command, settings, deps) {
  const { fetchFn, stdout, stderr } = deps;
  if (command === "status") {
    const health = await getHealth(settings, fetchFn);
    if (!health) {
      stderr("bridge: not running\n");
      return 1;
    }
    stdout(
      `bridge: running (pid ${health.pid}, v${health.version}) — ` +
        `extension: ${health.extensionConnected ? "connected" : "not connected"}\n`,
    );
    return 0;
  }
  if (command === "start") {
    const health = await ensureBridge(settings, deps);
    deps.stdout(`bridge running (pid ${health.pid})\n`);
    return 0;
  }
  if (command === "stop") {
    const health = await getHealth(settings, fetchFn);
    if (!health) {
      stdout("bridge: not running\n");
      return 0;
    }
    process.kill(health.pid, "SIGTERM");
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
      if (!(await getHealth(settings, fetchFn))) {
        stdout(`stopped (pid ${health.pid})\n`);
        return 0;
      }
    }
    stderr(`bridge (pid ${health.pid}) did not stop within 3s\n`);
    return 1;
  }
  // ping
  const health = await ensureBridge(settings, deps);
  if (!health.extensionConnected) {
    stderr("extension: NOT connected (load it via about:debugging)\n");
    return 1;
  }
  const token = deps.token;
  const summary = await dispatch(settings, token, fetchFn, "get_tabs_summary", {}, undefined);
  stdout(`extension connected — ${summary?.tabs?.length ?? "?"} tabs\n`);
  return 0;
}

export async function runCli(argv, overrides = {}) {
  const env = overrides.env ? { ...process.env, ...overrides.env } : process.env;
  const deps = {
    fetchFn: overrides.fetchFn ?? fetch,
    spawnFn: overrides.spawnFn ?? spawn,
    stdout: overrides.stdout ?? ((s) => process.stdout.write(s)),
    stderr: overrides.stderr ?? ((s) => process.stderr.write(s)),
    pollMs: overrides.autostartPollMs ?? 100,
    timeoutMs: overrides.autostartTimeoutMs ?? 4000,
    env,
  };
  const settings = readSettings(env);

  const parsed = parseCli(argv);
  if (!parsed.ok) {
    deps.stderr(`${parsed.error}\n`);
    return 2;
  }
  if (parsed.kind === "help") {
    deps.stdout(`${usageText()}\n`);
    return 0;
  }
  deps.noAutostart = parsed.flags.noAutostart;

  try {
    const token = env.FIREFOX_BRIDGE_SSE_TOKEN || loadOrCreateToken({ tokenPath: settings.tokenFile });
    deps.token = token;

    if (parsed.kind === "lifecycle") return await runLifecycle(parsed.command, settings, deps);

    await ensureBridge(settings, deps);
    const results = [];
    let prev = null;
    for (const step of parsed.steps) {
      const args = step.buildArgs ? step.buildArgs(prev) : step.args;
      if (args == null) {
        throw new CliError(`no matching element (${JSON.stringify(parsed.steps[0].args)})`);
      }
      prev = await dispatch(settings, token, deps.fetchFn, step.tool, args, parsed.flags.timeout);
      results.push({ tool: step.tool, result: prev });
    }

    if (parsed.command === "screenshot") {
      const shot = results[results.length - 1].result;
      if (typeof shot?.dataUrl !== "string") throw new CliError("screenshot payload missing dataUrl");
      const out = parsed.flags.out ?? `firefox-${Date.now()}.${shot.format === "jpeg" ? "jpg" : "png"}`;
      writeFileSync(out, Buffer.from(stripDataUrlPrefix(shot.dataUrl), "base64"));
      deps.stdout(`${resolve(out)} (${shot.width}x${shot.height})\n`);
      return 0;
    }

    const rendered = formatResult(parsed.command, results, { json: parsed.flags.json });
    if (rendered) deps.stdout(`${rendered}\n`);
    return 0;
  } catch (err) {
    if (err instanceof CliError) {
      deps.stderr(`${err.message}\n`);
      return err.exitCode;
    }
    deps.stderr(`unexpected error: ${err?.stack ?? err}\n`);
    return 1;
  }
}

// Only run as a script when invoked directly (`ff ...` or `node cli.mjs ...`),
// not when imported by tests. realpathSync (not plain resolve()) so this also
// fires through the npm-linked `ff` symlink, matching index.mjs's pattern.
function invokedDirectly() {
  try {
    return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  runCli(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}

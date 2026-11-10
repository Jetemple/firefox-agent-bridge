#!/usr/bin/env node
// ff — drive the logged-in Firefox from the shell. Thin HTTP client over the
// bridge's /health + /dispatch; see cli-core.mjs for the command table.
import { spawn } from "node:child_process";
import { mkdirSync, openSync, writeFileSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadOrCreateToken, DEFAULT_TOKEN_PATH } from "../scripts/secure-config.mjs";
import { parseCli, formatResult, formatTab, splitLeadingGlobals, usageText } from "./cli-core.mjs";

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

function readStdinAll() {
  return new Promise((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => (data += c));
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", reject);
  });
}

const POINTER_DONE = { click: "clicked", hover: "hovered", double_click: "doubleClicked", right_click: "rightClicked" };

// `ff js` accepts code inline, from a file (`-f <path>`), or from stdin (`-`),
// so non-trivial scripts skip shell-escaping entirely. File/stdin reads are I/O
// and live here; cli-core stays pure. Returns a rewritten argv with the code as
// the sole js positional. Throws CliError(2) on an unreadable file.
async function resolveJsSource(argv, deps) {
  let split;
  try {
    split = splitLeadingGlobals(argv);
  } catch {
    return argv; // parseCli reports the same usage error
  }
  const { globals, rest: command } = split;
  if (command[0] !== "js") return argv;
  let code = null;
  const rest = [];
  for (let i = 1; i < command.length; i++) {
    const a = command[i];
    if (a === "-f" || a === "--file") {
      const path = command[++i];
      if (path == null) throw new CliError("usage: ff js -f <file>", 2);
      try {
        code = deps.readFileFn(path, "utf8");
      } catch (err) {
        throw new CliError(`cannot read ${path}: ${err?.message ?? err}`, 2);
      }
    } else if (a === "-") {
      code = await deps.readStdin();
    } else {
      rest.push(a);
    }
  }
  return code == null ? argv : [...globals, "js", code, ...rest];
}

// Which tab a wait should probe. A session already pins the tab bridge-side, so
// only fall back to the last step's tab when there is no session in the envelope.
function waitTarget(envelope, lastResult) {
  return !envelope.session && lastResult?.tabId != null ? { tabId: lastResult.tabId } : {};
}

// Shared loop behind --wait-for and --settle: call probe(budgetMs) until it
// returns true or the deadline passes. Each probe gets only the time that is
// left (capped at --timeout, or the bridge's 15 s default), so one slow probe
// cannot run past the deadline. Errors that `retryable` rejects are thrown.
async function pollUntil(deadline, deps, flags, probe, retryable) {
  let lastError = null;
  for (;;) {
    const budgetMs = Math.max(1, Math.min(flags.timeout || 15000, deadline - Date.now()));
    try {
      if (await probe(budgetMs)) return { done: true, lastError: null };
      lastError = null;
    } catch (err) {
      if (!retryable(err)) throw err;
      lastError = err;
    }
    if (Date.now() >= deadline) return { done: false, lastError };
    await new Promise((res) => setTimeout(res, deps.waitPollMs));
  }
}

// Client-side `--wait-for <css>`: poll find_element until the selector appears
// (or the deadline passes), so callers stop guessing fixed `sleep`s after nav.
async function waitForSelector(settings, token, deps, flags, lastResult, envelope, wait) {
  const args = { selector: flags.waitFor, ...waitTarget(envelope, lastResult) };
  const probe = async (budgetMs) =>
    (await dispatch(settings, token, deps.fetchFn, "find_element", args, budgetMs, envelope))?.found;
  // A tab created mid-navigation is briefly about:blank (RESTRICTED_URL) and a
  // loading page can transiently fail the probe: that's exactly what we are
  // waiting out, so every error is retried until the deadline.
  const { done, lastError } = await pollUntil(wait.deadline, deps, flags, probe, () => true);
  if (!done) {
    const detail = lastError ? ` (last error: ${lastError.message})` : "";
    throw new CliError(`--wait-for: "${flags.waitFor}" did not appear within ${Math.round(wait.ms / 1000)}s${detail}`);
  }
}

// Client-side `--settle`: poll document.readyState until the page has loaded,
// then pause a random moment (0.8–2.5 s by default) so the next read or click
// doesn't land the instant the page appears. A page that never finishes loading
// is not an error: after the deadline we warn and carry on, as a fixed sleep would.
// Only "page not ready yet" is retried: about:blank before the load starts
// (RESTRICTED_URL), a script that can't run mid-navigation (SCRIPT_FAILED), or a
// probe that ran out of time (WS_TIMEOUT). A closed tab or a dead bridge is a
// real failure and is thrown.
const NOT_READY = /^(RESTRICTED_URL|SCRIPT_FAILED|WS_TIMEOUT):/;
async function waitForLoad(settings, token, deps, flags, lastResult, envelope, wait) {
  const args = { code: "document.readyState", ...waitTarget(envelope, lastResult) };
  const probe = async (budgetMs) =>
    (await dispatch(settings, token, deps.fetchFn, "javascript_tool", args, budgetMs, envelope))?.result === "complete";
  const { done, lastError } = await pollUntil(wait.deadline, deps, flags, probe, (err) => NOT_READY.test(err?.message ?? ""));
  if (!done) {
    // Two different outcomes: the page answered "still loading", or the load
    // state could never be read at all (e.g. a page that forbids scripts).
    const secs = Math.round(wait.ms / 1000);
    deps.stderr(
      lastError
        ? `--settle: could not read the page's load state within ${secs}s, continuing (last error: ${lastError.message})\n`
        : `--settle: page still loading after ${secs}s, continuing\n`,
    );
  }
  await new Promise((res) => setTimeout(res, deps.settleMs()));
}

async function dispatch(settings, token, fetchFn, tool, args, timeout, envelope = {}) {
  let res;
  try {
    res = await fetchFn(`http://127.0.0.1:${settings.ssePort}/dispatch`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({
        tool,
        args,
        ...(timeout ? { timeoutMs: timeout } : {}),
        ...(envelope.session ? { session: envelope.session } : {}),
        ...(envelope.profile ? { profile: envelope.profile } : {}),
      }),
    });
  } catch {
    throw new CliError("lost connection to the bridge mid-call");
  }
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    throw new CliError(
      body?.error?.code
        ? `${body.error.code}: ${body.error.message}`
        : (body?.error?.message ?? `bridge rejected the call (HTTP ${res.status})`),
    );
  }
  if (body?.error) throw new CliError(`${body.error.code}: ${body.error.message}`);
  return body.result;
}

// `ff start --replace`: the only path allowed to SIGTERM an existing bridge.
// Kills the pid advertised by /health, then any lingering positively
// identified bridge processes still holding the WS/HTTP ports; refuses to
// touch foreign holders. index.mjs / ws-relay.mjs are imported lazily so the
// per-call CLI path stays free of their startup cost.
async function replaceExistingBridge(settings, deps) {
  const { fetchFn, stderr, killFn, pollMs } = deps;
  const [{ killStaleBridge, inspectPortHolders }, { DEFAULT_PORT }] = await Promise.all([
    import("./index.mjs"),
    import("./ws-relay.mjs"),
  ]);
  const wsPort = deps.env.FIREFOX_BRIDGE_WS_PORT ? Number(deps.env.FIREFOX_BRIDGE_WS_PORT) : DEFAULT_PORT;
  const execOpts = deps.execFn ? { execFn: deps.execFn } : {};

  const health = await getHealth(settings, fetchFn);
  if (health) {
    stderr(`replacing running bridge (pid ${health.pid})\n`);
    try {
      killFn(health.pid, "SIGTERM");
    } catch (err) {
      if (err?.code !== "ESRCH") {
        throw new CliError(`could not signal bridge (pid ${health.pid}): ${err?.message ?? err}`);
      }
    }
    const deadline = Date.now() + 3000;
    while (await getHealth(settings, fetchFn)) {
      if (Date.now() > deadline) throw new CliError(`bridge (pid ${health.pid}) did not stop within 3s`);
      await new Promise((r) => setTimeout(r, pollMs));
    }
  }

  // A half-dead bridge can hold its ports while staying invisible to /health.
  for (const port of [wsPort, settings.ssePort]) {
    const { foreign } = killStaleBridge(port, { ...execOpts, killFn, log: (m) => stderr(`${m}\n`) });
    if (foreign.length) {
      throw new CliError(
        `port ${port} is held by non-bridge process(es) ${foreign.join(", ")} — refusing to kill; free the port first`,
      );
    }
  }
  const deadline = Date.now() + 3000;
  while (
    inspectPortHolders(wsPort, execOpts).length ||
    inspectPortHolders(settings.ssePort, execOpts).length
  ) {
    if (Date.now() > deadline) throw new CliError("previous bridge did not release its ports within 3s");
    await new Promise((r) => setTimeout(r, pollMs));
  }
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
    if (deps.replace) await replaceExistingBridge(settings, deps);
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
    try {
      process.kill(health.pid, "SIGTERM");
    } catch (err) {
      if (err?.code === "ESRCH") {
        stdout(`bridge already stopped (pid ${health.pid})\n`);
        return 0;
      }
      stderr(`could not signal bridge (pid ${health.pid}): ${err?.message ?? err}\n`);
      return 1;
    }
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
  const summary = await dispatch(settings, token, fetchFn, "get_tabs_summary", {}, undefined, {});
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
    killFn: overrides.killFn ?? ((pid, sig) => process.kill(pid, sig)),
    execFn: overrides.execFn,
    readFileFn: overrides.readFileFn ?? readFileSync,
    readStdin: overrides.readStdin ?? readStdinAll,
    waitPollMs: overrides.waitPollMs ?? 250,
    settleMs: overrides.settleMs ?? (() => 800 + Math.random() * 1700),
    env,
  };
  const settings = readSettings(env);

  let effectiveArgv = argv;
  try {
    effectiveArgv = await resolveJsSource(argv, deps);
  } catch (err) {
    deps.stderr(`${err.message}\n`);
    return err instanceof CliError ? err.exitCode : 1;
  }
  const parsed = parseCli(effectiveArgv);
  if (!parsed.ok) {
    deps.stderr(`${parsed.error}\n`);
    return 2;
  }
  if (parsed.kind === "help") {
    deps.stdout(`${usageText()}\n`);
    return 0;
  }
  deps.noAutostart = parsed.flags.noAutostart;
  deps.replace = parsed.flags.replace;

  try {
    const token = env.FIREFOX_BRIDGE_SSE_TOKEN || loadOrCreateToken({ tokenPath: settings.tokenFile });
    deps.token = token;

    if (parsed.kind === "lifecycle") return await runLifecycle(parsed.command, settings, deps);

    await ensureBridge(settings, deps);
    const envelope = { session: parsed.flags.session, profile: parsed.flags.profile };

    // Sessions live in the bridge, tabs in the extension: join them so `ff tabs`
    // shows which tabs other sessions own. Best-effort, a listing still prints.
    async function withSessionOwners(tabs, profile) {
      let sessions = [];
      try {
        ({ sessions = [] } = await dispatch(settings, token, deps.fetchFn, "session_list", {}, parsed.flags.timeout, {}));
      } catch {
        return tabs;
      }
      const live = sessions.filter((s) => s.live && (!profile || s.profile === profile));
      return tabs.map((t) => {
        const owner = live.find((s) => s.tabId === t.id);
        return owner ? { ...t, session: owner.name } : t;
      });
    }

    // `ff tabs` with no explicit --profile, against a bridge juggling several
    // connected profiles: the tool call comes back PROFILE_REQUIRED, so fan
    // the summary out across every connected profile instead of surfacing
    // that error to the user (every other command still sees it unchanged).
    async function renderTabsAcrossProfiles() {
      const { profiles } = await dispatch(settings, token, deps.fetchFn, "profiles_list", {}, parsed.flags.timeout, {});
      if (parsed.flags.json) {
        const jsonProfiles = [];
        for (const p of profiles) {
          const summary = await dispatch(settings, token, deps.fetchFn, "get_tabs_summary", {}, parsed.flags.timeout, { profile: p.name });
          jsonProfiles.push({ name: p.name, tabs: await withSessionOwners(summary?.tabs ?? [], p.name) });
        }
        deps.stdout(`${JSON.stringify({ profiles: jsonProfiles }, null, 2)}\n`);
        return;
      }
      const blocks = [];
      for (const p of profiles) {
        const summary = await dispatch(settings, token, deps.fetchFn, "get_tabs_summary", {}, parsed.flags.timeout, { profile: p.name });
        const lines = (await withSessionOwners(summary?.tabs ?? [], p.name)).map(formatTab);
        blocks.push(`[${p.name}]\n${lines.join("\n")}`);
      }
      deps.stdout(`${blocks.join("\n\n")}\n`);
    }

    const results = [];
    let prev = null;
    try {
      for (const step of parsed.steps) {
        const args = step.buildArgs ? step.buildArgs(prev) : step.args;
        if (args == null) {
          throw new CliError(`no matching element (${JSON.stringify(parsed.steps[0].args)})`);
        }
        try {
          prev = await dispatch(settings, token, deps.fetchFn, step.tool, args, parsed.flags.timeout, envelope);
        } catch (err) {
          if (step.tool === "get_containers" && /^UNKNOWN_TOOL:/.test(err?.message ?? "")) {
            throw new CliError("the Firefox extension predates container support: reload it (0.2.3+) and retry");
          }
          if (/group/.test(step.tool) && /^UNKNOWN_TOOL:/.test(err?.message ?? "")) {
            throw new CliError("the Firefox extension predates tab group support: reload it (0.2.5+) and retry");
          }
          throw err;
        }
        // A missed pointer action stops the composite here: the next step, or
        // the caller, would otherwise carry on as if it landed.
        const verb = POINTER_DONE[step.tool];
        if (verb && prev?.[verb] === false) {
          const hint = prev.hit ? ` (covered by ${prev.hit}; no events sent, --at X,Y acts on whatever is there)` : "";
          throw new CliError(`${parsed.command} failed at (${prev.x}, ${prev.y}): ${prev.reason}${hint}`);
        }
        // Same for a type whose text didn't land: exit nonzero, never "typed".
        if (step.tool === "type" && prev?.typed === false) {
          const now = prev.fieldNow != null ? ` (box now holds: ${JSON.stringify(prev.fieldNow)})` : "";
          throw new CliError(`type failed: ${prev.reason}${now}`);
        }
        results.push({ tool: step.tool, result: prev });
      }
    } catch (err) {
      if (parsed.command === "tabs" && !envelope.profile && err instanceof CliError && /^PROFILE_REQUIRED:/.test(err.message)) {
        await renderTabsAcrossProfiles();
        return 0;
      }
      throw err;
    }

    // --wait-for and --settle share one --wait-timeout budget (default 10 s).
    const waitMs = Number.isFinite(parsed.flags.waitTimeout) ? parsed.flags.waitTimeout : 10000;
    const wait = { ms: waitMs, deadline: Date.now() + waitMs };
    if (parsed.flags.waitFor) {
      await waitForSelector(settings, token, deps, parsed.flags, prev, envelope, wait);
    }
    if (parsed.flags.settle) {
      await waitForLoad(settings, token, deps, parsed.flags, prev, envelope, wait);
    }

    if (parsed.command === "open" && parsed.flags.as) {
      const opened = results[results.length - 1].result;
      const bound = await dispatch(
        settings, token, deps.fetchFn, "session_bind",
        { name: parsed.flags.as, tabId: opened.tabId }, parsed.flags.timeout, envelope,
      );
      deps.stdout(
        parsed.flags.json
          ? `${JSON.stringify(bound, null, 2)}\n`
          : `session ${bound.name} → tab ${bound.tabId} (profile ${bound.profile})${opened.container ? ` in container ${opened.container}` : ""}${opened.group != null ? ` in group ‹${opened.group}›` : ""}\n`,
      );
      return 0;
    }

    if (parsed.command === "tabs" && results[0].result?.tabs) {
      results[0].result.tabs = await withSessionOwners(results[0].result.tabs, parsed.flags.profile);
    }

    if (parsed.command === "screenshot") {
      const shot = results[results.length - 1].result;
      if (typeof shot?.dataUrl !== "string") throw new CliError("screenshot payload missing dataUrl");
      const out = parsed.flags.out ?? `firefox-${Date.now()}.${shot.format === "jpeg" ? "jpg" : "png"}`;
      writeFileSync(out, Buffer.from(stripDataUrlPrefix(shot.dataUrl), "base64"));
      // Dimensions are best-effort (the probe can't inject into about:* pages).
      const dims = shot.width != null && shot.height != null ? ` (${shot.width}x${shot.height})` : "";
      deps.stdout(`${resolve(out)}${dims}\n`);
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

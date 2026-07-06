#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync, statSync } from "node:fs";
import { dirname, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BENCH_DIR = resolve(ROOT, "bench");
const RESULTS_DIR = resolve(BENCH_DIR, "results");
const FIXTURE_DIR = resolve(BENCH_DIR, "fixtures");
const PLAYWRIGHT_BIN = resolve(ROOT, "node_modules", ".bin", process.platform === "win32" ? "playwright.cmd" : "playwright");
const OPS = ["open", "text", "links", "find", "js-title", "screenshot"];

export function approxTokens(bytes) {
  return bytes <= 0 ? 0 : Math.ceil(bytes / 4);
}

export function parseArgs(argv) {
  const parsed = { tools: ["ff", "playwright"], target: "local", out: null, repeat: 1 };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const [flag, inlineValue] = arg.startsWith("--") ? arg.split("=", 2) : [arg, undefined];
    const value = () => inlineValue ?? argv[++i];
    if (flag === "--tools") parsed.tools = value().split(",").map((s) => s.trim()).filter(Boolean);
    else if (flag === "--target") parsed.target = value();
    else if (flag === "--out") parsed.out = value();
    else if (flag === "--repeat") parsed.repeat = Number(value());
    else if (arg === "--help" || arg === "-h") parsed.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!["local", "example"].includes(parsed.target)) throw new Error("--target must be local or example");
  if (!Number.isInteger(parsed.repeat) || parsed.repeat < 1) throw new Error("--repeat must be a positive integer");
  return parsed;
}

export function recordFromResult({ tool, operation, target, command, result, started, ended, ok, notes = "", artifactPath = "" }) {
  const stdoutBytes = Buffer.byteLength(result.stdout ?? "");
  const stderrBytes = Buffer.byteLength(result.stderr ?? "");
  return {
    tool,
    operation,
    target,
    command,
    duration_ms: Number((ended - started) / 1_000_000n),
    exit_code: result.code,
    stdout_bytes: stdoutBytes,
    stderr_bytes: stderrBytes,
    approx_stdout_tokens: approxTokens(stdoutBytes),
    approx_stderr_tokens: approxTokens(stderrBytes),
    artifact_path: artifactPath,
    ok,
    notes,
  };
}

export function renderSummary(records) {
  const lines = [
    "| Tool | Operation | Target | OK | Duration ms | stdout bytes | stdout tokens | Notes |",
    "| --- | --- | --- | --- | ---: | ---: | ---: | --- |",
  ];
  for (const r of records) {
    lines.push(
      `| ${r.tool} | ${r.operation} | ${r.target} | ${r.ok ? "yes" : "no"} | ${r.duration_ms ?? ""} | ${r.stdout_bytes ?? 0} | ${r.approx_stdout_tokens ?? 0} | ${String(r.notes ?? "").replaceAll("|", "\\|")} |`,
    );
  }
  return lines.join("\n");
}

function usage() {
  return `browser-cli-surface benchmark

Usage:
  node bench/browser-cli-surface.mjs [--tools ff,playwright] [--target local|example] [--repeat N] [--out file.jsonl]
`;
}

function shellQuote(arg) {
  return /^[A-Za-z0-9_./:=@%+,-]+$/.test(arg) ? arg : `'${arg.replaceAll("'", "'\"'\"'")}'`;
}

function commandString(cmd, args) {
  return [cmd, ...args].map(shellQuote).join(" ");
}

function tail(text, max = 240) {
  const normalized = String(text ?? "").replace(/\s+/g, " ").trim();
  return normalized.length > max ? `${normalized.slice(0, max - 1)}...` : normalized;
}

function contentType(path) {
  if (extname(path) === ".html") return "text/html; charset=utf-8";
  if (extname(path) === ".js") return "text/javascript; charset=utf-8";
  if (extname(path) === ".css") return "text/css; charset=utf-8";
  return "application/octet-stream";
}

async function startFixtureServer() {
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const pathname = decodeURIComponent(url.pathname === "/" ? "/basic.html" : url.pathname);
      const path = resolve(FIXTURE_DIR, `.${pathname}`);
      if (!path.startsWith(`${FIXTURE_DIR}/`)) {
        res.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
        res.end("forbidden");
        return;
      }
      const data = await readFile(path);
      res.writeHead(200, { "content-type": contentType(path) });
      res.end(data);
    } catch {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end("not found");
    }
  });
  await new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const { port } = server.address();
  return {
    origin: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolveClose) => server.close(resolveClose)),
  };
}

async function targetFor(name) {
  if (name === "example") {
    return {
      name,
      url: "https://example.com",
      expectedHeading: "Example Domain",
      expectedLink: "Learn more",
      expectedTitle: "Example Domain",
      findCss: "h1",
      close: async () => {},
    };
  }
  const fixture = await startFixtureServer();
  return {
    name,
    url: `${fixture.origin}/basic.html`,
    expectedHeading: "Benchmark Fixture",
    expectedLink: "Example Link",
    expectedTitle: "Firefox MCP Benchmark Fixture",
    findCss: "h1",
    close: fixture.close,
  };
}

function runCommand(cmd, args, { env = {}, timeoutMs = 30_000 } = {}) {
  return new Promise((resolveCommand) => {
    let settled = false;
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const child = spawn(cmd, args, {
      cwd: ROOT,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveCommand({ stdout, stderr, timedOut, ...result });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => {
        if (!settled) child.kill("SIGKILL");
      }, 1000).unref();
    }, timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (err) => {
      stderr += err.message;
      finish({ code: 127, signal: null });
    });
    child.on("close", (code, signal) => {
      finish({ code: timedOut ? 124 : (code ?? 1), signal });
    });
  });
}

async function measureCommand({ tool, operation, target, cmd, args, validate, artifactPath = "", env = {}, timeoutMs }) {
  const started = process.hrtime.bigint();
  const result = await runCommand(cmd, args, { env, timeoutMs });
  const ended = process.hrtime.bigint();
  let ok = result.code === 0;
  let notes = "";
  if (ok && validate) {
    try {
      const validation = validate(result);
      ok = validation === true;
      if (!ok) notes = typeof validation === "string" ? validation : "expected output was not found";
    } catch (err) {
      ok = false;
      notes = err?.message ?? String(err);
    }
  } else if (!ok) {
    notes = result.timedOut ? "command timed out" : tail(result.stderr || result.stdout);
  }
  return recordFromResult({
    tool,
    operation,
    target: target.name,
    command: commandString(cmd, args),
    result,
    started,
    ended,
    ok,
    notes,
    artifactPath,
  });
}

function skippedRecord(tool, operation, target, notes) {
  return {
    tool,
    operation,
    target: target.name,
    command: "",
    duration_ms: 0,
    exit_code: null,
    stdout_bytes: 0,
    stderr_bytes: 0,
    approx_stdout_tokens: 0,
    approx_stderr_tokens: 0,
    artifact_path: "",
    ok: false,
    notes,
  };
}

async function runFf(target, context) {
  const session = `bench-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  const artifact = resolve(context.artifactsDir, `ff-${target.name}-${Date.now()}.png`);
  const records = [];
  try {
    records.push(await measureCommand({
      tool: "ff",
      operation: "open",
      target,
      cmd: "ff",
      args: ["open", target.url, "--as", session, "--wait-for", target.findCss, "--wait-timeout", "10000"],
      validate: (r) => r.stdout.includes(`session ${session}`) || "session binding was not printed",
      timeoutMs: 20_000,
    }));
    records.push(await measureCommand({
      tool: "ff",
      operation: "text",
      target,
      cmd: "ff",
      args: ["-s", session, "text", "--max", "1000"],
      validate: (r) => r.stdout.includes(target.expectedHeading) || `missing heading ${target.expectedHeading}`,
      timeoutMs: 15_000,
    }));
    records.push(await measureCommand({
      tool: "ff",
      operation: "links",
      target,
      cmd: "ff",
      args: ["-s", session, "links", "--max", "10"],
      validate: (r) => r.stdout.includes(target.expectedLink) || `missing link ${target.expectedLink}`,
      timeoutMs: 15_000,
    }));
    records.push(await measureCommand({
      tool: "ff",
      operation: "find",
      target,
      cmd: "ff",
      args: ["-s", session, "find", target.expectedHeading, "--css", target.findCss],
      validate: (r) => r.stdout.includes("found") && r.stdout.includes(target.expectedHeading) || `missing find result for ${target.expectedHeading}`,
      timeoutMs: 15_000,
    }));
    records.push(await measureCommand({
      tool: "ff",
      operation: "js-title",
      target,
      cmd: "ff",
      args: ["-s", session, "js", "document.title"],
      validate: (r) => r.stdout.trim() === target.expectedTitle || `expected title ${target.expectedTitle}`,
      timeoutMs: 15_000,
    }));
    records.push(await measureCommand({
      tool: "ff",
      operation: "screenshot",
      target,
      cmd: "ff",
      args: ["-s", session, "screenshot", "-o", artifact],
      artifactPath: artifact,
      validate: () => existsSync(artifact) && statSync(artifact).size > 0 || "screenshot artifact was not written",
      timeoutMs: 20_000,
    }));
  } finally {
    await runCommand("ff", ["-s", session, "tab", "close"], { timeoutMs: 10_000 });
  }
  return records;
}

async function runUnimplemented(tool, target) {
  return OPS.map((operation) =>
    skippedRecord(tool, operation, target, `${tool} adapter not implemented in this harness yet`),
  );
}

async function runPlaywright(target, context) {
  const records = [];
  for (const operation of OPS) {
    const artifact = resolve(context.artifactsDir, `playwright-${target.name}-${operation}-${Date.now()}.png`);
    records.push(await measureCommand({
      tool: "playwright",
      operation,
      target,
      cmd: PLAYWRIGHT_BIN,
      args: [
        "test",
        "bench/playwright-surface.spec.mjs",
        "--browser",
        "chromium",
        "--reporter",
        "line",
        "--workers",
        "1",
        "--timeout",
        "15000",
        "--output",
        resolve(RESULTS_DIR, "playwright-output"),
      ],
      env: {
        BENCH_OPERATION: operation,
        BENCH_URL: target.url,
        BENCH_EXPECTED_HEADING: target.expectedHeading,
        BENCH_EXPECTED_LINK: target.expectedLink,
        BENCH_EXPECTED_TITLE: target.expectedTitle,
        BENCH_ARTIFACT_PATH: artifact,
        PLAYWRIGHT_HTML_OPEN: "never",
      },
      artifactPath: operation === "screenshot" ? artifact : "",
      validate: (r) => {
        if (!r.stdout.includes("PW_BENCH_RESULT")) return "missing PW_BENCH_RESULT marker";
        if (operation === "screenshot" && (!existsSync(artifact) || statSync(artifact).size === 0)) {
          return "screenshot artifact was not written";
        }
        return true;
      },
      timeoutMs: 45_000,
    }));
  }
  return records;
}

async function runTool(tool, target, context) {
  if (tool === "ff") return runFf(target, context);
  if (tool === "playwright") return runPlaywright(target, context);
  return runUnimplemented(tool, target);
}

async function runBenchmark(argv = process.argv.slice(2)) {
  const parsed = parseArgs(argv);
  if (parsed.help) {
    process.stdout.write(usage());
    return { records: [], out: null };
  }
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const out = parsed.out ? resolve(ROOT, parsed.out) : resolve(RESULTS_DIR, `browser-cli-surface-${timestamp}.jsonl`);
  const artifactsDir = resolve(RESULTS_DIR, "artifacts");
  await mkdir(dirname(out), { recursive: true });
  await mkdir(artifactsDir, { recursive: true });

  const records = [];
  const target = await targetFor(parsed.target);
  try {
    for (let repeat = 0; repeat < parsed.repeat; repeat++) {
      for (const tool of parsed.tools) {
        records.push(...await runTool(tool, target, { artifactsDir, repeat }));
      }
    }
  } finally {
    await target.close();
  }

  await writeFile(out, `${records.map((r) => JSON.stringify(r)).join("\n")}\n`);
  process.stdout.write(`${renderSummary(records)}\n\nResults: ${out}\n`);
  return { records, out };
}

function invokedDirectly() {
  return process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

if (invokedDirectly()) {
  runBenchmark().catch((err) => {
    process.stderr.write(`${err?.stack ?? err}\n`);
    process.exitCode = 1;
  });
}

#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const DEFAULT_TOKEN_PATH = resolve(REPO_ROOT, ".firefox-bridge-token");

// A 256-bit token, hex-encoded. Long enough that guessing it is hopeless.
export function generateToken() {
  return randomBytes(32).toString("hex");
}

// Load the SSE token from tokenPath, creating and persisting one (owner-only)
// if the file is missing or blank. Stable across re-runs so the bridge and the
// Cowork plugin keep agreeing on the same secret.
export function loadOrCreateToken({
  tokenPath = DEFAULT_TOKEN_PATH,
  readFileFn = readFileSync,
  writeFileFn = writeFileSync,
  existsFn = existsSync,
  gen = generateToken,
} = {}) {
  if (existsFn(tokenPath)) {
    const existing = String(readFileFn(tokenPath, "utf8")).trim();
    if (existing) return existing;
  }
  const token = gen();
  writeFileFn(tokenPath, `${token}\n`, { mode: 0o600 });
  return token;
}

// The Cowork plugin's `.mcp.json`. When a token is supplied, the client must
// send it as an Authorization: Bearer header on every request.
export function pluginMcpJson({ url, token } = {}) {
  const server = { type: "http", url };
  if (token) server.headers = { Authorization: `Bearer ${token}` };
  return { mcpServers: { "firefox-bridge": server } };
}

// CLI used by scripts/setup-firefox-bridge.sh:
//   secure-config.mjs token            -> ensure + print the token
//   secure-config.mjs plugin <url>     -> print the plugin .mcp.json (bearer header from the token file)
function main(argv) {
  const [cmd, arg] = argv;
  if (cmd === "token") {
    process.stdout.write(`${loadOrCreateToken()}\n`);
    return;
  }
  if (cmd === "plugin") {
    if (!arg) throw new Error("usage: secure-config.mjs plugin <url>");
    // Header is included iff a token is in play (same env var as the bridge), so
    // the loopback/default mode emits a header-less plugin.
    const token = process.env.FIREFOX_BRIDGE_SSE_TOKEN || null;
    process.stdout.write(`${JSON.stringify(pluginMcpJson({ url: arg, token }), null, 2)}\n`);
    return;
  }
  throw new Error(`unknown command: ${cmd ?? "(none)"} — expected 'token' or 'plugin <url>'`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : err}\n`);
    process.exitCode = 1;
  }
}

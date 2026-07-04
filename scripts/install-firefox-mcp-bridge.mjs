#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const currentFilePath = fileURLToPath(import.meta.url);
const defaultRepoRoot = resolve(dirname(currentFilePath), "..");

export const MCP_SERVER_KEY = "firefox-bridge";

// Resolve Claude Desktop's config path per platform.
export function getClaudeDesktopConfigPath({ platform = process.platform, env = process.env } = {}) {
  const home = env.HOME || env.USERPROFILE || "";
  if (platform === "win32") {
    const appData = env.APPDATA || join(home, "AppData", "Roaming");
    return join(appData, "Claude", "claude_desktop_config.json");
  }
  if (platform === "darwin") {
    return join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json");
  }
  // linux / other
  const configHome = env.XDG_CONFIG_HOME || join(home, ".config");
  return join(configHome, "Claude", "claude_desktop_config.json");
}

// Pure read-merge: preserve every existing key, upsert only our server entry.
// serverEnv (optional) becomes the entry's `env` block — used to expose the SSE
// endpoint on a LAN host with a token. Omitted entirely when empty so the
// loopback-only default stays the simplest config.
export function upsertBridgeConfig(existing, bridgePath, serverEnv) {
  const config = existing && typeof existing === "object" ? { ...existing } : {};
  const mcpServers =
    config.mcpServers && typeof config.mcpServers === "object" ? { ...config.mcpServers } : {};
  const entry = { command: "node", args: [bridgePath] };
  if (serverEnv && Object.keys(serverEnv).length > 0) {
    entry.env = serverEnv;
  }
  mcpServers[MCP_SERVER_KEY] = entry;
  config.mcpServers = mcpServers;
  return config;
}

// Pick the SSE exposure vars (host + token) out of an environment, so the bridge
// Claude Desktop spawns inherits them. Only includes keys that are actually set.
export function bridgeServerEnv(env = {}) {
  const out = {};
  if (env.FIREFOX_BRIDGE_SSE_HOST) out.FIREFOX_BRIDGE_SSE_HOST = env.FIREFOX_BRIDGE_SSE_HOST;
  if (env.FIREFOX_BRIDGE_SSE_TOKEN) out.FIREFOX_BRIDGE_SSE_TOKEN = env.FIREFOX_BRIDGE_SSE_TOKEN;
  return out;
}

export async function installFirefoxMcpBridge({
  env = process.env,
  platform = process.platform,
  repoRoot = defaultRepoRoot,
  readFileFn = readFile,
  writeFileFn = writeFile,
  mkdirFn = mkdir,
  logFn = console.log,
} = {}) {
  const bridgePath = resolve(repoRoot, "firefox-mcp-bridge/index.mjs");
  if (!isAbsolute(bridgePath)) {
    throw new Error("bridge path must be absolute");
  }

  const configPath = getClaudeDesktopConfigPath({ platform, env });

  // Read-merge-write: never clobber a config we cannot parse.
  let existing = {};
  try {
    const raw = await readFileFn(configPath, "utf8");
    existing = JSON.parse(raw);
  } catch (err) {
    if (err && err.code === "ENOENT") {
      existing = {};
    } else {
      throw new Error(
        `Could not parse existing Claude config at ${configPath}: ${err?.message ?? err}`,
      );
    }
  }

  const config = upsertBridgeConfig(existing, bridgePath, bridgeServerEnv(env));

  await mkdirFn(dirname(configPath), { recursive: true });
  await writeFileFn(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");

  logFn(`Updated Claude Desktop config: ${configPath}`);
  logFn(`Registered MCP server "${MCP_SERVER_KEY}" -> node ${bridgePath}`);
  logFn("Restart Claude Desktop for the change to take effect.");

  return { configPath, bridgePath, config };
}

if (process.argv[1] && resolve(process.argv[1]) === currentFilePath) {
  installFirefoxMcpBridge().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}

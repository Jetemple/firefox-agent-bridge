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
export function upsertBridgeConfig(existing, bridgePath) {
  const config = existing && typeof existing === "object" ? { ...existing } : {};
  const mcpServers =
    config.mcpServers && typeof config.mcpServers === "object" ? { ...config.mcpServers } : {};
  mcpServers[MCP_SERVER_KEY] = { command: "node", args: [bridgePath] };
  config.mcpServers = mcpServers;
  return config;
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

  const config = upsertBridgeConfig(existing, bridgePath);

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

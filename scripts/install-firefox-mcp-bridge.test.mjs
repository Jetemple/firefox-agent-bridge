import test from "node:test";
import assert from "node:assert/strict";
import { isAbsolute } from "node:path";
import {
  MCP_SERVER_KEY,
  getClaudeDesktopConfigPath,
  upsertBridgeConfig,
  installFirefoxMcpBridge,
} from "./install-firefox-mcp-bridge.mjs";

test("getClaudeDesktopConfigPath returns the per-OS Claude config path", () => {
  assert.equal(
    getClaudeDesktopConfigPath({ platform: "darwin", env: { HOME: "/home/me" } }),
    "/home/me/Library/Application Support/Claude/claude_desktop_config.json",
  );
  // On a posix test runner path.join yields "/" separators; assert the tail.
  const win = getClaudeDesktopConfigPath({ platform: "win32", env: { APPDATA: "C:/Users/me/AppData/Roaming" } });
  assert.ok(win.includes("C:/Users/me/AppData/Roaming"));
  assert.ok(win.endsWith("Claude/claude_desktop_config.json"));
  const linux = getClaudeDesktopConfigPath({ platform: "linux", env: { HOME: "/home/me" } });
  assert.equal(linux, "/home/me/.config/Claude/claude_desktop_config.json");
});

test("upsertBridgeConfig preserves existing servers and other keys, upserts firefox-bridge", () => {
  const existing = {
    mcpServers: { other: { command: "x", args: ["y"] } },
    globalShortcut: "Cmd+Space",
  };
  const out = upsertBridgeConfig(existing, "/repo/firefox-mcp-bridge/index.mjs");
  assert.equal(out.globalShortcut, "Cmd+Space");
  assert.deepEqual(out.mcpServers.other, { command: "x", args: ["y"] });
  assert.deepEqual(out.mcpServers[MCP_SERVER_KEY], {
    command: "node",
    args: ["/repo/firefox-mcp-bridge/index.mjs"],
  });
  // does not mutate the input
  assert.equal(existing.mcpServers[MCP_SERVER_KEY], undefined);
});

test("upsertBridgeConfig tolerates a config with no mcpServers", () => {
  const out = upsertBridgeConfig({}, "/repo/firefox-mcp-bridge/index.mjs");
  assert.equal(out.mcpServers[MCP_SERVER_KEY].command, "node");
});

test("upsertBridgeConfig adds an env block when given server env", () => {
  const out = upsertBridgeConfig({}, "/repo/firefox-mcp-bridge/index.mjs", {
    FIREFOX_BRIDGE_SSE_HOST: "0.0.0.0",
    FIREFOX_BRIDGE_SSE_TOKEN: "tok",
  });
  assert.deepEqual(out.mcpServers[MCP_SERVER_KEY].env, {
    FIREFOX_BRIDGE_SSE_HOST: "0.0.0.0",
    FIREFOX_BRIDGE_SSE_TOKEN: "tok",
  });
});

test("upsertBridgeConfig omits the env block when server env is empty or absent", () => {
  const a = upsertBridgeConfig({}, "/repo/firefox-mcp-bridge/index.mjs");
  const b = upsertBridgeConfig({}, "/repo/firefox-mcp-bridge/index.mjs", {});
  assert.equal("env" in a.mcpServers[MCP_SERVER_KEY], false);
  assert.equal("env" in b.mcpServers[MCP_SERVER_KEY], false);
});

test("installFirefoxMcpBridge writes the SSE host+token env when both are set", async () => {
  const env = {
    HOME: "/home/secure",
    FIREFOX_BRIDGE_SSE_HOST: "0.0.0.0",
    FIREFOX_BRIDGE_SSE_TOKEN: "s3cret",
  };
  const configPath = getClaudeDesktopConfigPath({ platform: "darwin", env });
  const files = new Map();
  await installFirefoxMcpBridge({
    env,
    platform: "darwin",
    repoRoot: "/repo",
    readFileFn: async (p) => {
      if (files.has(p)) return files.get(p);
      const e = new Error("missing");
      e.code = "ENOENT";
      throw e;
    },
    writeFileFn: async (p, data) => files.set(p, data),
    mkdirFn: async () => {},
    logFn: () => {},
  });
  const bridge = JSON.parse(files.get(configPath)).mcpServers[MCP_SERVER_KEY];
  assert.deepEqual(bridge.env, {
    FIREFOX_BRIDGE_SSE_HOST: "0.0.0.0",
    FIREFOX_BRIDGE_SSE_TOKEN: "s3cret",
  });
});

test("installFirefoxMcpBridge writes no env block when no SSE vars are set", async () => {
  const env = { HOME: "/home/plain" };
  const configPath = getClaudeDesktopConfigPath({ platform: "darwin", env });
  const files = new Map();
  await installFirefoxMcpBridge({
    env,
    platform: "darwin",
    repoRoot: "/repo",
    readFileFn: async (p) => {
      if (files.has(p)) return files.get(p);
      const e = new Error("missing");
      e.code = "ENOENT";
      throw e;
    },
    writeFileFn: async (p, data) => files.set(p, data),
    mkdirFn: async () => {},
    logFn: () => {},
  });
  const bridge = JSON.parse(files.get(configPath)).mcpServers[MCP_SERVER_KEY];
  assert.equal("env" in bridge, false);
});

test("installFirefoxMcpBridge merges into an existing config and registers an absolute bridge path", async () => {
  const env = { HOME: "/home/test" };
  const configPath = getClaudeDesktopConfigPath({ platform: "darwin", env });
  const files = new Map([
    [configPath, JSON.stringify({ mcpServers: { keepme: { command: "k", args: [] } }, theme: "dark" })],
  ]);
  const log = [];

  const result = await installFirefoxMcpBridge({
    env,
    platform: "darwin",
    repoRoot: "/repo",
    readFileFn: async (p) => {
      if (files.has(p)) return files.get(p);
      const e = new Error("missing");
      e.code = "ENOENT";
      throw e;
    },
    writeFileFn: async (p, data) => files.set(p, data),
    mkdirFn: async () => {},
    logFn: (m) => log.push(m),
  });

  assert.equal(result.configPath, configPath);
  const written = JSON.parse(files.get(configPath));
  assert.equal(written.theme, "dark");
  assert.deepEqual(written.mcpServers.keepme, { command: "k", args: [] });
  const bridge = written.mcpServers[MCP_SERVER_KEY];
  assert.equal(bridge.command, "node");
  assert.ok(isAbsolute(bridge.args[0]));
  assert.ok(bridge.args[0].endsWith("/firefox-mcp-bridge/index.mjs"));
  assert.ok(files.get(configPath).endsWith("\n"));
});

test("installFirefoxMcpBridge creates a fresh config when none exists, and is idempotent", async () => {
  const env = { HOME: "/home/fresh" };
  const configPath = getClaudeDesktopConfigPath({ platform: "darwin", env });
  const files = new Map();
  const deps = {
    env,
    platform: "darwin",
    repoRoot: "/repo",
    readFileFn: async (p) => {
      if (files.has(p)) return files.get(p);
      const e = new Error("missing");
      e.code = "ENOENT";
      throw e;
    },
    writeFileFn: async (p, data) => files.set(p, data),
    mkdirFn: async () => {},
    logFn: () => {},
  };

  await installFirefoxMcpBridge(deps);
  const first = files.get(configPath);
  await installFirefoxMcpBridge(deps); // run again
  const second = files.get(configPath);

  assert.equal(first, second, "second run must be idempotent");
  const cfg = JSON.parse(second);
  assert.equal(Object.keys(cfg.mcpServers).length, 1);
  assert.ok(cfg.mcpServers[MCP_SERVER_KEY]);
});

test("installFirefoxMcpBridge refuses to clobber a malformed existing config", async () => {
  const env = { HOME: "/home/bad" };
  const configPath = getClaudeDesktopConfigPath({ platform: "darwin", env });
  const files = new Map([[configPath, "{ this is not json"]]);

  await assert.rejects(
    installFirefoxMcpBridge({
      env,
      platform: "darwin",
      repoRoot: "/repo",
      readFileFn: async (p) => files.get(p),
      writeFileFn: async () => {
        throw new Error("must not write");
      },
      mkdirFn: async () => {},
      logFn: () => {},
    }),
    /parse/i,
  );
});

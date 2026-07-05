import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { TOOLS } from "./tools.mjs";

const INDEX = resolve(dirname(fileURLToPath(import.meta.url)), "index.mjs");

async function waitUntil(fn, { timeout = 4000, interval = 20 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, interval));
  }
  throw new Error("waitUntil timed out");
}

test("speaks MCP over stdio and lists every tool", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ffmcp-"));
  const tokenFile = join(dir, "token");
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [INDEX],
    env: { ...getDefaultEnvironment(), FIREFOX_BRIDGE_WS_PORT: "0", FIREFOX_BRIDGE_SSE_PORT: "0", FIREFOX_BRIDGE_TOKEN_FILE: tokenFile },
  });
  const client = new Client({ name: "test", version: "0" });
  await client.connect(transport);
  try {
    const list = await client.listTools();
    assert.equal(list.tools.length, TOOLS.length);
    assert.ok(list.tools.some((t) => t.name === "ping_firefox"));
  } finally {
    await client.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("keeps stdout pure JSON-RPC (logs go to stderr) and exits 0 on SIGTERM", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ffmcp-"));
  const tokenFile = join(dir, "token");
  const child = spawn(process.execPath, [INDEX], {
    env: { ...process.env, FIREFOX_BRIDGE_WS_PORT: "0", FIREFOX_BRIDGE_SSE_PORT: "0", FIREFOX_BRIDGE_WS_TIMEOUT_MS: "200", FIREFOX_BRIDGE_TOKEN_FILE: tokenFile },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (d) => (stdout += d));
  child.stderr.on("data", (d) => (stderr += d));

  try {
    // Startup diagnostics must appear on stderr, never stdout.
    await waitUntil(() => stderr.toLowerCase().includes("listening"));
    assert.equal(stdout, "", "no diagnostics should reach stdout before any MCP traffic");

    // Drive one JSON-RPC request; the response is the only thing allowed on stdout.
    child.stdin.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "t", version: "0" },
        },
      }) + "\n",
    );
    await waitUntil(() => stdout.split("\n").some((l) => l.trim().length > 0));

    // Every non-empty stdout line must be valid JSON-RPC.
    for (const line of stdout.split("\n")) {
      if (!line.trim()) continue;
      const msg = JSON.parse(line);
      assert.equal(msg.jsonrpc, "2.0");
    }

    const exitCode = await new Promise((res) => {
      child.on("exit", (code) => res(code));
      child.kill("SIGTERM");
    });
    assert.equal(exitCode, 0);
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL");
    rmSync(dir, { recursive: true, force: true });
  }
});

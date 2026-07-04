import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readConfig } from "./index.mjs";
import { DEFAULT_TOKEN_PATH } from "../scripts/secure-config.mjs";

const INDEX = resolve(dirname(fileURLToPath(import.meta.url)), "index.mjs");

async function waitUntil(fn, { timeout = 4000, interval = 20 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, interval));
  }
  throw new Error("waitUntil timed out");
}

function freePort() {
  return new Promise((res, rej) => {
    const srv = createServer();
    srv.once("error", rej);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => res(port));
    });
  });
}

// --- readConfig: safe-by-default SSE ---

test("readConfig defaults SSE to a loopback bind with no token", () => {
  const cfg = readConfig({});
  assert.equal(cfg.sseHost, "127.0.0.1");
  assert.equal(cfg.sseToken, null);
});

test("readConfig reads an explicit SSE host and token from env", () => {
  const cfg = readConfig({
    FIREFOX_BRIDGE_SSE_HOST: "0.0.0.0",
    FIREFOX_BRIDGE_SSE_TOKEN: "s3cret",
  });
  assert.equal(cfg.sseHost, "0.0.0.0");
  assert.equal(cfg.sseToken, "s3cret");
});

test("readConfig defaults tokenFile to the repo token path", () => {
  const cfg = readConfig({});
  assert.equal(cfg.tokenFile, DEFAULT_TOKEN_PATH);
});

test("readConfig honors FIREFOX_BRIDGE_TOKEN_FILE", () => {
  const cfg = readConfig({ FIREFOX_BRIDGE_TOKEN_FILE: "/tmp/tok" });
  assert.equal(cfg.tokenFile, "/tmp/tok");
});

// --- end-to-end: the live SSE endpoint enforces the token ---

test("SSE endpoint returns 401 without a token and passes auth with it", async () => {
  const port = await freePort();
  const dir = mkdtempSync(join(tmpdir(), "ffmcp-"));
  const tokenFile = join(dir, "token");
  const child = spawn(process.execPath, [INDEX], {
    env: {
      ...process.env,
      FIREFOX_BRIDGE_STANDALONE: "1",
      FIREFOX_BRIDGE_WS_PORT: "0",
      FIREFOX_BRIDGE_SSE_PORT: String(port),
      FIREFOX_BRIDGE_SSE_TOKEN: "s3cret",
      FIREFOX_BRIDGE_TOKEN_FILE: tokenFile,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (d) => (stderr += d));

  try {
    await waitUntil(() => stderr.includes("SSE endpoint at"));
    const url = `http://127.0.0.1:${port}/mcp`;
    const body = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "t", version: "0" },
      },
    });
    const headers = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    };

    const noAuth = await fetch(url, { method: "POST", headers, body });
    await noAuth.body?.cancel?.();
    assert.equal(noAuth.status, 401, "request without a token must be rejected");

    const withAuth = await fetch(url, {
      method: "POST",
      headers: { ...headers, authorization: "Bearer s3cret" },
      body,
    });
    await withAuth.body?.cancel?.();
    assert.notEqual(withAuth.status, 401, "request with the right token must pass the auth gate");
  } finally {
    child.kill("SIGKILL");
    rmSync(dir, { recursive: true, force: true });
  }
});

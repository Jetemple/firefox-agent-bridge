import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { generateToken, loadOrCreateToken, pluginMcpJson } from "./secure-config.mjs";

const CLI = resolve(dirname(fileURLToPath(import.meta.url)), "secure-config.mjs");

test("generateToken returns a long random hex string that differs each call", () => {
  const a = generateToken();
  const b = generateToken();
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.notEqual(a, b);
});

test("loadOrCreateToken returns an existing non-empty token without regenerating", () => {
  let wrote = false;
  const token = loadOrCreateToken({
    tokenPath: "/x/.token",
    existsFn: () => true,
    readFileFn: () => "  existing-token\n",
    writeFileFn: () => {
      wrote = true;
    },
    gen: () => "NEW",
  });
  assert.equal(token, "existing-token");
  assert.equal(wrote, false, "must not overwrite an existing token");
});

test("loadOrCreateToken generates and persists a token (0600) when none exists", () => {
  const writes = [];
  const token = loadOrCreateToken({
    tokenPath: "/x/.token",
    existsFn: () => false,
    readFileFn: () => {
      throw new Error("should not read");
    },
    writeFileFn: (p, data, opts) => writes.push({ p, data, opts }),
    gen: () => "FRESH",
  });
  assert.equal(token, "FRESH");
  assert.equal(writes.length, 1);
  assert.equal(writes[0].p, "/x/.token");
  assert.match(writes[0].data, /FRESH/);
  assert.equal(writes[0].opts?.mode, 0o600, "token file must be written owner-only");
});

test("loadOrCreateToken regenerates when the existing file is blank", () => {
  const token = loadOrCreateToken({
    tokenPath: "/x/.token",
    existsFn: () => true,
    readFileFn: () => "   \n",
    writeFileFn: () => {},
    gen: () => "REGEN",
  });
  assert.equal(token, "REGEN");
});

test("pluginMcpJson omits headers when there is no token", () => {
  const out = pluginMcpJson({ url: "http://127.0.0.1:3003/mcp" });
  assert.deepEqual(out, {
    mcpServers: { "firefox-bridge": { type: "http", url: "http://127.0.0.1:3003/mcp" } },
  });
});

test("pluginMcpJson adds a bearer header when given a token", () => {
  const out = pluginMcpJson({ url: "http://10.0.0.63:3003/mcp", token: "s3cret" });
  assert.deepEqual(out.mcpServers["firefox-bridge"].headers, {
    Authorization: "Bearer s3cret",
  });
});

test("`plugin` CLI emits a bearer header only when FIREFOX_BRIDGE_SSE_TOKEN is set", () => {
  const url = "http://10.0.0.63:3003/mcp";

  const withTok = JSON.parse(
    execFileSync(process.execPath, [CLI, "plugin", url], {
      env: { ...process.env, FIREFOX_BRIDGE_SSE_TOKEN: "s3cret" },
      encoding: "utf8",
    }),
  );
  assert.equal(withTok.mcpServers["firefox-bridge"].headers.Authorization, "Bearer s3cret");

  const noTok = JSON.parse(
    execFileSync(process.execPath, [CLI, "plugin", url], {
      env: { ...process.env, FIREFOX_BRIDGE_SSE_TOKEN: "" },
      encoding: "utf8",
    }),
  );
  assert.equal("headers" in noTok.mcpServers["firefox-bridge"], false);
  assert.equal(noTok.mcpServers["firefox-bridge"].url, url);
});

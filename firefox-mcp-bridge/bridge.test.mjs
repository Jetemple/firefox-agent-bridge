import test from "node:test";
import assert from "node:assert/strict";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { createBridge } from "./bridge.mjs";
import { TOOLS } from "./tools.mjs";

async function connectClient(relay, opts = {}) {
  const server = createBridge({ relay, ...opts });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, server };
}

function fakeRelay({ clientCount = 0, dispatch } = {}) {
  return {
    clientCount: () => clientCount,
    dispatch: dispatch ?? (() => Promise.reject({ code: "NO_CLIENT", message: "No Firefox extension connected" })),
  };
}

function parseText(result) {
  return JSON.parse(result.content[0].text);
}

test("the bridge registers every tool defined in TOOLS", async () => {
  const { client, server } = await connectClient(fakeRelay());
  const list = await client.listTools();
  assert.equal(list.tools.length, TOOLS.length);
  await server.close();
});

test("ping_firefox is answered locally with connected:false, tabCount:null when no client", async () => {
  const { client, server } = await connectClient(fakeRelay({ clientCount: 0 }), {
    now: () => 1234,
    startedAt: 1000,
  });
  const res = await client.callTool({ name: "ping_firefox", arguments: {} });
  assert.equal(res.isError, undefined);
  const body = parseText(res);
  assert.equal(body.connected, false);
  assert.equal(body.tabCount, null);
  assert.equal(body.uptimeMs, 234);
  await server.close();
});

test("ping_firefox reports the live tab count when a client is connected", async () => {
  const relay = fakeRelay({
    clientCount: 1,
    dispatch: (tool) => {
      assert.equal(tool, "get_tabs_summary");
      return Promise.resolve({ tabs: [{ id: 1 }, { id: 2 }, { id: 3 }] });
    },
  });
  const { client, server } = await connectClient(relay);
  const body = parseText(await client.callTool({ name: "ping_firefox", arguments: {} }));
  assert.equal(body.connected, true);
  assert.equal(body.tabCount, 3);
  await server.close();
});

test("a WS tool whose dispatch rejects returns an isError result, not a throw", async () => {
  const relay = fakeRelay({
    clientCount: 0,
    dispatch: () => Promise.reject({ code: "NO_CLIENT", message: "No Firefox extension connected" }),
  });
  const { client, server } = await connectClient(relay);
  const res = await client.callTool({ name: "navigate", arguments: { url: "https://x.com" } });
  assert.equal(res.isError, true);
  assert.equal(res.content[0].text, "NO_CLIENT: No Firefox extension connected");
  await server.close();
});

test("a WS tool whose dispatch resolves returns the wrapped JSON text", async () => {
  const relay = fakeRelay({
    clientCount: 1,
    dispatch: (tool, args) => Promise.resolve({ tabId: args.tabId ?? 7, url: args.url }),
  });
  const { client, server } = await connectClient(relay);
  const body = parseText(await client.callTool({ name: "navigate", arguments: { url: "https://x.com" } }));
  assert.deepEqual(body, { tabId: 7, url: "https://x.com" });
  await server.close();
});

test("screenshot results are returned as an MCP image content block", async () => {
  const relay = fakeRelay({
    clientCount: 1,
    dispatch: () => Promise.resolve({ dataUrl: "data:image/png;base64,IMG", format: "png", width: 4, height: 2 }),
  });
  const { client, server } = await connectClient(relay);
  const res = await client.callTool({ name: "screenshot", arguments: { tabId: 1 } });
  assert.equal(res.content[0].type, "image");
  assert.equal(res.content[0].data, "IMG");
  assert.equal(res.content[0].mimeType, "image/png");
  await server.close();
});

test("tool schemas are strict: unknown or out-of-range args are rejected, not dropped", async () => {
  let dispatched = 0;
  const relay = fakeRelay({ clientCount: 1, dispatch: () => (dispatched++, Promise.resolve({})) });
  const { client, server } = await connectClient(relay);
  const list = await client.listTools();
  const nav = list.tools.find((t) => t.name === "navigate");
  assert.equal(nav.inputSchema.additionalProperties, false);
  assert.ok(nav.inputSchema.properties.url, "the strict object still advertises its properties");
  for (const [name, args] of [
    ["get_page_text", { maxLengthh: 10 }],
    ["get_page_text", { maxLength: -1 }],
    ["navigate", { url: "" }],
  ]) {
    const res = await client.callTool({ name, arguments: args });
    assert.equal(res.isError, true, `${name} ${JSON.stringify(args)}`);
  }
  assert.equal(dispatched, 0);
  await server.close();
});

// --- per-connection default tab ---
// Every MCP connection (one per agent) gets its own default tab, so two agents
// that both omit tabId never drive the same tab.

function recordingRelay(results = {}) {
  const calls = [];
  let next = 100;
  return {
    calls,
    clientCount: () => 1,
    dispatch: async (tool, args) => {
      calls.push({ tool, args });
      if (tool in results) {
        const r = results[tool](args);
        if (r instanceof Error) throw Object.assign(r, { code: r.message });
        return r;
      }
      if (tool === "navigate") return { tabId: args.tabId ?? next++, url: args.url };
      return { ok: true };
    },
  };
}

test("each MCP connection's first navigate opens its own tab, and later calls default to it", async () => {
  const relay = recordingRelay();
  const a = await connectClient(relay);
  const b = await connectClient(relay);
  await a.client.callTool({ name: "navigate", arguments: { url: "https://a.example" } });
  await b.client.callTool({ name: "navigate", arguments: { url: "https://b.example" } });
  await a.client.callTool({ name: "get_page_text", arguments: {} });
  await b.client.callTool({ name: "navigate", arguments: { url: "https://b2.example" } });
  assert.deepEqual(
    relay.calls.map((c) => [c.tool, c.args.tabId, c.args.ownTab]),
    [
      ["navigate", undefined, true],
      ["navigate", undefined, true],
      ["get_page_text", 100, undefined],
      ["navigate", 101, undefined],
    ],
  );
  await a.server.close();
  await b.server.close();
});

test("the default tab is sent with the Firefox run that issued it, and the run id stays out of results", async () => {
  // Firefox reissues tab ids on restart; the extension refuses a tabRun that isn't its own.
  const relay = recordingRelay({
    navigate: (args) => ({ tabId: args.tabId ?? 100, url: args.url, ...(args.ownTab ? { runId: "run-1" } : {}) }),
  });
  const { client, server } = await connectClient(relay);
  const opened = await client.callTool({ name: "navigate", arguments: { url: "https://a.example" } });
  assert.deepEqual(parseText(opened), { tabId: 100, url: "https://a.example" });
  await client.callTool({ name: "get_page_text", arguments: {} });
  await client.callTool({ name: "click", arguments: { tabId: 7, x: 1, y: 2 } });
  assert.deepEqual(relay.calls[1].args, { tabId: 100, tabRun: "run-1" });
  assert.deepEqual(relay.calls[2].args, { tabId: 7, x: 1, y: 2 }, "an explicit tab carries no run");
  await server.close();
});

test("an extension that reports no run id gets no tabRun", async () => {
  const relay = recordingRelay();
  const { client, server } = await connectClient(relay);
  await client.callTool({ name: "navigate", arguments: { url: "https://a.example" } });
  await client.callTool({ name: "get_page_text", arguments: {} });
  assert.deepEqual(relay.calls[1].args, { tabId: 100 });
  await server.close();
});

test("onTabUsed hears each tab a call lands on, but not a close", async () => {
  const relay = recordingRelay();
  const used = [];
  const { client, server } = await connectClient(relay, { onTabUsed: (id) => used.push(id) });
  await client.callTool({ name: "navigate", arguments: { url: "https://a.example" } });
  await client.callTool({ name: "get_page_text", arguments: {} });
  await client.callTool({ name: "click", arguments: { tabId: 7, x: 1, y: 2 } });
  await client.callTool({ name: "close_tab", arguments: {} });
  assert.deepEqual(used, [100, 100, 7]);
  await server.close();
});

test("an explicit tabId is passed through untouched", async () => {
  const relay = recordingRelay();
  const { client, server } = await connectClient(relay);
  await client.callTool({ name: "navigate", arguments: { url: "https://a.example" } });
  await client.callTool({ name: "click", arguments: { tabId: 7, x: 1, y: 2 } });
  assert.deepEqual(relay.calls[1].args, { tabId: 7, x: 1, y: 2 });
  await server.close();
});

test("a tab-targeting call before this connection's first navigate fails instead of using another agent's tab", async () => {
  const relay = recordingRelay();
  const { client, server } = await connectClient(relay);
  const res = await client.callTool({ name: "click", arguments: { x: 1, y: 2 } });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /NO_AGENT_TAB/);
  assert.equal(relay.calls.length, 0, "nothing reached Firefox");
  await server.close();
});

test("after its default tab is closed, the next navigate opens a fresh one", async () => {
  const relay = recordingRelay({
    navigate: (args) => (args.tabId === 100 ? new Error("TAB_NOT_FOUND") : { tabId: 200, url: args.url }),
  });
  const { client, server } = await connectClient(relay);
  // First navigate: the stub answers 200 for a fresh tab; pretend that id was 100.
  relay.calls.length = 0;
  await client.callTool({ name: "navigate", arguments: { url: "https://a.example" } });
  await client.callTool({ name: "close_tab", arguments: {} });
  const res = await client.callTool({ name: "navigate", arguments: { url: "https://b.example" } });
  assert.equal(res.isError, undefined);
  assert.deepEqual(
    relay.calls.map((c) => [c.tool, c.args.tabId, c.args.ownTab]),
    [
      ["navigate", undefined, true],
      ["close_tab", 200, undefined],
      ["navigate", undefined, true],
    ],
  );
  await server.close();
});

test("a navigate whose default tab vanished retries once in a fresh tab", async () => {
  let first = true;
  const relay = recordingRelay({
    navigate: (args) => {
      if (args.ownTab) return { tabId: first ? ((first = false), 100) : 300, url: args.url };
      return new Error("TAB_NOT_FOUND");
    },
  });
  const { client, server } = await connectClient(relay);
  await client.callTool({ name: "navigate", arguments: { url: "https://a.example" } });
  const res = await client.callTool({ name: "navigate", arguments: { url: "https://b.example" } });
  assert.equal(parseText(res).tabId, 300);
  await client.callTool({ name: "get_page_text", arguments: {} });
  assert.equal(relay.calls.at(-1).args.tabId, 300);
  await server.close();
});

test("the server sends usage rules as MCP instructions, so every client gets them", async () => {
  const { client, server } = await connectClient(fakeRelay());
  const text = client.getInstructions();
  assert.match(text, /signed-in/);
  assert.match(text, /navigate/);
  assert.match(text, /activate_tab/);
  assert.match(text, /without asking/);
  await server.close();
});

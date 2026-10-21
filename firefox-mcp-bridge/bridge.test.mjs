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
  const res = await client.callTool({ name: "screenshot", arguments: {} });
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

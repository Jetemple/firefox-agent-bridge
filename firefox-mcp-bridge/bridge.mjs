import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { TOOLS } from "./tools.mjs";
import { toCallToolResult, toErrorResult } from "./result.mjs";

export const SERVER_NAME = "firefox-bridge";
export const SERVER_VERSION = "0.1.0";

// Sent to every MCP client at connect (clients show it to the model), so the
// rules hold whichever agent runtime is driving, not only ones with a rules file.
export const SERVER_INSTRUCTIONS = [
  "This drives the user's real, signed-in Firefox. Your tabs open in the agent window, a separate Firefox window behind the user's apps; never change what the user is looking at.",
  "Start with navigate (no tabId): it opens a tab for this session in the agent window, and later calls without a tabId use that tab. Pass tabId only for a tab you opened (navigate or open_tab) or one the user asked you to use.",
  "Don't call activate_tab or open_tab with active:true unless the user asks to see a tab: they take the user's focus, and do nothing unless the user allowed that in the extension panel.",
  "Close only your own tabs when done (close_tab with no tabId closes this session's tab).",
  "Don't send messages, post, buy, or submit forms for the user without asking.",
].join("\n");

// Tools whose tabId defaults to the agent's tab when omitted.
const TAB_TARGETING = new Set(TOOLS.filter((t) => t.inputSchema && "tabId" in t.inputSchema).map((t) => t.name));

// createBridge wires the tools onto an McpServer. It does not own a transport
// — index.mjs connects it to StdioServerTransport; tests connect it to an
// InMemoryTransport. `relay` provides clientCount() and dispatch(tool, args).
export function createBridge({
  relay,
  name = SERVER_NAME,
  version = SERVER_VERSION,
  startedAt = Date.now(),
  now = () => Date.now(),
  // Called with the tab id each time a call lands on a tab, so the owner's
  // idle sweep knows the tab is in use.
  onTabUsed = () => {},
} = {}) {
  const server = new McpServer({ name, version }, { instructions: SERVER_INSTRUCTIONS });

  // This connection's default tab. One bridge serves one MCP connection (one
  // agent), so agents that omit tabId each drive their own tab instead of the
  // extension's single shared agent tab. Opened by the first navigate.
  // defaultTabRun is the extension run that issued the id: Firefox reissues
  // tab ids when it restarts, so the id is sent back with its run (tabRun) and
  // the extension refuses it if it has restarted since.
  let defaultTabId = null;
  let defaultTabRun = null;

  // Fill in the default tab for a call that omits tabId. Returns the args to
  // send, or null when the call needs a tab and this connection has none yet.
  function withDefaultTab(toolName, args) {
    if (!TAB_TARGETING.has(toolName) || args.tabId != null || args.tabIds != null) return args;
    if (defaultTabId != null) {
      return { ...args, tabId: defaultTabId, ...(defaultTabRun != null ? { tabRun: defaultTabRun } : {}) };
    }
    // ownTab: a fresh tab in the agent window for this connection, not the shared one.
    if (toolName === "navigate") return { ...args, ownTab: true };
    return null;
  }

  async function dispatchDefaulted(toolName, args) {
    const sent = withDefaultTab(toolName, args);
    if (sent == null) {
      throw {
        code: "NO_AGENT_TAB",
        message: "No tab yet for this session — call navigate first (it opens a tab in the agent window), or pass the tabId from open_tab",
      };
    }
    const usedDefault = sent !== args && sent.tabId != null;
    try {
      let result = await relay.dispatch(toolName, sent);
      if (toolName === "navigate" && sent.ownTab && result?.tabId != null) {
        // runId is for this bookkeeping only, not for the agent.
        const { runId, ...rest } = result;
        defaultTabId = result.tabId;
        defaultTabRun = runId ?? null;
        result = rest;
      }
      // A navigate can land on a replacement tab id; keep following it.
      else if (usedDefault && toolName === "navigate" && result?.tabId != null) defaultTabId = result.tabId;
      if (usedDefault && toolName === "close_tab") defaultTabId = null;
      const usedTab = sent.tabId ?? result?.tabId;
      if (typeof usedTab === "number" && toolName !== "close_tab") onTabUsed(usedTab);
      return result;
    } catch (err) {
      if (usedDefault && err?.code === "TAB_NOT_FOUND") {
        defaultTabId = null;
        // The default tab is gone (closed by the user or another tool): a
        // navigate just opens a fresh one; anything else reports the error.
        if (toolName === "navigate") return dispatchDefaulted(toolName, args);
      }
      throw err;
    }
  }

  // Dispatch a WS tool and wrap the reply, converting expected { code, message }
  // rejections into isError results (so the model can self-correct) rather than
  // throwing. Only rejections without a code propagate as INTERNAL.
  async function dispatchAndWrap(toolName, args) {
    try {
      const wsResult = await dispatchDefaulted(toolName, args);
      return toCallToolResult(toolName, wsResult);
    } catch (err) {
      if (err && err.code) {
        return toErrorResult(err.code, err.message ?? "");
      }
      return toErrorResult("INTERNAL", err instanceof Error ? err.message : String(err));
    }
  }

  // ping_firefox is bridge-local: it must answer even with no extension attached.
  async function pingHandler() {
    const connected = relay.clientCount() > 0;
    let tabCount = null;
    if (connected) {
      try {
        // Short budget: ping must stay cheap even if the extension is wedged
        // (connected but not replying). `connected` already reflects the socket.
        const summary = await relay.dispatch("get_tabs_summary", {}, { timeoutMs: 1500 });
        tabCount = Array.isArray(summary?.tabs) ? summary.tabs.length : null;
      } catch {
        tabCount = null;
      }
    }
    return toCallToolResult("ping_firefox", {
      connected,
      tabCount,
      uptimeMs: now() - startedAt,
    });
  }

  for (const tool of TOOLS) {
    const opts = { description: tool.description };
    // strict: the advertised additionalProperties:false is actually enforced.
    if (tool.inputSchema) opts.inputSchema = z.object(tool.inputSchema).strict();

    let handler;
    if (tool.name === "ping_firefox") {
      handler = pingHandler;
    } else if (tool.inputSchema) {
      // First arg is the parsed args object.
      handler = (args) => dispatchAndWrap(tool.name, args ?? {});
    } else {
      // No inputSchema: the SDK passes `extra` as the first arg, so ignore it.
      handler = () => dispatchAndWrap(tool.name, {});
    }

    server.registerTool(tool.name, opts, handler);
  }

  return server;
}

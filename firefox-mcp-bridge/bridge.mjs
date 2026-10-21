import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { TOOLS } from "./tools.mjs";
import { toCallToolResult, toErrorResult } from "./result.mjs";

export const SERVER_NAME = "firefox-bridge";
export const SERVER_VERSION = "0.1.0";

// createBridge wires the tools onto an McpServer. It does not own a transport
// — index.mjs connects it to StdioServerTransport; tests connect it to an
// InMemoryTransport. `relay` provides clientCount() and dispatch(tool, args).
export function createBridge({
  relay,
  name = SERVER_NAME,
  version = SERVER_VERSION,
  startedAt = Date.now(),
  now = () => Date.now(),
} = {}) {
  const server = new McpServer({ name, version });

  // Dispatch a WS tool and wrap the reply, converting expected { code, message }
  // rejections into isError results (so the model can self-correct) rather than
  // throwing. Only rejections without a code propagate as INTERNAL.
  async function dispatchAndWrap(toolName, args) {
    try {
      const wsResult = await relay.dispatch(toolName, args);
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

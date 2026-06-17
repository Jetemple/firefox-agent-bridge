import { z } from "zod";

// Tool definitions for the Firefox MCP bridge.
//
// `inputSchema` is a Zod *raw shape* (Record<string, ZodType>) or `undefined`.
// McpServer.registerTool throws on raw JSON Schema and on an empty `{}` shape,
// so no-arg tools (ping_firefox, get_tabs_summary) omit inputSchema entirely.
//
// ping_firefox is answered bridge-locally; the other 7 are dispatched to the
// Firefox extension over the WebSocket relay (see WS_TOOL_NAMES).

const tabId = z.number().describe("Optional: tab ID. Defaults to the active tab.").optional();

export const TOOLS = [
  {
    name: "ping_firefox",
    description:
      "Health check — returns whether a Firefox extension is connected, the tab count, and bridge uptime.",
    inputSchema: undefined,
  },
  {
    name: "get_tabs_summary",
    description:
      "Returns a summary of all open browser tabs (id, url, title, active, pinned, windowId).",
    inputSchema: undefined,
  },
  {
    name: "navigate",
    description:
      "Navigate an existing tab to a URL or open a new one. Specify tabId to reuse an existing tab; omit to open a new tab.",
    inputSchema: {
      url: z.string().describe("URL to navigate to (with or without protocol)"),
      tabId: z
        .number()
        .describe("Optional: ID of existing tab to navigate. If omitted, opens a new tab.")
        .optional(),
    },
  },
  {
    name: "screenshot",
    description:
      "Capture a screenshot of a tab's visible viewport. Returns a PNG/JPEG image. Note: passing tabId activates and focuses that tab before capture.",
    inputSchema: {
      tabId,
      format: z.enum(["png", "jpeg"]).describe("Image format. Default: png.").optional(),
      quality: z
        .number()
        .min(0)
        .max(100)
        .describe("JPEG quality 0-100. Ignored for PNG. Default: 92.")
        .optional(),
    },
  },
  {
    name: "get_page_text",
    description: "Extract visible text content from the page.",
    inputSchema: {
      tabId,
      maxLength: z
        .number()
        .describe("Optional: truncate text to this many characters.")
        .optional(),
    },
  },
  {
    name: "click",
    description:
      "Click at coordinates (x, y) on the current page. Coordinates are viewport-relative pixels.",
    inputSchema: {
      tabId,
      x: z.number().describe("X coordinate in viewport pixels"),
      y: z.number().describe("Y coordinate in viewport pixels"),
    },
  },
  {
    name: "type",
    description: "Type text into the currently focused element on the page.",
    inputSchema: {
      tabId,
      text: z.string().describe("Text to type"),
      clearFirst: z
        .boolean()
        .describe("Clear existing field content before typing. Default: false.")
        .optional(),
    },
  },
  {
    name: "javascript_tool",
    description: "Execute JavaScript in the context of the page and return the result.",
    inputSchema: {
      tabId,
      code: z
        .string()
        .describe("JavaScript code to execute. Use document.body.innerText for page text."),
      world: z
        .enum(["ISOLATED", "MAIN"])
        .describe(
          "Execution world. ISOLATED = content script sandbox (default), MAIN = page's own JS context (Firefox 128+).",
        )
        .optional(),
    },
  },
  {
    name: "close_tab",
    description: "Close a tab. Specify tabId; omit to close the active tab.",
    inputSchema: { tabId },
  },
  {
    name: "activate_tab",
    description: "Bring a tab to the foreground (activate it and focus its window).",
    inputSchema: { tabId },
  },
  {
    name: "reload",
    description: "Reload a tab. Omit tabId to reload the active tab.",
    inputSchema: {
      tabId,
      bypassCache: z
        .boolean()
        .describe("Bypass the cache (hard reload). Default: false.")
        .optional(),
    },
  },
  {
    name: "back",
    description: "Navigate a tab back in its session history. Omit tabId for the active tab.",
    inputSchema: { tabId },
  },
  {
    name: "forward",
    description: "Navigate a tab forward in its session history. Omit tabId for the active tab.",
    inputSchema: { tabId },
  },
];

// Tools dispatched to the Firefox extension over the WebSocket relay.
// ping_firefox is intentionally excluded — it is handled entirely in the bridge.
export const WS_TOOL_NAMES = TOOLS.map((t) => t.name).filter((n) => n !== "ping_firefox");

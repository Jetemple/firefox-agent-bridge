import { z } from "zod";
import { SESSION_NAME_RE } from "./sessions.mjs";

// Tool definitions for the Firefox MCP bridge.
//
// `inputSchema` is a Zod *raw shape* (Record<string, ZodType>) or `undefined`.
// McpServer.registerTool throws on raw JSON Schema and on an empty `{}` shape,
// so no-arg tools (ping_firefox, get_tabs_summary) omit inputSchema entirely.
//
// ping_firefox is answered bridge-locally; every other tool is dispatched to
// the Firefox extension over the WebSocket relay (see WS_TOOL_NAMES). Both the
// MCP server and /dispatch validate with these shapes in strict mode, so an
// unknown argument is rejected rather than silently dropped.

const tabId = z
  .number()
  .describe("Optional: tab ID. Defaults to the agent tab (the one navigate drives); the active tab before the first navigate.")
  .optional();

const tabIds = z
  .array(z.number())
  .min(1)
  .describe("Optional: several tab IDs (overrides tabId).")
  .optional();
const groupName = z.string().trim().min(1).max(100);
const groupColor = z.enum(["grey", "blue", "red", "yellow", "green", "pink", "purple", "cyan", "orange"]);

// Coordinates are relative to `frameId`'s viewport. Pass find_element's frameId
// and ref straight through to the pointer tools.
const frameId = z
  .number()
  .describe("Optional: find_element's frameId. x/y are then relative to that iframe.")
  .optional();
const ref = z
  .string()
  .describe("Optional: find_element's ref. Fails instead of acting if another element covers the target.")
  .optional();

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
      "Returns a summary of all open browser tabs (id, url, title, active, pinned, windowId; agent: true marks the agent tab; container names the Firefox container a tab is in; group names its tab group).",
    inputSchema: undefined,
  },
  {
    name: "get_containers",
    description:
      "Lists the Firefox containers (name, cookieStoreId, color, icon). Pass a name to open_tab's container to open a tab in it.",
    inputSchema: undefined,
  },
  {
    name: "get_tab_groups",
    description: "Lists Firefox's native tab groups (id, title, color, collapsed, windowId, tabIds).",
    inputSchema: undefined,
  },
  {
    name: "group_tabs",
    description:
      "Put tabs in a tab group by title: joins the group with that title (case-insensitive) or creates it. Never changes the active tab. Omit tabId/tabIds for the agent tab.",
    inputSchema: {
      group: groupName.describe("Group title to join or create."),
      tabId,
      tabIds,
      color: groupColor.describe("Optional: set the group's color.").optional(),
      collapsed: z.boolean().describe("Optional: collapse (true) or expand (false) the group.").optional(),
    },
  },
  {
    name: "ungroup_tabs",
    description: "Take tabs out of their tab group. Omit tabId/tabIds for the agent tab.",
    inputSchema: { tabId, tabIds },
  },
  {
    name: "navigate",
    description:
      "Load a URL without switching the user's view. Omit tabId to drive the agent tab (reused across calls; opened in the background if needed); specify tabId to navigate that tab.",
    inputSchema: {
      url: z.string().min(1).describe("URL to navigate to (with or without protocol)"),
      tabId: z
        .number()
        .describe("Optional: ID of an existing tab to navigate. If omitted, uses the agent tab.")
        .optional(),
    },
  },
  {
    name: "open_tab",
    description:
      "Open a URL in a new tab WITHOUT focusing it (set active: true to focus). Returns the new tabId.",
    inputSchema: {
      url: z.string().min(1).describe("URL to open (with or without protocol)"),
      active: z
        .boolean()
        .describe("Focus the new tab. Default: false — agents must not steal the user's focus.")
        .optional(),
      label: z
        .string()
        .regex(SESSION_NAME_RE)
        .describe("Short name shown in the tab strip as \"🤖 label · title\".")
        .optional(),
      container: z
        .string()
        .min(1)
        .describe("Optional: Firefox container to open the tab in, by name (case-insensitive) or cookieStoreId. See get_containers.")
        .optional(),
      group: groupName.describe("Optional: tab group to put the new tab in, joined by title (case-insensitive) or created.").optional(),
      groupColor: groupColor.describe("Optional: color for the group (applies to an existing group too).").optional(),
    },
  },
  {
    name: "screenshot",
    description:
      "Capture a screenshot of a tab's visible viewport. Returns a PNG/JPEG image. Works on background tabs without switching to them.",
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
    description: "Extract visible text content from the page, including open and closed shadow roots and iframes.",
    inputSchema: {
      tabId,
      maxLength: z
        .number()
        .int()
        .min(0)
        .describe("Optional: truncate text to this many characters.")
        .optional(),
    },
  },
  {
    name: "click",
    description:
      "Click at coordinates (x, y) on the current page. Coordinates are viewport-relative pixels. A point over an iframe clicks inside it. clicked: true means events were dispatched, not that the page reacted.",
    inputSchema: {
      tabId,
      x: z.number().describe("X coordinate in viewport pixels"),
      y: z.number().describe("Y coordinate in viewport pixels"),
      frameId,
      ref,
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
      maxLength: z
        .number()
        .int()
        .min(1)
        .describe("Cap the result at this many characters (JSON text for non-strings). Default: 50000.")
        .optional(),
    },
  },
  {
    name: "close_tab",
    description: "Close a tab. Omit tabId to close the agent tab.",
    inputSchema: { tabId },
  },
  {
    name: "activate_tab",
    description: "Bring a tab to the foreground (activate it and focus its window). The only tool that changes what the user sees; omit tabId to show the agent tab.",
    inputSchema: { tabId },
  },
  {
    name: "reload",
    description: "Reload a tab. Omit tabId for the agent tab.",
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
    description: "Navigate a tab back in its session history. Omit tabId for the agent tab.",
    inputSchema: { tabId },
  },
  {
    name: "forward",
    description: "Navigate a tab forward in its session history. Omit tabId for the agent tab.",
    inputSchema: { tabId },
  },
  {
    name: "press_key",
    description:
      "Dispatch a key press to the focused element (e.g. 'Enter', 'Escape', 'Tab', 'ArrowDown', or a single character). Synthetic event — drives page handlers, not native browser shortcuts.",
    inputSchema: {
      tabId,
      key: z.string().describe("Key value, e.g. 'Enter', 'Escape', 'ArrowDown', or 'a'."),
      ctrl: z.boolean().describe("Hold Ctrl. Default: false.").optional(),
      alt: z.boolean().describe("Hold Alt. Default: false.").optional(),
      shift: z.boolean().describe("Hold Shift. Default: false.").optional(),
      meta: z.boolean().describe("Hold Meta/Cmd. Default: false.").optional(),
    },
  },
  {
    name: "scroll",
    description:
      "Scroll the page by a pixel delta (dx/dy), or scroll an element into view by CSS selector.",
    inputSchema: {
      tabId,
      dx: z.number().describe("Horizontal pixels to scroll by. Default: 0.").optional(),
      dy: z
        .number()
        .describe("Vertical pixels to scroll by (positive = down). Default: 0.")
        .optional(),
      selector: z
        .string()
        .describe("If given, scroll this element into view instead of by delta.")
        .optional(),
    },
  },
  {
    name: "hover",
    description: "Move the pointer over the element at viewport coordinates (x, y).",
    inputSchema: {
      tabId,
      x: z.number().describe("X coordinate in viewport pixels"),
      y: z.number().describe("Y coordinate in viewport pixels"),
      frameId,
      ref,
    },
  },
  {
    name: "double_click",
    description: "Double-click at viewport coordinates (x, y).",
    inputSchema: {
      tabId,
      x: z.number().describe("X coordinate in viewport pixels"),
      y: z.number().describe("Y coordinate in viewport pixels"),
      frameId,
      ref,
    },
  },
  {
    name: "right_click",
    description: "Right-click (open the context menu) at viewport coordinates (x, y).",
    inputSchema: {
      tabId,
      x: z.number().describe("X coordinate in viewport pixels"),
      y: z.number().describe("Y coordinate in viewport pixels"),
      frameId,
      ref,
    },
  },
  {
    name: "drag",
    description: "Press at (fromX, fromY), move, and release at (toX, toY).",
    inputSchema: {
      tabId,
      fromX: z.number().describe("Source X in viewport pixels"),
      fromY: z.number().describe("Source Y in viewport pixels"),
      toX: z.number().describe("Destination X in viewport pixels"),
      toY: z.number().describe("Destination Y in viewport pixels"),
    },
  },
  {
    name: "select_option",
    description:
      "Choose an <option> in a <select>. Match by `value` or by visible `label` (provide at least one).",
    inputSchema: {
      tabId,
      selector: z.string().describe("CSS selector for the <select> element"),
      value: z.string().describe("Option value to select.").optional(),
      label: z
        .string()
        .describe("Visible option text to select (used if value is omitted).")
        .optional(),
    },
  },
  {
    name: "set_checkbox",
    description: "Set a checkbox or radio input's checked state by CSS selector.",
    inputSchema: {
      tabId,
      selector: z.string().describe("CSS selector for the checkbox/radio input"),
      checked: z.boolean().describe("Desired checked state"),
    },
  },
  {
    name: "find_element",
    description:
      "Find the first visible element matching a CSS selector and/or visible text, returning its center (x, y) so you can click/hover it. Searches shadow roots and iframes; pass the returned frameId and ref to the click/hover call. Provide selector, text, or both.",
    inputSchema: {
      tabId,
      text: z
        .string()
        .describe("Visible text (or aria-label, or placeholder) to match, case-insensitive.")
        .optional(),
      selector: z
        .string()
        .describe("CSS selector to match (scopes the search when combined with text).")
        .optional(),
    },
  },
  {
    name: "get_links",
    description: "List the page's links as { text, href }.",
    inputSchema: {
      tabId,
      max: z.number().int().min(0).describe("Maximum number of links to return.").optional(),
    },
  },
  {
    name: "get_tables",
    description: "Extract the page's tables as arrays of rows of cell text.",
    inputSchema: {
      tabId,
      max: z.number().int().min(0).describe("Maximum number of tables to return.").optional(),
    },
  },
];

// Tools dispatched to the Firefox extension over the WebSocket relay.
// ping_firefox is intentionally excluded — it is handled entirely in the bridge.
export const WS_TOOL_NAMES = TOOLS.map((t) => t.name).filter((n) => n !== "ping_firefox");

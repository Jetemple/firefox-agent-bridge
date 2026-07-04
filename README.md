# firefox-mcp

Drive your **real, logged-in Firefox** from any MCP client.

firefox-mcp is a small local MCP server plus a Firefox WebExtension. Together they
let an MCP client (Claude Desktop, Cowork, or anything that speaks MCP) control the
Firefox you already use — your existing sessions, cookies, logins, history, and
installed extensions.

## Why

Most agent-browser tools spin up a *fresh, throwaway* browser that's logged into
nothing — great for clean-room automation and testing. firefox-mcp does the opposite,
and that's the point: it acts **as you, in the browser you're already signed into**.

> "Open my Gmail and summarize the top thread" just works — because it's *your* Firefox,
> already logged in.

It's not a replacement for clean-room tools like Playwright; it's the answer to a
different question. And it's a Firefox answer in a space that's almost entirely
Chrome-centric.

## How it works

```
MCP client ──▶ bridge ──▶ WebSocket (127.0.0.1:3002) ──▶ extension ──▶ Firefox
```

- **Bridge** (`firefox-mcp-bridge/`) — a Node MCP server. One process serves two
  transports: stdio + WebSocket on `127.0.0.1:3002` (for Claude Desktop and the
  extension relay) and StreamableHTTP/SSE on `127.0.0.1:3003` (for HTTP clients
  like Cowork).
- **Extension** (`firefox-extension/`) — a WebExtension that receives tool calls over
  the WebSocket and executes them with `browser.*` APIs and injected page functions.

## Install

Requires Node.js and Firefox.

```bash
npm run setup
```

`scripts/setup-firefox-bridge.sh` installs the bridge's dependencies, registers the
bridge with Claude Desktop, builds the Cowork plugin, and health-checks the ports.
Two steps are manual (they're GUI actions the script can't do, and it prints both):

1. **Firefox** → `about:debugging#/runtime/this-firefox` → *Load Temporary Add-on…* →
   pick `firefox-extension/manifest.json`.
2. **Cowork** (optional) → Settings → *Upload local plugin* → pick the generated
   `firefox-bridge.plugin`. See [Security](#security) first — remote clients require a token.

Restart Claude Desktop afterward so it spawns the bridge.

## Security

The SSE/HTTP endpoint can drive your logged-in browser — including running arbitrary
JavaScript on your pages (`javascript_tool`) — so it is **locked to localhost by
default** (`127.0.0.1:3003`). In the default configuration nothing on your network can
reach it.

To use a client that connects over the network (such as Cowork, which reaches the host
over its LAN IP), opt in to LAN exposure — which **always** comes with a token:

```bash
FIREFOX_BRIDGE_EXPOSE=1 npm run setup
```

That one command generates a 256-bit token (stored in `.firefox-bridge-token`, which is
gitignored), binds the SSE endpoint on `0.0.0.0`, requires the token on every request,
and rebuilds `firefox-bridge.plugin` with a matching `Authorization` header. There is no
way to expose the endpoint **without** a token through the script.

Under the hood the bridge reads two env vars (set for you by the script, e.g. in the
Claude Desktop server entry's `env`):

```bash
FIREFOX_BRIDGE_SSE_HOST=0.0.0.0
FIREFOX_BRIDGE_SSE_TOKEN=<the-generated-secret>
```

A client then presents the token on every request — either an `Authorization: Bearer
<token>` header (what the generated Cowork plugin uses) or a `?token=<token>` query
parameter. If you manually bind a non-loopback host **without** a token, the bridge
still starts but logs a loud warning — don't do that.

**WebSocket relay:** the `127.0.0.1:3002` relay (bridge ↔ extension) rejects WebSocket
connections whose `Origin` is a web page (`http(s)://…`), so a malicious site you visit
can't open `ws://127.0.0.1:3002` and hijack the relay. The extension (a
`moz-extension://` origin) is unaffected.

### Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `FIREFOX_BRIDGE_WS_PORT` | `3002` | WebSocket port (Desktop + extension relay) |
| `FIREFOX_BRIDGE_WS_HOST` | `127.0.0.1` | WebSocket bind address |
| `FIREFOX_BRIDGE_SSE_PORT` | `3003` | StreamableHTTP/SSE port |
| `FIREFOX_BRIDGE_SSE_HOST` | `127.0.0.1` | SSE bind address — set `0.0.0.0` to expose (use a token!) |
| `FIREFOX_BRIDGE_SSE_TOKEN` | _(none)_ | Require this bearer/query token on SSE requests |
| `FIREFOX_BRIDGE_EXPOSE` | `0` | `1` → `npm run setup` provisions secure LAN exposure (token + header) |
| `FIREFOX_BRIDGE_WS_ALLOW_ANY_ORIGIN` | `0` | `1` → disable the WS origin guard (debug escape hatch) |

## Tools

24 tools across four groups:

- **Status / tabs** — `ping_firefox`, `get_tabs_summary`, `close_tab`, `activate_tab`,
  `reload`, `back`, `forward`
- **Navigation / capture** — `navigate`, `screenshot`, `get_page_text`
- **Interaction** — `click`, `type`, `press_key`, `scroll`, `hover`, `double_click`,
  `right_click`, `drag`, `select_option`, `set_checkbox`
- **Queries / scripting** — `find_element`, `get_links`, `get_tables`, `javascript_tool`

## Status & caveats

- The extension currently loads as a **temporary** add-on, so it drops when Firefox
  restarts and must be re-loaded from `about:debugging`. A signed/permanent package is
  not done yet.
- `navigate` and `click` are **fire-and-forget** — they return when the action is
  initiated, without waiting for the page to finish loading or settling. Add your own
  read-back (e.g. `get_page_text`) when you need to be sure a step landed.
- Mouse and keyboard tools dispatch synthetic DOM events: they drive page handlers, not
  native browser chrome.

## Development

```bash
cd firefox-mcp-bridge && npm install
npm test          # from the repo root: runs the bridge + scripts unit tests
```

Add a tool: define it in `firefox-mcp-bridge/tools.mjs`, add a handler file under
`firefox-extension/tools/`, register the handler in the extension manifest, and add
tests. A parity test enforces that the bridge and extension expose the same tool names.

## License

MIT — see [LICENSE](LICENSE).

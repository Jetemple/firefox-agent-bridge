# firefox-mcp

Drive your **real, logged-in Firefox** from any coding agent or MCP client.

Two front doors, one bridge, one extension:

- **`ff` CLI** — for TUI agents (Claude Code, codex, gemini, anything with a
  shell). No MCP config at all: the agent just runs `ff nav`, `ff text`,
  `ff click`.
- **MCP** — stdio for Claude Desktop, StreamableHTTP for Cowork (and any HTTP
  MCP client), multiple sessions at once.

```
Claude Desktop ──stdio/MCP──▶ bridge (owner :3002/:3003) ◀──ws── Firefox extension
Cowork ─────────HTTP /mcp───▶   │
Claude Code ──── ff … ──────────┤  /health + /dispatch (loopback, token)
codex / gemini ─ ff … ──────────┘
```

The first bridge instance owns both ports; extra instances (a second MCP
client, the CLI's auto-start) detect it via `/health` and forward through it
instead of fighting over the ports. If the owner quits, a follower takes over
in-process and the extension reconnects — nothing restarts.

## Quickstart

```bash
npm run setup        # deps, Claude Desktop config, Cowork plugin, `ff` on PATH
```

then load the extension: Firefox → `about:debugging#/runtime/this-firefox` →
*Load Temporary Add-on…* → `firefox-extension/manifest.json`, and try:

```bash
ff status            # bridge + extension state
ff tabs              # list your tabs
ff nav example.com   # open a page
ff text              # read it
```

The bridge auto-starts on demand (`~/.firefox-mcp/bridge.log`); `ff start` /
`ff stop` control it manually.

## Using it from a coding agent

Drop this in your `CLAUDE.md` / `AGENTS.md`:

```markdown
## Firefox
You can drive my real, logged-in Firefox with the `ff` CLI (run `ff --help` once).
Read: `ff tabs`, `ff text`, `ff links`, `ff find <text>`, `ff screenshot -o x.png`
Act:  `ff nav <url>`, `ff click <visible text>`, `ff type <field label> <text>`,
      `ff key Enter`, `ff scroll --dy 600`, `ff js <code>`
Targeting is by visible text (add `--css <sel>` to scope, `--at X,Y` for raw
coordinates). `navigate`/`click` are fire-and-forget — verify with `ff text`.
Commands run in your own background tab (🤖), never the one I'm viewing; use
`--here` only when I ask about the page I'm on.
```

### The agent tab

`ff` never switches the tab you're looking at or raises a Firefox window.
`ff nav <url>` opens a background tab the first time (stamped 🤖 in the tab
strip) and reuses it after that; `ff text`, `ff click`, `ff screenshot` and
the rest act on it by default. `--here` targets the tab you're viewing instead,
and `ff tab activate` brings the agent tab into view when you want to watch.
If you close the agent tab, commands error until the next `ff nav` rather than
falling through to your tab.

Some extensions reopen a tab under a new id as it loads; container extensions
do this to sites they assign to a container. `ff` follows the swap, and
`ff open`/`ff nav` report the id the page ended up in. When you're done,
`ff tab close --mine` closes every tab the agent opened except the one you're
viewing (`--dry-run` lists them first). It only knows about tabs opened since
the extension last started, and it covers every agent's tabs, not just yours.

## Sessions & profiles

Multiple agents (or one agent juggling tabs) can each pin a named session to a
tab, so nothing ever depends on which tab you happen to be looking at:

```bash
ff open https://docs.example --as research   # background tab, never steals focus
ff -s research text                          # every command can target the session
ff -s research tab close                     # closes the tab and the session
```

Sessions fail safe: if Firefox restarted or the tab is gone you get
SESSION_STALE — never a command silently running against the wrong tab.

Run several Firefox profiles at once and name each one (once, per profile):

```bash
ff profiles name work        # with one profile connected
ff --profile work nav https://mail.example
ff tabs                      # more than one profile? tabs come grouped
```

With one profile connected, nothing changes — name flags are only needed when
two Firefoxes are up.

## CLI reference

Run `ff --help` for the one-screen version. Highlights:

| | |
| --- | --- |
| `ff status` / `start` / `stop` / `ping` | bridge lifecycle & health |
| `ff tabs`, `ff tab close\|activate [--tab N]`, `ff tab close --mine [--dry-run]` | tab management |
| `ff nav <url>`, `ff reload [--hard]`, `ff back`, `ff forward` | navigation |
| `ff text`, `ff links`, `ff tables`, `ff find <text>` | reading pages |
| `ff screenshot [-o f.png] [--jpeg]` | capture (writes a file, prints the path) |
| `ff click\|hover\|dblclick\|rclick <query> [--css SEL] \| --at X,Y` | pointer (query = visible text) |
| `ff type <query> <text> [--clear]`, `ff type <text> --focused` | typing |
| `ff key <key>`, `ff scroll --dy N \| --into <css>`, `ff drag --from X,Y --to X,Y` | input |
| `ff select <css> <val> [--by-text]`, `ff check\|uncheck <css>` | forms |
| `ff js <code>` | run JavaScript in the page |

Global flags: `--tab N`, `--json`, `--timeout MS`, `--no-autostart`.
Exit codes: 0 ok · 1 tool/bridge error · 2 usage.

## MCP clients

- **Claude Desktop** — `npm run setup` registers the stdio server; restart
  Desktop afterward.
- **Cowork** — `FIREFOX_BRIDGE_EXPOSE=1 npm run setup`, then upload the
  generated `firefox-bridge.plugin` (Settings → Upload local plugin). See
  [Security](#security).
- **Any HTTP MCP client** — point it at `http://127.0.0.1:3003/mcp`. Multiple
  concurrent sessions are supported.

## Why

Most agent-browser tools spin up a *fresh, throwaway* browser that's logged into
nothing — great for clean-room automation and testing. firefox-mcp does the opposite,
and that's the point: it acts **as you, in the browser you're already signed into**.

> "Open my Gmail and summarize the top thread" just works — because it's *your* Firefox,
> already logged in.

It's not a replacement for clean-room tools like Playwright; it's the answer to a
different question. And it's a Firefox answer in a space that's almost entirely
Chrome-centric.

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

**`/dispatch` (the CLI's endpoint)** is defense-in-depth hardened: it always
requires the local token (auto-provisioned 0600 file — web pages can't read
it), rejects any web-page `Origin`, requires exact `application/json` (so a
cross-origin page can't even send a no-preflight "simple" request that
matters), only accepts loopback connections regardless of the bind host, and
validates every tool name and argument against the same schemas as MCP before
anything reaches Firefox. `/health` exposes only name/version/pid/startedAt/connected.

### Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `FIREFOX_BRIDGE_WS_PORT` | `3002` | WebSocket port (Desktop + extension relay) |
| `FIREFOX_BRIDGE_WS_HOST` | `127.0.0.1` | WebSocket bind address |
| `FIREFOX_BRIDGE_SSE_PORT` | `3003` | StreamableHTTP/SSE port |
| `FIREFOX_BRIDGE_SSE_HOST` | `127.0.0.1` | SSE bind address — set `0.0.0.0` to expose (use a token!) |
| `FIREFOX_BRIDGE_SSE_TOKEN` | _(none)_ | Require this bearer/query token on SSE requests |
| `FIREFOX_BRIDGE_TOKEN_FILE` | `.firefox-bridge-token` | Path to local token file (0600, prevents web access) |
| `FIREFOX_BRIDGE_LOG_DIR` | `~/.firefox-mcp` | Directory for bridge logs (`bridge.log`) |
| `FIREFOX_BRIDGE_EXPOSE` | `0` | `1` → `npm run setup` provisions secure LAN exposure (token + header) |
| `FIREFOX_BRIDGE_WS_ALLOW_ANY_ORIGIN` | `0` | `1` → disable the WS origin guard (debug escape hatch) |

## Status & caveats

- A **temporary** add-on drops when Firefox restarts. For a permanent install, sign
  your own copy (see *Permanent install* below).
- `navigate` and `click` are **fire-and-forget** — they return when the action is
  initiated, without waiting for the page to finish loading or settling. Add your own
  read-back (e.g. `get_page_text`) when you need to be sure a step landed.
- Mouse and keyboard tools dispatch synthetic DOM events: they drive page handlers, not
  native browser chrome.
- `find_element`, `get_page_text`, the pointer tools, `type` and `press_key` reach into
  iframes and shadow roots (open and closed). `get_links`, `get_tables`, `javascript_tool`,
  `drag`, `scroll`, `select_option` and `set_checkbox` stay in the top frame's light DOM.
- A successful `click` means events were dispatched. A click aimed through `find_element`'s
  `ref` fails if another element covers the target; `tabHidden: true` flags a background tab,
  where some pages ignore clicks.

## Permanent install

Release Firefox only installs signed extensions. Mozilla signs unlisted (self-distributed)
add-ons automatically, usually within minutes:

1. Get API credentials at <https://addons.mozilla.org/developers/addon/api/key/> and
   export them as `WEB_EXT_API_KEY` (the JWT issuer) and `WEB_EXT_API_SECRET`.
2. If you forked this repo, change `browser_specific_settings.gecko.id` in
   `firefox-extension/manifest.json`: an add-on id belongs to the account that first
   signed it.
3. `npm run sign`, then open the `.xpi` from `web-ext-artifacts/` in Firefox (or drag it
   onto a window) and approve the install. Remove the temporary copy from
   `about:debugging` first.

Each upload needs a new `version` in the manifest, so bump it before signing again.

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

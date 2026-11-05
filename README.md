# Agent Bridge for Firefox

Lets coding agents and MCP clients drive the Firefox you're already signed into, in
background tabs, without touching the tab you're looking at.

Two ways in, sharing one local bridge and one extension:

- **`ff` CLI** for any agent with a shell (Claude Code, Codex, Gemini CLI). No MCP config.
- **MCP server**: stdio for Claude Desktop, Streamable HTTP at `/mcp` for Cowork and any
  HTTP MCP client.

```
Claude Desktop ──stdio/MCP──▶ bridge (:3002/:3003) ◀──ws── Firefox extension
Cowork ─────────HTTP /mcp───▶   │
Claude Code ──── ff … ──────────┤  /health + /dispatch (loopback, token)
codex / gemini ─ ff … ──────────┘
```

> **Trust:** anything that can run `ff` or reach the MCP endpoint can act as you on every
> site you're signed into, including running JavaScript in your pages. Only connect agents
> you trust. Everything binds to localhost by default; see [Security](#security).

## Requirements

- Firefox 142 or newer
- Node.js 20 or newer
- Tested on macOS and Linux. `--cowork` setup is macOS-only; Windows is untested.

## Install

```bash
git clone https://github.com/Jetemple/firefox-agent-bridge.git
cd firefox-agent-bridge
npm run setup                # deps, and `ff` on your PATH
```

`npm run setup -- --desktop` also registers the MCP server with Claude Desktop;
`--cowork` does that plus LAN exposure for Cowork (see [MCP clients](#mcp-clients)).

Then load the extension: Firefox → `about:debugging#/runtime/this-firefox` →
*Load Temporary Add-on…* → `firefox-extension/manifest.json`. A temporary add-on goes away
when Firefox restarts; see [Permanent install](#permanent-install). Try it:

```bash
ff status            # bridge + extension state
ff tabs              # list your tabs
ff nav example.com   # open a page in a background tab
ff text              # read it
```

The bridge starts on demand (log: `~/.firefox-mcp/bridge.log`); `ff start` / `ff stop`
control it by hand.

## Using it from a coding agent

An agent working in this repo (to set it up for you or change it) should read
[AGENTS.md](AGENTS.md). For day-to-day use, drop this in your `CLAUDE.md` / `AGENTS.md`:

```markdown
## Firefox
You can drive my real, logged-in Firefox with the `ff` CLI (run `ff --help` once).
Read: `ff tabs`, `ff text`, `ff links`, `ff find <text>`, `ff screenshot -o x.png`
Act:  `ff nav <url>`, `ff click <visible text>`, `ff type <field label> <text>`,
      `ff key Enter`, `ff scroll --dy 600`, `ff js <code>`
Targeting is by visible text (add `--css <sel>` to scope, `--at X,Y` for raw
coordinates). `navigate`/`click` are fire-and-forget, so verify with `ff text`.
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

Agents forget, so the bridge also sweeps: every 5 minutes it closes tabs an
agent opened (or a session owns) that no command has touched for 2 hours. It
never closes the tab you're viewing, a pinned tab, or the reused 🤖 tab, and it
drops session records whose tab is gone. `FIREFOX_BRIDGE_AGENT_TAB_IDLE_MS`
changes the cutoff; `0` turns the sweep off.

### Containers

`ff containers` lists your Firefox containers. `ff open <url> --container
Gmail` opens the page in one, matched by name (case-insensitive) or by its
`firefox-container-N` id; an unknown name fails without opening anything.
The reply names the container the tab actually landed in, since an "always
open in" rule can move it. `ff tabs` marks container tabs `{Gmail}`. An open
tab can't change containers, so to keep working in one, name a session:
`ff open <url> --container Gmail --as mail`, then `ff -s mail <command>`.

### Tab groups

Firefox's native tab groups. `ff open <url> --group "TV hunt"`
opens the page straight into the group with that title (case-insensitive),
creating it if there's none; add `--color` to set its color (grey, blue, red,
yellow, green, pink, purple, cyan, orange). `ff group <name> [TAB_ID...]`
moves open tabs in (no ids: `--tab N`, `--here`, `-s NAME`, or the agent tab),
`--collapse`/`--expand` folds the group, and `ff ungroup [TAB_ID...]` takes
tabs out. `ff groups` lists them, and `ff tabs` marks grouped tabs `‹TV hunt›`.
Grouping never changes which tab you're viewing. Pinned tabs can't join a group.

## Sessions & profiles

Multiple agents (or one agent juggling tabs) can each pin a named session to a
tab, so nothing ever depends on which tab you happen to be looking at:

```bash
ff open https://docs.example --as research   # background tab, never steals focus
ff -s research text                          # every command can target the session
ff -s research tab close                     # closes the tab and the session
```

Sessions fail safe: if Firefox restarted or the tab is gone you get
SESSION_STALE, never a command silently running against the wrong tab.

Run several Firefox profiles at once and name each one (once, per profile):

```bash
ff profiles name work        # with one profile connected
ff --profile work nav https://mail.example
ff tabs                      # more than one profile? tabs come grouped
```

With one profile connected, nothing changes: name flags are only needed when
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

- **Claude Desktop:** `npm run setup -- --desktop` registers the stdio server; restart
  Desktop afterward.
- **Cowork:** `npm run setup -- --cowork`, then upload the generated
  `firefox-bridge.plugin` (Settings → Upload local plugin). This exposes the bridge on your
  LAN behind a token; see [Security](#security).
- **Any HTTP MCP client:** point it at `http://127.0.0.1:3003/mcp`. Multiple concurrent
  sessions are supported.

The first bridge instance owns both ports. Extra instances (a second MCP client, the CLI's
auto-start) find it through `/health` and forward through it. If the owner quits, a
follower takes over in-process and the extension reconnects.

## Security

- **Localhost by default.** The HTTP endpoint binds `127.0.0.1:3003`; nothing on your
  network can reach it.
- **LAN exposure always has a token.** `--cowork` generates a 256-bit token
  (`.firefox-bridge-token`, gitignored), binds `0.0.0.0`, requires the token on every
  request (`Authorization: Bearer <token>` or `?token=`), and bakes the header into the
  Cowork plugin. The setup script can't expose the endpoint without one. If you bind a
  non-loopback host by hand (`FIREFOX_BRIDGE_SSE_HOST`) without `FIREFOX_BRIDGE_SSE_TOKEN`,
  the bridge starts anyway and logs a warning. Don't.
- **WebSocket relay** (`127.0.0.1:3002`, bridge ↔ extension) rejects connections whose
  `Origin` is a web page, so a site you visit can't hijack it.
- **`/dispatch`** (the CLI's endpoint) accepts only loopback connections, requires the local
  token (an owner-only file web pages can't read), rejects web-page origins, requires exact
  `application/json`, and validates every tool name and argument against the MCP schemas.
- **`/health`** exposes only name, version, pid, start time, and connection state.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `FIREFOX_BRIDGE_WS_PORT` | `3002` | WebSocket port (Desktop + extension relay) |
| `FIREFOX_BRIDGE_WS_HOST` | `127.0.0.1` | WebSocket bind address |
| `FIREFOX_BRIDGE_SSE_PORT` | `3003` | Streamable HTTP port |
| `FIREFOX_BRIDGE_SSE_HOST` | `127.0.0.1` | HTTP bind address: set `0.0.0.0` to expose (use a token!) |
| `FIREFOX_BRIDGE_SSE_TOKEN` | _(none)_ | Require this bearer/query token on HTTP requests |
| `FIREFOX_BRIDGE_TOKEN_FILE` | `.firefox-bridge-token` | Path to local token file (0600, prevents web access) |
| `FIREFOX_BRIDGE_LOG_DIR` | `~/.firefox-mcp` | Directory for bridge logs (`bridge.log`) |
| `FIREFOX_BRIDGE_EXPOSE` | `0` | `1` is the same as `npm run setup -- --cowork` |
| `FIREFOX_BRIDGE_WS_ALLOW_ANY_ORIGIN` | `0` | `1` → disable the WS origin guard (debug escape hatch) |
| `FIREFOX_BRIDGE_AGENT_TAB_IDLE_MS` | `7200000` | Close agent tabs idle this long (ms); `0` disables the sweep |

## Caveats

- `navigate` and `click` are **fire-and-forget**: they return when the action is
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
2. Change `browser_specific_settings.gecko.id` in `firefox-extension/manifest.json` to
   your own: an add-on id belongs to the account that first signed it.
3. `npm run sign`, then open the `.xpi` from `web-ext-artifacts/` in Firefox (or drag it
   onto a window) and approve the install. Remove the temporary copy from
   `about:debugging` first.

Each upload needs a new `version` in the manifest, so bump it before signing again.

## Development

```bash
npm install --prefix firefox-mcp-bridge
npm test                 # bridge, extension, and bench unit tests
npm run lint:extension   # web-ext lint
```

Add a tool: define it in `firefox-mcp-bridge/tools.mjs`, add a handler under
`firefox-extension/tools/`, register it in the extension manifest, and add tests. A parity
test checks that the bridge and the extension expose the same tool names.

The extension's `manifest.json` version is the one that matters for releases; the
`package.json` versions are internal.

## License

MIT, see [LICENSE](LICENSE).

# Agent Bridge for Firefox

Let coding agents and MCP clients drive the Firefox you're signed into, in background
tabs, without touching the tab you're on. Use the `ff` CLI from any shell agent, or connect
an MCP client.

> **Trust:** anything that can run `ff` or reach the MCP endpoint can act as you on every
> site you're signed into. Only connect agents you trust.

**Requires** Firefox 142+ and Node 20+. Tested on macOS and Linux.

## Install

```bash
git clone https://github.com/Jetemple/firefox-agent-bridge.git
cd firefox-agent-bridge
npm run setup        # deps + `ff` on PATH; add `-- --desktop` or `-- --cowork` for those apps
```

Install the signed extension from the [latest release](https://github.com/Jetemple/firefox-agent-bridge/releases/latest)
(open the `.xpi` in Firefox). Working on the extension itself? Load it temporarily instead:
`about:debugging#/runtime/this-firefox` → *Load Temporary Add-on…* →
`firefox-extension/manifest.json`. Then:

```bash
ff status            # bridge + extension
ff nav example.com   # opens in a background 🤖 tab
ff text              # read it
```

Run `ff --help` for every command.

## Tell your agent

Add to your `CLAUDE.md` / `AGENTS.md`:

```markdown
You can drive my logged-in Firefox with `ff` (run `ff --help` once). It works in its
own background tab; use `--here` only when I ask about the page I'm on. `nav` and
`click` don't wait, so verify with `ff text`.
```

To have an agent set this up or change the code, point it at [AGENTS.md](AGENTS.md).

## MCP clients

- **Claude Desktop:** `npm run setup -- --desktop`, then restart Desktop.
- **Cowork:** `npm run setup -- --cowork`, then upload `firefox-bridge.plugin`. This exposes
  the bridge on your LAN behind a token.
- **Anything else:** `http://127.0.0.1:3003/mcp` (Streamable HTTP).

## Security

- Binds localhost only by default. LAN exposure (`--cowork`) always uses a token.
- The extension relay and the CLI endpoint reject requests from web pages.
- Sites can detect it: input events are synthetic (`isTrusted: false`) and the agent tab's
  title starts with 🤖.

## Configuration

| Env var | Default | |
| --- | --- | --- |
| `FIREFOX_BRIDGE_WS_PORT` / `_SSE_PORT` | `3002` / `3003` | extension relay / HTTP MCP ports |
| `FIREFOX_BRIDGE_SSE_HOST` | `127.0.0.1` | HTTP bind address; pair `0.0.0.0` with a token |
| `FIREFOX_BRIDGE_SSE_TOKEN` | none | required bearer token for HTTP |
| `FIREFOX_BRIDGE_AGENT_TAB_IDLE_MS` | 2 hours | close idle agent tabs; `0` disables |
| `FIREFOX_BRIDGE_LOG_DIR` | `~/.firefox-mcp` | bridge log location |

## Permanent install

To sign your own build, get AMO API keys, export
`WEB_EXT_API_KEY` / `WEB_EXT_API_SECRET`, set your own `gecko.id` in the manifest, and run
`npm run sign`. Open the `.xpi` from `web-ext-artifacts/`.

## Development

```bash
npm test                 # all unit tests
npm run lint:extension
```

MIT licensed.

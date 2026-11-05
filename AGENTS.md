# AGENTS.md

For an agent working in this repo: setting it up for your user, connecting to it, or
changing the code.

## Set it up for your user

1. `npm run setup` installs dependencies and puts `ff` on PATH. Add `-- --desktop` only if
   the user wants Claude Desktop, `-- --cowork` only if they want Cowork (it exposes the
   bridge on the LAN, so ask first).
2. **The user has to load the extension themselves**; you can't. Ask them to open
   `about:debugging#/runtime/this-firefox` in Firefox → *Load Temporary Add-on…* →
   `firefox-extension/manifest.json`. A temporary add-on is gone after a Firefox restart;
   README → *Permanent install* covers signing.
3. Run `ff status` until it prints `extension: connected`. The bridge starts on demand;
   its log is `~/.firefox-mcp/bridge.log`.

## Connect and use it

- **Shell agents:** run `ff --help` once, then use `ff`. Paste README → *Using it from a
  coding agent* into the user's `CLAUDE.md` / `AGENTS.md` so later sessions know about it.
- **MCP clients:** stdio via Claude Desktop (`--desktop`), or Streamable HTTP at
  `http://127.0.0.1:3003/mcp`.
- `ff` works in its own background tab (🤖) and never switches the user's tab. Use `--here`
  only when the user asks about the page they're on.
- `nav` and `click` don't wait for the page; read back with `ff text` before claiming a step
  worked. `ff type` exits nonzero when the text didn't land.
- This is the user's signed-in browser. Don't send messages, buy things, or submit forms
  for them without asking.

## Change the code

- `npm test` must pass (it runs bridge, extension, and bench tests). `npm run
  lint:extension` must show 0 errors; the `eval` warning from `javascript_tool` is expected.
- New tool: define it in `firefox-mcp-bridge/tools.mjs`, add a handler in
  `firefox-extension/tools/`, register it in `manifest.json`. A parity test checks both
  sides expose the same names.
- Functions passed to `executeScript` (e.g. `performType` in `tools/type.js`) are
  serialized by source: keep them self-contained, with no outside helpers or constants.
- Bump `version` in `firefox-extension/manifest.json` for any extension change you sign.
- Public repo: no `docs/` directory, no personal paths, names, or tokens in commits.

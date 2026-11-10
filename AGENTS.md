# AGENTS.md

For an agent working in this repo: setting it up for your user, connecting to it, or
changing the code.

## Set it up for your user

1. `npm run setup` installs dependencies and puts `ff` on PATH. Add `-- --desktop` only if
   the user wants Claude Desktop, `-- --cowork` only if they want Cowork (it exposes the
   bridge on the LAN, so ask first).
2. **The user has to install the extension themselves**; you can't. Ask them to open the
   signed `.xpi` from the
   [latest release](https://github.com/Jetemple/firefox-agent-bridge/releases/latest) in
   Firefox. To run the extension from this checkout instead, they open
   `about:debugging#/runtime/this-firefox` → *Load Temporary Add-on…* →
   `firefox-extension/manifest.json`; that one is gone after a Firefox restart.
3. Run `ff status` until it prints `extension: connected`. The bridge starts on demand;
   its log is `~/.firefox-mcp/bridge.log`.

## Connect and use it

- **Shell agents:** run `ff --help` once, then use `ff`. Paste README → *Tell your
  agent* into the user's `CLAUDE.md` / `AGENTS.md` so later sessions know about it.
- **MCP clients:** stdio via Claude Desktop (`--desktop`), or Streamable HTTP at
  `http://127.0.0.1:3003/mcp`.
- `ff` works in its own background tab (🤖) and never switches the user's tab. Use `--here`
  only when the user asks about the page they're on.
- Every agent shares that one tab. When more than one agent may be running, each opens its
  own with `ff open <url> --as <unique-name>` and passes `-s <unique-name>` on every command.
- `nav` and `open` return before the page loads; add `--settle` to wait for it. `click`
  doesn't wait either, so read back with `ff text` before claiming a step worked.
  `ff type` exits nonzero when the text didn't land.
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

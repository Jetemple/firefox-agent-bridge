#!/usr/bin/env bash
#
# setup-firefox-bridge.sh — one-shot setup for the owned Firefox MCP bridge.
#
# Idempotent. Re-run any time — in particular whenever your LAN IP changes,
# then re-upload the rebuilt firefox-bridge.plugin in Cowork.
#
# It will:
#   1. install the bridge's node deps
#   2. detect your host LAN IP   (override: FIREFOX_BRIDGE_HOST_IP=x.x.x.x)
#   3. register the bridge with Claude Desktop (classic chat + the SSE endpoint)
#   4. (re)build ./firefox-bridge.plugin with that IP baked in
#   5. health-check the bridge ports
#
# Two steps stay manual (GUI — can't be scripted): uploading the plugin to
# Cowork, and loading the extension in Firefox. The script prints both.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

SSE_PORT="${FIREFOX_BRIDGE_SSE_PORT:-3003}"
WS_PORT="${FIREFOX_BRIDGE_WS_PORT:-3002}"
PLUGIN_OUT="$REPO_ROOT/firefox-bridge.plugin"
BRIDGE_DIR="$REPO_ROOT/firefox-mcp-bridge"
EXT_MANIFEST="$REPO_ROOT/firefox-extension/manifest.json"

c_blue=$'\033[1;34m'; c_green=$'\033[1;32m'; c_yellow=$'\033[1;33m'; c_reset=$'\033[0m'
log()  { printf '%s▶ %s%s\n' "$c_blue"   "$*" "$c_reset"; }
ok()   { printf '%s✓ %s%s\n' "$c_green"  "$*" "$c_reset"; }
warn() { printf '%s⚠ %s%s\n' "$c_yellow" "$*" "$c_reset"; }

# 1. deps -------------------------------------------------------------------
if ! command -v npm >/dev/null 2>&1; then
  warn "npm not found on PATH — install Node.js, then re-run."; exit 1
fi
log "Installing bridge dependencies…"
npm install --prefix "$BRIDGE_DIR" --silent
ok "Dependencies ready."

# 2. detect LAN IP ----------------------------------------------------------
detect_ip() {
  local ip=""
  for iface in en0 en1; do
    ip="$(ipconfig getifaddr "$iface" 2>/dev/null || true)"
    [ -n "$ip" ] && { printf '%s' "$ip"; return 0; }
  done
  local def
  def="$(route -n get default 2>/dev/null | awk '/interface:/{print $2}')"
  [ -n "$def" ] && ipconfig getifaddr "$def" 2>/dev/null || true
}
LAN_IP="${FIREFOX_BRIDGE_HOST_IP:-$(detect_ip)}"
if [ -z "$LAN_IP" ]; then
  warn "Could not detect a LAN IP. Re-run as: FIREFOX_BRIDGE_HOST_IP=x.x.x.x $0"; exit 1
fi
SSE_URL="http://$LAN_IP:$SSE_PORT/mcp"
ok "Host LAN IP: $LAN_IP   → SSE url: $SSE_URL"

# 3. register bridge with Claude Desktop ------------------------------------
log "Registering bridge in Claude Desktop config…"
node "$REPO_ROOT/scripts/install-firefox-mcp-bridge.mjs"

# 4. (re)build the Cowork plugin bundle -------------------------------------
log "Building $PLUGIN_OUT …"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
mkdir -p "$STAGE/.claude-plugin"
cat > "$STAGE/.claude-plugin/plugin.json" <<'JSON'
{
  "name": "firefox-bridge",
  "version": "0.1.0",
  "description": "Control Firefox via a local MCP bridge"
}
JSON
cat > "$STAGE/.mcp.json" <<JSON
{
  "mcpServers": {
    "firefox-bridge": {
      "type": "http",
      "url": "$SSE_URL"
    }
  }
}
JSON
rm -f "$PLUGIN_OUT"
( cd "$STAGE" && zip -q -X -r "$PLUGIN_OUT" .mcp.json .claude-plugin )
ok "Built $PLUGIN_OUT  (firefox-bridge → $SSE_URL)"
command -v open >/dev/null 2>&1 && open -R "$PLUGIN_OUT" 2>/dev/null || true

# 5. health check -----------------------------------------------------------
log "Checking bridge ports…"
port_up() { lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1; }
port_up "$WS_PORT"  && ok "WS relay listening on :$WS_PORT"     || warn "Nothing on :$WS_PORT — restart Claude Desktop to spawn the bridge."
port_up "$SSE_PORT" && ok "SSE endpoint listening on :$SSE_PORT" || warn "Nothing on :$SSE_PORT — restart Claude Desktop to spawn the bridge."

# 6. remaining manual steps -------------------------------------------------
cat <<EOF

${c_blue}────────────────────────────────────────────────────────────${c_reset}
 Two steps left (GUI — can't be scripted):

  ${c_green}1) Cowork${c_reset}  → Settings → ${c_green}Upload local plugin${c_reset}
     choose:  $PLUGIN_OUT
     (Finder was opened to it for you.)

  ${c_green}2) Firefox${c_reset} → about:debugging#/runtime/this-firefox
     → "Load Temporary Add-on…" → choose:
        $EXT_MANIFEST

 IP changed / new network?  Re-run this script and re-upload the .plugin.
${c_blue}────────────────────────────────────────────────────────────${c_reset}
EOF

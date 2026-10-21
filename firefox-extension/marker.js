// Tab-title marker — the single source of truth for how an agent-driven tab is
// stamped in the Firefox tab strip. Loaded early in manifest background.scripts
// (like restricted.js) so open-tab.js, background.js's onUpdated listener, and
// tabs-summary.js all share one format definition.
//
// `var`, not `const`: background.scripts share one top-level lexical scope and
// restricted.js / background.js also bind FF; `const` would throw "redeclaration
// of const FF" and abort the script on load.
var FF = (globalThis.FFBridge ??= {});

// The emoji every marked tab carries. Kept as one constant so a future change
// is a one-line edit here.
FF.MARKER_EMOJI = "🤖";

// Tabs the CLI/agent opened, keyed by tab id → session label (string) or null
// (no session). In-memory only: the persistent background page keeps it across
// dispatches; an extension reload or Firefox restart clears every mark.
FF.markedTabs ??= new Map();

// The prefix stamped onto a marked tab's title.
//   markerPrefix("airbnb") → "🤖 airbnb · "
//   markerPrefix(null)     → "🤖 "
FF.markerPrefix = function markerPrefix(label) {
  return label ? `${FF.MARKER_EMOJI} ${label} · ` : `${FF.MARKER_EMOJI} `;
};

// Regex SOURCE (a string, so it can be handed to a page-injected function that
// has no access to this scope) matching a leading marker, with or without a
// session name. Session names are validated to PROFILE_NAME_RE bridge-side, so
// the optional name group mirrors it.
FF.markerRegexSource = function markerRegexSource() {
  return `^${FF.MARKER_EMOJI} (?:[a-z0-9][a-z0-9-]{0,31} · )?`;
};

// Remove a leading marker from a title; non-strings pass through untouched.
// Used by tabs-summary so agents read clean titles while the human sees the
// stamp in the strip.
FF.stripMarker = function stripMarker(title) {
  return typeof title === "string" ? title.replace(new RegExp(FF.markerRegexSource()), "") : title;
};

// Compute the stamped title: strip any existing marker, then prepend the fresh
// prefix. Idempotent (re-stamping is a no-op) and relabel-safe (an old label is
// stripped before the new one is applied). The in-page stamp function mirrors
// this using markerRegexSource() + markerPrefix() passed as arguments.
FF.buildTitle = function buildTitle(current, label) {
  return FF.markerPrefix(label) + FF.stripMarker(current ?? "");
};

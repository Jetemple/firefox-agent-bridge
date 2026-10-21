// Shared namespace bootstrap + restricted-URL policy.
// Loaded first in manifest background.scripts, so it creates globalThis.FFBridge
// for the tool files and background.js to extend.

// `var`, not `const`: background.scripts share one top-level lexical scope,
// so a top-level `const FF` here AND in background.js would throw
// "redeclaration of const FF" and abort background.js on load. `var` is the
// idiomatic shared-scope binding (redeclaration is a no-op). The tool files use
// block-scoped `const FF` inside `{ }`, which is isolated and fine.
var FF = (globalThis.FFBridge ??= {});
FF.tools ??= {};

// Protocols a top-level tab URL can carry where scripting/capture should be
// refused. `executeScript` also refuses privileged hosts (e.g. AMO); the
// per-call try/catch -> SCRIPT_FAILED is the authoritative backstop for those.
FF.RESTRICTED_PROTOCOLS = [
  "about:",
  "moz-extension:",
  "chrome:",
  "view-source:",
  "resource:",
  "data:",
  "blob:",
];

FF.isRestricted = function isRestricted(url) {
  if (!url) return true;
  const lower = String(url).toLowerCase();
  return FF.RESTRICTED_PROTOCOLS.some((p) => lower.startsWith(p));
};

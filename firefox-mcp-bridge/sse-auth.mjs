import { createHash, timingSafeEqual } from "node:crypto";

// Authorization for the StreamableHTTP/SSE transport (`:3003/mcp`). Pure helpers,
// no side effects, so they're cheap to unit-test. The bridge binds loopback by
// default; a token is what makes a non-loopback (LAN) bind safe to expose.

// A loopback bind is reachable only from this machine — no token required.
export function isLoopbackHost(host) {
  return host === "127.0.0.1" || host === "::1" || host === "localhost";
}

// The token a request presents: `Authorization: Bearer <t>`, or a `?token=<t>`
// query-param fallback for clients that can't set headers. null if neither.
export function requestToken(req) {
  const auth = req?.headers?.authorization || req?.headers?.Authorization;
  if (auth) {
    const m = /^Bearer\s+(.+)$/i.exec(auth);
    if (m) return m[1].trim();
  }
  try {
    const t = new URL(req?.url ?? "", "http://localhost").searchParams.get("token");
    if (t) return t;
  } catch {
    /* malformed URL → no token */
  }
  return null;
}

// Constant-time token comparison. Hashing both sides first keeps it constant-time
// regardless of length (timingSafeEqual throws on length-mismatched buffers).
function tokensMatch(expected, presented) {
  if (!presented) return false;
  const a = createHash("sha256").update(String(expected)).digest();
  const b = createHash("sha256").update(String(presented)).digest();
  return timingSafeEqual(a, b);
}

// Authorize an incoming SSE request. With no token configured the endpoint is
// open (its safety then rests on the loopback bind); with a token, every request
// must present it.
export function isSseAuthorized(token, req) {
  if (!token) return true;
  return tokensMatch(token, requestToken(req));
}

// A warning to log when the SSE endpoint is exposed beyond loopback with no
// token — i.e. any device on the network could drive the logged-in browser.
// Returns null when the configuration is safe.
export function sseInsecureWarning({ sseHost, sseToken }) {
  if (sseToken) return null;
  if (isLoopbackHost(sseHost)) return null;
  return (
    `SSE is bound to ${sseHost} with no token — any device on your network can drive ` +
    `your logged-in Firefox (including arbitrary JS via javascript_tool). ` +
    `Set FIREFOX_BRIDGE_SSE_TOKEN to require auth, or bind FIREFOX_BRIDGE_SSE_HOST=127.0.0.1.`
  );
}

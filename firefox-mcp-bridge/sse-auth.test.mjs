import test from "node:test";
import assert from "node:assert/strict";
import { isLoopbackHost, isSseAuthorized, sseInsecureWarning } from "./sse-auth.mjs";

// --- loopback classification ---

test("isLoopbackHost recognizes loopback binds and only those", () => {
  assert.equal(isLoopbackHost("127.0.0.1"), true);
  assert.equal(isLoopbackHost("::1"), true);
  assert.equal(isLoopbackHost("localhost"), true);
  assert.equal(isLoopbackHost("0.0.0.0"), false);
  assert.equal(isLoopbackHost("10.0.0.63"), false);
});

// --- request authorization ---

test("isSseAuthorized allows any request when no token is configured", () => {
  assert.equal(isSseAuthorized(null, { headers: {}, url: "/mcp" }), true);
});

test("isSseAuthorized requires a matching bearer token when configured", () => {
  const tok = "s3cret";
  assert.equal(
    isSseAuthorized(tok, { headers: { authorization: "Bearer s3cret" }, url: "/mcp" }),
    true,
  );
  assert.equal(
    isSseAuthorized(tok, { headers: { authorization: "Bearer wrong" }, url: "/mcp" }),
    false,
  );
  assert.equal(isSseAuthorized(tok, { headers: {}, url: "/mcp" }), false);
});

test("isSseAuthorized accepts a ?token= query-param fallback", () => {
  assert.equal(isSseAuthorized("s3cret", { headers: {}, url: "/mcp?token=s3cret" }), true);
  assert.equal(isSseAuthorized("s3cret", { headers: {}, url: "/mcp?token=nope" }), false);
});

test("isSseAuthorized is not fooled by a token of a different length", () => {
  // Guards against a constant-time compare that throws on length mismatch.
  assert.equal(isSseAuthorized("s3cret", { headers: { authorization: "Bearer x" }, url: "/mcp" }), false);
  assert.equal(
    isSseAuthorized("s3cret", { headers: { authorization: "Bearer s3cretXXXXXX" }, url: "/mcp" }),
    false,
  );
});

// --- insecure-bind warning ---

test("sseInsecureWarning fires only for a non-loopback bind without a token", () => {
  assert.equal(sseInsecureWarning({ sseHost: "127.0.0.1", sseToken: null }), null);
  assert.equal(sseInsecureWarning({ sseHost: "0.0.0.0", sseToken: "x" }), null);
  const warn = sseInsecureWarning({ sseHost: "0.0.0.0", sseToken: null });
  assert.ok(warn && /token/i.test(warn));
});

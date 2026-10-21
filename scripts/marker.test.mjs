// Tests for firefox-extension/marker.js — the single source of truth for the
// tab-title marker format (prefix + strip). Loaded into a vm with a bare
// FFBridge namespace, exactly like the other extension-script tests.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";

function loadMarker() {
  const sandbox = { console };
  sandbox.globalThis = sandbox;
  createContext(sandbox);
  runInContext(readFileSync(new URL("../firefox-extension/marker.js", import.meta.url), "utf8"), sandbox, {
    filename: "marker.js",
  });
  return sandbox.FFBridge;
}

test("markerPrefix formats with and without a session label", () => {
  const FF = loadMarker();
  assert.equal(FF.markerPrefix("airbnb"), "🤖 airbnb · ");
  assert.equal(FF.markerPrefix(null), "🤖 ");
  assert.equal(FF.markerPrefix(undefined), "🤖 ");
});

test("stripMarker removes a leading marker, with or without a label", () => {
  const FF = loadMarker();
  assert.equal(FF.stripMarker("🤖 airbnb · Airbnb — Rentals"), "Airbnb — Rentals");
  assert.equal(FF.stripMarker("🤖 Plain title"), "Plain title");
});

test("stripMarker leaves unmarked titles untouched and passes non-strings through", () => {
  const FF = loadMarker();
  assert.equal(FF.stripMarker("No marker here"), "No marker here");
  assert.equal(FF.stripMarker(undefined), undefined);
  // A title that merely contains the emoji mid-string is not a leading marker.
  assert.equal(FF.stripMarker("Report 🤖 status"), "Report 🤖 status");
});

test("buildTitle stamps an unmarked title", () => {
  const FF = loadMarker();
  assert.equal(FF.buildTitle("Airbnb — Rentals", "airbnb"), "🤖 airbnb · Airbnb — Rentals");
  assert.equal(FF.buildTitle("Plain", null), "🤖 Plain");
});

test("buildTitle is idempotent — re-stamping the same title is a no-op", () => {
  const FF = loadMarker();
  const once = FF.buildTitle("Airbnb — Rentals", "airbnb");
  assert.equal(FF.buildTitle(once, "airbnb"), once);
});

test("buildTitle relabels cleanly instead of double-stamping", () => {
  const FF = loadMarker();
  assert.equal(FF.buildTitle("🤖 airbnb · Foo", "scraper"), "🤖 scraper · Foo");
  // emoji-only → labeled, and back
  assert.equal(FF.buildTitle("🤖 Foo", "airbnb"), "🤖 airbnb · Foo");
  assert.equal(FF.buildTitle("🤖 airbnb · Foo", null), "🤖 Foo");
});

test("markerRegexSource is a string usable across the page boundary", () => {
  const FF = loadMarker();
  assert.equal(typeof FF.markerRegexSource(), "string");
  // The in-page stamp function reconstructs the regex from this source and the
  // prefix; verify the pair reproduces buildTitle exactly.
  const bare = "Some Page".replace(new RegExp(FF.markerRegexSource()), "");
  assert.equal(FF.markerPrefix("airbnb") + bare, FF.buildTitle("Some Page", "airbnb"));
});

test("markedTabs is a Map for tracking agent-opened tabs", () => {
  const FF = loadMarker();
  // Cross-realm: the vm's Map !== this realm's Map, so instanceof fails —
  // assert the map behavior we depend on instead.
  assert.equal(FF.markedTabs.constructor.name, "Map");
  FF.markedTabs.set(7, "airbnb");
  assert.equal(FF.markedTabs.has(7), true);
  assert.equal(FF.markedTabs.get(7), "airbnb");
  FF.markedTabs.delete(7);
  assert.equal(FF.markedTabs.has(7), false);
});

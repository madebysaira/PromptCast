/**
 * PromptCast — static checks.
 *
 * A Chrome extension cannot run its content scripts under Node, but
 * the pure logic (verifyFill normalization, delivery labels, safe
 * input regex, reset preservation) can and should be tested. These
 * tests mirror the implementations; keep them in sync.
 */
const assert = require("node:assert");
const { test } = require("node:test");

// ── Mirrors verifyFill normalization in scripts/content.js ──
function norm(s) {
  return s.replace(/\s+/g, " ").trim();
}
function fillMatches(have, want) {
  have = norm(have);
  want = norm(want);
  return have.length > 0 && (have.includes(want.slice(0, 60)) || want.includes(have.slice(0, 60)));
}

// ── Mirrors SAFE_INPUT_TYPES in scripts/content.js ──
const SAFE_INPUT_TYPES = /^(text|search|url|tel)$/i;

// ── Mirrors labelFor in pages/grid.js ──
function labelFor(state) {
  return {
    "no-permission": "Needs access",
    "input-missing": "Box not found",
    "fill-unverified": "Not sent",
    "timed-out": "Timed out",
  }[state] || state;
}

test("verify: exact fill matches", () => {
  assert.ok(fillMatches("Explain black holes", "Explain black holes"));
});

test("verify: editor reflow (extra whitespace) still matches", () => {
  assert.ok(fillMatches("Explain   black\nholes  ", "Explain black holes"));
});

test("verify: stale draft does NOT match", () => {
  assert.ok(!fillMatches("Write a poem about cats", "Explain black holes"));
});

test("verify: empty editor never verifies", () => {
  assert.ok(!fillMatches("", "Explain black holes"));
  assert.ok(!fillMatches("   ", "Explain black holes"));
});

test("selection: password fields are never captured", () => {
  assert.ok(!SAFE_INPUT_TYPES.test("password"));
  assert.ok(!SAFE_INPUT_TYPES.test("email"));
  assert.ok(!SAFE_INPUT_TYPES.test("number"));
});

test("selection: plain text fields are captured", () => {
  for (const t of ["text", "search", "url", "tel"]) {
    assert.ok(SAFE_INPUT_TYPES.test(t), t);
  }
});

test("grid: every failure state has a human label", () => {
  for (const s of ["no-permission", "input-missing", "fill-unverified", "timed-out"]) {
    assert.notEqual(labelFor(s), s, s);
  }
});

test("reset: custom providers survive a defaults restore", () => {
  const DEFAULTS = { enabledProviders: ["chatgpt"], autoSubmit: true };
  const settings = { ...DEFAULTS, customProviders: [{ id: "custom-x" }] };
  // performReset semantics: defaults restored, custom kept
  const after = { ...DEFAULTS, customProviders: settings.customProviders };
  assert.equal(after.customProviders.length, 1);
  assert.equal(after.customProviders[0].id, "custom-x");
});

test("manifest: DNR ruleset ships disabled (no standing header stripping)", () => {
  const manifest = require("../manifest.json");
  const rule = manifest.declarative_net_request.rule_resources[0];
  assert.equal(rule.enabled, false);
});

test("manifest: no broad host permissions at install", () => {
  const manifest = require("../manifest.json");
  assert.ok(!manifest.host_permissions, "host_permissions must stay absent");
  assert.ok(
    (manifest.optional_host_permissions || []).every((p) => !["http://*/*", "https://*/*", "<all_urls>"].includes(p)),
    "no wildcard optional hosts"
  );
});

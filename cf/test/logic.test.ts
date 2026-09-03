//=====================================================================
// logic.test.ts — business-logic tests for input normalization & routing.
// Run: npm run test:logic
//
// Separate from test:safety (infrastructure/framework invariants). This
// covers the user-input handling layer added at Level 14+ so real-world
// Telegram/WhatsApp Indonesian slang, typos, and empty payloads route to
// the intended path instead of the fail-closed "Aksi ditangguhkan."/"Ok."
//=====================================================================

import assert from "node:assert";
import { normalizeInput, isEmptyInput, GREETING_RE } from "../src/lib/normalize";

function testSlangExpansion() {
  assert.strictEqual(normalizeInput("gmn cara bikin website"), "bagaimana cara bikin website",
    "'gmn' expands to 'bagaimana' (filler, enabling topic-carry marker)");
  assert.strictEqual(normalizeInput("udh blm selesai"), "sudah belum selesai",
    "'udh'->sudah, 'blm'->belum");
  assert.strictEqual(normalizeInput("cari bisnis yg paling gede"), "cari bisnis yang paling gede",
    "'yg' expands to 'yang', keeps command word 'cari'");
  assert.strictEqual(normalizeInput("gw mau cari toko kopi"), "saya mau cari toko kopi",
    "'gw'->saya; 'mau' (not short slang) kept; 'cari' kept so search marker survives");
  assert.strictEqual(normalizeInput("translate stuff ke English"), "translate stuff ke english",
    "prefix preserved; only casing normalized");
}

function testTypoTolerance() {
  // Greeting with repeated letters must collapse so it matches the greeting matcher.
  assert.ok(GREETING_RE.test(normalizeInput("halooo")), "'halooo' must collapse to 'halo' for greeting");
  assert.ok(GREETING_RE.test(normalizeInput("hellooo pak")), "'hellooo' collapses to 'hello' for greeting");
  assert.ok(GREETING_RE.test(normalizeInput("pagi")), "plain greeting still matches");
}

function testCommandWhitespace() {
  // Extra whitespace inside / never breaks command matching (normalize collapses).
  assert.strictEqual(normalizeInput("/cari   topik  bisnis "), "/cari topik bisnis",
    "multiple spaces collapse to single");
  assert.strictEqual(normalizeInput("  /status  "), "/status",
    "leading/trailing whitespace trimmed");
}

function testRawCommandArgsPreserved() {
  // Normalization must NOT mangle the slash command prefix.
  assert.ok(normalizeInput("/mark_stop jangan kirim berita").startsWith("/mark_stop"),
    "slash command prefix preserved verbatim");
  assert.ok(normalizeInput("/ratify jangan hapus data").startsWith("/ratify"),
    "/ratify prefix preserved");
}

function testEmptyInput() {
  assert.strictEqual(isEmptyInput(""), true, "empty string is empty");
  assert.strictEqual(isEmptyInput("   "), true, "whitespace only is empty");
  assert.strictEqual(isEmptyInput("🤔"), true, "emoji-only is empty");
  assert.strictEqual(isEmptyInput("👍👏"), true, "emoji-only is empty");
  assert.strictEqual(isEmptyInput("---"), true, "punctuation-only is empty");
  assert.strictEqual(isEmptyInput("halo"), false, "real text is not empty");
  assert.strictEqual(isEmptyInput("cari bisnis"), false, "real text is not empty");
}

function testNonSlangPassThrough() {
  assert.strictEqual(normalizeInput("Analisis bisnis 2026"), "analisis bisnis 2026",
    "non-slang text passes with only casing/whitespace normalized");
  assert.strictEqual(normalizeInput("help"), "help");
}

function main() {
  testSlangExpansion();
  testTypoTolerance();
  testCommandWhitespace();
  testRawCommandArgsPreserved();
  testEmptyInput();
  testNonSlangPassThrough();
  console.log("LOGIC TESTS PASSED");
}

main();

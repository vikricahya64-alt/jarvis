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
import { isFollowUpQuery } from "../src/lib/ai";
import { gatherSuggestionCandidates, URGENCY_THRESHOLD, MAX_OFFER_BATCH } from "../src/lib/predictive";

async function testPredictiveUrgencyRanking() {
  // Deterministic ranking: approval (open/expiring proposals) must rank first,
  // followed by the most urgent of (task/insight/preference). All are derived
  // purely from D1 reads (no LLM), keeping the offer cheap on cron. Every
  // returned candidate must clear the urgency bar, and the batch is capped
  // tight so the owner is never overwhelmed (notification-fatigue guard).
  type Row = Record<string, unknown>;
  const rows: Row[] = [
    // value_proposals (pendingProposals) -> approval candidate
    { id: 9001, domain: "constitution", new_proposal: "jangan hapus data tanpa persetujuan", old_value: "", reason: "sovereignty", confidence: 0.9, expires_at: Date.now() + 86_400_000, ts: Date.now() },
    // scheduled_tasks (getScheduledTasks) -> task candidates
    { id: "t1", owner_id: 1, description: "kirim laporan mingguan", cadence: "weekly", schedule_at: Date.now() + 3600_000, lastRun: null, approved: 0, risk_level: "high" },
    { id: "t2", owner_id: 1, description: "cek status sistem", cadence: "daily", schedule_at: Date.now() + 3600_000, lastRun: null, approved: 1, risk_level: "low" },
    // owner_preferences (getActivePreferences) -> preference candidate (explicit, high conf)
    { key: "format", value: "markdown singkat", source: "explicit", confidence: 0.8, evidence_count: 3, disabled: 0 },
    { key: "bahasa", value: "jawa", source: "inferred", confidence: 0.7, evidence_count: 1, disabled: 0 },
    // insights (listInsights) -> insight candidate
    { id: 77, rule_text: "pemilik suka ringkasan singkat di pagi hari", category: "preference", evidence_ids: "[]", evidence_count: 3, confidence: 0.85, disabled: 0 },
  ];

  const makeEnv = (data: Row[]) => {
    const mapRows = (sql: string): Row[] => {
      if (sql.includes("value_proposals")) return data.filter((r) => r.id === 9001);
      if (sql.includes("scheduled_tasks")) return data.filter((r) => r.id === "t1" || r.id === "t2");
      if (sql.includes("owner_preferences")) return data.filter((r) => typeof r.key === "string");
      if (sql.includes("insights")) return data.filter((r) => r.id === 77);
      return [];
    };
    const db = {
      prepare: (sql: string) => ({
        bind: () => ({
          run: async () => ({ meta: { changes: 0 } }),
          all: async () => ({ results: mapRows(sql) }),
          first: async () => null,
        }),
      }),
    };
    return { DB: db } as unknown as Parameters<typeof gatherSuggestionCandidates>[0];
  };

  const env = makeEnv(rows);

  // Full signal set → cap truncates to the few most urgent, approval leading.
  const out = await gatherSuggestionCandidates(env, 1, new Set());
  assert.ok(out.length > 0, "candidates gathered from mock signals");
  assert.ok(out.length <= MAX_OFFER_BATCH, "batch never exceeds MAX_OFFER_BATCH");
  assert.strictEqual(out[0].category, "approval", "open proposal is the most urgent signal");
  for (const c of out) {
    assert.ok(c.urgency >= URGENCY_THRESHOLD,
      `candidate ${c.category} must clear the urgency bar (got ${c.urgency})`);
  }

  // Preference-first scenario: with no approval/task/insight, a high-confidence
  // explicit preference is still offerable (routine suggestion) — but an
  // inferred, low-confidence one stays below the bar and is filtered out.
  const prefOnly = await gatherSuggestionCandidates(makeEnv(rows.slice(3, 4)), 1, new Set());
  assert.strictEqual(prefOnly[0].category, "preference",
    "high-confidence explicit preference is a valid (lowest-priority) offer");

  // Dedup: sources already offered are excluded.
  const already = new Set(["approval:9001", "task:t1", "task:t2"]);
  const out2 = await gatherSuggestionCandidates(env, 1, already);
  assert.ok(!out2.some((c) => c.sourceKey.startsWith("approval:9001") || c.sourceKey.startsWith("task:")),
    "already-offered sources must not be re-offered");
}

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

function testFollowUpDetection() {
  // Follow-up phrasing that extends a prior answer (no fresh topic marker).
  for (const q of ["lebih dalam", "lanjut", "yang tadi", "perinci lebih detail", "tambahin informasi", "jelasin lebih", "expand dong"]) {
    assert.ok(isFollowUpQuery(q), `follow-up must be detected: ${q}`);
  }
  // A fresh topic query is NOT a follow-up.
  for (const q of ["cari bisnis kopi 2026", "Apa itu ribosom", "bandingkan hp dan laptop"]) {
    assert.ok(!isFollowUpQuery(q), `fresh topic must NOT be a follow-up: ${q}`);
  }
}

async function main() {
  testSlangExpansion();
  testTypoTolerance();
  testCommandWhitespace();
  testRawCommandArgsPreserved();
  testEmptyInput();
  testNonSlangPassThrough();
  testFollowUpDetection();
  await testPredictiveUrgencyRanking();
  console.log("LOGIC TESTS PASSED");
}

main().catch((e) => {
  console.error("LOGIC TEST FAILED:", e);
  process.exit(1);
});

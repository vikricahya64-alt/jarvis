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
import { gatherSuggestionCandidates, URGENCY_THRESHOLD, MAX_OFFER_BATCH, feedbackMultipliers, FEEDBACK_MIN_MULT, FEEDBACK_NEUTRAL } from "../src/lib/predictive";
import { behaviorAffinity, parseReflection, BEHAVIOR_AFFINITY_MIN, BEHAVIOR_AFFINITY_NEUTRAL, BEHAVIOR_HALF_LIFE_DAYS } from "../src/lib/evolution";

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
    "slash command prefix preserved");
  assert.ok(normalizeInput("/ratify jangan hapus data").startsWith("/ratify"),
    "/ratify prefix preserved");
}

function testGroupPrefixStripping() {
  // Telegram group bots often prepend "Username:" to messages. This prefix must
  // be stripped so slash commands and search topics route correctly instead of
  // falling to "Aksi ditangguhkan." (DEFER).
  assert.strictEqual(normalizeInput("Vsco Bayu:/hapus"), "/hapus",
    "group prefix stripped, slash command preserved");
  assert.strictEqual(normalizeInput("Vsco Bayu:Reset todo"), "reset todo",
    "group prefix stripped, plain text passes");
  assert.strictEqual(normalizeInput("  John:/cari bisnis kopi"), "/cari bisnis kopi",
    "leading whitespace + group prefix stripped");
  assert.strictEqual(normalizeInput("/cari topik"), "/cari topik",
    "no prefix → normal processing");
  assert.strictEqual(normalizeInput("cari bisnis"), "cari bisnis",
    "no prefix → normal processing");
  // Multi-line: "Vsco Bayu:\nMalang" — prefix on separate line from content
  assert.strictEqual(normalizeInput("Vsco Bayu:\nMalang"), "malang",
    "multi-line group prefix stripped");
  assert.strictEqual(normalizeInput("Vsco Bayu:\nreset todo"), "reset todo",
    "multi-line group prefix stripped, plain text passes");
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

function testExpandedSlang() {
  // Extended Indonesian social-media/Telegram slang dictionary (research-backed:
  // Han & Baldwin 2013, ViLexNorm EACL'24, MultiLexNorm++ 2026). All harmless
  // filler — never expands into a verb/command the guard must see.
  assert.strictEqual(normalizeInput("mksh ya"), "terima kasih ya", "mksh -> terima kasih");
  assert.strictEqual(normalizeInput("klo gitu kapan"), "kalau gitu kapan", "klo -> kalau");
  assert.strictEqual(normalizeInput("cma mau tanya"), "cma mau tanya", "'cma' (not in dict) passes");
  assert.strictEqual(normalizeInput("mantul"), "mantap", "mantul -> mantap");
  assert.strictEqual(normalizeInput("bener banget"), "benar banget", "bener -> benar");
  assert.strictEqual(normalizeInput("jngn lupa"), "jangan lupa", "jngn -> jangan");
  assert.strictEqual(normalizeInput("skrng gimana"), "sekarang gimana", "skrng -> sekarang");
  assert.strictEqual(normalizeInput("plis bantu"), "tolong bantu", "plis -> tolong");
  // A real verb/command word is NOT expanded (guard must still see it).
  assert.strictEqual(normalizeInput("reset todo"), "reset todo", "real command words preserved");
  assert.strictEqual(normalizeInput("hapus"), "hapus", "verb preserved");
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

function testFuzzyExtractTopic() {
  // extractTopic fuzzy tolerance (QueryStack/Kondrak 2026): common misspellings
  // of topic markers must still be recognized, so JARVIS routes to search
  // instead of wrongly DEFERing with "Aksi ditangguhkan."
  const { extractTopic } = require("../src/lib/ai");
  // Standard markers.
  assert.ok(extractTopic("cari bisnis kopi"), "standard 'cari' marker");
  assert.ok(extractTopic("tentang ekonomi digital"), "standard 'tentang' marker");
  assert.ok(extractTopic("analisis pasar saham"), "standard 'analisis' marker");
  assert.ok(extractTopic("info cuaca jakarta"), "standard 'info' marker");
  assert.ok(extractTopic("review hp terbaru"), "standard 'review' marker");
  assert.ok(extractTopic("bagaimana cara investasi"), "standard 'bagaimana' marker");
  // Fuzzy misspelling variants.
  assert.ok(extractTopic("carii bisnis kopi"), "extra 'i' in 'carii'");
  assert.ok(extractTopic("tenteng ekonomi digital"), "'tenteng' variant of 'tentang'");
  assert.ok(extractTopic("info cuaca jakarta"), "standard 'info'");
  assert.ok(extractTopic("ulsn hp terbaru"), "'ulsn' variant of 'ulasan'");
  assert.ok(extractTopic("gmn cara investasi"), "'gmn' variant of 'bagaimana'");
  // Non-topic (no marker) must NOT match.
  assert.strictEqual(extractTopic("reset todo"), null, "no marker -> null");
  assert.strictEqual(extractTopic("hapus data ini"), null, "verb-only -> null");
  assert.strictEqual(extractTopic("apa kabar"), null, "greeting -> null");
}

async function testFeedbackLearning() {
  // Feedback learning: JARVIS must respond to explicit negative feedback
  // (dismiss) by reducing similar suggestions (Google RecSys '23; Beirlant et
  // al. 2025). The per-category multiplier must be FAIL-CLOSED: it can only
  // lower a category's urgency from baseline, never raise it.
  type ResultRow = { category: string; accepted: number; dismissed: number };
  const makeDb = (results: ResultRow[]) => ({
    prepare: () => ({ bind: () => ({ all: async () => ({ results }) }) }),
  });

  // Category with no resolved history → neutral (untouched).
  const empty = await feedbackMultipliers(
    { DB: makeDb([]) } as unknown as Parameters<typeof feedbackMultipliers>[0],
    1,
  );
  assert.strictEqual(empty["approval"] ?? FEEDBACK_NEUTRAL, FEEDBACK_NEUTRAL,
    "no history → learning is neutral, never changes base urgency");

  // Always dismissed (accept=0, dismiss=2) → floor multiplier (strong damping).
  const alwaysDismissed = await feedbackMultipliers(
    { DB: makeDb([{ category: "insight", accepted: 0, dismissed: 2 }]) } as unknown as Parameters<typeof feedbackMultipliers>[0],
    1,
  );
  assert.strictEqual(alwaysDismissed["insight"], FEEDBACK_MIN_MULT,
    "a fully-dismissed category is dampened to the floor");

  // Mixed (1 accepted, 1 dismissed) → rate 0.5 → multiplier in (floor, neutral).
  const mixed = await feedbackMultipliers(
    { DB: makeDb([{ category: "task", accepted: 1, dismissed: 1 }]) } as unknown as Parameters<typeof feedbackMultipliers>[0],
    1,
  );
  assert.ok(mixed["task"] > FEEDBACK_MIN_MULT && mixed["task"] < FEEDBACK_NEUTRAL,
    `mixed outcomes give an in-between multiplier (got ${mixed["task"]})`);

  // Always accepted → neutral (no damping; must NOT exceed baseline).
  const alwaysAccepted = await feedbackMultipliers(
    { DB: makeDb([{ category: "approval", accepted: 3, dismissed: 0 }]) } as unknown as Parameters<typeof feedbackMultipliers>[0],
    1,
  );
  assert.strictEqual(alwaysAccepted["approval"], FEEDBACK_NEUTRAL,
    "a fully-accepted category stays at baseline — learning never boosts urgency");

  // Total (accepted+dismissed) <= 0 → neutral, no divide-by-zero.
  const zero = await feedbackMultipliers(
    { DB: makeDb([{ category: "preference", accepted: 0, dismissed: 0 }]) } as unknown as Parameters<typeof feedbackMultipliers>[0],
    1,
  );
  assert.strictEqual(zero["preference"], FEEDBACK_NEUTRAL, "zero-history row is neutral");

  // The same damping must lower a candidate's urgency so a previously-offered
  // (now dismissed) category drops out of the urgent pool / below threshold.
  const u = 0.7;
  assert.ok(FEEDBACK_MIN_MULT * u < u, "damping strictly lowers urgency below baseline");
  assert.ok(Number.isFinite(FEEDBACK_MIN_MULT) && FEEDBACK_MIN_MULT > 0 && FEEDBACK_MIN_MULT < 1,
    "floor multiplier is a valid (0,1) dampener");
  assert.ok(FEEDBACK_NEUTRAL === 1, "neutral multiplier is identity");
}

async function testBehaviorAlignmentRanking() {
  // Answer-behavior alignment: the reflection loop's *corrections* (answer was
  // changed) drive a deterministic, fail-closed, recency-decayed affinity per
  // category. Verify the ranking math is sane, monotonic, and recommender-grade.
  type Row = { category: string; reflected: number; created_at: number };
  const makeDb = (rows: Row[]) => ({
    prepare: () => ({ bind: () => ({ all: async () => ({ results: rows }) }) }),
  });
  const now = Date.now();
  const D = 86400_000;

  // More corrections => lower (damped) affinity; never above neutral; bounded below.
  // (Two corrections are still above the floor, so the strict decrease holds.)
  const one = await behaviorAffinity({ DB: makeDb([{ category: "tone", reflected: 1, created_at: now }]) } as any, now);
  const two = await behaviorAffinity({ DB: makeDb([
    { category: "tone", reflected: 1, created_at: now },
    { category: "tone", reflected: 1, created_at: now },
  ]) } as any, now);
  const three = await behaviorAffinity({ DB: makeDb([
    { category: "tone", reflected: 1, created_at: now },
    { category: "tone", reflected: 1, created_at: now },
    { category: "tone", reflected: 1, created_at: now },
  ]) } as any, now);

  assert.ok(one["tone"] > two["tone"],
    "affinity must strictly decrease as corrections accumulate (before floor)");
  assert.ok(one["tone"] <= BEHAVIOR_AFFINITY_NEUTRAL && two["tone"] <= BEHAVIOR_AFFINITY_NEUTRAL,
    "affinity never exceeds neutral (no amplification)");
  assert.strictEqual(three["tone"], BEHAVIOR_AFFINITY_MIN,
    "saturation drives a category to the floor, and stays there (never below)");

  // Recency decay: a correction today damps far more than the same correction
  // one half-life (or many) ago — a category that stops being corrected recovers.
  const fresh = await behaviorAffinity({ DB: makeDb([{ category: "format", reflected: 1, created_at: now }]) } as any, now);
  const aged = await behaviorAffinity({ DB: makeDb([{ category: "format", reflected: 1, created_at: now - BEHAVIOR_HALF_LIFE_DAYS * D }]) } as any, now);
  assert.ok(aged["format"] > fresh["format"],
    "older correction must be weighted less (Ebbinghaus/recency decay)");

  const veryOld = await behaviorAffinity({ DB: makeDb([{ category: "safety", reflected: 1, created_at: now - 100 * BEHAVIOR_HALF_LIFE_DAYS * D }]) } as any, now);
  assert.ok(veryOld["safety"] >= BEHAVIOR_AFFINITY_NEUTRAL - 1e-9,
    "a very old correction must decay essentially to neutral (no permanent ban)");

  // Correctness of the half-life math: one correction at exactly one half-life
  // old contributes weight 0.5 -> affinity = max(floor, 1 - 0.5/3) = 0.8333...
  const atHalfLife = await behaviorAffinity({ DB: makeDb([{ category: "timing", reflected: 1, created_at: now - BEHAVIOR_HALF_LIFE_DAYS * D }]) } as any, now);
  const expected = Math.max(BEHAVIOR_AFFINITY_MIN, 1 - 0.5 / 3);
  assert.ok(Math.abs((atHalfLife["timing"] ?? 0) - expected) < 1e-9,
    `half-life decay affine math must match (got ${atHalfLife["timing"]}, want ${expected})`);
}

function testReflectionParser() {
  // Deterministic reflection parser (SLOT EMNLP-I '25 / SchemaRL ACL '25):
  // must robustly extract SKOR/CACAT/PERBAIKAN even when the LLM deviates from
  // the strict template — no fragile single-line regex dependency.

  // Well-formed strict output.
  const good = parseReflection(
    "SKOR: 4\nCACAT: jawaban kurang sumber\nPERBAIKAN: tambahkan sitasi resmi pada klaim utama.",
  );
  assert.strictEqual(good.score, 4);
  assert.ok(good.critique.includes("kurang sumber"));
  assert.ok(good.improvement.includes("sitasi resmi"));

  // Deviated: extra preface + lowercase labels + multi-line improvement.
  const dev = parseReflection(
    "Saya nilai:\nskor: 2\ncacat: terlalu panjang\nperbaikan: ringkas menjadi\n3 baris saja.",
  );
  assert.strictEqual(dev.score, 2);
  assert.ok(dev.critique.includes("terlalu panjang"));
  assert.ok(dev.improvement.includes("ringkas menjadi"));

  // Score out of range is clamped to 1..5.
  const clamp = parseReflection("SKOR: 9\nCACAT: x\nPERBAIKAN: perbaiki sesuatu yang jelas dan cukup panjang.");
  assert.strictEqual(clamp.score, 5);
  const low = parseReflection("SKOR: 0\nCACAT: y\nPERBAIKAN: perbaiki sesuatu yang jelas dan cukup panjang.");
  assert.strictEqual(low.score, 1);

  // Missing PERBAIKAN label -> no improvement (fail-closed: keep original).
  const noFix = parseReflection("SKOR: 3\nCACAT: sedikit kurang relevan");
  assert.strictEqual(noFix.improvement, "");

  // Empty / no score -> safe defaults (score 0, no crash).
  const empty = parseReflection("");
  assert.strictEqual(empty.score, 0);
  assert.strictEqual(empty.improvement, "");
}

async function main() {
  testSlangExpansion();
  testTypoTolerance();
  testCommandWhitespace();
  testRawCommandArgsPreserved();
  testGroupPrefixStripping();
  testEmptyInput();
  testNonSlangPassThrough();
  testExpandedSlang();
  testFollowUpDetection();
  testFuzzyExtractTopic();
  await testPredictiveUrgencyRanking();
  await testFeedbackLearning();
  await testBehaviorAlignmentRanking();
  testReflectionParser();
  console.log("LOGIC TESTS PASSED");
}

main().catch((e) => {
  console.error("LOGIC TEST FAILED:", e);
  process.exit(1);
});

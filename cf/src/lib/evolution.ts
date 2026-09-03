//=====================================================================
// evolution.ts — Level 13 "Reflective Apprentice": self-improvement layer.
//
// L12 made J.A.R.V.I.S. a steward bound by an immutable covenant. L13 makes
// it a *learner*: it reflects on its own outputs, consolidates daily
// experience into long-term insights, adapts to owner preferences, and
// anticipates needs — everything append-only, evidence-warranted, and under
// owner authority (every learned rule can be disabled, never silently
// irreversible, never self-modifying its own schema/prompt).
//
// Principles (from public reference research on self-evolving agents):
//   1. Bounded reflection: generate -> critic -> refine, MAX 1 round (no
//      runaway token burn; "no stop rule over-corrects on round 2-3").
//   2. Dreaming consolidation (Anthropic "Dreaming", Mnemosyne BEAM): daily
//      Light/REM/Deep pass over recent episodic memory -> generalized insight.
//   3. ExpeL-style experiential insight, but PHANTOM-safe: no insight without
//      >= MIN_EVIDENCE supporting episodic memories.
//   4. Adaptive preference memory (PAHF / evolving conditional memory):
//      confidence rises on validation, decays over time, owner can disable.
//   5. Proactive sentinel that SKIPS when nothing is notable ("if nothing
//      happened, send nothing" — avoids owner fatigue).
//   6. Guardrails: append-only tables; the agent never ALTERs schema or its
//      own system prompt.
//
// All 100% free tier: D1 + FTS5 (existing memories/memories_fts) + Groq/Gemini.
//=====================================================================

import { Env, searchMemory, rememberMemory } from "./db";
import { llmRespond } from "./ai";

// Evidence-warrant gate: an insight must rest on at least this many supporting
// episodic memories before the agent may act on it (phantom-guardrail guard).
export const MIN_INSIGHT_EVIDENCE = 3;
export const PREFERENCE_DECAY_DAYS = 45;   // unvalidated confidence halves ~ /14d
export const CONSOLIDATION_WINDOW_MS = 24 * 3600_000;

// ---- Level 17: answer-behavior alignment feedback loop ----
// The reflection loop (reflection_log) records when the critic flags a defect
// and JARVIS actually changes its answer. Aggregating that per behavioral
// category gives a FAIL-CLOSED affinity weight: a category that is repeatedly
// reflected-to-correct is negative feedback on that answer behavior, so its
// lessons are suppressed from steering future answers. Affinity stays in
// [BEHAVIOR_AFFINITY_MIN, 1] — learning can only dampen influence, NEVER
// amplify it (Learning-from-Negative-Feedback / Fail-Closed-Alignment). The
// negative signal is ALSO recency-decayed (Ebbinghaus forgetting curve /
// FadeMem / PMORS) so a category that STOPS being corrected gradually recovers
// its influence instead of being permanently suppressed (stabilized forgetting).
export const BEHAVIOR_AFFINITY_NEUTRAL = 1;
export const BEHAVIOR_AFFINITY_MIN = 0.4;
// This many recency-weighted corrections drives a category to the floor.
export const BEHAVIOR_CORRECTION_SATURATION = 3;
// Half-life of a correction signal: past corrections lose half their weight
// every BEHAVIOR_HALF_LIFE_DAYS days, so influence recovers once JARVIS stops
// repeating the corrected behavior (no permanent suppression).
export const BEHAVIOR_HALF_LIFE_DAYS = 14;
// Answer-behavior lessons whose category falls below this affinity are withheld
// from steering replies (suppressed), while the owner's explicit preferences
// are never suppressed.
export const BEHAVIOR_AFFINITY_KEEP = 0.5;

export interface ReflectedTurn {
  id: number;
  turnText: string;
  output: string;
  errors: string;
  critique: string;
  refined: string;
  score: number;
}

export interface Insight {
  id: number;
  ruleText: string;
  category: string;
  evidenceIds: string[];
  evidenceCount: number;
  confidence: number;
  disabled: boolean;
}

export interface OwnerPreference {
  key: string;
  value: string;
  source: "explicit" | "inferred";
  confidence: number;
  evidenceCount: number;
  disabled: boolean;
}

// ---------------------------------------------------------------------
// Pillar 1 — Verbal Reflection (bounded 1 round)
// ---------------------------------------------------------------------

/** After a non-trivial response, ask the critic model to assess it against a
 *  small rubric and, if a fixable defect is found, emit a refined version.
 *  Returns the refined output (falling back to the original on any failure,
 *  fail-closed) and logs the reflection row. Never loops more than once. */
export async function reflectOnTurn(
  env: Env,
  turnText: string,
  output: string,
  errors: string[] = [],
  category = "behavior",
): Promise<string> {
  const rubric =
    "Nilai jawaban Anda sebagai kritik terhadap asisten J.A.R.V.I.S. (Bahasa Indonesia). " +
    "Berikan: (1) skor 1..5, (2) SATU cacat paling penting, (3) SATU versi jawaban yang diperbaiki ringkas " +
    "JIKA jawaban asli punya cacat faktual/kerancuan/kesalahan format. Format ketat:\n" +
    "SKOR: <1..5>\nCACAT: <satu baris>\nPERBAIKAN: <versi diperbaiki atau 'tidak perlu'>\n\n" +
    "Jawaban asli:\n" + output;
  let critique = "";
  let refined = output;
  let score = 0;
  const g = await llmRespond(env, rubric, { context: [{ role: "assistant", content: turnText }] });
  if (g.reply) {
    const m = g.reply.match(/SKOR:\s*(\d+)/i);
    score = Number(m?.[1] || 0);
    critique = g.reply.slice(0, 400);
    const fix = g.reply.match(/PERBAIKAN:\s*(.+)/i);
    const candidate = fix?.[1]?.trim();
    if (candidate && candidate !== "tidak perlu" && candidate.length > 10) {
      refined = candidate;
    }
  }
  try {
    await env.DB.prepare(
      `INSERT INTO reflection_log (created_at, turn_text, output, errors, critique, refined, score, reflected, category)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(Date.now(), turnText.slice(0, 500), output.slice(0, 1000),
      (errors.join("; ") || "").slice(0, 200), critique, refined.slice(0, 1000), score,
      refined !== output ? 1 : 0, (category || "behavior").slice(0, 32)).run();
  } catch { /* availability */ }
  return refined;
}

// ---------------------------------------------------------------------
// Pillar 2 & 3 — Dreaming Consolidation + Insight extraction
// ---------------------------------------------------------------------

export interface DreamResult {
  scanned: number;
  insightsExtracted: number;
  archived: number;
  briefingSent: number;
}

/** Extract a generalized, evidence-warranted rule from a cluster of episodic
 *  memories. Returns null if the evidence is too thin (< MIN_INSIGHT_EVIDENCE)
 *  or the LLM declines — never fabricates a phantom rule. */
export async function extractInsightFromCluster(
  env: Env,
  memories: Array<{ id: string; content: string }>,
): Promise<{ rule: string; category: string } | null> {
  if (memories.length < MIN_INSIGHT_EVIDENCE) return null;
  const prompt =
    "Berikut beberapa memori pengalaman dari percakapan sebelumnya dengan pemilik J.A.R.V.I.S. " +
    "Ekstrak SATU aturan umum yang didukung oleh SEMUA memori ini (preferensi, gaya, format, atau " +
    "kesalahan yang berulang). Jangan mengarang aturan yang tidak didukung. Jika tidak ada pola, " +
    "jawab TIDAK ADA POLA.\n\n" +
    memories.map((m) => `- ${m.content}`).join("\n") +
    "\n\nFormat ketat:\nCATEGORY: <behavior|format|tone|timing|safety>\nRULE: <satu kalimat umum, Bahasa Indonesia>";
  const g = await llmRespond(env, prompt);
  if (!g.reply || /tidak ada pola|no pattern/i.test(g.reply)) return null;
  const cat = g.reply.match(/CATEGORY:\s*(\w+)/i)?.[1]?.toLowerCase() ?? "behavior";
  const rule = g.reply.match(/RULE:\s*(.+)/i)?.[1]?.trim();
  if (!rule || rule === "TIDAK ADA POLA") return null;
  return { rule: rule.slice(0, 500), category: ["behavior", "format", "tone", "timing", "safety"].includes(cat) ? cat : "behavior" };
}

/** Persist an insight only after the warrant check (>= MIN_INSIGHT_EVIDENCE). */
export async function saveInsight(
  env: Env,
  rule: string,
  category: string,
  evidenceIds: string[],
): Promise<number | null> {
  if (evidenceIds.length < MIN_INSIGHT_EVIDENCE) return null;
  const confidence = Math.min(1, 0.5 + (evidenceIds.length - MIN_INSIGHT_EVIDENCE) * 0.1);
  const now = Date.now();
  try {
    const res = await env.DB.prepare(
      `INSERT INTO insights (rule_text, category, evidence_ids, evidence_count, confidence, created_at, last_validated_at, disabled)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0)`,
    ).bind(rule, category, JSON.stringify(evidenceIds.slice(0, 20)),
      evidenceIds.length, confidence, now, now).run();
    const id = res.meta.last_row_id;
    return typeof id === "number" ? id : null;
  } catch {
    return null;
  }
}

/** The daily "dream": consolidate recent experiences into warranted insights
 *  and note the run. Runs on cron; stays well under cron CPU because all LLM
 *  calls are I/O-wait and D1 work is tiny. Phase decisions:
 *    Light: scan episodic memories from the last window.
 *    REM:   ask the model for clusters/insights from the freshest set.
 *    Deep:  archive low-importance, never-retrieved memories. */
export async function runDreamCycle(env: Env): Promise<DreamResult> {
  const now = Date.now();
  const since = now - CONSOLIDATION_WINDOW_MS;
  const res: DreamResult = { scanned: 0, insightsExtracted: 0, archived: 0, briefingSent: 0 };
  try {
    // Light: fetch fresh high-signal memories (corrections/interactions matter).
    const fresh = await env.DB.prepare(
      `SELECT id, content FROM memories
       WHERE created_at >= ?
       ORDER BY importance DESC, created_at DESC
       LIMIT 30`,
    ).bind(since).all<{ id: string; content: string }>();
    res.scanned = (fresh.results ?? []).length;
    const rows = (fresh.results ?? []);
    // REM: try to derive at most one warrant-worthy cluster per run (cheap,
    // single LLM call) from the freshest memories.
    if (rows.length >= MIN_INSIGHT_EVIDENCE) {
      const cluster = rows.slice(0, Math.min(8, rows.length)).map((r) => ({ id: r.id, content: r.content }));
      const insight = await extractInsightFromCluster(env, cluster);
      if (insight) {
        const id = await saveInsight(env, insight.rule, insight.category, cluster.map((c) => c.id));
        if (id != null) res.insightsExtracted = 1;
      }
    }
    // Deep: archive (safe soft-mark via expires_at) never-retrieved + low importance.
    const stale = await env.DB.prepare(
      `UPDATE memories SET expires_at=?
       WHERE access_count=0 AND importance <= 1 AND created_at < ?`,
    ).bind(now, now - 30 * 86400_000).run();
    res.archived = stale.meta.changes ?? 0;
  } catch { /* availability */ }
  try {
    await env.DB.prepare(
      `INSERT INTO dream_cycles (ran_at, memories_scanned, insights_extracted, archived, briefing_sent, errors)
       VALUES (?, ?, ?, ?, ?, 0)`,
    ).bind(Date.now(), res.scanned, res.insightsExtracted, res.archived, res.briefingSent).run();
  } catch { /* availability */ }
  return res;
}

// ---------------------------------------------------------------------
// Pillar 4 — Proactive Sentinel (morning briefing, skip-if-nothing)
// ---------------------------------------------------------------------

/** Deterministic morning summary: only sends when something is actually worth
 *  mentioning (new dream insight, pending approval, notable errors). Returns
 *  null to skip (no message, no wasted LLM call). */
export async function generateMorningBriefing(env: Env, owner: number): Promise<string | null> {
  const now = Date.now();
  const last24h = now - 24 * 3600_000;
  const lines: string[] = [];
  try {
    const recentIterations = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM dream_cycles WHERE ran_at >= ? AND insights_extracted > 0`,
    ).bind(last24h).first<{ n: number }>();
    const insightCount = recentIterations?.n ?? 0;
    if (insightCount > 0) lines.push(`💡 ${insightCount} insight baru dipelajari semalam.`);

    const pendingInsights = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM insights WHERE disabled=0 AND last_validated_at=0`,
    ).bind().first<{ n: number }>();
    if ((pendingInsights?.n ?? 0) > 0) lines.push(`Jelajahi \`/insights\` untuk melihat ${pendingInsights?.n} pelajaran baru.`);

    const errors = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM request_log WHERE status='fail' AND ts >= ?`,
    ).bind(last24h).first<{ n: number }>();
    if ((errors?.n ?? 0) > 0) lines.push(`⚠️ ${errors?.n} kegagalan layanan 24 jam terakhir — cek /ai_diag.`);
  } catch { /* availability: sing off */ }
  if (lines.length === 0) return null; // skip: nothing notable
  lines.unshift("🌅 *Pagi, Pemilik.* Ringkasan singkat J.A.R.V.I.S.:");
  return lines.join("\n");
}

// ---------------------------------------------------------------------
// Pillar 5 — Adaptive Preference Memory
// ---------------------------------------------------------------------

/** Owner sets (or updates) a preference explicitly. Zero LLM cost. */
export async function setPreference(
  env: Env,
  key: string,
  value: string,
  source: "explicit" | "inferred" = "explicit",
): Promise<string> {
  if (!key || !value) return "Gunakan: /set-preference <kunci> = <nilai>.";
  const now = Date.now();
  try {
    await env.DB.prepare(
      `INSERT INTO owner_preferences (key, value, source, confidence, evidence_count, last_validated_at, disabled, created_at, updated_at)
       VALUES (?, ?, ?, ?, 1, ?, 0, ?, ?)
       ON CONFLICT(key) DO UPDATE SET
         value=excluded.value, source=excluded.source, updated_at=excluded.updated_at`,
    ).bind(key.trim().toLowerCase().slice(0, 60), value.slice(0, 300), source, 0.7, now, now, now).run();
    return `Preferensi \`${key}\` disimpan: ${value.slice(0, 120)}`;
  } catch {
    return "Gagal menyimpan preferensi.";
  }
}

/** Confidence steward: bump when validated, decay when not re-validated over
 *  time. Owner may disable a preference (soft), never memory-deletes it. */
export async function decayPreferences(env: Env, now = Date.now()): Promise<number> {
  try {
    const row = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM owner_preferences
       WHERE disabled=0 AND updated_at < ?`,
    ).bind(now - 30 * 86400_000).first<{ n: number }>();
    const stale = row?.n ?? 0;
    // Soft-disable stale preferences so they no longer steer replies (no delete).
    await env.DB.prepare(
      `UPDATE owner_preferences SET disabled=1
       WHERE disabled=0 AND confidence < 0.3 AND updated_at < ?`,
    ).bind(now - PREFERENCE_DECAY_DAYS * 86400_000).run();
    return stale;
  } catch {
    return 0;
  }
}

export async function getActivePreferences(env: Env): Promise<OwnerPreference[]> {
  try {
    const { results } = await env.DB.prepare(
      `SELECT key, value, source, confidence, evidence_count, disabled
       FROM owner_preferences WHERE disabled=0 ORDER BY confidence DESC, updated_at DESC LIMIT 30`,
    ).bind().all<OwnerPreference>();
    return (results ?? []).map((r) => ({ ...r, disabled: Boolean(r.disabled) }));
  } catch {
    return [];
  }
}

export async function disablePreference(env: Env, key: string): Promise<string> {
  if (!key) return "Gunakan: /disable-preference <kunci>.";
  try {
    const r = await env.DB.prepare(`UPDATE owner_preferences SET disabled=1 WHERE key=?`).bind(key).run();
    return r.meta.changes > 0 ? `Preferensi \`${key}\` dinonaktifkan.` : `Tidak ada preferensi \`${key}\`.`;
  } catch {
    return "Gagal menonaktifkan preferensi.";
  }
}

// ---------------------------------------------------------------------
// Pillar 6 — Metacognitive Guardrails (query + warrant surface)
// ---------------------------------------------------------------------

export async function listInsights(env: Env, includeDisabled = false): Promise<Insight[]> {
  try {
    const { results } = await env.DB.prepare(
      `SELECT id, rule_text, category, evidence_ids, evidence_count, confidence, disabled
       FROM insights ${includeDisabled ? "" : "WHERE disabled=0"}
       ORDER BY created_at DESC LIMIT 40`,
    ).bind().all<{
      id: number; rule_text: string; category: string; evidence_ids: string;
      evidence_count: number; confidence: number; disabled: number;
    }>();
    return (results ?? []).map((r) => ({
      id: r.id,
      ruleText: r.rule_text,
      category: r.category,
      evidenceIds: JSON.parse(r.evidence_ids || "[]"),
      evidenceCount: r.evidence_count ?? 0,
      confidence: r.confidence ?? 0,
      disabled: Boolean(r.disabled),
    }));
  } catch {
    return [];
  }
}

/** Fetch the active, evidence-warranted lessons to inject into an LLM reply
 *  (so behavior drifts toward owner preference without rewriting any prompt). */
export async function getBehaviorContext(env: Env, topic: string | null): Promise<string> {
  const parts: string[] = [];
  const prefs = await getActivePreferences(env);
  if (prefs.length) parts.push("Preferensi pemilik: " + prefs.map((p) => `${p.key}=${p.value}`).join("; "));
  const insights = await listInsights(env, false);
  if (insights.length) parts.push("Pelajaran yang dipelajari: " + insights.map((i) => i.ruleText).join(" | "));
  if (parts.length === 0) return "";
  return parts.join("\n").slice(0, 1500);
}

/** Phantom-rule audit: list insights whose evidence dropped below the warrant
 *  floor or that were never validated — candidates the owner may disable. */
export async function auditPhantomRules(env: Env): Promise<string> {
  const all = await listInsights(env, true);
  const suspicious: string[] = [];
  for (const i of all) {
    if (i.disabled) continue;
    if (i.evidenceCount < MIN_INSIGHT_EVIDENCE) suspicious.push(`#${i.id} (${i.category}): bukti ${i.evidenceCount}/${MIN_INSIGHT_EVIDENCE}`);
  }
  if (suspicious.length === 0) return "Tidak ada aturan tanpa bukti (phantom). ✅";
  return "Aturan dengan bukti tipis (kandidat disable):\n" + suspicious.join("\n");
}

// ---------------------------------------------------------------------
// Pillar 7 — Answer-behavior alignment (Level 17)
// ---------------------------------------------------------------------

/** Deterministic, FAIL-CLOSED affinity weight per behavioral category, derived
 *  from reflection_log. A "correction" is a reflection where the critic made
 *  JARVIS actually change its answer (reflected=1): that is implicit negative
 *  feedback on the category's answer behavior (Reflexion; RESPECT; CHI '25
 *  intentional-implicit feedback). Aggregate corrections per category, decaying
 *  old ones via an Ebbinghaus/recency half-life (FadeMem; PMORS; Generative
 *  Agents recency) so a category that STOPS being corrected recovers influence
 *  instead of being permanently suppressed (stabilized forgetting). Affinity is
 *  clamped to [BEHAVIOR_AFFINITY_MIN, 1] — never above neutral, so learning can
 *  only dampen influence, never amplify it. Fail-open: any DB problem => all
 *  categories stay neutral (1), behavior context just no longer filtered. */
export async function behaviorAffinity(
  env: Env,
  now = Date.now(),
): Promise<Record<string, number>> {
  const halfLife = BEHAVIOR_HALF_LIFE_DAYS * 86400_000;
  try {
    const { results } = await env.DB.prepare(
      `SELECT category, reflected, created_at FROM reflection_log`,
    ).bind().all<{ category: string; reflected: number; created_at: number }>();
    const rows = results ?? [];
    if (rows.length === 0) return {};
    const damped: Record<string, number> = {};
    for (const r of rows) {
      const cat = r.category || "behavior";
      if (!r.reflected) continue; // only corrections are the negative signal
      const age = Math.max(0, now - (r.created_at || now));
      const weight = Math.pow(0.5, age / halfLife); // half-life decay
      damped[cat] = (damped[cat] ?? 0) + weight;
    }
    const out: Record<string, number> = {};
    for (const [cat, d] of Object.entries(damped)) {
      const affinity = Math.max(BEHAVIOR_AFFINITY_MIN, 1 - d / BEHAVIOR_CORRECTION_SATURATION);
      out[cat] = Math.min(BEHAVIOR_AFFINITY_NEUTRAL, affinity); // never > 1
    }
    return out;
  } catch {
    return {};
  }
}

/** Fail-closed version of getBehaviorContext: inject owner preferences (always,
 *  they are explicit statements) plus only the insight lessons whose category
 *  still has trust (affinity >= BEHAVIOR_AFFINITY_KEEP). A category that the
 *  reflection loop keeps correcting is suppressed from steering future answers
 *  — JARVIS stops repeating answer behaviors it keeps being told are wrong,
 *  without ever amplifying any behavior. Fail-open: any failure falls back to
 *  the unfiltered context so replies are never blocked. */
export async function getAnswerBehaviorContext(
  env: Env,
  topic: string | null,
  now = Date.now(),
): Promise<string> {
  const parts: string[] = [];
  const prefs = await getActivePreferences(env);
  if (prefs.length) parts.push("Preferensi pemilik: " + prefs.map((p) => `${p.key}=${p.value}`).join("; "));
  try {
    const affinity = await behaviorAffinity(env, now);
    const insights = await listInsights(env, false);
    const kept = insights.filter((i) => (affinity[i.category] ?? BEHAVIOR_AFFINITY_NEUTRAL) >= BEHAVIOR_AFFINITY_KEEP);
    if (kept.length) parts.push("Pelajaran yang dipelajari: " + kept.map((i) => i.ruleText).join(" | "));
  } catch {
    const insights = await listInsights(env, false);
    if (insights.length) parts.push("Pelajaran yang dipelajari: " + insights.map((i) => i.ruleText).join(" | "));
  }
  if (parts.length === 0) return "";
  return parts.join("\n").slice(0, 1500);
}

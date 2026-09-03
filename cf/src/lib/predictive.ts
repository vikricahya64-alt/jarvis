//=====================================================================
// predictive.ts — Level 16 "Predictive Steward": proactive suggestions.
//
// J.A.R.V.I.S. becomes *anticipatory* WITHOUT becoming independent: it
// surfaces concrete, read-only suggestions to the owner drawn from signals it
// already holds (preferences, insights, scheduled tasks, pending approvals).
// A suggestion is ONLY a text "offer" — acting on one is an explicit owner
// decision. The origin gate (predictive => DEFER, never auto-run) plus the
// fail-closed constitutional guard are unchanged; this adds NO execution path.
//
// Research-driven design (applied Level 16):
//   * Timing > volume — we only surface via the daily morning digest (cron 0 7,
//     wired in index.ts), never interrupt per-event. Notification fatigue is the
//     top failure mode for proactive agents (Zylos/IBM), so we digest.
//   * Urgency scoring — not every signal is worth the owner's attention. Each
//     candidate is scored; only those above a threshold are offered, and we cap
//     the batch tight (~3, not 6).
//   * Short bullets > long blocks (CHI 2025) — each offer is one concise line
//     with an inline accept/dismiss action.
//   * Human-on-the-loop, low-approval (arXiv Proactive Agent) — we *offer*,
//     never execute. Acting on an offer is an explicit owner decision.
//   * Learned dismiss — a dismissed suggestion's source is never re-offered
//     (driven by the dedup guard + offeredSourceKeys), so JARVIS learns what
//     the owner ignores. Observed acceptance/dismissal can later tune urgency.
//
// Skip-if-nothing (owner-fatigue guard): offerSuggestions returns null and the
// cron sends no Telegram message when there are no NEW, undismissed suggestions.
//
// All 100% free-tier D1 (migration 0008). Deterministic reads, no LLM needed
// to form the candidates themselves (cheap, never bloats the LLM budget).
//=====================================================================

import { Env, pendingProposals } from "./db";
import { listInsights, getActivePreferences } from "./evolution";
import { getScheduledTasks } from "./maestro";

export interface Suggestion {
  id: number;
  category: string;
  text: string;
  sourceKey: string;
  status: "offered" | "accepted" | "dismissed";
  urgency: number;
  createdAt: number;
}

export interface SuggestionCandidate {
  category: "preference" | "insight" | "task" | "approval";
  text: string;
  sourceKey: string;  // dedup key: e.g. "pref:<key>", "insight:<id>", "task:<id>", "approval:<id>"
  urgency: number;    // 0..1 — higher = more worth the owner's attention (research: score before interrupt)
}

// Urgency thresholds — tuning knobs for the offer gate (research: selective
// interruption; only interrupt when it clears the bar).
export const URGENCY_THRESHOLD = 0.5;   // offer only candidates at/above this
export const MAX_OFFER_BATCH = 3;       // tight cap — never overwhelm the owner (was 6)

/**
 * Deterministically gather NEW, high-urgency suggestion candidates from signals
 * JARVIS already holds. Each returns a concrete, actionable, one-line offer in
 * Bahasa Indonesia. No LLM call — pure D1 reads, so it's cheap on cron and never
 * burns the research/LLM budget. Returns only candidates whose source hasn't
 * already been offered AND whose urgency clears the threshold.
 */
export async function gatherSuggestionCandidates(
  env: Env,
  owner: number,
  alreadyOffered: Set<string>,
): Promise<SuggestionCandidate[]> {
  // Ranked pool, closed later by urgency threshold + batch cap.
  const pool: SuggestionCandidate[] = [];

  // 1) Approval signals — highest urgency: open value-alignment / configuration
  //    proposals are deviations waiting on the owner's explicit consent (L13
  //    warrant). Never validate on JARVIS's own say-so.
  const props = await pendingProposals(env, owner, 5).catch(() => []);
  for (const p of props) {
    const key = `approval:${p.id}`;
    if (alreadyOffered.has(key)) continue;
    // An open proposal expiring soon is the most pressing item JARVIS can surface.
    const timeLeft = p.expires_at - Date.now();
    const recency = Math.max(0, 1 - timeLeft / 7_776_000_000); // 90d window
    const urgency = Math.min(1, 0.65 + p.confidence * 0.15 + recency * 0.2);
    pool.push({
      category: "approval",
      text: `⚠️ Tinjau proposal: "${p.new_proposal.slice(0, 90)}"`,
      sourceKey: key,
      urgency,
    });
  }

  // 2) Task signals — a scheduled task about to run unapproved, or a high-risk
  //    delegated task, is worth a heads-up before it fires (HOTL).
  const tasks = await getScheduledTasks(env, owner).catch(() => []);
  for (const t of tasks) {
    const key = `task:${t.id}`;
    if (alreadyOffered.has(key)) continue;
    let urgency = 0.3;
    if (!t.approved) urgency = Math.max(urgency, t.riskLevel === "high" ? 0.75 : 0.6);
    else if (t.scheduleAt && t.scheduleAt - Date.now() < 86400_000) urgency = 0.55; // runs w/in a day
    pool.push({
      category: "task",
      text: `🗓️ ${t.approved ? "Jalankan segera:" : "Belum disetujui:"} "${t.description.slice(0, 90)}"`,
      sourceKey: key,
      urgency,
    });
  }

  // 3) Insight signals — a high-confidence, never-validated lesson is worth the
  //    owner confirming (lights up the L13 warrant loop). Only moderately urgent.
  const insights = await listInsights(env, false).catch(() => []);
  for (const ins of insights) {
    const key = `insight:${ins.id}`;
    if (alreadyOffered.has(key)) continue;
    if (ins.confidence >= 0.6) {
      pool.push({
        category: "insight",
        text: `🧠 Konfirmasi pelajaran: "${ins.ruleText.slice(0, 90)}"`,
        sourceKey: key,
        urgency: 0.35 + ins.confidence * 0.25,
      });
    }
  }

  // 4) Preference signals — a cadence-like preference (explicit, confident) with
  //    no matching task could become a delegated routine. Lowest urgency.
  const prefs = await getActivePreferences(env).catch(() => []);
  for (const p of prefs) {
    const key = `pref:${p.key}`;
    if (alreadyOffered.has(key)) continue;
    if (p.source === "explicit" && p.confidence >= 0.5) {
      pool.push({
        category: "preference",
        text: `🔁 Rutinkan preferensi "${p.key}=${p.value}"?`,
        sourceKey: key,
        urgency: 0.35 + p.confidence * 0.25,
      });
    }
  }

  // Research: urgency-sort then take the tight cap of items that clear the bar —
  // never bother the owner with low-value noise.
  return pool
    .filter((c) => c.urgency >= URGENCY_THRESHOLD)
    .sort((a, b) => b.urgency - a.urgency)
    .slice(0, MAX_OFFER_BATCH);
}

/** Load the set of source_keys already offered (for dedup). */
export async function offeredSourceKeys(env: Env, owner: number): Promise<Set<string>> {
  const { results } = await env.DB.prepare(
    `SELECT source_key FROM suggestions WHERE owner_id = ? AND status != 'dismissed'`,
  ).bind(owner).all<{ source_key: string }>();
  return new Set((results ?? []).map((r) => r.source_key).filter(Boolean));
}

/**
 * Offer any NEW suggestion candidates to the owner as a proactive Telegram-ready
 * digest message. Returns a message string to send, or null to SKIP (nothing
 * new / nothing cleared the urgency bar / all dismissed) — the owner-fatigue
 * guard. Inserts each candidate into `suggestions` so it's never re-offered
 * while open. Fail-open: any DB error degrades to "skip", never blocks.
 */
export async function offerSuggestions(env: Env, owner: number): Promise<string | null> {
  try {
    const already = await offeredSourceKeys(env, owner);
    const candidates = await gatherSuggestionCandidates(env, owner, already);
    if (candidates.length === 0) return null; // skip: nothing actionable

    const now = Date.now();
    const rows = candidates.map((c) => ({
      category: c.category,
      text: c.text,
      source_key: c.sourceKey,
      urgency: c.urgency,
    }));

    const insert = env.DB.prepare(
      `INSERT INTO suggestions (owner_id, category, text, source_key, status, urgency, created_at)
       VALUES (?, ?, ?, ?, 'offered', ?, ?)`,
    );
    for (const r of rows) {
      await insert.bind(owner, r.category, r.text, r.source_key, r.urgency, now).run().catch(() => {});
    }

    // Re-read ids so the digest can name concrete /suggestion accept <id> targets.
    const fresh = await listSuggestions(env, owner);
    const bySrc = new Map(fresh.map((s) => [s.sourceKey, s.id]));

    // One concise bullet per suggestion, each naming its trigger provenance
    // (per "Proactive, But Not Creepy": explain what triggered it, with an
    // immediate actionable control). Id prefix lets the owner act inline.
    const lines = [
      "💡 *Saran J.A.R.V.I.S.* — hanya tawaran, tak ada yang dieksekusi otomatis.",
      "",
      ...rows.map((r) => {
        const id = bySrc.get(r.source_key) ?? "?";
        const kind =
          r.category === "approval" ? "persetujuan" :
          r.category === "task" ? "tugas" :
          r.category === "insight" ? "pelajaran" : "preferensi";
        return `• (${id}) [${kind}] ${r.text}`;
      }),
      "",
      "Aksi: \`/suggestion accept <id>\` · \`/suggestion dismiss <id>\` · abaikan bila tak relevan.",
    ];
    return lines.join("\n");
  } catch {
    return null; // fail-open: never block on a suggestion
  }
}

/** List current suggestions (for /suggestions). */
export async function listSuggestions(env: Env, owner: number): Promise<Suggestion[]> {
  const { results } = await env.DB.prepare(
    `SELECT id, category, text, source_key, status, urgency, created_at
     FROM suggestions WHERE owner_id = ? AND status != 'dismissed'
     ORDER BY created_at DESC LIMIT 25`,
  ).bind(owner).all<{
    id: number; category: string; text: string; source_key: string;
    status: "offered" | "accepted" | "dismissed"; urgency: number; created_at: number;
  }>();
  return (results ?? []).map((r) => ({
    id: r.id, category: r.category, text: r.text, sourceKey: r.source_key,
    status: r.status, urgency: r.urgency ?? 0, createdAt: r.created_at,
  }));
}

/** Owner resolves a suggestion: accept (mark accepted; optionally able to become
 *  a scheduled task later via /schedule) or dismiss (never re-offer). */
export async function resolveSuggestion(
  env: Env,
  owner: number,
  id: number,
  action: "accept" | "dismiss",
): Promise<string> {
  const outcome = action === "accept" ? "accepted" : "dismissed";
  try {
    const res = await env.DB.prepare(
      `UPDATE suggestions SET status = ?, updated_at = ? WHERE id = ? AND owner_id = ?`,
    ).bind(outcome, Date.now(), id, owner).run();
    if (res.meta.changes > 0) {
      if (action === "accept") {
        // HOTL: accepting only signals JARVIS to *prepare* the next step as an
        // offer; nothing executes yet. The owner still drives any delegation.
        return (
          `✅ Saran #${id} diterima. Sinyal tercatat — aku tak mengeksekusi apa pun otomatis.\n` +
          `Ketik kebutuhanmu (mis. \`/schedule <kebutuhan>\`) untuk meneruskan, atau ketik \`/suggestions\` untuk sisa daftar.`
        );
      }
      return `🚫 Saran #${id} ditutup; JARVIS tak akan menawarkannya lagi (learned dismiss).`;
    }
    return `Tidak ada saran #${id} (mungkin sudah diproses).`;
  } catch {
    return "Gagal memproses saran.";
  }
}

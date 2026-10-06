//=====================================================================
// degradation.ts — Graceful Degradation (Level 12)
//
// Ketika mendekati batas kuota free-tier, secara otomatis mengecilkan
// non-esensial features sambil mempertahankan esensial (covenant, DMS, override).
// Integrasi dengan modul pemantauan, tidak ada dependency pada layanan berbayar.
//=====================================================================

import { Env } from "./db";

export interface FeaturePriority {
  name: string;
  essential: boolean;
  minQuota: number;   // 0.0 = always on, 1.0 = never on
  description: string;
}

export const FEATURE_PRIORITY: FeaturePriority[] = [
  { name: "covenant_enforcement", essential: true, minQuota: 0.0, description: "Perjanjian immutable dan validasi" },
  { name: "dms_dead_mans_switch", essential: true, minQuota: 0.0, description: "State machine, auto-kematian" },
  { name: "emergency_override", essential: true, minQuota: 0.0, description: "Bypasses DMS, berhenti/kill/override" },
  { name: "user_command_processing", essential: false, minQuota: 0.1, description: "Telegram parsing, command hierarchy" },
  { name: "value_alignment_check", essential: false, minQuota: 0.2, description: "Proposals, nilai alignment" },
  { name: "predictive_intuition", essential: false, minQuota: 0.4, description: "ML inference, tindakan proaktif" },
  { name: "existential_audit", essential: false, minQuota: 0.6, description: "Audit eksistensial mingguan" },
  { name: "federated_learning", essential: false, minQuota: 0.8, description: "FL lintas-owner" },
];

/** Cek status degradasi saat ini dan kembalikan daftar fitur yang dinonaktifkan */
export async function getDegradationStatus(env: Env): Promise<{ remainingPct: number; disabledFeatures: string[] }> {
  const row = await env.DB.prepare(
    `SELECT quota_snapshot, remaining_pct, disabled_features FROM degradation_state WHERE owner_id = 0 LIMIT 1`,
  ).first();
  if (!row) {
    // Inisialisasi jika belum ada
    await env.DB.prepare(
      `INSERT INTO degradation_state (owner_id, quota_snapshot, remaining_pct, disabled_features, updated_at)
       VALUES (0, 100, 100, '[]', ${Date.now()}) ON CONFLICT(owner_id) DO NOTHING`,
    ).run();
    return { remainingPct: 100, disabledFeatures: [] };
  }
  return {
    remainingPct: (row as { remaining_pct: number }).remaining_pct,
    disabledFeatures: safeParseFeatures((row as { disabled_features: string }).disabled_features),
  };
}

/** JSON.parse with a degenerate-input fallback so a corrupt quota row can
 *  never crash /status. */
function safeParseFeatures(raw: string): string[] {
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? (v as string[]) : [];
  } catch {
    return [];
  }
}

/** Update quota snapshot dan perbarui daftar fitur yang dinonaktifkan */
export async function updateQuotaSnapshot(
  env: Env,
  owner: number,
): Promise<{ disabledFeatures: string[]; changed: boolean }> {
  const now = Date.now();
  const usagePct = await calculateUsagePercent(env);
  const remainingPct = Math.max(0, 100 - usagePct);

  const disabled: string[] = [];

  for (const feat of FEATURE_PRIORITY) {
    if (remainingPct < feat.minQuota * 100 + 0.01) { // minQuota * 100 + tolerance
      disabled.push(feat.name);
    } else {
      break; // karena fitur diurutkan berdasarkan prioritas
    }
  }

  // Upsert, not plain INSERT. owner_id is the PRIMARY KEY, so the first call
  // created the row and every call after it threw
  // "UNIQUE constraint failed: degradation_state.owner_id" - which silently
  // froze the snapshot. Production showed remaining_pct stuck at 99.688 and
  // disabled_features stuck at "[]" since 2026-09-03, i.e. the degradation
  // feature could never actually suspend anything, while /status still
  // reported it as healthy. The bootstrap path above already uses
  // ON CONFLICT(owner_id) DO NOTHING; this is the write side of the same row.
  await env.DB.prepare(
    `INSERT INTO degradation_state (owner_id, quota_snapshot, remaining_pct, disabled_features, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(owner_id) DO UPDATE SET
       quota_snapshot=excluded.quota_snapshot,
       remaining_pct=excluded.remaining_pct,
       disabled_features=excluded.disabled_features,
       updated_at=excluded.updated_at`,
  ).bind(
    owner, usagePct, remainingPct, JSON.stringify(disabled), now,
  ).run();

  // Alert on TRANSITION, not on state.
  //
  // This ran whenever `disabled.length > 0`, so with a 5-minute cadence it
  // would write ~288 identical rows a day and, once the owner is notified at
  // all, spam them identically. What the owner needs to know is that the set
  // CHANGED. Compare against what was stored and return the transition so the
  // caller can act on it.
  const previous = await env.DB.prepare(
    "SELECT disabled_features FROM degradation_state WHERE owner_id = ?",
  ).bind(owner).first<{ disabled_features: string }>();
  const before = safeParseFeatures(previous?.disabled_features ?? "[]");
  const changed = before.length !== disabled.length
    || before.some((f) => !disabled.includes(f));

  if (changed && disabled.length > 0) {
    await env.DB.prepare(
      `INSERT INTO degradation_alerts (owner_id, message, created_at)
       VALUES (?, ?, ?)`,
    ).bind(owner, `⚠️ Fitur non-esensial ditangguhkan: ${disabled.join(", ")}`, now).run();
  }
  if (changed) {
    console.log(
      `[degradation] owner=${owner} remaining=${remainingPct.toFixed(1)}% ` +
      `disabled ${before.length ? before.join(",") : "(none)"} -> ${disabled.length ? disabled.join(",") : "(none)"}`,
    );
  }

  return { disabledFeatures: disabled, changed };
}

/** Hitung penggunaan kuota saat ini (contoh: dms + obedience + auto tasks) */
async function calculateUsagePercent(env: Env): Promise<number> {
  const now = Date.now();
  const dayInMs = 86400_000;
  const startOfDay = now - dayInMs;

  // Hitung DMS Cron executions
  const dmsRows = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM obedience_audit WHERE ts >= ? AND action_type IN ('AUTONOMOUS_ACTION', 'USER_COMMAND')`,
  ).bind(startOfDay).first();
  const dmsCount = (dmsRows as { n: number })?.n ?? 0;

  // Hitung opsion GQ calls (bukan CPU) - hard estimate
  const groqEstimate = Math.min(30, dmsCount * 0.5);

  // Hitung webhook responses
  const webhookRows = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM obedience_audit WHERE ts >= ? AND action_type = 'USER_COMMAND'`,
  ).bind(startOfDay).first();
  const webhookCount = (webhookRows as { n: number })?.n ?? 0;

  // Hitung penggunaan sederhana: 1 setiap 1000 req + 0.5 setiap DMS + 0.2 setiap webhook
  const usage = groqEstimate * 1 + dmsCount * 0.5 + webhookCount * 0.2;
  const pct = Math.min(100, (usage / 10000) * 100); // anggap 10k req = 100%

  return pct;
}

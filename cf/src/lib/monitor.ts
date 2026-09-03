//=====================================================================
// monitor.ts — Environment Monitor (Level 12)
//
// Pelacakan kuota free-tier, deteksi ambang, integrasi degradasi.
// Tidak ada layanan eksternal, semua berdasarkan perhitungan D1.
//=====================================================================

import { Env } from "./db";
import { FeaturePriority, updateQuotaSnapshot, FEATURE_PRIORITY } from "./degradation";

/** Cron: update snapshot quota setiap 5 menit */
export async function refreshQuotaSnapshot(env: Env, owner: number): Promise<void> {
  await updateQuotaSnapshot(env, owner);
}

/** Ambil status degradasi saat ini (hanya baca) */
export async function getCurrentDegradation(env: Env, owner: number): Promise<any> {
  const row = await env.DB.prepare(
    `SELECT remaining_pct, disabled_features FROM degradation_state WHERE owner_id = ? LIMIT 1`,
  ).bind(owner).first();
  if (!row) {
    // Tidak ada snapshot, kembalikan default sehat
    return { remainingPct: 100, disabledFeatures: [] };
  }
  return {
    remainingPct: (row as { remaining_pct: number }).remaining_pct,
    disabledFeatures: JSON.parse((row as { disabled_features: string }).disabled_features),
  };
}

/** Kirim alert user (opsional, bisa terintegrasi dengan Telegram nanti) */
export async function sendDegradationAlert(env: Env, owner: number, message: string): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO degradation_alerts (owner_id, message, created_at) VALUES (?, ?, ?)`,
  ).bind(owner, message.slice(0, 500), Date.now()).run();
  // Integrasi future: Telegram sendMessage here
}

/** Intisari status untuk dashboard */
export async function getStatusSummary(env: Env, owner: number): Promise<any> {
  const quota = await getCurrentDegradation(env, owner);
  const features: FeaturePriority[] = FEATURE_PRIORITY;

  const status = {
    healthy: quota.remainingPct >= 80,
    warning: quota.remainingPct < 80 && quota.remainingPct >= 50,
    critical: quota.remainingPct < 50,
    quota_pct: quota.remainingPct,
    disabled: quota.disabledFeatures,
    feature_summary: features.map((f: FeaturePriority) => ({
      name: f.name,
      essential: f.essential,
      disabled: quota.disabledFeatures.includes(f.name),
    })),
  };

  return status;
}

/** Reset snapshot (untuk testing) */
export async function resetQuotaSnapshot(env: Env, owner: number): Promise<void> {
  await env.DB.prepare(
    `DELETE FROM degradation_state WHERE owner_id = ?`,
  ).bind(owner).run();
}

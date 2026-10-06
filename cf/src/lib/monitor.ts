//=====================================================================
// monitor.ts — Environment Monitor (Level 12)
//
// Pelacakan kuota free-tier, deteksi ambang, integrasi degradasi.
// Tidak ada layanan eksternal, semua berdasarkan perhitungan D1.
//=====================================================================

import { Env } from "./db";
import { updateQuotaSnapshot } from "./degradation";

/**
 * Refresh the quota snapshot, on the six-hourly cron that already drives it.
 *
 * Two corrections to what was recorded here before, both found by auditing the
 * live system rather than the code:
 *
 *  - It was documented as running "every 5 minutes" with zero callers. That was
 *    WRONG on the second count: index.ts imported it as `monitorRefresh` and
 *    called it from the six-hourly branch. An audit that greps the original name
 *    misses an aliased call, so "no callers" is not a conclusion you get to
 *    assert without checking both names.
 *
 *  - degradation_state looked frozen because it genuinely was, but not for the
 *    reason assumed. updateQuotaSnapshot did a plain INSERT against the primary
 *    key, so the first run created the row and every run after it threw
 *    UNIQUE constraint failed. With that fixed, the six-hourly cron updated the
 *    row on its next tick (2026-10-06 06:00:47), so the feature works on the
 *    schedule it always had.
 *
 * What was genuinely missing is the delivery half: degradation_alerts was
 * written and never read, so the "notify the owner" in the code was fiction.
 * The owner is now actually messaged - on a TRANSITION of the disabled-feature
 * set only, so a sustained degraded state does not repeat every cycle.
 *
 * No second scheduler is introduced here; the cadence lives with its caller.
 */
export async function refreshQuotaSnapshot(env: Env, owner: number): Promise<void> {
  const { disabledFeatures, changed } = await updateQuotaSnapshot(env, owner)
    .catch(() => ({ disabledFeatures: [] as string[], changed: false }));
  if (!changed || disabledFeatures.length === 0) return;
  // The alert row is bookkeeping nobody was reading. This is the notification
  // the code has always claimed to send: it fires only on a TRANSITION, so a
  // sustained degraded state does not repeat every cycle.
  const { sendMessage } = await import("./telegram");
  await sendMessage(env, owner,
    `⚠️ Fitur non-esensial ditangguhkan karena kuota: ${disabledFeatures.join(", ")}.\n` +
    `Fitur esensial tetap aktif.`)
    .catch(() => {});
}

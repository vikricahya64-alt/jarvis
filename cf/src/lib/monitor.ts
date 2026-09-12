//=====================================================================
// monitor.ts — Environment Monitor (Level 12)
//
// Pelacakan kuota free-tier, deteksi ambang, integrasi degradasi.
// Tidak ada layanan eksternal, semua berdasarkan perhitungan D1.
//=====================================================================

import { Env } from "./db";
import { updateQuotaSnapshot } from "./degradation";

/** Cron: update snapshot quota setiap 5 menit */
export async function refreshQuotaSnapshot(env: Env, owner: number): Promise<void> {
  await updateQuotaSnapshot(env, owner);
}

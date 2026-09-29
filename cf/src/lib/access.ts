// ACCESS CONTROL — dua tier: owner (penuh) vs user (penuh, TERISOLASI).
//
// KEBUTUHAN (m9-v11.55): owner ingin membuka gerbang — siapa pun yang bertanya
// ke JARVIS boleh memakai FUNGSI PENUH, tanpa daftar ID per pengguna. Yang
// tetap dijaga adalah DATA owner, bukan daftar orang.
//
// MODEL: akses FUNGSIONAL terbuka, akses DATA terisolasi per-user.
//   - Semua non-owner = tier "user": obrolan, memory, todo, reminder, /tugas,
//     /etask, /mcp, /pinjam, /proyek, /baca, search, gambar — semuanya jalan.
//   - Data TIDAK dibagi: memory, sesi, negosiasi, dan tugas di-scope lewat
//     owner_id (migrasi 0020 + searchMemory/rememberMemory). Temanmu memakai
//     JARVIS-nya sendiri; dia tak pernah membaca memo, hasil eksekusi, atau
//     riwayat milik owner.
//   - Owner-only (tak berubah): kendali atas bot itu sendiri — privacy mode,
//     autonomy pause/resume, admin, audit, debug, evolution, preferences.
//     Itu pengaturan owner atas JARVIS-nya, bukan "fungsi".
//
// Kenapa bukan buka data juga: satu akun salah bisa membaca nama, pekerjaan,
// dan rencana pribadi owner, dan itu tak bisa ditarik kembali. Isolasi
// per-user memberi FUNGSI PENUH tanpa kebocoran; biayanya satu kolom
// owner_id yang sudah ada di separuh tabel.
//
// KUOTA: kunci LLM dibayar owner dan gerbang kini terbuka untuk siapa pun,
// jadi rem kuota per-telegram-id untuk tier "user" WAJIB ada.

import type { Env } from "./db";

/** Tier akses. owner = penuh. user = penuh, data terisolasi. */
export type AccessTier = "owner" | "user";

/** Kapabilitas yang WAJIB owner — kendali atas bot & data owner. Dicatat
 *  eksplisit supaya mudah diaudit: daftar ini adalah kebocoran yang kita
 *  CEGAH, bukan daftar yang boleh dibuka ke semua orang. */
const OWNER_ONLY_CAPABILITIES = [
  "privacy_mode", "autonomy", "admin", "audit", "debug",
  "evolution", "preferences", "identity_epoch", "covenant",
  "obedience_report", "dm_status", "queue_status", "insights_admin",
  "multi_user_config",
] as const;

/** Tier untuk sebuah user id. Satu-satunya sumber kebenaran (dulu ini
 *  spread di webhook sebagai OWNER_OK; sekarang terpusat + bisa diuji). */
export function tierFor(env: Env, userId: number | string): AccessTier {
  return String(userId) === String(env.OWNER_TELEGRAM_ID) ? "owner" : "user";
}

/** Apakah user ini owner? (pembungkus tipis, enak dibaca di call-site lama) */
export function isOwner(env: Env, userId: number | string): boolean {
  return tierFor(env, userId) === "owner";
}

/** Gate kapabilitas. Owner selalu boleh. Tier "user" (semua non-owner) boleh
 *  semua kapabilitas fungsional; hanya OWNER_ONLY_CAPABILITIES yang ditolak. */
export function gateCapability(
  env: Env,
  userId: number | string,
  capability: string,
): { allowed: boolean; tier: AccessTier; reason: string } {
  const tier = tierFor(env, userId);
  if (tier === "owner") return { allowed: true, tier, reason: "owner" };
  // Owner-only ditebak SEBELUM tier user — kendali atas bot milik owner
  // tidak dibuka ke user mana pun.
  if (isOwnerOnlyCapability(capability)) {
    return { allowed: false, tier, reason: `capability "${capability}" owner-only` };
  }
  // Tier "user" (semua non-owner) boleh SEMUA kapabilitas fungsional; hanya
  // OWNER_ONLY_CAPABILITIES di atas yang ditolak.
  return { allowed: true, tier, reason: "user_full" };
}

/** Apakah kapabilitas ini owner-only menurut konfigurasi saat ini?
 *  Dipakai test agar daftar OWNER_ONLY tak bisa diam-diam melebar. */
export function isOwnerOnlyCapability(capability: string): boolean {
  return (OWNER_ONLY_CAPABILITIES as readonly string[]).includes(capability);
}

/** Pesan penolakan untuk perintah owner-only. Singkat, ramah, dan TIDAK
 *  membocorkan kapabilitas apa saja yang ada (tiada enumeration privilege). */
export function ownerOnlyDenial(capability: string): string {
  return `Perintah itu mengatur JARVIS secara global, jadi khusus pemilik. ` +
    `Semua fungsi biasa tetap bisa kupakai. (yang kamu minta: ${capability})`;
}

/** Kuota per-tier (menit). Gerbang terbuka untuk siapa pun, dan kunci LLM
 *  dibayar owner — jadi rem per-telegram-id ini wajib, bukan opsional. */
const LIMITS = {
  owner: { maxPerHour: 200, maxPerDay: 1500 },
  // User tier: fungsi penuh, tapi kuota LLM dibayar owner — satu akun tak
  // boleh menghabiskan tagihan.
  user: { maxPerHour: 60, maxPerDay: 300 },
} as const;

/** Rate limit kuota per-tier berbasis KV. Fail-open TIDAK di sini: kalau KV
 *  mati, user dapat limit ketat (fail-closed untuk resource — lebih baik
 *  menahan user daripada membebani owner's tagihan). */
export async function quotaCheck(
  env: Env,
  userId: number | string,
): Promise<{ allowed: boolean; reason: string; retryAfterS: number }> {
  const tier = tierFor(env, userId);
  const lim = LIMITS[tier];
  const id = String(userId);
  const hourKey = `quota:${id}:h:${Math.floor(Date.now() / 3_600_000)}`;
  const dayKey = `quota:${id}:d:${new Date().toISOString().slice(0, 10)}`;

  try {
    const hour = Number((await env.CONFIG_KV.get(hourKey)) ?? "0") + 1;
    const day = Number((await env.CONFIG_KV.get(dayKey)) ?? "0") + 1;
    if (hour > lim.maxPerHour || day > lim.maxPerDay) {
      const over = day > lim.maxPerDay;
      return {
        allowed: false,
        reason: over ? "daily_quota" : "hourly_quota",
        retryAfterS: over
          ? Math.max(60, 86_400 - (Date.now() % 86_400_000) / 1000 | 0)
          : 3_600 - (Date.now() % 3_600_000) / 1000 | 0,
      };
    }
    await Promise.all([
      env.CONFIG_KV.put(hourKey, String(hour), { expirationTtl: 7_200 }),
      env.CONFIG_KV.put(dayKey, String(day), { expirationTtl: 172_800 }),
    ]);
    return { allowed: true, reason: "within_quota", retryAfterS: 0 };
  } catch {
    // KV gagal: izinkan owner (jangan matikan bot sendiri), tolak user.
    if (tier === "owner") return { allowed: true, reason: "kv_error_owner_bypass", retryAfterS: 0 };
    return { allowed: false, reason: "quota_check_unavailable", retryAfterS: 60 };
  }
}

/** Untuk UI/test: berapa kuota yang tersisa. */
export async function quotaRemaining(
  env: Env,
  userId: number | string,
): Promise<{ hour: number; day: number }> {
  const lim = LIMITS[tierFor(env, userId)];
  try {
    const hour = Number((await env.CONFIG_KV.get(`quota:${userId}:h:${Math.floor(Date.now() / 3_600_000)}`)) ?? "0");
    const day = Number((await env.CONFIG_KV.get(`quota:${userId}:d:${new Date().toISOString().slice(0, 10)}`)) ?? "0");
    return { hour: Math.max(0, lim.maxPerHour - hour), day: Math.max(0, lim.maxPerDay - day) };
  } catch {
    return { hour: 0, day: 0 };
  }
}

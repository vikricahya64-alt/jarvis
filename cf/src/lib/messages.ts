//=====================================================================
// messages.ts — centralized natural language message templates for JARVIS.
//
// All user-facing text lives here for:
// - Consistent personality across all modules
// - Easy A/B testing of phrasing
// - Single source of truth for tone/voice
//
// Personality: warm, competent, slightly formal (British butler archetype).
// Language: Bahasa Indonesia sehari-hari, natural, tidak kaku.
//=====================================================================

/** Greeting variants (rotated for freshness). */
export const GREETINGS = {
  morning: [
    "Selamat pagi, Pemilik.",
    "Pagi, Bos.",
    "Halo, selamat pagi.",
  ],
  afternoon: [
    "Selamat siang.",
    "Siang, Bos.",
    "Halo, siang ini.",
  ],
  evening: [
    "Selamat sore.",
    "Sore yang baik.",
    "Halo, sore ini.",
  ],
  night: [
    "Selamat malam.",
    "Malam, Bos.",
    "Halo, malam ini.",
  ],
  general: [
    "Halo. J.A.R.V.I.S. siap.",
    "Halo, ada yang bisa saya bantu?",
    "Halo, Bos.",
  ],
};

/** Get time-appropriate greeting. */
export function getGreeting(hour: number): string {
  const pool =
    hour < 11 ? GREETINGS.morning :
    hour < 15 ? GREETINGS.afternoon :
    hour < 18 ? GREETINGS.evening :
    GREETINGS.night;
  return pool[Math.floor(Math.random() * pool.length)];
}

/** Status messages. */
export const STATUS = {
  autonomyActive: "Otonomi aktif — semua sistem jalan.",
  autonomyPaused: "Otonomi di-pause. Hanya perintah langsung yang jalan.",
  constitutionRatified: "Konstitusi: sudah diratifikasi.",
  constitutionNotRatified: "Konstitusi: belum diratifikasi (mode fail-closed).",
  systemOk: "Semua sistem normal.",
  commandList: "Perintah: /health · /dms_status · /queue_status · /pause · /resume · /obedience_report",
};

/** Search/research responses. */
export const SEARCH = {
  searching: (topic: string) => `Mencari tentang *${topic}*...`,
  noResults: (topic: string) =>
    `Saya cari tentang "${topic}" tapi belum menemukan hasil yang cukup. Coba dengan kata kunci lain?`,
  fallback: (topic: string) =>
    `Berikut yang saya temukan tentang *${topic}* — ini dari pencarian langsung, belum tentu lengkap:`,
  synthesized: (topic: string) =>
    `Ini rangkuman tentang *${topic}*:`,
};

/** Reflection/learning messages. */
export const REFLECTION = {
  insightExtracted: (rule: string) =>
    `Saya baru pelajari sesuatu: "${rule.slice(0, 100)}". Akan saya ingat untuk ke depan.`,
  morningBriefing: "🌅 *Pagi, Pemilik.* Ringkasan singkat J.A.R.V.I.S.:",
  noNewInsights: "Tidak ada insight baru semalam.",
};

/** Consent flow messages. */
export const CONSENT = {
  pending: (action: string) =>
    `Ini butuh persetujuan Anda:\n\n*${action}*\n\nSetuju?`,
  approved: "Disetujui. Menjalankan...",
  rejected: "Ditolak. Aksi dibatalkan.",
  timeout: "Waktu habis. Aksi dibatalkan.",
};

/** Help text. */
export const HELP = {
  header: "📋 *Perintah J.A.R.V.I.S.*",
  sections: [
    { title: "Umum", items: "/health — cek status sistem\n/status — status otonomi\n/help — bantuan ini\n/tugas — delegasi kerja berat ke eksekutor cloud (/tugas <pekerjaan>)" },
    { title: "Pencarian", items: "/cari <topik> — cari informasi\nTerjemahkan <teks> — terjemahkan\n/baca <url> — baca + ringkas halaman\n/e2b <skrip> — eksekusi shell/Python di sandbox E2B" },
    { title: "Pengaturan", items: "/pause — pause otonomi\n/resume — lanjutkan otonomi\n/mark_stop <frasa> — larang aksi" },
    { title: "Lainnya", items: "/dms_status — status DMS\n/obedience_report — laporan kepatuhan" },
  ],
};

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

/** Error messages — never robotic, always honest. */
export const ERRORS = {
  internal: "Maaf, ada kesalahan internal. Saya sudah catet, akan saya perbaiki.",
  blocked: (reason: string) =>
    `Aksi ini tidak bisa saya jalankan — ${reason}. Kalau ada yang salah, kasih tahu saya.`,
  deferred: "Aksi ini saya tunda dulu. Kalau perlu sekarang, coba perjelas permintaannya.",
  clarify: (confidence: number) =>
    confidence < 0.5
      ? "Saya kurang yakin dengan permintaan ini. Bisa jelaskan lebih detail?"
      : "Permintaan ini agak ambigu. Bisa diperjelas?",
  consentNeeded: (action: string) =>
    `Ini butuh persetujuan Anda dulu. Konfirmasi aksi: ${action}`,
  notAllowed: "Perintah ini tidak diizinkan.",
  rateLimited: "Terlalu banyak permintaan. Tunggu sebentar, ya.",
  offline: "Saya sedang tidak bisa menghubungi layanan luar. Coba lagi sebentar.",
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

/** Suggestion messages (daily digest). */
export const SUGGESTIONS = {
  header: "💡 Saran J.A.R.V.I.S. — cuma tawaran, tidak ada yang jalan otomatis.",
  empty: "Tidak ada saran baru untuk saat ini.",
  accept: (id: number) =>
    `Saran #${id} diterima. Saya catet — tapi tidak saya jalankan otomatis. Ketik kebutuhanmu untuk meneruskan.`,
  dismiss: (id: number) =>
    `Saran #${id} ditutup. Saya tidak akan menawarkannya lagi.`,
  notFound: (id: number) =>
    `Tidak ada saran #${id}. Mungkin sudah diproses.`,
};

/** Reflection/learning messages. */
export const REFLECTION = {
  insightExtracted: (rule: string) =>
    `Saya baru pelajari sesuatu: "${rule.slice(0, 100)}". Akan saya ingat untuk ke depan.`,
  morningBriefing: "🌅 *Pagi, Pemilik.* Ringkasan singkat J.A.R.V.I.S.:",
  noNewInsights: "Tidak ada insight baru semalam.",
};

/** Translation responses. */
export const TRANSLATION = {
  processing: "Menerjemahkan...",
  failed: "Gagal menerjemahkan. Coba lagi, ya.",
};

/** Consent flow messages. */
export const CONSENT = {
  pending: (action: string) =>
    `Ini butuh persetujuan Anda:\n\n*${action}*\n\nSetuju?`,
  approved: "Disetujui. Menjalankan...",
  rejected: "Ditolak. Aksi dibatalkan.",
  timeout: "Waktu habis. Aksi dibatalkan.",
};

/** Privacy mode messages. */
export const PRIVACY = {
  enabled: "Mode privasi aktif. Data sensitif tidak akan ditampilkan.",
  disabled: "Mode privasi nonaktif.",
};

/** Mark/stop/never messages. */
export const MARK = {
  stopAdded: (phrase: string) =>
    `"${phrase.slice(0, 50)}" ditambahkan ke daftar "jangan pernah". Saya tidak akan lakukan ini.`,
  stopRemoved: (phrase: string) =>
    `"${phrase.slice(0, 50)} dihapus dari daftar "jangan pernah".`,
  neverAdded: (phrase: string) =>
    `Perintah "jangan: ${phrase.slice(0, 50)}" tercatat.`,
};

/** Schedule messages. */
export const SCHEDULE = {
  created: (desc: string) =>
    `Tugas terjadwal: "${desc.slice(0, 60)}". Saya ingatkan saat waktunya.`,
  cancelled: (id: number) =>
    `Tugas #${id} dibatalkan.`,
};

/** Help text. */
export const HELP = {
  header: "📋 *Perintah J.A.R.V.I.S.*",
  sections: [
    { title: "Umum", items: "/health — cek status sistem\n/status — status otonomi\n/help — bantuan ini\n/tugas — delegasi kerja berat ke eksekutor cloud (/tugas <pekerjaan>)" },
    { title: "Pencarian", items: "/cari <topik> — cari informasi\nTerjemahkan <teks> — terjemahkan\n/baca <url> — baca + ringkas halaman\n/odyssey <adegan> — simulasikan dunia (video interaktif) via Odyssey" },
    { title: "Pengaturan", items: "/pause — pause otonomi\n/resume — lanjutkan otonomi\n/mark_stop <frasa> — larang aksi" },
    { title: "Lainnya", items: "/dms_status — status DMS\n/obedience_report — laporan kepatuhan" },
  ],
};

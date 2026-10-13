//=====================================================================
// negotiation.ts — /tugas single-pass router (pengganti Q&A bridge lama).
//
// Prinsip: SATU panggilan model menafsirkan input pemilik menjadi SALAH SATU:
//   * PERINTAH — instruksi final siap eksekusi, atau
//   * PERTANYAAN — SATU pertanyaan klarifikasi paling penting.
//
// Mengapa jalur lama dibuang: generator 3 pertanyaan memanggil LLM TANPA
// teks tugas ikut terkirim (skipUserMessage + konteks kosong), sehingga model
// mengarang dari memori percakapan; parser lama menerima kalimat apa pun
// (8-200 char) sebagai "pertanyaan". Hasilnya: Q1 berupa rangkuman ngawur.
// Jalur baru: teks tugas SELALU dikirim eksplisit sebagai pesan user, output
// model TERKUNCI pada kontrak JENIS:/ISI:, dan sesi parkir maksimal 2 putaran.
//
// Alur: /tugas <x> → routeTaskInput → perintah (tampil + tunggu GO) ATAU
// pertanyaan (tampil, tunggu 1 jawaban) → answerPending → perintah (tampil +
// tunggu GO). GO → dispatch; batal → buang; catatan → refineFinal (sekali,
// deterministik-bounded). KV-backed (nego:<owner>), TTL fail-closed.
//=====================================================================

import { Env } from "./db";
import { llmRespond } from "./ai";

const NEGO_TTL_SEC = 30 * 60;

export interface NegoSession {
  task: string; // teks tugas asli pemilik (verbatim)
  riset: boolean; // opt-in protokol sitasi (--riset)
  tanya: string; // SATU pertanyaan pending ("" = tak ada; sesi menunggu GO)
  putaran: number; // 1 = jawaban pertama dinanti; 2 = ronde pemoles (maks)
  final?: string; // perintah final siap eksekusi
  ts: number;
}

export const NEGO_KEY = (owner: number): string => `nego:${owner}`;

export async function readNegotiation(
  env: Env,
  owner: number,
): Promise<NegoSession | null> {
  try {
    const raw = await env.CONFIG_KV.get(NEGO_KEY(owner), "json");
    if (!raw) return null;
    const s = raw as unknown as NegoSession;
    // Bentuk sesi Q&A lama ({questions,answers,step}) DITOLAK di sini —
    // pemilik cukup kirim ulang; TTL 30 mnt membersihkan sisanya.
    if (!s || typeof s.task !== "string" || typeof s.tanya !== "string") return null;
    if (typeof s.putaran !== "number" || (s.tanya && !s.final && s.putaran < 1)) return null;
    return s;
  } catch {
    return null;
  }
}

export async function saveNegotiation(env: Env, owner: number, s: NegoSession): Promise<void> {
  try {
    await env.CONFIG_KV.put(NEGO_KEY(owner), JSON.stringify(s), { expirationTtl: NEGO_TTL_SEC });
  } catch { /* fail-closed: sesi hilang = pemilik kirim ulang */ }
}

export async function clearNegotiation(env: Env, owner: number): Promise<void> {
  try {
    await env.CONFIG_KV.delete(NEGO_KEY(owner));
  } catch { /* best-effort */ }
}

/** Kata kerja aksi: sinyal deterministik bahwa tugas punya target kerja.
// Dipakai isVagueTask — BUKAN untuk menebak maksud, hanya untuk memutuskan
// apakah input layak dikirim ke model atau langsung ditanya balik. */
const ACTION_VERBS =
  /bua?t(kan)?|bikin|carikan|cari|riset|tulis|ringkas|rangkum|analisis|analisa|perbaiki|jadwalkan|jadwal|kirim|ambil|download|unduh|terjemahkan?|kerjakan|jalankan|lakukan|eksekusi|cek|periksa|bandingkan|desain|rancang|hitung|monitor|ingatkan|catat|simpan|baca|bacakan|susun|review|audit|selidiki|rencanakan|optimalkan|tampilkan|tunjukkan/i;

/** True bila baris berbentuk pertanyaan (diakhiri ? atau diawali kata tanya).
// Murni + fail-closed: yang bukan pertanyaan TIDAK PERNAH lolos sebagai tanya. */
export function isQuestionLine(line: string): boolean {
  const l = (line ?? "").trim();
  if (l.length < 8 || l.length > 200) return false;
  if (/\?\s*$/.test(l)) return true;
  return /^(apa|apakah|bagaimana|gimana|berapa|kapan|di\s?mana|ke\s?mana|dari\s?mana|mengapa|kenapa|siapa|yang\s+mana|mana|seberapa|tolong|jelaskan|sebutkan|konfirmasi|mau|ingin\s+tahu)/i.test(l);
}

/** True bila tugas tak punya sinyal aksi yang bisa dieksekusi (tanpa kata
// kerja aksi dan bukan kalimat tanya) — mis. "pilih opsi tindakan yang
// tepat". Murni + konservatif: ragu = tidak vague (biar model yang menilai). */
export function isVagueTask(task: string): boolean {
  const t = (task ?? "").trim();
  if (!t) return true;
  if (/\?\s*$/.test(t)) return false;
  return !new RegExp(`\\b(?:${ACTION_VERBS.source})\\b`, "i").test(t);
}

/** Pertanyaan baku deterministik untuk input vague — TANPA memanggil model
// (permukaan halusinasi nol, biaya nol). */
export const VAGUE_TASK_QUESTION =
  "Aku belum menangkap pekerjaan konkretnya — tugas apa tepatnya yang harus kukerjakan? " +
  "Sebutkan aksi + objeknya, mis. 'riset harga emas hari ini' atau 'buatkan ringkasan markdown'.";

export type RoutedTask =
  | { kind: "perintah"; instruksi: string }
  | { kind: "pertanyaan"; tanya: string };

/** Parse output ketat model menjadi RoutedTask. Format kontrak:
//   JENIS: PERINTAH|PERTANYAAN
//   ISI: <teks, boleh multi-baris>
// Di luar kontrak = null (pemanggil pakai fallback deterministik). */
export function parseRouterReply(text: string): RoutedTask | null {
  const lines = (text ?? "").split(/\n+/).map((l) => l.trim()).filter(Boolean);
  if (lines.length < 2) return null;
  const jenis = /^JENIS:\s*(PERINTAH|PERTANYAAN)\s*$/i.exec(lines[0] ?? "");
  if (!jenis) return null;
  const rest = lines.slice(1).join("\n");
  const isiMatch = /^ISI:\s?([\s\S]*)$/.exec(rest);
  if (!isiMatch) return null;
  const isi = (isiMatch[1] ?? "").trim();
  if (isi.length < 10 || isi.length > 2000) return null;
  if (jenis[1].toUpperCase() === "PERTANYAAN") {
    // PERTANYAAN boleh multi-baris di model, tapi yang disimpan = baris
    // interogatif pertama (bukti: kasus Q1-rangkuman-ngawur).
    const first = isi.split(/\n+/).map((l) => l.trim()).find((l) => isQuestionLine(l));
    if (!first) return null;
    return { kind: "pertanyaan", tanya: first };
  }
  return { kind: "perintah", instruksi: isi };
}

/** Kompilasi deterministik tanpa model: tugas + Q&A ditempel apa adanya.
// Dipakai saat model gagal di ronde kedua (bounded) atau refine — tidak ada
// ronde ketiga, tidak ada tebakan baru. */
export function compileDeterministic(task: string, tanya: string, jawaban: string): string {
  const t = (task ?? "").trim();
  const j = (jawaban ?? "").trim();
  if (!j) return t;
  return `${t}\n\nKlarifikasi pemilik (${tanya.slice(0, 120)}):\n${j}`;
}

const ROUTER_SYSTEM =
  "Kamu adalah penafsir tugas JARVIS. Di bawah ada permintaan pemilik. Balas HANYA dengan format persis ini:\n" +
  "JENIS: PERINTAH\nISI: <instruksi final siap eksekusi>\natau\nJENIS: PERTANYAAN\nISI: <satu pertanyaan klarifikasi>\n" +
  "Aturan: permintaan yang sudah jelas → PERINTAH (terjemahkan ke instruksi konkret, JANGAN tambah hal baru, JANGAN beri pembuka/penutup). " +
  "Permintaan yang kabur/tak bisa dieksekusi → PERTANYAAN (SATU saja, maks 25 kata, tanyakan aksi+objek konkret yang kurang). " +
  "ISI perintah 10-2000 karakter. Tidak ada teks di luar format itu.";

/** Satu-satunya panggilan model per putaran. Teks tugas SELALU dikirim
// eksplisit sebagai pesan user (skipUserMessage:false) — pelajaran dari bug
// Q1-ngawur: tanpa ini model menjawab dari memori, bukan dari tugas. */
async function callRouter(env: Env, owner: number, userText: string): Promise<RoutedTask | null> {
  try {
    const g = await llmRespond(env, userText, { owner,
      systemOverride: ROUTER_SYSTEM,
      skipUserMessage: false,
    }).catch(() => ({ reply: null, source: null }));
    return parseRouterReply(g.reply ?? "");
  } catch {
    return null;
  }
}

/** Rute input /tugas baru: vague → pertanyaan baku (tanpa LLM);
 *  jelas → satu panggilan model; gagal parse → perintah verbatim (perilaku
 *  pra-negosiasi: teruskan apa adanya, keputusan akhir tetap di pemilik
 *  lewat konfirmasi GO). Tidak pernah throw. */
export async function routeTaskInput(
  env: Env,
  owner: number,
  task: string,
): Promise<RoutedTask> {
  const t = (task ?? "").trim();
  if (isVagueTask(t)) return { kind: "pertanyaan", tanya: VAGUE_TASK_QUESTION };
  const routed = await callRouter(env, owner, `TUGAS PEMILIK:\n${t}`);
  if (routed) return routed;
  return { kind: "perintah", instruksi: t };
}

/** Olah JAWABAN atas pertanyaan pending menjadi perintah. Bila model
 *  mengembalikan pertanyaan lagi: hanya di putaran 1 dikembalikan sebagai
 *  pertanyaan susulan (putaran 2, terakhir); di putaran ≥2 langsung kompilasi
 *  deterministik — TIDAK ADA ronde ketiga. Tidak pernah throw. */
export async function answerPending(
  env: Env,
  owner: number,
  s: NegoSession,
  jawaban: string,
): Promise<RoutedTask> {
  const j = (jawaban ?? "").trim().replace(/\s+/g, " ").slice(0, 600);
  const routed = await callRouter(env, owner,
    `TUGAS PEMILIK:\n${s.task}\nPERTANYAAN YANG DIAJUKAN:\n${s.tanya}\nJAWABAN PEMILIK:\n${j}`);
  if (routed?.kind === "perintah") return routed;
  if (routed?.kind === "pertanyaan" && s.putaran < 2) return routed;
  return { kind: "perintah", instruksi: compileDeterministic(s.task, s.tanya, j) };
}

/** Poles perintah final dengan catatan pemilik — SEKALI panggil, dipaksa
 *  PERINTAH (tanya dari refine diabaikan → fallback deterministik). */
export async function refineFinal(
  env: Env,
  owner: number,
  s: NegoSession,
  catatan: string,
): Promise<string> {
  const c = (catatan ?? "").trim().replace(/\s+/g, " ").slice(0, 600);
  const routed = await callRouter(env, owner,
    `TUGAS PEMILIK:\n${s.task}\nPERINTAH SAAT INI:\n${s.final ?? s.task}\nCATATAN TAMBAHAN PEMILIK:\n${c}\n` +
    `Hasilkan PERINTAH final yang menggabungkan catatan itu.`);
  if (routed?.kind === "perintah") return routed.instruksi;
  return compileDeterministic(s.final ?? s.task, "catatan tambahan", c);
}

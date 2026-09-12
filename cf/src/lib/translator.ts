//=====================================================================
// translator.ts — JARVIS SEBAGAI NEGOSIATOR PEMILIK; penerjemah adalah
// PIHAK KETIGA (pekerja kontrak ragam-bahasa) yang JARVIS negosiasikan
// dan awasi atas nama pemilik, untuk eksekutor pinjaman (kategori
// eksekutor eksternal).
//
// Peran yang BENAR (koreksi v11.45 — sebelumnya salah diposisikan sebagai
// "JARVIS = penerjemah pihak ketiga"): JARVIS berdiri SANGAT di sisi pemilik.
//  - Pemilik bicara bahasa manusia + kepentingannya.
//  - JARVIS (NEGOSIATOR) mewakili pemilik: memastikan tujuan jelas (bertanya
//    jika ambigu, bukan menebak), menetapkan batasan, dan mengawasi.
//  - PENERJEMAH (groq:translator) adalah PIHAK KETIGA yang dinegosiasikan:
//    ia hanya menurunkan GOAL menjadi artefak eksekusi (skrip) ATAU meminta
//    klarifikasi — tidak pernah mengambil keputusan atas nama pemilik.
//  - EKSEKUTOR (E2B) juga pihak ketiga: platform pinjaman yang menjalankan
//    artefak itu; JARVIS yang memegang ledger, persetujuan, dan laporan.
//
// Dua fase "output terbaik" (arahan pemilik) dibangun di atas penerjemah ini:
//   (1) DISKUSI sebelum eksekusi — rencana (langkah + kode) dipertunjukkan
//       dan disetujui pemilik SEBELUM sandbox dibuka (lihat /proyek).
//   (2) PENGEDITAN saat proses berjalan — iterasi perbaikan atas rencana
//       yang sedang/gagal berjalan (follow-up run, lihat /proyek lanjut).
//
// Fail-closed: tanpa key/LLM/bentuk jelek → null; tidak pernah throw.
// Terjemahan divalidasi deterministik (parse JSON ketat), kode di-cap ke
// PAYLOAD_CAP, dan hanya bahasa bash/python yang diterima. Ambigu → balas
// permintaan klarifikasi (negotiate:true), TIDAK pernah mengarang rencana.
//=====================================================================

import { Env } from "./db";
import { groqSingleShot } from "./ai";

export type ExecutableLanguage = "bash" | "python";

export interface ExecutablePlan {
  language: ExecutableLanguage;
  /** Skrip siap eksekusi (bash atau python) — artefak bagi platform pinjaman. */
  code: string;
  /** Langkah ringkas untuk DISKUSI pemilik (bukan untuk mesin). */
  steps: string[];
  /** Satu kalimat: apa yang akan dikerjakan / diperiksa oleh eksekutor. */
  summary: string;
}

/** Cap kode (sama dengan kontrak payload bersama 4000). */
export const TRANSLATOR_CODE_CAP = 3500;

/** Hasil "negosiasi" JARVIS dengan penerjemah pihak ketiga: entah rencana
 *  yang siap dieksekusi, atau permintaan klarifikasi untuk DITERUSKAN ke
 *  pemilik (negosiator TIDAK pernah mengarang rencana dari tujuan ambigu). */
export type GoalNegotiation =
  | { kind: "plan"; plan: ExecutablePlan }
  | { kind: "ask"; ask: string };

/** Pure, deterministic: parse respon penerjemah yang BISA berupa rencana
 *  ATAU permintaan klarifikasi. Menolak apa pun yang bukan bentuk valid
 *  (fail-closed — bentuk aneh tidak pernah sampai ke pemilik/sandbox). */
export function parseGoalNegotiation(raw: string | null): GoalNegotiation | null {
  if (!raw) return null;
  const cleaned = raw
    .replace(/^\uFEFF/, "")
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/, "")
    .trim();
  let obj: unknown;
  try {
    obj = JSON.parse(cleaned);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== "object") return null;
  const o = obj as { negotiate?: unknown; ask?: unknown; language?: unknown; code?: unknown; steps?: unknown; summary?: unknown };
  if (o.negotiate === true) {
    // Strict single-contract: form campuran (klarifikasi + rencana) tidak valid.
    const hasPlanShape =
      typeof o.language === "string" || typeof o.code === "string" || Array.isArray(o.steps);
    if (hasPlanShape) return null;
    const ask = typeof o.ask === "string" ? o.ask.trim() : "";
    if (ask) return { kind: "ask", ask: ask.slice(0, 300) };
  }
  const language = String(o.language ?? "").toLowerCase();
  if (language !== "bash" && language !== "python") return null;
  const code = typeof o.code === "string" ? o.code.trim() : "";
  if (!code) return null;
  const steps = Array.isArray(o.steps)
    ? o.steps.map((s) => String(s ?? "").trim()).filter(Boolean).slice(0, 8)
    : [];
  const summary = typeof o.summary === "string" ? o.summary.trim() : "";
  if (steps.length === 0) return null;
  const plan: ExecutablePlan = {
    language,
    code: code.slice(0, TRANSLATOR_CODE_CAP),
    steps,
    summary: summary.slice(0, 200),
  };
  return { kind: "plan", plan };
}

/** Konteks iterasi-pengeditan saat proses berjalan (/proyek lanjut <id>).
 *  Pengingat bahwa ini ITERASI berikutnya atas TUGAS yang sama — penerjemah
 *  harus mempertahankan tujuan asli sambil menerapkan perbaikan pemilik. */
export interface IterationContext {
  goal: string;
  status: "done" | "failed" | "running" | "pending";
  /** Hasil/kesalahan PUTARAN SEBELUMNYA (ringkas, sudah dipotong oleh panggil). */
  outcome: string;
  /** Instruksi perbaikan baru dari pemilik. */
  instruction: string;
}

/** Pure: bangun string BATASAN untuk translateTaskToExecutable pada iterasi
 *  lanjutan. Menyalurkan (a) konteks putaran sebelumnya supaya pemilik tidak
 *  perlu mengulang tujuannya, dan (b) instruksi perbaikan — JARVIS tetap
 *  berdiri sebagai penerjemah antara bahasa pemilik dan kode baru. */
export function buildIterationConstraint(ctx: IterationContext): string {
  const goal = (ctx.goal ?? "").trim();
  const instruction = (ctx.instruction ?? "").trim();
  const outcome = (ctx.outcome ?? "").trim();
  const lines = [
    `Ini ITERASI PERBAIKAN (runtime-edit) atas tujuan yang sudah pernah dijalankan:`,
  ];
  if (goal) lines.push(`TUJUAN ASLI:\n${goal.slice(0, 1200)}`);
  if (outcome) lines.push(`HASIL PUTARAN SEBELUMNYA (${ctx.status}):\n${outcome.slice(0, 2000)}`);
  if (instruction) lines.push(`INSTRUKSI PERBAIKAN PEMILIK:\n${instruction.slice(0, 1200)}`);
  lines.push(
    `Pertahankan esensi tujuan asli; terapkan instruksi perbaikan. Jika putaran sebelumnya gagal, ` +
    `perbaiki penyebab kegagalannya (cetak data, tangani error, jangan hanya status sukses).`,
  );
  return lines.join("\n\n");
}

/** Pure, deterministic: parse the strict-JSON plan the LLM must return.
 *  Accepts a ```json fence around the object, strips BOM/whitespace, and
 *  validates types + allowed languages. Returns null on ANY deviation
 *  (fail-closed — a malformed "translation" never reaches the sandbox). */
export function parseExecutablePlan(raw: string | null): ExecutablePlan | null {
  if (!raw) return null;
  const cleaned = raw
    .replace(/^\uFEFF/, "")
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/, "")
    .trim();
  let obj: unknown;
  try {
    obj = JSON.parse(cleaned);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== "object") return null;
  const o = obj as { language?: unknown; code?: unknown; steps?: unknown; summary?: unknown };
  const language = String(o.language ?? "").toLowerCase();
  if (language !== "bash" && language !== "python") return null;
  const code = typeof o.code === "string" ? o.code.trim() : "";
  if (!code) return null;
  const steps = Array.isArray(o.steps)
    ? o.steps.map((s) => String(s ?? "").trim()).filter(Boolean).slice(0, 8)
    : [];
  const summary = typeof o.summary === "string" ? o.summary.trim() : "";
  if (steps.length === 0) return null;
  return {
    language,
    code: code.slice(0, TRANSLATOR_CODE_CAP),
    steps,
    summary: summary.slice(0, 200),
  };
}

const TRANSLATOR_SYSTEM =
  "Kamu adalah PENERJEMAH ragam-bahasa yang netral — PIHAK KETIGA (pekerja kontrak) " +
  "yang DINEGOSIASIKAN oleh JARVIS, NEGOSIATOR yang mewakili pemilik. JARVIS berdiri di " +
  "pihak pemilik; kamu adalah pihak luar yang diawasi JARVIS. Terima GOAL pemilik dan " +
  "turunkan ke SKRIP yang siap dieksekusi untuk pekerja nyata (internet pakai curl, " +
  "mulut command-line, python3, git tersedia). " +
  "PILIH bash untuk otomatisasi sistem/pencarian/latensi-rendah; python untuk parsing data, " +
  "API, atau perhitungan. Tulis skrip yang TEGAS dan TIDAK interaktif (tanpa prompt), dengan " +
  "set -e untuk bash; cetak hasil akhir yang jelas (jangan hanya status sukses — tampilkan data). " +
  "CAKUP kapabilitas: riset web/API (pakai curl), parsing, laporan, otomasi. JANGAN meminta izin " +
  "di dalam skrip. " +
  "Jika GOAL BUKAN tugas yang jelas (kata tunggal seperti \"lanjut\", sapaan, frasa ambigu, " +
  "atau permintaan yang belum punya target konkret) → JANGAN mengarang skrip; balas " +
  "{\"negotiate\":true,\"ask\":\"<SATU pertanyaan klarifikasi dalam bahasa pemilik>\"}. " +
  "Balas HANYA satu JSON:\n" +
  `{"language":"bash|python","code":"<skrip lengkap, escaped>","steps":["<langkah 1>","<langkah 2>"],"summary":"<1 kalimat>"}\n` +
  `ATAU\n{"negotiate":true,"ask":"<1 pertanyaan klarifikasi>"}`;

/** NEGOSIASI + TERJEMAH: tanya penerjemah pihak ketiga atas nama pemilik.
 *  Hasilnya bisa rencana siap eksekusi (plan) atau permintaan klarifikasi
 *  (ask) yang harus DITERUSKAN JARVIS ke pemilik — tidak pernah diabaikan
 *  dan tidak pernah dijadikan rencana. Fail-closed: LLM/parsing gagal → null. */
export async function negotiateGoalTranslate(
  env: Env,
  task: string,
  opts: { constraint?: string } = {},
): Promise<GoalNegotiation | null> {
  const goal = (task ?? "").trim();
  if (goal.length < 3) return null;
  const user =
    `GOAL PEMILIK (bahasa manusia):\n${goal.slice(0, 1200)}\n\n` +
    (opts.constraint ? `BATASAN:\n${opts.constraint}\n\n` : "") +
    `Balas hanya satu JSON valid: rencana {"language":...} ATAU klarifikasi {"negotiate":true,"ask":...}`;
  const raw = await groqSingleShot(env, {
    label: "groq:translator",
    system: TRANSLATOR_SYSTEM,
    user,
    temperature: 0.2,
    maxTokens: 1400,
  }).catch(() => null);
  return parseGoalNegotiation(raw);
}

/** Translate the owner's natural-language goal into an executable plan only.
 *  Permintaan klarifikasi (negotiate) dianggap null di sini — jalur eksekusi
 *  otomatis (eskalasi) memakai plano-only dan jatuh ke teks mentah bila perlu.
 *  Fail-closed: any LLM/parse/validate failure → null. One wire-owner
 *  (groq:translator) so the borrow is tallied like every other system module. */
export async function translateTaskToExecutable(
  env: Env,
  task: string,
  opts: { constraint?: string } = {},
): Promise<ExecutablePlan | null> {
  const g = await negotiateGoalTranslate(env, task, opts);
  return g?.kind === "plan" ? g.plan : null;
}
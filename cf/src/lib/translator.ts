//=====================================================================
// translator.ts — JARVIS SEBAGAI PIHAK KETIGA: PENERJEMAH bahasa pemilik
// → bahasa pemrograman untuk eksekutor pinjaman (kategori eksekutor eksternal).
//
// E2B hanyalah satu contoh "sistem konsep". Di semua platform yang
// dieksekusi oleh pihak eksternal, JARVIS berdiri di tengah antara manusia
// dan mesin: bahasa manusia (goal, niat, batasan) DIUBAH menjadi artefak
// yang bisa DIEKSEKUSI (skrip bash/python) oleh platform pinjaman — bukan
// sekadar meneruskan kalimat mentah. Sistem konsep yang sama berlaku untuk
// calon penerjemah berikutnya (GitHub/open-code, Vercel connector task).
//
// Dua fase "output terbaik" (arahan pemilik) dibangun di atas penerjemah ini:
//   (1) DISKUSI sebelum eksekusi — rencana (langkah + kode) dipertunjukkan
//       dan disetujui pemilik SEBELUM sandbox dibuka (lihat /proyek).
//   (2) PENGEDITAN saat proses berjalan — iterasi perbaikan atas rencana
//       yang sedang/gagal berjalan (follow-up run, lihat /proyek lanjut).
//
// Fail-closed: tanpa key/LLM/bentuk jelek → null; tidak pernah throw.
// Terjemahan divalidasi deterministik (parse JSON ketat), kode di-cap ke
// PAYLOAD_CAP, dan hanya bahasa bash/python yang diterima.
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
  "Kamu adalah PENERJEMAH BAHASA MANUSIA → BAHASA PEMROGRAMAN (pihak ketiga antara manusia " +
  "dan mesin). Tugas pemilik adalah GOAL; kamu harus menurunkan-nya menjadi SKRIP yang siap " +
  "dieksekusi untuk pekerja nyata (akses internet, mulut command-line, python3, git tersedia). " +
  "PILIH bash untuk otomatisasi sistem/pencarian/latensi-rendah; python untuk parsing data, " +
  "API, atau perhitungan. Tulis skrip yang TEGAS dan TIDAK interaktif (tanpa prompt), dengan " +
  "set -e untuk bash; cetak hasil akhir yang jelas (jangan hanya status sukses — tampilkan data). " +
  "CAKUP kapabilitas: riset web/API (pakai curl), parsing, laporan, otomasi. JANGAN meminta izin " +
  "di dalam skrip. Balas HANYA dengan JSON:\n" +
  `{"language":"bash|python","code":"<skrip lengkap, escaped>","steps":["<langkah 1>","<langkah 2>"],"summary":"<1 kalimat>"}`;

/** Translate the owner's natural-language goal into an executable plan.
 *  Fail-closed: any LLM/parse/validate failure → null. One wire-owner
 *  (groq:translator) so the borrow is tallied like every other system module. */
export async function translateTaskToExecutable(
  env: Env,
  task: string,
  opts: { constraint?: string } = {},
): Promise<ExecutablePlan | null> {
  const goal = (task ?? "").trim();
  if (goal.length < 3) return null;
  const user =
    `GOAL PEMILIK (bahasa manusia):\n${goal.slice(0, 1200)}\n\n` +
    (opts.constraint ? `BATASAN:\n${opts.constraint}\n\n` : "") +
    `Balas hanya JSON valid: {"language":..., "code":..., "steps":[...], "summary":...}`;
  const raw = await groqSingleShot(env, {
    label: "groq:translator",
    system: TRANSLATOR_SYSTEM,
    user,
    temperature: 0.2,
    maxTokens: 1400,
  }).catch(() => null);
  return parseExecutablePlan(raw);
}
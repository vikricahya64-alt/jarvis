//=====================================================================
// negotiation.ts — /tugas negotiation bridge (translator + negotiator).
//
// Principle (owner, m9-v11.31): JARVIS is NOT a verbatim pass-through to
// the cloud executor. It is a translator + negotiator — the human language
// of the owner becomes a precise, unambiguous instruction for opencode,
// AFTER a short Q&A so the executed work matches the owner's intent. This
// mirrors discussing a buyer's request with the service provider, with
// JARVIS as the third party ensuring both sides agree BEFORE the job runs.
//
// Flow: /tugas <x> → generate 1-3 clarifying questions → owner answers in
// chat (one per turn) → JARVIS compiles the final instruction → shows it →
// owner replies GO → dispatch to GitHub/openOJIS. KV-backed (nego:<owner>)
// so the conversation survives cold starts; TTL-bounded failure-closed.
//=====================================================================

import { Env } from "./db";
import { llmRespond } from "./ai";

const NEGO_TTL_SEC = 30 * 60;

export interface NegoSession {
  task: string; // original task text passed by the owner (verbatim)
  riset: boolean; // owner opted into the source-citation protocol (--riset)
  questions: string[]; // 1-3 clarifying questions asked of the owner
  answers: string[]; // collected answers, parallel to questions
  step: "ask" | "confirm"; // ask = collecting answers; confirm = final shown, awaiting GO
  final?: string; // compiled final instruction (translated), set at confirm
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
    if (!s || typeof s.task !== "string" || !Array.isArray(s.questions)) return null;
    return s;
  } catch {
    return null;
  }
}

export async function saveNegotiation(env: Env, owner: number, s: NegoSession): Promise<void> {
  try {
    await env.CONFIG_KV.put(NEGO_KEY(owner), JSON.stringify(s), { expirationTtl: NEGO_TTL_SEC });
  } catch { /* fail-closed: a lost session just means the owner re-sends */ }
}

export async function clearNegotiation(env: Env, owner: number): Promise<void> {
  try {
    await env.CONFIG_KV.delete(NEGO_KEY(owner));
  } catch { /* best-effort */ }
}

/** Parse the LLM's answer into a clean question list. Pure + fail-closed. */
export function parseGeneratedQuestions(text: string): string[] {
  const lines = (text ?? "")
    .split(/\n+/)
    .map((l) => l.replace(/^[-*\d\.)\s]+/, "").trim())
    .filter((l) => l.length >= 8 && l.length <= 200);
  const out: string[] = [];
  for (const l of lines) {
    if (out.length >= 3) break;
    if (!out.some((e) => e.toLowerCase() === l.toLowerCase())) out.push(l);
  }
  return out;
}

/** Deterministic fallback questions when the LLM is unavailable. */
export function fallbackQuestions(task: string): string[] {
  const base: string[] = [
    "Output akhirnya seperti apa — ringkasan, laporan markdown, atau tabel?",
    "Seberapa dalam? Cukup ringkas-cepat atau sampai analisis mendalam?",
    "Ada kriteria atau batasan khusus yang harus dipenuhi?",
  ];
  void task;
  return base;
}

/** Compile final instruction when the LLM is unavailable (deterministic). */
export function fallbackCompile(task: string, answers: string[]): string {
  const qa = answers.map((a, i) => `• ${a}`).join("\n").trim();
  return qa ? `${task}\n\nTambahan dari pemilik (klarifikasi):\n${qa}` : task;
}

const QUESTIONS_SYSTEM =
  "Kamu adalah JARVIS. Pemilik ingin mendelegasikan tugas kepada eksekutor cloud (opencode). " +
  "Sebelum eksekusi, ajukan MAKSIMAL 3 pertanyaan klarifikasi singkat (maks 25 kata per pertanyaan, " +
  "Bahasa Indonesia natural) yang paling penting untuk membuat instruksi final tidak ambigu: " +
  "format output, kedalaman, cakupan, kriteria/batasan. HANYA tanya yang benar-benar diperlukan — " +
  "jika tugas sudah cukup jelas, cukup 1-2 pertanyaan konfirmasi penting. Jawab HANYA pertanyaannya, " +
  "satu per baris, tanpa nomor, tanpa bullet, tanpa pembuka/penutup.";

/** Generate 1-3 clarifying questions for the task via the LLM cascade. */
export async function generateClarifyQuestions(
  env: Env,
  task: string,
): Promise<string[]> {
  try {
    const g = await llmRespond(env, task, {
      systemOverride: QUESTIONS_SYSTEM,
      skipUserMessage: true,
    }).catch(() => ({ reply: null, source: null }));
    const parsed = parseGeneratedQuestions(g.reply ?? "");
    return parsed.length > 0 ? parsed.slice(0, 3) : fallbackQuestions(task);
  } catch {
    return fallbackQuestions(task);
  }
}

const COMPILE_SYSTEM =
  "Kamu adalah JARVIS, penerjemah presisi antara bahasa manusia dan instruksi eksekusi. " +
  "Pemilik mendelegasikan tugas ke eksekutor cloud (opencode). Di bawah ada permintaan asli pemilik " +
  "beserta jawaban klarifikasinya. Susun SATU teks instruksi final yang jelas, spesifik, dan tidak " +
  "ambigu dalam Bahasa Indonesia, yang mewakili PERSIS keinginan pemilik, dengan menggabungkan semua " +
  "jawaban klarifikasi ke dalamnya (mis. format output, cakupan, batasan). Jangan menambah hal " +
  "yang tidak diminta pemilik. Hasil akhir = instruksi yang siap kirim ke eksekutor, tanpa sapaan, " +
  "tanpa pembuka, tanpa penomoran berlebihan.";

/** Kisah tulisan pertanyaan: grounding for compile. */
export interface AskedTerm {
  q: string;
  a: string;
}

/** Compile the final instruction from the original task + clarification Q&A. */
export async function compileFinalInstruction(
  env: Env,
  task: string,
  qa: AskedTerm[],
): Promise<string> {
  const body = [
    `PERMINTAAN ASLI PEMILIK:\n${task}`,
    "",
    qa.length
      ? `JAWABAN KLARIFIKASI:\n${qa.map((x, i) => `${i + 1}. ${x.q}\n   → ${x.a}`).join("\n")}`
      : "TANPA KLARIFIKASI TAMBAHAN.",
  ].join("\n");
  try {
    const g = await llmRespond(env, body, {
      systemOverride: COMPILE_SYSTEM,
      skipUserMessage: true,
    }).catch(() => ({ reply: null, source: null }));
    const out = (g.reply ?? "").trim();
    if (out.length >= 10) return out;
    return fallbackCompile(task, qa.map((x) => x.a));
  } catch {
    return fallbackCompile(task, qa.map((x) => x.a));
  }
}
//=====================================================================
// relevance.ts — RELEVANCE GATES. Dua peran:
//
// (A) RELEVANCE GATE (m9-v9): never execute an ambitious intent on a topic
//     whose meaning we can't verify. Owner principle: understand → confirm
//     → execute. Confusable/ambiguous topics are parked in CONFIG_KV and
//     resumed by "1"/"2"/"ya"; anything else is a fresh query.
//
// (B) EXTERNAL-EXECUTOR GATE (v11.45): JARVIS sebagai NEGOSIATOR pemilik
//     menilai apakah sebuah tugas PANUT dibawa ke platform pinjaman
//     (eksekutor eksternal). Platform pinjaman punya LINGKUNGAN + KEMAMPUAN
//     — bukan keputusan. Sapaan, kata tunggal ambigu, dan obrolan ringan
//     TIDAK layak sandbox: itu milik jalur chat. Predikat murni &
//     deterministik (tanpa LLM/network). Fail-closed ke false utk kosong.
//=====================================================================

import { Env } from "./db";
import { detectConfusableTopic } from "./ai";

// ====(A) m9-v9 relevance gate ==============================================

const PENDING_PREFIX = "relevance_wait:";
const PENDING_TTL = 600; // 10 minutes — matches typo_wait freshness

export interface RelevancePending {
  text: string;          // the owner's original request
  topic: string;         // topic exactly as extracted
  correctedText: string; // request with the confusable word replaced
  correctedTopic: string; // topic with the confusable word replaced
  original: string;      // the word as the owner typed it
  corrected: string;     // the likely-intended word
  intentType: string;    // "search" | "design" | "code" — resume re-derives strategy
  ts: number;
}

export interface RelevanceGate {
  ambiguous: boolean;
  pending?: Omit<RelevancePending, "ts">;
  question?: string;
}

/** Intent yang eksekusinya MAHAL (search/design/code) — gerbang relevansi hanya
 *  menyela jenis ini; chat/question/translate yang murah lewat tanpa hambatan. */
const AMBITIOUS_INTENTS = new Set(["search", "design", "code"]);

/** Kata penunjuk yang tanpa subjek konkret membuat topik "menjuntai" — kalau
 *  permintaan ambisius cuma berisi ini, mengeksekusi = menebak topik sendiri. */
const VAGUE_MARKER_RE = /\b(?:itu|ini|tadi|tsb|tersebut|begitu|gitu|yang\s+tadi|yang\s+ini|yang\s+itu|itu\s+aja|lainnya|lain\s+lagi)\b/i;

// Stopwords ringan untuk menilai kerapatan kata bermakna pada topik.
const THIN_STOPWORDS = new Set([
  "dan", "atau", "yang", "ini", "itu", "untuk", "dari", "dengan", "akan",
  "pada", "para", "bagi", "tentang", "mengenai", "adalah", "dalam", "agar",
  "supaya", "antara", "serta", "karena", "tidak", "bisa", "boleh", "buat",
  "bikin", "coba", "tolong", "minta", "kan", "ya", "sih", "deh", "hal",
  "suatu", "sebuah", "ke", "di", "per", "lebih", "saja", "juga",
]);

function contentWords(s: string): string[] {
  return String(s ?? "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 3 && !THIN_STOPWORDS.has(w));
}

/** Cek apakah topik ambisius terlalu samar untuk dieksekusi langsung.
 *  Deterministik + fail-closed: minimal kata bermakna menyentuh ambang, atau
 *  kata penunjuk mendominasi tanpa subjek konkret → butuh konfirmasi. */
function isThinTopic(input: string): boolean {
  const tokens = String(input ?? "").trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return false;
  const content = contentWords(tokens.join(" "));
  if (content.length < 2) return true;
  const ratio = (content.length / tokens.length);
  const dominatedByVague = VAGUE_MARKER_RE.test(tokens.join(" ")) && content.length < 4;
  return dominatedByVague && ratio < 0.5;
}

/** Detect whether executing this request risks answering the WRONG topic.
 *  Deterministic + fail-closed:
 *  1) Confusable topic word with a neutral/corrected-reading bias (webhook
 *     typo_wait precedent) → ask with both options.
 *  2) GENERAL AMBIGUITY: an ambitious intent whose topic is too thin or
 *     dominated by referential markers ("itu", "yang tadi") would make us
 *     execute OUR OWN guess. Ask one short confirmation instead of guessing.
 *  Clear, concrete requests always flow straight through. */
export function detectRelevanceAmbiguity(
  topic: string | null,
  text: string,
  intentType: string,
): RelevanceGate {
  const t = (topic || text || "").trim().slice(0, 120);
  if (t.length < 2) return { ambiguous: false };
  const ambitious = AMBITIOUS_INTENTS.has(intentType);

  // (1) Confusable dictionary pair — both readings are plausible.
  const cf = detectConfusableTopic(t);
  if (cf && cf.bias !== "original") {
    const rx = new RegExp(`\\b${cf.original}\\b`, "i");
    const correctedText = (text || "").replace(rx, cf.corrected);
    const correctedTopic = t.replace(rx, cf.corrected);
    const biasHint =
      cf.bias === "corrected"
        ? "\n(Konteks kalimatmu mengarah ke koreksi itu.)"
        : "";
    return {
      ambiguous: true,
      pending: {
        text: (text || "").trim(),
        topic: t,
        correctedText,
        correctedTopic,
        original: cf.original,
        corrected: cf.corrected,
        intentType: intentType || "search",
      },
      question:
        `🔍 Sebelum kukerjakan: topik yang aku dengar adalah *${t.slice(0, 80)}*.\n\n` +
        `Apakah memang itu yang kamu cari, atau maksudmu *${cf.corrected}*?\n` +
        `Balas \`1\` untuk *${cf.corrected}* (koreksi), \`2\` untuk tetap *${cf.original}*.${biasHint}`,
    };
  }

  // (2) General ambiguity — ambitious intent on a too-vague topic.
  if (ambitious && isThinTopic(t)) {
    return {
      ambiguous: true,
      pending: {
        text: (text || "").trim(),
        topic: t,
        correctedText: t,
        correctedTopic: t,
        original: "",
        corrected: "",
        intentType: intentType || "search",
      },
      question:
        `🔍 Sebelum kukerjakan, aku mau pastikan arahnya dulu — supaya tidak menjawab yang salah.\n\n` +
        `Yang kudengar cuma *"${t.slice(0, 80)}"*, belum ada topik konkret yang bisa kukerjakan.\n\n` +
        `Tulis ulang permintaanmu dengan topik yang lebih jelas, atau balas \`ya\` kalau yang *${t.slice(0, 60)}* memang yang kamu maksud.`,
    };
  }

  return { ambiguous: false };
}

export async function parkPendingRelevance(
  env: Env,
  owner: number,
  p: RelevancePending,
): Promise<void> {
  try {
    await env.CONFIG_KV?.put(`${PENDING_PREFIX}${owner}`, JSON.stringify(p), {
      expirationTtl: PENDING_TTL,
    });
  } catch { /* best-effort — no confirm, no resume; the next turn stands alone */ }
}

export async function readPendingRelevance(
  env: Env,
  owner: number,
): Promise<RelevancePending | null> {
  try {
    const raw = (await env.CONFIG_KV?.get(`${PENDING_PREFIX}${owner}`, "json").catch<unknown>(() => null)) as
      null | RelevancePending;
    // Confusable pending needs corrected; general-ambiguity pending has none
    // (just a topic to confirm). Require only topic.
    if (!raw || !raw.topic || !raw.intentType) return null;
    return raw;
  } catch {
    return null;
  }
}

export async function clearPendingRelevance(env: Env, owner: number): Promise<void> {
  try {
    await env.CONFIG_KV?.delete(`${PENDING_PREFIX}${owner}`).catch(() => {});
  } catch { /* best-effort */ }
}

export interface RelevanceResolution {
  confirmed: boolean;
  applyCorrection: boolean;
}

/** Interpret the owner's reply to a parked relevance question. Only CLEAR
 *  confirmations resume the parked intent: "1" → corrected reading (only when a
 *  correction was offered), "2"/"ya" → the owner's original wording. Anything
 *  else is NOT a confirmation — the caller discards the pending and processes
 *  the message as a fresh query (fail-closed: never resume a guess). Mirrors
 *  typo_wait semantics. */
export function resolveRelevanceConfirmation(
  reply: string,
  pending: RelevancePending | null,
): RelevanceResolution {
  if (!pending) return { confirmed: false, applyCorrection: false };
  const r = (reply || "").trim().toLowerCase();
  const hasCorrection = !!pending.corrected && pending.corrected !== pending.original;
  if (r === "1") return { confirmed: true, applyCorrection: hasCorrection };
  if (r === "2") return { confirmed: true, applyCorrection: false };
  if (/^(?:ya|y|iya|iyaa|yes|bener|benar|betul|itu|tuh|lanjut|oke|ok|siap)\b/.test(r) && r.length <= 12) {
    return { confirmed: true, applyCorrection: false };
  }
  return { confirmed: false, applyCorrection: false };
}

// ====(B) v11.45 external-executor gate =====================================

/** Pola sapaan / obrolan tanpa substansi (ditolak untuk eksekutor eksternal). */
const EXEC_CASUAL_RE =
  /^(?:halo|hai|hi|hello|hey|pagi|siang|sore|malam|selamat|thanks|terima kasih|makasih|ok|oke|ya|test|coba)\b/i;

/** Kata tunggal ambigu yang bukan tugas eksekusi (negosiasi dulu, bukan eksekusi). */
const EXEC_VAGUE_RE =
  /^(?:lanjut|iya|tidak|bukan|itu|ini|dia|kamu|siapa|apa|kenapa|kapan|dimana|gimana|lanjutkan|detail|info)\b/i;

/** Kata kunci yang MENYATAKAN pekerjaan eksekusi konkret (mengerjakan/menyusun). */
const EXEC_VERB_RE =
  /(ambil|ambilkan|buat|bikin|tulis|tuliskan|buatkan|generate|proses|parse|unduh|download|curl|scrape|fet[h]?|rangkum|ringkas|analisis|cari|riset|lapor|hitung|cek|periksa|jalankan|run|instal|setup|deploy|kemas|kirim|data|file|gambar|render|otomasi|script|skrip|regex|json|csv|api|endpoint)/i;

/** PURE: apakah tujuan layak dibawa ke eksekutor eksternal (lingkungan +
 *  kemampuan)? Sapaan/obrolan/kata ambigu → false. Tugas konkret → true.
 *  Konservatif: tugas yang tidak jelas dikirim ke NEGOSIASI (bukan eksekusi),
 *  jadi kriteria ini TIDAK boleh menolak tujuan yang bertele-tele panjang berisi
 *  kata kerja eksekusi. Fail-closed ke FALSE untuk input kosong. */
export function isRelevantExecutorTask(goal: string | null | undefined): boolean {
  const g = (goal ?? "").trim();
  if (g.length < 4) return false;
  if (EXEC_VAGUE_RE.test(g)) {
    // Kata ambigu tapi dengan isi eksekusi di belakangnya (mis. "lanjutkan riset AI")
    // → tetap layak; hanya kata ambigu TANPA isi yang ditolak.
    if (!EXEC_VERB_RE.test(g)) return false;
  }
  if (EXEC_CASUAL_RE.test(g) && !EXEC_VERB_RE.test(g)) return false;
  return true;
}

/** PURE: pesan bernuansa eksekusi langsung yang TIDAK pantas masuk jalur
 *  sandbox karena hanya menyapa/mengangguk. Untuk respon ramah pengalihan. */
export function isCasualOnly(goal: string | null | undefined): boolean {
  const g = (goal ?? "").trim();
  if (g.length < 4) return true;
  if (EXEC_VAGUE_RE.test(g) && !EXEC_VERB_RE.test(g)) return true;
  return EXEC_CASUAL_RE.test(g) && !EXEC_VERB_RE.test(g);
}
//=====================================================================
// relevance.ts — RELEVANCE GATE (m9-v9): never execute an ambitious
// intent on a topic whose meaning we can't verify.
//
// Principle (owner-stated): JARVIS may know a lot, but relevance comes
// first — "understand → confirm → execute". When a search/design/code
// request carries a confusable topic word, executing OUR OWN reading of
// it can answer the wrong question entirely (the "bias corrected" /
// "bias correction" misfire precedent). So we ask ONE short confirmation
// ("apakah topik ini yang kamu cari?") and PARK the intended action in
// CONFIG_KV with a TTL. The owner's next "1"/"2"/"ya" resumes it;
// anything else discards it and is processed as a fresh query.
//
// This mirrors the webhook typo_wait pattern (M8-v25/v27) at the BRAIN
// layer: the webhook path already gates confusables before runResearch,
// but processIntelligence/act() executed search/design/code without any
// relevance check. Fail-closed: never guess-execute, never block a
// clear request, never throw.
//=====================================================================

import { Env } from "./db";
import { detectConfusableTopic } from "./ai";

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
 *  2) GENERAL AMBIGUITY (owner principle — "relevance first, never guess"):
 *     an ambitious intent whose topic is too thin or dominated by referential
 *     markers ("itu", "yang tadi") would make us execute OUR OWN guess of the
 *     topic. Ask one short confirmation instead of burning budget on it.
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
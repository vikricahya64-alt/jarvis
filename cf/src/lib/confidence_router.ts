//=====================================================================
// confidence_router.ts — Deterministic confidence router (Level 14).
//
// JARVIS bukan ML yang menghitung semua probabilitas. Ia hanya menghitung
// probabilitas PEMAHAMAN secara deterministik (0 token, <1ms) dari sinyal
// yang sudah dihasilkan perceive():
//   - subjek hadir (extractTopic)
//   - intent confidence (classifyIntent)
//   - bahasa/literasi/domain confidence (comprehend)
//   - unknown entity signal
//   - emosi confidence
//
// Threshold 70% (UNDERSTAND_CONFIDENCE_HIGH):
//   conf ≥ 0.7 → JAWAB LANGSUNG (0 search, 0 token probabilitas)
//   conf < 0.7 → TANYA + SEARCH paralel → model merge
//   emosi murni tanpa subjek → CLARIFY (0 token, search tak berguna)
//
// Live failure yang diperbaiki:
//   "Saya sedang bingung" → halusinasi "kerja remote" dari memori
//   "Bukan soal apa-apa hanya hari ini sedang bingung" → halusinasi echo hello
//=====================================================================

import { Env } from "./db";
import type { Perception } from "./intelligence";
import {
  isVagueNoSubject,
  CLARIFY_EMPTY_SUBJECT,
  extractTopic,
  unknownEntitySignal,
  searchTopResults,
  groqSingleShot,
  llmRespond,
} from "./ai";
import { appendMemory } from "./db";

// ============================================================================
// CONSTANTS
// ============================================================================

/** Threshold confidence di atas mana JARVIS menjawab langsung (tanpa search).
 *  Di bawah threshold → tanya+search. Sesuai arsitektur: JARVIS hanya
 *  "menghitung probabilitas" ≥0.7; di bawah → serahkan ke model + search. */
export const UNDERSTAND_CONFIDENCE_HIGH = 0.7;

/** Threshold di mana input sudah SANGAT jelas (subject + intent + bahasa
 *  semua positif). Di atas threshold ini, JARVIS skip heavy processing
 *  (act() pipeline) dan langsung ke llmRespond. Hemat 1-2 LLM calls
 *  untuk pesan sederhana jelas (contoh: "apa kabar?", "siapa kamu?"). */
export const SKIP_HEAVY_CONFIDENCE = 0.85;

/** Threshold intensitas emosi di mana emosi dianggap DOMINAN. Di atas
 *  threshold ini + intent chat/understand → force "clarify" (empati dulu,
 *  bukan saran). Hemat token: clarify 50-100 token vs full response 500-1000. */
export const EMOTION_DOMINANT_INTENSITY = 0.45;

// ============================================================================
// CONFIDENCE COMPUTATION (deterministik, 0 token, <1ms)
// ============================================================================

/**
 * Hitung confidence pemahaman input secara deterministik.
 * Gabungan sinyal yang SUDAH dihasilkan perceive() — tidak ada panggilan
 * LLM baru, tidak ada search, tidak ada biaya token.
 *
 * Bobot total = 85. Score = weighted_sum / 85.
 */
export function computeUnderstandConfidence(p: Perception, text: string): number {
  const t = (text ?? "").trim();
  if (!t) return 0;

  const comp = p?.comprehension;
  const langConf = comp?.language?.confidence ?? 0.4;
  const litConf = comp?.literacy?.confidence ?? 0.5;
  const domConf = comp?.domain?.confidence ?? 0.3;
  const intentConf = p?.intent?.confidence ?? 0.5;
  const emotConf = p?.emotion?.confidence ?? 0.5;

  // Subjek nyata (bukan fallback teks mentah, bukan emosi tanpa subjek)
  const realTopic = extractTopic(t);
  const hasRealSubject = !!realTopic && !isVagueNoSubject(t);

  // Unknown entity = platform/produk asing → penalty
  const hasUnknown = unknownEntitySignal(t);

  // Continuity yang ter-anchor (bukan memory bleed)
  const contBoost = p?.isContinuation && hasRealSubject ? 0.8 : 0.4;

  // Weighted sum
  let weighted = 0;
  let maxWeight = 0;

  const add = (w: number, v: number) => { maxWeight += w; weighted += w * Math.max(0, Math.min(1, v)); };

  add(25, hasRealSubject ? 1 : 0.1);           // Subjek hadir = kuat
  add(20, intentConf);                          // Intent jelas
  add(10, langConf);                            // Bahasa teridentifikasi
  add(5,  litConf);                             // Literasi teridentifikasi
  add(5,  domConf);                             // Domain teridentifikasi
  add(10, hasUnknown ? 0.2 : 1);               // Unknown entity = penalty
  add(5,  emotConf);                            // Emosi terdeteksi
  add(5,  contBoost);                           // Continuity

  return maxWeight > 0 ? weighted / maxWeight : 0;
}

// ============================================================================
// ANSWER MODE DECISION
// ============================================================================

export type AnswerMode = "direct" | "ask_search" | "clarify";

/**
 * Putuskan mode jawab berdasarkan confidence deterministik:
 * - "clarify" = emosi murni tanpa subjek → CLARIFY_EMPTY_SUBJECT (0 token)
 * - "clarify" = emosi dominan (intensity ≥ 0.45 + intent chat) → empati dulu
 * - "direct" = conf ≥ 0.7 → jawab langsung (0 search, 0 token probabilitas)
 * - "ask_search" = conf < 0.7 → tanya model + search paralel → merge
 */
export function decideAnswerMode(p: Perception, text: string): AnswerMode {
  if (isVagueNoSubject(text)) return "clarify";
  // Emosi dominan: user curhat/emosi → tanya empati dulu, bukan saran.
  // Hemat token: clarify ~50-100 token vs full response ~500-1000 token.
  const emotIntensity = p?.emotion?.intensity ?? 0;
  const intentType = p?.intent?.type ?? "";
  if (emotIntensity >= EMOTION_DOMINANT_INTENSITY && /^(chat|understand)$/.test(intentType)) {
    return "clarify";
  }
  const conf = computeUnderstandConfidence(p, text);
  return conf >= UNDERSTAND_CONFIDENCE_HIGH ? "direct" : "ask_search";
}

/**
 * Apakah input ini cukup jelas untuk skip heavy processing (act() pipeline)?
 * Threshold 0.85: subject + intent + bahasa semua positif → langsung llmRespond.
 * Mengembalikan { skip, conf } agar caller bisa memutuskan.
 */
export function shouldSkipHeavy(p: Perception, text: string): { skip: boolean; conf: number } {
  const conf = computeUnderstandConfidence(p, text);
  return { skip: conf >= SKIP_HEAVY_CONFIDENCE, conf };
}

/**
 * Apakah emosi user dominan? (intensity ≥ threshold + intent chat/understand).
 * Jika ya, JARVIS harus tanya empati dulu, bukan langsung kasih saran.
 */
export function isEmotionDominant(p: Perception): boolean {
  const intensity = p?.emotion?.intensity ?? 0;
  const intentType = p?.intent?.type ?? "";
  return intensity >= EMOTION_DOMINANT_INTENSITY && /^(chat|understand)$/.test(intentType);
}

// ============================================================================
// SEARCH KEY EXTRACTION
// ============================================================================

/**
 * Ekstrak kata kunci search dari pesan. Prioritas: real topic dari
 * extractTopic, fallback ke beberapa kata signifikan dari teks.
 */
export function extractSearchKey(p: Perception, text: string): string | null {
  // Real topic (punya command/question verb + subjek)
  const realTopic = extractTopic(text);
  if (realTopic) return realTopic;

  // Fallback: ambil kata >= 4 huruf yang bukan filler
  const FILLERS = new Set([
    "yang", "dengan", "untuk", "dari", "dalam", "pada", "adalah",
    "ini", "itu", "saya", "aku", "kamu", "bisa", "tidak", "akan",
    "sudah", "sedang", "lagi", "hanya", "cuma", "mau", "ingin",
    "tolong", "bantu", "buat", "apa", "bagaimana", "gimana",
    "kenapa", "mengapa", "kapan", "dimana", "siapa", "berapa",
  ]);
  const words = text.toLowerCase()
    .replace(/[^\w\s]/g, "")
    .split(/\s+/)
    .filter((w) => w.length >= 4 && !FILLERS.has(w));
  if (words.length === 0) return null;
  return words.slice(0, 5).join(" ");
}

// ============================================================================
// ASK + SEARCH PATH
// ============================================================================

/**
 * Jalur TANYA + SEARCH: paralel tanya model + search web, lalu satukan
 * hasilnya dalam satu panggilan model final.
 *
 * Arsitektur (sesuai pemilik):
 *   1. Tanya model terpasang (Groq) → pahami + jawab sementara
 *   2. Search web → kumpulkan fakta
 *   3. Satu model final: gabung (A + S + konteks percakapan) →
 *      ringkas & susun respons kontekstual
 *
 * Probabilitas pemahaman FOLDED ke dalam generasi jawaban — tidak ada
 * panggilan terpisah untuk "hitung probabilitas" (hemat token).
 */
export async function askSearchRespond(
  env: Env,
  owner: number,
  text: string,
  perception: Perception,
): Promise<string> {
  const searchKey = extractSearchKey(perception, text);

  // Paralel: tanya model + search web (jika ada search key)
  const [modelGuess, searchHits] = await Promise.all([
    groqSingleShot(env, {
      label: "groq:ask_interpret",
      user:
        "Pahami pesan pengguna ini dan berikan jawaban singkat yang relevan. " +
        "Jika pesan emosional/abstrak, berikan respons empati yang sesuai.\n\n" +
        `Pesan: "${text}"\n` +
        `Topik aktif: ${perception.topic ?? "(belum ada)"}`,
      temperature: 0.3,
      maxTokens: 200,
    }).catch(() => null as string | null),
    searchKey
      ? searchTopResults(env, searchKey, 3).catch(() => [] as Array<{ title: string; url: string; snippet: string }>)
      : Promise.resolve([] as Array<{ title: string; url: string; snippet: string }>),
  ]);

  // Susun konteks untuk model final
  const contextParts: string[] = [];

  if (modelGuess) {
    contextParts.push(`[Interpretasi model]\n${modelGuess}`);
  }
  if (searchHits.length > 0) {
    const hitDigest = searchHits
      .slice(0, 3)
      .map((h) => `• ${h.title}: ${h.snippet.slice(0, 120)}`)
      .join("\n");
    contextParts.push(`[Hasil pencarian]\n${hitDigest}`);
  }

  if (contextParts.length === 0) {
    // Tidak ada model guess DAN tidak ada search → fallback clarify
    return CLARIFY_EMPTY_SUBJECT;
  }

  // Satu model final: gabung semua → respons kontekstual
  const finalContext = contextParts.join("\n\n");
  const result = await llmRespond(env, text, {
    context: [{ role: "assistant", content: finalContext }],
    topic: perception.topic ?? undefined,
  }).catch(() => ({ reply: null as string | null }));

  const reply = result.reply;
  if (!reply || reply.trim().length < 5) {
    // Model gagal → fallback ke modelGuess saja
    return modelGuess && modelGuess.trim().length > 5
      ? modelGuess.trim()
      : CLARIFY_EMPTY_SUBJECT;
  }

  // Simpan ringkasan ke memori (episodic)
  const summary = `[tanya+search] ${text.slice(0, 80)} → ${reply.slice(0, 200)}`;
  await appendMemory(env, owner, "assistant", summary, "").catch(() => {});

  return reply.trim();
}

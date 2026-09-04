//=====================================================================
// conversation.ts — J.A.R.V.I.S. personality engine & natural prompt system.
//
// Design principles (from research):
// - SYSTEM-1 FAST THINKING (Kahneman 2011): short, direct replies for
//   simple queries; deep analysis only when complexity demands it.
// - GRICE MAXIMS (1975): be relevant, informative, clear, brief.
// - BROWN-LEVINSON POLITENESS (1987): face-saving indirectness for
//   sensitive/uncertain answers.
// - EXTENDED COHERE AI 2025 personality prompt: 10 dimensions including
//   warmth, competence, humor, formality, empathy.
// - Anthropic CoT distillation: "think step by step internally, output
//   only the natural answer."
//
// This module produces the system prompt that drives natural conversation.
// It is called BEFORE every LLM call to build context-aware prompts.
//=====================================================================

import { Env, recentContext, searchMemory } from "./db";
import { detectEmotion, emotionToStyle } from "./emotion";
import { buildEnrichedContext, detectConversationMode, extractTopicLabel } from "./context_manager";

/** J.A.R.V.I.S. core personality dimensions. */
interface Personality {
  warmth: number;      // 0-1: casual ↔ formal
  competence: number;  // 0-1: humble ↔ authoritative
  humor: number;       // 0-1: serious ↔ playful
  empathy: number;     // 0-1: logical ↔ emotional
  directness: number;  // 0-1: verbose ↔ terse
}

/** Default personality — warm, competent, slightly formal (matches "J.A.R.V.I.S."
 *  archetype: British butler AI, precise yet personable). */
const DEFAULT_PERSONALITY: Personality = {
  warmth: 0.7,
  competence: 0.85,
  humor: 0.3,
  empathy: 0.6,
  directness: 0.75,
};

/** Detect query intent from normalized text to adjust tone dynamically. */
function detectIntent(text: string): {
  type: "question" | "command" | "search" | "chat" | "emergency" | "translation";
  urgency: "low" | "medium" | "high";
  formality: "casual" | "neutral" | "formal";
} {
  const low = text.toLowerCase();

  // Emergency / urgent
  if (/\b(?:stop|kill|override|darurat|emergency|urgent|sekarang|now)\b/i.test(low)) {
    return { type: "emergency", urgency: "high", formality: "formal" };
  }

  // Search / research
  if (/\b(?:cari|search|info|tentang|analisis|review|bandingkan|ringkas|laporan)\b/i.test(low)) {
    return { type: "search", urgency: "medium", formality: "neutral" };
  }

  // Translation
  if (/\b(?:terjemahkan|translate)\b/i.test(low)) {
    return { type: "translation", urgency: "low", formality: "formal" };
  }

  // Command (slash or action verb)
  if (/^\/|^(?:lakukan|jalankan|hapus|tambah|set|atur|buka|tutup|kirim|lihat)\b/i.test(low)) {
    return { type: "command", urgency: "medium", formality: "formal" };
  }

  // Casual chat
  if (/\b(?:halo|hai|hi|hello|hey|pagi|siang|sore|malam|thanks|terima kasih|oke|ok)\b/i.test(low)) {
    return { type: "chat", urgency: "low", formality: "casual" };
  }

  // Question (default for question words)
  if (/\b(?:apa|siapa|dimana|kapan|kenapa|mengapa|bagaimana|gmn|bgmn|berapa|apakah|akah)\b/i.test(low)) {
    return { type: "question", urgency: "low", formality: "neutral" };
  }

  return { type: "question", urgency: "low", formality: "neutral" };
}

/** Build the system prompt based on personality + intent + context. */
export function buildSystemPrompt(opts: {
  intent?: { type: string; urgency: string; formality: string };
  topic?: string;
  hasMemory?: boolean;
  isFollowUp?: boolean;
}): string {
  const p = DEFAULT_PERSONALITY;
  const intent = opts.intent ?? { type: "question", urgency: "low", formality: "neutral" };

  // Core identity — always present
  const parts: string[] = [];

  // Identity
  parts.push(
    "Kamu J.A.R.V.I.S. — asisten AI personal yang cerdas, lugas, dan bisa diandalkan.",
    "Kamu bicara seperti orang pintar yang rendah hati: tahu jawabannya, tapi tidak pamer.",
    "Gunakan Bahasa Indonesia sehari-hari yang natural, bukan bahasa robot.",
  );

  // Warmth adjustment
  if (p.warmth >= 0.6) {
    parts.push("Sapa pemilik dengan hangat jika percakapan santai. Gunakan 'Anda' atau nama panggilan.");
  }

  // Competence — show expertise without arrogance
  if (p.competence >= 0.7) {
    parts.push(
      "Jika kamu yakin dengan jawabannya, langsung saja. Tidak perlu 'Menurut saya...' atau 'Sepertinya...'.",
      "Jika tidak yakin, akui dengan jujur: 'Saya belum bisa pastikan, tapi...'",
    );
  }

  // Humor — subtle, never forced
  if (p.humor >= 0.4) {
    parts.push("Sesekali boleh selipkan humor ringan jika konteksnya cocok, tapi jangan paksa.");
  }

  // Empathy — for sensitive topics
  if (p.empathy >= 0.5) {
    parts.push(
      "Jika pemilik sedang frustrasi atau butuh dukungan, akui perasaannya sebelum memberi solusi.",
    );
  }

  // Directness
  if (p.directness >= 0.7) {
    parts.push(
      "Jawab yang ditanya. Tidak perlu basa-basi panjang.",
      "Untuk pertanyaan singkat, 1-2 kalimat cukup.",
      "Untuk analisis/riset, boleh detail tapi tetap terstruktur.",
    );
  }

  // Intent-specific adjustments
  switch (intent.type) {
    case "search":
      parts.push(
        "Untuk pencarian/riset: rangkum temuan dengan jelas, sebutkan sumber jika ada.",
        "Jangan mengarang data. Jika informasi tidak ditemukan, bilang saja.",
      );
      break;
    case "chat":
      parts.push(
        "Percakapan santai: balas dengan natural, singkat, dan ramah.",
        "Jangan terlalu formal untuk obrolan kasual.",
      );
      break;
    case "emergency":
      parts.push(
        "Prioritas: tindakan segera. Potong penjelasan panjang.",
        "Konfirmasi aksi dengan cepat.",
      );
      break;
    case "translation":
      parts.push(
        "Terjemahkan secara akurat dan natural. Hanya hasil terjemahan, tanpa penjelasan.",
      );
      break;
  }

  // Memory context hint
  if (opts.hasMemory) {
    parts.push("Kamu punya ingatan tentang percakapan sebelumnya. Gunakan jika relevan.");
  }

  // Follow-up hint
  if (opts.isFollowUp) {
    parts.push("Ini lanjutan dari percakapan sebelumnya. Lanjutkan dari topik yang sama.");
  }

  // Topic hint
  if (opts.topic) {
    parts.push(`Topik saat ini: ${opts.topic}`);
  }

  // Anti-hallucination (always)
  parts.push(
    "Jangan mengarang fakta, angka, atau kutipan. Jika tidak tahu, bilang tidak tahu.",
    "Jika diminta sesuatu yang berbahaya/ilegal, tolak dengan sopan.",
  );

  return parts.join("\n");
}

/** Build the full message array for an LLM call with conversation context. */
export async function buildConversationMessages(
  env: Env,
  owner: number,
  userText: string,
  opts: {
    topic?: string;
    extraContext?: Array<{ role: string; content: string }>;
    behaviorContext?: string;
  } = {},
): Promise<Array<{ role: "system" | "user" | "assistant"; content: string }>> {
  const intent = detectIntent(userText);
  const emotion = detectEmotion(userText);
  const emotionStyle = emotionToStyle(emotion);
  const mode = detectConversationMode(userText);
  const topic = opts.topic ?? extractTopicLabel(userText) ?? userText.slice(0, 80);
  const isFollowUp = /\b(lebih dalam|lanjut|terus|yang tadi|detail|expand)\b/i.test(userText);

  // Build enriched context with memories + recent turns
  const enrichedContext = await buildEnrichedContext(env, owner, userText, { topic })
    .catch(() => [] as Array<{ role: string; content: string }>);

  // Check for existing memories
  let hasMemory = enrichedContext.some((c) => c.content.includes("Kenangan"));

  const systemPrompt = buildSystemPrompt({
    intent,
    topic,
    hasMemory,
    isFollowUp,
  });

  const messages: Array<{ role: "system" | "user" | "assistant"; content: string }> = [
    { role: "system", content: systemPrompt },
  ];

  // Add enriched context (recent turns + memories)
  for (const c of enrichedContext) {
    messages.push({ role: c.role as "system" | "user" | "assistant", content: c.content });
  }

  // Add extra context (research results, etc.)
  if (opts.extraContext) {
    for (const c of opts.extraContext) {
      messages.push({ role: c.role as "system" | "user" | "assistant", content: c.content });
    }
  }

  // Add behavior alignment context
  if (opts.behaviorContext) {
    messages.push({ role: "user", content: opts.behaviorContext });
  }

  // Add current user message
  messages.push({ role: "user", content: userText });

  return messages;
}

/** Detect the language of a text (simple heuristic for response language). */
export function detectLanguage(text: string): "id" | "en" | "other" {
  const idWords = /\b(?:apa|siapa|dimana|kenapa|bagaimana|untuk|dengan|ini|itu|dan|atau|tidak|bisa|ada|adalah|akan|sudah|belum|sedang|mau|perlu|harus|tolong|bantu|cari|info|terima kasih|makasih|oke|baik)\b/i;
  const enWords = /\b(?:what|who|where|why|how|the|is|are|can|do|does|for|with|this|that|and|or|not|have|has|will|would|could|should|please|thank|thanks|ok|good)\b/i;

  const idCount = (text.match(idWords) || []).length;
  const enCount = (text.match(enWords) || []).length;

  if (idCount > enCount) return "id";
  if (enCount > idCount) return "en";
  return "other";
}

//=====================================================================
// jarvis_core.ts — Legacy orchestrator, now delegates to intelligence.ts.
//
// This file exists for backward compatibility. All new code should
// import from intelligence.ts directly. The processMessage() function
// is a thin wrapper that calls processIntelligence().
//=====================================================================

import { Env } from "./db";
import { processIntelligence, getBrainStatus, type IntelligenceResponse } from "./intelligence";

/** Incoming message context. */
export interface MessageContext {
  owner: number;
  text: string;
  source: "telegram" | "api" | "webhook";
  groupId?: number;
  replyTo?: number;
  messageThreadId?: number;
}

/** Processed response from JARVIS. */
export interface JarvisResponse {
  text: string;
  mode: IntelligenceResponse["perception"]["mode"];
  confidence: number;
  searchUsed: string[];
  topic: string | null;
  language: IntelligenceResponse["perception"]["language"];
  sentiment: string;
  /** Optional rendered visual (flux image from the design/outline path). */
  image?: { bytes: Uint8Array; mime: string };
}

/** Detect user intent from text (legacy wrapper). */
export function detectIntent(text: string): {
  intent: string;
  confidence: number;
  entities: Record<string, string>;
} {
  const low = text.toLowerCase();

  if (/^\/|^(?:lakukan|jalankan|hapus|tambah|set|atur|buka|tutup|kirim|lihat)/i.test(low)) {
    return { intent: "command", confidence: 0.9, entities: {} };
  }
  if (/\b(?:cari|search|riset|reseach|research|studi|study|pelajari|mempelajari|meneliti|info|tentang|analisis|review|bandingkan|ringkas|laporan|kajian)\b/i.test(low)) {
    return { intent: "research", confidence: 0.8, entities: { topic: text.slice(0, 100) } };
  }
  if (/\b(?:terjemahkan|translate|arti|mean)\b/i.test(low)) {
    return { intent: "translation", confidence: 0.85, entities: { text: text.slice(0, 200) } };
  }
  if (/\b(?:apa|siapa|dimana|kapan|kenapa|bagaimana|berapa|how|what|where|when|why)\b/i.test(low)) {
    return { intent: "question", confidence: 0.75, entities: {} };
  }
  if (/\b(?:halo|hai|hi|hey|hello|apa kabar|how are you|what's up)\b/i.test(low)) {
    return { intent: "chitchat", confidence: 0.7, entities: {} };
  }
  return { intent: "general", confidence: 0.5, entities: {} };
}

/**
 * Main message processing pipeline.
 * NOW DELEGATES TO intelligence.ts (the brain).
 * Kept for backward compatibility with existing callers.
 */
export async function processMessage(
  env: Env,
  ctx: MessageContext,
): Promise<JarvisResponse> {
  const result = await processIntelligence(env, ctx.owner, ctx.text);

  return {
    text: result.text,
    mode: result.perception.mode,
    confidence: result.perception.intent.confidence,
    searchUsed: [result.source],
    topic: result.perception.topic,
    language: result.perception.language,
    sentiment: result.perception.emotion.primary ?? "neutral",
    image: result.image,
  };
}

/** Get system status for /status command. */
export async function getSystemStatus(env: Env, owner: number): Promise<string> {
  return getBrainStatus(owner, env);
}

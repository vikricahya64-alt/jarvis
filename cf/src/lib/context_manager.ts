//=====================================================================
// context_manager.ts — conversation state & memory manager for JARVIS.
//
// Manages:
// - Conversation turn tracking (who said what, when)
// - Topic continuity (is this a continuation or new topic?)
// - Memory recall (what does JARVIS remember about this topic?)
// - Speaker identification (owner vs others in group chat)
// - Session state (active topics, pending actions, follow-ups)
//
// Design references:
// - MemGPT (Packer et al., 2023): hierarchical memory management
// - generative_agents (Park et al., 2023): memory retrieval + reflection
// - RAPTOR (Sarthi et al., 2024): recursive abstractive memory trees
//=====================================================================

import { Env, recentContext, appendMemory, searchMemory } from "./db";

/** A single conversation turn. */
export interface Turn {
  role: "user" | "assistant" | "system";
  content: string;
  timestamp: number;
  topic?: string;
  emotion?: string;
}

/** Conversation session state. */
export interface SessionState {
  owner: number;
  activeTopic: string | null;
  turnCount: number;
  lastInteraction: number;
  pendingFollowUp: boolean;
  recentTopics: string[];
  mood: string;            // detected emotional state
  conversationMode: "chat" | "research" | "command" | "translation";
}

/** In-memory session cache (per-owner, reset on cold start). */
const sessions = new Map<number, SessionState>();

/** Get or create session state for an owner. */
export function getSession(owner: number): SessionState {
  let s = sessions.get(owner);
  if (!s) {
    s = {
      owner,
      activeTopic: null,
      turnCount: 0,
      lastInteraction: 0,
      pendingFollowUp: false,
      recentTopics: [],
      mood: "neutral",
      conversationMode: "chat",
    };
    sessions.set(owner, s);
  }
  return s;
}

/** Detect if the current message is a continuation of a prior topic
 *  or a fresh topic switch. Uses keyword overlap + recency decay. */
export function detectTopicContinuity(
  currentText: string,
  priorContext: Array<{ role: string; content: string }>,
): { isContinuation: boolean; topic: string | null; confidence: number } {
  if (priorContext.length === 0) {
    return { isContinuation: false, topic: null, confidence: 0 };
  }

  const lastAssistant = [...priorContext].reverse().find((c) => c.role === "assistant");
  const lastUser = [...priorContext].reverse().find((c) => c.role === "user");

  if (!lastAssistant && !lastUser) {
    return { isContinuation: false, topic: null, confidence: 0 };
  }

  const prior = (lastAssistant?.content ?? lastUser?.content ?? "").toLowerCase();
  const current = currentText.toLowerCase();

  // Extract key nouns/concepts (simple: words >= 4 chars)
  const priorWords = new Set(prior.split(/\s+/).filter((w) => w.length >= 4));
  const currentWords = current.split(/\s+/).filter((w) => w.length >= 4);

  let overlap = 0;
  for (const w of currentWords) {
    if (priorWords.has(w)) overlap++;
  }

  const overlapRatio = currentWords.length > 0 ? overlap / currentWords.length : 0;

  // Follow-up markers (high continuation signal)
  const followUpMarkers = /\b(lebih dalam|lanjut|terus|yang tadi|detail|expand|selanjutnya|kemudian|lalu|itupun|itu jug)\b/i;
  const isFollowUp = followUpMarkers.test(current);

  // Topic switch markers
  const switchMarkers = /\b(switch|ganti|beda|lain|sekarang|skrg|next|move on|coba|gimana kalau|how about|what about)\b/i;
  const isSwitch = switchMarkers.test(current);

  if (isFollowUp) {
    return { isContinuation: true, topic: null, confidence: 0.9 };
  }
  if (isSwitch) {
    return { isContinuation: false, topic: null, confidence: 0.8 };
  }

  if (overlapRatio >= 0.3) {
    return { isContinuation: true, topic: null, confidence: Math.min(0.8, 0.4 + overlapRatio) };
  }

  return { isContinuation: false, topic: null, confidence: 0.3 };
}

/** Build enriched context for LLM calls, combining recent turns + memories. */
export async function buildEnrichedContext(
  env: Env,
  owner: number,
  userText: string,
  opts: {
    maxRecentTurns?: number;
    maxMemories?: number;
    topic?: string;
  } = {},
): Promise<Array<{ role: string; content: string }>> {
  const maxRecent = opts.maxRecentTurns ?? 4;
  const maxMems = opts.maxMemories ?? 3;
  const context: Array<{ role: string; content: string }> = [];

  // 1) Recent conversation turns
  try {
    const recent = await recentContext(env, owner, maxRecent);
    for (const r of recent) {
      if (r.role === "user" || r.role === "assistant") {
        context.push({ role: r.role, content: r.content.slice(0, 1200) });
      }
    }
  } catch { /* fail-open */ }

  // 2) Relevant memories (FTS5 search)
  const topic = opts.topic ?? userText.slice(0, 80);
  try {
    const mems = await searchMemory(env, topic, maxMems);
    if (mems.length > 0) {
      const memText = mems.map((m) => m.content).join(" | ").slice(0, 1000);
      context.push({
        role: "assistant",
        content: `[Kenangan relevan tentang "${topic}"]: ${memText}`,
      });
    }
  } catch { /* fail-open */ }

  return context;
}

/** Update session state after processing a turn. */
export function updateSession(
  owner: number,
  userText: string,
  reply: string,
  topic: string | null,
  mode: SessionState["conversationMode"],
): void {
  const s = getSession(owner);
  s.turnCount++;
  s.lastInteraction = Date.now();
  s.conversationMode = mode;

  if (topic) {
    s.activeTopic = topic;
    if (!s.recentTopics.includes(topic)) {
      s.recentTopics.unshift(topic);
      if (s.recentTopics.length > 5) s.recentTopics.pop();
    }
  }

  // Detect pending follow-up
  s.pendingFollowUp = /\b(lebih dalam|lanjut|terus|detail|expand)\b/i.test(reply);
}

/** Detect conversation mode from user text. */
export function detectConversationMode(
  text: string,
): SessionState["conversationMode"] {
  const low = text.toLowerCase();

  if (/^\/|^(?:lakukan|jalankan|hapus|tambah|set|atur|buka|tutup|kirim|lihat)/i.test(low)) {
    return "command";
  }
  if (/\b(?:cari|search|info|tentang|analisis|review|bandingkan|ringkas|laporan)\b/i.test(low)) {
    return "research";
  }
  if (/\b(?:terjemahkan|translate)\b/i.test(low)) {
    return "translation";
  }
  return "chat";
}

/** Generate a topic label from text (simple extraction). */
export function extractTopicLabel(text: string): string | null {
  const low = text.toLowerCase();

  // Search/research query
  const searchMatch = low.match(
    /\b(?:cari|info|tentang|analisis|review|bandingkan|ringkas)\b\s*[:\-]?\s*(.+)/,
  );
  if (searchMatch) return searchMatch[1].slice(0, 60);

  // Question topic
  const questionMatch = low.match(
    /\b(?:apa|siapa|dimana|kapan|kenapa|bagaimana|berapa)\s+(?:itu|ini|yang)?\s*(.+)/,
  );
  if (questionMatch) return questionMatch[1].slice(0, 60);

  return null;
}

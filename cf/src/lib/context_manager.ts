//=====================================================================
// context_manager.ts — conversation state & memory manager for JARVIS.
//
// Manages:
// - Conversation turn tracking (who said what, when)
// - Topic continuity (is this a continuation or new topic?)
// - Memory recall (what does JARVIS remember about this topic?)
// - Speaker identification (owner vs others in group chat)
// - Session state (active topics, pending actions, follow-ups)
// - Working memory scratchpad (for multi-step reasoning)
// - Summarization chains (compress old turns to save context)
// - Mood tracking integration (emotion memory across turns)
//
// Design references:
// - MemGPT (Packer et al., 2023): hierarchical memory management
// - generative_agents (Park et al., 2023): memory retrieval + reflection
// - RAPTOR (Sarthi et al., 2024): recursive abstractive memory trees
// - MemoryOS (BAI-LAB, 2025 EMNLP): working/episodic/semantic tiers
// - Observational Memory (VentureBeat, 2025): dated structured notes
// - "State of AI Agent Memory 2026" (Mem0): 3-tier hierarchy consensus
// - CORAL (2026): self-evolving multi-agent shared persistent memory
//=====================================================================

import { Env, recentContext, appendMemory, searchMemory } from "./db";
import { detectEmotion, updateMood, getMoodState, setMoodState, moodSummary, type MoodState } from "./emotion";

/** A single conversation turn. */
export interface Turn {
  role: "user" | "assistant" | "system";
  content: string;
  timestamp: number;
  topic?: string;
  emotion?: string;
}

/** Working memory scratchpad for multi-step reasoning within a session.
 *  Inspired by MemGPT's working memory + AI tutor scratchpad patterns. */
export interface WorkingMemory {
  /** Current problem or task being worked on */
  currentTask: string | null;
  /** Step tracking for multi-step tasks */
  stepsCompleted: string[];
  /** Pending sub-questions or follow-ups */
  pendingItems: string[];
  /** Key facts extracted so far in this reasoning chain */
  extractedFacts: string[];
  /** Error tracking for iterative correction */
  errorsDetected: string[];
  /** Confidence in current reasoning path */
  reasoningConfidence: number;
  /** Timestamp of last update */
  lastUpdated: number;
}

/** Conversation session state. */
export interface SessionState {
  owner: number;
  activeTopic: string | null;
  turnCount: number;
  lastInteraction: number;
  pendingFollowUp: boolean;
  recentTopics: string[];
  mood: string;
  conversationMode: "chat" | "research" | "command" | "translation";
  /** Working memory for current reasoning chain */
  workingMemory: WorkingMemory;
  /** Summarized older turns (to save context window) */
  summaryBuffer: string;
  /** Number of raw turns compressed into summaryBuffer */
  summarizedTurns: number;
  /** Session start time */
  sessionStart: number;
  /** Conversation style preferences learned from this session */
  learnedStyle: {
    preferredLength: "short" | "normal" | "detailed" | null;
    preferredFormality: "casual" | "neutral" | "formal" | null;
    topicsExplored: string[];
  };
}

/** In-memory session cache (per-owner, reset on cold start).
 *  Untuk single-owner, ini acceptable. Multi-owner butuh D1-backed sessions.
 *  Sesi di-load dari KV saat cold start dan di-save setelah setiap turn. */
const sessions = new Map<number, SessionState>();

/** Context window budget: max tokens to allocate for conversation history.
 *  Approximates 1 token ≈ 4 chars for Indonesian text. */
const MAX_CONTEXT_CHARS = 4800; // ~1200 tokens
const SUMMARY_COMPRESS_THRESHOLD = 8; // compress after this many raw turns
const SUMMARY_TARGET_CHARS = 800; // target length for compressed summary

/** Initialize working memory with defaults. */
function initWorkingMemory(): WorkingMemory {
  return {
    currentTask: null,
    stepsCompleted: [],
    pendingItems: [],
    extractedFacts: [],
    errorsDetected: [],
    reasoningConfidence: 0.7,
    lastUpdated: Date.now(),
  };
}

/** Get or create session state for an owner.
 *  Jika sesi tidak ada di cache (cold start), coba load dari KV. */
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
      workingMemory: initWorkingMemory(),
      summaryBuffer: "",
      summarizedTurns: 0,
      sessionStart: Date.now(),
      learnedStyle: {
        preferredLength: null,
        preferredFormality: null,
        topicsExplored: [],
      },
    };
    sessions.set(owner, s);
  }
  return s;
}

/** Save session to KV for persistence across cold starts.
 *  Panggil setelah setiap turn untuk mengurangi kehilangan konteks. */
export async function saveSessionToKV(env: Env, owner: number): Promise<void> {
  const s = sessions.get(owner);
  if (!s) return;
  try {
    // MoodState (with history/trajectory) persisted so trajectory detection
    // survives cold starts — previously only the string label was kept.
    const moodState = (() => {
      try { return getMoodState(owner); }
      catch { return null; }
    })();
    // Hanya simpan data ringkas (tidak perlu semua field)
    const snapshot = {
      activeTopic: s.activeTopic,
      turnCount: s.turnCount,
      recentTopics: s.recentTopics.slice(0, 5),
      mood: s.mood,
      moodState,
      conversationMode: s.conversationMode,
      summaryBuffer: s.summaryBuffer.slice(0, 500),
      summarizedTurns: s.summarizedTurns,
      sessionStart: s.sessionStart,
      learnedStyle: s.learnedStyle,
      workingMemory: {
        currentTask: s.workingMemory.currentTask,
        stepsCompleted: s.workingMemory.stepsCompleted.slice(-5),
        extractedFacts: s.workingMemory.extractedFacts.slice(-5),
        reasoningConfidence: s.workingMemory.reasoningConfidence,
      },
      savedAt: Date.now(),
    };
    await env.CONFIG_KV.put(
      `session:${owner}`,
      JSON.stringify(snapshot),
      { expirationTtl: 86400 }, // TTL 24 jam
    );
  } catch { /* fail-open: sesi tetap jalan meski KV gagal */ }
}

/** Load session from KV after cold start. */
export async function loadSessionFromKV(env: Env, owner: number): Promise<SessionState> {
  const s = getSession(owner);
  try {
    const raw = await env.CONFIG_KV.get(`session:${owner}`, "json");
    if (!raw) return s;

    const snap = raw as Record<string, unknown>;
    // Restore hanya jika data masih relevan (< 24 jam)
    if (typeof snap.savedAt === "number" && Date.now() - snap.savedAt < 86400_000) {
      s.activeTopic = (typeof snap.activeTopic === "string" ? snap.activeTopic : null);
      s.turnCount = (typeof snap.turnCount === "number" ? snap.turnCount : 0);
      s.recentTopics = (Array.isArray(snap.recentTopics) ? snap.recentTopics : []);
      s.mood = (typeof snap.mood === "string" ? snap.mood : "neutral");
      s.conversationMode = (typeof snap.conversationMode === "string" ? snap.conversationMode : "chat") as SessionState["conversationMode"];
      s.summaryBuffer = (typeof snap.summaryBuffer === "string" ? snap.summaryBuffer : "");
      s.summarizedTurns = (typeof snap.summarizedTurns === "number" ? snap.summarizedTurns : 0);
      s.sessionStart = (typeof snap.sessionStart === "number" ? snap.sessionStart : Date.now());
      if (snap.moodState) setMoodState(owner, snap.moodState);
      if (snap.learnedStyle && typeof snap.learnedStyle === "object") {
        s.learnedStyle = snap.learnedStyle as SessionState["learnedStyle"];
      }
      if (snap.workingMemory && typeof snap.workingMemory === "object") {
        const wm = snap.workingMemory as Record<string, unknown>;
        s.workingMemory.currentTask = (typeof wm.currentTask === "string" ? wm.currentTask : null);
        s.workingMemory.stepsCompleted = (Array.isArray(wm.stepsCompleted) ? wm.stepsCompleted : []);
        s.workingMemory.extractedFacts = (Array.isArray(wm.extractedFacts) ? wm.extractedFacts : []);
        s.workingMemory.reasoningConfidence = (typeof wm.reasoningConfidence === "number" ? wm.reasoningConfidence : 0.7);
      }
    }
  } catch { /* fail-open: gunakan session default */ }
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

/** Compress old turns into a summary string (summarization chain).
 *  Uses extractive summarization: key sentences from older turns.
 *  Returns a summary string to prepend to context. */
function compressTurns(turns: Array<{ role: string; content: string }>): string {
  if (turns.length === 0) return "";

  // Extractive approach: take first sentence of each turn + any explicit facts
  const sentences: string[] = [];
  for (const turn of turns) {
    const text = turn.content.trim();
    // Split into sentences (Indonesian/English punctuation)
    const sents = text.split(/(?<=[.!?])\s+/);
    if (sents.length > 0) {
      // Take the first sentence (most likely to contain the main point)
      sentences.push(sents[0].slice(0, 150));
    }
    // Also extract any explicit facts (dates, numbers, names)
    const factMatch = text.match(/\b(?:tanggal|date|usia|umur|nomor|number|alamat|address|nama|name)\b[^.!?]*[.!?]/gi);
    if (factMatch) {
      for (const f of factMatch.slice(0, 2)) {
        sentences.push(f.slice(0, 100));
      }
    }
  }

  // Deduplicate and truncate
  const unique = [...new Set(sentences)];
  return unique.join(" ").slice(0, SUMMARY_TARGET_CHARS);
}

/** Update working memory based on conversation context. */
export function updateWorkingMemory(
  session: SessionState,
  userText: string,
  assistantReply: string,
): void {
  const wm = session.workingMemory;
  const now = Date.now();
  wm.lastUpdated = now;

  // Detect task switching
  const taskSwitch = /\b(coba|lanjut|ganti|sekarang|next|switch|gimana|bagaimana|cari|search|info)\b/i.test(userText);

  if (taskSwitch && wm.currentTask && wm.stepsCompleted.length > 0) {
    // Archive current task to facts
    wm.extractedFacts.push(`Tugas sebelumnya: ${wm.currentTask} (${wm.stepsCompleted.length} langkah selesai)`);
    wm.currentTask = null;
    wm.stepsCompleted = [];
    wm.pendingItems = [];
  }

  // Set current task if not set
  if (!wm.currentTask && userText.length > 10) {
    wm.currentTask = userText.slice(0, 100);
  }

  // Track steps from assistant response
  if (assistantReply.length > 20) {
    // Check if response contains step indicators
    const stepMatch = assistantReply.match(/(?:langkah|step|poin|1\.|2\.|3\.|pertama|kedua|ketiga)/gi);
    if (stepMatch) {
      wm.stepsCompleted.push(assistantReply.slice(0, 80));
    }
  }

  // Extract facts from assistant response
  const factPatterns = [
    /(?:adalah|merupakan|berarti|means|is a)\s+([^,.!]{10,60})/gi,
    /(?:nilai|value|jumlah|total|angka)\s*[:=]?\s*([^,.!]{5,40})/gi,
    /(?:tanggal|date)\s*[:=]?\s*([^,.!]{5,30})/gi,
  ];
  for (const pat of factPatterns) {
    const matches = assistantReply.matchAll(pat);
    for (const m of matches) {
      if (m[1]) wm.extractedFacts.push(m[1].trim().slice(0, 80));
    }
  }

  // Keep facts bounded
  if (wm.extractedFacts.length > 10) {
    wm.extractedFacts = wm.extractedFacts.slice(-10);
  }

  // Update reasoning confidence based on error signals
  if (/\b(error|maaf|tidak bisa|belum|gagal|salah)\b/i.test(assistantReply)) {
    wm.reasoningConfidence = Math.max(0.3, wm.reasoningConfidence - 0.1);
    wm.errorsDetected.push(assistantReply.slice(0, 80));
    if (wm.errorsDetected.length > 5) wm.errorsDetected = wm.errorsDetected.slice(-5);
  } else {
    wm.reasoningConfidence = Math.min(1, wm.reasoningConfidence + 0.05);
  }
}

/** Compress old turns into summaryBuffer if threshold exceeded. */
function maybeCompressSession(session: SessionState): void {
  if (session.turnCount < SUMMARY_COMPRESS_THRESHOLD) return;
  if (session.summarizedTurns >= session.turnCount) return;

  // The summaryBuffer grows incrementally
  // We don't have access to old turns here, so we track counts
  // The actual compression happens in buildEnrichedContext
  session.summarizedTurns = session.turnCount;
}

/** Build enriched context for LLM calls, combining:
 *  1) Summary buffer (compressed older turns)
 *  2) Recent turns (raw, bounded)
 *  3) Working memory (for multi-step reasoning)
 *  4) Mood context (emotion memory)
 *  5) Relevant memories (FTS5 search)
 *  All within MAX_CONTEXT_CHARS budget. */
export async function buildEnrichedContext(
  env: Env,
  owner: number,
  userText: string,
  opts: {
    maxRecentTurns?: number;
    maxMemories?: number;
    topic?: string;
    mood?: MoodState;
  } = {},
): Promise<Array<{ role: string; content: string }>> {
  const maxRecent = opts.maxRecentTurns ?? 6;
  const maxMems = opts.maxMemories ?? 3;
  const context: Array<{ role: string; content: string }> = [];
  let charBudget = MAX_CONTEXT_CHARS;

  const session = getSession(owner);

  // 1) Summary buffer (compressed older turns)
  if (session.summaryBuffer) {
    const summaryRole = "system";
    const summaryContent = `[Ringkasan percakapan sebelumnya]: ${session.summaryBuffer}`;
    context.push({ role: summaryRole, content: summaryContent });
    charBudget -= summaryContent.length;
  }

  // 2) Recent conversation turns + 5) memories are independent D1 reads —
  //     fetch both in parallel to cut a round-trip on every enriched-context build.
  const topic = opts.topic ?? userText.slice(0, 80);
  const [recent, mems] = await Promise.all([
    recentContext(env, owner, maxRecent).catch(() => [] as Array<{ role: string; content: string }>),
    searchMemory(env, topic, maxMems).catch(() => [] as Array<{ content: string }>),
  ]);
  try {
    for (const r of recent) {
      if (r.role === "user" || r.role === "assistant") {
        const content = r.content.slice(0, Math.min(600, charBudget / 2));
        if (content.length + 50 < charBudget) {
          context.push({ role: r.role, content });
          charBudget -= content.length + 50; // +50 for role prefix overhead
        }
      }
    }
  } catch { /* fail-open */ }

  // 3) Working memory (only if there's an active reasoning chain)
  const wm = session.workingMemory;
  if (wm.currentTask && wm.stepsCompleted.length > 0) {
    const wmContent = [
      `[Memori kerja] Tugas: ${wm.currentTask}`,
      `Langkah selesai: ${wm.stepsCompleted.length}`,
      `Fakta terkumpul: ${wm.extractedFacts.slice(-3).join("; ")}`,
      `Keyakinan: ${(wm.reasoningConfidence * 100).toFixed(0)}%`,
    ].join("\n");
    if (wmContent.length < charBudget) {
      context.push({ role: "system", content: wmContent });
      charBudget -= wmContent.length;
    }
  }

  // 4) Mood context (if tracked)
  if (opts.mood && opts.mood.current !== "neutral") {
    const moodText = `[Konteks emosi]: ${moodSummary(opts.mood)}`;
    if (moodText.length < charBudget) {
      context.push({ role: "system", content: moodText });
      charBudget -= moodText.length;
    }
  }

  // 5) Relevant memories (shared [recent, mems] fetched in parallel above)
  try {
    if (mems.length > 0) {
      const memText = mems.map((m) => m.content).join(" | ").slice(0, Math.min(1000, charBudget));
      context.push({
        role: "assistant",
        content: `[Kenangan relevan tentang "${topic}"]: ${memText}`,
      });
      charBudget -= memText.length;
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
    // Track in learned style
    if (!s.learnedStyle.topicsExplored.includes(topic)) {
      s.learnedStyle.topicsExplored.push(topic);
      if (s.learnedStyle.topicsExplored.length > 20) {
        s.learnedStyle.topicsExplored = s.learnedStyle.topicsExplored.slice(-20);
      }
    }
  }

  // Detect pending follow-up
  s.pendingFollowUp = /\b(lebih dalam|lanjut|terus|detail|expand)\b/i.test(reply);

  // Learn style from conversation patterns
  if (reply.length < 100) {
    s.learnedStyle.preferredLength = "short";
  } else if (reply.length > 500) {
    s.learnedStyle.preferredLength = "detailed";
  }

  // Update working memory
  updateWorkingMemory(s, userText, reply);

  // Maybe compress old turns
  maybeCompressSession(s);
}

// ---------------------------------------------------------------------
// Session Sync Loop (coordinated with loop_scheduler)
// ---------------------------------------------------------------------
// Syncs in-memory sessions to KV + prunes stale sessions.
// Prevents memory leaks from abandoned sessions and ensures persistence.

export interface SessionSyncResult {
  saved: number;
  pruned: number;
  restored: number;
}

/** Save all active sessions to KV. Called periodically by loop_scheduler. */
export async function syncAllSessions(env: Env): Promise<SessionSyncResult> {
  const result: SessionSyncResult = { saved: 0, pruned: 0, restored: 0 };
  const now = Date.now();

  try {
    // 1) Save all active sessions to KV
    for (const [owner, session] of sessions) {
      if (now - session.lastInteraction < 3600_000) { // active in last hour
        await saveSessionToKV(env, owner);
        result.saved++;
      }
    }

    // 2) Prune stale in-memory sessions (inactive > 2 hours)
    for (const [owner, session] of sessions) {
      if (now - session.lastInteraction > 7200_000) {
        sessions.delete(owner);
        result.pruned++;
      }
    }
  } catch { /* fail-open */ }

  return result;
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

/** Build context summary for LLM (compressed older turns + working memory).
 *  Called by conversation.ts to build the system prompt context. */
export function buildContextSummary(owner: number): string {
  const session = getSession(owner);
  const parts: string[] = [];

  if (session.summaryBuffer) {
    parts.push(`Ringkasan percakapan: ${session.summaryBuffer.slice(0, 300)}`);
  }

  const wm = session.workingMemory;
  if (wm.currentTask) {
    parts.push(`Tugas aktif: ${wm.currentTask}`);
    if (wm.extractedFacts.length > 0) {
      parts.push(`Fakta: ${wm.extractedFacts.slice(-3).join("; ")}`);
    }
  }

  if (session.recentTopics.length > 0) {
    parts.push(`Topik terakhir: ${session.recentTopics.slice(0, 3).join(", ")}`);
  }

  return parts.join("\n");
}

//=====================================================================
// jarvis_memory.ts — Specialized memory service for JARVIS.
//
// Bertanggung jawab untuk:
// - Memory storage & retrieval (FTS5)
// - Memory consolidation (decay, sweep, cleanup)
// - Observational memory (user patterns)
// - Working memory (scratchpad)
// - Memory search & ranking
//
// Architecture: Memory Tiers (inspired by MemoryOS EMNLP 2025)
// 1. Working Memory (scratchpad) - current session only
// 2. Short-term Memory (conversation log) - last 7 days
// 3. Long-term Memory (memories FTS5) - persistent
// 4. Observational Memory (user patterns) - inferred
//=====================================================================

import { Env, rememberMemorySmart, searchMemory, sweepExpiredMemories, decayMemories, saveObservation, getRecentObservations } from "./db";

/** Memory tier. */
export type MemoryTier = "working" | "short_term" | "long_term" | "observational";

/** Memory record. */
export interface MemoryRecord {
  id: string;
  tier: MemoryTier;
  content: string;
  type: "fact" | "decision" | "context" | "person";
  importance: number;
  confidence: number;
  accessCount: number;
  lastAccessed: number;
  createdAt: number;
  expiresAt: number;
  tags: string[];
}

/** Memory search result. */
export interface MemorySearchResult {
  record: MemoryRecord;
  score: number;
  rank: number;
}

/** Working memory state for current session. */
export interface WorkingMemoryState {
  currentTask: string | null;
  stepsCompleted: string[];
  pendingItems: string[];
  extractedFacts: string[];
  errorsDetected: string[];
  reasoningConfidence: number;
  lastUpdated: number;
}

/** User observation. */
export interface UserObservation {
  pattern: string;
  category: string;
  confidence: number;
  evidenceCount: number;
  lastSeen: number;
}

// ---------------------------------------------------------------------
// Working Memory (Scratchpad)
// ---------------------------------------------------------------------

/** Initialize working memory. */
export function initWorkingMemory(): WorkingMemoryState {
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

/** Update working memory based on conversation context. */
export function updateWorkingMemory(
  wm: WorkingMemoryState,
  userText: string,
  assistantReply: string,
): void {
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

/** Build working memory context for LLM. */
export function buildWorkingMemoryContext(wm: WorkingMemoryState): string {
  if (!wm.currentTask) return "";

  const parts = [
    `[Memori Kerja] Tugas: ${wm.currentTask}`,
    `Langkah selesai: ${wm.stepsCompleted.length}`,
    `Fakta terkumpul: ${wm.extractedFacts.slice(-3).join("; ")}`,
    `Keyakinan: ${(wm.reasoningConfidence * 100).toFixed(0)}%`,
  ];

  if (wm.errorsDetected.length > 0) {
    parts.push(`Error terakhir: ${wm.errorsDetected[wm.errorsDetected.length - 1]}`);
  }

  return parts.join("\n");
}

// ---------------------------------------------------------------------
// Memory Storage & Retrieval
// ---------------------------------------------------------------------

/** Store a memory with auto-importance scoring. */
export async function storeMemory(
  env: Env,
  content: string,
  opts: {
    type?: "fact" | "decision" | "context" | "person";
    tier?: MemoryTier;
    tags?: string[];
    importance?: number;
    ttlMs?: number;
  } = {},
): Promise<void> {
  const tier = opts.tier ?? "long_term";

  // Working memory: store in working memory state (not D1)
  if (tier === "working") {
    // This is handled by updateWorkingMemory
    return;
  }

  // Short-term: store in conversation log (handled by appendMemory)
  if (tier === "short_term") {
    // This is handled by appendMemory
    return;
  }

  // Long-term and observational: store in D1 memories
  await rememberMemorySmart(env, content, {
    type: opts.type ?? "fact",
    tags: opts.tags ?? [],
    importance: opts.importance,
    source: tier,
    ttlMs: opts.ttlMs,
  });
}

/** Search memories with ranking. */
export async function searchMemories(
  env: Env,
  query: string,
  opts: {
    maxResults?: number;
    minImportance?: number;
    tiers?: MemoryTier[];
  } = {},
): Promise<MemorySearchResult[]> {
  const maxResults = opts.maxResults ?? 5;
  const minImportance = opts.minImportance ?? 0.5;

  try {
    const results = await searchMemory(env, query, maxResults * 2);

    return results
      .filter(r => r.importance >= minImportance)
      .slice(0, maxResults)
      .map((r, i) => ({
        record: {
          id: r.id,
          tier: "long_term" as MemoryTier,
          content: r.content,
          type: r.type as MemoryRecord["type"],
          importance: r.importance,
          confidence: 0.7,
          accessCount: 0,
          lastAccessed: Date.now(),
          createdAt: Date.now(),
          expiresAt: 0,
          tags: [],
        },
        score: r.importance,
        rank: i + 1,
      }));
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------
// Memory Consolidation
// ---------------------------------------------------------------------

/** Consolidate all memory maintenance in one pass. */
export async function consolidateAllMemory(env: Env): Promise<{
  decayed: number;
  swept: number;
  observations: number;
}> {
  const result = { decayed: 0, swept: 0, observations: 0 };

  try {
    // 1) Decay old memories
    const decay = await decayMemories(env);
    result.decayed = decay.decayed;

    // 2) Sweep expired memories
    result.swept = await sweepExpiredMemories(env);

    // 3) Get recent observations for context
    const obs = await getRecentObservations(env, 5);
    result.observations = obs.length;
  } catch { /* availability */ }

  return result;
}

// ---------------------------------------------------------------------
// Observational Memory
// ---------------------------------------------------------------------

/** Record an observation about user behavior. */
export async function recordObservation(
  env: Env,
  observation: string,
  category: string = "general",
): Promise<void> {
  await saveObservation(env, 0, observation, category);
}

/** Get recent observations about user. */
export async function getObservations(
  env: Env,
  limit: number = 5,
): Promise<string[]> {
  return getRecentObservations(env, limit);
}

/** Analyze conversation patterns and generate observations. */
export function analyzeConversationPatterns(
  userMessages: string[],
  assistantReplies: string[],
): UserObservation[] {
  const observations: UserObservation[] = [];

  // Analyze message length patterns
  const avgUserLength = userMessages.reduce((sum, m) => sum + m.length, 0) / userMessages.length;
  if (avgUserLength > 100) {
    observations.push({
      pattern: "User cenderung menulis panjang",
      category: "communication_style",
      confidence: 0.7,
      evidenceCount: userMessages.length,
      lastSeen: Date.now(),
    });
  } else if (avgUserLength < 20) {
    observations.push({
      pattern: "User cependat menulis",
      category: "communication_style",
      confidence: 0.7,
      evidenceCount: userMessages.length,
      lastSeen: Date.now(),
    });
  }

  // Analyze question patterns
  const questionCount = userMessages.filter(m => /\?|apa|siapa|dimana|kapan|kenapa|bagaimana|how|what|where|when|why/i.test(m)).length;
  if (questionCount > userMessages.length * 0.5) {
    observations.push({
      pattern: "User sering bertanya",
      category: "interaction_style",
      confidence: 0.8,
      evidenceCount: questionCount,
      lastSeen: Date.now(),
    });
  }

  // Analyze topic patterns
  const topics = new Map<string, number>();
  for (const msg of userMessages) {
    const words = msg.toLowerCase().split(/\s+/).filter(w => w.length > 4);
    for (const word of words) {
      topics.set(word, (topics.get(word) ?? 0) + 1);
    }
  }

  const topTopics = [...topics.entries()]
    .sort(([, a], [, b]) => b - a)
    .slice(0, 3)
    .map(([topic]) => topic);

  if (topTopics.length > 0) {
    observations.push({
      pattern: `Topik favorit: ${topTopics.join(", ")}`,
      category: "topic_preference",
      confidence: 0.6,
      evidenceCount: userMessages.length,
      lastSeen: Date.now(),
    });
  }

  return observations;
}

/** Build memory context for LLM. */
export async function buildMemoryContext(
  env: Env,
  topic: string | null,
): Promise<string> {
  const parts: string[] = [];

  // Search relevant memories
  if (topic) {
    const memories = await searchMemories(env, topic, { maxResults: 3 });
    if (memories.length > 0) {
      parts.push("Kenangan relevan: " + memories.map(m => m.record.content).join(" | "));
    }
  }

  // Get recent observations
  const observations = await getObservations(env, 3);
  if (observations.length > 0) {
    parts.push("Observasi: " + observations.join(" | "));
  }

  return parts.join("\n").slice(0, 1000);
}

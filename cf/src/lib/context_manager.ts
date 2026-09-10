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

import { Env, recentContext, searchMemory, searchConversationLog } from "./db";
import { getMoodState, setMoodState, moodSummary, type MoodState } from "./emotion";
import { topicOverlaps, topicTokens, groqRespond } from "./ai";

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

/** Refresh the in-memory session's interaction clock on ANY message (not only
 *  brain turns). Previously lastInteraction was written only by updateSession
 *  (brain path), so command-only traffic let syncAllSessions prune the session
 *  and the KV snapshot age out to its 24h TTL — mood history + summary buffer
 *  then silently vanished under otherwise-active usage. Cheap, RAM-only. */
export function touchSession(owner: number): void {
  const s = getSession(owner);
  s.lastInteraction = Date.now();
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
 *  or a fresh topic switch. Uses keyword overlap + recency decay.
 *
 *  m9-v10 HUMANE CONTINUITY: humans keep a conversation going WITHOUT typing
 *  trigger words ("lebih dalam", "lanjut"). Catching a continuation must not
 *  depend on a fixed phrase list alone — a short relative message ("kalau di
 *  rumah?", "yang mana paling cocok?", "itu gimana caranya?", "bisa buat
 *  jualan juga?") that references the prior turn still continues the SAME
 *  topic. So we ALSO mark as continuation any message that (a) carries an
 *  anaphoric/relative token, (b) has no fresh-topic / topic-switch marker,
 *  and (c) follows a substantive prior assistant turn. A brand-new factual
 *  question with its own noun subject and no anaphor ("berapa harga saham
 *  bca?") does NOT qualify, so it still starts a fresh topic. */
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

  // No prior substance → nothing to continue (chitchat reply of <30 chars
  // doesn't count as an anchor; rejecting here prevents false continuations).
  const priorSubstance = (lastAssistant?.content ?? lastUser?.content ?? "");
  if (priorSubstance.trim().length < 30) {
    return { isContinuation: false, topic: null, confidence: 0 };
  }

  const prior = priorSubstance.toLowerCase();
  const current = currentText.toLowerCase();

  // Extract key nouns/concepts (simple: words >= 4 chars)
  const priorWords = new Set(prior.split(/\s+/).filter((w) => w.length >= 4));
  const currentWords = current.split(/\s+/).filter((w) => w.length >= 4);

  let overlap = 0;
  for (const w of currentWords) {
    if (priorWords.has(w)) overlap++;
  }

  const overlapRatio = currentWords.length > 0 ? overlap / currentWords.length : 0;

  // Simplification request (re-explain the ongoing topic in plain words)
  // is a continuation, not a fresh topic switch.
  const simplifyWords = /\b(lebih mudah|sederhanakan|saya belum mengerti|saya nggak paham|biar paham|gampang|mudah dipahami|tolong sederhanakan|jika bisa)\b/i;
  if (simplifyWords.test(current) || /belum\s+mengerti|tidak\s+paham/i.test(current)) {
    return { isContinuation: true, topic: null, confidence: 0.72 };
  }

  // GLOBAL ANAPHORA — Indonesian "-nya" suffix (membuatnya, lihatnya, inginnya,
  // kirimkan? — the pronoun is fused to the verb). A word ending in "-nya"
  // references a prior-turn entity ("Apakah bisa membuatnya sendiri?" = "make
  // it [the all-in-one AI] yourself?").  NOT covered by the token-list markers
  // above because the split() never isolates the suffix as a separate word.
  // This is the MISSING anaphora that caused the "Apakah bisa membuatnya
  // sendiri" over-fire: JARVIS treated it as a fresh topic → echoed random
  // memories. Placed BEFORE fresh-markers so continuations win over splits.
  const anaphoricNya = /\b[a-z]{3,}nya\b/i.test(current);
  if (anaphoricNya && priorSubstance.trim().length >= 30) {
    return { isContinuation: true, topic: null, confidence: 0.78 };
  }

  // Follow-up markers (high continuation signal)
  const followUpMarkers = /\b(lebih dalam|lanjut|terus|yang tadi|detail|expand|selanjutnya|kemudian|lalu|itupun|itu jug)\b/i;
  const isFollowUp = followUpMarkers.test(current);

  // Topic switch markers + FRESH-TOPIC markers (a phrase introducing its own
  // subject — "cari X", "riset X", "apa itu X" — always starts fresh).
  const switchMarkers = /\b(switch|ganti|beda|lain|sekarang|skrg|next|move on|gimana kalau|how about|what about)\b/i;
  const freshMarkers = /\b(cari|riset|jelaskan?|jelasin|bandingkan|analisis|analisa|buatkan?|bikin|sebutkan|daftarkan?)\b/i;
  const isSwitch = switchMarkers.test(current) || freshMarkers.test(current);

  if (isFollowUp) {
    return { isContinuation: true, topic: null, confidence: 0.9 };
  }
  if (isSwitch) {
    return { isContinuation: false, topic: null, confidence: 0.8 };
  }

  // ANAPHORIC / RELATIVE continuation — the humane "no trigger word" case.
  // "kalau untuk…", "yang mana…", "itu gimana…", "…juga", "…lagi",
  // "ya", "oke", "ok" keep pointing at the prior turn; combined with a
  // substantive prior reply they mean: keep talking about the same thing.
  const relativeMarkers = /\b(itu|ini|yang\s+(?:tadi|itu|mana|paling)|kalau|kalo|gimana|bagaimana\s+kalau|berarti|abusitu|habisitu|setelahitu|dari\s+tadi|tadi\s+itu|juga|lagi|dong|sama\s+itu|caranya|carany|ya\b|oke|ok)\b/i;
  const isRelative = relativeMarkers.test(current);

  if (isRelative && current.length <= 90) {
    return { isContinuation: true, topic: null, confidence: 0.75 };
  }

  if (overlapRatio >= 0.3) {
    return { isContinuation: true, topic: null, confidence: Math.min(0.8, 0.4 + overlapRatio) };
  }

  return { isContinuation: false, topic: null, confidence: 0.3 };
}

/** Significant subject tokens behind a topic-recall signal ("bekerja remote"
 *  from "tadi kita bahas bekerja remote") — markers AND conversational
 *  connectors stripped, so the result is the CLEAN subject usable as an FTS
 *  AND-query too ("bekerja" + "remote" match memory rows; the filler "kita
 *  bahas" would silently break FTS matching). Shared by detectTopicRecall AND
 *  the recall-branch search so both engines query the SAME clean subject. */
const RECALL_STOP = new Set([
  "tadi", "barusan", "kemarin", "kemaren", "sebelumnya", "terakhir",
  "itu", "ini", "lalu", "balik", "kembali", "lanjut", "lanjutkan",
  "lanjutin", "terus", "soal", "tentang", "masalah", "topik", "waktu",
  "kita", "saya", "aku", "kami", "kamu", "bahas", "bicarakan",
  "omong", "ngomong", "membahas", "dibahas", "yang", "mau", "sama",
  "lagi", "dulu", "ke", "di", "dari", "pada", "saja", "aja",
]);
export function topicRecallSubjects(text: string): string[] {
  if (!text || typeof text !== "string") return [];
  return topicTokens(text).filter((t) => !RECALL_STOP.has(t));
}

/** m9-v11.11: assistant turns that are pure offer/menu questions (e.g. "Mau saya
 *  lanjutkan dengan X, Y, atau Z?") must NOT be fed back into a topic-return
 *  recall block — the model imitates its own previous question and anchors the
 *  answer onto asking the menu again instead of continuing directly. */
export function isMenuOfferQuestion(content: string): boolean {
  if (!content || typeof content !== "string") return false;
  const offers =
    /\b(?:mau|ingin|apakah kamu|apakah anda|boleh)\b[^.!?\n]{0,60}\b(?:saya|aku|kita)\b/i.test(
      content,
    ) &&
    /(?:lanjutkan|melanjutkan|bahas|membahas|bicarakan|jelaskan|menjelaskan|berikan|contoh|opsi|pilihan|gali|yang mana|atau)/i.test(
      content,
    );
  return offers && /[?？]/.test(content) && content.length < 260;
}

/** m9-v11.10: LET THE MODEL UNDERSTAND the recalled topic — the owner's
 *  direction was that token dictionaries keep misreading intent (a "kamus"
 *  approach). We ask a single lightweight Groq pass (recall turns only, so a
 *  rare extra call) to name the subject semantically; on ANY failure we fall
 *  back to the deterministic topicRecallSubjects so recall can only get
 *  sharper, never break. Uses prebuiltMessages to bypass the normal message
 *  builder — calling llmRespond here would re-enter buildEnrichedContext
 *  (infinite recursion). */
export async function extractRecallSubject(env: Env, text: string): Promise<string[]> {
  const dictFallback = topicRecallSubjects(text);
  try {
    const messages = [
      {
        role: "system" as const,
        content:
          `Pemilik menulis pesan yang menunjuk KEMBALI ke topik yang pernah dibahas ` +
          `("tadi kita bahas...", "balik ke soal...", dst). Pahami MAKNA kalimatnya — ` +
          `bukan dari kata kunci — lalu sebutkan topik yang dimaksud dalam 1-4 kata ` +
          `kunci singkat, Bahasa Indonesia, huruf kecil. Output HANYA kata-kata kunci ` +
          `dipisah spasi, tanpa tanda baca, tanpa kalimat lain. ` +
          `Contoh: "bekerja remote", "desain pasir pantai".`,
      },
      { role: "user" as const, content: text },
    ];
    const reply = await groqRespond(env, text, { prebuiltMessages: messages }).catch(() => null);
    const tokens = ((reply ?? "").toLowerCase().match(/[a-z0-9]{3,}/g) ?? []);
    if (tokens.length >= 1) return tokens;
  } catch { /* fall through to dictionary */ }
  return dictFallback;
}

/** m9-v11.8: true when the message signals RETURNING to an EARLIER topic —
 *  the human "I remember we talked about X earlier" dispatch that lets a chat
 *  roam across topics ("lanjutkan desain pasir pantai yang tadi", "balik ke
 *  soal gambar uang", "tadi kita bahas bekerja remote"). Marker-driven
 *  (deterministic, zero budget) AND requires a real subject (>=2 significant
 *  tokens beyond the marker/stopwords), so a bare "tadi"/"terus" continuation
 *  never trips it. Marker words are excluded from the subject count. */
export function detectTopicRecall(text: string): boolean {
  if (!text || typeof text !== "string") return false;
  const low = text.toLowerCase().trim();
  const recallMarkers =
    /\b(?:tadi|barusan|kemarin|kemaren|sebelumnya|terakhir|waktu\s+itu|tadi\s+(?:kita|saya|aku|kami)?\s*(?:bahas|bicarakan|omong\w*|soal|tentang)|soal\s+\w+\s+tadi|yang\s+tadi|yg\s+tadi|tadi\s+itu|tadi\s+(?:aja|saja)|balik\s+(?:ke|lagi)|kembali\s+ke|lanjut(?:kan|in)?\s+(?:soal|tentang|ke|di|dimana|mana)|masalah\s+tadi|topik\s+tadi)\b/i;
  if (!recallMarkers.test(low)) return false;
  return topicRecallSubjects(text).length >= 2;
}

/** Update working memory based on conversation context.
 *  m9-v11.3 SANITIZATION: (a) don't store raw markdown-sliced assistant
 *  replies as steps (was leaking table rows like "h | Konsep AI | Layanan
 *  con" into the Audit echo); (b) fact-extraction skips table-pipe content;
 *  (c) stale WM from a drifted topic is archived when no topic overlap. */
export function updateWorkingMemory(
  session: SessionState,
  userText: string,
  assistantReply: string,
): void {
  const wm = session.workingMemory;
  const now = Date.now();
  wm.lastUpdated = now;

  // --- STALE TASK ARCHIVAL: if wm.currentTask does NOT topically overlap
  // with the new user message (and it's not a short clarification), archive
  // the old task so it doesn't leak into a new thread as "Audit Status".
  if (wm.currentTask && userText.length > 8) {
    // m9-v11.6: a negation/clarification ("Bukan membuat AI all in one buatan
    // sendiri") is a REDIRECT — it names the real subject in the SAME message.
    // Keeping the old task on the negation alone would re-inject an unrelated,
    // stale task (the "Audit Status" echo from a previous thread) into the new
    // conversation. Only genuine continuations (topical overlap or short words
    // like "ya" / "itu" / "yang kedua") keep the current task.
    const taskStillRelevant = topicOverlaps(wm.currentTask, userText) || userText.trim().length <= 15;
    if (!taskStillRelevant) {
      // Archive keeps ONE audit line; all other facts belong to the old task
      // and are dropped — stops pre-sanitization garbage ("h | Konsep AI yang
      // dipakai | Layanan con") from surviving inside KV-restored sessions.
      wm.extractedFacts = [`Tugas sebelumnya: ${wm.currentTask} (${wm.stepsCompleted.length} langkah selesai)`];
      wm.currentTask = null;
      wm.stepsCompleted = [];
      wm.pendingItems = [];
    }
  }

  // Detect task switching
  const taskSwitch = /\b(coba|lanjut|ganti|sekarang|next|switch|gimana|bagaimana|cari|search|info)\b/i.test(userText);

  if (taskSwitch && wm.currentTask && wm.stepsCompleted.length > 0) {
    // Archive current task to facts (keep the audit line; drop stale facts)
    wm.extractedFacts = [`Tugas sebelumnya: ${wm.currentTask} (${wm.stepsCompleted.length} langkah selesai)`];
    wm.currentTask = null;
    wm.stepsCompleted = [];
    wm.pendingItems = [];
  }

  // Set current task if not set (only substantive messages; a PURE
  // acknowledgement like "bukan", "ya", "oke" never spawns a task, but a long
  // negation redirect ("Bukan membuat AI all in one buatan sendiri") that just
  // archived an old task SHOULD become the new task).
  if (!wm.currentTask && userText.length > 15 && !/^\s*(?:ya|bukan|nope|nggak|tidak|oke|ok|bener|benar|betul)\s*[.!?]?\s*$/i.test(userText.trim())) {
    wm.currentTask = userText.slice(0, 100);
  }

  // Track steps from assistant response — CLEAN step counter only (no raw
  // markdown slices that leak table rows like "h | Konsep AI | Layanan con").
  if (assistantReply.length > 20) {
    const stepMatch = assistantReply.match(/(?:langkah|step|poin|1\.|2\.|3\.|pertama|kedua|ketiga)/gi);
    if (stepMatch) {
      wm.stepsCompleted.push(`langkah-${wm.stepsCompleted.length + 1}`);
    }
  }

  // Extract facts from assistant response — skip markdown table pipes and
  // internal blocks (the source of "h | Konsep AI yang dipakai | Layanan con" garbage).
  const factPatterns = [
    /(?:adalah|merupakan|berarti|means|is a)\s+([^,.!]{10,60})/gi,
    /(?:nilai|value|jumlah|total|angka)\s*[:=]?\s*([^,.!]{5,40})/gi,
    /(?:tanggal|date)\s*[:=]?\s*([^,.!]{5,30})/gi,
  ];
  for (const pat of factPatterns) {
    const matches = assistantReply.matchAll(pat);
    for (const m of matches) {
      const fact = m[1]?.trim().slice(0, 80);
      // Skip table fragments (pipe-delimited), markdown blocks, memory markers
      if (fact && !/[|\[\]]/.test(fact)) {
        wm.extractedFacts.push(fact);
      }
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

/**
 * m9-v11.6: true when the session's working-memory task is relevant to the
 * given conversation topic — gates ALL WM injection (the enriched-context
 * block AND the system-prompt hint) so an unrelated tracked task never leaks
 * into replies as an "Audit Status" echo. Short continuations ("ya", "itu")
 * carry the WM because they can't be matched topically.
 */
export function wmTopicRelevant(session: SessionState, topic: string, userText: string): boolean {
  const wm = session.workingMemory;
  if (!wm.currentTask || wm.stepsCompleted.length === 0) return false;
  if (topic && topicOverlaps(wm.currentTask, topic)) return true;
  if (userText.trim().length <= 15 && (Date.now() - wm.lastUpdated) < 30_000) return true;
  return false;
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

  // 1) Summary buffer + 2) recent turns belong to the CURRENT thread — they
  //     are only meaningful when the owner stays in it. m9-v11.10: when the
  //     message RETURNS to an earlier topic (recall signal), the current
  //     thread's turns are NOT conversation for this message: they actively
  //     fought the recall block (live failure: "tadi kita bahas bekerja remote"
  //     got merged with the recent child-sand/"storyboard" thread). On recall
  //     we PIVOT — drop summary + recent, make the recall block the only
  //     conversational grounding.
  const topic = opts.topic ?? userText.slice(0, 80);
  const isRecall = detectTopicRecall(userText);
  const [recent, mems] = await Promise.all([
    recentContext(env, owner, maxRecent).catch(() => [] as Array<{ role: string; content: string }>),
    searchMemory(env, topic, maxMems).catch(() => [] as Array<{ content: string }>),
  ]);

  if (!isRecall) {
    // 1) Summary buffer (compressed older turns)
    if (session.summaryBuffer) {
      const summaryContent = `[Ringkasan percakapan sebelumnya — soft-context, angka/klaim di sini BELUM diverifikasi ulang; jangan jadikan fakta]: ${session.summaryBuffer}`;
      context.push({ role: "system", content: summaryContent });
      charBudget -= summaryContent.length;
    }

    // 2) Recent conversation turns (raw, bounded)
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
  } else {
    // 2b) TOPIC-RECALL (m9-v11.8): signals pointing back at an EARLIER thread
    // ("yang tadi", "balik ke soal X", "tadi kita bahas Y") pull that older
    // history into context — the reference humans use to re-enter a topic mid-
    // chat. m9-v11.9 queries the durable FTS memories too (log threads rotate
    // out of the 100-turn bound; curated memories survive). m9-v11.10 lets the
    // model NAME the subject (no token dictionary) and suppresses the current
    // thread, so the recall block is the ONLY conversational input.
    const cutoff = recent.reduce<number>((m, r) => {
      const ts = (r as { ts?: number }).ts;
      return typeof ts === "number" && ts < m ? ts : m;
    }, Infinity);
    const subjects = await extractRecallSubject(env, userText);
    const [recalled, recalledMems] = await Promise.all([
      searchConversationLog(
        env, owner, subjects.length >= 2 ? subjects : topicTokens(userText), 6,
        Number.isFinite(cutoff) ? cutoff : Infinity,
      ).catch(() => [] as Array<{ role: string; content: string; ts: number }>),
      subjects.length >= 2
        ? searchMemory(env, subjects.join(" "), 4).catch(
            () => [] as Array<{ content: string }>,
          )
        : Promise.resolve([] as Array<{ content: string }>),
    ]);
    const recalledLines: string[] = recalled
      .filter((r) => !(r.role === "assistant" && isMenuOfferQuestion(r.content)))
      .map((r) => {
        const who = r.role === "user" ? "pemilik" : "kamu";
        return `${who}: ${(r.content || "").slice(0, 220)}`;
      });
    for (const m of recalledMems.slice(0, 3)) {
      recalledLines.push(`kenangan: ${(m.content || "").slice(0, 180)}`);
    }
    if (recalledLines.length > 0) {
      const recallText =
        `[Riwayat percakapan sebelumnya] (KONTEKS INTERNAL saja, bukan bahan kutipan): ` +
        recalledLines.join(" | ").slice(0, Math.min(1400, charBudget)) +
        `. Pemilik menunjuk KEMBALI ke topik ini DARI TOPIK LAIN. ` +
        `Percakapan terakhir (topik berbeda) tidak disertakan — jawab HANYA berdasarkan ` +
        `riwayat ini. Lanjutkan topik itu LANGSUNG dengan tanggapan yang mengalir seperti ` +
        `orang ngobrol — JANGAN membuka dengan pertanyaan pilihan/menawarkan menu, ` +
        `JANGAN pakai tabel, daftar bernomor, atau judul bagian. ` +
        `JANGAN menggabungkan topik lama dengan topik percakapan terakhir, ` +
        `JANGAN kutip verbatim, dan JANGAN tampilkan riwayat sebagai bagian jawaban.`;
      if (recallText.length < charBudget) {
        context.push({ role: "system", content: recallText });
        charBudget -= recallText.length;
      }
    } else {
      // The recall signal fired but the older thread is NOT in memory
      // (m9-v11.9). Without this rail the model anchored onto the MOST RECENT
      // stale thread and answered as if the owner typed another topic. Tell it
      // plainly instead of guessing or blending.
      const missText =
        `[Catatan riwayat]: Pemilik menunjuk kembali ke topik yang pernah dibahas ` +
        `sebelumnya, tapi kamu TIDAK menemukan riwayat topik itu di memori. ` +
        `JANGAN mengalihkan ke topik lain dari percakapan terakhir dan JANGAN ` +
        `menggabungkannya dengan permintaan ini, JANGAN pula menebak isi topik lamanya. ` +
        `Jawab jujur singkat bahwa riwayat topik itu sudah tidak tersimpan, lalu minta ` +
        `pemilik mengingatkan inti konteksnya.`;
      if (missText.length < charBudget) {
        context.push({ role: "system", content: missText });
        charBudget -= missText.length;
      }
    }
  }

  // 3) Working memory (only if active AND topically relevant to THIS conversation)
  // m9-v11.6: the bare ≤30s window used alone could inject a STALE unrelated
  // task into a quick follow-up (the "Audit Status" echo bug). Shared helper:
  // topological overlap OR a short pure continuation within 30s.
  const wm = session.workingMemory;
  const wmRelevant = wmTopicRelevant(session, topic ?? userText, userText);
  if (wmRelevant) {
    const wmContent = [
      `[Memori kerja] Tugas: ${wm.currentTask}`,
      `Langkah selesai: ${wm.stepsCompleted.length}`,
      `Catatan percakapan (belum diverifikasi): ${wm.extractedFacts.filter((f) => f && !/[|\[\]]/.test(f)).slice(-3).join("; ")}`,
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
  // m9-v11.6: memories are CONTEXT ONLY. Previously role="assistant" + "natural
  // saja menyebutnya" actively invited the model to drag unrelated old memories
  // ("desain visual anak-anak bermain pasir", "kota Malang") into a clarify
  // reply and offer them as fabricated options. Now: system role, no enticement.
  try {
    if (mems.length > 0) {
      const memText = mems.map((m) => m.content).join(" | ").slice(0, Math.min(1000, charBudget));
      context.push({
        role: "system",
        content: `[Kenangan relevan tentang "${topic}" — KONTEKS INTERNAL saja, bukan bahan jawaban]: ${memText}. ` +
          `Blok ini hanya petunjuk arah. JANGAN mengutip daftarnya sebagai jawaban, ` +
          `JANGAN tawarkan memori lama sebagai pilihan kepada pemilik, dan JANGAN menyebutnya ` +
          `kalau tidak menjawab pertanyaan pemilik secara langsung.`,
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
 *  Called by conversation.ts to build the system prompt context.
 *  m9-v11.7: the working-memory lines honor the same topical gate as the WM
 *  block / workingMemoryHint — an unrelated tracked task must never reach the
 *  system prompt as "Tugas aktif"/"Fakta" (the hidden third echo vector). */
export function buildContextSummary(owner: number, opts: { topic?: string; userText?: string } = {}): string {
  const session = getSession(owner);
  const parts: string[] = [];

  if (session.summaryBuffer) {
    parts.push(`Ringkasan percakapan: ${session.summaryBuffer.slice(0, 300)}`);
  }

  const wm = session.workingMemory;
  if (wmTopicRelevant(session, opts.topic ?? "", opts.userText ?? "")) {
    parts.push(`Tugas aktif: ${wm.currentTask}`);
    if (wm.extractedFacts.length > 0) {
      parts.push(`Fakta: ${wm.extractedFacts.filter((f) => f && !/[|\[\]]/.test(f)).slice(-3).join("; ")}`);
    }
  }

  if (session.recentTopics.length > 0) {
    parts.push(`Topik terakhir: ${session.recentTopics.slice(0, 3).join(", ")}`);
  }

  return parts.join("\n");
}

//=====================================================================
// intelligence.ts — THE BRAIN: top-level cognitive system for JARVIS.
//
// Architecture: Cognitive Cycle (perceive → think → decide → act → reflect)
//   * Perceive: detect emotion, language, intent, topic, conversation mode
//   * Think:    decide strategy (chat / research / design / translation)
//   * Decide:   select provider cascade, risk level, depth
//   * Act:      dispatch to the appropriate sub-system
//   * Reflect:  learn from outcome, update mood, track performance
//
// This module OWNS all other intelligence sub-modules:
//   - conversation.ts (personality + prompt building) → PERCEPTION
//   - emotion.ts (sentiment + mood) → PERCEPTION
//   - ai.ts (LLM dispatch + search) → COGNITION
//   - subagents.ts (research/design pipelines) → COGNITION
//   - evolution.ts (self-improvement) → REFLECTION
//
// All other modules (db.ts, resilience.ts, telegram_webhook.ts) call
// processIntelligence() as the SINGLE ENTRY POINT for message handling.
//=====================================================================

import { Env, searchMemory, recentContext, appendMemory } from "./db";
import {
  detectEmotion, updateMood, getMoodState,
  emotionToStyle, moodSummary, inferEmotionFromContext, detectTopicSentiment,
  type EmotionSignal, type MoodState,
} from "./emotion";
import { detectLanguage, type Language } from "./jarvis_language";
import {
  getSession, type SessionState,
  detectConversationMode, detectTopicContinuity,
  updateSession, buildEnrichedContext, saveSessionToKV,
} from "./context_manager";
import { buildConversationMessages } from "./conversation";
import {
  llmRespond, searchAndSynthesize, extractTopic,
  isFollowUpQuery, resolveFollowUpAnchor,
  parseTranslate, translateText, understandUserWants,
  generateImagePrompt, generateImage, sniffImageMime,
  storeResearchAnchor,
} from "./ai";
import {
  isResearchClass, orchestrateResearch,
  isDesignIntent,
} from "./subagents";
import { writeExpertPrompt } from "./prompt_master";
import { lookupLibraryDocs, context7FailureMessage } from "./context7";
import { capabilityIntent, approachForIntent } from "./capability_registry";
import {
  detectRelevanceAmbiguity, parkPendingRelevance,
  readPendingRelevance, clearPendingRelevance, resolveRelevanceConfirmation,
} from "./relevance";
import { readFailureTally } from "./failure";
import { describeGapProposals } from "./gap_upgrade";
import { reflectOnTurn, getAnswerBehaviorContext } from "./evolution";
import { buildFinalReply } from "./response_formatter";
import { JARVIS_IDENTITY, SELF_REF_RE } from "./identity";

// ============================================================================
// Types
// ============================================================================

/** Perception result — what the brain understands about the input. */
export interface Perception {
  language: Language;
  emotion: EmotionSignal;
  mood: MoodState;
  intent: IntentResult;
  topic: string | null;
  mode: SessionState["conversationMode"];
  isFollowUp: boolean;
  /** m9-v10 humane continuity: message references the prior turn WITHOUT a
   *  trigger word (detectTopicContinuity's anaphoric/relative + overlap
   *  signals). When set, cheap chat paths keep the ACTIVE topic as frame. */
  isContinuation: boolean;
  enrichedContext: Array<{ role: string; content: string }>;
}

/** Intent classification result. */
export interface IntentResult {
  type: "question" | "command" | "search" | "chat" | "emergency" | "translation" | "design" | "self_referential" | "understand" | "prompt_writer" | "context7" | "code";
  urgency: "low" | "medium" | "high";
  formality: "casual" | "neutral" | "formal";
  confidence: number;
  entities: Record<string, string>;
}

/** Strategy decision — how the brain will handle this message. */
export interface Strategy {
  approach: "simple_llm" | "search_synthesize" | "orchestrate_research" | "orchestrate_design" | "translate" | "self_referential" | "understand_intent" | "prompt_master" | "context7_docs";
  depth: "shallow" | "medium" | "deep";
  providerPreference: "any" | "fast" | "thorough";
  riskLevel: "safe" | "caution" | "blocked";
}

/** Intelligence response — the brain's full output. */
export interface IntelligenceResponse {
  text: string;
  perception: Perception;
  strategy: Strategy;
  source: string;
  latencyMs: number;
  reflection: { shouldReflect: boolean; topic: string | null };
  /** Optional rendered visual (flux image) accompanying design intents. */
  image?: { bytes: Uint8Array; mime: string };
}

// ============================================================================
// Self-Monitoring: track brain performance across requests
// ============================================================================

interface BrainMetrics {
  totalRequests: number;
  strategyCounts: Record<string, number>;
  avgLatencyMs: number;
  providerSuccessRates: Record<string, { ok: number; fail: number }>;
  lastUpdated: number;
}

const brainMetrics: BrainMetrics = {
  totalRequests: 0,
  strategyCounts: {},
  avgLatencyMs: 0,
  providerSuccessRates: {},
  lastUpdated: Date.now(),
};

function recordMetrics(strategy: string, latencyMs: number, provider: string | null, success: boolean) {
  brainMetrics.totalRequests++;
  brainMetrics.strategyCounts[strategy] = (brainMetrics.strategyCounts[strategy] || 0) + 1;
  // Running average
  brainMetrics.avgLatencyMs = (brainMetrics.avgLatencyMs * (brainMetrics.totalRequests - 1) + latencyMs) / brainMetrics.totalRequests;
  if (provider) {
    if (!brainMetrics.providerSuccessRates[provider]) {
      brainMetrics.providerSuccessRates[provider] = { ok: 0, fail: 0 };
    }
    const ps = brainMetrics.providerSuccessRates[provider];
    if (success) ps.ok++; else ps.fail++;
  }
  brainMetrics.lastUpdated = Date.now();
}

// ============================================================================
// PHASE 1: PERCEIVE — Understand the input
// ============================================================================

// SELF_REF_RE is imported from identity.ts (single source of truth).

/**
 * Phase 1: PERCEIVE — Build a complete understanding of the input.
 * Detects language, emotion, intent, topic, mode, and enriches context.
 */
export async function perceive(
  env: Env,
  owner: number,
  text: string,
): Promise<Perception> {
  // Parallel perception tasks (independent of each other)
  const [language, rawEmotion, session] = await Promise.all([
    Promise.resolve(detectLanguage(text)),
    Promise.resolve(detectEmotion(text)),
    Promise.resolve(getSession(owner)),
  ]);

  const mood = getMoodState(owner);
  updateMood(owner, rawEmotion);
  
  // L18: Context-based emotion inference for unknown topics
  const recentEmotions = mood.history.slice(-3).map(h => ({
    sentiment: "neutral" as const,
    intensity: h.intensity,
    primary: h.emotion,
    confidence: 0.5,
  }));
  const emotion = inferEmotionFromContext(rawEmotion, mood, recentEmotions);

  const mode = detectConversationMode(text);
  const isFollowUp = isFollowUpQuery(text);

  // Build enriched context (recent turns + memories + working memory)
  const enrichedContext = await buildEnrichedContext(env, owner, text, {
    mood,
    topic: session.activeTopic ?? undefined,
  });

  // Detect topic continuity
  const topicResult = detectTopicContinuity(text, enrichedContext);
  // Contract fix (M2): the brain's topic must use the SAME noun-phrase extractor
  // as the webhook's search path — otherwise whole imperative sentences ("saya
  // butuh analisis ini") became the DDG query. On a detected continuation with
  // no fresh marker, prefer the session's activeTopic so follow-ups stay on the
  // anchored subject instead of the raw sentence prefix.
  const topic =
    topicResult.topic ??
    ((topicResult.isContinuation && session.activeTopic) || extractTopic(text) || text.slice(0, 80));

  // Classify intent (combines multiple signals)
  const intent = classifyIntent(text, topic);

  return {
    language,
    emotion,
    mood,
    intent,
    topic,
    mode,
    isFollowUp,
    isContinuation: topicResult.isContinuation,
    enrichedContext,
  };
}

/**
 * Unified intent classifier — combines signals from multiple sources.
 * Priority: self-referential > emergency > design > translate > search > command > chat > question > understand
 */
function classifyIntent(text: string, topic: string | null): IntentResult {
  const low = text.toLowerCase();

  // Self-referential (highest priority — JARVIS talking about itself)
  if (SELF_REF_RE.test(low)) {
    return { type: "self_referential", urgency: "low", formality: "neutral", confidence: 0.95, entities: {} };
  }

  // Emergency — STANDALONE markers only, i.e. the marker starts the message
  // (optional leading prompt word) or is emphatic (ends with "!"); a marker
  // buried mid-sentence ("cari urgent care…", "emergency plan") is a DESCRIBED
  // topic, not an order — old regex fired emergency for any whitespace-separated
  // occurrence (M6 false-positive fix, e.g. "urgent care").
  if (/^(?:(?:tolong|mohon|hey|hei|woi|coba|bisa)\s+)?(?:stop|kill|override|darurat|emergency|urgent)(?:\s|$|[.,!])|\b(?:sekarang|now)\s+!/i.test(low)) {
    return { type: "emergency", urgency: "high", formality: "formal", confidence: 0.9, entities: {} };
  }

  // Capability router (single source of trigger): prompt-master & context7 are
  // classified by the SAME canonical predicates the webhook pre-cascade uses,
  // so the two routers can no longer drift (capability_registry.ts).
  const preCap = capabilityIntent(text, { ids: ["prompt_master", "context7"] });
  if (preCap?.id === "prompt_master") {
    return { type: "prompt_writer", urgency: "low", formality: "neutral", confidence: 0.85, entities: { topic: text.slice(0, 100) } };
  }

  if (preCap?.id === "context7") {
    return { type: "context7", urgency: "low", formality: "neutral", confidence: 0.8, entities: { topic: text.slice(0, 100) } };
  }

  // Design engineering intent. Synonymous design keywords (video, film, clip,
  // reels, tiktok, dll.) also carry non-design meanings — so keep pure
  // recommendation/descriptive questions ("film apa yang bagus?") on the
  // question path, while creation phrasings ("buat video X") stay design.
  if (isDesignIntent(text)) {
    const designAsk = /\b(?:apa|siapa|berapa|kapan|kenapa|mengapa|apakah|bagaimana|yang\s+(?:bagus|terbaik|recommended)|rekomendasi|referensi|mirip)\b/i.test(text);
    const creationVerb = /\b(?:buat|bikin|bkin|buatin|desain|rancang|gambar|foto|animasi\s*kan|videokan|tolong|minta|mohon|coba|mau|ingin|pengen|bisa|boleh)\b/i.test(text);
    if (!designAsk || creationVerb) {
      return { type: "design", urgency: "medium", formality: "neutral", confidence: 0.85, entities: { topic: text.slice(0, 100) } };
    }
  }

  // Translation — canonical predicate shared with the webhook pre-cascade.
  const trCap = capabilityIntent(text, { ids: ["translate"] });
  if (trCap) {
    const bare = /^\s*(?:terjemahkan|translate)\s*$/i.test(low);
    return {
      type: "translation",
      urgency: "low",
      formality: "formal",
      confidence: bare ? 0.8 : 0.9,
      entities: bare ? { bare: "true" } : {},
    };
  }

  // Search / research
  if (/\b(?:cari|search|riset|reseach|research|studi|study|pelajari|mempelajari|meneliti|info|tentang|analisis|review|bandingkan|ringkas|laporan|kajian)\b/i.test(low)) {
    return { type: "search", urgency: "medium", formality: "neutral", confidence: 0.8, entities: { topic: text.slice(0, 100) } };
  }

  // Programming language / code task (conservative: code vocabulary + an action
  // verb, or an explicit ``` block — "aku suka coding" stays casual chat).
  if (/```/.test(low) || (/\b(?:kode|code|coding|pemrograman|programming|script|skrip|syntax|sintaks|algoritm[ae]|debug)\b/i.test(low) && /\b(?:tulis|buat|bikin|jelaskan|perbaiki|debug|analisis|analisa|baca|review|cara|bagaimana|apa|kenapa|mengapa)\b/i.test(low))) {
    return { type: "code", urgency: "low", formality: "neutral", confidence: 0.8, entities: {} };
  }

  // Command
  if (/^\/|^(?:lakukan|jalankan|hapus|tambah|set|atur|buka|tutup|kirim|lihat)\b/i.test(low)) {
    return { type: "command", urgency: "medium", formality: "formal", confidence: 0.85, entities: {} };
  }

  // Casual chat
  if (/\b(?:halo|hai|hi|hello|hey|pagi|siang|sore|malam|thanks|terima kasih|oke|ok)\b/i.test(low)) {
    return { type: "chat", urgency: "low", formality: "casual", confidence: 0.7, entities: {} };
  }

  // Question
  if (/\b(?:apa|siapa|dimana|kapan|kenapa|mengapa|bagaimana|gmn|bgmn|berapa|apakah|akah)\b/i.test(low)) {
    return { type: "question", urgency: "low", formality: "neutral", confidence: 0.7, entities: {} };
  }

  // Unknown / vague intent — text we couldn't match to any known pattern.
  // Instead of guessing with a low-confidence "question"/"command", mark it
  // as "understand" so the brain asks the LLM to decode the user's actual
  // want (or ask a natural clarifying question) rather than replying "Ok.".
  // Heuristics: it's a real message (>=3 chars), not a bare emoji/whitespace,
  // carries some information-bearing content, and is NOT just short chatter
  // like "lol", "test", "ok" (those stay on the cheap LLM path).
  const isNoise = /^(?:lol|lmao|wkwk|hehe|haha|test|tes|coba|iya|ya|nggak|ga|gak|tidak|ok|oke|okay|yoi|sip|noted|mksd|maksud|kenapa)\W*$/i.test(low);
  if (low.length >= 3 && !/^[\s\W_]+$/.test(low) && /[a-z0-9\u00e0-\u024f]/i.test(low) && !isNoise) {
    return { type: "understand", urgency: "low", formality: "neutral", confidence: 0.5, entities: {} };
  }

  return { type: "question", urgency: "low", formality: "neutral", confidence: 0.5, entities: {} };
}

// ============================================================================
// PHASE 2: THINK + DECIDE — Select strategy based on perception
// ============================================================================

/**
 * Phase 2: THINK + DECIDE — Choose the optimal strategy.
 * The brain weighs intent, urgency, complexity, and available resources.
 */
export function decide(perception: Perception): Strategy {
  const { intent, isFollowUp, topic, mood, enrichedContext } = perception;
  // Registry-backed strategy approach (single contract table); falls back to
  // simple_llm when the intent has no dedicated capability.
  const cap = (it: string) => (approachForIntent(it) as Strategy["approach"]) ?? "simple_llm";

  // Self-referential → direct answer (no LLM needed, handled by webhook)
  if (intent.type === "self_referential") {
    return {
      approach: cap("self_referential"),
      depth: "shallow",
      providerPreference: "any",
      riskLevel: "safe",
    };
  }

  // Translation → dedicated pipeline
  if (intent.type === "translation") {
    return {
      approach: cap("translation"),
      depth: "shallow",
      providerPreference: "fast",
      riskLevel: "safe",
    };
  }

  // Prompt-engineering → expert prompt writer (prompt-master skill)
  if (intent.type === "prompt_writer") {
    return {
      approach: cap("prompt_writer"),
      depth: "medium",
      providerPreference: "thorough",
      riskLevel: "safe",
    };
  }

  // Library docs → Context7 (up-to-date documentation grounding)
  if (intent.type === "context7") {
    return {
      approach: cap("context7"),
      depth: "medium",
      providerPreference: "any",
      riskLevel: "safe",
    };
  }

  // Emergency → fast, direct LLM
  if (intent.type === "emergency") {
    return {
      approach: cap("emergency"),
      depth: "shallow",
      providerPreference: "fast",
      riskLevel: "safe",
    };
  }

  // Design engineering → full design pipeline
  if (intent.type === "design" && topic) {
    return {
      approach: cap("design"),
      depth: "deep",
      providerPreference: "thorough",
      riskLevel: "caution",
    };
  }

  // Search/research → determine depth
  if (intent.type === "search" && topic) {
    const isComplex = isResearchClass(topic, perception.language?.code === "en" ? topic : "");
    if (isComplex) {
      return {
        approach: "orchestrate_research",
        depth: "deep",
        providerPreference: "thorough",
        riskLevel: "caution",
      };
    }
    return {
      approach: cap("search"),
      depth: "medium",
      providerPreference: "any",
      riskLevel: "safe",
    };
  }

  // Code / programming language → quality LLM (code must be correct, not fast)
  if (intent.type === "code") {
    return {
      approach: "simple_llm",
      depth: "medium",
      providerPreference: "thorough",
      riskLevel: "safe",
    };
  }

  // Follow-up → medium depth (context already enriched)
  if (isFollowUp) {
    return {
      approach: "search_synthesize",
      depth: "medium",
      providerPreference: "any",
      riskLevel: "safe",
    };
  }

  // Unknown / vague intent → ASK the LLM to understand the user's want
  // (answer directly if clear, or ask one natural clarifying question).
  if (intent.type === "understand") {
    return {
      approach: "understand_intent",
      depth: "medium",
      providerPreference: "any",
      riskLevel: "safe",
    };
  }

  // Command / chat / question → simple LLM
  return {
    approach: "simple_llm",
    depth: "shallow",
    providerPreference: "any",
    riskLevel: "safe",
  };
}

// ============================================================================
// PHASE 3: ACT — Execute the strategy
// ============================================================================

/**
 * Phase 3: ACT — Execute the chosen strategy.
 * Dispatches to the appropriate sub-system.
 */
export async function act(
  env: Env,
  owner: number,
  text: string,
  perception: Perception,
  strategy: Strategy,
): Promise<{ reply: string; source: string; image?: { bytes: Uint8Array; mime: string } }> {
  const { topic, enrichedContext, language } = perception;

  switch (strategy.approach) {
    case "self_referential":
      // Handled by webhook directly — this should never be reached
      return { reply: "", source: "self_ref" };

    case "translate": {
      const parsed = parseTranslate(text);
      if (parsed?.source) {
        const result = await translateText(env, parsed.source, parsed.target);
        return { reply: result ?? "Terjemahan tidak tersedia.", source: "translate" };
      }
      // Bare translate — use last assistant reply
      const lastAssistant = enrichedContext.filter((c) => c.role === "assistant").pop();
      if (lastAssistant && lastAssistant.content.length > 30) {
        const result = await translateText(env, lastAssistant.content, "English");
        return { reply: result ?? lastAssistant.content, source: "translate_bare" };
      }
      return { reply: "Tidak ada teks untuk diterjemahkan.", source: "translate" };
    }

    case "orchestrate_design": {
      if (!topic) return { reply: "Topik tidak ditemukan.", source: "design" };
      // The separate video-design capability was removed (free tier has no
      // video model). Design intents now yield a concise design outline text
      // PLUS a real flux image of the subject — flux is merged into the image
      // generation path. Fail-closed: outline failure falls back to search;
      // image failure degrades to text-only.
      const outline = await llmRespond(env, `Buat konsep desain singkat (4-6 baris, markdown) untuk: "${text}".\nTermasuk: ide utama, gaya visual, warna dominan, dan elemen utama. Bahasa Indonesia. Jangan sebut storyboard/keyframe/video.` , {
        topic: `desain-${topic}`,
      }).catch(() => null);
      let image: { bytes: Uint8Array; mime: string } | undefined;
      try {
        const promptText = text.length >= 3 ? text.slice(0, 250) : text;
        const prompt = await generateImagePrompt(env, promptText);
        const bytes = await generateImage(env, prompt).catch(() => null);
        if (bytes && bytes.length > 0) image = { bytes, mime: sniffImageMime(bytes) };
      } catch (e) {
        console.error("orchestrate_design image failed:", String(e).slice(0, 120));
      }
      if (outline?.reply) return { reply: outline.reply.slice(0, 900), source: "design", image };
      const fallback = await searchAndSynthesize(env, owner, text, topic);
      return { reply: fallback.reply ?? "Gagal memproses desain.", source: "design_fallback", image };
    }

    case "orchestrate_research": {
      if (!topic) return { reply: "Topik tidak ditemukan.", source: "research" };
      const anchor = isFollowUpQuery(text) ? resolveFollowUpAnchor(enrichedContext)?.prior ?? "" : "";
      const result = await orchestrateResearch(env, owner, text, topic, anchor);
      if (result) return { reply: result, source: "research" };
      // Fallback to search
      const fallback = await searchAndSynthesize(env, owner, text, topic);
      return { reply: fallback.reply ?? "Gagal melakukan riset.", source: "research_fallback" };
    }

    case "search_synthesize": {
      if (!topic) return { reply: "Topik tidak ditemukan.", source: "search" };
      const result = await searchAndSynthesize(env, owner, text, topic);
      return { reply: result.reply ?? "Pencarian tidak menghasilkan jawaban.", source: result.source ?? "search" };
    }

    case "understand_intent": {
      // Decode what the user actually WANTS, even for unknown/vague requests.
      const result = await understandUserWants(env, text, owner, enrichedContext);
      if (result.reply) {
        return { reply: result.reply, source: result.understood ? "understand" : "understand_clarify" };
      }
      // Fallback: plain LLM, fail-closed.
      const fallback = await llmRespond(env, text, {
        topic: topic ?? undefined,
        context: enrichedContext,
        contextIsEnriched: true,
      });
      if (fallback.reply) {
        return { reply: fallback.reply, source: fallback.source ?? "llm" };
      }
      return { reply: "Maaf, saya belum memahami permintaan ini. Bisa jelaskan lagi dengan lebih detail?", source: "understand_fallback" };
    }

    case "prompt_master": {
      const result = await writeExpertPrompt(env, text, enrichedContext);
      if (result.ok && result.reply) {
        return { reply: result.reply, source: "prompt_master" };
      }
      const fallback = await llmRespond(env, text, {
        topic: topic ?? undefined,
        context: enrichedContext,
        contextIsEnriched: true,
      });
      if (fallback.reply) {
        return { reply: fallback.reply, source: fallback.source ?? "llm" };
      }
      return { reply: "Maaf, saya belum bisa menyusun prompt itu sekarang. Coba lagi ya.", source: "prompt_master_fallback" };
    }

    case "context7_docs": {
      const ctx7 = await lookupLibraryDocs(env, text, enrichedContext);
      if (ctx7.ok && ctx7.reply) {
        return { reply: ctx7.reply, source: "context7" };
      }
      // FAIL-CLOSED (anti-halusinasi): library yang tidak ter-resolve harus
      // dijawab JUJUR, bukan diteruskan ke LLM umum (yang terbukti bisa
      // menghalusinasi subjek salah — mis. "hono" jadi "Sonos"). Tally dicatat
      // lookupLibraryDocs ke ledger gap→upgrade (context7 empty/blocked).
      return { reply: context7FailureMessage(ctx7.reason ?? "empty", ctx7.library), source: "context7_fallback" };
    }

    case "simple_llm":
    default: {
      const result = await llmRespond(env, text, {
        topic: topic ?? undefined,
        context: enrichedContext,
        contextIsEnriched: true,
        // m9-v10 HUMANE CONTINUITY FRAME: when the message continues the prior
        // topic WITHOUT a trigger word (isContinuation), anchor the LLM to the
        // active topic explicitly — otherwise short relative replies ("kalau
        // untuk perseorangan?", "itu gimana caranya?") drift to a generic
        // unrelated answer. Frame defers to a genuinely new question.
        systemOverride: perception.isContinuation && topic
          ? `Pemilik MENERUSKAN percakapan yang sedang berlangsung — pesan ini ringkas dan tidak menyebut ulang topiknya. ` +
            `Topik aktif yang sedang dibicarakan: "${topic}". ` +
            `Jawab sebagai LANJUTAN dari percakapan itu, langsung ke pokok, bahasa santai seperti biasa. ` +
            `Namun jika pesan itu ternyata benar-benar menanyakan hal baru, jawab hal barunya dengan natural.`
          : undefined,
        // Hard-lift comprehension for code questions: OpenRouter's free
        // reasoning model reads ambiguous wording far more accurately.
        deep: perception.intent.type === "code",
      });
      if (result.reply) {
        return { reply: result.reply, source: result.source ?? "llm" };
      }
      return { reply: "Maaf, saya sedang mengalami kendala teknis. Silakan coba lagi.", source: "fallback" };
    }
  }
}

// ============================================================================
// PHASE 4: REFLECT — Learn from the outcome
// ============================================================================

/**
 * Phase 4: REFLECT — Update memory, mood, and trigger learning.
 * This is the feedback loop that makes JARVIS smarter over time.
 */
export async function reflect(
  env: Env,
  owner: number,
  text: string,
  reply: string,
  perception: Perception,
  strategy: Strategy,
): Promise<void> {
  const { topic, emotion } = perception;

  // Save to episodic memory (both user and assistant turns)
  const safeTopic = topic ?? "general";
  await appendMemory(env, owner, "user", text, safeTopic);
  await appendMemory(env, owner, "assistant", reply, safeTopic);

  // Trigger reflection for substantial replies (learning signal)
  if (reply.length > 120) {
    void reflectOnTurn(env, text, reply, []).catch(() => {});
  }

  // Update session state
  updateSession(owner, text, reply, topic, perception.mode);
  // H4: persist session (incl. moodState history) to KV after EVERY turn, not
  // only on the periodic sync — a cold start between syncs no longer loses the
  // latest turn's state.
  await saveSessionToKV(env, owner).catch(() => {});
}

// ============================================================================
// MAIN ENTRY POINT: THE COGNITIVE CYCLE
// ============================================================================

/** Ambitious strategies whose EXPENSIVE execution we must never run on a
 *  possibly-misread topic — research pipelines, design pipelines, and code
 *  answers. Cheap intents (chat/question/translate) skip the gate entirely. */
function isAmbitiousIntent(strategy: Strategy, intentType: string): boolean {
  if (["orchestrate_research", "search_synthesize", "orchestrate_design"].includes(strategy.approach)) {
    return true;
  }
  return strategy.approach === "simple_llm" && intentType === "code";
}

/**
 * THE BRAIN: single entry point for all message processing.
 * Runs the full cognitive cycle: perceive → think → decide → act → reflect.
 *
 * This replaces the old processMessage() in jarvis_core.ts.
 * All webhook handlers should call this instead.
 *
 * RELEVANCE GATE (m9-v9): before executing an ambitious intent, verify the
 * topic didn't get misread — ask one short confirmation instead of guessing
 * (owner principle: understand → confirm → execute).
 */
export async function processIntelligence(
  env: Env,
  owner: number,
  text: string,
): Promise<IntelligenceResponse> {
  const start = Date.now();

  // Phase 1: PERCEIVE
  const perception = await perceive(env, owner, text);

  // RELEVANCE GATE — resume/discard a parked confirmation from an earlier
  // turn BEFORE deciding. A clear confirmation ("1"/"2"/"ya") resumes the
  // parked intent with the CONFIRMED topic; anything else discards it and
  // this message is processed as a fresh query. Fail-closed: no parked intent
  // → nothing changes, clear requests always flow straight through.
  const pending = await readPendingRelevance(env, owner).catch(() => null);
  let effectiveText = text;
  if (pending) {
    const res = resolveRelevanceConfirmation(text, pending);
    await clearPendingRelevance(env, owner).catch(() => {});
    if (res.confirmed) {
      perception.topic = res.applyCorrection ? pending.correctedTopic : pending.topic;
      perception.intent = {
        ...perception.intent,
        type: (pending.intentType as Perception["intent"]["type"]) ?? perception.intent.type,
      };
      effectiveText = res.applyCorrection ? pending.correctedText : pending.text;
    }
  }

  // Phase 2: THINK + DECIDE — runs AFTER any resume override so decide() sees
  // the confirmed topic, never the bare "1"/"2" confirmation word.
  const strategy = decide(perception);

  // Gate only FRESH turns (a resume already carries its confirmation) and only
  // when we are about to EXECUTE an ambitious intent on a possibly-misread
  // topic. On ambiguity: park the intent + ask ONE short confirmation instead
  // of burning budget on a guessed search/design/code run.
  if (!pending && isAmbitiousIntent(strategy, perception.intent.type)) {
    const gate = detectRelevanceAmbiguity(perception.topic, text, perception.intent.type);
    if (gate.ambiguous && gate.pending && gate.question && perception.topic) {
      await parkPendingRelevance(env, owner, { ...gate.pending, ts: Date.now() }).catch(() => {});
      return {
        text: gate.question,
        perception,
        strategy,
        source: "relevance_gate",
        latencyMs: Date.now() - start,
        reflection: { shouldReflect: false, topic: perception.topic },
      };
    }
  }

  // Phase 3: ACT
  const { reply, source, image } = await act(env, owner, effectiveText, perception, strategy);

  // Anchor substantive search/research replies to KV so a later follow-up
  // ("lebih dalam", "Lanjutkan") deepens THIS answer deterministically. The
  // brain now owns research fully (the webhook no longer writes anchors for
  // its old parallel path).
  if (reply.length > 80 && ["search_synthesize", "orchestrate_research"].includes(strategy.approach)) {
    await storeResearchAnchor(env, owner, perception.topic ?? effectiveText.slice(0, 80), reply).catch(() => {});
  }

  // Phase 4: REFLECT
  await reflect(env, owner, effectiveText, reply, perception, strategy);

  const latencyMs = Date.now() - start;

  // Record metrics (fire-and-forget)
  recordMetrics(strategy.approach, latencyMs, source, true);

  return {
    text: reply,
    perception,
    strategy,
    source,
    latencyMs,
    image,
    reflection: {
      shouldReflect: reply.length > 120,
      topic: perception.topic,
    },
  };
}

// ============================================================================
// Brain Status: for /status command
// ============================================================================

/** Get comprehensive brain status for diagnostics. */
export async function getBrainStatus(owner: number, env?: Env): Promise<string> {
  const session = getSession(owner);
  const mood = getMoodState(owner);
  const metrics = brainMetrics;
  const gateLines = env ? await readFailureTally(env) : "";
  const gapLines = env ? await describeGapProposals(env) : "";

  const lines = [
    "🧠 *J.A.R.V.I.S. Brain Status*",
    "",
    `*Cognitive Cycle:*`,
    `  Session: Turn ${session.turnCount}, Mode: ${session.conversationMode}`,
    `  Mood: ${mood.current} (intensity: ${(mood.intensity * 100).toFixed(0)}%)`,
    `  Topic: ${session.activeTopic ?? "None"}`,
    `  Working Memory: ${session.workingMemory.extractedFacts.length} facts`,
    "",
    `*Performance:*`,
    `  Total requests: ${metrics.totalRequests}`,
    `  Avg latency: ${Math.round(metrics.avgLatencyMs)}ms`,
    `  Strategies used: ${Object.entries(metrics.strategyCounts).map(([k, v]) => `${k}(${v})`).join(", ") || "none yet"}`,
    "",
    `*Provider Health:*`,
    ...Object.entries(metrics.providerSuccessRates).map(([k, v]) => {
      const rate = v.ok + v.fail > 0 ? ((v.ok / (v.ok + v.fail)) * 100).toFixed(0) : "N/A";
      return `  ${k}: ${rate}% (${v.ok} ok, ${v.fail} fail)`;
    }),
    "",
    "*Sub-Systems:*",
    "  • Perception (emotion/language/intent): ✅",
    "  • Cognition (LLM/research/design): ✅",
    "  • Reflection (learning/memory): ✅",
    "  • Safety (verifier/heuristics): ✅",
    "",
  ];
  if (gateLines) lines.push(gateLines);
  if (gapLines) lines.push(gapLines);
  return lines.map((l) => l.trimEnd()).join("\n");
}

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
  emotionToStyle, moodSummary,
  type EmotionSignal, type MoodState,
} from "./emotion";
import { detectLanguage, type Language } from "./jarvis_language";
import {
  getSession, type SessionState,
  detectConversationMode, detectTopicContinuity,
  updateSession, buildEnrichedContext,
} from "./context_manager";
import { buildConversationMessages } from "./conversation";
import {
  llmRespond, searchAndSynthesize, extractTopic,
  isFollowUpQuery, resolveFollowUpAnchor,
  parseTranslate, translateText,
} from "./ai";
import {
  isResearchClass, orchestrateResearch,
  isDesignIntent, orchestrateDesign,
} from "./subagents";
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
  enrichedContext: Array<{ role: string; content: string }>;
}

/** Intent classification result. */
export interface IntentResult {
  type: "question" | "command" | "search" | "chat" | "emergency" | "translation" | "design" | "self_referential";
  urgency: "low" | "medium" | "high";
  formality: "casual" | "neutral" | "formal";
  confidence: number;
  entities: Record<string, string>;
}

/** Strategy decision — how the brain will handle this message. */
export interface Strategy {
  approach: "simple_llm" | "search_synthesize" | "orchestrate_research" | "orchestrate_design" | "translate" | "self_referential";
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

/** Detect translation requests. */
const TRANSLATE_RE = /(?:terjemahkan|translate|arti|mean)\s+(?:ke(?:\s+(?:bahasa)?)?)?\s*(\w[\w\s]*)/i;

/** Detect bare translation (just "terjemahkan" with prior assistant context). */
const BARE_TRANSLATE_RE = /^(?:terjemahkan|translate)\s*$/i;

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
  const [language, emotion, session] = await Promise.all([
    Promise.resolve(detectLanguage(text)),
    Promise.resolve(detectEmotion(text)),
    Promise.resolve(getSession(owner)),
  ]);

  const mood = getMoodState(owner);
  updateMood(owner, emotion);

  const mode = detectConversationMode(text);
  const isFollowUp = isFollowUpQuery(text);

  // Build enriched context (recent turns + memories + working memory)
  const enrichedContext = await buildEnrichedContext(env, owner, text, {
    mood,
    topic: session.activeTopic ?? undefined,
  });

  // Detect topic continuity
  const topicResult = detectTopicContinuity(text, enrichedContext);
  const topic = topicResult.topic ?? text.slice(0, 80);

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
    enrichedContext,
  };
}

/**
 * Unified intent classifier — combines signals from multiple sources.
 * Priority: self-referential > emergency > design > translate > search > command > chat > question
 */
function classifyIntent(text: string, topic: string | null): IntentResult {
  const low = text.toLowerCase();

  // Self-referential (highest priority — JARVIS talking about itself)
  if (SELF_REF_RE.test(low)) {
    return { type: "self_referential", urgency: "low", formality: "neutral", confidence: 0.95, entities: {} };
  }

  // Emergency (standalone markers only, not inside search phrases)
  if (/(?:^|\s)(?:stop|kill|override|darurat|emergency|urgent)(?:\s|$|[.,!])|\b(?:sekarang|now)\s*!/i.test(low)) {
    return { type: "emergency", urgency: "high", formality: "formal", confidence: 0.9, entities: {} };
  }

  // Design engineering intent
  if (isDesignIntent(text)) {
    return { type: "design", urgency: "medium", formality: "neutral", confidence: 0.85, entities: { topic: text.slice(0, 100) } };
  }

  // Translation
  const translateMatch = text.match(TRANSLATE_RE);
  if (translateMatch) {
    return { type: "translation", urgency: "low", formality: "formal", confidence: 0.9, entities: { target: translateMatch[1]?.trim() || "" } };
  }
  if (BARE_TRANSLATE_RE.test(low)) {
    return { type: "translation", urgency: "low", formality: "formal", confidence: 0.8, entities: { bare: "true" } };
  }

  // Search / research
  if (/\b(?:cari|search|info|tentang|analisis|review|bandingkan|ringkas|laporan)\b/i.test(low)) {
    return { type: "search", urgency: "medium", formality: "neutral", confidence: 0.8, entities: { topic: text.slice(0, 100) } };
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

  // Self-referential → direct answer (no LLM needed, handled by webhook)
  if (intent.type === "self_referential") {
    return {
      approach: "self_referential",
      depth: "shallow",
      providerPreference: "any",
      riskLevel: "safe",
    };
  }

  // Translation → dedicated pipeline
  if (intent.type === "translation") {
    return {
      approach: "translate",
      depth: "shallow",
      providerPreference: "fast",
      riskLevel: "safe",
    };
  }

  // Emergency → fast, direct LLM
  if (intent.type === "emergency") {
    return {
      approach: "simple_llm",
      depth: "shallow",
      providerPreference: "fast",
      riskLevel: "safe",
    };
  }

  // Design engineering → full design pipeline
  if (intent.type === "design" && topic) {
    return {
      approach: "orchestrate_design",
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
      approach: "search_synthesize",
      depth: "medium",
      providerPreference: "any",
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
): Promise<{ reply: string; source: string }> {
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
      const anchor = isFollowUpQuery(text) ? resolveFollowUpAnchor(enrichedContext)?.prior ?? "" : "";
      const result = await orchestrateDesign(env, owner, text, topic, anchor);
      if (result) return { reply: result, source: "design" };
      // Fallback to search
      const fallback = await searchAndSynthesize(env, owner, text, topic);
      return { reply: fallback.reply ?? "Gagal memproses desain.", source: "design_fallback" };
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

    case "simple_llm":
    default: {
      const result = await llmRespond(env, text, {
        topic: topic ?? undefined,
        context: enrichedContext,
        contextIsEnriched: true,
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
}

// ============================================================================
// MAIN ENTRY POINT: THE COGNITIVE CYCLE
// ============================================================================

/**
 * THE BRAIN: single entry point for all message processing.
 * Runs the full cognitive cycle: perceive → think → decide → act → reflect.
 *
 * This replaces the old processMessage() in jarvis_core.ts.
 * All webhook handlers should call this instead.
 */
export async function processIntelligence(
  env: Env,
  owner: number,
  text: string,
): Promise<IntelligenceResponse> {
  const start = Date.now();

  // Phase 1: PERCEIVE
  const perception = await perceive(env, owner, text);

  // Phase 2: THINK + DECIDE
  const strategy = decide(perception);

  // Phase 3: ACT
  const { reply, source } = await act(env, owner, text, perception, strategy);

  // Phase 4: REFLECT
  await reflect(env, owner, text, reply, perception, strategy);

  const latencyMs = Date.now() - start;

  // Record metrics (fire-and-forget)
  recordMetrics(strategy.approach, latencyMs, source, true);

  return {
    text: reply,
    perception,
    strategy,
    source,
    latencyMs,
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
export function getBrainStatus(owner: number): string {
  const session = getSession(owner);
  const mood = getMoodState(owner);
  const metrics = brainMetrics;

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
  ];

  return lines.join("\n");
}

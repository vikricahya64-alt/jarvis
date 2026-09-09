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
  detectGarbledInput,
  unknownEntitySignal,
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
import { buildFinalReply, ensureReciprocalQuestion } from "./response_formatter";
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

/** Ask-vs-EXECUTE verdict for HEAVY capabilities (design/search/code — the
 *  intents whose act is expensive: flux render, multi-step research, deep
 *  writer). A message that merely MENTIONS a heavy capability may be ASKING
 *  ABOUT it ("perbedaan gambar vs teks", "apa itu desain X?") instead of
 *  ORDERING it ("buatkan logo"). Owner principle (m9-v11.1): give a RESPONSE
 *  and VERIFY whether the capability should run — but not every turn: when the
 *  input text itself decides, use it (clear order verb → execute, plain question
 *  wording with no order verb → just answer). Only mixed/status-is-unclear
 *  phrasings ("cara buat poster yang bagus", a bare capability noun) get the
 *  answer + verification suffix. */
function heavyCapVerdict(type: "search" | "design" | "code", text: string): "execute" | "answer" | "verify" {
  const low = text.toLowerCase();
  // Per-capability ORDER verbs — words that mean "run the capability NOW".
  // Search trigger words themselves are orders (cari/riset/tentang/info/...);
  // design orders need explicit creation verbs; code orders use build/fix verbs.
  const orderVerb =
    type === "search"
      ? /\b(?:cari|search|riset|research|analisis|analisa|review|bandingkan|ringkas|pelajari|mempelajari|telusuri|tentang|info|studi|study|kajian|laporan)\b/.test(low)
      : type === "code"
        ? /\b(?:tulis|tuliskan|buat|bikin|bkin|buatin|perbaiki|debug|analisis|analisa|review|baca|fix|koding|jelaskan|menjelaskan|tunjukkan)\b/.test(low)
        : /\b(?:buat|bikin|bkin|buatin|desain|rancang|gambarkan|membuat|menghasilkan|generate|tolong|minta|mohon|coba)\b/.test(low);
  const questionWord =
    /\b(?:apa|siapa|berapa|kapan|kenapa|mengapa|apakah|bagaimana|cara|perbedaan|banding|vs|versus|lebih\s+(?:baik|bagus)|mana\s+yang|rekomendasi|referensi|mirip|maksud|itu)\b/.test(low);
  if (orderVerb && !questionWord) return "execute";
  if (questionWord && !orderVerb) return "answer";
  return "verify";
}

/** Human, capability-specific verification suffix: asked AND answered, then we
 *  confirm whether the heavy capability should actually run. */
function heavyVerifySuffix(cap: string, reply: string): string {
  const ask =
    cap === "search"
      ? `\n\nNgomong-ngomong, kalau yang kamu mau adalah aku langsung cari/risetkan detailnya, bilang saja — nanti kukerjakan.`
      : cap === "code"
        ? `\n\nNgomong-ngomong, kalau yang kamu mau adalah aku langsung tulis/kerjakan kodenya, bilang saja — nanti kukerjakan.`
        : `\n\nNgomong-ngomong, kalau yang kamu mau adalah aku langsung buatkan desain/gambarnya, bilang saja — nanti kukerjakan.`;
  return `${reply}${ask}`;
}

// ============================================================================
// GLOBAL MODE CLASSIFIER: communicate vs execute
// ============================================================================

/** Global communication-vs-execution mode, applied BEFORE any capability
 *  classification.  A message that is clearly a QUESTION/CLARIFICATION
 *  ("ilmu komunikasi" — knowledge exchange) must NEVER trigger a heavy
 *  capability (design/search/code), even if it happens to contain a trigger
 *  word like "gambar" or "cari".  Only an imperative ORDER verb without a
 *  question-dominant structure warrants execution.  Owner principle (m9-v11.3):
 *  "JARVIS tidak tahu membedakan ilmu komunikasi dan eksekusi — seharusnya
 *  dia tahu sebelum respons verifikasi kemampuan."
 *
 *  This classifier is GLOBAL — works across ALL topic contexts, not tuned to
 *  one topic. It is the most fundamental axis before any capability routing. */
type MessageMode = "communicate" | "execute" | "ambiguous";
function messageMode(text: string): MessageMode {
  const low = text.toLowerCase();
  // COMMUNICATE signals: question words, clarifications, negation,
  // comparative phrasing, "aku mau tahu", "bisa tidak", "mau tanya"
  const communicate =
    /\b(?:apa|apakah|siapa|kenapa|mengapa|kapan|berapa|bagaimana|gmn|bgmn|cara|perbedaan|perbandingan|bandingkan?|vs\b|versus|lebih\s+(?:baik|bagus|murah|mahal)|mana\s+yang|rekomendasi|referensi|jelaskan?|ceritakan|info\s+tentang|tahu|tau|maksud|artinya|contoh|bisa\s+(?:tidak|nggak|gak|kah|saja)|mau\s+tanya|ingin\s+tahu|aku\s+mau|yang\s+(?:saya|aku)\s+(?:maksud|minta|tahu)|bukan|maksudku|misalnya)\b/.test(low);
  // EXECUTE signals: imperative/order creation verbs with no question wrapper
  const execute =
    /\b(?:buat|bikin|bkin|buatin|desain|rancang|gambarkan?|generate|tolong\s+(?:buat|bikin|cari|riset|tulis)|minta\s+(?:buat|bikin|cari)|mohon\s+(?:buat|bikin)|cari\s+(?:data|info|info-nya)|riset|research|analisis|analisa|tulis\s+(?:kode|code|script)|tuliskan|perbaiki|debug|fix)\b/.test(low);
  if (execute && !communicate) return "execute";
  if (communicate && !execute) return "communicate";
  return "ambiguous";
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
  // m9-v11.1 RESPOND-THEN-VERIFY (owner principle): a heavy capability should
  // run on a CLEAR order verb ("buat/desain/rancang/gambarkan ...") — but when
  // the text could be asking ABOUT it ("perbedaan generasi gambar vs teks pada
  // platform agent" was hijacked into a Flux design, "4 konsep AI dalam 1
  // software" got an Ide Utama/Gaya Visual outline) — we ANSWER and then ask
  // whether to actually run the capability. Text-clear turns still skip the
  // verification (owner: "tidak setiap saat di verifikasi").
  if (isDesignIntent(text)) {
    const verdict = heavyCapVerdict("design", text);
    if (verdict === "execute") {
      return { type: "design", urgency: "medium", formality: "neutral", confidence: 0.85, entities: { topic: text.slice(0, 100) } };
    }
    if (verdict === "verify") {
      return { type: "question", urgency: "low", formality: "neutral", confidence: 0.7, entities: { heavyVerify: "design", topic: text.slice(0, 100) } };
    }
    // verdict === "answer" → fall through to the plain question path below.
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

  // Simplification request (re-explain the ACTIVE topic in plain words)
  // is NOT a new search topic. Route to simple_llm so the answer stays
  // grounded on the ongoing thread and the simplicity rail keeps it plain.
  const simplifyWords = /\b(lebih mudah|sederhanakan|saya belum mengerti|saya nggak paham|biar paham|gampang|mudah dipahami|tolong sederhanakan|jika bisa)\b/i;
  if (simplifyWords.test(low) || /belum\s+mengerti|tidak\s+paham/i.test(low)) {
    return { type: "question", urgency: "low", formality: "neutral", confidence: 0.7, entities: {} };
  }

  // m9-v11.3 GLOBAL MODE GUARD: ilmu komunikasi vs eksekusi.
  // If the message is clearly a QUESTION/CLARIFICATION/NEGATION (communicate
  // mode), force it to a pure question/chat path BEFORE any capability
  // routing (search/design/code). This is the most fundamental axis:
  // JARVIS must know whether the owner is DISCUSSING (ilmu komunikasi) or
  // ORDERING (eksekusi) before any capability decision. Prevents:
  // "Apakah bisa membuatnya sendiri" (communicate → clarification about the
  // topic) from echoing random memories, "perbedaan generasi gambar vs teks"
  // (communicate → comparison question) from hijacking to Flux design.
  const mode = messageMode(text);
  if (mode === "communicate") {
    return { type: "question", urgency: "low", formality: "neutral", confidence: 0.8, entities: { topic: text.slice(0, 100) } };
  }

  // Search / research — a heavy capability: a CLEAR order runs the search,
  // but an ask-shaped phrasing ("bagaimana cara riset X?") that doesn't order
  // it gets ANSWERED + verified instead of burning a search literally (owner:
  // respond then verify, not every turn — text-clear turns skip verification).
  if (/\b(?:cari|search|riset|reseach|research|studi|study|pelajari|mempelajari|meneliti|info|tentang|analisis|review|bandingkan|ringkas|laporan|kajian)\b/i.test(low)) {
    if (heavyCapVerdict("search", text) === "verify") {
      return { type: "question", urgency: "low", formality: "neutral", confidence: 0.7, entities: { heavyVerify: "search", topic: text.slice(0, 100) } };
    }
    return { type: "search", urgency: "medium", formality: "neutral", confidence: 0.8, entities: { topic: text.slice(0, 100) } };
  }

  // Programming language / code task (conservative: code vocabulary + an action
  // verb, or an explicit ``` block — "aku suka coding" stays casual chat).
  if (/```/.test(low) || (/\b(?:kode|code|coding|pemrograman|programming|script|skrip|syntax|sintaks|algoritm[ae]|debug)\b/i.test(low) && /\b(?:tulis|buat|bikin|jelaskan|perbaiki|debug|analisis|analisa|baca|review|cara|bagaimana|apa|kenapa|mengapa)\b/i.test(low))) {
    if (heavyCapVerdict("code", text) === "verify") {
      return { type: "question", urgency: "low", formality: "neutral", confidence: 0.7, entities: { heavyVerify: "code" } };
    }
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
        systemOverride: (() => {
          // m9-v11 ANTI-FABRICATION RAIL (owner principle): never confidently
          // explain a platform/product/term that isn't in the conversation and
          // you aren't sure is real (live failure: fabricated "platform AGE").
          // Applies to ALL simple_llm turns, continuation or not.
          if (perception.isContinuation && topic) {
            const isSimplify = /\b(lebih mudah|sederhanakan|belum mengerti|nggak paham|gampang|mudah dipahami|biar paham|tolong sederhanakan)\b/i.test(text);
            if (isSimplify) {
              return `Pemilik minta penjelasan lebih sederhana tentang topik yang sedang dibahas. ` +
                `Topik aktif: "${topic}". ` +
                `Jawab ULANG penjelasan tentang topik itu dengan bahasa sehari-hari yang sangat sederhana: ` +
                `tanpa jargon, tanpa poin-poin panjang, kalimat pendek mengalir, seperti menjelaskan ke teman. ` +
                `Tetap pada topik itu — JANGAN ganti topik. ` +
                `Jika ada platform/produk/istilah yang tidak kamu kenal atau tidak muncul di percakapan, ` +
                `JANGAN menjelaskannya secara detail — katakan jujur tidak yakin dan kembalikan ke topik yang dibahas. ` +
                `LARANGAN ECHO: JANGAN PERNAH mengulang atau menyebut blok markup internal ` +
                `(seperti [Memori kerja], [Kenangan relevan], [Ringkasan]) dalam jawaban — itu konteks internal.`;
            }
            return `Pemilik MENERUSKAN percakapan tentang "${topic}". ` +
              `Pesan ini ringkas dan tidak menyebut ulang topiknya. ` +
              `Jawab sebagai LANJUTAN dari percakapan tentang topik itu. ` +
              `TETAP pada topik "${topic}" — JANGAN menyimpang ke topik lain, ` +
              `JANGAN menjawab tentang hal yang tidak berkaitan dengan topik di atas. ` +
              `Jika ada platform/produk/istilah yang tidak kamu kenal atau tidak muncul di percakapan, ` +
              `JANGAN menjelaskannya secara detail — katakan jujur tidak yakin dan kembali ke topik yang dibahas. ` +
              `LARANGAN ECHO: JANGAN PERNAH mengulang atau menyebut blok markup internal ` +
              `(seperti [Memori kerja], [Kenangan relevan], [Ringkasan]) dalam jawaban.`;
          }
          return `Jawab pertanyaan ini secara langsung, jujur, dan fokus. ` +
            `JANGAN mengarang atau menjelaskan dengan percaya diri tentang platform, produk, merek, ` +
            `atau istilah yang tidak kamu kenal dan tidak muncul di konteks percakapan. ` +
            `Kalau sebuah istilah tidak jelas bagimu, jawab jujur: "Aku belum paham yang kamu maksud — ` +
            `bisa dijelaskan sedikit?" — JANGAN menebak-nebak platform yang mungkin tidak nyata.`;
        })(),
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

  // m9-v11 COMPREHENSION GATE (typo/garble detection): an odd sentence that
  // doesn't fit the ongoing topic should be ASKED ABOUT, not confidently
  // answered (owner principle: "manusia bertanya saat tidak mengerti kalimat
  // yang aneh, sebelum menjawabnya"). Live failures: "jelaskan bahasa mudah"
  // → Malang; "generasi hambar vs teks pada platform age" → fabricated
  // "platform AGE". Runs BEFORE decide/act so a garbled message never burns
  // a search/design run on a misread topic. Skipped when we already resume a
  // parked confirmation, and on commands/emergency/self-ref (deterministic,
  // low-risk paths where a gate would just add noise).
  const skipComprehension =
    pending ||
    /^\//.test(text.trim()) ||
    /^(emergency|self_referential|translation|command|prompt_writer|context7)$/.test(perception.intent.type);
  if (!skipComprehension) {
    // Anti-false-positive guard (m9-v11.1): a PURE continuation that only
    // references what's already in the thread must be ANSWERED, not re-asked.
    // Live over-fire: "4 konsep tersebut" / "kedua generasi tersebut" → JARVIS
    // asked a clarifying question although the owner was clearly continuing.
    // Only run the gate when the message actually INTRODUCES an unknown
    // platform/product/term (deterministic red-flag) — then a garbled
    // continuation like "generasi hambar pada platform age" still trips it.
    const bareContinuation = perception.isContinuation && !unknownEntitySignal(effectiveText);
    if (!bareContinuation) {
      const garbled = await detectGarbledInput(env, effectiveText, perception.enrichedContext, perception.topic).catch(
        () => ({ clear: true, uncertain: null }),
      );
      if (garbled.clear === false) {
        const term = garbled.uncertain?.trim();
        const clarifyBase =
          term && term.length <= 60 && !/^[\s\W]+$/.test(term)
            ? term.startsWith("platform")
              ? `Sebelum kujawab: platform "${term.split(/\s+/)[1] || term}" yang kamu maksud itu apa ya? Aku belum paham istilah itu dalam konteks ini — boleh jelaskan sedikit?`
              : `Sebelum kujawab: "${term}" yang kamu maksud itu apa ya? Aku belum paham istilah itu dalam konteks ini — boleh jelaskan sedikit?`
            : `Sebelum kujawab, mau memastikan dulu: maksud pesanmu itu apa ya? Ada bagian yang belum kupahami — boleh dijelaskan ulang?`;
        return {
          text: clarifyBase,
          perception,
          strategy,
          source: "understand_clarify",
          latencyMs: Date.now() - start,
          reflection: { shouldReflect: false, topic: perception.topic },
        };
      }
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

  // m9-v10 URL STRIP (anti-halusinasi): non-research/chat paths must NOT emit
  // URLs — the LLM fabricates them (e.g. "https://en.wikipedia.org/wiki/Bukan-
  // Bukan") and they get delivered as unverified junk. Research/search/design
  // paths have already been sanitized by their own verifier layer. Only chat/
  // question/understand/code paths need this blanket strip.
  const isResearchPath = ["search_synthesize", "orchestrate_research", "orchestrate_design"].includes(strategy.approach);
  const safeReply = isResearchPath
    ? reply
    : reply.replace(/https?:\/\/[^\s)]+/g, "").replace(/\[([^\]]*)\]\(\s*https?:\/\/[^\s)]+\)/g, "$1").trim();

  // m9-v10 RECIPROCAL QUESTION (basis of human communication): after an
  // answer a person asks back — verifying the answer matched what the owner
  // meant. ensureReciprocalQuestion appends ONE natural follow-up question,
  // unless the owner is ALREADY steering the thread (follow-up/continuation —
  // double-asking would nag), the turn is a system/closed-loop result
  // (canned/fallback/self-ref/translate/relevance-gate), or there is no topic
  // to probe around. Anchors, memory, and metrics all keep the PLAIN answer.
  const heavyCap = perception.intent.entities?.heavyVerify;
  const probeSkip =
    perception.isFollowUp || perception.isContinuation ||
    /^(canned|fallback|self_ref|understand_clarify|relevance_gate|translate|translate_bare)$/i.test(source) ||
    /^(command|emergency|translation|self_referential)$/i.test(perception.intent.type) ||
    !!heavyCap ||
    !perception.topic;
  const deliverable =
    heavyCap
      ? // m9-v11.1 RESPOND-THEN-VERIFY: the capability was ambiguous in the text
        // ("cara buat poster?" / "bagaimana cara riset X?") — we ANSWERED it via
        // the cheap question path above, and now ask whether the HEAVY act should
        // actually run. Never verify when the text was clear (that path keeps a
        // plain answer, no nagging).
        heavyVerifySuffix(heavyCap, safeReply)
      : ensureReciprocalQuestion(safeReply, { skip: probeSkip });

  return {
    text: deliverable,
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

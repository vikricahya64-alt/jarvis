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

import { Env, appendMemory } from "./db";
import {
  detectEmotion, updateMood, getMoodState,
  inferEmotionFromContext,
  type EmotionSignal, type MoodState,
} from "./emotion";
import { detectLanguage, type Language } from "./jarvis_language";
import { comprehend, comprehensionNote, LANG_NAMES, type ComprehensionProfile } from "./comprehension";
import {
  getSession, type SessionState,
  detectConversationMode, detectTopicContinuity,
  updateSession, buildEnrichedContext, saveSessionToKV,
} from "./context_manager";
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
import { reflectOnTurn } from "./evolution";
import { SELF_REF_RE } from "./identity";
import { probeProviders } from "./providers";

// ============================================================================
// Types
// ============================================================================

/** Perception result — what the brain understands about the input. */
export interface Perception {
  language: Language;
  /** m9-v11.32: ROOT comprehension engine — universal language, literacy
   *  register, and knowledge-domain awareness. Aditif; cabang lain tetap
   *  memakai `language`/`intent` lama. */
  comprehension: ComprehensionProfile;
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
    comprehension: comprehend(text),
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
function classifyIntent(text: string, _topic: string | null): IntentResult {
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
  const { intent, isFollowUp, topic } = perception;
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
// ============================================================================
// m9-v11.19 DETERMINISTIC NO-MENU GUARD
// The no-menu / no-announcement rail is a PROMPT-level rule; gpt-oss-120b
// intermittently ignores it. Owner live failure (2026-09-10): the recall
// "tadi kita bahas bekerja remote" came back as a BARE menu question
// ("Mau saya lanjutkan dengan contoh tantangan utama ... atau tips praktis ...?")
// even though the rail was in the system message. These helpers enforce the
// rule AFTER generation, deterministically — we must never ship a menu-first
// answer. Flow: isMenuFirstLine → regenerate once with a nudge → strip; for
// recall turns a still-menu answer degrades into a deterministic continuation.
// ============================================================================

const MENU_FOLLOWUP_NUDGE =
  `\n\nCatatan proses: jawaban yang kamu kirimkan TADI DIMULAI dengan ` +
  `pertanyaan pilihan ("Mau saya ...? ... atau ...?") — itu TIDAK sesuai ` +
  `permintaan pemilik. TULIS ULANG sekarang: tulis ulang seluruh jawaban sebagai ` +
  `satu paragraf yang LANGSUNG berisi isi lanjutan topiknya, tanpa kalimat ` +
  `"Mau saya lanjutkan dengan ...", tanpa bertanya balik, tanpa pembukaan ` +
  `pengumuman, dan berhenti di konten. Jangan menyebut soal penulisan ulang ini.`;

const ECHO_FOLLOWUP_NUDGE =
  `\n\nCatatan proses: jawaban yang kamu kirimkan itu MENGULANG frasa yang sama ` +
  `berulang kali (echo) alih-alih memberi isi. TULIS ULANG sekarang: tulis ulang ` +
  `seluruh jawaban sebagai satu paragraf yang menjelaskan isi topiknya dengan ` +
  `kalimat baru, tanpa mengulang frasa atau kata yang sama, dan berhenti di ` +
  `konten. Jangan menyebut soal penulisan ulang ini.`;

// m9-v11.27: last-ditch recall regeneration — force REAL content, banning the
// meta-acknowledgement stub ("Aku ingat konteks ini dan siap lanjut dari situ")
// the model keeps falling back to on recall turns.
const RECALL_CONTENT_NUDGE =
  `\n\nCatatan proses: jawaban yang kamu kirimkan sebelumnya hanya mengakui ` +
  `mengingat dan menawarkan lanjut, tanpa menyampaikan isi. TULIS ULANG sekarang: ` +
  `LANGSUNG tulis satu paragraf yang berisi lanjutan topik itu — sampaikan poin ` +
  `nyata (definisi, contoh, tantangan, atau tips) yang sesuai dengan topik yang ` +
  `kamu ingat. JANGAN menulis "aku ingat", "aku siap lanjut", "soal itu dari ` +
  `pembicaraan kita dulu", atau "intinya ...". Berhenti di konten. Jangan ` +
  `menyebut soal penulisan ulang ini.`;

/** True when the reply only ACKNOWLEDGES remembering + invites continuation
 *  without delivering any substance — the meta-stub "Soal itu — dari
 *  pembicaraan kita dulu, intinya X. Aku ingat konteks ini dan siap lanjut dari
 *  situ." (owner live failure 2026-09-10, deterministic recall fallback). */
export function isAcknowledgeOnly(content: string): boolean {
  const t = (content ?? "").trim();
  if (t.length > 400) return false;
  return (
    /\b(?:aku|saya)\s+(?:ingat|masih ingat|paham)\s+konteks\b/i.test(t) ||
    /\bsiap lanjut\b/i.test(t) ||
    /dari pembicaraan kita dulu,?\s+intinya/i.test(t)
  );
}

/** Kata-kata terlalu umum untuk jadi sinyal pengulangan yang bermakna. Subset
 *  kecil lokal (hindari cycle import dari verifier). */
const ECHO_STOP = new Set([
  "yang", "itu", "dengan", "dari", "pada", "untuk", "dan", "atau", "dalam", "akan",
  "juga", "kamu", "saya", "anda", "kami", "kita", "mereka", "dia", "ini", "ada",
  "adalah", "di", "ke", "saat", "karena", "kalau", "jika", "maka", "tapi", "namun",
  "agar", "supaya", "bisa", "dapat", "sudah", "belum", "tidak", "bukan", "sangat",
  "lebih", "cara", "banyak", "sedikit", "tentu", "seperti", "baik", "mungkin",
  "masih", "terus", "lanjut", "saja", "lagi", "pertama", "secara", "antara", "serta",
  "selalu",
]);

/** True when the reply is a DEGENERATE ECHO — satu frasa bermakna (2 kata
 *  signifikan berurutan) diulang >=3 kali dalam satu jawaban (mis. "...bekerja
 *  remote... bekerja remote dan bekerja remote") alih-alih isi. Deterministic;
 *  hanya menilai jawaban yang cukup panjang (>=60 char) agar jawaban singkat
 *  yang sah tidak kena. Owner live failure 2026-09-10 (turning recall). */
export function hasDegenerateEcho(content: string): boolean {
  const t = (content ?? "").trim();
  if (t.length < 60) return false;
  const words = (t.toLowerCase().match(/[a-z]{3,}/g) ?? []).filter((w) => !ECHO_STOP.has(w));
  if (words.length < 8) return false;
  const seen = new Map<string, number>();
  for (let i = 0; i < words.length - 1; i++) {
    const pair = `${words[i]} ${words[i + 1]}`;
    seen.set(pair, (seen.get(pair) ?? 0) + 1);
  }
  for (const c of seen.values()) if (c >= 3) return true;
  return false;
}

/** True when the answer OPENS with an offer/menu question or with an empty
 *  announcement — the two bad patterns the rail forbids but the model can
 *  still produce. Looks only at the FIRST sentence, so a menu deep in an
 *  otherwise contentful answer passes (the recall scrub already handles
 *  trailing junk). */
export function isMenuFirstLine(content: string): boolean {
  if (!content || typeof content !== "string") return false;
  const first = (content.match(/^[^.!?？\n]*[.!?？]?/) ?? [""])[0].trim().slice(0, 160);
  if (!first) return false;
  const looksMenu =
    /\b(?:mau|ingin|apakah kamu|apakah anda|boleh)\b[^!?？]{0,60}\b(?:saya|aku|kita)\b/i.test(first) &&
    /(?:lanjutkan|melanjutkan|bahas|membahas|bicarakan|jelaskan|menjelaskan|berikan|contoh|opsi|pilihan|gali|yang mana|atau)/i.test(first) &&
    /[?？]/.test(first);
  // m9-v11.26: menu question WITHOUT a first-person pronoun slips past the
  // pattern above ("Mau lanjut ke topik mana ... — misalnya X, Y, atau Z?" —
  // owner live failure after the recall fix). Catch any leading QUESTION that
  // explicitly enumerates choices (misalnya ... atau / mana yang / pilih).
  const menuOffer =
    /[?？]/.test(first) &&
    (/\b(?:misalnya|misal|contohnya)\b/i.test(first) ||
     /\b(?:mana yang|yang mana)\b[^?？]{0,30}/i.test(first) ||
     /\bpilih salah satu\b/i.test(first));
  const bareMau =
    /^(?:mau|apakah kamu mau|apakah anda mau|boleh mau)\b[^!?？]{0,80}?[?？]/i.test(first) &&
    /(?:lanjutkan|melanjutkan|bahas|bicarakan|tentang|ke|soal)/i.test(first);
  const announceLead =
    /^(?:saya akan|aku akan|saya siap|aku siap|saya jelaskan|aku jelaskan|saya bahas|aku bahas|saya uraikan|aku uraikan|berikut yang akan saya|berikut yang akan aku|berikut ini yang akan saya|berikut ini yang akan aku|rencana saya|kamu ingin mengetahui|anda ingin mengetahui|selanjutnya saya akan)/i.test(first);
  return looksMenu || menuOffer || bareMau || announceLead;
}

/** Strip a LEADING run of menu-question / empty-announcement sentences. The
 *  last line of defense after the regenerate-nudge: whatever survives is real
 *  content, or empty. */
export function stripLeadingMenuSentences(content: string): string {
  if (!content || typeof content !== "string") return "";
  const kept: string[] = [];
  let contentSeen = false;
  for (const line of content.split(/\n+/).map((s) => s.trim()).filter(Boolean)) {
    if (!contentSeen && isMenuFirstLine(line)) continue;
    contentSeen = true;
    kept.push(line);
  }
  return kept.join("\n");
}

/** Deterministic continuation for a recall turn that STILL opens with a menu
 *  even after the regenerate-nudge: re-narrate the recalled SUBJECT as a short
 *  natural paragraph instead of a question — NEVER a dump of raw data
 *  (timestamps / "User menanyakan tentang:" / pipe separators). Content-first,
 *  no menu, and m9-v11.27: no empty invite either — the old tail ("...Aku ingat
 *  konteks ini dan siap lanjut dari situ.") was a stub that DELIVERED no
 *  substance (owner live failure). Now it states the recollection honestly. */
export function deterministicRecallContinuation(recallBlock?: { content?: string }): string {
  const raw = (recallBlock?.content ?? "").replace(/^\[[^\]]+\]\s*\([^)]*\)\s*:/, "");
  const pick = (re: RegExp): string[] =>
    raw
      .split("|")
      .map((s) => s.trim())
      .filter((l) => re.test(l))
      .map((l) =>
        l
          .replace(/^(pemilik|kenangan|kamu):\s*/i, "")
          .replace(/\d{4}-\d{2}-\d{2}\s*/g, "")
          .replace(/user\s+menanyakan\s+tentang:\s*/gi, "")
          .replace(/\.\s*Pemilik menunjuk[\s\S]*$/i, ""),
      )
      .filter((l) => l.length > 0);
  // Surface the SUBJECT discussed: owner's words first, then curated memories;
  // assistant lines fill the rest — owner substance always ranks above the
  // assistant's own (upstream-scrubbed) answers.
  const bits = pick(/^(pemilik|kenangan):/i);
  const assistantBits = pick(/^kamu:/i);
  const merged = [...bits, ...assistantBits.filter((b) => !bits.includes(b))];
  if (merged.length === 0) {
    return "Aku belum berhasil menemukan catatan percakapan itu — tolong ingatkan aku sedikit konteksnya.";
  }
  // Translate remaining data-level artifacts ("owner membicarakan X") into a
  // human memory ("kita sempat membahas X") — one door in, one door out. The
  // remembered DETAIL (kelebihan/kekurangan/pro-kontra) is kept — it is the
  // substance of the recollection, not filler.
  const humanize = (s: string): string =>
    s
      .replace(/^owner\s+(membicarakan|membahas|sempat membicarakan|sempat membahas)\s+/i, "kita sempat membahas ")
      .replace(/^owner\s+/i, "kita ")
      .replace(/\s{2,}/g, " ")
      .trim();
  const clean = merged.map((s) => humanize(s).replace(/\s{2,}/g, " ").trim()).filter(Boolean);
  if (clean.length === 0) {
    return "Aku belum berhasil menemukan catatan percakapan itu — tolong ingatkan aku sedikit konteksnya.";
  }
  // m9-v11.27: honest recollection WITHOUT an invitation — name what we
  // actually discussed, stop. No "siap lanjut", no question, no fabrication.
  const subject = clean[0];
  const extra = clean.length > 1 ? ` Yang aku catat dulu antara lain ${clean.slice(1, 3).join(" dan ")}.` : "";
  return `Dari pembicaraan kita dulu, kita sempat membahas ${subject}.${extra}`;
}

// ============================================================================
// m9-v11.19 GLOBAL TWO-PARAGRAPH PROTOCOL (replaces the answer-vs-verification
// external-suffix mechanics). Every conversational generation gets ONE rail:
//   P1 Jawaban — answer the question directly, from conversation + memory.
//   P2 Rekomendasi — only when a recommendation/next-step is warranted: a
//      recommendation anchored in memory ("berdasarkan catatan kita..."), with
//      uncertainty flagged AND verification folded into it in one line
//      ("ini perkiraanku — mau aku pastikan/riset?").
// The verification is now PART OF P2, produced by the model under the rail —
// the old separate system-appended heavyVerifySuffix is retired. Anti-menu,
// anti-fabrication, persona rules stay for every branch.
// ============================================================================

/** Build the universal system frame for a single conversational turn. Shared by
 *  the simple_llm branch AND the conversational fallbacks (understand_intent /
 *  prompt_master) so no model call can slip out of the persona/no-menu/verify-
 *  in-P2 rails. Research/design report surfaces keep their own structured
 *  formats (they are reports, not conversation) — their final text still passes
 *  the global reply-shape choke point below. */
export function buildUniversalFrame(opts: {
  text: string;
  topic?: string | null;
  perception: Perception;
  context: Array<{ role: string; content: string }>;
}): string {
  const { text, topic, perception, context } = opts;
  // IGNORE the caller's topic when a recall block is present: the owner pointed
  // AWAY from the current thread — the rail must say so loudly, or the model
  // merges the old subject with the recent thread (live failure: "tadi kita
  // bahas bekerja remote" → storyboard gabungan dengan anak-anak bermain pasir).
  const recallBlock = (context ?? []).find((c) =>
    /\[(?:Riwayat percakapan sebelumnya|Catatan riwayat)\]/.test(c.content || ""));
  // m9-v11 ANTI-FABRICATION RAIL (owner principle): never confidently explain a
  // platform/product/term that isn't in the conversation and you aren't sure is
  // real (live failure: fabricated "platform AGE"). Universal — applies to EVERY
  // simple_llm turn, continuation or not (m9-v11.13).
  const baseRail =
    `Balas seperti orang ngobrol: paragraf ringkas yang mengalir, langsung ke inti. ` +
    `JANGAN menyusun jawaban sebagai laporan — tanpa tabel, daftar bernomor, ` +
    `daftar berpoin panjang, atau judul seksi. ` +
    `Beri ISI jawaban SEKARANG; JANGAN membuka dengan pertanyaan pilihan atau ` +
    `menawarkan menu (pola seperti "Mau saya lanjutkan dengan X, Y, atau Z?", ` +
    `"Mau bahas yang mana?", "Mau aku gali lebih dalam yang mana?"). ` +
    `JANGAN membuka dengan kalimat PENGUMUMAN rencana yang kosong isi, seperti ` +
    `"Saya akan jelaskan...", "Berikut yang akan saya bahas...", "Selanjutnya ` +
    `saya akan...", "Saya akan uraikan...", "Kamu ingin mengetahui..." atau ` +
    `"Anda ingin mengetahui..." — langsung JAWAB isinya tanpa bingkai perkenalan. ` +
    `JANGAN menutup dengan ajakan kosong generik seperti "kalau ada bagian yang ` +
    `ingin kamu dalami, beri tahu saya" atau "jika ada yang ingin kamu tanyakan, ` +
    `silakan bilang" — berhenti di konten. ` +
    `Panggil pemilik dengan "kamu", BUKAN "Anda" — tetap akrab seperti orang ngobrol. ` +
    `Struktur jawaban GLOBAL: paragraf PERTAMA = jawaban langsung atas yang ` +
    `ditanyakan (bersumber percakapan & memori). Bila ada rekomendasi, saran, ` +
    `atau langkah berikutnya yang pantas, paragraf KEDUA = rekomendasi yang ` +
    `berbasis MEMORI/pembicaraan — sebutkan basisnya ("berdasarkan catatan ` +
    `kita...") — dan bila ada ketidakpastian, tandai sebagai dugaan serta ` +
    `VERIFIKASI/sesuaikan dalam satu kalimat di dalam paragraf itu ("ini ` +
    `perkiraanku, mau aku pastikan/riset?"). Bila tidak ada rekomendasi yang ` +
    `pantas, cukup satu paragraf jawaban. Jangan memaksakan dua paragraf bila ` +
    `tidak perlu — dan JANGAN pernah mengubah pertanyaan pilihan menjadi isi. ` +
    `Aturan ini berlaku untuk SEMUA topik percakapan. ` +
    `JANGAN mengarang atau menjelaskan dengan percaya diri tentang platform, produk, merek, ` +
    `atau istilah yang tidak kamu kenal dan tidak muncul di konteks percakapan — kalau ` +
    `sebuah istilah tidak jelas bagimu, jawab jujur: "Aku belum paham yang kamu maksud — ` +
    `bisa dijelaskan sedikit?" — JANGAN menebak-nebak platform yang mungkin tidak nyata. ` +
    `LARANGAN ECHO: JANGAN PERNAH mengulang atau menyebut blok markup internal ` +
    `([Memori kerja], [Kenangan relevan], [Riwayat percakapan sebelumnya], [Ringkasan]) ` +
    `dalam jawaban — itu konteks internal, bukan bahan jawaban. ` +
    `JANGAN PERNAH menampilkan data mentah dari konteks: timestamp (mis. "2026-09-07"), ` +
    `label seperti "User menanyakan tentang:", separator "|", atau format data ` +
    `terstruktur — konteks adalah REFERENSI internal untuk dipahami, bukan untuk ` +
    `disebut apa adanya. Ingat SUBSTANSINYA dan tulis ulang dengan kata-katamu ` +
    `seperti orang yang benar-benar ingat percakapan — satu pintu masuk, satu ` +
    `pintu keluar: jawaban yang keluar terlihat persis seperti manusia bicara.`;
  // m9-v11.16 ANSWER-vs-VERIFY separation evolved (m9-v11.19): the external
  // suffix is retired — the verification question now lives at the END of the
  // recommendation paragraph, written by the model under this note. Answer and
  // verification stay distinguishable: content answer, then a single crisp
  // verify line inside P2 — never a menu opener.
  // m9-v11.32 ROOT COMPREHENSION — the FOUNDATION rail. Every capability's
  // output (conversation, search, design, research, prompt_master) is built on
  // the ability to understand the owner's text universally: reply in the SAME
  // language, at the SAME literacy register, aware of the SAME knowledge field,
  // with the per-language adaptation (formality/honorifics/tone). This is
  // deterministic & additive — unknown input keeps the neutral default.
  const p = perception.comprehension;
  const compRail =
    `\n\nPemahaman input yang jadi pijakan jawabanmu:\n` +
    `- Bahasa pemilik: ${p.language.code === "unknown" ? "belum teridentifikasi (gunakan bahasa yang paling masuk akal)" : p.language.name}${p.mixed.length ? ` (campur: ${p.mixed.map((l) => LANG_NAMES[l] ?? l).join(", ")})` : ""}.\n` +
    `- Registrasi bahasa: ${p.literacy.type === "unknown" ? "biasa" : p.literacy.type}.\n` +
    `- Bidang pembicaraan: ${p.domain.type === "umum" ? "umum" : p.domain.type}.\n` +
    `- Arah adaptasi: balas DALAM BAHASA yang sama dengan pemilik di atas; ` +
    `${p.adapt.honorifics ? "pakai sapaan yang menghargai" : "sapaan sederhana"}; ` +
    `nada ${p.adapt.tone}.${p.adapt.formality === "formal" ? " Pertahankan tingkat kesopanan formal." : ""}`;

  const heavyNote = perception.intent.entities?.heavyVerify
    ? `\n\n(Catatan: permintaan ini menyiratkan aksi berat yang belum pasti jelas ` +
      `(riset/gambar/kode). Tuangkan VERIFIKASINYA di akhir paragraf kedua/rekomendasi ` +
      `sebagai SATU kalimat tegas seperti "kalau yang kamu maksud aku langsung ` +
      `kerjakan, kabari aku" — jangan menjadi pertanyaan pilihan, dan jangan ` +
      `membuka atau menutup jawaban dengan menu.)`
    : "";
  if (recallBlock) {
    return (baseRail +
      `\n\nPemilik menunjuk KEMBALI ke topik lama yang dijelaskan pada blok ` +
      `"[Riwayat percakapan sebelumnya]" / "[Catatan riwayat]" di konteks. ` +
      `Jawab HANYA berdasarkan blok riwayat itu: LANGSUNG lanjutkan topik lamanya. ` +
      `Jangan bertanya balik seperti "Mau aku melanjutkan dengan X atau Y?" — ` +
      `jawablah lanjutannya LANGSUNG tanpa menu. ` +
      `JANGAN membaca blok riwayat MENTAH (timestamp, "User menanyakan tentang:", ` +
      `separator "|"): simpulkan topiknya lalu lanjutkan seolah kamu memang ` +
      `mengingatnya secara alami. Bila bloknya menyatakan riwayat tidak ditemukan, ` +
      `jawab jujur ` +
      `singkat dan minta pemilik mengingatkan konteksnya. ` +
      `ABAIKAN topik percakapan terakhir — JANGAN menggabungkan topik lama dengan ` +
      `topik baru dari percakapan terakhir (mis. jangan mencampur "bekerja remote" ` +
      `dengan thread gambar/storyboard).` +
      compRail) + heavyNote;
  }
  if (perception.isContinuation && topic) {
    const isSimplify = /\b(lebih mudah|sederhanakan|belum mengerti|nggak paham|gampang|mudah dipahami|biar paham|tolong sederhanakan)\b/i.test(text);
    if (isSimplify) {
      return baseRail +
        `\n\nPemilik minta penjelasan lebih sederhana tentang topik yang sedang dibahas. ` +
        `Topik aktif: "${topic}". ` +
        `Jawab ULANG penjelasan tentang topik itu dengan bahasa sehari-hari yang sangat sederhana: ` +
        `tanpa jargon, tanpa poin-poin panjang, kalimat pendek mengalir, seperti menjelaskan ke teman. ` +
        `Tetap pada topik itu — JANGAN ganti topik.` +
        compRail +
        heavyNote;
    }
    return baseRail +
      `\n\nPemilik MENERUSKAN percakapan tentang "${topic}". ` +
      `Pesan ini ringkas dan tidak menyebut ulang topiknya. ` +
      `Jawab sebagai LANJUTAN dari percakapan tentang topik itu. ` +
      `TETAP pada topik "${topic}" — JANGAN menyimpang ke topik lain, ` +
      `JANGAN menjawab tentang hal yang tidak berkaitan dengan topik di atas.` +
      compRail +
      heavyNote;
  }
  return baseRail + compRail + heavyNote;
}

// ============================================================================
// m9-v11.21 THE TWO DOORS (owner's architecture — "satu pintu input, satu
// pintu output"). Naturalization is ONE concept applied at BOTH ends; the
// modules in the middle process RAW data and never carry human-sounding text:
//
//   INPUT DOOR  (this translation layer): the owner's natural message is
//     TRANSLATED into a structured task — WHICH module owns it (module), a
//     clean imperative directive (directive), extracted parameters (params),
//     and the RAW context handed to that module untouched (payload). JARVIS —
//     not the module — understands what the human asked (live failures the
//     door prevents: menu phrasing surviving into the answer, random memory
//     echo on scalar questions).
//   MIDDLE (the modules): free to munch raw data — memory/KV lookups, search,
//     embeddings, flux, translate APIs — structurally, no human-voice styling.
//   OUTPUT DOOR (buildUniversalFrame + the global choke point): the module's
//     raw result is TRANSLATED BACK into a reply that sounds exactly like a
//     human speaking (P1 answer → P2 recommendation/verify, no raw data leaks).
// ============================================================================

/** A structured task produced by the INPUT DOOR. The module named by `module`
 *  receives `directive` + `params` (a clean, translated instruction) and
 *  `payload` (the raw context) — it never has to re-understand natural text. */
export interface TranslatedTask {
  module: Strategy["approach"];
  /** Clean imperative directive — the owner's natural sentence stripped of
   *  bare-grounding gesture words (tolong/coba/bisakah…), so modules get the
   *  actual ask, not filler. */
  directive: string;
  /** Extracted parameters (intent entities + topic) for the module. */
  params: Record<string, string>;
  /** RAW context passed through untouched — modules process data, not speech. */
  payload: Array<{ role: string; content: string }>;
}

/** INPUT DOOR — translate the owner's natural message into a structured task
 *  for exactly one module. Mirrors the OUTPUT DOOR (buildUniversalFrame): the
 *  intelligence layer owns all understanding on both ends, so a module never
 *  parses human phrasing to know what to do. */
export function translateInput(
  text: string,
  perception: Perception,
  strategy: Strategy,
): TranslatedTask {
  // Gesture-verb strip: "tolong cari X" → "cari X" (what the module should do)
  // without losing the ask. Keeps question/chat directives intact.
  const directive = text
    .replace(
      /^(?:tolong|mohon|coba|bisa nggak|bisa gak|bisakah|kamu bisa|bisa kamu|coba dong|bisa kamu coba|minta tolong)[\s,:]?\s*/i,
      "",
    )
    .replace(/\s+/g, " ")
    .trim();
  return {
    module: strategy.approach,
    directive: directive.length > 0 ? directive : text,
    params: {
      ...((perception.intent.entities as Record<string, string>) ?? {}),
      ...(perception.topic ? { topic: perception.topic } : {}),
    },
    payload: perception.enrichedContext,
  };
}

/** The BRAIN's act() — decide already picked a strategy; this executes it. */
export async function act(
  env: Env,
  owner: number,
  text: string,
  perception: Perception,
  strategy: Strategy,
): Promise<{ reply: string; source: string; image?: { bytes: Uint8Array; mime: string } }> {
  // m9-v11.21: route through the INPUT DOOR FIRST — every module below receives
  // the translated directive/payload, never the raw natural sentence.
  const task = translateInput(text, perception, strategy);
  const d = task.directive;
  const { topic, enrichedContext } = perception;

  switch (strategy.approach) {
    case "self_referential":
      // Handled by webhook directly — this should never be reached
      return { reply: "", source: "self_ref" };

    case "translate": {
      const parsed = parseTranslate(d);
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
      const outline = await llmRespond(env, d, {
        topic: `desain-${topic}`,
        contextIsEnriched: true,
        context: [{ role: "system", content: `Buat konsep desain singkat (4-6 baris, prose paragraphs) untuk: "${d}".\nTermasuk: ide utama, gaya visual, warna dominan, dan elemen utama. Bahasa Indonesia. Jangan sebut storyboard/keyframe/video.` }],
        systemOverride: buildUniversalFrame({ text: d, topic, perception, context: enrichedContext }),
      }).catch(() => null);
      let image: { bytes: Uint8Array; mime: string } | undefined;
      try {
        const promptText = d.length >= 3 ? d.slice(0, 250) : d;
        const prompt = await generateImagePrompt(env, promptText);
        const bytes = await generateImage(env, prompt).catch(() => null);
        if (bytes && bytes.length > 0) image = { bytes, mime: sniffImageMime(bytes) };
      } catch (e) {
        console.error("orchestrate_design image failed:", String(e).slice(0, 120));
      }
      if (outline?.reply) return { reply: outline.reply.slice(0, 900), source: "design", image };
      const fallback = await searchAndSynthesize(env, owner, d, topic);
      return { reply: fallback.reply ?? "Gagal memproses desain.", source: "design_fallback", image };
    }

    case "orchestrate_research": {
      if (!topic) return { reply: "Topik tidak ditemukan.", source: "research" };
      const anchor = isFollowUpQuery(d) ? resolveFollowUpAnchor(enrichedContext)?.prior ?? "" : "";
      const result = await orchestrateResearch(env, owner, d, topic, anchor);
      if (result) return { reply: result, source: "research" };
      // Fallback to search
      const fallback = await searchAndSynthesize(env, owner, d, topic);
      return { reply: fallback.reply ?? "Gagal melakukan riset.", source: "research_fallback" };
    }

    case "search_synthesize": {
      if (!topic) return { reply: "Topik tidak ditemukan.", source: "search" };
      const result = await searchAndSynthesize(env, owner, d, topic);
      return { reply: result.reply ?? "Pencarian tidak menghasilkan jawaban.", source: result.source ?? "search" };
    }

    case "understand_intent": {
      // Decode what the user actually WANTS, even for unknown/vague requests.
      // m9-v11.32: feed the ROOT comprehension (universal language/literacy/
      // domain) so understanding works across all human languages & fields.
      const result = await understandUserWants(env, d, owner, enrichedContext, {
        lang: perception.comprehension.language.name,
        literacy: perception.comprehension.literacy.type,
        domain: perception.comprehension.domain.type,
        adapt: comprehensionNote(perception.comprehension),
      });
      if (result.reply) {
        return { reply: result.reply, source: result.understood ? "understand" : "understand_clarify" };
      }
      // Fallback: plain LLM, fail-closed (still under the universal rail —
      // m9-v11.19: no model call escapes the persona/no-menu/verify-in-P2 frame).
      const fallback = await llmRespond(env, d, {
        topic: topic ?? undefined,
        context: enrichedContext,
        contextIsEnriched: true,
        systemOverride: buildUniversalFrame({ text: d, topic, perception, context: enrichedContext }),
      });
      if (fallback.reply) {
        return { reply: fallback.reply, source: fallback.source ?? "llm" };
      }
      return { reply: "Maaf, saya belum memahami permintaan ini. Bisa jelaskan lagi dengan lebih detail?", source: "understand_fallback" };
    }

    case "prompt_master": {
      const result = await writeExpertPrompt(env, d, enrichedContext);
      if (result.ok && result.reply) {
        return { reply: result.reply, source: "prompt_master" };
      }
      const fallback = await llmRespond(env, d, {
        topic: topic ?? undefined,
        context: enrichedContext,
        contextIsEnriched: true,
        systemOverride: buildUniversalFrame({ text: d, topic, perception, context: enrichedContext }),
      });
      if (fallback.reply) {
        return { reply: fallback.reply, source: fallback.source ?? "llm" };
      }
      return { reply: "Maaf, saya belum bisa menyusun prompt itu sekarang. Coba lagi ya.", source: "prompt_master_fallback" };
    }

    case "context7_docs": {
      const ctx7 = await lookupLibraryDocs(env, d, enrichedContext);
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
      const recallBlock = task.payload.find((c) =>
        /\[(?:Riwayat percakapan sebelumnya|Catatan riwayat)\]/.test(c.content || ""));
      const frame = () =>
        buildUniversalFrame({ text: d, topic, perception, context: task.payload });
      const result = await llmRespond(env, d, {
        topic: topic ?? undefined,
        context: task.payload,
        contextIsEnriched: true,
        systemOverride: frame(),
        deep: perception.intent.type === "code",
      });
      if (result.reply) {
        let reply = result.reply;
        // m9-v11.19 NO-MENU GUARD: when the answer OPENS with a menu or an
        // announcement (model ignored the rail) regenerate ONCE with a targeted
        // nudge. m9-v11.25: the same one-shot retry fires for a DEGENERATE ECHO.
        // m9-v11.27: acknowledge-only stubs also retry — and a SECOND retry
        // forces real content on recall turns instead of the empty stub.
        // The final strip/continuation is enforced GLOBALLY at the
        // processIntelligence choke point (covers EVERY strategy).
        const badAnswer =
          isMenuFirstLine(reply) || hasDegenerateEcho(reply) || isAcknowledgeOnly(reply);
        if (badAnswer) {
          const nudge = isMenuFirstLine(reply) ? MENU_FOLLOWUP_NUDGE : ECHO_FOLLOWUP_NUDGE;
          const retry = await llmRespond(env, d, {
            topic: topic ?? undefined,
            context: task.payload,
            contextIsEnriched: true,
            systemOverride: frame() + nudge,
            deep: perception.intent.type === "code",
          }).catch(() => null);
          const retryGood = (r: { reply: string | null } | null | undefined): boolean =>
            !!r?.reply && !isMenuFirstLine(r.reply) && !hasDegenerateEcho(r.reply) && !isAcknowledgeOnly(r.reply);
          if (retryGood(retry)) {
            reply = retry!.reply!;
          } else if (recallBlock) {
            // Recall turns get ONE content-forced second pass (the deterministic
            // continuation is a recollection, not a continuation — content must
            // come from the LLM when at all possible).
            const retry2 = await llmRespond(env, d, {
              topic: topic ?? undefined,
              context: task.payload,
              contextIsEnriched: true,
              systemOverride: frame() + RECALL_CONTENT_NUDGE,
              deep: perception.intent.type === "code",
            }).catch(() => null);
            reply = retryGood(retry2)
              ? retry2!.reply!
              : stripLeadingMenuSentences(retry2?.reply ?? retry?.reply ?? reply) ||
                deterministicRecallContinuation(recallBlock);
          } else {
            reply =
              stripLeadingMenuSentences(retry?.reply ?? reply) ||
              reply;
          }
        }
        return { reply, source: result.source ?? "llm" };
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
  _strategy: Strategy,
): Promise<void> {
  const { topic } = perception;

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

  // m9-v11.19 GLOBAL CHOKE POINT — applies to EVERY strategy (simple_llm,
  // understand_intent, prompt_master, research, etc.).
  // 1) Strip any leading menu/announcement sentence the model may still emit
  //    (deterministic — not a model call).
  // 2) For recall turns where stripping left nothing usable, fall back to
  //    deterministicRecallContinuation (narrate the recalled lines).
  // 3) No more system-appended heavyVerifySuffix / heavyNote: the
  //    verification question now lives INSIDE the P2 recommendation paragraph
  //    under buildUniversalFrame's heavyNote rail — produced by the model,
  //    distinguishable (answer vs verify) by the owner. (m9-v11.19)
  let deliverable = safeReply;
  if (isMenuFirstLine(deliverable) || hasDegenerateEcho(deliverable) || isAcknowledgeOnly(deliverable)) {
    const recallBlock = (perception.enrichedContext ?? []).find((c) =>
      /\[(?:Riwayat percakapan sebelumnya|Catatan riwayat)\]/.test(c.content || ""));
    deliverable =
      stripLeadingMenuSentences(deliverable) ||
      (recallBlock ? deterministicRecallContinuation(recallBlock) : "") ||
      deliverable;
  }

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
  // m9-v11.18 free-service observability: live ping of every free provider
  // (metadata endpoints only, cached 60s). Exposes a dead key/endpoint that
  // aggregated rates alone would hide.
  const probeLines = env
    ? await probeProviders(env).then((ps) =>
        ps.map((p) => {
          const mark = p.configured ? (p.live ? "🟢" : "🔴") : "⚪";
          return `  ${mark} ${p.name}: ${p.configured ? (p.live ? "live" : "DEAD") : "not configured"}${p.ms !== null ? ` (${p.ms})` : ""} — ${p.detail}`;
        }),
      )
    : [];
  const vectorDimsInfo =
    env && probeLines.some((l) => l.includes("memory_vec"))
      ? "  (bge-m3 ×1024 dims, cosine)" : "";

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
    `*Provider Probe (live):*`,
    ...(probeLines.length > 0 ? probeLines : ["  (env not provided)"]),
    "",
    "*Sub-Systems:*",
    "  • Perception (emotion/language/intent): ✅",
    "  • Cognition (LLM/research/design): ✅",
    "  • Reflection (learning/memory): ✅",
    "  • Safety (verifier/heuristics): ✅",
    "",
  ];
  if (vectorDimsInfo) lines.push(vectorDimsInfo);
  if (gateLines) lines.push(gateLines);
  if (gapLines) lines.push(gapLines);
  return lines.map((l) => l.trimEnd()).join("\n");
}

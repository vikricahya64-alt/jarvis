//=====================================================================
// response_formatter.ts — adaptive response formatting for JARVIS.
//
// Transforms raw LLM output into naturally formatted Telegram messages:
// - Markdown bold/italic for emphasis
// - Emoji sparingly for tone (not overdone)
// - Bullet points for lists
// - Length adaptation based on query complexity
// - Emoji-free zones (formal/sensitive topics)
// - Citation formatting for research results
// - Progress indicators for long operations
// - Adaptive verbosity based on user preferences
//
// Design references:
// - Grice Maxims (1975): quantity, quality, manner, relevance
// - Nielsen Norman Group (2020): readability on mobile screens
// - Telegram MarkdownV2 spec for formatting
// - Mem0 (2025): context compression for cost reduction
// - Observational Memory (VentureBeat 2025): dated structured notes
//=====================================================================

/** Format configuration based on query type. */
export interface FormatConfig {
  useEmoji: boolean;
  maxParagraphs: number;
  useBold: boolean;
  useBullets: boolean;
  lineBreaks: "single" | "double";
  /** Max words for chat responses */
  maxWordsChat: number;
  /** Whether to include source citations */
  includeCitations: boolean;
}

/** Default format configs by conversation mode. */
const FORMAT_PRESETS: Record<string, FormatConfig> = {
  chat: {
    useEmoji: true,
    maxParagraphs: 6,
    useBold: false,
    useBullets: false,
    lineBreaks: "single",
    maxWordsChat: 150,
    includeCitations: false,
  },
  research: {
    useEmoji: false,
    maxParagraphs: 16,
    useBold: false,
    useBullets: false,
    lineBreaks: "double",
    maxWordsChat: 900,
    includeCitations: true,
  },
  code: {
    useEmoji: true,
    maxParagraphs: 12,
    useBold: false,
    useBullets: false,
    lineBreaks: "double",
    maxWordsChat: 900,
    includeCitations: false,
  },
  command: {
    useEmoji: true,
    maxParagraphs: 1,
    useBold: true,
    useBullets: false,
    lineBreaks: "single",
    maxWordsChat: 20,
    includeCitations: false,
  },
  translation: {
    useEmoji: false,
    maxParagraphs: 1,
    useBold: false,
    useBullets: false,
    lineBreaks: "single",
    maxWordsChat: 100,
    includeCitations: false,
  },
  emergency: {
    useEmoji: true,
    maxParagraphs: 1,
    useBold: true,
    useBullets: false,
    lineBreaks: "single",
    maxWordsChat: 20,
    includeCitations: false,
  },
};

/** Adapt response length based on query complexity and user preferences. */
export function adaptLength(
  reply: string,
  queryType: string,
  userText: string,
  preferredLength?: "short" | "normal" | "detailed",
): string {
  const words = reply.split(/\s+/);
  const queryLen = userText.split(/\s+/).length;
  const config = FORMAT_PRESETS[queryType] ?? FORMAT_PRESETS.chat;

  // Determine target length based on preferences and query
  let targetWords = config.maxWordsChat;

  if (preferredLength === "short") targetWords = Math.min(targetWords, 20);
  if (preferredLength === "detailed") targetWords = Math.max(targetWords, 100);
  if (queryLen > 5) targetWords = Math.max(targetWords, 50); // longer queries deserve longer answers

  // Complex query → allow longer answer
  if (queryType === "research" && words.length < 30) {
    return reply;
  }

  // Chat/other: let the reply flow naturally — the LLM's own length is
  // respected (only "short" preference trims). Hard caps live in the
  // Telegram chunker, not here, so answers aren't chopped mid-thought.
  return reply;
}

/** Research rails (owner principle: "prosa naratif + URL terverifikasi saja").
 *  Deterministic post-processor that turns LLM research output into BODY prose:
 *  - Unwraps every markdown link "[label](url)" → plain "url" text. Because the
 *    caller only feeds this text AFTER sanitizeUncitedLinks, every surviving URL
 *    is already verified against the real search hits; plain URLs render
 *    clickably in Telegram and can never show mangled "](...)" brackets.
 *  - Flattens bullet/header artifacts into sentences and strips the
 *    report-style openers/closers ("Berikut rangkuman…", "Intinya, …").
 *  - Never touches fenced code blocks (code answers keep their structure).
 *  Pure, idempotent, never throws. */
export function proseifyResearch(text: string): string {
  if (!text) return text;
  let t = text;

  // 1. Quarantine fenced code so the link/bullet rules never touch code.
  const fences: string[] = [];
  t = t.replace(/```[\s\S]*?```/g, (m: string) => {
    fences.push(m);
    return `\uE010FENCE${fences.length - 1}\uE011`;
  });

  // 2. Markdown links → plain verified URL. Repair the observed production
  //    leak shape first: a URL-like token followed by "](url)" (the opening
  //    "[" was swallowed by sanitization), then unwrap well-formed links.
  t = t.replace(/([^\s\[\]]+)\]\(\s*(https?:\/\/[^\s)]+)\)/g, (_m, _label: string, url: string) => url);
  t = t.replace(/\[([^\]]*)\]\(\s*(https?:\/\/[^\s)]+)\)/g, (_m, _label: string, url: string) => url);

  // 3. Header lines: strip bold/italic markers so a line like
  //    "**Misi utama:** …" becomes "Misi utama: …" (reads as prose, not a
  //    report heading). Supports both "**Label:**" and "**Label:**" colons.
  t = t.replace(/^[*_]{1,2}\s*([^*_\n]{1,120}?)\s*(:?)\s*[*_]{1,2}\s*/gm, (_m, label: string, colon: string) => `${label}${colon} `);

  // 4. Bullet markers → plain sentences.
  t = t.replace(/^\s*(?:[-*•–]|\d+[.)])\s+/gm, "");

  // 4b. Word-ordinal enumeration (the live m9-v11.21 shape: "Pertama, …",
  //     "Kedua, …", "Kelima, …") → drop the ordinal so the list reads as
  //     flowing prose instead of an enumerated report.
  t = t.replace(
    /(^|[.,!?;:]\s+)(Pertama|Kedua|Ketiga|Keempat|Kelima|Keenam|Ketujuh|Kedelapan|Kesembilan|Kesepuluh)\s*[,:]\s*/gi,
    "$1",
  );

  // 5. Report-style openers/closers (Indonesian + English, context-safe).
  t = t
    .replace(/^\s*Berikut\s+(?:adalah\s+)?(?:rangkuman|ringkasan|hasil|informasi)[^\n]*\n{1,3}/im, "")
    .replace(/^\s*Intinya[^\n]*\n{1,2}/im, "")
    .replace(/^\s*Semoga\s+[^\n]*\.\s*\n?/gim, "")
    .replace(/\n*\s*Intinya,?[^\n]*\.?\s*$/im, "");
  t = t.replace(/^\s*Singkatnya[^\n]*\n{1,2}/im, "");
  t = t.replace(/\n*\s*Begitulah[^\n]*\.?\s*$/im, "");

  // 6. Collapse whitespace & blank-line runs (max 2), drop any orphan square
  //    brackets (nothing bracket-y survives in prose research), keep fences.
  t = t
    .replace(/[\[\]]/g, "")
    .replace(/\n{3,}/g, "\n\n").replace(/[ \t]+/g, " ").replace(/ ?\n ?/g, "\n").trim();

  // 7. Restore fenced code.
  return t.replace(/\uE010FENCE(\d+)\uE011/g, (_m, i: string) => fences[Number(i)] ?? _m);
}

/** Clean up common LLM artifacts. */
export function cleanLLMArtifacts(text: string): string {
  if (!text) return text;
  let t = text;
  // Protect intact markdown links so the repairs below can never mangle them.
  const intact: string[] = [];
  t = t.replace(/\[([^\[\]]+)\]\(\s*(https?:\/\/[^\s)]+)\)/g, (m: string) => {
    intact.push(m);
    return `\uE003${intact.length - 1}\uE004`;
  });
  t = t
    // Remove "As an AI..." disclaimers
    .replace(/(?:Sebagai|As)\s+(?:AI|model|bahasa|language)[^.]*\./gi, "")
    // Remove "I hope this helps..." fillers
    .replace(/(?:Semoga|I hope)[^.]*!/gi, "")
    // Remove excessive dashes/bullets
    .replace(/^[-–—]{3,}\s*$/gm, "")
    // Remove duplicate line breaks (max 2)
    .replace(/\n{3,}/g, "\n\n")
    // Repair mangled markdown links the LLM sometimes emits: "(url](url)"
    // or "(url](url))" → single clean "(url)".
    .replace(/\((https?:\/\/[^\s)\]]+)\]\(https?:\/\/[^\s)\]]+\)+/g, "($1)")
    // Repair "[label](url)" links that lost their opening "[" — the observed
    // production leak is "url](url)" (a URL-like label), so bind the label to
    // a single whitespace-delimited token and re-emit valid markdown instead
    // of leaving raw mangled brackets visible in Telegram.
    .replace(/(?<=^|\s)([^\s\[\]]+)\]\(\s*(https?:\/\/[^\s)]+)\)/g, (_m, label: string, url: string) => `[${label}](${url})`);
  return t
    // Restore the protected intact links.
    .replace(/\uE003(\d+)\uE004/g, (_m, i: string) => intact[Number(i)] ?? _m)
    .trim();
}

// ============================================================================
// RECIPROCAL QUESTION (m9-v10) — REMOVED in m9-v11.14. The deterministic
// appender ("Mau aku gali lebih dalam bagian yang mana?") fought the owner's
// persona rail: every substantive answer got a canned menu trailer appended
// even when the model had already closed naturally. The rail (simple_llm) now
// governs turn-taking; no canned follow-up is force-added.
// ============================================================================

/** Format citations in research responses.
 *  Converts bare URLs and source mentions into Markdown links (unless the
 *  caller is the prose-rails research path, where URLs are already
 *  whitelisted + plain and MUST NOT be re-wrapped into "[url](url)" — that
 *  rewrite produced the leaked m9-v9 "itu.int](...)" failure). */
function formatCitations(text: string, wrapLinks: boolean): string {
  // Convert "Source: <url>" or "Sumber: <url>" to Markdown links
  if (wrapLinks) {
    text = text.replace(
      /(?:Source|Sumber|Referensi|Link):\s*(https?:\/\/\S+)/gi,
      "[$1]($1)",
    );
  }

  // Convert inline URLs to clickable links
  text = text.replace(
    /\b(https?:\/\/[^\s,)]+)/g,
    (url) => {
      if (!wrapLinks) return url;
      // Don't re-format already formatted links
      if (text.includes(`[${url}]`)) return url;
      return `[${url}](${url})`;
    },
  );

  // Convert "Menurut X (tahun)" to bold
  text = text.replace(
    /(?:Menurut|According to|Per|Seperti dilaporkan)\s+([A-Z][^.]*?\(\d{4}\))/g,
    "*$1*",
  );

  return text;
}

/** Format response for Telegram (MarkdownV2-safe). */
export function formatForTelegram(
  reply: string,
  mode: string = "chat",
  opts: {
    preferredLength?: "short" | "normal" | "detailed";
    userText?: string;
  } = {},
): string {
  const config = FORMAT_PRESETS[mode] ?? FORMAT_PRESETS.chat;
  let text = cleanLLMArtifacts(reply);

  // Adapt length
  text = adaptLength(text, mode, opts.userText ?? "", opts.preferredLength);

  // Format citations for research mode (prose rails: plain verified URLs,
  // no "[url](url)" markdown re-wrapping).
  if (config.includeCitations) {
    text = formatCitations(text, mode !== "research");
  }

  // Emoji filtering for formal contexts
  if (!config.useEmoji) {
    // Remove common emoji patterns
    text = text.replace(/[\u{1F600}-\u{1F64F}]/gu, "");  // emoticons
    text = text.replace(/[\u{1F300}-\u{1F5FF}]/gu, "");  // symbols
    text = text.replace(/[\u{1F680}-\u{1F6FF}]/gu, "");  // transport
    text = text.replace(/[\u{2600}-\u{26FF}]/gu, "");    // misc symbols
    text = text.replace(/[\u{2700}-\u{27BF}]/gu, "");    // dingbats
  }

  // Paragraph limiting
  const paragraphs = text.split(/\n\n+/);
  if (paragraphs.length > config.maxParagraphs) {
    text = paragraphs.slice(0, config.maxParagraphs).join("\n\n");
  }

  // Clean up excessive whitespace
  text = text.replace(/\n{3,}/g, "\n\n").trim();

  return text;
}

/** Generate a natural acknowledgment before the main reply. */
export function generateAcknowledgment(
  queryType: string,
  sentiment: string,
): string {
  if (queryType === "command") return "";
  if (sentiment === "negative") return "";  // Don't be cheerful when user is upset
  if (queryType === "translation") return "";

  const acks: Record<string, string[]> = {
    chat: ["", "", "", ""],           // Most chats don't need acknowledgment
    research: ["", "", ""],
  };

  const pool = acks[queryType] ?? [""];
  return pool[Math.floor(Math.random() * pool.length)];
}

/** Generate a progress indicator for long operations. */
export function progressIndicator(stage: string): string {
  const indicators: Record<string, string> = {
    searching: "🔍 Mencari...",
    analyzing: "🤔 Menganalisis...",
    synthesizing: "📝 Menyusun...",
    translating: "🌐 Menerjemahkan...",
    reflecting: "💭 Merefleksi...",
    default: "⏳ Memproses...",
  };
  return indicators[stage] ?? indicators.default;
}

/** Build the final reply by combining acknowledgment + formatted response. */
export function buildFinalReply(
  rawReply: string,
  mode: string,
  sentiment: string,
  opts: {
    preferredLength?: "short" | "normal" | "detailed";
    userText?: string;
  } = {},
): string {
  // Owner principle (m9-v9): research output must be NARRATIVE PROSE with only
  // verified URLs (already whitelisted by sanitizeUncitedLinks at the caller).
  // proseifyResearch runs here so NO research reply can leak report styling or
  // mangled "[label](url)" markdown, regardless of which caller produced it.
  const prose = mode === "research" ? proseifyResearch(rawReply) : rawReply;
  const ack = generateAcknowledgment(mode, sentiment);
  const formatted = formatForTelegram(prose, mode, opts);
  return ack ? `${ack}\n\n${formatted}` : formatted;
}

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

/** Clean up common LLM artifacts. */
export function cleanLLMArtifacts(text: string): string {
  return text
    // Remove "As an AI..." disclaimers
    .replace(/(?:Sebagai|As)\s+(?:AI|model|bahasa|language)[^.]*\./gi, "")
    // Remove "I hope this helps..." fillers
    .replace(/(?:Semoga|I hope)[^.]*!/gi, "")
    // Remove excessive dashes/bullets
    .replace(/^[-–—]{3,}\s*$/gm, "")
    // Remove duplicate line breaks (max 2)
    .replace(/\n{3,}/g, "\n\n")
    // Remove leading/trailing whitespace
    .trim()
    // Repair mangled markdown links the LLM sometimes emits: "(url](url)"
    // or "(url](url))" → single clean "(url)".
    .replace(/\((https?:\/\/[^\s)\]]+)\]\(https?:\/\/[^\s)\]]+\)+/g, "($1)");
}

/** Format citations in research responses.
 *  Converts bare URLs and source mentions into Markdown links. */
function formatCitations(text: string): string {
  // Convert "Source: <url>" or "Sumber: <url>" to Markdown links
  text = text.replace(
    /(?:Source|Sumber|Referensi|Link):\s*(https?:\/\/\S+)/gi,
    "[$1]($1)",
  );

  // Convert inline URLs to clickable links
  text = text.replace(
    /\b(https?:\/\/[^\s,)]+)/g,
    (url) => {
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

  // Format citations for research mode
  if (config.includeCitations) {
    text = formatCitations(text);
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
  const ack = generateAcknowledgment(mode, sentiment);
  const formatted = formatForTelegram(rawReply, mode, opts);
  return ack ? `${ack}\n\n${formatted}` : formatted;
}

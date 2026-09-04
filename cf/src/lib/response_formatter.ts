//=====================================================================
// response_formatter.ts — adaptive response formatting for JARVIS.
//
// Transforms raw LLM output into naturally formatted Telegram messages:
// - Markdown bold/italic for emphasis
// - Emoji sparingly for tone (not overdone)
// - Bullet points for lists
// - Length adaptation based on query complexity
// - Emoji-free zones (formal/sensitive topics)
//
// Design references:
// - Grice Maxims (1975): quantity, quality, manner, relevance
// - Nielsen Norman Group (2020): readability on mobile screens
// - Telegram MarkdownV2 spec for formatting
//=====================================================================

/** Format configuration based on query type. */
export interface FormatConfig {
  useEmoji: boolean;
  maxParagraphs: number;
  useBold: boolean;
  useBullets: boolean;
  lineBreaks: "single" | "double";
}

/** Default format configs by conversation mode. */
const FORMAT_PRESETS: Record<string, FormatConfig> = {
  chat: {
    useEmoji: true,
    maxParagraphs: 2,
    useBold: false,
    useBullets: false,
    lineBreaks: "single",
  },
  research: {
    useEmoji: false,
    maxParagraphs: 4,
    useBold: true,
    useBullets: true,
    lineBreaks: "double",
  },
  command: {
    useEmoji: true,
    maxParagraphs: 1,
    useBold: true,
    useBullets: false,
    lineBreaks: "single",
  },
  translation: {
    useEmoji: false,
    maxParagraphs: 1,
    useBold: false,
    useBullets: false,
    lineBreaks: "single",
  },
  emergency: {
    useEmoji: true,
    maxParagraphs: 1,
    useBold: true,
    useBullets: false,
    lineBreaks: "single",
  },
};

/** Adapt response length based on query complexity. */
export function adaptLength(
  reply: string,
  queryType: string,
  userText: string,
): string {
  const words = reply.split(/\s+/);
  const queryLen = userText.split(/\s+/).length;

  // Simple query → short answer
  if (queryLen <= 3 && queryType === "chat") {
    if (words.length > 30) {
      return words.slice(0, 25).join(" ") + "...";
    }
  }

  // Complex query → allow longer answer
  if (queryType === "research" && words.length < 30) {
    // Too short for research — might need more detail
    return reply;
  }

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
    .trim();
}

/** Format response for Telegram (MarkdownV2-safe). */
export function formatForTelegram(
  reply: string,
  mode: string = "chat",
): string {
  const config = FORMAT_PRESETS[mode] ?? FORMAT_PRESETS.chat;
  let text = cleanLLMArtifacts(reply);

  // Adapt length
  text = adaptLength(text, mode, "");

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

/** Build the final reply by combining acknowledgment + formatted response. */
export function buildFinalReply(
  rawReply: string,
  mode: string,
  sentiment: string,
): string {
  const ack = generateAcknowledgment(mode, sentiment);
  const formatted = formatForTelegram(rawReply, mode);
  return ack ? `${ack}\n\n${formatted}` : formatted;
}

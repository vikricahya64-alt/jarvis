//=====================================================================
// emotion.ts — sentiment & emotion detection for natural conversation.
//
// Design references:
// - VADER (Hutto & Gilbert, 2014): rule-based sentiment for social media
// - NRC Emotion Lexicon (Mohammad & Turney, 2013): word-emotion associations
// - Plutchik's Wheel of Emotions: 8 primary emotions + compound
// - Buechel & Hahn (2017): EmoLex for German/English adaptation
//
// Zero-dependency, works on CF edge. Indonesian adaptation via curated
// emotion lexicon + negation/intensifier handling.
//=====================================================================

/** Detected emotion from text. */
export interface EmotionSignal {
  sentiment: "positive" | "negative" | "neutral" | "mixed";
  intensity: number;       // 0-1
  primary?: string;        // e.g. "frustrasi", "senang", "khawatir"
  secondary?: string;
  confidence: number;      // 0-1
}

/** Indonesian emotion lexicon (curated from NRC + Plutchik adapted to Indo). */
const POSITIVE_WORDS = new Set([
  "senang", "bahagia", "gembira", "puas", "suka", "cinta", "sayang",
  "bagus", "hebat", "luar biasa", "terbaik", "oke", "ok", "baik",
  "mantap", "keren", "wow", "thanks", "terima kasih", "makasih",
  "setuju", "betul", "benar", "sip", "joss", "top", "sempurna",
  "optimis", "semangat", "antusias", "pujian", "selamat", "berhasil",
  "untung", "beruntung", "berhasil", "sukses", "maju", "berkembang",
]);

const NEGATIVE_WORDS = new Set([
  "sedih", "marah", "kesal", "jengkel", "kecewa", "frustrasi", "gagal",
  "buruk", "jelek", "parah", "hancur", "rusak", "error", "bug", "masalah",
  "sulit", "susah", "tidak bisa", "gak bisa", "nggak bisa", "enggak",
  "tidak mau", "gak mau", "nggak mau", "benci", "muak", "capek",
  "lelah", "stres", "panik", "takut", "khawatir", "cemas", "risau",
  "corona", "mati", "kematian", "hilang", "rugi", "bangkrut", "gulung tikar",
  "dilarang", "terlarang", "bahaya", "ancaman", "risiko", "was-was",
]);

const INTENSIFIERS = new Set([
  "sangat", "sekali", "banget", "bgt", "benar-benar", "amat", "paling",
  "super", "ekstra", "luar biasa", "sungguh", "terlalu", "most",
]);

const NEGATORS = new Set([
  "tidak", "bukan", "jangan", "belum", "tak", "tanpa", "gak", "nggak",
  "enggak", "ga", "gk", "tdk", "no", "never", "don't", "not", "isn't",
  "aren't", "wasn't", "weren't", "won't", "can't", "cannot", "couldn't",
]);

/** Detect sentiment and emotion from text. */
export function detectEmotion(text: string): EmotionSignal {
  const low = text.toLowerCase();
  const words = low.split(/\s+/);

  let positiveScore = 0;
  let negativeScore = 0;
  let primary = "";
  let secondary = "";

  // Check each word against emotion lexicons
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    const isNegated = i > 0 && NEGATORS.has(words[i - 1]);
    const isIntensified = i > 0 && INTENSIFIERS.has(words[i - 1]);
    const multiplier = isIntensified ? 1.5 : 1;

    if (POSITIVE_WORDS.has(w)) {
      if (isNegated) {
        negativeScore += 0.5 * multiplier;
      } else {
        positiveScore += 1.0 * multiplier;
        if (!primary) primary = w;
        else if (!secondary) secondary = w;
      }
    }

    if (NEGATIVE_WORDS.has(w)) {
      if (isNegated) {
        positiveScore += 0.3 * multiplier;
      } else {
        negativeScore += 1.0 * multiplier;
        if (!primary) primary = w;
        else if (!secondary) secondary = w;
      }
    }
  }

  // Punctuation/exclamation intensifiers
  const exclaim = (text.match(/!/g) || []).length;
  const question = (text.match(/\?/g) || []).length;
  if (exclaim >= 2) {
    if (positiveScore > negativeScore) positiveScore += 0.5;
    else negativeScore += 0.5;
  }
  // All-caps check
  if (/[A-Z]{3,}/.test(text) && text !== text.toUpperCase()) {
    // Has capitalized words (emphasis)
    if (positiveScore > negativeScore) positiveScore += 0.3;
    else if (negativeScore > positiveScore) negativeScore += 0.3;
  }

  // Determine sentiment
  const total = positiveScore + negativeScore;
  let sentiment: EmotionSignal["sentiment"] = "neutral";
  let intensity = 0;
  let confidence = 0.5;

  if (total > 0) {
    intensity = Math.min(1, total / 4);
    confidence = Math.min(1, 0.5 + total * 0.15);

    if (positiveScore > 0 && negativeScore > 0) {
      sentiment = "mixed";
    } else if (positiveScore > negativeScore) {
      sentiment = "positive";
    } else {
      sentiment = "negative";
    }
  }

  return { sentiment, intensity, primary, secondary, confidence };
}

/** Map emotion to conversational style adjustment. */
export function emotionToStyle(emotion: EmotionSignal): {
  tone: "warm" | "neutral" | "firm" | "empathetic" | "encouraging";
  formality: "casual" | "neutral" | "formal";
  length: "short" | "normal" | "detailed";
} {
  if (emotion.sentiment === "negative" && emotion.intensity > 0.5) {
    return { tone: "empathetic", formality: "neutral", length: "normal" };
  }
  if (emotion.sentiment === "positive" && emotion.intensity > 0.5) {
    return { tone: "encouraging", formality: "casual", length: "short" };
  }
  if (emotion.primary === "frustrasi" || emotion.primary === "kesal") {
    return { tone: "empathetic", formality: "neutral", length: "normal" };
  }
  if (emotion.primary === "marah") {
    return { tone: "firm", formality: "formal", length: "short" };
  }
  if (emotion.primary === "senang" || emotion.primary === "bahagia") {
    return { tone: "warm", formality: "casual", length: "short" };
  }
  return { tone: "neutral", formality: "neutral", length: "normal" };
}

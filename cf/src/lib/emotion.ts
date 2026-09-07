//=====================================================================
// emotion.ts — sentiment & emotion detection with continuous mood tracking.
//
// Design references:
// - VADER (Hutto & Gilbert, 2014): rule-based sentiment for social media
// - NRC Emotion Lexicon (Mohammad & Turney, 2013): word-emotion associations
// - Plutchik's Wheel of Emotions: 8 primary emotions + compound
// - EAC-Agent (Jamil et al., 2026): multimodal emotion-aware conversational AI
// - EmotiCare (2025): long-term mood tracking with LLMs
// - MemRL (2026): runtime reinforcement on episodic memory
//
// Upgrades over v1:
// - Plutchik 8-emotion classification (joy, trust, fear, surprise, sadness,
//   disgust, anger, anticipation)
// - Continuous mood tracking across turns (emotion memory)
// - Mood trajectory: detects if user is getting better/worse
// - Compound emotion detection (anger+disgust = contempt, fear+surprise = awe)
// - Emoji-to-emotion mapping (emojis are emotional signals)
// - Sarcasm/heavy-sigh detection via pattern cues
// - Anti-sycophancy: mood tracking informs tone but never overrides truth
//=====================================================================

/** Detected emotion from text. */
export interface EmotionSignal {
  sentiment: "positive" | "negative" | "neutral" | "mixed";
  intensity: number;       // 0-1
  primary?: string;        // e.g. "frustrasi", "senang", "khawatir"
  secondary?: string;
  confidence: number;      // 0-1
  plutchik?: PlutchikEmotion;  // 8-emotion classification
  emojis?: string[];       // detected emoji signals
}

/** Plutchik's 8 primary emotions + compound emotions. */
export type PlutchikEmotion =
  | "joy" | "trust" | "fear" | "surprise"
  | "sadness" | "disgust" | "anger" | "anticipation"
  | "love" | "optimism" | "submission" | "awe"
  | "disapproval" | "remorse" | "contempt" | "aggressiveness"
  | "neutral";

/** Plutchik wheel mapping: word -> [emotion, intensity]. */
const PLUTCHIK_LEXICON: Record<string, [PlutchikEmotion, number][]> = {
  // Joy
  senang: [["joy", 0.8]], bahagia: [["joy", 0.9]], gembira: [["joy", 0.85]],
  puas: [["joy", 0.6]], suka: [["joy", 0.7]], cinta: [["joy", 0.9]],
  sayang: [["joy", 0.8]], bagus: [["joy", 0.6]], hebat: [["joy", 0.7]],
  "luar biasa": [["joy", 0.85]], terbaik: [["joy", 0.8]], mantap: [["joy", 0.7]],
  keren: [["joy", 0.7]], wow: [["joy", 0.6]], thanks: [["joy", 0.5]],
  "terima kasih": [["joy", 0.6]], makasih: [["joy", 0.5]], setuju: [["trust", 0.6]],
  optimis: [["joy", 0.5], ["anticipation", 0.6]], semangat: [["joy", 0.7], ["anticipation", 0.5]],
  berhasil: [["joy", 0.7]], sukses: [["joy", 0.7]], selamat: [["joy", 0.6]],
  // Trust
  setuju2: [["trust", 0.7]], percaya: [["trust", 0.8]], yakin: [["trust", 0.7]],
  andal: [["trust", 0.7]], bisa: [["trust", 0.5]], baik: [["trust", 0.5]],
  // Fear
  takut: [["fear", 0.9]], khawatir: [["fear", 0.7]], cemas: [["fear", 0.7]],
  risau: [["fear", 0.6]], panik: [["fear", 0.9]], "was-was": [["fear", 0.6]],
  ngeri: [["fear", 0.8]], seram: [["fear", 0.7]], bahaya: [["fear", 0.7]],
  ancaman: [["fear", 0.7]], risiko: [["fear", 0.5]],
  // Surprise
  kaget: [["surprise", 0.8]], terkejut: [["surprise", 0.8]],
  "tidak menyangka": [["surprise", 0.7]], ternyata: [["surprise", 0.5]],
  // Sadness
  sedih: [["sadness", 0.8]], kecewa: [["sadness", 0.8]],
  frustasi: [["sadness", 0.7], ["anger", 0.4]], galau: [["sadness", 0.7]],
  hancur: [["sadness", 0.9]], kehilangan: [["sadness", 0.8]],
  // Disgust
  benci: [["disgust", 0.9]], muak: [["disgust", 0.8]],
  jelek: [["disgust", 0.6]], parah: [["disgust", 0.6]],
  // Anger
  marah: [["anger", 0.9]], kesal: [["anger", 0.7]], jengkel: [["anger", 0.7]],
  gagal: [["anger", 0.5], ["sadness", 0.4]], error: [["anger", 0.4]],
  bug: [["anger", 0.4]], masalah: [["anger", 0.4]],
  // Anticipation
  penasaran: [["anticipation", 0.7]], menunggu: [["anticipation", 0.5]],
  tunggu: [["anticipation", 0.5]], upcoming: [["anticipation", 0.6]],
  rencana: [["anticipation", 0.5]], planning: [["anticipation", 0.5]],
};

/** Emoji → Plutchik emotion mapping. */
const EMOJI_EMOTION: Record<string, [PlutchikEmotion, number][]> = {
  "😀": [["joy", 0.7]], "😃": [["joy", 0.7]], "😄": [["joy", 0.8]],
  "😁": [["joy", 0.7]], "😆": [["joy", 0.8]], "😂": [["joy", 0.9]],
  "🤣": [["joy", 0.9]], "😊": [["joy", 0.6]], "😇": [["joy", 0.5], ["trust", 0.5]],
  "🙂": [["joy", 0.4]], "🙃": [["joy", 0.3]], "😉": [["joy", 0.4]],
  "😍": [["joy", 0.9], ["trust", 0.7]], "🥰": [["joy", 0.9], ["trust", 0.8]],
  "😘": [["joy", 0.8]], "😗": [["joy", 0.6]], "😚": [["joy", 0.6]],
  "😙": [["joy", 0.5]], "🥲": [["joy", 0.4], ["sadness", 0.3]],
  "😋": [["joy", 0.6]], "😛": [["joy", 0.5]], "😜": [["joy", 0.6]],
  "🤪": [["joy", 0.7]], "😝": [["joy", 0.6]], "🤑": [["joy", 0.5]],
  "🤗": [["trust", 0.7], ["joy", 0.5]], "🤭": [["surprise", 0.4], ["joy", 0.3]],
  "🤫": [["trust", 0.4]], "🤔": [["anticipation", 0.5]],
  "🫡": [["trust", 0.6]], "🤐": [["trust", 0.3]],
  "😐": [["neutral", 0.5]], "😑": [["neutral", 0.4], ["disgust", 0.2]],
  "😶": [["neutral", 0.4]], "😏": [["joy", 0.3], ["anticipation", 0.3]],
  "😒": [["disgust", 0.5]], "🙄": [["disgust", 0.6]], "😬": [["fear", 0.3]],
  "😮‍💨": [["sadness", 0.4]], "🤥": [["disgust", 0.3]],
  "😌": [["joy", 0.4], ["trust", 0.4]], "😔": [["sadness", 0.6]],
  "😪": [["sadness", 0.4]], "🤤": [["joy", 0.3]], "😴": [["sadness", 0.2]],
  "😷": [["fear", 0.3], ["sadness", 0.2]], "🤒": [["sadness", 0.4]],
  "🤕": [["sadness", 0.5]], "🤢": [["disgust", 0.7]], "🤮": [["disgust", 0.9]],
  "🥵": [["anger", 0.3]], "🥶": [["fear", 0.3]],
  "🥴": [["surprise", 0.3], ["sadness", 0.2]], "😵": [["surprise", 0.5]],
  "🤯": [["surprise", 0.9]], "🤠": [["joy", 0.6]], "🥳": [["joy", 0.8]],
  "🥸": [["surprise", 0.3]], "😎": [["joy", 0.5], ["trust", 0.5]],
  "🤓": [["trust", 0.4]], "🧐": [["anticipation", 0.4]],
  "😕": [["sadness", 0.3], ["surprise", 0.2]], "🫤": [["sadness", 0.2]],
  "😟": [["sadness", 0.4], ["fear", 0.3]], "🙁": [["sadness", 0.4]],
  "☹️": [["sadness", 0.5]], "😮": [["surprise", 0.6]],
  "😯": [["surprise", 0.6]], "😲": [["surprise", 0.8]],
  "😳": [["surprise", 0.7], ["fear", 0.4]], "🥺": [["sadness", 0.5], ["trust", 0.4]],
  "🥹": [["sadness", 0.4], ["joy", 0.3]], "😦": [["surprise", 0.5], ["sadness", 0.3]],
  "😧": [["sadness", 0.5], ["anger", 0.3]], "😨": [["fear", 0.8]],
  "😰": [["fear", 0.7], ["sadness", 0.4]], "😥": [["sadness", 0.6]],
  "😢": [["sadness", 0.8]], "😭": [["sadness", 0.9]],
  "😱": [["fear", 0.9], ["surprise", 0.8]], "😖": [["sadness", 0.6], ["anger", 0.4]],
  "😣": [["sadness", 0.5], ["anger", 0.4]], "😞": [["sadness", 0.7]],
  "😓": [["sadness", 0.5]], "😩": [["sadness", 0.6], ["anger", 0.3]],
  "😫": [["sadness", 0.6]], "🥱": [["sadness", 0.3]],
  "😤": [["anger", 0.8]], "😡": [["anger", 0.9]], "🤬": [["anger", 0.95]],
  "😈": [["anger", 0.4], ["joy", 0.3]], "👿": [["anger", 0.7]],
  "💀": [["surprise", 0.4]], "☠️": [["fear", 0.5]],
  "💩": [["disgust", 0.4]], "🤡": [["disgust", 0.3], ["surprise", 0.2]],
  "👻": [["fear", 0.3], ["surprise", 0.3]], "👽": [["surprise", 0.5]],
  "🤖": [["trust", 0.3]], "👹": [["fear", 0.5], ["anger", 0.4]],
  "👺": [["anger", 0.6]],
  "❤️": [["joy", 0.8], ["trust", 0.8]], "🧡": [["joy", 0.7]],
  "💛": [["joy", 0.7]], "💚": [["joy", 0.6], ["trust", 0.5]],
  "💙": [["trust", 0.7]], "💜": [["trust", 0.6], ["joy", 0.5]],
  "🖤": [["sadness", 0.4]], "🤍": [["trust", 0.6]],
  "🤎": [["trust", 0.5]], "💔": [["sadness", 0.9]],
  "❣️": [["joy", 0.7]], "💕": [["joy", 0.8], ["trust", 0.7]],
  "💞": [["joy", 0.8]], "💓": [["joy", 0.7]], "💗": [["joy", 0.7]],
  "💖": [["joy", 0.8]], "💘": [["joy", 0.7], ["anticipation", 0.5]],
  "💝": [["joy", 0.7], ["trust", 0.6]], "👍": [["trust", 0.6]],
  "👎": [["disgust", 0.5], ["anger", 0.4]], "👏": [["joy", 0.6]],
  "🙌": [["joy", 0.7]], "🤝": [["trust", 0.7]], "🙏": [["trust", 0.5], ["anticipation", 0.4]],
  "💪": [["trust", 0.6], ["anticipation", 0.5]], "🫶": [["joy", 0.7], ["trust", 0.6]],
};

const PLUTCHIK_WORDS = new Set(Object.keys(PLUTCHIK_LEXICON));

const POSITIVE_WORDS = new Set([
  "senang", "bahagia", "gembira", "puas", "suka", "cinta", "sayang",
  "bagus", "hebat", "luar biasa", "terbaik", "mantap", "keren", "wow",
  "thanks", "terima kasih", "makasih", "setuju", "betul", "benar",
  "sip", "joss", "top", "sempurna", "optimis", "semangat", "antusias",
  "pujian", "selamat", "berhasil", "untung", "beruntung", "sukses",
  "maju", "berkembang",
]);

const NEGATIVE_WORDS = new Set([
  "sedih", "marah", "kesal", "jengkel", "kecewa", "frustrasi", "gagal",
  "buruk", "jelek", "parah", "hancur", "rusak", "error", "bug", "masalah",
  "sulit", "susah", "tidak bisa", "gak bisa", "nggak bisa",
  "tidak mau", "gak mau", "benci", "muak", "capek", "lelah",
  "stres", "panik", "takut", "khawatir", "cemas", "risau",
  "mati", "hilang", "rugi", "dilarang", "bahaya", "ancaman", "risiko",
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

// Compound emotions (Plutchik pairs)
const COMPOUND_EMOTIONS: Record<string, PlutchikEmotion> = {
  "joy+trust": "love",
  "joy+anticipation": "optimism",
  "trust+fear": "submission",
  "fear+surprise": "awe",
  "surprise+sadness": "disapproval",
  "sadness+disgust": "remorse",
  "disgust+anger": "contempt",
  "anger+anticipation": "aggressiveness",
};

/** User mood state tracked across turns. */
export interface MoodState {
  current: PlutchikEmotion | "neutral";
  intensity: number;
  trajectory: "improving" | "declining" | "stable";
  history: Array<{ emotion: PlutchikEmotion | "neutral"; intensity: number; ts: number }>;
  lastUpdate: number;
}

/** In-memory mood cache per owner (resets on cold start, which is acceptable
 *  for a single-owner system — mood is a session-scale signal). */
const moodCache = new Map<number, MoodState>();

/** Get or initialize mood state for an owner. */
export function getMoodState(owner: number): MoodState {
  let m = moodCache.get(owner);
  if (!m) {
    m = {
      current: "neutral",
      intensity: 0,
      trajectory: "stable",
      history: [],
      lastUpdate: Date.now(),
    };
    moodCache.set(owner, m);
  }
  return m;
}

/** Restore a persisted MoodState (from KV) after cold start. Keeps mood
 *  trajectory (history) across restarts instead of resetting to neutral —
 *  previously mood.history was never persisted, so trajectory detection
 *  restarted from scratch on every cold start. Validates shape; ignores junk. */
export function setMoodState(owner: number, raw: unknown): void {
  if (!raw || typeof raw !== "object") return;
  const s = raw as Record<string, unknown>;
  const current = typeof s.current === "string" ? (s.current as MoodState["current"]) : "neutral";
  const history = Array.isArray(s.history)
    ? (s.history as MoodState["history"]).filter(
        (h) => h && typeof h === "object" && typeof h.intensity === "number" && h.ts &&
               (h.emotion === "joy" || h.emotion === "sadness" || h.emotion === "anger" ||
                h.emotion === "fear" || h.emotion === "disgust" || h.emotion === "surprise" ||
                h.emotion === "trust" || h.emotion === "anticipation" || h.emotion === "neutral"),
      ).slice(-20)
    : [];
  const intensity = typeof s.intensity === "number" ? Math.max(0, Math.min(1, s.intensity)) : 0;
  const trajectory = (typeof s.trajectory === "string" &&
    (s.trajectory === "stable" || s.trajectory === "improving" || s.trajectory === "declining"))
    ? (s.trajectory as MoodState["trajectory"])
    : "stable";
  moodCache.set(owner, {
    current,
    intensity,
    trajectory,
    history,
    lastUpdate: typeof s.lastUpdate === "number" ? s.lastUpdate : Date.now(),
  });
}

/** Extract emojis from text and classify their emotional signal. */
function extractEmojiEmotions(text: string): Array<[PlutchikEmotion, number]> {
  const results: Array<[PlutchikEmotion, number]> = [];
  // Match emoji characters (broad Unicode ranges)
  const emojiRe = /[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F1E0}-\u{1F1FF}\u{1F900}-\u{1F9FF}\u{1FA00}-\u{1FA6F}\u{1FA70}-\u{1FAFF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{FE00}-\u{FE0F}\u{1F000}-\u{1F02F}\u{1F0A0}-\u{1F0FF}\u{200D}\u{20E3}\u{E0020}-\u{E007F}]/gu;
  const emojis = text.match(emojiRe) || [];
  for (const e of emojis) {
    const mapping = EMOJI_EMOTION[e];
    if (mapping) results.push(...mapping);
  }
  return results;
}

/** Detect Plutchik emotions from text via lexicon lookup. */
function detectPlutchik(text: string): Map<PlutchikEmotion, number> {
  const low = text.toLowerCase();
  const words = low.split(/\s+/);
  const scores = new Map<PlutchikEmotion, number>();

  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    const isNegated = i > 0 && NEGATORS.has(words[i - 1]);
    const isIntensified = i > 0 && INTENSIFIERS.has(words[i - 1]);
    const multiplier = isIntensified ? 1.5 : 1;

    const lexEntry = PLUTCHIK_LEXICON[w];
    if (lexEntry) {
      for (const [emotion, baseScore] of lexEntry) {
        if (isNegated) {
          // Negation inverts: joy -> sadness, anger -> trust (roughly)
          const inverted = invertEmotion(emotion);
          scores.set(inverted, (scores.get(inverted) ?? 0) + baseScore * 0.5 * multiplier);
        } else {
          scores.set(emotion, (scores.get(emotion) ?? 0) + baseScore * multiplier);
        }
      }
    }
  }

  // Add emoji signals
  const emojiSignals = extractEmojiEmotions(text);
  for (const [emotion, score] of emojiSignals) {
    scores.set(emotion, (scores.get(emotion) ?? 0) + score);
  }

  return scores;
}

/** Invert a Plutchik emotion (rough approximation). */
function invertEmotion(e: PlutchikEmotion): PlutchikEmotion {
  const inverses: Record<PlutchikEmotion, PlutchikEmotion> = {
    joy: "sadness", trust: "disgust", fear: "anger", surprise: "anticipation",
    sadness: "joy", disgust: "trust", anger: "fear", anticipation: "surprise",
    love: "disgust", optimism: "sadness", submission: "anger", awe: "contempt",
    disapproval: "joy", remorse: "joy", contempt: "trust", aggressiveness: "fear",
    neutral: "neutral",
  };
  return inverses[e] ?? "neutral";
}

/** Detect compound emotions from Plutchik pairs. */
function detectCompound(scores: Map<PlutchikEmotion, number>): string | null {
  const present = Array.from(scores.entries()).filter(([, v]) => v >= 0.5);
  for (let i = 0; i < present.length; i++) {
    for (let j = i + 1; j < present.length; j++) {
      const key1 = `${present[i][0]}+${present[j][0]}`;
      const key2 = `${present[j][0]}+${present[i][0]}`;
      const compound = COMPOUND_EMOTIONS[key1] ?? COMPOUND_EMOTIONS[key2];
      if (compound) return compound;
    }
  }
  return null;
}

/** Detect if text contains sarcasm/heavy-sigh cues. */
function detectSarcasm(text: string): boolean {
  // Pattern: positive words + ellipsis, "ya", "sure", excessive punctuation
  const low = text.toLowerCase();
  if (/\.{3,}|…/.test(text) && POSITIVE_WORDS.size > 0) {
    const posCount = Array.from(POSITIVE_WORDS).filter(w => low.includes(w)).length;
    if (posCount > 0 && /\.{3,}|…|ya\.|sure\.|ok\./.test(low)) return true;
  }
  if (/(?:haha|hehe|hihi|wkwk|hiahia){2,}/i.test(low)) return true;
  if (/whatever|terserah|bebas|yaudah/i.test(low)) return true;
  return false;
}

/** Detect sentiment and emotion from text with Plutchik 8-emotion classification. */
export function detectEmotion(text: string): EmotionSignal {
  const low = text.toLowerCase();
  const words = low.split(/\s+/);

  let positiveScore = 0;
  let negativeScore = 0;
  let primary = "";
  let secondary = "";

  // Word-level sentiment (VADER-style)
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
  if (exclaim >= 2) {
    if (positiveScore > negativeScore) positiveScore += 0.5;
    else negativeScore += 0.5;
  }
  // All-caps check
  if (/[A-Z]{3,}/.test(text) && text !== text.toUpperCase()) {
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

  // Plutchik 8-emotion classification
  const plutchikScores = detectPlutchik(text);
  let plutchik: PlutchikEmotion | undefined;
  let plutchikIntensity = 0;
  let topPlutchik: [PlutchikEmotion, number][] = [];

  if (plutchikScores.size > 0) {
    topPlutchik = Array.from(plutchikScores.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 2);
    plutchik = topPlutchik[0][0];
    plutchikIntensity = Math.min(1, topPlutchik[0][1] / 2);
    // Boost overall confidence if Plutchik agrees with sentiment
    confidence = Math.min(1, confidence + 0.1);
  }

  // Compound emotion detection
  const compound = detectCompound(plutchikScores);

  // Sarcasm detection
  const isSarcastic = detectSarcasm(text);

  // Extract emojis
  const emojis = (text.match(/[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F1E0}-\u{1F1FF}\u{1F900}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/gu)) ?? [];

  return {
    sentiment,
    intensity: Math.max(intensity, plutchikIntensity),
    primary: primary || plutchik,
    secondary: secondary || (topPlutchik.length > 1 ? topPlutchik[1][0] : undefined),
    confidence: isSarcastic ? confidence * 0.6 : confidence,  // reduce confidence on sarcasm
    plutchik,
    emojis: emojis.length > 0 ? emojis : undefined,
  };
}

/** Update mood state with a new emotion signal (continuous tracking). */
export function updateMood(owner: number, signal: EmotionSignal): MoodState {
  const mood = getMoodState(owner);
  const now = Date.now();
  const emotion = signal.plutchik ?? (signal.sentiment === "positive" ? "joy" :
    signal.sentiment === "negative" ? "sadness" : "neutral");

  // Add to history (keep last 20 entries)
  mood.history.push({ emotion, intensity: signal.intensity, ts: now });
  if (mood.history.length > 20) mood.history.shift();

  // Detect trajectory (compare last 3 vs previous 3)
  if (mood.history.length >= 6) {
    const recent = mood.history.slice(-3);
    const previous = mood.history.slice(-6, -3);
    const recentAvg = recent.reduce((s, h) => s + h.intensity, 0) / recent.length;
    const prevAvg = previous.reduce((s, h) => s + h.intensity, 0) / previous.length;
    if (recentAvg > prevAvg + 0.15) mood.trajectory = "declining";
    else if (recentAvg < prevAvg - 0.15) mood.trajectory = "improving";
    else mood.trajectory = "stable";
  }

  // Update current mood (EMA: exponential moving average)
  const alpha = 0.3; // learning rate
  mood.current = emotion as PlutchikEmotion | "neutral";
  mood.intensity = mood.intensity * (1 - alpha) + signal.intensity * alpha;
  mood.lastUpdate = now;

  return mood;
}

/** Map emotion to conversational style adjustment. */
export function emotionToStyle(emotion: EmotionSignal, mood?: MoodState): {
  tone: "warm" | "neutral" | "firm" | "empathetic" | "encouraging";
  formality: "casual" | "neutral" | "formal";
  length: "short" | "normal" | "detailed";
} {
  // Use mood trajectory for additional context
  const trajectory = mood?.trajectory ?? "stable";

  if (emotion.sentiment === "negative" && emotion.intensity > 0.5) {
    // If trajectory is declining, be extra supportive
    if (trajectory === "declining") {
      return { tone: "empathetic", formality: "neutral", length: "detailed" };
    }
    return { tone: "empathetic", formality: "neutral", length: "normal" };
  }
  if (emotion.sentiment === "positive" && emotion.intensity > 0.5) {
    return { tone: "encouraging", formality: "casual", length: "short" };
  }
  if (emotion.plutchik === "anger") {
    return { tone: "firm", formality: "formal", length: "short" };
  }
  if (emotion.plutchik === "fear" || emotion.plutchik === "sadness") {
    return { tone: "empathetic", formality: "neutral", length: "normal" };
  }
  if (emotion.plutchik === "joy") {
    return { tone: "warm", formality: "casual", length: "short" };
  }
  if (emotion.plutchik === "anticipation") {
    return { tone: "encouraging", formality: "neutral", length: "normal" };
  }
  return { tone: "neutral", formality: "neutral", length: "normal" };
}

/** Get a human-readable summary of the current mood state. */
export function moodSummary(mood: MoodState): string {
  if (mood.current === "neutral" && mood.intensity < 0.2) {
    return "Mood: netral.";
  }
  const emoji: Record<string, string> = {
    joy: "😊", trust: "🤝", fear: "😰", surprise: "😮",
    sadness: "😢", disgust: "😤", anger: "😡", anticipation: "🤔",
    neutral: "😐",
  };
  const trajectoryLabel = mood.trajectory === "improving" ? "↑ membaik" :
    mood.trajectory === "declining" ? "↓ menurun" : "→ stabil";
  return `${emoji[mood.current] ?? "😐"} Mood: ${mood.current} (${(mood.intensity * 100).toFixed(0)}%) — ${trajectoryLabel}`;
}

// ---------------------------------------------------------------------
// Context-Based Emotion Inference (for unknown topics)
// ---------------------------------------------------------------------
// When direct emotion detection fails (neutral/unknown), infer from:
// 1. Mood trajectory (declining = likely negative, improving = likely positive)
// 2. Recent conversation history
// 3. Topic-related emotional patterns from memory

/** Infer emotion when direct detection is neutral/unknown.
 *  Uses mood history, trajectory, and context clues. */
export function inferEmotionFromContext(
  signal: EmotionSignal,
  mood: MoodState,
  recentEmotions: EmotionSignal[] = [],
): EmotionSignal {
  // If we already have a good signal, return as-is
  if (signal.primary && signal.confidence > 0.6) {
    return signal;
  }

  // Inference 1: Use mood trajectory
  const trajectory = mood.trajectory;
  if (trajectory === "declining" && mood.intensity > 0.3) {
    return {
      ...signal,
      sentiment: "negative",
      primary: signal.primary || mood.history[mood.history.length - 2]?.emotion || "sadness",
      intensity: Math.max(signal.intensity, mood.intensity * 0.8),
      confidence: Math.min(1, signal.confidence + 0.2),
    };
  }
  if (trajectory === "improving" && mood.intensity > 0.3) {
    return {
      ...signal,
      sentiment: "positive",
      primary: signal.primary || "joy",
      intensity: Math.max(signal.intensity, mood.intensity * 0.6),
      confidence: Math.min(1, signal.confidence + 0.15),
    };
  }

  // Inference 2: Use recent emotion patterns
  if (recentEmotions.length > 0) {
    const recentPrimary = recentEmotions[recentEmotions.length - 1];
    if (recentPrimary.plutchik && recentPrimary.plutchik !== "neutral") {
      return {
        ...signal,
        sentiment: signal.sentiment || recentPrimary.sentiment,
        primary: signal.primary || recentPrimary.plutchik,
        intensity: Math.max(signal.intensity, recentPrimary.intensity * 0.5),
        confidence: Math.min(1, signal.confidence + 0.1),
      };
    }
  }

  // Inference 3: Use dominant mood if available
  if (mood.current !== "neutral" && mood.intensity > 0.4) {
    return {
      ...signal,
      sentiment: signal.sentiment || (["joy", "trust", "love", "optimism"].includes(mood.current) ? "positive" :
        ["sadness", "fear", "anger", "disgust"].includes(mood.current) ? "negative" : "neutral"),
      primary: signal.primary || mood.current,
      intensity: Math.max(signal.intensity, mood.intensity * 0.4),
      confidence: Math.min(1, signal.confidence + 0.1),
    };
  }

  return signal;
}

/** Detect emotion from topic keywords (sentiment of topic itself).
 *  Useful when user text is neutral but topic has emotional weight. */
export function detectTopicSentiment(topic: string): { sentiment: "positive" | "negative" | "neutral"; weight: number } {
  const low = topic.toLowerCase();
  
  // Positive topics
  const positivePatterns = /\b(sukses|berhasil|baik|bagus|hebat|senang|bahagia|cantik|indah|jernih|bersih|segar|lembut|hangat|cerah|menang|juara|maju|berkembang|positif)\b/i;
  const negativePatterns = /\b(gagal|error|bug|rusak|corrupt|salah|jelek|buruk|sedih|marah|kecewa|gagal|hancur|hilang|mati|sakit|luka|darurat|bahaya|ancaman|masalah|trouble|crash)\b/i;
  
  if (positivePatterns.test(low)) return { sentiment: "positive", weight: 0.6 };
  if (negativePatterns.test(low)) return { sentiment: "negative", weight: 0.6 };
  
  return { sentiment: "neutral", weight: 0 };
}

//=====================================================================
// jarvis_emotion.ts — Emotion & personality service for JARVIS.
//
// Bertanggung jawab untuk:
// - Plutchik 8-emotion wheel
// - Dynamic personality adaptation
// - Mood tracking & prediction
// - Sarcasm detection
// - Cultural emotion mapping
//
// Design references:
// - Plutchik's emotion wheel (8 primary + 8 compound emotions)
// - Big Five personality model (OCEAN)
// - Hofstede's cultural dimensions
//=====================================================================

import { detectEmotion as detectEmotionBase, type MoodState } from "./emotion";
import { type Language, type LanguageCode } from "./jarvis_language";

/** Emotion dimension scores. */
export interface EmotionDimensions {
  valence: number;    // -1 (negative) to 1 (positive)
  arousal: number;    // 0 (calm) to 1 (excited)
  dominance: number;  // 0 (submissive) to 1 (dominant)
}

/** Personality profile (Big Five). */
export interface PersonalityProfile {
  openness: number;         // 0-1: creativity, curiosity
  conscientiousness: number; // 0-1: organization, reliability
  extraversion: number;     // 0-1: sociability, assertiveness
  agreeableness: number;    // 0-1: cooperation, trust
  neuroticism: number;      // 0-1: emotional instability
}

/** Cultural emotion norms. */
export interface CulturalEmotionNorms {
  /** Which emotions are appropriate to express */
  expressible: string[];
  /** Which emotions should be suppressed */
  suppressed: string[];
  /** Default emotional tone */
  defaultTone: string;
  /** Formality level affects emotion expression */
  formalityImpact: number; // 0-1
}

/** JARVIS personality dimensions. */
export interface JarvisPersonality {
  warmth: number;      // 0-1: friendliness
  competence: number;  // 0-1: expertise display
  humor: number;       // 0-1: humor usage
  empathy: number;     // 0-1: emotional understanding
  directness: number;  // 0-1: straight-to-the-point
}

/** Cultural emotion norms per language. */
const CULTURAL_NORMS: Record<LanguageCode, CulturalEmotionNorms> = {
  id: {
    expressible: ["joy", "trust", "anticipation"],
    suppressed: ["anger", "disgust"],
    defaultTone: "warm",
    formalityImpact: 0.3,
  },
  en: {
    expressible: ["joy", "surprise", "anticipation"],
    suppressed: [],
    defaultTone: "neutral",
    formalityImpact: 0.2,
  },
  ms: {
    expressible: ["joy", "trust", "anticipation"],
    suppressed: ["anger", "disgust"],
    defaultTone: "warm",
    formalityImpact: 0.3,
  },
  jv: {
    expressible: ["joy", "trust"],
    suppressed: ["anger", "disgust", "surprise"],
    defaultTone: "formal",
    formalityImpact: 0.5,
  },
  su: {
    expressible: ["joy", "trust", "fear"],
    suppressed: ["anger"],
    defaultTone: "warm",
    formalityImpact: 0.4,
  },
  mixed: {
    expressible: ["joy", "trust", "anticipation", "surprise"],
    suppressed: [],
    defaultTone: "neutral",
    formalityImpact: 0.2,
  },
  unknown: {
    expressible: ["joy", "trust", "anticipation"],
    suppressed: [],
    defaultTone: "neutral",
    formalityImpact: 0.2,
  },
};

/** Default JARVIS personality. */
const DEFAULT_PERSONALITY: JarvisPersonality = {
  warmth: 0.7,
  competence: 0.8,
  humor: 0.4,
  empathy: 0.7,
  directness: 0.6,
};

/** Detect emotion from text (enhanced with cultural awareness). */
export function detectEmotion(
  text: string,
  language: Language,
): {
  primary: string;
  secondary: string | null;
  dimensions: EmotionDimensions;
  confidence: number;
  culturalFit: boolean;
} {
  // Base emotion detection
  const baseResult = detectEmotionBase(text);

  // Get cultural norms
  const norms = CULTURAL_NORMS[language.code];

  // Check if detected emotion is culturally appropriate
  const isCulturallyFit = norms.expressible.includes(baseResult.primary ?? "") ||
    !norms.suppressed.includes(baseResult.primary ?? "");

  // Calculate emotion dimensions
  const dimensions = calculateEmotionDimensions(baseResult.primary ?? "neutral", baseResult.secondary ?? null);

  return {
    primary: baseResult.primary ?? "neutral",
    secondary: baseResult.secondary ?? null,
    dimensions,
    confidence: baseResult.confidence,
    culturalFit: isCulturallyFit,
  };
}

/** Calculate emotion dimensions (valence, arousal, dominance). */
function calculateEmotionDimensions(
  primary: string,
  secondary: string | null,
): EmotionDimensions {
  const emotionMap: Record<string, EmotionDimensions> = {
    joy: { valence: 0.8, arousal: 0.6, dominance: 0.7 },
    trust: { valence: 0.6, arousal: 0.4, dominance: 0.5 },
    fear: { valence: -0.6, arousal: 0.8, dominance: 0.2 },
    surprise: { valence: 0.3, arousal: 0.9, dominance: 0.4 },
    sadness: { valence: -0.7, arousal: 0.3, dominance: 0.2 },
    disgust: { valence: -0.5, arousal: 0.5, dominance: 0.6 },
    anger: { valence: -0.6, arousal: 0.8, dominance: 0.8 },
    anticipation: { valence: 0.4, arousal: 0.7, dominance: 0.6 },
  };

  const primaryDims = emotionMap[primary] ?? { valence: 0, arousal: 0.5, dominance: 0.5 };

  if (secondary) {
    const secondaryDims = emotionMap[secondary] ?? { valence: 0, arousal: 0.5, dominance: 0.5 };
    return {
      valence: (primaryDims.valence + secondaryDims.valence) / 2,
      arousal: (primaryDims.arousal + secondaryDims.arousal) / 2,
      dominance: (primaryDims.dominance + secondaryDims.dominance) / 2,
    };
  }

  return primaryDims;
}

/** Get dynamic personality based on context. */
export function getDynamicPersonality(
  mood: MoodState,
  language: Language,
  intent: string,
): JarvisPersonality {
  const base = { ...DEFAULT_PERSONALITY };

  // Adjust based on mood
  if (mood.current === "joy") {
    base.warmth = Math.min(1, base.warmth + 0.2);
    base.humor = Math.min(1, base.humor + 0.3);
  } else if (mood.current === "sadness") {
    base.empathy = Math.min(1, base.empathy + 0.3);
    base.warmth = Math.min(1, base.warmth + 0.1);
  } else if (mood.current === "anger") {
    base.directness = Math.min(1, base.directness + 0.2);
    base.warmth = Math.max(0, base.warmth - 0.1);
  } else if (mood.current === "fear") {
    base.empathy = Math.min(1, base.empathy + 0.2);
    base.competence = Math.min(1, base.competence + 0.1);
  }

  // Adjust based on language culture
  const norms = CULTURAL_NORMS[language.code];
  if (norms.defaultTone === "warm") {
    base.warmth = Math.min(1, base.warmth + 0.1);
  } else if (norms.defaultTone === "formal") {
    base.competence = Math.min(1, base.competence + 0.1);
    base.humor = Math.max(0, base.humor - 0.2);
  }

  // Adjust based on intent
  if (intent === "command") {
    base.directness = Math.min(1, base.directness + 0.2);
    base.competence = Math.min(1, base.competence + 0.1);
  } else if (intent === "chitchat") {
    base.warmth = Math.min(1, base.warmth + 0.2);
    base.humor = Math.min(1, base.humor + 0.1);
  } else if (intent === "research") {
    base.competence = Math.min(1, base.competence + 0.2);
    base.directness = Math.min(1, base.directness + 0.1);
  }

  return base;
}

/** Build personality context for LLM. */
export function buildPersonalityContext(
  personality: JarvisPersonality,
  language: Language,
): string {
  const parts: string[] = [];

  // Personality traits
  if (personality.warmth > 0.7) parts.push("Ramah dan hangat");
  if (personality.competence > 0.8) parts.push("Kompeten dan berpengetahuan");
  if (personality.humor > 0.5) parts.push("Sedikit humoris");
  if (personality.empathy > 0.7) parts.push("Empati dan memahami perasaan");
  if (personality.directness > 0.7) parts.push("Langsung dan to the point");

  // Cultural adjustment
  const norms = CULTURAL_NORMS[language.code];
  if (norms.formalityImpact > 0.3) {
    parts.push("Gunakan bahasa yang sopan dan beretika");
  }

  return parts.join(". ");
}

/** Adapt emotion expression based on culture. */
export function adaptEmotionExpression(
  emotion: string,
  language: Language,
): string {
  const norms = CULTURAL_NORMS[language.code];

  // If emotion is suppressed in this culture, tone it down
  if (norms.suppressed.includes(emotion)) {
    return "neutral";
  }

  // If emotion is expressible, enhance it
  if (norms.expressible.includes(emotion)) {
    return emotion;
  }

  return emotion;
}

/** Format personality info for display. */
export function formatPersonalityInfo(
  personality: JarvisPersonality,
  mood: MoodState,
  language: Language,
): string {
  const lines = [
    "🎭 *Personality J.A.R.V.I.S.*",
    "",
    `*Warmth:* ${"█".repeat(Math.round(personality.warmth * 5))}${"░".repeat(5 - Math.round(personality.warmth * 5))} ${(personality.warmth * 100).toFixed(0)}%`,
    `*Competence:* ${"█".repeat(Math.round(personality.competence * 5))}${"░".repeat(5 - Math.round(personality.competence * 5))} ${(personality.competence * 100).toFixed(0)}%`,
    `*Humor:* ${"█".repeat(Math.round(personality.humor * 5))}${"░".repeat(5 - Math.round(personality.humor * 5))} ${(personality.humor * 100).toFixed(0)}%`,
    `*Empathy:* ${"█".repeat(Math.round(personality.empathy * 5))}${"░".repeat(5 - Math.round(personality.empathy * 5))} ${(personality.empathy * 100).toFixed(0)}%`,
    `*Directness:* ${"█".repeat(Math.round(personality.directness * 5))}${"░".repeat(5 - Math.round(personality.directness * 5))} ${(personality.directness * 100).toFixed(0)}%`,
    "",
    `*Mood:* ${mood.current} (intensity: ${(mood.intensity * 100).toFixed(0)}%)`,
    `*Language:* ${language.name} (${language.code})`,
    `*Cultural Tone:* ${CULTURAL_NORMS[language.code].defaultTone}`,
  ];

  return lines.join("\n");
}

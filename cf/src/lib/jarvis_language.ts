//=====================================================================
// jarvis_language.ts — Multi-language support service for JARVIS.
//
// Bertanggung jawab untuk:
// - Deteksi bahasa user (Indonesian, English, Mixed)
// - Deteksi code-switching (campuran bahasa)
// - Cultural context awareness
// - Language-specific formatting
// - Response dalam bahasa yang sama dengan user
//
// Design references:
// - ISO 639-1 language codes
// - CLD3 (Compact Language Detector)
// - Cross-lingual transfer learning
//=====================================================================

/** Supported languages. */
export type LanguageCode = "id" | "en" | "ms" | "jv" | "su" | "mixed" | "unknown";

/** Language info. */
export interface Language {
  code: LanguageCode;
  name: string;
  confidence: number;
  isMixed: boolean;
  detectedLanguages: LanguageCode[];
  culturalContext: CulturalContext;
}

/** Cultural context for response formatting. */
export interface CulturalContext {
  formality: "formal" | "casual" | "very_casual";
  honorifics: boolean;
  pronounStyle: "standard" | "polite" | "intimate";
  responseLength: "short" | "medium" | "long";
}

/** Language detection patterns. */
const LANGUAGE_PATTERNS: Record<LanguageCode, RegExp[]> = {
  id: [
    /\b(?:apa|siapa|dimana|kapan|kenapa|bagaimana|berapa|mengapa|karena|sebagai|dengan|untuk|dari|ini|itu|yang|dan|atau|tetapi|jika|maka|akan|sedang|telah|sudah|belum|bisa|dapat|harus|mau|ingin|tolong|bantu)\b/gi,
    /\b(?:saya|aku|kamu|dia|kami|mereka|kita|anda|bapak|ibu|om|tante|mas|mbak|pak|bu)\b/gi,
    /\b(?:baik|benar|salah|tidak|bukan|jangan|lama|baru|besar|kecil|tinggi|rendah|panjang|pendek)\b/gi,
    /(?:lah|kah|tah|pun|nya|ku|mu|di|ke|dari|dengan|untuk|pada)\b/gi,
  ],
  en: [
    /\b(?:what|who|where|when|why|how|which|whose|whom)\b/gi,
    /\b(?:the|a|an|this|that|these|those|my|your|his|her|its|our|their)\b/gi,
    /\b(?:is|are|was|were|be|been|being|have|has|had|do|does|did|will|would|could|should|may|might|can|shall)\b/gi,
    /\b(?:I|you|he|she|it|we|they|me|him|her|us|them)\b/gi,
    /\b(?:and|or|but|if|then|else|when|while|because|since|although|though|where|there|here|very|really|just|also|too|only|even|still|already|yet)\b/gi,
  ],
  ms: [
    /\b(?:apa|siapa|dimana|kapan|kenapa|bagaimana|berapa|mengapa|kerana|sebagai|dengan|untuk|dari|ini|itu|yang|dan|atau|tetapi|jika|maka|akan|sedang|telah|sudah|belum|boleh|dapat|harus|mau|ingin|tolong|bantu)\b/gi,
    /\b(?:saya|aku|kamu|dia|kami|mereka|kita|anda)\b/gi,
  ],
  jv: [
    /\b(?:apa|sapa|ngendi|kapan|kenapa|piye|pira|apaane|amarga|minangka|karo|kanggo|saka|iki|iku|sing|lan|utawa|nanging|yen|maka|bakal|lagi|wis|durung|bisa|kudu|arep|nggih|monggo)\b/gi,
    /\b(?:kulo|sinjen|panjenengan|kula|sampéan|adhi|kakang|rawuh)\b/gi,
  ],
  su: [
    /\b(?:naon|saha|diyeu|kamana|kumaha|sabaraheun|kunaon|lantaran|janten|sareng|pikeun|ti|ieu|eta|anu|jeung|tapi|lamun|maka|moal|nuju|parantos|can|tiasa|kedah|badé| Sơn)\b/gi,
  ],
  mixed: [], // detected when multiple languages match
  unknown: [],
};

/** Cultural contexts per language. */
const CULTURAL_CONTEXTS: Record<LanguageCode, CulturalContext> = {
  id: {
    formality: "casual",
    honorifics: true,
    pronounStyle: "polite",
    responseLength: "medium",
  },
  en: {
    formality: "casual",
    honorifics: false,
    pronounStyle: "standard",
    responseLength: "medium",
  },
  ms: {
    formality: "casual",
    honorifics: true,
    pronounStyle: "polite",
    responseLength: "medium",
  },
  jv: {
    formality: "formal",
    honorifics: true,
    pronounStyle: "polite",
    responseLength: "long",
  },
  su: {
    formality: "formal",
    honorifics: true,
    pronounStyle: "polite",
    responseLength: "medium",
  },
  mixed: {
    formality: "casual",
    honorifics: false,
    pronounStyle: "standard",
    responseLength: "medium",
  },
  unknown: {
    formality: "casual",
    honorifics: false,
    pronounStyle: "standard",
    responseLength: "medium",
  },
};

/** Detect language from text. */
export function detectLanguage(text: string): Language {
  const scores: Record<LanguageCode, number> = {
    id: 0,
    en: 0,
    ms: 0,
    jv: 0,
    su: 0,
    mixed: 0,
    unknown: 0,
  };

  // Count matches per language
  for (const [code, patterns] of Object.entries(LANGUAGE_PATTERNS)) {
    if (code === "mixed" || code === "unknown") continue;
    for (const pattern of patterns) {
      const matches = text.match(pattern);
      if (matches) {
        scores[code as LanguageCode] += matches.length;
      }
    }
  }

  // Find top languages
  const sorted = Object.entries(scores)
    .filter(([code]) => code !== "mixed" && code !== "unknown")
    .sort(([, a], [, b]) => b - a);

  const topScore = sorted[0]?.[1] ?? 0;
  const topLanguages = sorted.filter(([, score]) => score >= topScore * 0.5).map(([code]) => code as LanguageCode);

  // Determine if mixed
  const isMixed = topLanguages.length > 1 && topScore > 0;
  const detectedLanguages = isMixed ? topLanguages : [sorted[0]?.[1] ?? 0 > 0 ? sorted[0][0] as LanguageCode : "unknown"];

  // Determine primary language
  let primaryCode: LanguageCode = "unknown";
  if (topScore > 0) {
    primaryCode = sorted[0][0] as LanguageCode;
  } else {
    // Fallback: check for common patterns
    if (/[a-zA-Z]/.test(text) && !/[àáâãäåèéêëìíîïòóôõöùúûüýÿ]/.test(text)) {
      primaryCode = "en";
    } else if (/[àáâãäåèéêëìíîïòóôõöùúûüýÿ]/.test(text)) {
      primaryCode = "id";
    }
  }

  const confidence = topScore > 0 ? Math.min(1, topScore / 10) : 0.3;
  const culturalContext = CULTURAL_CONTEXTS[primaryCode];

  return {
    code: primaryCode,
    name: getLanguageName(primaryCode),
    confidence,
    isMixed,
    detectedLanguages,
    culturalContext,
  };
}

/** Get language name from code. */
export function getLanguageName(code: LanguageCode): string {
  const names: Record<LanguageCode, string> = {
    id: "Indonesian",
    en: "English",
    ms: "Malay",
    jv: "Javanese",
    su: "Sundanese",
    mixed: "Mixed",
    unknown: "Unknown",
  };
  return names[code] ?? "Unknown";
}

/** Detect code-switching (mixing languages). */
export function detectCodeSwitching(text: string): {
  isMixed: boolean;
  segments: Array<{ text: string; language: LanguageCode }>;
} {
  const words = text.split(/\s+/);
  const segments: Array<{ text: string; language: LanguageCode }> = [];
  let currentSegment = "";
  let currentLang: LanguageCode = "unknown";

  for (const word of words) {
    const wordLang = detectWordLanguage(word);
    if (wordLang === currentLang || currentLang === "unknown") {
      currentSegment += (currentSegment ? " " : "") + word;
      currentLang = wordLang;
    } else {
      if (currentSegment) {
        segments.push({ text: currentSegment, language: currentLang });
      }
      currentSegment = word;
      currentLang = wordLang;
    }
  }

  if (currentSegment) {
    segments.push({ text: currentSegment, language: currentLang });
  }

  const languages = new Set(segments.map(s => s.language));
  return {
    isMixed: languages.size > 1,
    segments,
  };
}

/** Detect language of a single word. */
function detectWordLanguage(word: string): LanguageCode {
  const low = word.toLowerCase();

  // Indonesian patterns
  if (/\b(?:apa|siapa|dimana|kapan|kenapa|bagaimana|saya|kamu|dia|baik|benar|tidak|bukan|yang|dan|atau|ini|itu)\b/i.test(low)) {
    return "id";
  }

  // English patterns
  if (/\b(?:what|who|where|when|why|how|the|a|an|is|are|was|were|I|you|he|she|it|we|they|and|or|but|this|that)\b/i.test(low)) {
    return "en";
  }

  // Javanese patterns
  if (/\b(?:apa|sapa|ngendi|piye|kulo|sinjen|panjenengan|nggih|monggo|sampéan)\b/i.test(low)) {
    return "jv";
  }

  // Sundanese patterns
  if (/\b(?:naon|saha|diyeu|kumaha|son|henteu|dupi|atos|cantik)\b/i.test(low)) {
    return "su";
  }

  // Default: check character patterns
  if (/^[a-zA-Z]+$/.test(word)) return "en";
  if (/[àáâãäåèéêëìíîïòóôõöùúûüýÿ]/i.test(word)) return "id";

  return "unknown";
}

/** Adapt response based on language and cultural context. */
export function adaptResponse(
  response: string,
  language: Language,
  opts: {
    forceFormal?: boolean;
    forceCasual?: boolean;
  } = {},
): string {
  const ctx = language.culturalContext;
  let adapted = response;

  // Apply formality adjustments
  if (opts.forceFormal || ctx.formality === "formal") {
    adapted = makeFormal(adapted, language.code);
  } else if (opts.forceCasual || ctx.formality === "casual") {
    adapted = makeCasual(adapted, language.code);
  }

  // Apply pronoun style
  if (ctx.pronounStyle === "polite") {
    adapted = addPoliteMarkers(adapted, language.code);
  }

  return adapted;
}

/** Make response more formal. */
function makeFormal(text: string, lang: LanguageCode): string {
  if (lang === "id") {
    // Indonesian formal markers
    return text
      .replace(/\bkamu\b/gi, "Anda")
      .replace(/\baku\b/gi, "Saya")
      .replace(/\bgimana\b/gi, "bagaimana")
      .replace(/\bgitu\b/gi, "begitu")
      .replace(/\bnggak\b/gi, "tidak")
      .replace(/\bngga\b/gi, "tidak")
      .replace(/\bgak\b/gi, "tidak")
      .replace(/\bya\b/gi, "iya")
      .replace(/\bnih\b/gi, "ini")
      .replace(/\btuh\b/gi, "itu");
  }
  if (lang === "en") {
    return text
      .replace(/\bgonna\b/gi, "going to")
      .replace(/\bwanna\b/gi, "want to")
      .replace(/\bgotta\b/gi, "got to")
      .replace(/\bya\b/gi, "yes")
      .replace(/\bnope\b/gi, "no");
  }
  return text;
}

/** Make response more casual. */
function makeCasual(text: string, lang: LanguageCode): string {
  if (lang === "id") {
    return text
      .replace(/\bAnda\b/g, "kamu")
      .replace(/\bSaya\b/g, "aku")
      .replace(/\bbagaimana\b/g, "gimana")
      .replace(/\bbegitu\b/g, "gitu")
      .replace(/\btidak\b/g, "nggak")
      .replace(/\biya\b/g, "ya");
  }
  if (lang === "en") {
    return text
      .replace(/\bgoing to\b/g, "gonna")
      .replace(/\bwant to\b/g, "wanna")
      .replace(/\bgot to\b/g, "gotta");
  }
  return text;
}

/** Add polite markers for languages that use them. */
function addPoliteMarkers(text: string, lang: LanguageCode): string {
  if (lang === "id") {
    // Add "ya" or "nih" for friendly tone
    if (!text.endsWith("ya") && !text.endsWith("nih") && !text.endsWith("loh")) {
      if (text.endsWith(".") || text.endsWith("!")) {
        return text.slice(0, -1) + " ya.";
      }
    }
  }
  if (lang === "jv") {
    // Add Javanese polite markers
    if (!text.includes("monggo") && !text.includes("nggih")) {
      return text + " (monggo)";
    }
  }
  return text;
}

/** Get language-specific greeting. */
export function getLanguageGreeting(lang: LanguageCode, timeOfDay: "morning" | "afternoon" | "evening" | "night"): string {
  const greetings: Record<LanguageCode, Record<string, string>> = {
    id: {
      morning: "Selamat pagi",
      afternoon: "Selamat siang",
      evening: "Selamat sore",
      night: "Selamat malam",
    },
    en: {
      morning: "Good morning",
      afternoon: "Good afternoon",
      evening: "Good evening",
      night: "Good night",
    },
    ms: {
      morning: "Selamat pagi",
      afternoon: "Selamat petang",
      evening: "Selamat petang",
      night: "Selamat malam",
    },
    jv: {
      morning: "Sugeng enjing",
      afternoon: "Sugeng siang",
      evening: "Sugeng dalu",
      night: "Sugeng dalu",
    },
    su: {
      morning: "Wilujeng enjing",
      afternoon: "Wilujeng siang",
      evening: "Wilujeng wengi",
      night: "Wilujeng wengi",
    },
    mixed: {
      morning: "Hi, good morning",
      afternoon: "Hi, good afternoon",
      evening: "Hi, good evening",
      night: "Hi, good night",
    },
    unknown: {
      morning: "Selamat pagi",
      afternoon: "Selamat siang",
      evening: "Selamat sore",
      night: "Selamat malam",
    },
  };

  return greetings[lang]?.[timeOfDay] ?? greetings.id[timeOfDay];
}

/** Format language info for display. */
export function formatLanguageInfo(lang: Language): string {
  const lines = [
    `*Bahasa:* ${lang.name} (${lang.code})`,
    `*Confidence:* ${(lang.confidence * 100).toFixed(0)}%`,
    `*Formality:* ${lang.culturalContext.formality}`,
    `*Mixed:* ${lang.isMixed ? "Ya" : "Tidak"}`,
  ];

  if (lang.isMixed) {
    lines.push(`*Detected:* ${lang.detectedLanguages.map(l => getLanguageName(l)).join(", ")}`);
  }

  return lines.join("\n");
}

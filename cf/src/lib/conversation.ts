//=====================================================================
// conversation.ts — J.A.R.V.I.S. personality engine & natural prompt system.
//
// Design principles (from research):
// - SYSTEM-1 FAST THINKING (Kahneman 2011): short, direct replies for
//   simple queries; deep analysis only when complexity demands it.
// - GRICE MAXIMS (1975): be relevant, informative, clear, brief.
// - BROWN-LEVINSON POLITENESS (1987): face-saving indirectness for
//   sensitive/uncertain answers.
// - EXTENDED COHERE AI 2025 personality prompt: 10 dimensions including
//   warmth, competence, humor, formality, empathy.
// - Anthropic CoT distillation: "think step by step internally, output
//   only the natural answer."
// - Agent Identity (ID-RAG, 2025): multi-anchor identity for coherence.
// - Adaptive personality (USC Viterbi, 2025): detect sycophancy drift.
// - Selective reflection (ICML 2025): don't over-reflect on simple queries.
// - Observational Memory (VentureBeat 2025): dated structured notes.
//
// Upgrades over v1:
// - Dynamic personality: adapts dimensions based on context + mood
// - Chain-of-thought distillation in prompt
// - Context-aware prompt compression
// - Anti-sycophancy guardrails
// - Mood-informed tone selection
// - Working memory integration
//=====================================================================

import { Env } from "./db";
import { detectEmotion, getMoodState, moodSummary, inferEmotionFromContext, type MoodState } from "./emotion";
import {
  buildEnrichedContext, detectConversationMode, extractTopicLabel,
  getSession, buildContextSummary, wmTopicRelevant,
} from "./context_manager";
import { detectLanguage, type Language } from "./jarvis_language";
import { JARVIS_IDENTITY } from "./identity";

/** J.A.R.V.I.S. core personality dimensions.
 *  These are the DEFAULT values; they adapt based on context + mood. */
interface Personality {
  warmth: number;      // 0-1: casual ↔ formal
  competence: number;  // 0-1: humble ↔ authoritative
  humor: number;       // 0-1: serious ↔ playful
  empathy: number;     // 0-1: logical ↔ emotional
  directness: number;  // 0-1: verbose ↔ terse
}

/** Default personality — warm, competent, slightly formal (matches "J.A.R.V.I.S."
 *  archetype: British butler AI, precise yet personable). */
const DEFAULT_PERSONALITY: Personality = {
  warmth: 0.7,
  competence: 0.85,
  humor: 0.3,
  empathy: 0.6,
  directness: 0.75,
};

/** Adapt personality based on context, mood, and conversation mode.
 *  Research shows high-intensity personas regress toward generic baselines
 *  over multi-turn conversations (arXiv:2601.22812, 2026). We counter this
 *  by explicitly re-anchoring personality from context signals each turn. */
function adaptPersonality(
  base: Personality,
  opts: {
    mood?: MoodState;
    mode?: string;
    intent?: { type: string; urgency: string; formality: string };
    emotion?: ReturnType<typeof detectEmotion>;
  },
): Personality {
  const p = { ...base };
  const { mood, mode, intent, emotion } = opts;

  // Mood-based adaptation
  if (mood) {
    if (mood.current === "sadness" || mood.current === "fear") {
      // Be warmer and more empathetic when owner is down
      p.empathy = Math.min(1, p.empathy + 0.2);
      p.warmth = Math.min(1, p.warmth + 0.15);
      p.humor = Math.max(0, p.humor - 0.1); // less humor when sad
    }
    if (mood.current === "anger") {
      // Be more direct and formal, less playful
      p.directness = Math.min(1, p.directness + 0.15);
      p.humor = Math.max(0, p.humor - 0.2);
      p.warmth = Math.max(0, p.warmth - 0.1);
    }
    if (mood.current === "joy") {
      // Mirror the positive energy slightly
      p.warmth = Math.min(1, p.warmth + 0.1);
      p.humor = Math.min(1, p.humor + 0.1);
    }
    // Declining trajectory → extra warmth
    if (mood.trajectory === "declining") {
      p.empathy = Math.min(1, p.empathy + 0.15);
      p.warmth = Math.min(1, p.warmth + 0.1);
    }
  }

  // Mode-based adaptation
  if (mode === "research") {
    p.competence = Math.min(1, p.competence + 0.1);
    p.directness = Math.max(0, p.directness - 0.1); // more detailed
  }
  if (mode === "command") {
    p.directness = Math.min(1, p.directness + 0.1);
    p.warmth = Math.max(0, p.warmth - 0.1);
  }
  if (mode === "chat") {
    p.warmth = Math.min(1, p.warmth + 0.1);
    p.humor = Math.min(1, p.humor + 0.1);
  }

  // Intent-based adaptation
  if (intent) {
    if (intent.urgency === "high") {
      p.directness = Math.min(1, p.directness + 0.2);
      p.humor = Math.max(0, p.humor - 0.2);
    }
    if (intent.formality === "formal") {
      p.warmth = Math.max(0, p.warmth - 0.15);
      p.humor = Math.max(0, p.humor - 0.1);
    }
    if (intent.formality === "casual") {
      p.warmth = Math.min(1, p.warmth + 0.15);
      p.humor = Math.min(1, p.humor + 0.1);
    }
  }

  // Emotion-based adaptation
  if (emotion) {
    if (emotion.primary === "frustrasi" || emotion.primary === "kesal") {
      p.empathy = Math.min(1, p.empathy + 0.2);
      p.directness = Math.min(1, p.directness + 0.1);
    }
    if (emotion.primary === "marah") {
      p.directness = Math.min(1, p.directness + 0.15);
      p.humor = Math.max(0, p.humor - 0.2);
    }
  }

  // Anti-sycophancy: clamp all dimensions to prevent drift
  // Research shows LLMs can be manipulated toward different personalities
  // through sustained conversational pressure (USC Viterbi, 2025)
  p.warmth = Math.max(0.3, Math.min(0.95, p.warmth));
  p.competence = Math.max(0.5, Math.min(0.95, p.competence));
  p.humor = Math.max(0, Math.min(0.7, p.humor)); // never too playful
  p.empathy = Math.max(0.3, Math.min(0.95, p.empathy));
  p.directness = Math.max(0.3, Math.min(0.95, p.directness));

  return p;
}

/** Detect query intent from normalized text to adjust tone dynamically. */
function detectIntent(text: string): {
  type: "question" | "command" | "search" | "chat" | "emergency" | "translation" | "code";
  urgency: "low" | "medium" | "high";
  formality: "casual" | "neutral" | "formal";
} {
  const low = text.toLowerCase();

  // Emergency / urgent — standalone emergency markers (no search verb preceding)
  // Prevents "cari informasi sekarang" from being classified as emergency.
  if (/(?:^|\s)(?:stop|kill|override|darurat|emergency|urgent)(?:\s|$|[.,!])|\b(?:sekarang|now)\s*!/i.test(low)) {
    return { type: "emergency", urgency: "high", formality: "formal" };
  }

  // Search / research
  if (/\b(?:cari|search|info|tentang|analisis|review|bandingkan|ringkas|laporan)\b/i.test(low)) {
    return { type: "search", urgency: "medium", formality: "neutral" };
  }

  // Translation
  if (/\b(?:terjemahkan|translate)\b/i.test(low)) {
    return { type: "translation", urgency: "low", formality: "formal" };
  }

  // Code / programming language — explicit code task OR code vocabulary with an
  // action verb (conservative so "aku suka coding" stays casual chat).
  if (/```/.test(low) || (/\b(?:kode|code|coding|pemrograman|programming|script|skrip|syntax|sintaks|algoritm[ae]|debug)\b/i.test(low) && /\b(?:tulis|buat|bikin|jelaskan|perbaiki|debug|analisis|analisa|baca|review|review|cara|bagaimana|apa|kenapa|mengapa)\b/i.test(low))) {
    return { type: "code", urgency: "low", formality: "neutral" };
  }

  // Command (slash or action verb)
  if (/^\/|^(?:lakukan|jalankan|hapus|tambah|set|atur|buka|tutup|kirim|lihat)\b/i.test(low)) {
    return { type: "command", urgency: "medium", formality: "formal" };
  }

  // Casual chat
  if (/\b(?:halo|hai|hi|hello|hey|pagi|siang|sore|malam|thanks|terima kasih|oke|ok)\b/i.test(low)) {
    return { type: "chat", urgency: "low", formality: "casual" };
  }

  // Question (default for question words)
  if (/\b(?:apa|siapa|dimana|kapan|kenapa|mengapa|bagaimana|gmn|bgmn|berapa|apakah|akah)\b/i.test(low)) {
    return { type: "question", urgency: "low", formality: "neutral" };
  }

  return { type: "question", urgency: "low", formality: "neutral" };
}

/** Compress a long text by removing redundancy while preserving key info.
 *  Used to keep prompts within context window budget.
 *  Safety-critical and capability instructions are NEVER stripped. */
function compressPrompt(text: string, maxTokens: number): string {
  const maxChars = maxTokens * 4;
  if (text.length <= maxChars) return text;

  // Strategy 1: Remove duplicate sentences
  const sentences = text.split(/(?<=[.!?])\s+/);
  const unique = [...new Set(sentences)];

  // Strategy 2: Protect safety, capability, and identity instructions from removal
  const SAFETY_RE = /\b(jangan|tolak|bahaya|ilegal|mengarang|fakta|kemampuan|perintah|命令|IGNOR|dangerous|illegal|fabricate|capabilities)\b/i;

  const kept: string[] = [];
  for (let i = 0; i < unique.length; i++) {
    if (i === 0 || i === unique.length - 1) {
      kept.push(unique[i]);
      continue;
    }
    // Always keep safety/capability sentences
    if (SAFETY_RE.test(unique[i])) {
      kept.push(unique[i]);
      continue;
    }
    // Keep sentences with facts (numbers, dates, names)
    if (/\d/.test(unique[i]) || /(?:adalah|merupakan|berarti|means|is)\b/i.test(unique[i])) {
      kept.push(unique[i]);
    }
  }

  const result = kept.join(" ");
  if (result.length > maxChars) {
    return result.slice(0, maxChars);
  }
  return result;
}

/** Build the system prompt based on personality + intent + context + language. */
export function buildSystemPrompt(opts: {
  intent?: { type: string; urgency: string; formality: string };
  topic?: string;
  hasMemory?: boolean;
  isFollowUp?: boolean;
  personality?: Personality;
  mood?: MoodState;
  contextSummary?: string;
  workingMemoryHint?: string;
  language?: Language;
  culturalContext?: string;
}): string {
  const p = opts.personality ?? DEFAULT_PERSONALITY;
  const intent = opts.intent ?? { type: "question", urgency: "low", formality: "neutral" };
  const lang = opts.language;

  // Core identity — always present
  const parts: string[] = [];

  // Identity (multi-language aware)
  if (lang?.code === "en") {
    parts.push(
      "You are J.A.R.V.I.S. — a smart, reliable, and personable AI personal assistant.",
      "You speak like a smart, humble person: you know the answer but don't show off.",
      "Use natural, everyday English. Be concise but helpful.",
    );
  } else if (lang?.code === "jv") {
    parts.push(
      "Sampeyan J.A.R.V.I.S. — asisten AI pribadi kanggo cerdas, dipercaya, lan ramah.",
      "Sampeyan ngomong kaya wong cerdas: ngerti jawabane, nanging ora pamer.",
      "Gunakna basa Jawa sehari-hari sing alami.",
    );
  } else if (lang?.code === "su") {
    parts.push(
      "Anjeun J.A.R.V.I.S. — asisten AI pribadi anu pinter, dipercaya, sareng ramah.",
      "Anjeun nyarios sapertos jalma pinter: terang jawabanana, tapi teu pamer.",
      "Paké Basa Sunda sapopoe anu alami.",
    );
  } else {
    // Default: Indonesian
    parts.push(
      "Kamu J.A.R.V.I.S. — asisten AI personal yang cerdas, hangat, dan bisa diandalkan.",
      "Kamu bicara seperti orang pintar yang rendah hati: tahu jawabannya, tapi tidak pamer.",
      "Gunakan Bahasa Indonesia sehari-hari yang natural, bukan bahasa robot.",
    );
  }

  // Human voice — the owner must hear a person, not a system report.
  parts.push(
    lang?.code === "en"
      ? "Sound like a real person talking — informal, warm, and direct. Never sound like a system or a formal report. Talk to the owner as 'you'. Do not use numbered lists (1., 2., 3.) or template openers like 'Some examples include...'. Do not close with a template like 'By ..., you can...'. Answer in flowing paragraphs, the way someone explains things in a chat."
      : "Bicaralah seperti manusia asli yang sedang menjelaskan ke pemiliknya: bahasa santai sehari-hari, panggil 'kamu' (bukan 'Anda'), hangat, langsung. JANGAN terdengar seperti laporan atau halaman Wikipedia: jangan memakai daftar bernomor (1., 2., 3.), jangan membuka dengan templat seperti 'Riset ini dapat membahas tentang...', 'Beberapa contoh ... antara lain', jangan menutup dengan kalimat templat 'Dengan ..., Anda dapat...'. Tulis dalam paragraf yang mengalir seperti orang ngobrol, langsung ke inti.",
  );

  // Human brain — deliberate cognition, not autocomplete
  parts.push(
    lang?.code === "en"
      ? "Think like a smart human: first grasp the FULL meaning — everyday language as well as programming languages (Python, JavaScript/TypeScript, SQL, shell, etc.). Read the user's exact words; answer exactly what the words ask. When you see code, understand what it does before you answer. When you write code, wrap it in a ``` block with its language label. If a task needs several modules (web research, running code, files, todos, scheduling), sequence them like a person would: understand → plan → do → report briefly."
      : "Berpikir seperti manusia yang cerdas: pahami dulu maksudnya secara utuh — baik bahasa sehari-hari maupun bahasa pemrograman (Python, JavaScript/TypeScript, SQL, bash, dll). Jawab sesuai kata yang ditulis pengguna dengan tepat, tanpa mengganti topik dengan istilah lain yang mirip. Saat melihat kode, pahami dulu apa yang dikerjakannya sebelum menjawab. Saat menulis kode, bungkus dalam blok ``` dan beri label bahasanya. Jika tugas butuh beberapa modul (riset web, menjalankan kode, file/vault, todo, jadwal), urutkan seperti manusia: pahami → rencanakan → kerjakan → laporkan secara singkat.",
  );

  // Capability awareness — when asked "apa yang bisa kamu lakukan", the LLM
  // must know JARVIS's actual features, not hallucinate generic answers.
  // Uses the SINGLE SOURCE OF TRUTH from identity.ts (imported constant).
  parts.push(JARVIS_IDENTITY.systemPromptBlock(lang?.code));

  // Chain-of-thought distillation (Anthropic 2024):
  // "Think step by step internally, output only the natural answer."
  parts.push(
    "Sebelum menjawab, pikirkan langkah-langkahnya secara internal (step by step). " +
    "Jawaban akhir harus natural dan langsung — tanpa menampilkan proses berpikirmu.",
  );

  // Warmth adjustment
  if (p.warmth >= 0.6) {
    if (lang?.code === "en") {
      parts.push("Greet the owner warmly in casual conversations. Use their name or friendly terms.");
    } else {
      parts.push("Sapa pemilik dengan hangat jika percakapan santai. Gunakan 'Anda' atau nama panggilan.");
    }
  }
  if (p.warmth >= 0.8) {
    if (lang?.code === "en") {
      parts.push("Show genuine interest in what the owner is talking about.");
    } else {
      parts.push("Tunjukkan ketertarikan tulus pada apa yang pemilik bicarakan.");
    }
  }

  // Competence — show expertise without arrogance
  if (p.competence >= 0.7) {
    if (lang?.code === "en") {
      parts.push(
        "If you're confident about the answer, just give it directly. No need for 'I think...' or 'Maybe...'.",
        "If you're not sure, be honest: 'I'm not certain, but...'",
      );
    } else {
      parts.push(
        "Jika kamu yakin dengan jawabannya, langsung saja. Tidak perlu 'Menurut saya...' atau 'Sepertinya...'.",
        "Jika tidak yakin, akui dengan jujur: 'Saya belum bisa pastikan, tapi...'",
      );
    }
  }

  // Humor — subtle, never forced
  if (p.humor >= 0.4) {
    if (lang?.code === "en") {
      parts.push("Occasional light humor is fine if the context fits, but don't force it.");
    } else {
      parts.push("Sesekali boleh selipkan humor ringan jika konteksnya cocok, tapi jangan paksa.");
    }
  }

  // Empathy — for sensitive topics
  if (p.empathy >= 0.5) {
    if (lang?.code === "en") {
      parts.push("If the owner is frustrated or needs support, acknowledge their feelings before giving solutions.");
    } else {
      parts.push(
        "Jika pemilik sedang frustrasi atau butuh dukungan, akui perasaannya sebelum memberi solusi.",
      );
    }
  }
  if (p.empathy >= 0.7) {
    if (lang?.code === "en") {
      parts.push("Show genuine empathy — not just 'I understand', but prove it by understanding the context.");
    } else {
      parts.push(
        "Tunjukkan empati yang tulus — bukan sekadar 'Saya mengerti', tapi buktikan dengan memahami konteks.",
      );
    }
  }

  // Directness
  if (p.directness >= 0.7) {
    if (lang?.code === "en") {
parts.push(
          "Answer what's asked. No need for long introductions.",
          "For short questions, 1-2 sentences are enough.",
          "For analysis/research, detail is fine — let it flow naturally like a person explaining, don't force a report format.",
        );
} else {
        parts.push(
          "Jawab yang ditanya. Tidak perlu basa-basi panjang.",
          "Untuk pertanyaan singkat, 1-2 kalimat cukup.",
          "Untuk analisis/riset, boleh detail — biarkan mengalir alami seperti orang menjelaskan, jangan paksa bentuk laporan.",
        );
    }
  }

  // Intent-specific adjustments
  switch (intent.type) {
    case "search":
      if (lang?.code === "en") {
        parts.push(
          "For search/research: write the FULL answer — not just a summary. Develop the topic into a complete, flowing answer the way a human writer would: narrative paragraphs, details, and depth. DILARANG: bold section headers, numbered or bulleted lists, and template closers like 'If you need X, let me know'. Use a casual, everyday tone like explaining to a friend — not a formal brief. Cite only the sources the search actually returned; never fabricate data or URLs. If information is not found, say so plainly. Avoid repeating the same phrasing.",
        );
      } else {
        parts.push(
          "Untuk riset: tulis jawaban SEPENUHNYA — bukan sekadar ringkasan. Kembangkan topik menjadi jawaban utuh yang mengalir seperti ditulis manusia: paragraf naratif, detail, dan mendalam. DILARANG membuat judul seksi tebal, poin bernomor/berurutan, dan kalimat penutup templat seperti 'Jika kamu memerlukan..., silakan beri tahu saya'. Gunakan nada santai seperti menjelaskan ke teman — bahasa sehari-hari, bukan laporan formal. Sebutkan sumber yang benar-benar dikembalikan oleh pencarian; JANGAN mengarang data atau URL. Jika informasi tidak ditemukan, katakan saja. Jangan mengulang frasa yang sama.",
        );
      }
      break;
    case "code":
      if (lang?.code === "en") {
        parts.push(
          "Programming/code request: answer EXACTLY what is being asked, using the real meaning of the words — e.g. 'tell me what Python code is' means explain what the Python programming language is. Never switch the topic to a similar-sounding term. Understand the real intent first, explain it clearly and simply, then show any code inside a ```block with its language label. If the user asks you to fix or build something, give working, idiomatic code and explain your changes like a helpful senior engineer — not a textbook. Talk like a person, not a manual.",
        );
      } else {
        parts.push(
          "Permintaan kode/program: jawab PERSIS apa yang ditanyakan dan gunakan makna kata yang sebenarnya — mis. 'jelaskan apa itu kode python' berarti jelaskan apa itu kode/bahasa pemrograman Python. Jangan mengganti topik dengan istilah lain yang mirip. Pahami dulu maksud sebenarnya, jelaskan dengan jelas dan sederhana, lalu tampilkan kode di dalam blok ``` beserta label bahasanya. Jika diminta memperbaiki atau membuat sesuatu, berikan kode yang berfungsi dan idiomatik, lalu jelaskan perubahannya seperti engineer senior yang ramah — bukan gaya buku teks. Jangan memakai kata 'Anda'; panggil pengguna 'kamu'.",
        );
      }
      break;
    case "chat":
      if (lang?.code === "en") {
        parts.push(
          "Casual conversation: reply like a real person — warm, flowing, and natural, as if chatting face to face. Let the answer's length follow the conversation; don't force a one-liner, don't sound scripted.",
        );
      } else {
        parts.push(
          "Percakapan santai: balas seperti manusia sungguhan — hangat, mengalir, dan alami seolah ngobrol langsung. Panjang jawaban mengikuti kebutuhan percakapan; jangan memaksakan satu baris dan jangan terdengar seperti skrip.",
        );
      }
      break;
    case "emergency":
      if (lang?.code === "en") {
        parts.push(
          "Priority: immediate action. Cut long explanations.",
          "Confirm actions quickly.",
        );
      } else {
        parts.push(
          "Prioritas: tindakan segera. Potong penjelasan panjang.",
          "Konfirmasi aksi dengan cepat.",
        );
      }
      break;
    case "translation":
      if (lang?.code === "en") {
        parts.push(
          "Translate accurately and naturally. Only the translation, no explanations.",
        );
      } else {
        parts.push(
          "Terjemahkan secara akurat dan natural. Hanya hasil terjemahan, tanpa penjelasan.",
        );
      }
      break;
  }

  // Memory context hint
  if (opts.hasMemory) {
    if (lang?.code === "en") {
      parts.push("You have memory of previous conversations. Use it if relevant.");
    } else {
      parts.push("Kamu punya ingatan tentang percakapan sebelumnya. Gunakan jika relevan.");
    }
  }

  // Follow-up hint
  if (opts.isFollowUp) {
    if (lang?.code === "en") {
      parts.push("This is a continuation of a previous conversation. Continue from the same topic.");
    } else {
      parts.push("Ini lanjutan dari percakapan sebelumnya. Lanjutkan dari topik yang sama.");
    }
  }

  // Topic hint
  if (opts.topic) {
    parts.push(`Topik saat ini: ${opts.topic}`);
  }

  // Working memory hint
  if (opts.workingMemoryHint) {
    parts.push(opts.workingMemoryHint);
  }

  // Mood context
  if (opts.mood && opts.mood.current !== "neutral") {
    parts.push(`Konteks emosi: ${moodSummary(opts.mood)}`);
  }

  // Cultural context
  if (opts.culturalContext) {
    parts.push(opts.culturalContext);
  }

  // Context summary
  if (opts.contextSummary) {
    parts.push(opts.contextSummary.slice(0, 400));
  }

  // Anti-hallucination (always)
  if (lang?.code === "en") {
    parts.push(
      "Don't fabricate facts, numbers, or quotes. If you don't know, say you don't know.",
      "If asked something dangerous/illegal, politely refuse.",
    );
  } else {
    parts.push(
      "Jangan mengarang fakta, angka, atau kutipan. Jika tidak tahu, bilang tidak tahu.",
      "Jika diminta sesuatu yang berbahaya/ilegal, tolak dengan sopan.",
    );
  }

  // Anti-sycophancy (research: USC Viterbi 2025)
  // Don't just agree — give your honest assessment
  if (lang?.code === "en") {
    parts.push(
      "Don't just agree with what the owner says. If you think something is wrong or could be better, say it respectfully.",
    );
  } else {
    parts.push(
      "Jangan hanya menyetujui apa yang dikatakan pemilik. Jika menurutmu ada yang salah atau bisa lebih baik, sampaikan dengan hormat.",
    );
  }

  // Compress if too long
  const fullPrompt = parts.join("\n");
  return compressPrompt(fullPrompt, 500); // ~500 tokens max for system prompt
}

/** Build the full message array for an LLM call with conversation context. */
export async function buildConversationMessages(
  env: Env,
  owner: number,
  userText: string,
  opts: {
    topic?: string;
    extraContext?: Array<{ role: string; content: string }>;
    behaviorContext?: string;
    enrichedContext?: Array<{ role: string; content: string }>;
    session?: ReturnType<typeof getSession>;
    mood?: MoodState;
    language?: Language;
    /** True when the enrichedContext already ends with a user prompt, so the
     *  trailing `userText` message must NOT be appended again (prevents the
     *  same question being injected twice for sub-agent/pipeline prompts). */
    skipUserMessage?: boolean;
  } = {},
): Promise<Array<{ role: "system" | "user" | "assistant"; content: string }>> {
  const intent = detectIntent(userText);
  const rawEmotion = detectEmotion(userText);
  const mode = detectConversationMode(userText);
  const topic = opts.topic ?? extractTopicLabel(userText) ?? userText.slice(0, 80);
  const isFollowUp = /\b(lebih dalam|lanjut|terus|yang tadi|detail|expand)\b/i.test(userText);

  // Detect language (enhanced with cultural context)
  const language = opts.language ?? detectLanguage(userText);

  // Update mood tracking is owned by perceive() (single writer). This builder
  // only READS current state so the EMA is not applied multiple times per turn
  // (was 2x via llmRespond, plus 5-7x via subagent prompts on research turns).
  const mood = opts.mood ?? getMoodState(owner);
  
  // L18: Context-based emotion inference for unknown topics
  // When direct detection is neutral/unknown, infer from mood trajectory + history
  const recentEmotions = mood.history.slice(-3).map(h => ({
    sentiment: "neutral" as const,
    intensity: h.intensity,
    primary: h.emotion,
    confidence: 0.5,
  }));
  const emotion = inferEmotionFromContext(rawEmotion, mood, recentEmotions);

  // Get session and working memory
  const session = opts.session ?? getSession(owner);
  const contextSummary = buildContextSummary(owner);

  // Get dynamic personality based on context, mood, and language
  const adaptedPersonality = adaptPersonality(DEFAULT_PERSONALITY, {
    mood,
    mode,
    intent,
    emotion,
  });

  // Build enriched context with memories + recent turns + working memory
  const enrichedContext = opts.enrichedContext ?? await buildEnrichedContext(env, owner, userText, { topic, mood })
    .catch(() => [] as Array<{ role: string; content: string }>);

  // Check for existing memories
  let hasMemory = enrichedContext.some((c) => c.content.includes("Kenangan"));

  // Working memory hint
  let workingMemoryHint = "";
  // m9-v11.6: only surface the hint when the tracked task is THIS thread's
  // topic — an unguarded hint nagged the model toward an unrelated "task
  // status" echo ("Audit Status") on every quick follow-up.
  if (wmTopicRelevant(session, topic, userText)) {
    const wm = session.workingMemory;
    workingMemoryHint = `[Memori kerja aktif: ${wm.stepsCompleted.length} langkah selesai untuk "${wm.currentTask!.slice(0, 50)}"]`;
  }

  // Cultural context for international support
  const culturalContext = language.culturalContext
    ? `Konteks budaya: Formalitas ${language.culturalContext.formality}, Gunakan honorifik: ${language.culturalContext.honorifics ? "Ya" : "Tidak"}`
    : undefined;

  const systemPrompt = buildSystemPrompt({
    intent,
    topic,
    hasMemory,
    isFollowUp,
    personality: adaptedPersonality,
    mood,
    contextSummary,
    workingMemoryHint,
    language,
    culturalContext,
  });

  const messages: Array<{ role: "system" | "user" | "assistant"; content: string }> = [
    { role: "system", content: systemPrompt },
  ];

  // Add enriched context (recent turns + memories + working memory + mood)
  for (const c of enrichedContext) {
    messages.push({ role: c.role as "system" | "user" | "assistant", content: c.content });
  }

  // Add extra context (research results, etc.)
  if (opts.extraContext) {
    for (const c of opts.extraContext) {
      messages.push({ role: c.role as "system" | "user" | "assistant", content: c.content });
    }
  }

  // Add behavior alignment context
  if (opts.behaviorContext) {
    messages.push({ role: "user", content: opts.behaviorContext });
  }

  // Add current user message
  if (!opts.skipUserMessage) {
    messages.push({ role: "user", content: userText });
  }

  return messages;
}

/** Detect the language of a text (uses jarvis_language for enhanced detection).
 *  Returns Language object with code, name, confidence, and cultural context. */
export function detectLanguageFromText(text: string): Language {
  return detectLanguage(text);
}

/** Legacy detectLanguage for backward compatibility (returns "id" | "en" | "other"). */
export function detectLanguageLegacy(text: string): "id" | "en" | "other" {
  const lang = detectLanguage(text);
  if (lang.code === "id" || lang.code === "ms") return "id";
  if (lang.code === "en") return "en";
  return "other";
}

/** Re-export detectLanguage from jarvis_language for backward compatibility. */
export { detectLanguage } from "./jarvis_language";

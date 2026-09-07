//=====================================================================
// ai.ts — generative LLM reasoning + web search for the CF edge.
//
// Both capabilities are fail-closed: when Groq/network is unavailable
// they degrade gracefully to the existing heuristic/canned behavior
// (no hard dependency, no hard failure). This raises the edge from
// L4 (heuristic-only) toward L8/L10 (reasoning + recall) while
// staying 100% free-tier compatible.
//
// Groq: llama-3.3-70b-versatile, non-streaming single shot (worker
// CPU is I/O-wait only). DuckDuckGo instant answer is plain fetch.
//=====================================================================

import { Env, recentContext, appendMemory, searchMemory, storeLearnedKnowledge, isTopicKnown } from "./db";
import { withResilience, fetchWithTimeout, logRequest, getBreakerState } from "./resilience";
import { getAnswerBehaviorContext, reflectOnTurn } from "./evolution";
import { isResearchClass, orchestrateResearch } from "./subagents";
import { buildConversationMessages, detectLanguage } from "./conversation";
import { buildFinalReply } from "./response_formatter";
import { detectEmotion as detectEmotionSig, inferEmotionFromContext, getMoodState, detectTopicSentiment } from "./emotion";
import { JARVIS_IDENTITY, SELF_REF_RE } from "./identity";

const GROQ_MODEL = "openai/gpt-oss-120b";

/** Brief/max-depth control request (ECC token-budget-advisor pattern): the
 *  owner explicitly asks for a SHORT answer — we honor it with a system hint
 *  instead of dumping a wall of text (their budget, their call). Absent the
 *  marker, behavior is 100% unchanged. */
export const BRIEF_INTENT_RE =
  /\b(?:ringkas|intisari|intisarikan|versi singkat|jawaban singkat|secara singkat|singkat saja|singkat aja|tl;?dr|short version|keep it short|brief)\b/i;
// OpenRouter free-tier fallback. ":free" models rotate; pinned to a widely
// available free model by default, overridable via OPENROUTER_MODEL env.
const OPENROUTER_MODEL = "qwen/qwen3.6-27b";
// Google Gemini as a resilience fallback when Groq is rate-limited/down.
// Uses the free-tier model (gemma-4-31b-it) by default; can rotate to backup.
const GEMINI_API = "https://generativelanguage.googleapis.com/v1beta/models/";
const GEMINI_FREE_MODEL = "gemma-4-31b-it";

// Shared fallback system prompt when buildConversationMessages fails (used by all providers).
// Uses the single source of truth from identity.ts.
const FALLBACK_SYS = JARVIS_IDENTITY.fallbackPrompt;

/** Build fallback messages array when the personality engine fails. */
function buildFallbackMessages(
  context: Array<{ role: string; content: string }>,
  userText: string,
  topicHint = "",
): Array<{ role: "system" | "user" | "assistant"; content: string }> {
  return [
    { role: "system" as const, content: FALLBACK_SYS },
    ...context.map((c) => ({ role: c.role as "user" | "assistant", content: c.content })),
    { role: "user" as const, content: userText + topicHint },
  ];
}

// ---- Level 15 follow-up resolution --------------------------------------
// A follow-up query continues a PRIOR research answer in the same session even
// when it carries no fresh topic/search marker (e.g. "lebih dalam", "yang tadi",
// "terus, kan?") — we anchor it to the most recent assistant analysis instead of
// wrongly replying "Ok." or "Aksi ditangguhkan.".
const FOLLOWUP_RE =
  /\b(lebih dalam|lebih dalam lagi|lebih detail|lebih lanjut|lanjutkan|lanjut|lengkapin|lengkapi|perdalam|perinci|detail|detailin|terus(?:,|kan)?|yang tadi|yg tadi|tadi itu|tambahin|tambahkan|expand|go deeper|jelasin lebih|jelaskan lebih|sampe? tuntas|ceritain lebih|info lebih|maksud saya|maksudku|bukan\s+[^?!.,]{1,40}\s+tapi)\b/i;

/** True if the (already normalized) message is a follow-up request that extends
 *  a prior answer rather than starting a brand-new topic. Read-only. */
export function isFollowUpQuery(text: string): boolean {
  if (!text) return false;
  const low = text.trim();
  // Very short follow-ups ("lanjut", "terus", "lebih dalam") are almost always
  // conversational continuations, not new topics.
  if (low.length <= 12 && /^(lanjut|terus|lebih dalam|lebih detail|lebih lanjut|expand|go deeper|yang tadi|yg tadi|itu maksudnya apa)\b/i.test(low)) {
    return true;
  }
  return FOLLOWUP_RE.test(low);
}

/** True when the message is a PURE continuation command ("Lanjutkan",
 *  "terus", "selanjutnya", "next") that must EXTEND the prior reply — NOT
 *  trigger a fresh web search. Strict: a following subject ("Lanjutkan riset
 *  kompetitor") is a directive with its own object → NOT pure (searches).
 *  Deterministic, zero budget. */
export function isPureContinuation(userText: string): boolean {
  if (!userText) return false;
  const low = userText.trim().toLowerCase();
  const head = /^(lanjut|lajut|lanjutin|lanjutkan|terus|teruskan|selanjutnya|next|sambung|sambungkan|continue|ke bagian berikutnya|lebih lanjut)(?:\s*(?:dong|ya|yuk|deh|tolong|aja))?\s*[.!?…,-]?\s*$/;
  return head.test(low);
}

/** ECC continuation parity: extend the LAST assistant analysis without a new
 *  web search. The prior reply (already sourced) is the only input, so the
 *  continuation stays on the exact same topic/structure and NEVER degrades into
 *  a clarifying question ("kota Malang ..." bug — M7). Fail-closed: null when
 *  no provider answers, so the caller falls back to a fresh search reply. */
export async function continueAnalysis(
  env: Env,
  _owner: number,
  prior: string,
  userText: string,
): Promise<string | null> {
  const step = (userText || "").trim().slice(0, 80);
  const system = [
    "Kamu J.A.R.V.I.S., asisten setia pemilik. Tugas: MELANJUTKAN analisis/riset yang terpotong di atas.",
    "Aturan:",
    "1. JANGAN mengulang atau meringkas bagian yang sudah ditulis.",
    "2. LANGSUNG lanjutkan ke bagian berikutnya sesuai struktur yang sudah mulai (mis. jika baru sampai 'Kelebihan', lanjut 'Kekurangan', 'Langkah Memulai', dst. sampai tuntas).",
    "3. PERTAHANKAN gaya penjawab di atas (judul Bold, poin bernomor, Bahasa Indonesia).",
    "4. JANGAN bertanya balik ke pemilik di akhir.",
    "5. Jika semua bagian sudah tuntas, akhiri dengan satu paragraf 'Kesimpulan' yang menutup topik.",
  ].join("\n");
  const messages = [
    { role: "system", content: system },
    { role: "user", content: `Lanjutkan bagian berikut dari analisis ini (jangan ulang isinya):\n\n${(prior || "").slice(0, 6000)}` },
  ];
  try {
    const groq = await groqRespond(env, step, { prebuiltMessages: messages, topic: "continuation" });
    if (groq) return groq;
    return await openrouterRespond(env, step, { prebuiltMessages: messages, topic: "continuation" });
  } catch {
    return null;
  }
}

/** Derive a research topic from the last assistant analysis (for follow-up
 *  anchoring). Returns the last assistant reply's content as the anchor topic,
 *  or null if there's no prior assistant analysis to build on.
 *
 *  The anchor must point at the ACTUAL current research answer — never at a
 *  stale clarification or an unrelated older turn. Guards, all fail-closed
 *  (return null when unsure, so the caller falls through to the generic reply):
 *   1. FRESHNESS — only context from the last <RECENT_MS> is eligible. An
 *      old turn (minutes/hours ago) is not a valid anchor for a live
 *      follow-up like "Lakukan riset lebih lanjut".
 *   2. NO-CLARIFICATION — turns that are questions back at the owner
 *      ("Anda ingin saya...? / benarkah?") or bare short acks are NOT answers;
 *      anchoring a follow-up to them reproduces the off-topic "Kota Malang"
 *      bug. Only substantive replies qualify. */
const RECENT_MS = 15 * 60 * 1000; // 15 minutes
const CLARIFY_RE =
  /(?:benarkah|apakah\s+anda\s+ingin|yang\s+dimaksud|bener\s+ga|yakin|benar\?|maksud\s+anda|apakah\s+itu\s+yang|apakah\s+ini\s+yang)/i;

export function resolveFollowUpAnchor(
  context: Array<{ role: string; content: string; ts?: number }>,
): { topic: string; prior: string } | null {
  const now = Date.now();
  const lastAssistant = [...(context || [])].reverse().find((c) => {
    if (c.role !== "assistant") return false;
    if (typeof c.ts === "number" && now - c.ts > RECENT_MS) return false;
    const t = (c.content || "").trim();
    if (t.length < 30) return false;
    // Only SHORT clarification/questions are rejected as anchors. A long,
    // substantive answer that merely ENDS with "Apakah Anda ingin…?" is still
    // a valid anchor — its trailing question is stripped below ("kota Malang"
    // bug M7), not the whole reply discarded.
    if (CLARIFY_RE.test(t) && t.length < 120) return false;
    return true;
  });
  if (!lastAssistant || !lastAssistant.content || lastAssistant.content.trim().length < 30) return null;
  const text = lastAssistant.content.trim();
  // Topic anchor: a CLEAN phrase, not a raw sentence. Strip trailing
  // question/closing-fluff and clip at a word boundary so follow-up searches
  // don't re-query sentence fragments ("kota Malang ..." bug) — the topic fed
  // to the searcher must be noun-phrase-ish, while `prior` keeps the full text.
  const trimmed = text.replace(/[\s.…]+[.?!…]*\s*$/, "").replace(/\s+/g, " ").trim();
  const clipped = trimmed.length > 90 ? trimmed.slice(0, 90).replace(/\s\S*$/, "") : trimmed;
  return { topic: clipped.length > 0 ? clipped : text.slice(0, 90), prior: text.slice(0, 3000) };
}

/** Pull a concrete topic from a search/summarize request (shared with webhook).
 *  Recognizes explicit search verbs AND research/analytical markers so queries
 *  like "Analisis bisnis paling menguntungkan..." (which carry no `cari`/`tentang`
 *  word) still reach the search path instead of wrongly DEFERing.
 *  Fuzzy-tolerant: common misspellings/typo variants of each marker are included
 *  in the alternation (QueryStack fuzzy 2026; Kondrak n-gram LCS) — no LLM
 *  budget spent, zero dependency, deterministic. */
//=====================================================================
// regex-vs-LLM routing rule (ECC pattern, maintained — M7):
//   1. DETERMINISTIC first: exact regex/heuristic wins when it matches
//      cleanly (commands, markers, language, norms). Zero LLM cost, zero
//      hallucination, fully testable (see test/logic.test.ts).
//   2. LLM/Groq ONLY for the low-confidence boundary: when the heuristic is
//      UNSURE (ambiguous phrasing, unknown entity), groqClassify picks the
//      intent; parseStructured parses JSON-shaped facts.
//   3. Contract: heuristics NEVER silently swallow text the LLM path also
//      claims (see the "riset" fix — the marker had to exist in every layer).
//   When touching intent classification, update BOTH comment + tests here.
//=====================================================================
export function extractTopic(text: string): string | null {
  const low = text.trim().toLowerCase();
  const m = low.match(
    /\b(?:cari|carii|cr|search|riset|reseach|research|studi|study|pelajari|mempelajari|meneliti|tentang|tenteng|tentan|tntg|ringkas|rangkum|summarize|artikel|topik|info|infp|informasi|analis\w*|laporan|laporn|report|review|riviu|perbandingan|bandingkan|perkembangan|ulasan|ulsn|kajian|menurut|menurutmu|bagaimana|gmn|bgmn|apa|apakah|siapa|kenapa|mengapa|kapan|berapa|dimana|di mana)\b(?:\s+(?:itu|apa|yang|kah|adalah|dengan|tentang|mengenai))?\s*[:\-]?\s*(.+)$/,
  );
  if (!m) return null;
  // Strip leading filler tokens repeatedly (a token cascade like
  // "tolong buatkan tentang X" needs multiple passes, not a one-shot slice).
  let topic = m[1].replace(/[?.!,;:]+$/g, "").trim();
  const head = /^(?:bantu|tolong|buatkan|please|let me|lagi|dong|sudah|untuk|itu|apa|yang|kah|adalah|tentang|mengenai)\s+/i;
  while (head.test(topic)) topic = topic.replace(head, "");
  topic = topic.trim();
  if (!topic) return null;
  // Guard: phrases that look like research topics but are actually self-ref
  // ("apa kabar", "apa yang bisa kamu lakukan", "bisa kamu lakukan") — these
  // are NOT research topics, so the generic single-pass engine should handle them.
  if (/^(kabar|khabar|kabar baik|kabar gembira|halo|hai|naik|hoax|yang bisa|bisa kamu|kamu bisa|kamu lakukan|apa yang bisa|apa uang bisa)/i.test(topic)) return null;
  return topic.length >= 3 ? topic.slice(0, 120) : null;
}

/** Parse a translation request: "Terjemahkan <teks>" or "Terjemahkan ke
 *  <bahasa> <teks>" (and likewise for "translate"/"translate to"). Returns the
 *  source text and an optional target language, or null if this isn't a
 *  translate request. Not a research topic — handled by its own dedicated path
 *  so it no longer falls through to the generic "Ok." reply. */
export function parseTranslate(text: string): { target: string | null; source: string } | null {
  const raw = text.trim();
  // Strip the leading verb/phrase: "Terjemahkan", "translate", "translate it",
  // "terjemahkan ke", "translate to/into".
  const verb = raw.match(/^terjemahkan(?:\s+ke)?|^translate(?:\s+it)?(?:\s+to|\s+into)?/i);
  if (!verb) return null;
  const rest = raw.slice(verb[0].length).trim();
  if (!rest) return null;
  // Detect an explicit target-language phrase at the head of the rest,
  // e.g. "ke bahasa Inggris", "Inggris", "to English", "English".
  const lang = rest.match(
    /^(?:(?:ke\s+)?(?:dalam\s+)?bahasa\s+|(?:\bin\b|to|into|ke|dalam)\s+)?(inggris|english|indonesia|indonesian|jepang|japanese|korea|korean|mandarin|china|chinese|arab|arabic|prancis|french|jerman|german|spanyol|spanish|italia|italian|portugis|portuguese|russia|russian|belanda|dutch|thai|hindi|india)\b\s*/i,
  );
  if (lang) {
    const target = normalizeLang(lang[1]);
    const source = rest.slice(lang[0].length).trim();
    if (!source) return null; // verb + language only, no text to translate
    return { target, source };
  }
  return { target: null, source: rest };
}

const LANG_MAP: Record<string, string> = {
  english: "English", inggris: "English",
  indonesia: "Indonesian", indonesian: "Indonesian",
  japanese: "Japanese", jepang: "Japanese",
  korean: "Korean", korea: "Korean",
  mandarin: "Mandarin Chinese", china: "Mandarin Chinese", chinese: "Mandarin Chinese",
  arabic: "Arabic", arab: "Arabic",
  french: "French", prancis: "French",
  german: "German", jerman: "German",
  spanish: "Spanish", spanyol: "Spanish",
  italian: "Italian", italia: "Italian",
  portuguese: "Portuguese", portugis: "Portuguese",
  russian: "Russian", russia: "Russian",
  dutch: "Dutch", belanda: "Dutch",
  thai: "Thai",
  hindi: "Hindi", india: "Hindi",
};
function normalizeLang(tok: string): string {
  const k = tok.toLowerCase();
  return LANG_MAP[k] ?? (k[0]?.toUpperCase() ?? "English") + k.slice(1);
}

/** Produce a translation of the given source text (free-form target language).
 *  Read-only, fail-closed: returns null on any failure so the caller falls back
 *  to a graceful canned reply — never an error. Uses the same Groq→Gemini
 *  dispatch as research so it needs no new provider/budget. */
export async function translateText(
  env: Env,
  source: string,
  target: string | null,
): Promise<string | null> {
  const targetPhrase = target ? target : "(sesuaikan: gunakan bahasa target yang masuk akal dari konteks/isi teks)";
  const sys =
    "Kamu adalah sub-agen PENERJEMAH which only translates text. " +
    "Balas HANYA dengan hasil terjemahan, tanpa penjelasan, tanpa sinyal kutip, " +
    "tanpa menambah komentar. Terjemahkan secara akurat dan natural ke bahasa target. " +
    `Bahasa target: ${targetPhrase}.`;
  const g = await llmRespond(env, source, {
    topic: "terjemahan",
    context: [{ role: "system", content: sys }],
  });
  return g.reply;
}

/** Deterministic repair when the token budget was exhausted: strip any dangling
 *  trailing list marker / unclosed formatting so the listener never receives a
 *  half-cut bullet, then append an honest continuation hint. Applies ONLY when
 *  the API reported finish_reason === "length" (genuine truncation). Never throws. */
export function repairTruncatedReply(reply: string): string {
  let out = (reply ?? "").trim();
  // 1) Drop a lone trailing list marker ("5.", "5)", "- ", "* ").
  out = out.replace(/\s*(?:\n+\s*\d+\.|\n+\s*\d+\)|\n+\s*[-*])\s*$/u, "");
  // 2) Drop an unclosed trailing markdown segment ("**...**" unterminated).
  const openBolds = (out.match(/\*\*/g) ?? []).length;
  if (openBolds % 2 === 1) out = out.replace(/\*\*[^*]*$/u, "");
  // 3) Drop a trailing colon that only opens an item that never got written.
  out = out.replace(/[:：]\s*$/u, "").trim();
  if (!out) return out;
  return `${out}\n\n📌 Jawaban saya terpotong oleh batas panjang — ketik \u201clanjut\u201d untuk bagian berikutnya.`;
}

/** Rough prompt/response token estimate (chars/4) for the free-tier cost
 *  ledger. Cheap and never throws — precision is not the goal. */
export function estimateTokens(text: string): number {
  try { return Math.max(1, Math.ceil((text ?? "").length / 4)); } catch { return 1; }
}

/** Append an estimated usage event to a rolling cost ledger in CONFIG_KV
 *  (`cost:<YYYY-MM>` → { provider: { used }}). ECC cost-aware-pipeline parity:
 *  we must SEE our free-tier budget burn per provider before it surprises us.
 *  100% best-effort + fire-and-forget — never adds latency/threats to replies. */
export async function trackTokenUsage(env: Env, provider: string, inTokens: number, outTokens: number): Promise<void> {
  try {
    const d = new Date();
    const key = `cost:${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    const prev = await env.CONFIG_KV.get(key).catch(() => null);
    const cur = (prev ? JSON.parse(prev) : {}) as Record<string, { used?: number }>;
    const used = (cur[provider]?.used ?? 0) + (inTokens || 0) + (outTokens || 0);
    cur[provider] = { used };
    await env.CONFIG_KV.put(key, JSON.stringify(cur), { expirationTtl: 370 * 86400 }).catch(() => {});
  } catch { /* best-effort */ }
}

/** Try to produce a generative assistant reply via Groq, using recent
 *  conversation context as memory. Returns null on any failure so the
 *  caller falls back to the canned reply (fail-closed). */
export async function groqRespond(
  env: Env,
  userText: string,
  opts: { context?: Array<{ role: string; content: string }>; topic?: string; contextIsEnriched?: boolean; prebuiltMessages?: Array<{ role: string; content: string }> } = {},
): Promise<string | null> {
  const key = env.GROQ_API_KEY;
  if (!key) return null;
  const context = opts.context ?? [];

  const messages = opts.prebuiltMessages ?? await buildConversationMessages(
    env,
    Number(env.OWNER_TELEGRAM_ID),
    userText,
    opts.contextIsEnriched && context.length > 0
      ? { topic: opts.topic, enrichedContext: context }
      : { topic: opts.topic, extraContext: context.length > 0 ? context : undefined },
  ).catch(() => buildFallbackMessages(context, userText));

  let reply: string | null = null;
  const ok = await withResilience(env, "groq", 0, async (timeoutMs) => {
    const res = await fetchWithTimeout("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        model: GROQ_MODEL,
        temperature: 0.6,
        messages,
        max_tokens: 1400,
      }),
    }, timeoutMs);
    if (!res.ok) return { ok: false, status: res.status };
    const data = (await res.json()) as { choices?: { message?: { content?: string }; finish_reason?: string }[]; usage?: { prompt_tokens?: number; completion_tokens?: number } };
    const content = data.choices?.[0]?.message?.content?.trim() ?? "";
    if (!content) return { ok: false, status: res.status };
    reply = data.choices?.[0]?.finish_reason === "length" ? repairTruncatedReply(content) : content;
    void trackTokenUsage(
      env, "groq",
      data.usage?.prompt_tokens ?? messages.reduce((a, m) => a + estimateTokens(m.content ?? ""), 0),
      data.usage?.completion_tokens ?? estimateTokens(reply),
    ).catch(() => {});
    return { ok: true, status: res.status };
  });
  return ok ? reply : null;
}

/** OpenRouter generative response (free/provided models) — resilience fallback
 *  once Groq is unavailable, adding breadth cheaply under a single key. Mirrors
 *  groqRespond's OpenAI-compatible shape; null on any failure so the chain stays
 *  fail-closed. Fail-open: returns null (never throws) when key/model missing or
 *  the provider errors, so it can never block the other providers. */
export async function openrouterRespond(
  env: Env,
  userText: string,
  opts: { context?: Array<{ role: string; content: string }>; topic?: string; contextIsEnriched?: boolean; prebuiltMessages?: Array<{ role: string; content: string }> } = {},
): Promise<string | null> {
  const key = env.OPENROUTER_API_KEY;
  if (!key) return null; // fail-open: not configured
  const context = opts.context ?? [];

  const messages = opts.prebuiltMessages ?? await buildConversationMessages(
    env,
    Number(env.OWNER_TELEGRAM_ID),
    userText,
    opts.contextIsEnriched && context.length > 0
      ? { topic: opts.topic, enrichedContext: context }
      : { topic: opts.topic, extraContext: context.length > 0 ? context : undefined },
  ).catch(() => buildFallbackMessages(context, userText));

  const model = env.OPENROUTER_MODEL || OPENROUTER_MODEL;
  let reply: string | null = null;
  const ok = await withResilience(env, "openrouter", 0, async (timeoutMs) => {
    const res = await fetchWithTimeout("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${key}`,
        "HTTP-Referer": "https://jarvis-sovereign.vikricahya64.workers.dev",
        "X-Title": "JARVIS-Sovereign",
      },
      body: JSON.stringify({
        model,
        temperature: 0.6,
        messages,
        max_tokens: 1400,
      }),
    }, timeoutMs);
    if (!res.ok) return { ok: false, status: res.status };
    const data = (await res.json()) as { choices?: { message?: { content?: string }; finish_reason?: string }[]; usage?: { prompt_tokens?: number; completion_tokens?: number } };
    const content = data.choices?.[0]?.message?.content?.trim() ?? "";
    if (!content) return { ok: false, status: res.status };
    reply = data.choices?.[0]?.finish_reason === "length" ? repairTruncatedReply(content) : content;
    void trackTokenUsage(
      env, "openrouter",
      data.usage?.prompt_tokens ?? messages.reduce((a, m) => a + estimateTokens(m.content ?? ""), 0),
      data.usage?.completion_tokens ?? estimateTokens(reply),
    ).catch(() => {});
    return { ok: true, status: res.status };
  });
  return ok ? reply : null;
}

/** Google Gemini generative response (free-tier gemma) — resilience fallback
 *  to Groq. Mirrors groqRespond's shape; returns null on any failure so the
 *  chain stays fail-closed. Supports a primary + backup API key rotation. */
export async function geminiRespond(
  env: Env,
  userText: string,
  opts: { context?: Array<{ role: string; content: string }>; topic?: string; contextIsEnriched?: boolean; prebuiltMessages?: Array<{ role: string; content: string }> } = {},
): Promise<string | null> {
  const keys = [env.GEMINI_API_KEY, env.GEMINI_API_KEY_BACKUP, env.GEMINI_API_KEY_SECONDARY].filter(
    (k): k is string => Boolean(k),
  );
  if (keys.length === 0) return null;
  const context = opts.context ?? [];

  const messages = opts.prebuiltMessages ?? await buildConversationMessages(
    env,
    Number(env.OWNER_TELEGRAM_ID),
    userText,
    opts.contextIsEnriched && context.length > 0
      ? { topic: opts.topic, enrichedContext: context }
      : { topic: opts.topic, extraContext: context.length > 0 ? context : undefined },
  ).catch(() => buildFallbackMessages(context, userText));

  // Convert messages array to Gemini's single-prompt format
  const systemMsg = messages.find((m) => m.role === "system")?.content ?? "";
  const conversationParts = messages
    .filter((m) => m.role !== "system")
    .map((m) => `${m.role}: ${m.content}`)
    .join("\n\n");
  const prompt = systemMsg + "\n\n" + conversationParts;

  for (const apiKey of keys) {
    const model = env.GEMINI_MODEL || GEMINI_FREE_MODEL;
    let reply: string | null = null;
    const ok = await withResilience(env, "gemini", 1, async (timeoutMs) => {
      const res = await fetchWithTimeout(
        `${GEMINI_API}${model}:generateContent?key=${encodeURIComponent(apiKey)}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: { temperature: 0.6, maxOutputTokens: 1200 },
          }),
        },
        timeoutMs,
      );
      if (!res.ok) return { ok: false, status: res.status };
      const data = (await res.json()) as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> }; finishReason?: string }>; usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number } };
      const content = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() ?? "";
      if (!content) return { ok: false, status: res.status };
      reply = data.candidates?.[0]?.finishReason === "MAX_TOKENS" ? repairTruncatedReply(content) : content;
      void trackTokenUsage(
        env, "gemini",
        data.usageMetadata?.promptTokenCount ?? estimateTokens(prompt),
        data.usageMetadata?.candidatesTokenCount ?? estimateTokens(reply),
      ).catch(() => {});
      return { ok: true, status: res.status };
    });
    if (ok && reply) return reply;
  }
  return null;
}

/** Cloudflare Workers AI — free edge inference, no API key needed.
 *  Uses the AI binding (env.AI) from wrangler.toml. OpenAI-compatible
 *  via env.AI.run() or direct fetch to the CF AI endpoint.
 *  Returns null on any failure so the chain stays fail-closed.
 *  Uses withResilience so the free edge model participates in the same
 *  circuit breaker, retry and observability as the external providers
 *  (instead of silently failing off the observability radar). */
export async function workersAiRespond(
  env: Env,
  userText: string,
  opts: { context?: Array<{ role: string; content: string }>; topic?: string; contextIsEnriched?: boolean; prebuiltMessages?: Array<{ role: string; content: string }> } = {},
): Promise<string | null> {
  if (!env.AI) return null;
  const context = opts.context ?? [];

  const messages = opts.prebuiltMessages ?? await buildConversationMessages(
    env,
    Number(env.OWNER_TELEGRAM_ID),
    userText,
    opts.contextIsEnriched && context.length > 0
      ? { topic: opts.topic, enrichedContext: context }
      : { topic: opts.topic, extraContext: context.length > 0 ? context : undefined },
  ).catch(() => buildFallbackMessages(context, userText));

  // Workers AI model — use a good conversational model
  const model = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

  let reply: string | null = null;
  const ok = await withResilience(env, "workers_ai", 0, async (timeoutMs) => {
    const started = Date.now();
    // AI.run() is not simple fetch; proxy it with a timeout guard.
    return await new Promise<{ ok: boolean; status: number }>((resolve) => {
      const timer = setTimeout(() => resolve({ ok: false, status: 0 }), timeoutMs);
      env.AI.run(model, { messages, max_tokens: 900, temperature: 0.6 })
        .then((res) => {
          clearTimeout(timer);
          const r = (res as { response?: string; usage?: { input_tokens?: number; output_tokens?: number } }).response?.trim();
          if (r) {
            // Workers AI reports no finish_reason — infer truncation from usage:
            // output tokens pinned at the 900 budget ⇒ treat as "length" so the
            // answer gets the same honest continuation hint as the other tiers
            // (M7 cost-aware pipeline: silent 900-token cuts are a capability leak).
            const outTok = (res as { usage?: { output_tokens?: number } }).usage?.output_tokens ?? estimateTokens(r);
            reply = outTok >= 880 ? repairTruncatedReply(r) : r;
            void trackTokenUsage(
              env, "workers_ai",
              (res as { usage?: { input_tokens?: number } }).usage?.input_tokens
                ?? messages.reduce((a, m) => a + estimateTokens(m.content ?? ""), 0),
              outTok,
            ).catch(() => {});
            resolve({ ok: true, status: 200 });
          } else {
            resolve({ ok: false, status: 0 });
          }
        })
        .catch((e) => {
          clearTimeout(timer);
          console.error("workers_ai:", String(e).slice(0, 120));
          resolve({ ok: false, status: 0 });
        });
      void started;
    });
  });
  return ok ? reply : null;
}

/** Generative LLM dispatch with Workers AI → Groq → Gemini resilience ordering.
 *  Returns the first provider that answers, or null if all fail. Source tells
 *  the caller which provider carried the response.
 *  Builds conversation messages ONCE and shares across all providers (4x → 1x). */
export async function llmRespond(
  env: Env,
  userText: string,
  opts: { context?: Array<{ role: string; content: string }>; topic?: string; contextIsEnriched?: boolean } = {},
): Promise<{ reply: string | null; source: "workers_ai" | "groq" | "openrouter" | "gemini" | "self_ref" | null }> {
  // SELF-REFERENTIAL INTERCEPT — the brain's first and most important guard.
  // If the input asks "who are you" or "what can you do", answer directly from
  // the identity's single source of truth. NEVER call an external LLM for this,
  // because a generic LLM will hallucinate (e.g. answer about "uang" — money).
  // This guard runs at the COGNITION level so it works no matter which path
  // reached the LLM (webhook, searchAndSynthesize, subagents, queue, etc.).
  const selfRefText = (userText || "").trim().toLowerCase();
  if (SELF_REF_RE.test(selfRefText)) {
    return { reply: JARVIS_IDENTITY.selfRefReply, source: "self_ref" };
  }

  const context = opts.context ?? [];

  // Build messages ONCE — shared across all providers (avoids 4x redundant buildConversationMessages calls)
  const prebuiltMessages = await buildConversationMessages(
    env,
    Number(env.OWNER_TELEGRAM_ID),
    userText,
    opts.contextIsEnriched && context.length > 0
      ? { topic: opts.topic, enrichedContext: context }
      : { topic: opts.topic, extraContext: context.length > 0 ? context : undefined },
  ).catch(() => buildFallbackMessages(context, userText));

  const sharedOpts = { ...opts, prebuiltMessages };

  // Provider cascade with circuit-breaker awareness (free-tier smoothing).
  // Workers AI (free edge) → Groq (free) → OpenRouter (free models) → Gemini
  // (free last-resort). A provider whose breaker is OPEN is skipped up front
  // (fast-fail) instead of burning an HTTP attempt + latency; its cooldown
  // will reopen it later automatically via half-open probing. D1 reads only
  // happen when the breaker has not been consulted recently (KV warm cache).
  const preferred: Array<{ p: "workers_ai" | "groq" | "openrouter" | "gemini"; fn: () => Promise<string | null>; src: "workers_ai" | "groq" | "openrouter" | "gemini" }> = [
    { p: "workers_ai", fn: () => workersAiRespond(env, userText, sharedOpts), src: "workers_ai" },
    { p: "groq", fn: () => groqRespond(env, userText, sharedOpts), src: "groq" },
    { p: "openrouter", fn: () => openrouterRespond(env, userText, sharedOpts), src: "openrouter" },
    { p: "gemini", fn: () => geminiRespond(env, userText, sharedOpts), src: "gemini" },
  ];
  for (const cand of preferred) {
    if (cand.p === "workers_ai" && !env.AI) continue;
    // Fail-closed: breaker read failure means "try it" (availability first).
    const state = await getBreakerState(env, cand.p).catch(() => "closed" as const);
    if (state === "open") {
      console.error(`[llm] skipped ${cand.p}: breaker open`);
      continue;
    }
    const r = await cand.fn();
    if (r) return { reply: r, source: cand.src };
  }
  return { reply: null, source: null };
}

/** Generic text extractor: strip HTML tags & entity whitespace. */
function stripTags(s: string): string {
  return s
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&amp;|&lt;|&gt;|&quot;/g, (m) =>
      m === "&nbsp;" ? " " : m === "&amp;" ? "&" : m === "&lt;" ? "<" : m === "&gt;" ? ">" : '"',
    )
    .replace(/\s+/g, " ")
    .trim();
}

/** DuckDuckGo search via plain fetch (no API key, free), with layered fallbacks.
 *  Tries the Official Instant Answer API (JSON) then the HTML endpoint, and
 *  finally Bing's lightweight HTML as a last resort. Returns a short human-
 *  readable summary or null when every source is unreachable.
 *  Returns an object so the caller can also know which source responded. */
export async function ddgSearch(env: Env, query: string): Promise<string | null> {
  const attempts: Array<() => Promise<string | null>> = [
    // 1) Official Instant Answer API (JSON) — most stable, no scraping.
    async () => {
      const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`;
      const res = await fetchWithTimeout(url, { headers: { "Accept-Language": "id,id,en;q=0.8" } }, 10000);
      if (!res.ok) return null;
      const d = (await res.json()) as {
        AbstractText?: string;
        Heading?: string;
        AbstractURL?: string;
        RelatedTopics?: Array<{ Text?: string }>;
      };
      const parts: string[] = [];
      if (d.AbstractText) parts.push(`${d.Heading || query}: ${d.AbstractText}`);
      const first = d.RelatedTopics?.find((t) => t.Text);
      if (first?.Text && parts.length < 2) parts.push(String(first.Text));
      return parts.length ? parts.join(" — ").slice(0, 400) : null;
    },
    // 2) HTML endpoint (scrape) — bots/challenges may block; regex-tolerant.
    async () => {
      const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
      const res = await fetchWithTimeout(url, { headers: { "Accept-Language": "id,id-ID;q=0.9,en;q=0.8" } }, 10000);
      if (!res.ok) return null;
      const html = await res.text();
      const a = html.match(/class="result__a"[^>]*>([\s\S]*?)<\/a>/i);
      const sn = html.match(/class="result__snippet"[^>]*>([\s\S]*?)<\/a>/i);
      if (!a && !sn) return null;
      const title = a?.[1] ? stripTags(a[1]) : null;
      const snippet = sn?.[1] ? stripTags(sn[1]) : null;
      if (!title && !snippet) return null;
      return [title, snippet].filter(Boolean).join(" — ").slice(0, 400);
    },
    // 3) SearXNG public meta-search — aggregates many upstream engines, giving
    //    the search path an independent egress reputation beyond DDG/Bing.
    async () => {
      const hits = await searxngSearch(query);
      if (!hits.length) return null;
      return hits.slice(0, 2).map((h) => `${h.title}: ${h.snippet}`).join(" — ").slice(0, 400);
    },
    // 4) Bing lightweight HTML — different egress reputation, likely reachable.
    async () => {
      const url = `https://www.bing.com/search?q=${encodeURIComponent(query)}&count=1`;
      const res = await fetchWithTimeout(url, {
        headers: { "User-Agent": "Mozilla/5.0 (Linux; Android 10)", "Accept-Language": "en,id;q=0.8" },
      }, 10000);
      if (!res.ok) return null;
      const html = await res.text();
      const m = html.match(/<li class="b_algo"[^>]*>([\s\S]*?)<\/li>/i);
      if (!m?.[1]) return null;
      const block = stripTags(m[1]).slice(0, 400);
      return block || null;
    },
  ];
  let result: string | null = null;
  const start = Date.now();
  for (const tryFn of attempts) {
    const r = await tryFn().catch(() => null);
    if (r) {
      result = r;
      break;
    }
  }
  await logRequest(env, "ddg", result ? "ok" : "fail", Date.now() - start, 0,
    result ? "search ok" : "all layers failed");
  return result;
}

/** A single web-search hit with its snippet (untrusted, must be spotlighted
 *  before reaching any LLM — see retrieval rail in subagents.ts). */
export interface SearchHit {
  title: string;
  url: string;
  snippet: string;
}

/** Structured search hits WITH URLs (used for citations). Fail-closed: always
 *  returns an array; layers that can't produce a URL are skipped. Deduped by
 *  host so the source list never feels like a link-farm. */
export async function ddgSearchHits(env: Env, query: string): Promise<SearchHit[]> {
  const hits: SearchHit[] = [];
  try {
    // 1) Official Instant Answer API — carries an AbstractURL.
    const ia = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`;
    const res = await fetchWithTimeout(ia, { headers: { "Accept-Language": "id,id,en;q=0.8" } }, 10000);
    if (res.ok) {
      const d = (await res.json()) as { Heading?: string; AbstractURL?: string; AbstractText?: string };
      if (d.AbstractURL && d.Heading) {
        hits.push({ title: `${d.Heading}: ${(d.AbstractText ?? "").slice(0, 120)}`, url: d.AbstractURL, snippet: d.AbstractText ?? "" });
      }
    }
  } catch { /* fail-closed */ }
  // 2) SearXNG meta-search — structured title/url/snippet.
  const searx = await searxngSearch(query).catch(() => [] as SearchHit[]);
  for (const h of searx) hits.push(h);
  // Dedupe by host (keep strongest first), cap at 6.
  const seen = new Set<string>();
  const out: SearchHit[] = [];
  for (const h of hits) {
    let host = "";
    try { host = new URL(h.url).hostname.replace(/^www\./, ""); } catch { host = h.url.slice(0, 40); }
    if (!host || seen.has(host)) continue;
    seen.add(host);
    out.push(h);
    if (out.length >= 6) break;
  }
  return out;
}

/** Pure, deterministic source-citation list (markdown) for appending to replies.
 *  ECC deep-research parity: answers carry source attribution — real, DEDUPED
 *  by host, query-noise-free, never invented (fail-closed). */
export function formatSourceList(hits: SearchHit[], max = 4): string {
  const seen = new Set<string>();
  const rows: string[] = [];
  for (const h of hits) {
    if (!h?.url || !h?.title) continue;
    // Dedupe by host (keep the strongest first hit per site).
    let host = "";
    try { host = new URL(h.url).hostname.replace(/^www\./, ""); } catch { host = ""; }
    if (host && seen.has(host)) continue;
    if (host) seen.add(host);
    const title = h.title.replace(/[\[\]()]/g, "").trim().slice(0, 70);
    if (!title) continue;
    const clean = h.url.split("?")[0]; // strip ALL utm/query noise
    rows.push(`[${title}](${clean})`);
    if (rows.length >= max) break;
  }
  return rows.length ? rows.map((r, i) => `${i + 1}. ${r}`).join("\n") : "";
}

/** SearXNG public meta-search (JSON), fail-closed. Aggregates multiple upstream
 *  engines (Google/Bing/DDG/wikipedia) under one plain-HTTP call — gives the
 *  search path a third, independent egress reputation beyond DDG and Bing.
 *  Public instances come and go; we try a couple of long-lived ones and return
 *  whatever aggregates, returning [] on any block/unreachability. */
async function searxngSearch(query: string): Promise<SearchHit[]> {
  const instances = ["https://searx.be", "https://searxng.world"];
  for (const base of instances) {
    try {
      const url = `${base}/search?q=${encodeURIComponent(query)}&format=json&language=${encodeURIComponent("id-ID")}`;
      const res = await fetchWithTimeout(url, {
        headers: { "User-Agent": "Mozilla/5.0 (X11; Linux x86_64)", "Accept": "application/json" },
      }, 9000);
      if (!res.ok) continue;
      const d = (await res.json()) as { results?: Array<{ title?: string; url?: string; content?: string }> };
      const hits = (d.results ?? [])
        .filter((r) => r.title && r.url)
        .map((r) => ({
          title: String(r.title).slice(0, 180),
          url: String(r.url).slice(0, 200),
          snippet: (r.content ?? "").slice(0, 340),
        }));
      if (hits.length) return hits.slice(0, 10);
    } catch { /* next instance */ }
  }
  return [];
}

/** Deterministic HTML→readable-text conversion (regex-based; Workers has no DOM). */
function readableText(html: string): string {
  const cleaned = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<(?:nav|header|footer|aside|iframe|svg|form|noscript)[\s\S]*?<\/(?:nav|header|footer|aside|iframe|svg|form|noscript)>/gi, " ")
    .replace(/<\/(?:p|h[1-6]|li|div|section|article|br|tr)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#39;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/&#x27;/gi, "'");
  // Collapse whitespace but keep paragraph/newline structure minimal.
  return cleaned.split(/\s*\n\s*/).map((l) => l.replace(/\s+/g, " ").trim()).filter((l) => l.length > 1).join("\n").trim();
}

/** Bounded deep-page reader: fetches url, reads at most MAX_BYTES of the body,
 *  strips boilerplate, returns the best readable-text prefix (>=120 chars) or
 *  null. Deterministic and fail-closed: it never throws, never hangs the caller
 *  beyond the timeout, and never returns a useless sliver of text. */
export async function deepReadPage(env: Env, url: string, maxChars = 1400): Promise<string | null> {
  const MAX_BYTES = 60000;
  try {
    if (!/^https?:\/\/[^\s]+$/.test(url)) return null;
    const res = await fetchWithTimeout(url, {
      headers: { "User-Agent": "Mozilla/5.0 (Linux; Android 10) JARVIS/1.0", "Accept-Language": "id,en;q=0.8" },
    }, 8000);
    if (!res.ok || !res.body) return null;
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        chunks.push(value);
        total += value.byteLength;
        if (total >= MAX_BYTES) break;
      }
    }
    reader.releaseLock();
    const bytes = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) { bytes.set(c, off); off += c.byteLength; }
    const text = readableText(new TextDecoder("utf-8").decode(bytes)).slice(0, maxChars);
    return text.length >= 120 ? text : null;
  } catch {
    return null;
  }
}

/** Multi-result web search (parallel fan-out support). Same layered-fallback
 *  strategy as ddgSearch() but returns the top N structured findings — richer
 *  evidence for the sub-agent writer to synthesize across multiple angles.
 *  Always fail-open: returns [] when unreachable (caller degrades gracefully). */
export async function searchTopResults(env: Env, query: string, limit = 3): Promise<SearchHit[]> {
  const attempts: Array<() => Promise<SearchHit[]>> = [
    // 1) DDG HTML endpoint — multiple titled results with snippets + hrefs.
    async () => {
      const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
      const res = await fetchWithTimeout(url, { headers: { "Accept-Language": "id,id-ID;q=0.9,en;q=0.8" } }, 10000);
      if (!res.ok) return [];
      const html = await res.text();
      const titles = [...html.matchAll(/class="result__a"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi)];
      const snips = [...html.matchAll(/class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi)];
      const hits: SearchHit[] = [];
      for (let i = 0; i < titles.length && hits.length < limit; i++) {
        const title = stripTags(titles[i][2] || "").slice(0, 180);
        if (!title) continue;
        const snippet = (snips[i]?.[1] ? stripTags(snips[i][1]) : "").slice(0, 340);
        // href is a DDG redirect; keep a short urlsafe form for citation.
        const href = titles[i][1] || "";
        const url = /uddg=([^&]+)/.test(href) ? decodeURIComponent(href.match(/uddg=([^&]+)/)![1]) : href.slice(0, 200);
        hits.push({ title, url, snippet });
      }
      return hits;
    },
    // 2) SearXNG public meta-search — aggregates multiple upstream engines,
    //    distinct egress; diversifies the hit pool vs. DDG alone.
    async () => {
      const hits = await searxngSearch(query);
      return hits.slice(0, limit);
    },
    // 3) Bing lightweight HTML — different egress reputation; diversifies the
    //    reference pool for the same query with ONE extra subrequest only when
    //    DDG returned fewer than requested. Still well inside the 50/subreq cap.
    async () => {
      const url = `https://www.bing.com/search?q=${encodeURIComponent(query)}&count=${Math.min(limit, 10)}&setlang=id`;
      const res = await fetchWithTimeout(url, {
        headers: { "User-Agent": "Mozilla/5.0 (Linux; Android 10)", "Accept-Language": "id,en;q=0.8" },
      }, 10000);
      if (!res.ok) return [];
      const html = await res.text();
      const blocks = [...html.matchAll(/<li class="b_algo"[^>]*>([\s\S]*?)<\/li>/gi)];
      const hits: SearchHit[] = [];
      for (let i = 0; i < blocks.length && hits.length < limit; i++) {
        const text = stripTags(blocks[i][1] || "");
        const m = text.match(/^(.{1,160}?)\s*(https?:\/\/[^\s]+)/i);
        // Bing blocks don't expose URL cleanly via this regex; fall back to title-only.
        const title = (m?.[1] || text.slice(0, 160)).trim();
        if (!title) continue;
        // Try to pull the real href for citation.
        const hrefMatch = blocks[i][1].match(/href="(https?:\/\/[^"]*)"/i);
        hits.push({
          title: title.slice(0, 180),
          url: (hrefMatch?.[1] || "").slice(0, 200),
          snippet: text.slice(0, 340),
        });
      }
      return hits;
    },
  ];
  let hits: SearchHit[] = [];
  for (const tryFn of attempts) {
    const r = await tryFn().catch(() => []);
    if (r.length) {
      hits = r;
      break;
    }
  }
  return hits;
}

/** Combined: search the web AND get a generative (Groq→Gemini) synthesis.
 *  Falls back gracefully at each step. Returns { reply, source, topic }. */
export async function searchAndSynthesize(
  env: Env,
  owner: number,
  userText: string,
  topic: string,
): Promise<{ reply: string; source: string }> {
  // SELF-REFERENTIAL GUARD — if a self-referential question somehow reaches the
  // search path, answer directly from identity instead of searching/hallucinating.
  const selfRefText = (userText || "").trim().toLowerCase();
  if (SELF_REF_RE.test(selfRefText)) {
    return { reply: JARVIS_IDENTITY.selfRefReply, source: "self_ref" };
  }

  // L14: for COMPLEX, multi-facet research queries, escalate through the
  // bounded orchestrator-worker sub-agent pipeline (researcher -> per-angle
  // searcher -> writer [-verified]), which yields a structured, evidence-
  // based answer. Simple/narrow topics stay on the cheap single-pass path.
  // Effort-scaling (Anthropic): do not spawn sub-agents for trivial queries.
  // Fail-closed: if orchestration returns null, fall through to the existing
  // single-pass synthesis so we ALWAYS return a real reply.
  // Level 15: FOLLOW-UP queries (that carry the research-class markers but
  // extend a prior answer) are anchored to the most recent assistant analysis
  // so the researcher DEEPENS it instead of searching a fresh topic.
  let followupAnchor = "";
  if (isFollowUpQuery(userText)) {
    const ctx = await recentContext(env, owner, 8).catch(() => []);
    const anchor = resolveFollowUpAnchor(ctx);
    if (anchor) followupAnchor = anchor.prior;
  }
  if (isResearchClass(topic, userText)) {
    // Iron Man JARVIS: complex design/research queries go through the bounded
    // orchestrator pipeline (research + design outline). The separate video
    // design spec was removed — flux renders images via generateImage, so any
    // visual request lands on the image path. Fail-closed: if orchestration
    // returns null, fall through to single-pass (never burns budget twice).
    const sub = await orchestrateResearch(env, owner, userText, topic, followupAnchor);
    if (sub) {
      await appendMemory(env, owner, "user", userText, topic);
      await appendMemory(env, owner, "assistant", sub, topic);
      if (sub.length > 120) void reflectOnTurn(env, userText, sub, []).catch(() => {});
      return { reply: sub, source: "subagents" };
    }
  }
  // Run all independent pre-LLM I/O in parallel: web search + conversation
  // history + memory retrieval + answer-behavior context (each is a separate
  // D1 read / network call, so serializing them wastes latency on every query).
  // L18: SELF-LEARNING — Check if topic is already known before searching.
  // If high-confidence memories exist, use them directly (no web search needed).
  const topicKnown = await isTopicKnown(env, topic, 2.0).catch(() => false);
  
  // Run all independent pre-LLM I/O in parallel: web search + conversation
  // history + memory retrieval + answer-behavior context (each is a separate
  // D1 read / network call, so serializing them wastes latency on every query).
  const [searchResult, hits, context, mems, behaviorContext] = await Promise.all([
    topicKnown ? Promise.resolve(null) : ddgSearch(env, topic), // Skip search if known
    topicKnown ? Promise.resolve([] as SearchHit[]) : ddgSearchHits(env, topic),
    recentContext(env, owner, 4),
    searchMemory(env, topic, 4).catch(() => []),
    getAnswerBehaviorContext(env, topic).catch(() => null),
  ]);
  if (mems.length > 0) {
    context.push({
      role: "system",
      content: "Kenang-kenangan relevan: " + mems.map((m) => m.content).join(" | ").slice(0, 1200),
    });
  }
  // ECC deep-research parity: the raw web result AND the citable sources are
  // handed to the LLM as context, so single-pass answers are GROUNDED in real
  // search output and cite only real URLs (never invented ones).
  if (searchResult) {
    context.push({
      role: "system",
      content: `Hasil penelusuran web untuk topik ini (gunakan sebagai dasar — JANGAN menambah tautan yang tidak ada di sumber):\n${searchResult.slice(0, 1600)}`,
    });
  }
  if (hits.length > 0) {
    context.push({
      role: "system",
      content: `Daftar sumber sah yang boleh disitasi:\n${formatSourceList(hits, 5)}`,
    });
  }
  // L13: inject accumulated insights + owner preferences into the reply
  // context — this steers behavior toward owner preferences without modifying
  // the system prompt (metacognitive guardrail: append-only context, never
  // prompt rewrite). Fail-open: missing evolution data doesn't block replies.
  // L17: getAnswerBehaviorContext applies the answer-behavior alignment loop —
  // it suppresses insight categories the reflection loop keeps correcting
  // (fail-closed dampening), tuning how JARVIS answers without rewriting any
  // framework logic or prompt.
  if (behaviorContext) {
    context.push({ role: "system", content: behaviorContext });
  }
  // ECC token-budget-advisor parity: when the owner explicitly asks for a
  // SHORT answer, inject a brevity constraint so the reply respects their
  // budget. Absent the marker, nothing changes.
  if (BRIEF_INTENT_RE.test(userText)) {
    context.push({
      role: "system",
      content: "Pemilik minta VERSI SINGKAT: jawab maksimal ±60 kata, langsung ke inti, tanpa intro/markdown berlebihan.",
    });
  }
  const g = await llmRespond(env, userText, { context, topic });
  if (g.reply) {
    // SELF-LEARNING: Store the synthesized knowledge for future queries
    if (searchResult) {
      await storeLearnedKnowledge(env, topic, searchResult, "web_search_synthesized").catch(() => {});
    }
    // L18: Enhanced emotion detection with inference for unknown topics
    const rawEmotion = detectEmotionSig(userText);
    const mood = getMoodState(owner);
    const recentEmotions = mood.history.slice(-3).map(h => ({
      sentiment: "neutral" as const,
      intensity: h.intensity,
      primary: h.emotion,
      confidence: 0.5,
    }));
    const emotion = inferEmotionFromContext(rawEmotion, mood, recentEmotions);
    
    // Use topic sentiment as additional signal for unknown emotions
    const topicSentiment = detectTopicSentiment(topic);
    const finalSentiment = emotion.sentiment === "neutral" && topicSentiment.sentiment !== "neutral"
      ? topicSentiment.sentiment
      : emotion.sentiment;
    
    // Format reply for natural conversation
    let formatted = buildFinalReply(g.reply, "research", finalSentiment);
    if (hits.length > 0 && !/sumber:|📚/i.test(formatted)) {
      formatted = `${formatted}\n\n📚 *Sumber:*\n${formatSourceList(hits, 4)}`;
    }
    await appendMemory(env, owner, "user", userText, topic);
    await appendMemory(env, owner, "assistant", formatted, topic);
    if (formatted.length > 120) {
      void reflectOnTurn(env, userText, formatted, []).catch(() => {});
    }
    return { reply: formatted, source: `${g.source}+ddg` };
  }
  if (searchResult) {
    // SELF-LEARNING: Store the new knowledge for future queries
    await storeLearnedKnowledge(env, topic, searchResult, "web_search").catch(() => {});
    // Use topic sentiment for fallback formatting
    const topicSentiment = detectTopicSentiment(topic);
    const sourceBlock = hits.length > 0 ? `\n\n📚 *Sumber:*\n${formatSourceList(hits, 4)}` : "";
    const formatted = buildFinalReply(
      `Berikut hasil pencarian tentang *${topic}*:\n\n${searchResult}\n\n(J.A.R.V.I.S. edge — tanpa LLM generatif, tampilkan hasil mentah.)${sourceBlock}`,
      "research",
      topicSentiment.sentiment,
    );
    await appendMemory(env, owner, "user", userText, topic);
    await appendMemory(env, owner, "assistant", formatted, topic);
    return { reply: formatted, source: "ddg" };
  }
  // Final fail-closed: canned reply.
  const canned = `Saya akan cari tentang *${topic}*, tapi belum bisa menghubungi mesin pencari saat ini. Coba lagi sebentar.`;
  await appendMemory(env, owner, "user", userText, topic);
  await appendMemory(env, owner, "assistant", canned, topic);
  return { reply: canned, source: "canned" };
}

// ============================================================================
// Image Prompt Generation (L18)
// Generates detailed image prompts for ANY user request,
// with graceful fallback for unknown topics.
//==========================================================================

/** Generate an image prompt based on user description.
 *  Works for ANY topic — products, concepts, scenes, objects, etc.
 *  With automatic fallback when description is empty/unknown. */
export async function generateImagePrompt(env: Env, userDescription: string): Promise<string> {
  // Clean and validate input
  const description = userDescription?.trim() ?? "";

  // Use default descriptions for empty/very short inputs
  const fallbackDescriptions: string[] = [
    "natural scenery with mountains and river",
    "portrait of a person reading a book in a cozy room",
    "abstract art with vibrant colors and geometric shapes",
    "city skyline at sunset with warm lighting",
    "still life with fresh fruit and flowers on a wooden table",
    "futuristic robot helper in a modern kitchen",
    "warm café interior with bookshelves and steaming coffee cups",
    "beach sunset with waves, palm trees, and a lone figure walking",
  ];

  let prompt: string;

  if (description.length < 3) {
    // Random fallback for empty/very short descriptions
    const fallback = fallbackDescriptions[Math.floor(Math.random() * fallbackDescriptions.length)];
    prompt = `Buatkan prompt deskripsi gambar yang detail dan vivid untuk: "${fallback}".
  Prompt harus dalam Bahasa Indonesia, lengkap dengan subjek utama, gaya visual, warna dominan, komposisi, dan detail kecil.
  Format: Hanya berikan prompt gambar saja, tanpa teks pembuka/penutup.
  Gunakan format yang kompatibel dengan Midjourney/DALL-E/Stable Diffusion.`;
  } else {
    // Truncate very long descriptions to avoid token overflow
    const cleanDesc = description.slice(0, 250);
    prompt = `Buatkan prompt deskripsi gambar yang detail dan vivid untuk: "${cleanDesc}".
  Prompt harus dalam Bahasa Indonesia, lengkap dengan:
  - Subjek utama
  - Gaya visual (realis, kartun, minimalis, dll.)
  - Warna dominan
  - Komposisi
  - Detail kecil
  - Pencerah/penyalaan
  Format: Hanya berikan prompt gambar saja, tanpa teks pembuka/penutup.
  Gunakan format yang kompatibel dengan Midjourney/DALL-E/Stable Diffusion.`;
  }

  const g = await llmRespond(env, prompt, {
    topic: "image_prompt",
  });
  if (g.reply) {
    // Clean the response - remove any non-prompt text
    const cleanReply = g.reply.replace(/^bisa|bisa saja|ini prompt|promp|berikut|prompt:.+/i, "").trim();
    return cleanReply.slice(0, 500);
  }
  // Fallback: use description as prompt base (if meaningful) or random fallback
  if (description.length >= 3) {
    return `Prompt gambar: ${description.slice(0, 200)}`;
  }
  // Final fallback: random scene
  const fallbackIdx = Math.floor(Math.random() * fallbackDescriptions.length);
  return `Prompt gambar: ${fallbackDescriptions[fallbackIdx]}`;
}

// ============================================================================
// Image Generation (L19) — ACTUALLY creating the image
//
// The /gambar command used to output only a text prompt ("Prompt gambar:")
// without ever producing an image. This layer generates the real raster image
// via Cloudflare Workers AI (free tier, no API key — same env.AI binding used
// for text models). Default model: @cf/black-forest-labs/flux-1-schnell.
// Fail-closed: on Workers AI failure, callers fall back to the text prompt so
// the user still gets a usable artifact.
//==========================================================================

/** The Cloudflare Workers AI text-to-image model used by /gambar. */
export const IMAGE_MODEL = "@cf/black-forest-labs/flux-1-schnell";

/** Generate a raster image from a prompt. Returns raw image bytes, or null on
 *  any failure (so callers can fall back to the text prompt). Pure function
 *  of (env, prompt) — no state, no side effects. */
export async function generateImage(
  env: Env,
  prompt: string,
): Promise<Uint8Array | null> {
  if (!env.AI) return null;
  try {
    const out = (await env.AI.run(IMAGE_MODEL, { prompt }) as { image?: string });
    if (!out || !out.image) return null;
    // Base64 → bytes (safe decode: chat_id bytes are not used in image output).
    const bin = atob(out.image);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  } catch (e) {
    console.error("generateImage failed:", String(e).slice(0, 200));
    return null;
  }
}

/** Sniff image MIME type from leading magic bytes (png/jpeg/gif/webp). */
export function sniffImageMime(bytes: Uint8Array): string {
  if (bytes.length < 4) return "image/png";
  // PNG: 89 50 4E 47
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png";
  // JPEG: FF D8 FF
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  // GIF: 47 49 46
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return "image/gif";
  // WEBP: 52 49 46 46 ... 57 45 42 50
  if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46) return "image/webp";
  return "image/png";
}

// ============================================================================
// Intent Comprehension ("Understand the User") — L19
//
// Bridging the last gap in JARVIS's cognition: when the user says something
// JARVIS has never seen before — a vague request, an unknown topic, a cryptic
// one-liner, or a desire expressed without standard keywords — the keyword
// classifiers can't decode it. Plain simple_llm often replies with a generic
// "Ok." or an off-topic guess. This layer uses the LLM itself to understand
// what the user actually WANTS:
//   * If it can infer a concrete need → answer it directly (natural Indonesian).
//   * If the request stays ambiguous → ask ONE short, natural clarifying
//     question (never a dead-end "Ok." and never 5 essays).
// Fail-closed: if the LLM is unreachable, we return a graceful, human
// clarifying question instead of an error.
//==========================================================================

/** Result of intent comprehension. */
export interface IntentUnderstanding {
  /** Final message to send to the user (answer OR clarifying question). */
  reply: string;
  /** Whether we already answered the need (true) or asked for clarification. */
  understood: boolean;
  /** Best-guess topic name for memory/logging (may approximate). */
  topic: string;
}

/** Ask the LLM to decode what the user wants even for unknown/vague input.
 *  Uses conversation history + retrieved memories when available. */
export async function understandUserWants(
  env: Env,
  userText: string,
  owner: number,
  context: Array<{ role: string; content: string }> = [],
): Promise<IntentUnderstanding> {
  const text = (userText || "").trim();
  const baseTopic = text.slice(0, 80);

  // Pull memories for the owner to ground the understanding in prior turns.
  let mems: string[] = [];
  try {
    const hits = await searchMemory(env, baseTopic, 3).catch(() => []);
    mems = hits.map((m) => m.content).slice(0, 3);
  } catch { mems = []; }

  const prior = context
    .filter((c) => (c.content || "").trim())
    .slice(-6)
    .map((c) => `[${c.role}] ${c.content.slice(0, 400)}`)
    .join("\n");

  const memoryBlock = mems.length
    ? `\nKenangan yang relevan:\n${mems.join("\n").slice(0, 1200)}\n`
    : "";

  const prompt =
    `Pemilik bertanya/meminta hal yang mungkin tidak jelas atau asing bagimu. ` +
    `Tugasmu: PAHAMI apa yang sebenarnya pemilik INGINKAN, meskipun kamu belum pernah tahu topik ini.\n\n` +
    `Pesan pemilik:\n"${text}"\n` +
    (prior ? `\nKonteks percakapan terakhir:\n${prior}\n` : "") +
    memoryBlock +
    `\nAturan:
1. Jika kamu cukup yakin (>= 60%) apa yang dia inginkan — jawab langsung dengan jelas, ringkas, bahasa Indonesia alami, dalam kepribadian J.A.R.V.I.S. (kompeten, hangat, lugas). Tidak perlu minta izin.
2. Jika kamu BELUM yakin — ajukan SATU pertanyaan klarifikasi yang singkat, natural, dan spesifik (bukan daftar panjang). Contoh: "Maksudmu kamu mau aku cari info brand baru itu yang mana, atau mau desain kemasannya?" JANGAN bertele-tele, JANGAN menebak dengan jawaban panjang.
3. Jangan pernah menjawab "Ok."/"Siap."/"Sistem dijalankan." sebagai tanggapan atas permintaan yang belum dipahami.
4. Balas dalam bahasa yang sama dengan pemilik (Indonesia/Inggris).
5. Maksimal 3 kalimat.`;

  const g = await llmRespond(env, prompt, {
    topic: `understand-${baseTopic}`,
    contextIsEnriched: true,
    context,
  });

  const reply = (g.reply ?? "").trim();
  if (!reply) {
    // Fail-closed graceful clarifying question.
    return {
      reply: `Maaf, saya belum memahaminya dengan baik. Bisa jelaskan sedikit lagi apa yang kamu butuhkan dari saya?`,
      understood: false,
      topic: baseTopic,
    };
  }

  // Guess whether we answered or need clarification: clarification questions
  // usually end with '?' or ask directly. Words like "Maksudmu", "bisa ... ?".
  const looksLikeQuestion = /\?$/.test(reply) || /^\s*(?:maksud|apakah|bisa|boleh|mau|butuh|perlu|jelas|maks|mksud|kenapa|kamu maksud|apa yang)/i.test(reply);
  const understood = !looksLikeQuestion;

  return { reply, understood, topic: baseTopic };
}

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

import { Env, recentContext, appendMemory, searchMemory } from "./db";
import { withResilience, fetchWithTimeout, logRequest } from "./resilience";
import { getAnswerBehaviorContext, reflectOnTurn } from "./evolution";
import { isResearchClass, orchestrateResearch, isDesignIntent, orchestrateDesign } from "./subagents";
import { buildConversationMessages, detectLanguage } from "./conversation";
import { buildFinalReply } from "./response_formatter";
import { detectEmotion as detectEmotionSig } from "./emotion";
import { JARVIS_IDENTITY, SELF_REF_RE } from "./identity";

const GROQ_MODEL = "qwen/qwen3.6-27b";
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
  /\b(lebih dalam|lebih dalam lagi|lebih detail|lebih lanjut|lanjutkan|lanjut|lengkapin|lengkapi|perdalam|perinci|detail|detailin|terus(?:,|kan)?|yang tadi|yg tadi|tadi itu|tambahin|tambahkan|expand|go deeper|jelasin lebih|jelaskan lebih|sampe? tuntas|ceritain lebih|info lebih)\b/i;

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

/** Derive a research topic from the last assistant analysis (for follow-up
 *  anchoring). Returns the last assistant reply's content as the anchor topic,
 *  or null if there's no prior assistant analysis to build on. */
export function resolveFollowUpAnchor(
  context: Array<{ role: string; content: string }>,
): { topic: string; prior: string } | null {
  const lastAssistant = [...(context || [])].reverse().find((c) => c.role === "assistant");
  if (!lastAssistant || !lastAssistant.content || lastAssistant.content.trim().length < 30) return null;
  const text = lastAssistant.content.trim();
  return { topic: text.slice(0, 120), prior: text.slice(0, 3000) };
}

/** Pull a concrete topic from a search/summarize request (shared with webhook).
 *  Recognizes explicit search verbs AND research/analytical markers so queries
 *  like "Analisis bisnis paling menguntungkan..." (which carry no `cari`/`tentang`
 *  word) still reach the search path instead of wrongly DEFERing.
 *  Fuzzy-tolerant: common misspellings/typo variants of each marker are included
 *  in the alternation (QueryStack fuzzy 2026; Kondrak n-gram LCS) — no LLM
 *  budget spent, zero dependency, deterministic. */
export function extractTopic(text: string): string | null {
  const low = text.trim().toLowerCase();
  const m = low.match(
    /\b(?:cari|carii|cr|search|tentang|tenteng|tentan|tntg|ringkas|rangkum|summarize|artikel|topik|info|infp|informasi|analis\w*|laporan|laporn|report|review|riviu|perbandingan|bandingkan|perkembangan|ulasan|ulsn|kajian|menurut|menurutmu|bagaimana|gmn|bgmn|apa|apakah|siapa|kenapa|mengapa|kapan|berapa|dimana|di mana)\b(?:\s+(?:itu|apa|yang|kah|adalah|dengan|tentang|mengenai))?\s*[:\-]?\s*(.+)$/,
  );
  if (!m) return null;
  let topic = m[1]
    .replace(/^(bantu|tolong|buatkan|please|let me|lagi|dong|sudah|untuk|itu|apa|yang|kah|adalah|tentang|mengenai)\s+/i, "")
    .replace(/[?.!,;:]+$/g, "")
    .trim();
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
    /^(?:(?:ke\s+)?bahasa\s+|(?:\bin\b|to|into|ke)\s+)?(inggris|english|indonesia|indonesian|jepang|japanese|korea|korean|mandarin|china|chinese|arab|arabic|prancis|french|jerman|german|spanyol|spanish|italia|italian|portugis|portuguese|russia|russian|belanda|dutch|thai|hindi|india)\b\s*/i,
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
        max_tokens: 600,
      }),
    }, timeoutMs);
    if (!res.ok) return { ok: false, status: res.status };
    const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    reply = data.choices?.[0]?.message?.content?.trim() ?? "";
    return { ok: Boolean(reply), status: res.status };
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
        max_tokens: 600,
      }),
    }, timeoutMs);
    if (!res.ok) return { ok: false, status: res.status };
    const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    reply = data.choices?.[0]?.message?.content?.trim() ?? "";
    return { ok: Boolean(reply), status: res.status };
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
            generationConfig: { temperature: 0.6, maxOutputTokens: 600 },
          }),
        },
        timeoutMs,
      );
      if (!res.ok) return { ok: false, status: res.status };
      const data = (await res.json()) as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
      reply = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() ?? "";
      return { ok: Boolean(reply), status: res.status };
    });
    if (ok && reply) return reply;
  }
  return null;
}

/** Cloudflare Workers AI — free edge inference, no API key needed.
 *  Uses the AI binding (env.AI) from wrangler.toml. OpenAI-compatible
 *  via env.AI.run() or direct fetch to the CF AI endpoint.
 *  Returns null on any failure so the chain stays fail-closed. */
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

  try {
    const res = await env.AI.run(model, {
      messages,
      max_tokens: 600,
      temperature: 0.6,
    }) as { response?: string };

    const reply = res.response?.trim();
    if (reply) return reply;
  } catch {
    // Fail-closed: return null on any error
  }
  return null;
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

  // 1) Workers AI (free, no key, on CF edge — fastest path)
  const wai = await workersAiRespond(env, userText, sharedOpts);
  if (wai) return { reply: wai, source: "workers_ai" };
  // 2) Groq (free tier, fast)
  const groq = await groqRespond(env, userText, sharedOpts);
  if (groq) return { reply: groq, source: "groq" };
  // 2b) OpenRouter (free/provided models, breadth under one key)
  const openrouter = await openrouterRespond(env, userText, sharedOpts);
  if (openrouter) return { reply: openrouter, source: "openrouter" };
  // 3) Gemini (free tier, last resort)
  const gemini = await geminiRespond(env, userText, sharedOpts);
  if (gemini) return { reply: gemini, source: "gemini" };
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
    // 3) Bing lightweight HTML — different egress reputation, likely reachable.
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
    // 2) Bing lightweight HTML — different egress reputation; diversifies the
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
    // Iron Man JARVIS: when the user explicitly asks for design/spec/analysis,
    // run the full engineering pipeline (research + design + risk) instead of
    // research alone. Fail-closed: on orchestrateDesign failure, falls through
    // to single-pass (never burns budget twice).
    const useDesign = isDesignIntent(userText);
    const sub = useDesign
      ? await orchestrateDesign(env, owner, userText, topic, followupAnchor)
      : await orchestrateResearch(env, owner, userText, topic, followupAnchor);
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
  const [searchResult, context, mems, behaviorContext] = await Promise.all([
    ddgSearch(env, topic),
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
  const g = await llmRespond(env, userText, { context, topic });
  if (g.reply) {
    // Format reply for natural conversation
    const emotion = detectEmotionSig(userText);
    const formatted = buildFinalReply(g.reply, "research", emotion.sentiment);
    await appendMemory(env, owner, "user", userText, topic);
    await appendMemory(env, owner, "assistant", formatted, topic);
    if (formatted.length > 120) {
      void reflectOnTurn(env, userText, formatted, []).catch(() => {});
    }
    return { reply: formatted, source: `${g.source}+ddg` };
  }
  if (searchResult) {
    const fallback = `Berikut hasil pencarian tentang *${topic}*:\n\n${searchResult}\n\n(J.A.R.V.I.S. edge — tanpa LLM generatif, tampilkan hasil mentah.)`;
    await appendMemory(env, owner, "user", userText, topic);
    await appendMemory(env, owner, "assistant", fallback, topic);
    return { reply: fallback, source: "ddg" };
  }
  // Final fail-closed: canned reply.
  const canned = `Saya akan cari tentang *${topic}*, tapi belum bisa menghubungi mesin pencari saat ini. Coba lagi sebentar.`;
  await appendMemory(env, owner, "user", userText, topic);
  await appendMemory(env, owner, "assistant", canned, topic);
  return { reply: canned, source: "canned" };
}
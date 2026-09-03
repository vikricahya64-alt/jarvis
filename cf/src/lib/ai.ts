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

import { Env, recentContext, appendMemory } from "./db";

const GROQ_MODEL = "llama-3.3-70b-versatile";
// Google Gemini as a resilience fallback when Groq is rate-limited/down.
// Uses the free-tier model (gemma-4-31b-it) by default; can rotate to backup.
const GEMINI_API = "https://generativelanguage.googleapis.com/v1beta/models/";
const GEMINI_FREE_MODEL = "gemma-4-31b-it";

/** Pull a concrete topic from a search/summarize request (shared with webhook). */
export function extractTopic(text: string): string | null {
  const low = text.trim().toLowerCase();
  const m = low.match(
    /\b(?:cari|search|tentang|mengenai|ringkas|summarize|artikel|topik|info|informasi)\b\s*[:\-]?\s*(.+)$/,
  );
  if (!m) return null;
  let topic = m[1]
    .replace(/^(bantu|tolong|buatkan|please|let me|lagi|dong|sudah|untuk|tentang|mengenai)\s*/i, "")
    .replace(/[?.!,;:]+$/g, "")
    .trim();
  if (!topic) return null;
  return topic.length >= 3 ? topic.slice(0, 120) : null;
}

/** Try to produce a generative assistant reply via Groq, using recent
 *  conversation context as memory. Returns null on any failure so the
 *  caller falls back to the canned reply (fail-closed). */
export async function groqRespond(
  env: Env,
  userText: string,
  opts: { context?: Array<{ role: string; content: string }>; topic?: string } = {},
): Promise<string | null> {
  const key = env.GROQ_API_KEY;
  if (!key) return null;
  const context = opts.context ?? [];
  const topicHint = opts.topic ? `\nTopik yang dicari: ${opts.topic}` : "";
  const messages = [
    {
      role: "system" as const,
      content:
        "Kamu J.A.R.V.I.S., asisten AI kedaulatan yang membantu pemiliknya " +
        "secara singkat dan membantu. Jawab dalam Bahasa Indonesia ringkas. " +
        "Jika diminta mencari/mengumpulkan informasi, rangkum secara jelas dan " +
        "nyatakan sumber/method-nya. Jangan bohongi atau membuat data palsu. " +
        "Jika tidak bisa menjawab, akui saja.",
    },
    ...context.map((c) => ({ role: c.role, content: c.content })),
    { role: "user" as const, content: userText + topicHint },
  ];
  try {
    const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        model: GROQ_MODEL,
        temperature: 0.4,
        messages,
        max_tokens: 500,
      }),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    const raw = data.choices?.[0]?.message?.content?.trim() ?? "";
    return raw || null;
  } catch {
    return null;
  }
}

/** Google Gemini generative response (free-tier gemma) — resilience fallback
 *  to Groq. Mirrors groqRespond's shape; returns null on any failure so the
 *  chain stays fail-closed. Supports a primary + backup API key rotation. */
export async function geminiRespond(
  env: Env,
  userText: string,
  opts: { context?: Array<{ role: string; content: string }>; topic?: string } = {},
): Promise<string | null> {
  const keys = [env.GEMINI_API_KEY, env.GEMINI_API_KEY_BACKUP, env.GEMINI_API_KEY_SECONDARY].filter(
    (k): k is string => Boolean(k),
  );
  if (keys.length === 0) return null;
  const context = opts.context ?? [];
  const topicHint = opts.topic ? `\nTopik yang dicari: ${opts.topic}` : "";
  const system = "Kamu J.A.R.V.I.S., asisten AI kedaulatan yang membantu pemiliknya " +
    "secara singkat dan membantu. Jawab dalam Bahasa Indonesia ringkas. " +
    "Jika diminta mencari/mengumpulkan informasi, rangkum secara jelas dan " +
    "nyatakan sumber/method-nya. Jangan bohongi atau membuat data palsu. " +
    "Jika tidak bisa menjawab, akui saja.";
  const prompt =
    system +
    "\n\n[Konteks percakapan]\n" +
    (context.map((c) => `${c.role}: ${c.content}`).join("\n") || "(tidak ada)") +
    "\n\n[Perintah user]\n" +
    userText +
    topicHint +
    "\n\nBalas dalam Bahasa Indonesia ringkas.";
  for (const apiKey of keys) {
    try {
      const model = env.GEMINI_MODEL || GEMINI_FREE_MODEL;
      const res = await fetch(`${GEMINI_API}${model}:generateContent?key=${encodeURIComponent(apiKey)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.4, maxOutputTokens: 600 },
        }),
      });
      if (!res.ok) continue;
      const data = (await res.json()) as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
      const raw = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() ?? "";
      if (raw) return raw;
    } catch {
      /* try next key */
    }
  }
  return null;
}

/** Generative LLM dispatch with Groq → Gemini resilience ordering. Returns the
 *  first provider that answers, or null if both are unavailable/failed. Source
 *  tells the caller which provider carried the response. */
export async function llmRespond(
  env: Env,
  userText: string,
  opts: { context?: Array<{ role: string; content: string }>; topic?: string } = {},
): Promise<{ reply: string | null; source: "groq" | "gemini" | null }> {
  const groq = await groqRespond(env, userText, opts);
  if (groq) return { reply: groq, source: "groq" };
  const gemini = await geminiRespond(env, userText, opts);
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
export async function ddgSearch(query: string): Promise<string | null> {
  const attempts: Array<() => Promise<string | null>> = [
    // 1) Official Instant Answer API (JSON) — most stable, no scraping.
    async () => {
      const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`;
      const res = await fetch(url, { headers: { "Accept-Language": "id,id,en;q=0.8" } });
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
      const res = await fetch(url, { headers: { "Accept-Language": "id,id-ID;q=0.9,en;q=0.8" } });
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
      const res = await fetch(url, {
        headers: { "User-Agent": "Mozilla/5.0 (Linux; Android 10)", "Accept-Language": "en,id;q=0.8" },
      });
      if (!res.ok) return null;
      const html = await res.text();
      const m = html.match(/<li class="b_algo"[^>]*>([\s\S]*?)<\/li>/i);
      if (!m?.[1]) return null;
      const block = stripTags(m[1]).slice(0, 400);
      return block || null;
    },
  ];
  for (const tryFn of attempts) {
    const r = await tryFn().catch(() => null);
    if (r) return r;
  }
  return null;
}

/** Combined: search the web AND get a generative (Groq→Gemini) synthesis.
 *  Falls back gracefully at each step. Returns { reply, source, topic }. */
export async function searchAndSynthesize(
  env: Env,
  owner: number,
  userText: string,
  topic: string,
): Promise<{ reply: string; source: string }> {
  const searchResult = await ddgSearch(topic);
  const context = await recentContext(env, owner, 4);
  const g = await llmRespond(env, userText, { context, topic });
  if (g.reply) {
    await appendMemory(env, owner, "user", userText, topic);
    await appendMemory(env, owner, "assistant", g.reply, topic);
    return { reply: g.reply, source: `${g.source}+ddg` };
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
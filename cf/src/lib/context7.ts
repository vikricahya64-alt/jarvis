import type { Env } from "./db";
import { llmRespond } from "./ai";
import { fetchWithTimeout } from "./resilience";
import { tallyFailure, type OperationalFailure } from "./failure";

const CTX7_API = "https://context7.com/api";

export function isContext7Request(text: string): boolean {
  if (!text) return false;
  const t = text.trim();
  if (/\b(?:ctx7|context7)\b/i.test(t)) return true;
  if (/\b(?:cara pakai|cara memakai|cara menggunakan|cara pemakaian|how to use|how do i use|how do you use|implement .* with)\s+[a-z0-9][\w-]*/i.test(t)) return true;
  if (/\b(?:docs?|dokumentasi|api)\s+(?:untuk|dari|of|for|pada)?\s*[a-z0-9][\w-]{1,}/i.test(t)) return true;
  return false;
}

const CHATTER = new Set([
  "bagaimana", "cara", "pakai", "memakai", "menggunakan", "pemakaian", "tolong",
  "mohon", "jelaskan", "bisa", "dokumentasi", "docs", "documentation", "api", "untuk",
  "tentang", "about", "yang", "saya", "aku", "mau", "ingin", "berapa", "apa", "sih",
  "please", "how", "to", "use", "do", "i", "you", "with", "the", "a", "an", "deploy",
]);

function cleanLibrary(raw: string): string {
  let s = (raw ?? "").trim().replace(/^[,，:：.;—-]+/, "");
  s = s.split(/\s+(?:untuk|supaya|agar|biar|yang|dari|di|dengan|pada|ke|of|for|to|and)\s+/i)[0];
  const tokens = s.split(/\s+/).filter(Boolean);
  while (tokens.length > 0 && CHATTER.has(tokens[0].toLowerCase())) tokens.shift();
  let out = tokens.slice(0, 2).join(" ").toLowerCase();
  out = out.replace(/[^a-z0-9_./@ -]+/g, " ").replace(/\s+/g, " ").trim();
  if (!out.startsWith("/") && out.includes(" ")) {
    const parts = out.split(" ");
    const sawSpace = /^(?:cloudflare|google|microsoft|vercel|aws|apache|openai|meta|supabase|stripe|shopify|wordpress|github|netlify|digitalocean|amazon|ibm|ora|oracle|redis|django|react|vue|angular|node|next|nuxt|svelte|laravel|dotnet|flutter|swift|kotlin|deno|bun|python|typescript|javascript|ruby|go|rust|java|php)$/i.test(parts[0].trim());
    if (!sawSpace) out = parts[0];
  }
  return out.slice(0, 60);
}

function extractLibrary(text: string): { nameOrId: string; isId: boolean } {
  const slashM = text.match(/\b(?:ctx7|context7|library id)\s*:?\s+(\/[\w./-]{1,50})/i);
  if (slashM) {
    const v = cleanLibrary(slashM[1]);
    if (v.startsWith("/")) return { nameOrId: v, isId: true };
  }
  for (const re of [
    /\b(?:cara pakai|cara memakai|cara menggunakan|cara pemakaian|how to use|how do i use|how do you use|implement .* with)\s+([a-z0-9][\w]*(?:\s+[a-z0-9][\w]*){0,2})/i,
    /\b(?:docs?|dokumentasi|api)\s+(?:untuk|dari|of|for|pada)?\s*([a-z0-9][\w]*(?:\s+[a-z0-9][\w]*){0,2})/i,
  ]) {
    const m = text.match(re);
    if (m) {
      const v = cleanLibrary(m[1]);
      if (v.length >= 2) return { nameOrId: v, isId: false };
    }
  }
  const markM = text.match(/\b(?:ctx7|context7)\b[\s:]+([a-z0-9][\w]*(?:\s+[a-z0-9][\w]*){0,2})/i);
  if (markM) {
    const v = cleanLibrary(markM[1]);
    if (v.length >= 2) return { nameOrId: v, isId: false };
  }
  return { nameOrId: "", isId: false };
}

async function ctx7Fetch(env: Env, path: string): Promise<string | null> {
  const key = env.CONTEXT7_API_KEY;
  const headers: Record<string, string> = { "User-Agent": "jarvis-ai-assistant/1.0" };
  if (key) headers.Authorization = `Bearer ${key}`;
  const res = await fetchWithTimeout(`${CTX7_API}${path}`, { headers }, 15000);
  if (!res.ok) return null;
  return res.text();
}

function normalizeTitle(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
}

/** Deterministic title verifier (m8-v15, defense-in-depth vs the normalizer
 *  "hono"→"sono" corruption class): the resolved library must ACTUALLY be the
 *  library the user asked for. Exact/leading-token/last-repo-segment equality
 *  only — "sono" is NEVER allowed to resolve to "Sonos" (suffix not a boundary).
 *  A mismatch → null → honest not_found; never wrong-library docs. */
function libraryTitleMatches(title: string | undefined | null, requested: string): boolean {
  if (!title) return false;
  const t = normalizeTitle(title);
  const r = normalizeTitle(requested);
  if (!t || !r) return false;
  if (t === r) return true;
  const firstToken = t.split(/\s+/)[0];
  if (firstToken === r) return true;
  // Repo-id form: last path segment of "org/repo" == requested ("honojs/hono").
  const segments = title.split("/");
  if (segments.length > 1) {
    const last = normalizeTitle(segments[segments.length - 1]);
    if (last === r || last.split(/\s+/)[0] === r) return true;
  }
  return false;
}

async function resolveLibrary(env: Env, libraryName: string, query: string): Promise<string | null> {
  const q = encodeURIComponent(query.slice(0, 200));
  const n = encodeURIComponent(libraryName);
  const body = await ctx7Fetch(env, `/v2/libs/search?query=${q}&libraryName=${n}`);
  if (!body) return null;
  try {
    const d = JSON.parse(body) as { results?: Array<{ id?: string; title?: string }>; error?: string };
    if (d.error || !d.results?.length) return null;
    const hit = d.results.find((r) => libraryTitleMatches(r.title, libraryName));
    return hit?.id ?? null;
  } catch {
    return null;
  }
}

export interface Context7Result {
  reply: string | null;
  ok: boolean;
  /** Library name tried (when the caller requested one but resolution failed). */
  library?: string;
  /** Why the lookup failed — the caller decides the honest reply (fail-closed,
   *  anti-hallucination: NEVER fall through to a generic LLM on a miss). */
  reason?: "unresolved" | "not_found" | "api_down" | "empty";
}

/** Map a lookup-failure reason to the operational failure ledger class so the
 *  gap→upgrade loop sees context7 volume (fire-and-forget, never throws). */
function tallyContext7Reason(env: Env, reason: NonNullable<Context7Result["reason"]>): void {
  const cls: OperationalFailure = reason === "api_down" ? "blocked" : "empty";
  void tallyFailure(env, "context7", cls).catch(() => {});
}

/** Deterministic, honest fallback message for a failed Context7 lookup.
 *  NO generic-LLM answer: an unresolvable library must never be answered by
 *  a model that is free to hallucinate a wrong subject (e.g. "hono" → "Sonos"). */
export function context7FailureMessage(reason: NonNullable<Context7Result["reason"]>, library?: string): string {
  const lib = library?.trim() ? ` '${library.trim()}'` : "";
  switch (reason) {
    case "not_found":
      return `Hmm, saya belum menemukan library${lib} di Context7. Periksa ejaannya, atau beri id repo yang pasti seperti *ctx7: org/repo* (contoh: \`ctx7: honojs/hono\`).`;
    case "api_down":
      return `Dokumentasi${lib} belum bisa diambil dari Context7 saat ini. Bisa dicoba lagi sebentar, atau pakai bentuk \`ctx7: org/repo\`.`;
    case "unresolved":
      return "Saya kurang menangkap nama library yang Anda maksud. Sebutkan library-nya (mis. 'cara pakai hono'), atau id repo-nya: *ctx7: org/repo*.";
    case "empty":
    default:
      return `Dokumentasi${lib} tidak menghasilkan konten untuk dijawab. Coba rephrasing, atau pakai id repo: \`ctx7: org/repo\`.`;
  }
}

export async function lookupLibraryDocs(
  env: Env,
  userText: string,
  context: Array<{ role: string; content: string }> = [],
): Promise<Context7Result> {
  const { nameOrId, isId } = extractLibrary(userText);
  if (!nameOrId) {
    tallyContext7Reason(env, "unresolved");
    return { reply: null, ok: false, reason: "unresolved", library: undefined };
  }

  let libraryId = isId ? nameOrId : null;
  if (!libraryId) {
    libraryId = await resolveLibrary(env, nameOrId, userText);
  }
  if (!libraryId) {
    tallyContext7Reason(env, "not_found");
    return { reply: null, ok: false, reason: "not_found", library: nameOrId };
  }

  const docs = await ctx7Fetch(env, `/v2/context?query=${encodeURIComponent(userText.slice(0, 200))}&libraryId=${encodeURIComponent(libraryId)}`);
  if (!docs || !docs.trim()) {
    tallyContext7Reason(env, docs === null ? "api_down" : "empty");
    return { reply: null, ok: false, reason: docs === null ? "api_down" : "empty", library: libraryId };
  }

  const system =
    `Jawab pertanyaan pemilik BERDASARKAN dokumentasi di bawah — ` +
    `jangan menambahkan fungsi, parameter, atau API yang TIDAK ADA di dokumentasi (anti-halusinasi). ` +
    `Bila relevan sertakan contoh kode dalam blok kode. Bahasa: sesuai permintaan pemilik.\n\n` +
    `=== DOKUMENTASI (Context7) — library ${libraryId} ===\n${docs.slice(0, 8000)}`;

  const r = await llmRespond(env, userText, {
    topic: `context7-${libraryId}`,
    contextIsEnriched: true,
    context,
    systemOverride: system,
  }).catch(() => null);

  const reply = (r?.reply ?? "").trim();
  if (!reply) {
    tallyContext7Reason(env, "empty");
    return { reply: null, ok: false, reason: "empty", library: libraryId };
  }
  return { reply: reply.slice(0, 3600), ok: true };
}

export async function tryContext7(
  env: Env,
  userText: string,
  context: Array<{ role: string; content: string }> = [],
): Promise<string | null> {
  const res = await lookupLibraryDocs(env, userText, context).catch(() => ({ reply: null, ok: false } as const));
  return res.ok && res.reply ? res.reply : null;
}
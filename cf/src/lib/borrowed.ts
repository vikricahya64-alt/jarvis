//=====================================================================
// borrowed.ts — REGISTRY PINJAMAN: EKSEKUTOR EKSTERNAL
// (generalisasi konsep /e2b ke SELURUH eksekutor eksternal yang JARVIS pinjam).
//
// Inti konsep /e2b := "JARVIS, sebagai pihak ketiga orkestrator, MEMINJAM
// sebuah platform eksternal yang mengeksekusi kerja dengan KEMAMPUAN PENUHnya
// — tidak pernah membangun ulang kemampuan itu di dalam Worker." Kategori
// kemampuan pinjaman adalah EKSEKUTOR EKSTERNAL: platform yang benar-benar
// mengerjakan tugas (shell/Python microVM, repo Actions+opencode, inferensi
// LLM, pembacaan dokumen, pencarian web, generasi media). e2b.ts
// mengoperasionalkannya: configured() eksplisit, state hint, token error
// fail-closed, run sync + async (ledger). Modul ini men-generalisasi konsep
// yang sama ke semua eksekutor eksternal agar tak ada yang tetap
// "belum terdeteksi":
//
//   - satu tabel registry: apa yang dipinjam JARVIS, ke mana egress sungguhnya
//     (gateway vs direct vs connector vs binding), kunci env apa yang
//     membukanya, fitur apa yang ditenagai.
//   - probeBorrowedPlatforms(env): probe live murah per eksekutor (pola
//     providers.ts) → configured/live/ms/detail untuk /status.
//   - borrowedStateHint(code): hint kegagalan yang terbaca (gaya e2bStateHint).
//   - describeBorrowedPlatforms(): tampilan markdown untuk /status + docs.
//
// Fail-open by design: setiap probe men-degradasi ke baris "mati/belum
// dikonfigurasi" dan TIDAK PERNAH throw (rendering status harus bertahan
// terhadap gangguab eksekutor). Di-cache 60s.
//=====================================================================

import type { Env } from "./db";
import { probeProviders } from "./providers";

export type BorrowedKind =
  | "eksekutor_platform" // E2B sandbox, GitHub Actions + opencode — eksekusi nyata
  | "eksekutor_llm"      // groq/openrouter/gemini/nim/workers_ai — berpikir pinjaman
  | "eksekutor_data"     // context7, figma, notion — baca/query pinjaman
  | "eksekutor_search"   // ddg/bing/searx — pencarian pinjaman
  | "eksekutor_media";   // pollinations, tts — generasi pinjaman

export interface BorrowedPlatform {
  /** Stable id, used in state hints + probes. */
  id: string;
  /** User-facing label (markdown-safe). */
  label: string;
  kind: BorrowedKind;
  /** Real egress root (documented, surfaced — "borrowing" must be visible). */
  endpoint: string;
  /** Egress route JARVIS actually uses. */
  egress: "gateway" | "direct" | "connector" | "binding";
  /** Env keys that unlock this executor (empty = no-key SaaS). */
  requiresKeys: string[];
  /** JARVIS feature this borrowed external executor powers. */
  capability: string;
  /** Whether a cheap, side-effect-free live probe exists here. */
  probe: boolean;
}

/** Inventori eksekutor eksternal yang JARVIS pinjam. Sumber tunggal untuk
 *  "apa yang dipinjam + bagaimana memverifikasi ia hidup". */
export const BORROWED_PLATFORMS: BorrowedPlatform[] = [
  ...llmPlatforms(),
  ...connectorPlatforms(),
  ...dataAndSearchPlatforms(),
  ...executorPlatforms(),
];

function llmPlatforms(): BorrowedPlatform[] {
  return [
    { id: "groq", label: "Groq (LLM)", kind: "eksekutor_llm", endpoint: "api.groq.com (via AI Gateway)", egress: "gateway", requiresKeys: ["GROQ_API_KEY"], capability: "obrolan, klasifikasi, kembali-kanan", probe: true },
    { id: "openrouter", label: "OpenRouter (LLM)", kind: "eksekutor_llm", endpoint: "openrouter.ai/api/v1 (via AI Gateway)", egress: "gateway", requiresKeys: ["OPENROUTER_API_KEY"], capability: "cadangan LLM (deep research)", probe: true },
    { id: "gemini", label: "Gemini (LLM)", kind: "eksekutor_llm", endpoint: "generativelanguage.googleapis.com (via AI Gateway)", egress: "gateway", requiresKeys: ["GEMINI_API_KEY"], capability: "cadangan LLM", probe: true },
    { id: "nvidia_nim", label: "NVIDIA NIM (LLM)", kind: "eksekutor_llm", endpoint: "integrate.api.nvidia.com/v1", egress: "direct", requiresKeys: ["NVIDIA_NIM_API_KEY"], capability: "cadangan LLM (jalur lurus)", probe: true },
    { id: "workers_ai", label: "Workers AI (LLM)", kind: "eksekutor_llm", endpoint: "Cloudflare binding env.AI", egress: "binding", requiresKeys: ["AI"], capability: "embedding + inferensi", probe: true },
  ];
}

function connectorPlatforms(): BorrowedPlatform[] {
  return [
    { id: "pollinations", label: "Pollinations.ai (gambar)", kind: "eksekutor_media", endpoint: "image.pollinations.ai (via Vercel Connector)", egress: "connector", requiresKeys: ["VERCEL_CONNECTOR_URL"], capability: "konsep desain + render", probe: true },
    { id: "figma", label: "Figma", kind: "eksekutor_data", endpoint: "api.figma.com (secrets di connector)", egress: "connector", requiresKeys: ["VERCEL_CONNECTOR_URL"], capability: "/figma file/node read", probe: false },
    { id: "notion", label: "Notion", kind: "eksekutor_data", endpoint: "api.notion.com (secrets di connector)", egress: "connector", requiresKeys: ["VERCEL_CONNECTOR_URL"], capability: "/notion cari/query/baca", probe: false },
  ];
}

function dataAndSearchPlatforms(): BorrowedPlatform[] {
  return [
    { id: "context7", label: "Context7 (docs)", kind: "eksekutor_data", endpoint: "context7.com/api", egress: "direct", requiresKeys: ["CONTEXT7_API_KEY?"], capability: "grounding docs anti-halusinasi", probe: true },
    { id: "weather", label: "Open-Meteo (cuaca)", kind: "eksekutor_data", endpoint: "api.open-meteo.com", egress: "direct", requiresKeys: [], capability: "/kota", probe: true },
    { id: "search_ddg", label: "DuckDuckGo", kind: "eksekutor_search", endpoint: "duckduckgo.com (api + html)", egress: "direct", requiresKeys: [], capability: "riset & pencarian", probe: true },
    { id: "search_bing", label: "Bing (cadangan)", kind: "eksekutor_search", endpoint: "www.bing.com/search", egress: "direct", requiresKeys: [], capability: "riset (fallback)", probe: true },
    { id: "search_searx", label: "SearXNG (cadangan 2)", kind: "eksekutor_search", endpoint: "searx.be / searxng.world", egress: "direct", requiresKeys: [], capability: "riset (fallback 2)", probe: true },
    { id: "tts", label: "Google Translate TTS", kind: "eksekutor_media", endpoint: "translate.google.com/translate_tts", egress: "direct", requiresKeys: [], capability: "/suara (voice note)", probe: false },
  ];
}

function executorPlatforms(): BorrowedPlatform[] {
  return [
    { id: "e2b", label: "E2B sandbox (eksekusi)", kind: "eksekutor_platform", endpoint: "api.e2b.app + sandbox.e2b.app", egress: "direct", requiresKeys: ["E2B_API_KEY"], capability: "/e2b sync + /etask (ledger async)", probe: true },
    { id: "github", label: "GitHub Actions + opencode", kind: "eksekutor_platform", endpoint: "api.github.com/repos/{repo}/dispatches", egress: "direct", requiresKeys: ["AGENT_TOKEN", "GITHUB_TOKEN", "GITHUB_REPO"], capability: "/tugas (delegasi async)", probe: true },
  ];
}

/** Entry predicate: a borrowed platform is "configured" when any required env
 *  key is present. No-key SaaS platforms are always configured. */
export function borrowedConfigured(env: Env, id: string): boolean {
  const p = BORROWED_PLATFORMS.find((x) => x.id === id);
  if (!p) return false;
  if (!p.requiresKeys.length) return true;
  for (const k of p.requiresKeys) {
    const v = (env as unknown as Record<string, string | undefined>)[k.replace("?", "")];
    if (typeof v === "string" && v.trim()) return true;
  }
  return false;
}

export type BorrowedProbe = {
  id: string;
  label: string;
  kind: BorrowedKind;
  egress: string;
  configured: boolean;
  live: boolean;
  ms: number | null;
  detail: string;
};

const cache = new Map<string, { at: number; value: BorrowedProbe[] }>();
const TTL_MS = 60_000;
const TIMEOUT_MS = 3_500;

/**
 * Budget for a single probe. TIMEOUT_MS is tuned for cheap API pings and is
 * deliberately short so /status stays responsive; callers that hit a heavy
 * HTML endpoint pass a larger budget instead of being silently misreported as
 * dead. A slow endpoint and an unreachable one look identical if the budget is
 * too small for the endpoint, so the budget has to fit the endpoint.
 */
async function reach(
  url: string,
  headers?: Record<string, string>,
  expectHttp = false,
  timeoutMs = TIMEOUT_MS,
): Promise<number | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers, signal: ctrl.signal });
    return res.status;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

type ReachResult = { status: number | null; msg: string | null };

/** Extract a short human reason from an error body (GitHub/E2B JSON `message`
 *  or `error`, else raw text). Whitespace-collapsed and capped so a status row
 *  stays one line. Never throws — a malformed body just yields null. */
export function errReason(text: string): string | null {
  const raw = text.slice(0, 2000).trim();
  if (!raw) return null;
  let msg = "";
  try {
    const j = JSON.parse(raw) as unknown;
    if (j && typeof j === "object") {
      const o = j as Record<string, unknown>;
      if (typeof o.message === "string") msg = o.message;
      else if (typeof o.error === "string") msg = o.error;
      else if (o.error && typeof o.error === "object") {
        const em = (o.error as Record<string, unknown>).message;
        if (typeof em === "string") msg = em;
      }
    }
  } catch { /* not JSON — fall through to raw text */ }
  if (!msg) msg = raw;
  msg = msg.replace(/\s+/g, " ").trim();
  return msg.length > 90 ? `${msg.slice(0, 89)}…` : msg;
}

/** Like reach(), but also captures the platform's own error message on 4xx/5xx
 *  so /status is SELF-DIAGNOSING (which it never could be with a bare status
 *  code): "token ditolak" vs "rate limit" vs "gangguan" is in the detail. */
async function reachMsg(url: string, headers?: Record<string, string>): Promise<ReachResult> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers, signal: ctrl.signal });
    if (res.status < 400) return { status: res.status, msg: null };
    const text = await res.text().catch(() => "");
    return { status: res.status, msg: errReason(text) };
  } catch {
    return { status: null, msg: null };
  } finally {
    clearTimeout(timer);
  }
}

/** Liveness for an AUTHENTICATED probe: only an ACCEPTED credential (2xx)
 *  counts as up. 401/403 (rejected) and everything else are down — the
 *  capability behind the probe (dispatch, sandbox) fails identically, so a
 *  green row there would be a lie. */
export function authLive(status: number | null): boolean {
  return status !== null && status >= 200 && status < 300;
}

/** One-line detail for an authenticated probe, carrying the platform's reason
 *  when it rejected the request. */
function reachDetail(r: ReachResult): string {
  if (r.status === null) return "timeout/error";
  return r.msg ? `HTTP ${r.status} — ${r.msg}` : `HTTP ${r.status}`;
}

/** LIVE probe every probed borrowed platform (cheap, side-effect-free, cached
 *  60s). Never throws — errors become "dead" rows so /status always renders.
 *  Non-production envs return the configured shape with no outbound calls. */
export async function probeBorrowedPlatforms(env: Env): Promise<BorrowedProbe[]> {
  if (env.APP_ENV !== "production") {
    return BORROWED_PLATFORMS.map((p) => ({
      id: p.id,
      label: p.label,
      kind: p.kind,
      egress: p.egress,
      configured: borrowedConfigured(env, p.id),
      live: false,
      ms: null,
      detail: "test-env (no outbound)",
    }));
  }
  const hit = cache.get("probes");
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;

  const out: BorrowedProbe[] = [];
  const ok = (id: string, live: boolean, ms: number | null, detail: string): void => {
    const p = BORROWED_PLATFORMS.find((x) => x.id === id);
    if (!p) return;
    out.push({
      id, label: p.label, kind: p.kind, egress: p.egress,
      configured: borrowedConfigured(env, id), live, ms, detail,
    });
  };

  // Executors: AUTHENTICATED probes — rejection (401/403) = platform down,
  // and the platform's own reason lands in /status (self-diagnosing rows).
  const e2b = env.E2B_API_KEY?.trim();
  if (e2b) {
    const r = await reachMsg("https://api.e2b.app/sandboxes", { "X-API-Key": e2b });
    ok("e2b", authLive(r.status), r.status, reachDetail(r));
  } else {
    ok("e2b", false, null, "E2B_API_KEY belum dipasang");
  }
  if (env.GITHUB_TOKEN && env.GITHUB_REPO) {
    const repoPath = env.GITHUB_REPO.split("/").map(encodeURIComponent).join("/");
    const r = await reachMsg(`https://api.github.com/repos/${repoPath}`, {
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "jarvis-sovereign",
      "X-GitHub-Api-Version": "2022-11-28",
    });
    ok("github", authLive(r.status), r.status, reachDetail(r));
  } else {
    ok("github", false, null, "token/repo belum lengkap");
  }

  // Data & search (no-key, reachability = liveness).
  // DuckDuckGo is reached through TWO distinct layers in the search cascade
  // (ai.ts ddgSearchPackage): the Instant Answer API and the HTML scrape.
  // Probing only html.duckduckgo.com marked the whole provider dead whenever
  // that single scrape layer was blocked - which it is, from Cloudflare egress
  // - while the Instant Answer API, SearXNG and Bing were all still serving
  // results. That produced a red row for a working capability.
  //
  // Report per layer, and call the provider live if ANY of its own layers
  // answer. SearXNG and Bing are probed separately below.
  const DDG_SCRAPE_MS = 9_000;
  const ddgLayers = await Promise.all([
    reach("https://api.duckduckgo.com/?q=jarvis&format=json&no_html=1"),
    reach("https://html.duckduckgo.com/html/?q=jarvis", undefined, false, DDG_SCRAPE_MS),
  ]);
  const ddgLive = ddgLayers.filter((x): x is number => x !== null);
  const [apiLayer, scrapeLayer] = ddgLayers;
  const parts: string[] = [];
  if (apiLayer !== null) parts.push(`api ${apiLayer}`);
  else parts.push("api timeout/error");
  if (scrapeLayer !== null) parts.push(`html ${scrapeLayer}`);
  // The scrape is the slow layer and gets the larger budget; say so, so a
  // future reader can tell "did not answer within 9s" from "does not work".
  else parts.push(`html timeout/error (>${DDG_SCRAPE_MS / 1000}s)`);
  ok("search_ddg", ddgLive.length > 0, ddgLive[0] ?? null,
    ddgLive.length === 0
      ? "semua layer timeout/error"
      : `${parts.join(" · ")} (${ddgLive.length}/${ddgLayers.length} layer hidup)`);
  const bing = await reach("https://www.bing.com/search?q=jarvis&count=1");
  ok("search_bing", bing !== null, bing !== null ? bing : null, bing === null ? "timeout/error" : `HTTP ${bing}`);
  const searx = await reach("https://searx.be/");
  ok("search_searx", searx !== null, searx !== null ? searx : null, searx === null ? "timeout/error" : `HTTP ${searx}`);
  const weather = await reach("https://api.open-meteo.com/v1/forecast?latitude=0&longitude=0&current=temperature_2m");
  ok("weather", weather !== null && weather < 500, weather !== null ? weather : null, weather === null ? "timeout/error" : `HTTP ${weather}`);
  const ctx7 = await reach("https://context7.com/api");
  ok("context7", ctx7 !== null, ctx7 !== null ? ctx7 : null, ctx7 === null ? "timeout/error" : `HTTP ${ctx7}`);
  const polli = await reach("https://image.pollinations.ai/");
  ok("pollinations", polli !== null, polli !== null ? polli : null, polli === null ? "timeout/error" : `HTTP ${polli}`);

  // Static rows (binding / connector-secret / on-demand platforms) — NOT
  // live-probed; their "live" value is a deliberate "assumed available on
  // demand" so /status never shows a misleading dead-red for platforms that
  // are routable but intentionally unprobed (avoid quota/side-effects).
  ok("figma", true, null, "via connector (secrets di sana; on-demand)");
  ok("notion", true, null, "via connector (secrets di sana; on-demand)");
  ok("tts", true, null, "on-demand untuk hindari kuota Google (tanpa probe)");

  // LLM executors are probed by providers.ts (same cheap list-models pings).
  // Merge those results so the borrowed inventory stays complete (16 rows).
  const llm = await probeProviders(env);
  for (const p of llm) {
    const id = mapProviderToBorrowed(p.name);
    if (!id) continue;
    const found = BORROWED_PLATFORMS.find((x) => x.id === id);
    if (!found || out.some((o) => o.id === id)) continue;
    out.push({
      id, label: found.label, kind: found.kind, egress: found.egress,
      configured: p.configured, live: p.live, ms: p.ms, detail: p.detail,
    });
  }

  cache.set("probes", { at: Date.now(), value: out });
  return out;
}

/** providers.ts name → borrowed registry id (LLM providers only). */
function mapProviderToBorrowed(name: string): string | null {
  switch (name) {
    case "groq": return "groq";
    case "openrouter": return "openrouter";
    case "gemini": return "gemini";
    case "nvidia_nim": return "nvidia_nim";
    case "workers_ai": return "workers_ai";
    default: return null;
  }
}

/** Human-readable hint for a borrowed-platform failure token (e2bStateHint
 *  generalization). Returns a self-contained, concise Indonesian sentence. */
export function borrowedStateHint(code: string): string {
  const c = code ?? "";
  if (c.includes("not-configured")) return " — platform belum diaktifkan: atur kunci env-nya dulu lalu /status.";
  if (c.includes("network") || c.includes("timeout")) return " — jaringan gagal / batas waktu terlampaui (lalu lintas ke platform ditunda).";
  if (c.includes("auth") || c.includes("401")) return " — kredensial platform ditolak (kunci salah/cabut); periksa /status.";
  if (c.includes("429")) return " — platform membatasi (rate limit) — coba lagi nanti.";
  if (c.includes("http_5")) return " — platform sedang gangguan (5xx) — coba lagi nanti.";
  if (c.includes("empty")) return " — tidak ada substansi untuk dipinjam (kosong).";
  return " — galat pada platform pinjaman.";
}

/** Rendered single-line status for one borrowed platform (markdown-safe). */
export function borrowedStatusLine(p: BorrowedProbe): string {
  const face = p.configured ? (p.live ? "🟢" : "🔴") : "⚪";
  const ewg = p.egress === "gateway" ? "· gateway" : p.egress === "connector" ? "· connector" : p.egress === "binding" ? "· binding" : "· direct";
  const cfg = p.configured ? "" : " (nonaktif)";
  return `${face} ${p.id}${cfg}: ${p.detail} ${ewg}`;
}

/** Markdown audit of every borrowed platform (surfaced in /status). */
export function describeBorrowedPlatforms(): string {
  const byKind: Record<BorrowedKind, BorrowedPlatform[]> = {
    eksekutor_platform: [], eksekutor_llm: [], eksekutor_data: [],
    eksekutor_search: [], eksekutor_media: [],
  };
  for (const p of BORROWED_PLATFORMS) byKind[p.kind].push(p);
  const block = (title: string, rows: BorrowedPlatform[]): string =>
    rows.length ? `${title}:\n` + rows.map((p) =>
      `  • \`${p.id}\` *${p.label}* — ${p.endpoint} — ` +
      (p.requiresKeys.length ? `kunci: ${p.requiresKeys.join(", ")}` : "tanpa kunci") +
      ` — ${p.capability}`).join("\n") : "";
  return [
    `🧩 *Eksekutor eksternal yang dipinjam — ${BORROWED_PLATFORMS.length}*.\n`,
    block("*Eksekutor — platform (eksekusi nyata)*", byKind.eksekutor_platform),
    block("*Eksekutor — LLM (berpikir pinjaman)*", byKind.eksekutor_llm),
    block("*Eksekutor — data/dokumen*", byKind.eksekutor_data),
    block("*Eksekutor — pencarian*", byKind.eksekutor_search),
    block("*Eksekutor — media*", byKind.eksekutor_media),
    "",
    "Setiap eksekutor dipinjam apa adanya (kemampuan penuh, tidak dibangun ulang). Probe live di sini tanpa side-effect; kegagalan eksekutor tidak pernah membuat status gagal render.",
  ].filter(Boolean).join("\n");
}
/**
 * What the KEYLESS search layers actually return, per query, with counts.
 *
 * Reachability is not usefulness. A probe that only checks HTTP status reports
 * a blocked scraper as healthy (202 counts as a response) and cannot tell an
 * empty knowledge graph from a full result page. This walks every layer the
 * search cascade uses and reports, per layer: HTTP status, payload size, and
 * how many structured hits actually parsed out.
 *
 * The counts are the decision input: "is search without an API key enough to
 * ground answers" is answerable only from parsed-result counts, not from a
 * green tick.
 */
export async function keylessSearchReport(
  env: Env,
  queries: string[],
): Promise<Array<{
  query: string;
  layers: Array<{
    layer: string;
    status: number | null;
    bytes: number;
    hits: number;
    detail: string;
  }>;
}>> {
  const probe = async (
    layer: string,
    url: string,
    pick: (text: string) => { hits: number; detail: string },
  ) => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 10_000);
    try {
      const res = await fetch(url, { signal: ctrl.signal, headers: { "User-Agent": "Mozilla/5.0 (Linux; Android 10)" } });
      const text = await res.text();
      const { hits, detail } = pick(text);
      return { layer, status: res.status, bytes: text.length, hits, detail };
    } catch (e) {
      return { layer, status: null, bytes: 0, hits: 0, detail: (e as Error).message };
    } finally {
      clearTimeout(timer);
    }
  };

  const out: Array<{ query: string; layers: any[] }> = [];
  for (const query of queries) {
    const q = encodeURIComponent(query);
    const layers = [
      await probe("ddg-instant-answer",
        `https://api.duckduckgo.com/?q=${q}&format=json&no_html=1&skip_disambig=1`,
        (t) => {
          try {
            const d = JSON.parse(t) as { AbstractText?: string; RelatedTopics?: unknown[]; Results?: unknown[] };
            const hits = (d.RelatedTopics?.length ?? 0) + (d.Results?.length ?? 0);
            return { hits, detail: d.AbstractText ? "abstract tersedia" : "tanpa abstract" };
          } catch { return { hits: 0, detail: "bukan JSON valid" }; }
        }),
      await probe("ddg-html-scrape",
        `https://html.duckduckgo.com/html/?q=${q}`,
        (t) => ({
          hits: (t.match(/class="result__a"/g) ?? []).length,
          detail: /anomaly|captcha|challenge|unusual/i.test(t) ? "BOT CHALLENGE (tanpa hasil)" : "scrape bisa diparse",
        })),
      await probe("searxng-json",
        `https://searx.be/search?q=${q}&format=json`,
        (t) => {
          try {
            const d = JSON.parse(t) as { results?: unknown[] };
            return { hits: d.results?.length ?? 0, detail: "JSON" };
          } catch { return { hits: 0, detail: "menolak JSON untuk klien tanpa API key (balas HTML)" }; }
        }),
      await probe("bing-html",
        `https://www.bing.com/search?q=${q}&count=10`,
        (t) => ({
          hits: (t.match(/<li class="b_algo"/g) ?? []).length,
          detail: (t.match(/<li class="b_algo"/g) ?? []).length > 0 ? "hasil diparse" : "tidak ada hasil",
        })),
    ];
    out.push({ query, layers });
  }
  return out;
}

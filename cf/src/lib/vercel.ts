//=====================================================================
// vercel.ts — VERCEL CONNECTOR CLIENT (free-tier integration layer).
//
// Bridges JARVIS → the Vercel Connector (https://jarvis-connector.vercel.app).
// The connector holds the heavy/stateful API keys (Figma, Notion, GitHub) so
// they never touch this Worker. Everything here FAILS CLOSED: any network /
// timeout / shape error returns a safe default (null / [] / undefined) and
// never throws — the callers degrade gracefully (same contract as ai.ts).
//
// Endpoints used:
//   POST /api/image      → Pollinations.ai (unlimited free, no key) image gen
//   GET  /api/figma      → Figma file/node read (FIGMA_ACCESS_TOKEN in connector)
//   POST /api/notion     → Notion search / query / read / create
//   POST /api/actions    → GitHub Actions drive (repo/owner in connector)
//=====================================================================

import { Env } from "./db";

const REQUEST_TIMEOUT_MS = 20_000;

export function vercelBaseUrl(env: Env): string {
  return (env.VERCEL_CONNECTOR_URL || "https://jarvis-connector.vercel.app").replace(/\/+$/, "");
}

/** Single bounded fetch against the connector. Never throws. */
async function connectorFetch(
  env: Env,
  path: string,
  init: RequestInit = {},
  timeoutMs = REQUEST_TIMEOUT_MS,
): Promise<{ ok: boolean; status: number; json: unknown }> {
  try {
    const base = vercelBaseUrl(env);
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...(init.headers as Record<string, string> | undefined),
    };
    if (env.VERCEL_CONNECTOR_TOKEN) {
      headers["Authorization"] = `Bearer ${env.VERCEL_CONNECTOR_TOKEN}`;
    }
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = await fetch(`${base}${path}`, {
        ...init,
        headers,
        signal: ac.signal,
      });
      let json: unknown = null;
      try {
        json = await res.json();
      } catch { /* non-JSON body — leave null */ }
      return { ok: res.ok, status: res.status, json };
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return { ok: false, status: 0, json: null };
  }
}

// ============================================================================
// IMAGE GENERATION — Pollinations.ai (unlimited free, no API key).
// The connector returns a base64 data URL:  data:image/jpeg;base64,....
// Returns image bytes (Uint8Array) or null on ANY failure (fail-closed).
// ============================================================================
export async function generateImageViaVercel(
  env: Env,
  prompt: string,
  opts: { width?: number; height?: number } = {},
): Promise<Uint8Array | null> {
  const p = (prompt || "").trim();
  if (!p) return null;
  const { ok, json } = await connectorFetch(env, "/api/image", {
    method: "POST",
    body: JSON.stringify({
      prompt: p.slice(0, 500),
      provider: "pollinations",
      width: opts.width ?? 1024,
      height: opts.height ?? 1024,
    }),
  });
  if (!ok) return null;
  const data = json as { imageUrl?: string } | null;
  if (!data?.imageUrl) return null;
  const m = data.imageUrl.match(/^data:[^;]+;base64,(.+)$/s);
  if (!m) return null;
  try {
    const bin = atob(m[1]);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

// ============================================================================
// FIGMA — read a design file / node through the connector.
// Returns a compact, markdown-friendly summary (fail-closed → null).
// ============================================================================
interface FigmaNodeLike {
  id?: string;
  name?: string;
  type?: string;
  children?: FigmaNodeLike[];
}

function flattenFigmaSummary(node: FigmaNodeLike, depth: number, maxDepth: number, out: string[]): void {
  if (!node || depth > maxDepth) return;
  const name = node.name || "(tanpa nama)";
  const type = node.type || "node";
  out.push(`${"  ".repeat(depth)}• ${name} — ${type}`);
  if (node.children?.length) {
    for (const c of node.children.slice(0, 12)) {
      flattenFigmaSummary(c, depth + 1, maxDepth, out);
    }
  }
}

export async function readFigmaViaVercel(
  env: Env,
  fileKeyOrUrl: string,
  opts: { nodeId?: string; depth?: number } = {},
): Promise<{ summary: string; name: string | null; status: number | undefined } | null> {
  const raw = (fileKeyOrUrl || "").trim();
  if (!raw) return null;
  // Accept a full figma.com/design/{key}/... URL and extract the key.
  const urlMatch = raw.match(/figma\.com\/\w+\/([A-Za-z0-9_-]{8,})\//i);
  const fileKey = urlMatch ? urlMatch[1] : raw;
  if (!/^[A-Za-z0-9_-]{8,}$/.test(fileKey)) return null;

  const params = new URLSearchParams();
  if (opts.nodeId) params.set("ids", opts.nodeId);
  params.set("depth", String(Math.max(1, Math.min(3, opts.depth ?? 2))));

  const { ok, status, json } = await connectorFetch(
    env,
    `/api/figma?fileKey=${encodeURIComponent(fileKey)}&${params.toString()}`,
  );
  if (!ok) return { summary: "", name: null, status };

  const data = json as {
    name?: string;
    document?: { children?: FigmaNodeLike[] };
    error?: string;
  } | null;
  if (!data || data.error) return { summary: "", name: null, status };

  const name = data.name ?? null;
  const lines: string[] = [];
  lines.push(`📐 *${name || "File Figma"}*`);
  const root = data.document;
  if (root?.children) {
    // Pages are the first level; render each page's first frames.
    for (const page of root.children.slice(0, 6)) {
      lines.push("");
      lines.push(`## ${page.name || "(halaman)"}`);
      flattenFigmaSummary(page, 1, Math.max(1, Math.min(2, (opts.depth ?? 2) - 1)), lines);
    }
    if (root.children.length > 6) {
      lines.push(`\n_…dan ${root.children.length - 6} halaman lainnya_.`);
    }
  }
  return { summary: lines.join("\n"), name, status };
}

// ============================================================================
// NOTION — search / query / read through the connector. Fail-closed → null.
// ============================================================================
export async function notionViaVercel(
  env: Env,
  payload: Record<string, unknown>,
): Promise<unknown | null> {
  if (!payload || typeof payload !== "object") return null;
  const { ok, json } = await connectorFetch(env, "/api/notion", {
    method: "POST",
    body: JSON.stringify(payload),
  });
  return ok ? json : null;
}

export async function notionSearchViaVercel(
  env: Env,
  query: string,
): Promise<Array<{ id: string; title: string; kind: string }>> {
  const q = (query || "").trim().slice(0, 100);
  const json = await notionViaVercel(env, q ? { action: "search", content: { query: q } } : { action: "search" });
  const data = json as
    | { results?: Array<{
        id: string;
        object?: "page" | "database";
        properties?: Record<string, { title?: Array<{ plain_text?: string }> }>;
        title?: Array<{ plain_text?: string }>;
      }> }
    | null;
  if (!data?.results) return [];
  const out: Array<{ id: string; title: string; kind: string }> = [];
  for (const r of data.results.slice(0, 8)) {
    let title = "";
    if (r.object === "database" && r.title?.length) {
      title = r.title.map((t) => t.plain_text ?? "").join("");
    } else if (r.properties) {
      // Page: grab the first title-type property.
      for (const prop of Object.values(r.properties)) {
        if (prop?.title?.length) {
          title = prop.title.map((t) => t.plain_text ?? "").join("");
          break;
        }
      }
    }
    out.push({ id: r.id, title: title.slice(0, 120) || "(tanpa judul)", kind: r.object ?? "page" });
  }
  return out;
}

// ============================================================================
// GITHUB — Actions listing / dispatch through the connector (executor plane).
// ============================================================================
export async function githubViaVercel(
  env: Env,
  payload: Record<string, unknown>,
): Promise<unknown | null> {
  if (!payload || typeof payload !== "object") return null;
  const { ok, json } = await connectorFetch(env, "/api/actions", {
    method: "POST",
    body: JSON.stringify(payload),
  });
  return ok ? json : null;
}

/** Compact label for a connector status line (used by /connector diagnostics). */
export function connectorsStatus(env: Env): string {
  const base = vercelBaseUrl(env);
  const lines = [
    `🔌 *Vercel Connector*: ${base}`,
    `  - Image (Pollinations): unlimited, no key — reachable`,
    `  - Figma / Notion / GitHub Actions: via connector secrets`,
    `  - Token: ${env.VERCEL_CONNECTOR_TOKEN ? "terpasang" : "tidak (publik)"}`,
  ];
  return lines.join("\n");
}
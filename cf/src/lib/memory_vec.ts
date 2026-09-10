//===========================================================================
// memory_vec.ts — SEMANTIC MEMORY on Cloudflare Vectorize (free tier)
//
// Complements the D1 keyword search (memories_fts) with real meaning-based
// recall: every memory written to the `memories` table is embedded with the
// free Workers AI multilingual model @cf/baai/bge-m3 and upserted into the
// Vectorize index `memory-vectors`. Retrieval queries the same embeddings so
// "tadi kita bahas bekerja remote" no longer depends on literal keyword hits
// (live failure we fixed with dictionaries + pivot rails — this removes the
// fragile part entirely).
//
// Fully optional: every function no-ops when MEM_VEC/AI is absent, so tests
// and cold starts never break. Fail-closed on any provider error.
//===========================================================================

import type { Env } from "./db";

export const EMBED_MODEL = "@cf/baai/bge-m3";
export const EMBED_DIMS = 1024;
// Cosine similarity floor for a "relevant" memory hit (bge-m3 embeddings).
export const MEMORY_SCORE_FLOOR = 0.2;

type EmbedOut =
  | { data?: Array<{ embedding?: number[] }> }
  | { embedding?: number[] }
  | null;

/** Embed text to a 1024-dim vector via Workers AI (free). Null on failure. */
export async function embedText(env: Env, text: string): Promise<number[] | null> {
  if (!env.AI) return null;
  try {
    const out = (await env.AI.run(EMBED_MODEL, { text: (text ?? "").slice(0, 2000) })) as unknown as
      | { data?: Array<{ embedding?: number[] }> }
      | { embedding?: number[] };
    // Two output shapes exist across embedding models: { data:[{embedding}] }
    // (bge-m3) and top-level { embedding } (older). Handle both defensively.
    const boxed = out as { data?: Array<{ embedding?: number[] }> };
    const flat = out as { embedding?: number[] };
    const e = boxed.data?.[0]?.embedding ?? flat.embedding;
    if (Array.isArray(e) && e.length >= EMBED_DIMS) return e;
    return null;
  } catch (e) {
    console.error("memory_vec embed:", String(e).slice(0, 120));
    return null;
  }
}

/** Upsert one memory vector. Fire-and-forget from the callee. No-op when the
 *  Vectorize binding or embedding is unavailable. */
export async function semanticUpsertMemory(
  env: Env,
  id: string,
  content: string,
  type: string,
): Promise<void> {
  if (!env.MEM_VEC) return;
  const values = await embedText(env, content);
  if (!values) return;
  try {
    await env.MEM_VEC.upsert([
      {
        id: `m:${id}`,
        values,
        metadata: { type: type.slice(0, 32), content: (content || "").slice(0, 500) },
      },
    ]);
  } catch (e) {
    console.error("memory_vec upsert:", String(e).slice(0, 120));
  }
}

/** Semantic top-k over memories. Returns [] when unavailable or below floor so
 *  callers fall back to the keyword FTS path unchanged. */
export async function semanticSearchMemory(
  env: Env,
  query: string,
  k = 4,
): Promise<Array<{ id: string; type: string; content: string; importance: number }>> {
  if (!env.MEM_VEC || !query) return [];
  const values = await embedText(env, query);
  if (!values) return [];
  try {
    const res = (await env.MEM_VEC.query(values, {
      topK: Math.min(10, k * 2 + 2),
      returnMetadata: true,
      returnValues: false,
    })) as unknown as {
      matches?: Array<{ id: string; score: number; metadata?: Record<string, string | number> }>;
    };
    const matches = (res?.matches ?? [])
      .filter((m) => Number(m.score ?? 0) >= MEMORY_SCORE_FLOOR)
      .map((m) => ({
        id: (m.id || "").replace(/^m:/, ""),
        type: String(m.metadata?.type ?? "fact"),
        content: String(m.metadata?.content ?? ""),
        importance: 1,
      }))
      .slice(0, k);
    if (matches.length === 0) return [];
    return matches;
  } catch (e) {
    console.error("memory_vec query:", String(e).slice(0, 120));
    return [];
  }
}
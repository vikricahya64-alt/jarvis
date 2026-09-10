//===========================================================================
// providers.ts — LIVE PROVIDER PROBE (free-tier observability)
//
// /status used to only show per-provider success RATES aggregated since boot
// (brainMetrics) — silent gaps (a revoked key, a dead free endpoint) stayed
// invisible. This probe pings each free provider's cheap metadata endpoint
// (NO generation, ~one HTTP call each) and reports live/dead + latency.
// Results are cached 60s in a module map so admin probing never burns quota
// or slows repeated /status calls. Fail-open: a probe error reports "dead"
// but never throws — status rendering must survive any provider outage.
//===========================================================================

import type { Env } from "./db";

export type ProviderProbe = {
  name: string;
  configured: boolean;
  live: boolean;
  ms: number | null;
  detail: string;
};

const cache = new Map<string, { at: number; value: ProviderProbe[] }>();
const TTL_MS = 60_000;
const TIMEOUT_MS = 4_000;

async function ping(url: string, headers?: Record<string, string>): Promise<number | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers, signal: ctrl.signal });
    return res.status;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function probeProviders(env: Env): Promise<ProviderProbe[]> {
  if (env.APP_ENV !== "production") {
    const stub: ProviderProbe[] = [
      { name: "groq", configured: env.GROQ_API_KEY !== undefined, live: false, ms: null, detail: "test-env (no outbound)" },
      { name: "workers_ai", configured: env.AI !== undefined, live: false, ms: null, detail: "test-env (binding only)" },
      { name: "openrouter", configured: env.OPENROUTER_API_KEY !== undefined, live: false, ms: null, detail: "test-env (no outbound)" },
      { name: "gemini", configured: env.GEMINI_API_KEY !== undefined, live: false, ms: null, detail: "test-env (no outbound)" },
      { name: "memory_vec", configured: env.MEM_VEC !== undefined, live: false, ms: null, detail: "test-env (binding only)" },
    ];
    return stub;
  }
  const hit = cache.get("probe");
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;

  // Mirror the ACTUAL egress path: when the AI Gateway is configured every
  // free provider is routed through it, so the probe must ping the very same
  // gateway URLs (a direct ping can 403 for reasons that the gateway hides).
  const gw = env.AI_GATEWAY_URL ? `${env.AI_GATEWAY_URL}` : "";
  const probes: Array<{ name: string; configured: boolean; url?: string; headers?: Record<string, string>; note: string }> = [
    {
      name: "groq",
      configured: !!env.GROQ_API_KEY,
      url: gw ? `${gw}/groq/v1/models` : "https://api.groq.com/openai/v1/models",
      headers: { Authorization: `Bearer ${env.GROQ_API_KEY}` },
      note: "list-models",
    },
    {
      name: "openrouter",
      configured: !!env.OPENROUTER_API_KEY,
      url: gw ? `${gw}/openrouter/v1/models` : "https://openrouter.ai/api/v1/models",
      headers: { Authorization: `Bearer ${env.OPENROUTER_API_KEY}` },
      note: "list-models",
    },
    {
      name: "gemini",
      configured: !!env.GEMINI_API_KEY,
      url: gw
        ? `${gw}/google-ai-studio/v1beta/models?key=${encodeURIComponent(env.GEMINI_API_KEY ?? "")}`
        : `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(env.GEMINI_API_KEY ?? "")}`,
      note: "list-models",
    },
  ];
  const runs = await Promise.allSettled(probes.map(async (p) => {
    if (!p.configured || !p.url) return { name: p.name, configured: false, live: false, ms: null, detail: "key tidak terpasang" };
    const status = await ping(p.url, p.headers);
    const live = status !== null && status >= 200 && status < 300;
    return {
      name: p.name,
      configured: true,
      live,
      ms: status !== null ? status : null,
      detail: status === null ? "timeout/error" : status === 200 ? `${p.note} 200` : `HTTP ${status}`,
    };
  }));

  const out: ProviderProbe[] = runs.map((r) => {
    if (r.status === "fulfilled") return r.value as ProviderProbe;
    return { name: "?", configured: false, live: false, ms: null, detail: "probe failed" };
  });
  out.push({
    name: "workers_ai",
    configured: env.AI !== undefined,
    live: env.AI !== undefined,
    ms: null,
    detail: env.AI ? "binding terpasang (ping via run)" : "binding tidak ada",
  });
  out.push({
    name: "memory_vec",
    configured: env.MEM_VEC !== undefined,
    live: env.MEM_VEC !== undefined,
    ms: null,
    detail: env.MEM_VEC ? "index terpasang" : "index tidak ada",
  });

  cache.set("probe", { at: Date.now(), value: out });
  return out;
}
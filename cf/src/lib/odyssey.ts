//=====================================================================
// odyssey.ts — Odyssey (odyssey.ml) world-model executor client.
//
// Odyssey is a FREE-tier external executor of a NEW KIND for JARVIS:
// not code execution (opencode) but WORLD-SIMULATION execution. The
// Simulate API runs scripted interactive-video simulation jobs in the
// background (async batch), perfect for a stateless Worker: submit a
// job, then poll its status, then fetch the resulting video URL.
//
// Endpoints (reverse-engineered from the official @odysseyml/odyssey
// SDK v1.3.x; live Jan-Jul 2026, verified):
//   POST {base}/auth/token          {api_key} -> {access_token, expires_in}
//   POST {base}/simulation-jobs     {portrait, output_video, script} -> {job_id}
//   GET  {base}/simulation-jobs/{id}-> {status, streams:[{stream_id}]}
//   GET  {base}/recordings/{id}     -> {video_url, duration_seconds}
//
// EVERYTHING FAILS CLOSED and never throws: a missing key, network error,
// auth failure, or malformed body returns a safe shape the caller can
// degrade from (same contract as vercel.ts / ai.ts). No key in the Worker
// -> the capability simply reports as unconfigured.
//=====================================================================

import { Env } from "./db";

const ODYSSEY_DEFAULT_BASE = "https://api.odyssey.ml";
const REQUEST_TIMEOUT_MS = 20_000;

export type OdysseyJobState = "pending" | "dispatched" | "processing" | "completed" | "failed" | "cancelled";

/** State of a submitted simulation job. `streams` holds per-stream results
 *  (each with its own status + optional error_message). */
export interface OdysseyJob {
  job_id: string;
  status: OdysseyJobState | string;
  error_message?: string | null;
  streams?: Array<{ stream_id: string; status?: string; error_message?: string | null }>;
}

export interface OdysseyJobResult {
  ok: boolean;
  job?: OdysseyJob;
  error?: string;
}

export interface OdysseyRecordingResult {
  ok: boolean;
  videoUrl?: string;
  durationSeconds?: number;
  error?: string;
}

export function odysseyBaseUrl(env: Env): string {
  return (env.ODYSSEY_API_URL ?? ODYSSEY_DEFAULT_BASE).replace(/\/+$/, "");
}

/** True when the world-model executor has an API key wired into the Worker. */
export function odysseyConfigured(env: Env): boolean {
  return Boolean(env.ODYSSEY_API_KEY?.trim());
}

/** Exchange the permanent API key for a short-lived bearer token. Cache the
 *  token in KV when available so we do not re-mint on every poll. */
async function odysseyAuthToken(env: Env): Promise<{ token: string } | { error: string }> {
  const apiKey = env.ODYSSEY_API_KEY?.trim();
  if (!apiKey) return { error: "odyssey-not-configured" };

  if (env.CONFIG_KV) {
    try {
      const cached = await env.CONFIG_KV.get("odyssey:token");
      if (cached) {
        const parsed = JSON.parse(cached) as { token: string; exp: number };
        if (parsed.token && parsed.exp > Date.now()) return { token: parsed.token };
      }
    } catch { /* cache is best-effort */ }
  }

  try {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(`${odysseyBaseUrl(env)}/auth/token`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ api_key: apiKey }),
        signal: ac.signal,
      });
      if (!res.ok) return { error: `odyssey_auth_${res.status}` };
      const data = (await res.json()) as { access_token?: string; expires_in?: number } | null;
      if (!data?.access_token) return { error: "odyssey_auth_no_token" };
      if (env.CONFIG_KV) {
        try {
          await env.CONFIG_KV.put("odyssey:token", JSON.stringify({
            token: data.access_token,
            exp: Date.now() + (data.expires_in ?? 3600) * 1000 - 60_000,
          }), { expirationTtl: 3600 });
        } catch { /* cache is best-effort */ }
      }
      return { token: data.access_token };
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return { error: "odyssey_auth_network" };
  }
}

/** Submit ONE text-to-video simulation job (default script: start -> ~10s
 *  later end). Fail-closed: never throws. */
export async function simulateOdyssey(
  env: Env,
  prompt: string,
  opts: { portrait?: boolean; durationMs?: number } = {},
): Promise<OdysseyJobResult> {
  const p = (prompt ?? "").trim();
  if (!p) return { ok: false, error: "odyssey-empty-prompt" };
  const auth = await odysseyAuthToken(env);
  if ("error" in auth) return { ok: false, error: auth.error };

  const duration = Math.max(3_000, Math.min(150_000, opts.durationMs ?? 12_000));
  const script = [
    { timestamp_ms: 0, start: { prompt: p.slice(0, 600) } },
    { timestamp_ms: duration, end: {} },
  ];

  try {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(`${odysseyBaseUrl(env)}/simulation-jobs`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${auth.token}`,
        },
        body: JSON.stringify({ portrait: opts.portrait ?? false, output_video: true, script }),
        signal: ac.signal,
      });
      if (!res.ok) return { ok: false, error: `odyssey_http_${res.status}` };
      const job = (await res.json()) as OdysseyJob | null;
      if (!job?.job_id) return { ok: false, error: "odyssey_no_job_id" };
      return { ok: true, job };
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return { ok: false, error: "odyssey_sim_network" };
  }
}

/** Poll a submitted simulation job's status. Fail-closed: never throws. */
export async function odysseyJobStatus(env: Env, jobId: string): Promise<OdysseyJobResult> {
  const id = (jobId ?? "").trim();
  if (!id) return { ok: false, error: "odyssey-no-job-id" };
  const auth = await odysseyAuthToken(env);
  if ("error" in auth) return { ok: false, error: auth.error };
  try {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(`${odysseyBaseUrl(env)}/simulation-jobs/${encodeURIComponent(id)}`, {
        method: "GET",
        headers: { Authorization: `Bearer ${auth.token}` },
        signal: ac.signal,
      });
      if (!res.ok) return { ok: false, error: `odyssey_http_${res.status}` };
      const job = (await res.json()) as OdysseyJob | null;
      if (!job?.job_id) return { ok: false, error: "odyssey-no-job" };
      return { ok: true, job };
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return { ok: false, error: "odyssey_stat_network" };
  }
}

/** Resolve the final MP4 video URL for a completed stream. Fail-closed. */
export async function odysseyRecording(env: Env, streamId: string): Promise<OdysseyRecordingResult> {
  const id = (streamId ?? "").trim();
  if (!id) return { ok: false, error: "odyssey-no-stream-id" };
  const auth = await odysseyAuthToken(env);
  if ("error" in auth) return { ok: false, error: auth.error };
  try {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(`${odysseyBaseUrl(env)}/recordings/${encodeURIComponent(id)}`, {
        method: "GET",
        headers: { Authorization: `Bearer ${auth.token}` },
        signal: ac.signal,
      });
      if (!res.ok) return { ok: false, error: `odyssey_http_${res.status}` };
      const data = (await res.json()) as { video_url?: string; duration_seconds?: number } | null;
      if (!data?.video_url) return { ok: false, error: "odyssey-no-video-url" };
      return { ok: true, videoUrl: data.video_url, durationSeconds: data.duration_seconds };
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return { ok: false, error: "odyssey_rec_network" };
  }
}

/** Human label for the current job state (Indonesian; fail-open "diproses"). */
export function odysseyStateLabel(state: string | undefined): string {
  switch (state) {
    case "pending": return "mengantre";
    case "dispatched": return "disiapkan ke GPU";
    case "processing": return "sedang membuat simulasi";
    case "completed": return "selesai ✓";
    case "failed": return "gagal ✗";
    case "cancelled": return "dibatalkan";
    default: return "diproses";
  }
}
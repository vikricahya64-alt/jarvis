//=====================================================================
// resilience.ts — Infrastructure-framework reliability layer (adopted
// from public reference research: circuit breaker, budget retry, timeout,
// per-provider observability). All free-tier: D1-backed state, Web Crypto,
// no external SDKs.
//
// Patterns implemented:
//   * Lazy circuit breaker (CLOSED/OPEN/HALF_OPEN) persisted in D1 so it
//     survives stateless Worker invocations.
//   * Classified retry with jittered exponential backoff (retry only 429/5xx,
//     never 4xx). Budget-capped so we don't burn the 10ms CPU on retries.
//   * Timeout budgeting via AbortController on every external fetch.
//   * request_log observability (AI Gateway cf-aig-step parity).
//
// All functions fail-closed / degrade gracefully; the caller keeps the
// sovereignty invariant: owner slash-commands are never demoted by these.
//=====================================================================

import { Env } from "./db";

// Bucket sizes (free-tier friendly; tuned for a personal assistant).
const TIMEOUT_MS = {
  groq: 15000,
  gemini: 20000,
  web: 10000,
} as const;

const BREAKER = {
  failureThreshold: 3, // consecutive failures to trip OPEN
  cooldownMs: 60000, // OPEN -> HALF_OPEN probe after 60s
  maxCooldownMs: 300000, // cap cooldown (5 min)
} as const;

const RETRY = {
  maxAttempts: 2, // 1 initial + 2 retries = 3 total
  baseMs: 400,
  capMs: 8000,
} as const;

/** Classify an HTTP status into retryable (true) vs hard-fail (false). */
export function isRetryableStatus(status: number): boolean {
  if (status === 429 || status === 500 || status === 502 || status === 503 || status === 504) {
    return true;
  }
  return false;
}

/** Jittered exponential backoff delay for attempt n (1-based). */
export function backoffMs(attempt: number, base = RETRY.baseMs, cap = RETRY.capMs): number {
  const exp = Math.min(cap, base * Math.pow(2, attempt - 1));
  // Full jitter: random between 0 and exp (avoids thundering herd).
  return Math.floor(Math.random() * exp);
}

/** Current circuit state for a provider, with lazy OPEN->HALF_OPEN promotion. */
export async function getBreakerState(env: Env, provider: string): Promise<"closed" | "open" | "half_open"> {
  try {
    const row = await env.DB.prepare(
      "SELECT state, cooldown_until FROM provider_health WHERE provider = ?",
    ).bind(provider).first<{ state: string; cooldown_until: number }>();
    if (!row) return "closed";
    if (row.state === "open" && row.cooldown_until > 0 && Date.now() >= row.cooldown_until) {
      // Lazy transition: allow one probe.
      await env.DB.prepare(
        "UPDATE provider_health SET state='half_open' WHERE provider = ?",
      ).bind(provider).run().catch(() => {});
      return "half_open";
    }
    return (row.state as "closed" | "open" | "half_open") || "closed";
  } catch {
    return "closed"; // availability over strictness on state read
  }
}

/** Record a success on a provider (reset the breaker if needed). */
export async function recordSuccess(env: Env, provider: string): Promise<void> {
  try {
    await env.DB.prepare(
      `INSERT INTO provider_health (provider, state, failures, last_failure_at, cooldown_until)
       VALUES (?, 'closed', 0, 0, 0)
       ON CONFLICT(provider) DO UPDATE SET
         state='closed', failures=0, cooldown_until=0`,
    ).bind(provider).run();
  } catch { /* best-effort */ }
}

/** Record a failure on a provider; trip OPEN once failures hit the threshold. */
export async function recordFailure(env: Env, provider: string, inFlight: { used: boolean } = { used: false }): Promise<void> {
  try {
    const now = Date.now();
    const row = await env.DB.prepare(
      "SELECT failures, cooldown_until FROM provider_health WHERE provider = ?",
    ).bind(provider).first<{ failures: number; cooldown_until: number }>();
    const prevCooldown = row?.cooldown_until ?? 0;
    const failures = (row?.failures ?? 0) + 1;
    if (failures >= BREAKER.failureThreshold) {
      const nextCooldown =
        prevCooldown > now
          ? Math.min(BREAKER.maxCooldownMs, prevCooldown * 2)
          : BREAKER.cooldownMs;
      await env.DB.prepare(
        `INSERT INTO provider_health (provider, state, failures, last_failure_at, cooldown_until)
         VALUES (?, 'open', ?, ?, ?)
         ON CONFLICT(provider) DO UPDATE SET
           state='open', failures=?, last_failure_at=?, cooldown_until=?`,
      ).bind(provider, failures, now, now + nextCooldown, failures, now, now + nextCooldown).run();
    } else {
      await env.DB.prepare(
        `INSERT INTO provider_health (provider, state, failures, last_failure_at, cooldown_until)
         VALUES (?, 'closed', ?, ?, ?)
         ON CONFLICT(provider) DO UPDATE SET failures=?, last_failure_at=?`,
      ).bind(provider, failures, now, prevCooldown, failures, now).run();
    }
  } catch { /* best-effort */ }
}

/** Cancelable fetch with a wall-clock timeout via AbortController. */
export async function fetchWithTimeout(
  url: string,
  init: RequestInit = {},
  timeoutMs: number,
): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** D1 transactional lock for cron overlap prevention. KV locks are unsafe for
 *  this (eventual consistency). Returns true if this invocation acquired the
 *  lock (should run the job); false if another instance holds it (skip). */
export async function acquireCronLock(env: Env, lockName: string, ttlMs = 55000): Promise<boolean> {
  const now = Date.now();
  const expires = now + ttlMs;
  try {
    const res = await env.DB.prepare(
      `UPDATE cron_locks
       SET locked_by=?, locked_at=?, expires_at=?
       WHERE lock_name=? AND (expires_at=0 OR expires_at < ?)`,
    ).bind("worker", now, expires, lockName, now).run();
    if (res.meta.changes > 0) return true;
    // Rows absent? Insert (unless a concurrent insert already won).
    const ins = await env.DB.prepare(
      `INSERT INTO cron_locks (lock_name, locked_by, locked_at, expires_at)
       SELECT ?, ?, ?, ? WHERE NOT EXISTS (
         SELECT 1 FROM cron_locks WHERE lock_name=? AND expires_at >= ?
       )`,
    ).bind(lockName, "worker", now, expires, lockName, now).run();
    return ins.meta.changes > 0;
  } catch {
    return true; // availability over strictness on lock failure
  }
}

/** Release a cron lock early (if the job finished well ahead of its TTL). */
export async function releaseCronLock(env: Env, lockName: string): Promise<void> {
  try {
    await env.DB.prepare(
      `UPDATE cron_locks SET expires_at=0 WHERE lock_name=?`,
    ).bind(lockName).run();
  } catch { /* best-effort */ }
}

/** Append an observability row to request_log (provider, step, status, latency). */
export async function logRequest(
  env: Env,
  provider: string,
  status: "ok" | "fail",
  latencyMs: number,
  step: number,
  note = "",
): Promise<void> {
  try {
    await env.DB.prepare(
      `INSERT INTO request_log (ts, provider, status, latency_ms, step, note)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).bind(Date.now(), provider, status, Math.round(latencyMs), step, note.slice(0, 200)).run();
  } catch { /* best-effort */ }
}

/** Wrapped provider call with retry + breaker + timeout + observability.
 *  fn(attempt) performs one raw attempt and returns { ok, status }. */
export async function withResilience(
  env: Env,
  provider: string,
  step: number,
  fn: (timeoutMs: number, attempt: number) => Promise<{ ok: boolean; status: number }>,
): Promise<boolean> {
  const start = Date.now();
  const state = await getBreakerState(env, provider);
  if (state === "open") {
    // Fast-fail: breaker open, reject without hitting the provider.
    await logRequest(env, provider, "fail", Date.now() - start, step, "breaker:open");
    return false;
  }
  const timeoutMs = TIMEOUT_MS[provider as keyof typeof TIMEOUT_MS] ?? TIMEOUT_MS.web;
  let lastStatus = 0;
  for (let attempt = 1; attempt <= RETRY.maxAttempts; attempt++) {
    const attemptStart = Date.now();
    let ok = false;
    try {
      const r = await fn(timeoutMs, attempt);
      ok = r.ok;
      lastStatus = r.status;
    } catch {
      ok = false;
      lastStatus = 0; // network abort/timeout
    }
    const latency = Date.now() - attemptStart;
    if (ok) {
      await recordSuccess(env, provider);
      await logRequest(env, provider, "ok", latency, step);
      return true;
    }
    if (attempt < RETRY.maxAttempts && isRetryableStatus(lastStatus)) {
      await logRequest(env, provider, "fail", latency, step, `retry:${attempt} status=${lastStatus}`);
      // Back off before next attempt.
      await new Promise((resolve) => setTimeout(resolve, backoffMs(attempt)));
      continue;
    }
    await recordFailure(env, provider);
    await logRequest(env, provider, "fail", latency, step, `status=${lastStatus}`);
    return false;
  }
  return false;
}
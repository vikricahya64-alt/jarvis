//=====================================================================
// loop_scheduler.ts — Centralized loop orchestrator for JARVIS.
//
// Semua siklus async dalam JARVIS dikoordinasi melalui modul ini:
// - Memory consolidation loop (dream + decay + observation)
// - Session sync loop (KV ↔ D1)
// - Error heal loop (detect → diagnose → fix → deploy)
// - Config optimize loop (analyze → suggest → apply)
// - Identity verify loop (epoch → hash → verify)
//
// Pola: Runnable → Scheduled → Acquired → Running → Completed/Failed
// Semua loop punya: health check, rate limit, fail-safe, observability.
//
// Design references:
// - Google SRE: error budgets, TOIL reduction
// - Kubernetes controller pattern: reconciliation loop
// - Akka/Pekko: supervised actor loops with backoff
//=====================================================================

import { Env } from "./db";
import { acquireCronLock, releaseCronLock } from "./resilience";

/** Status setiap loop. */
export type LoopStatus = "idle" | "running" | "completed" | "failed" | "rate_limited";

/** Definisi sebuah loop. */
export interface LoopDef {
  /** Nama unik loop (digunakan sebagai lock name) */
  name: string;
  /** Interval minimum antar run (ms) */
  minIntervalMs: number;
  /** Fungsi yang dijalankan */
  run: (env: Env) => Promise<void>;
  /** Timeout per run (ms) */
  timeoutMs: number;
  /** Aktif atau tidak */
  enabled: boolean;
}

/** State runtime sebuah loop. */
interface LoopState {
  status: LoopStatus;
  lastRun: number;
  lastDuration: number;
  lastError: string | null;
  consecutiveFailures: number;
  totalRuns: number;
  totalFailures: number;
}

/** In-memory state tracker. Tidak perlu persist — state rebuild dari D1 logs. */
const loopStates = new Map<string, LoopState>();

function getState(name: string): LoopState {
  let s = loopStates.get(name);
  if (!s) {
    s = {
      status: "idle",
      lastRun: 0,
      lastDuration: 0,
      lastError: null,
      consecutiveFailures: 0,
      totalRuns: 0,
      totalFailures: 0,
    };
    loopStates.set(name, s);
  }
  return s;
}

/** Cek apakah loop boleh run (rate limit + backoff). */
function canRun(def: LoopDef, state: LoopState): { ok: boolean; reason?: string } {
  if (!def.enabled) return { ok: false, reason: "disabled" };

  // Rate limit: belum waktunya
  if (Date.now() - state.lastRun < def.minIntervalMs) {
    return { ok: false, reason: "rate_limited" };
  }

  // Exponential backoff setelah consecutive failure
  if (state.consecutiveFailures >= 3) {
    const backoffMs = Math.min(
      def.minIntervalMs * Math.pow(2, state.consecutiveFailures - 2),
      3600_000, // max 1 hour backoff
    );
    if (Date.now() - state.lastRun < backoffMs) {
      return { ok: false, reason: `backoff (${state.consecutiveFailures} failures)` };
    }
  }

  return { ok: true };
}

/** Jalankan sebuah loop dengan timeout, error handling, dan observability. */
export async function runLoop(env: Env, def: LoopDef): Promise<void> {
  const state = getState(def.name);
  const check = canRun(def, state);

  if (!check.ok) {
    state.status = check.reason === "disabled" ? "idle" : "rate_limited";
    return;
  }

  // Acquire D1 lock (anti-concurrent)
  const lockName = `loop:${def.name}`;
  const haveLock = await acquireCronLock(env, lockName);
  if (!haveLock) {
    state.status = "rate_limited";
    return;
  }

  state.status = "running";
  const startTime = Date.now();

  try {
    // Execute with timeout
    await withTimeout(def.run(env), def.timeoutMs);

    state.status = "completed";
    state.consecutiveFailures = 0;
    state.totalRuns++;
  } catch (err) {
    state.status = "failed";
    state.lastError = (err as Error).message?.slice(0, 200) ?? "unknown";
    state.consecutiveFailures++;
    state.totalFailures++;
    state.totalRuns++;

    // Log error untuk error_monitor
    console.error(`[loop:${def.name}] failed: ${state.lastError}`);
  } finally {
    state.lastRun = Date.now();
    state.lastDuration = Date.now() - startTime;
    await releaseCronLock(env, lockName);
  }
}

/** Execute with timeout (AbortController pattern). */
function withTimeout(promise: Promise<void>, ms: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout after ${ms}ms`)), ms);
    promise
      .then(() => { clearTimeout(timer); resolve(); })
      .catch((err) => { clearTimeout(timer); reject(err); });
  });
}

/** Jalankan beberapa loop secara sequential (untuk cron handler). */
export async function runLoopBatch(env: Env, defs: LoopDef[]): Promise<void> {
  for (const def of defs) {
    await runLoop(env, def);
  }
}

/** Jalankan beberapa loop secara parallel (untuk non-critical loops). */
export async function runLoopParallel(env: Env, defs: LoopDef[]): Promise<void> {
  await Promise.allSettled(defs.map((def) => runLoop(env, def)));
}

/** Get status semua loops (untuk /system_health). */
export function getAllLoopStatus(): Array<{ name: string } & LoopState> {
  const result: Array<{ name: string } & LoopState> = [];
  for (const [name, state] of loopStates) {
    result.push({ name, ...state });
  }
  return result;
}

/** Get status satu loop. */
export function getLoopStatus(name: string): LoopState | null {
  return loopStates.get(name) ?? null;
}

/** Health check: true jika semua loop aktif sehat. */
export function isHealthy(): boolean {
  for (const [, state] of loopStates) {
    if (state.status === "failed" && state.consecutiveFailures >= 3) {
      return false;
    }
  }
  return true;
}

/** Format loop status untuk Telegram. */
export function formatLoopStatus(): string {
  const loops = getAllLoopStatus();
  if (loops.length === 0) return "🔄 Tidak ada loop aktif.";

  const lines = ["🔄 *Loop Status J.A.R.V.I.S.*", ""];
  const statusEmoji: Record<LoopStatus, string> = {
    idle: "⏸️",
    running: "🔄",
    completed: "✅",
    failed: "❌",
    rate_limited: "⏳",
  };

  for (const loop of loops) {
    const emoji = statusEmoji[loop.status] ?? "❓";
    const age = loop.lastRun > 0 ? `${Math.round((Date.now() - loop.lastRun) / 60_000)}m lalu` : "belum pernah";
    lines.push(`${emoji} *${loop.name}*: ${loop.status} (${age})`);
    if (loop.lastError) {
      lines.push(`   ⚠️ ${loop.lastError.slice(0, 60)}`);
    }
  }

  return lines.join("\n");
}

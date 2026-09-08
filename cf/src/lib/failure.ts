//=====================================================================
// failure.ts — FAILURE TAXONOMY + BUDGETED RECOVERY (Phase 3).
//
// Phase-3 contract (alphaXiv failure classifier + budgeted recovery):
// every detectable failure carries (1) a CLASS, (2) a recovery STRATEGY,
// and (3) an explicit LLM BUDGET so recovery can never loop or inflate
// the free-tier bill. The verifier (verifier.ts) is the deterministic
// semantic gate that proposes the verdict; this module decides WHAT the
// taxon costs to fix and runs it.
//
//   verdict    → strategy    → llm budget   → deterministic?
//   truncated    repair         0              yes (repairTruncatedReply)
//   raw_dump     rewrite        1 (max)       no (recoverReply w/ guidance)
//   non_answer   rewrite        1 (max)       no
//   repetitive   rewrite        1 (max)       no        (anchor-grounded)
//   empty/timeout/blocked/stale degrade       0 (never retry)  yes
//
// Operational classes ARE the registry contract: capability_registry's
// errorCodes (EMPTY|TIMEOUT|BLOCKED|STALE) maps 1:1 onto these — the
// registry advertises WHICH classes a capability can surface, this module
// decides how each is repaid.
//
// Every budgetedRecovery() run records its outcome through
// tallyGate/tallyFailure (KV, fire-and-forget) so the gap→upgrade loop
// (gap roll-up, Phase 4) can read back what misfired and how often.
// FAIL-OPEN GUARANTEE: this module never throws to the caller — a broken
// reply falls back to the caller's own canonical cascade.
//=====================================================================

import { Env } from "./db";
import {
  gateVerdict,
  tallyGate,
  repairTruncatedReply,
  type GateVerdict,
} from "./verifier";
import { recoverReply } from "./ai";

// ---------------------------------------------------------------------------
// Taxonomy
// ---------------------------------------------------------------------------

/** Semantic failure classes (from the deterministic output gate). */
export type VerdictFailure = Exclude<GateVerdict, "ok">;

/** Operational failure classes — 1:1 with capability_registry errorCodes. */
export type OperationalFailure = "empty" | "timeout" | "blocked" | "stale";

export type FailureClass = VerdictFailure | OperationalFailure;

export type RecoveryStrategy = "repair" | "rewrite" | "degrade" | "none";

export interface RecoveryPlan {
  class: GateVerdict | OperationalFailure;
  strategy: RecoveryStrategy;
  /** Maximum LLM calls this recovery may spend (0 for deterministic). */
  llmBudget: number;
  /** Whether a meaningful rewrite needs the prior anchor. */
  needsAnchor: boolean;
  /** True when recovery needs no provider call. */
  deterministic: boolean;
}

/** Where a failure happens (tally path; matches registry metricsKey intent). */
export type FailurePath = "search_synth" | "subagents" | "translate" | "understand" | "context7";

// ---------------------------------------------------------------------------
// Failure classification (pure)
// ---------------------------------------------------------------------------

/** Recoverability plan for a failure class. `ok` is a legal input (no-op) so
 *  callers can hand the raw gate verdict straight in. Anchor length matters for
 *  repetitive (no anchor → repetition is not even judgeable). Never throws. */
export function recoveryPlan(
  classOrVerdict: GateVerdict | OperationalFailure,
  anchorLength = 0,
): RecoveryPlan {
  switch (classOrVerdict) {
    case "truncated":
      return { class: "truncated", strategy: "repair", llmBudget: 0, needsAnchor: false, deterministic: true };
    case "repetitive":
      // Repetition is only meaningful against an anchor; without one the
      // rewrite still works but is downgraded to a general rewrite.
      return { class: "repetitive", strategy: "rewrite", llmBudget: 1, needsAnchor: anchorLength > 40, deterministic: false };
    case "raw_dump":
      return { class: "raw_dump", strategy: "rewrite", llmBudget: 1, needsAnchor: false, deterministic: false };
    case "non_answer":
      return { class: "non_answer", strategy: "rewrite", llmBudget: 1, needsAnchor: false, deterministic: false };
    case "empty":
    case "timeout":
    case "blocked":
    case "stale":
      // Operational failure → do NOT burn more LLM budget; let the caller's
      // degraded cascade (canned reply / provider failover) take over.
      return { class: classOrVerdict, strategy: "degrade", llmBudget: 0, needsAnchor: false, deterministic: true };
    case "ok":
      return { class: "ok", strategy: "none", llmBudget: 0, needsAnchor: false, deterministic: true };
  }
}

/** Coarse error classifier for operational (non-LLM) failures. Maps the
 *  capability_registry errorCodes vocabulary. Pure heuristic, never throws. */
export function classifyOperational(err: unknown, fallback: OperationalFailure = "empty"): OperationalFailure {
  const msg = String((err as Error)?.message ?? err ?? "").toLowerCase();
  if (/timeout|timed.?out|etimedout|abort/i.test(msg)) return "timeout";
  if (/403|429|404|error 5\d\d|5\d\d|blocked|captcha|too many|rate.?limit/i.test(msg)) return "blocked";
  if (/stale|expired|outdated|no (new |fresh )?result(final|s)?/i.test(msg)) return "stale";
  if (/empty|null|no content|nothing/i.test(msg)) return "empty";
  return fallback;
}

// ---------------------------------------------------------------------------
// Budgeted recovery loop
// ---------------------------------------------------------------------------

export interface RecoveryOpts {
  userText: string;
  bad: string;
  context?: Array<{ role: string; content: string }>;
  anchor: string;
  verdict: GateVerdict;
  topic: string;
  /** Tally path (registry metricsKey), e.g. "search_synth". */
  path: FailurePath;
  /** Caller-supplied LLM-call headroom (0 = deterministic only). */
  llmBudget: number;
}

export interface RecoveryResult {
  text: string;
  strategy: RecoveryStrategy;
  /** True when recovery produced a gate-clean reply. */
  recovered: boolean;
  /** Final gate verdict of the returned text. */
  outcome: GateVerdict;
  /** LLM calls actually spent during recovery. */
  llmSpent: number;
}

/** Run the budgeted recovery for a verdict. NEVER throws: at minimum returns
 *  `bad` untouched so the caller keeps its fail-open cascade. One rewrite at
 *  most (llmBudget is honored as a cap, and rewrite itself spends exactly 1). */
export async function budgetedRecovery(env: Env, o: RecoveryOpts): Promise<RecoveryResult> {
  const start: RecoveryResult = {
    text: o.bad,
    strategy: "none",
    recovered: false,
    outcome: o.verdict,
    llmSpent: 0,
  };
  if (!env || !o.bad) return start;

  const plan = recoveryPlan(o.verdict, o.anchor.length);
  void tallyGate(env, o.path, o.verdict).catch(() => {});

  // 1) Deterministic repair (truncated) — zero provider budget.
  if (plan.strategy === "repair") {
    const fixed = repairTruncatedReply(o.bad).trim();
    const out = gateVerdict(fixed || o.bad, o.anchor);
    return {
      text: (fixed || o.bad).trim(),
      strategy: "repair",
      recovered: out === "ok",
      outcome: out,
      llmSpent: 0,
    };
  }

  // 2) Rewrite (raw_dump / non_answer / repetitive) — exactly ONE call,
  //    honoring the caller's headroom.
  if (plan.strategy === "rewrite" && o.llmBudget > 0) {
    const rec = await recoverReply(env, o.userText, o.bad, o.context ?? [], o.anchor, o.verdict as VerdictFailure, o.topic);
    if (rec && rec.trim().length >= 40) {
      const out = gateVerdict(rec.trim(), o.anchor);
      return {
        text: rec.trim(),
        strategy: "rewrite",
        recovered: out === "ok",
        outcome: out,
        llmSpent: 1,
      };
    }
    return { ...start, strategy: "rewrite", outcome: o.verdict };
  }

  // 3) Degrade (operational) or no budget → caller's canonical fallback owns it.
  return { ...start, strategy: plan.strategy, outcome: o.verdict };
}

// ---------------------------------------------------------------------------
// Observability: failure roll-up (gap→upgrade ledger)
// ---------------------------------------------------------------------------

/** Best-effort KV tally of OPERATIONAL failures per path per day (mirrors
 *  tallyGate but for non-gate classes). Fire-and-forget, never throws. */
export async function tallyFailure(env: Env, path: FailurePath, cls: OperationalFailure): Promise<void> {
  if (!env) return;
  try {
    const d = new Date();
    const key = `fail:${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    const prev = await env.CONFIG_KV?.get(key).catch(() => null);
    const cur = (prev ? JSON.parse(prev) : {}) as Record<string, Record<string, number>>;
    cur[path] = cur[path] ?? {};
    cur[path][cls] = (cur[path][cls] ?? 0) + 1;
    await env.CONFIG_KV?.put(key, JSON.stringify(cur), { expirationTtl: 8 * 86400 }).catch(() => {});
  } catch { /* best-effort */ }
}

/** Compact 24h failure roll-up (gate + operational) — feed for the
 *  gap→upgrade loop and the /status diagnostic. Read-only, never throws. */
export async function readFailureTally(env: Env): Promise<string> {
  const d = new Date();
  const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const [gateRaw, failRaw] = await Promise.all([
    env.CONFIG_KV?.get(`gate:${day}`).catch(() => null),
    env.CONFIG_KV?.get(`fail:${day}`).catch(() => null),
  ]);
  const gate = (gateRaw ? JSON.parse(gateRaw) : {}) as Record<string, Record<string, number>>;
  const fail = (failRaw ? JSON.parse(failRaw) : {}) as Record<string, Record<string, number>>;
  const total = (m: Record<string, Record<string, number>>) =>
    Object.values(m).reduce((a, v) => a + Object.values(v).reduce((x, y) => x + y, 0), 0);
  const gateTotal = total(gate);
  const failTotal = total(fail);
  const format = (m: Record<string, Record<string, number>>) =>
    Object.entries(m)
      .map(([path, cls]) => `  ${path}: ${Object.entries(cls).map(([c, n]) => `${c}=${n}`).join(", ")}`)
      .join("\n") || "  —";
  return [
    "*Output Gate (24h)*",
    `  gate failures: ${gateTotal}${gateTotal ? "\n" + format(gate) : ""}`,
    `  operational failures: ${failTotal}${failTotal ? "\n" + format(fail) : ""}`,
    "",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Multi-day ledger (Phase 4 input: gap→upgrade)
// ---------------------------------------------------------------------------

export interface FailureLedgerRow {
  /** Tally path (registry metricsKey intent), e.g. "search_synth". */
  path: FailurePath;
  failureClass: FailureClass;
  /** Summed count over the window. */
  count: number;
}

/** ISO date string (YYYY-MM-DD) for a UTC day offset from today (offset 0 =
 *  today). Deterministic for fixed timestamps. */
export function ledgerDayKey(offset: number, now = Date.now()): string {
  const d = new Date(now);
  d.setUTCDate(d.getUTCDate() - offset);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

/** Aggregate the gate + operational ledgers across the last `days` days into
 *  per-(path, class) counts. Read-only, never throws. */
export async function readFailureLedger(env: Env, days = 7): Promise<FailureLedgerRow[]> {
  const agg = new Map<string, FailureLedgerRow>();
  const add = (path: string, cls: string, n: number) => {
    const key = `${path}:${cls}`;
    const prev = agg.get(key) ?? {
      path: path as FailurePath,
      failureClass: cls as FailureClass,
      count: 0,
    };
    prev.count += n;
    agg.set(key, prev);
  };
  for (let off = 0; off < days; off++) {
    const day = ledgerDayKey(off);
    const [gateRaw, failRaw] = await Promise.all([
      env.CONFIG_KV?.get(`gate:${day}`).catch(() => null),
      env.CONFIG_KV?.get(`fail:${day}`).catch(() => null),
    ]);
    const gate = (gateRaw ? JSON.parse(gateRaw) : {}) as Record<string, Record<string, number>>;
    const fail = (failRaw ? JSON.parse(failRaw) : {}) as Record<string, Record<string, number>>;
    for (const [path, byClass] of Object.entries(gate)) {
      for (const [cls, n] of Object.entries(byClass)) add(path, cls, n);
    }
    for (const [path, byClass] of Object.entries(fail)) {
      for (const [cls, n] of Object.entries(byClass)) add(path, cls, n);
    }
  }
  return [...agg.values()].sort((a, b) => b.count - a.count);
}
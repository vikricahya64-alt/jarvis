//=====================================================================
// e2b_executor.ts — serverless delegation to the E2B sandbox executor.
//
// Same SYSTEM as the opencode/GitHub executor (agent_executor.ts): the
// owner queues a task, JARVIS (as the orchestrating third party) borrows
// an EXTERNAL executor platform, the platform does the real work with
// its FULL native capability (no capability is re-built here), and the
// result comes back to Telegram asynchronously.
//
// Borrowed platform here = E2B Firecracker microVM sandboxes:
//   /etask <tugas>    queue + delegate now (ledger: agent_tasks, exec=e2b)
//   cron poller       probes each running sandbox once a minute, kills it
//                     when done, sanitizes + DMs the report (like /agent/done)
//
// Differences from the GitHub executor are ONLY the transport (E2B REST +
// envd Connect instead of repository_dispatch). Shared with all borrowers:
// payload cap + truncation notice (buildExecutorPayload), the agent_tasks
// ledger, the report sanitizer + injection flag. Fail-closed everywhere:
// never throws; missing key = unconfigured; dead sandbox = task failed with
// a visible reason (never silently dropped).
//=====================================================================

import { Env } from "./db";
import {
  buildExecutorPayload,
  stripDeepResearchFlag,
  usesDeepResearchProtocol,
  sanitizeAgentReport,
  flagAgentReport,
} from "./agent_executor";
import {
  e2bConfigured,
  e2bCreateSandbox,
  e2bGetSandboxToken,
  e2bKillSandbox,
  e2bStartProcessCollect,
} from "./e2b";
import { listAgentTasksByExecutor, finishAgentTask } from "./db";
import { finalizeAgentTask } from "./agent_results";

/** Sandbox TTL cap, mirroring the GitHub runner's 15-minute window. The
 *  sandbox self-destructs at this limit even if the poller missed it. */
const E2B_EXEC_TIMEOUT_MS = 900_000;
/** Budget for the launch call (must only confirm the background runner
 *  started, not wait for the whole agent task — that is the poller's job). */
const E2B_LAUNCH_TIMEOUT_MS = 20_000;
/** Budget for one status probe (a fast `cat`/`test` inside the sandbox). */
const E2B_PROBE_TIMEOUT_MS = 15_000;
/** Soft cap of probes per minute tick (Worker cron budget is tiny). */
const E2B_PROBES_PER_TICK = 6;

/** bash script launched DETACHED inside the sandbox by the webhook:
 *  runs the queued task with the sandbox's full environment, redirecting
 *  output to /tmp/jarvis_out.txt, then drops the /tmp/jarvis_done marker.
 *  The outer process returns immediately ("LAUNCHED") so the webhook can
 *  answer fast; the poller later reads the marker + output.
 *
 *  v11.48 FIX LIVE (RC=2): the translator legitimately emits python plans,
 *  but this script used to pipe EVERYTHING through bash — python dict/f-string
 *  braces became bash syntax errors (RC=2, empty report). Dispatch now on the
 *  JARVIS_LANG env var carried from the translation contract: python → python3
 *  (fallback python), bash → bash. Fail-closed default stays bash. */
export const E2B_LAUNCH_SCRIPT =
  "cd /tmp; printf %s \"$JARVIS_RUN\" > /tmp/jarvis_script.sh; " +
  "{ if [ \"$JARVIS_LANG\" = \"python\" ] && command -v python3 >/dev/null 2>&1; then " +
  "python3 /tmp/jarvis_script.sh > /tmp/jarvis_out.txt 2>&1; " +
  "elif [ \"$JARVIS_LANG\" = \"python\" ] && command -v python >/dev/null 2>&1; then " +
  "python /tmp/jarvis_script.sh > /tmp/jarvis_out.txt 2>&1; " +
  "else bash /tmp/jarvis_script.sh > /tmp/jarvis_out.txt 2>&1; fi; " +
  "echo JARVIS_RC=$? >> /tmp/jarvis_out.txt; touch /tmp/jarvis_done; } > /dev/null 2>&1 & " +
  "echo LAUNCHED";

/** bash script used by the poller to read the run marker + output. */
const E2B_PROBE_SCRIPT =
  "if [ -f /tmp/jarvis_done ]; then cat /tmp/jarvis_out.txt; echo JARVIS_DONE; " +
  "else echo JARVIS_RUNNING; fi";

export type E2bDelegateResult = { runId?: string; error?: string; truncated?: boolean };

export type E2bDelegateOpts = { riset?: boolean; language?: "bash" | "python" };

/** True when the E2B executor platform has an API key wired in. */
export function e2bExecutorConfigured(env: Env): boolean {
  return e2bConfigured(env);
}

/** Queue a task to E2B: create the sandbox (full template powers), launch the
 *  detached runner, return the sandbox id as the run id. Fail-closed. */
export async function delegateToE2b(
  env: Env,
  task: string,
  opts: E2bDelegateOpts = {},
): Promise<E2bDelegateResult> {
  if (!e2bConfigured(env)) return { error: "executor-not-configured", truncated: false };
  const wantRiset = opts.riset === true || usesDeepResearchProtocol(task);
  const { payload, truncated } = buildExecutorPayload(task, { riset: wantRiset });
  if (!payload.trim()) return { error: "e2b-empty-task", truncated };

  const lang = opts.language === "python" ? "python" : "bash";
  const created = await e2bCreateSandbox(env, payload, 0, {
    timeoutMs: E2B_EXEC_TIMEOUT_MS,
    envVars: { JARVIS_RUN: payload, JARVIS_LANG: lang },
  });
  if (!created.ok) return { error: created.error, truncated };

  const launch = await e2bStartProcessCollect(
    env, created.sandboxId, created.accessToken, E2B_LAUNCH_SCRIPT, E2B_LAUNCH_TIMEOUT_MS,
  );
  if (!launch.ok) {
    await e2bKillSandbox(env, created.sandboxId);
    return { runId: created.sandboxId, error: launch.error ?? "e2b-launch-failed", truncated };
  }
  return { runId: created.sandboxId, truncated };
}

export type E2bProbe = { status: "running" | "done" | "gone"; output?: string; error?: string };

/** One status/delivery probe against a running sandbox. Re-auths envd via
 *  GET /sandboxes/{id} (the access token is never persisted), reads the run
 *  marker + output file. Any platform failure = "gone" (fail-closed). */
export async function probeE2bRun(env: Env, sandboxId: string): Promise<E2bProbe> {
  const meta = await e2bGetSandboxToken(env, sandboxId);
  if (!meta.ok) return { status: "gone", error: meta.error };
  const s = await e2bStartProcessCollect(env, sandboxId, meta.accessToken, E2B_PROBE_SCRIPT, E2B_PROBE_TIMEOUT_MS);
  if (!s.ok) return { status: "gone", error: s.error ?? "e2b-probe-failed" };
  const out = `${s.stdout}${s.stderr}`.trim();
  return e2bOutcome(out);
}

/** Pure: turn a probe's raw combined output into a status + clean report.
 *  The probe appends "JARVIS_DONE" AFTER the run content, so strip the
 *  TRAILING marker line (not a leading one) and keep everything user-side. */
export function e2bOutcome(raw: string): E2bProbe {
  const out = (raw ?? "").trim();
  if (!/JARVIS_DONE/.test(out)) return { status: "running" };
  const clean = out
    .replace(/\n?JARVIS_DONE\s*$/, "")
    .replace(/^JARVIS_DONE\s*/, "")
    .trim();
  return { status: "done", output: clean };
}

/** Extract the exit code line ("JARVIS_RC=0") from the raw run output. */
export function e2bParseExitCode(raw: string): number | null {
  const m = (raw ?? "").match(/JARVIS_RC=(-?\d+)/);
  return m ? Number(m[1]) : null;
}

/** Strip the JARVIS_RC marker line from the report (leave user content). */
export function e2bStripMarker(raw: string): string {
  return (raw ?? "").replace(/\s*JARVIS_RC=-?\d+\s*$/, "").trim();
}

/** Per-minute cron poller: complete finished E2B sandbox runs on the
 *  agent_tasks ledger, DM the owner each report (mirrors /agent/done).
 *  Returns the number of tasks finalized this tick. Never throws. */
export async function pollE2bAgentRuns(env: Env): Promise<number> {
  if (!e2bConfigured(env)) return 0;
  const runs = await listAgentTasksByExecutor(env, "e2b", E2B_PROBES_PER_TICK);
  let finished = 0;
  for (const t of runs) {
    const base = {
      env, id: t.id, owner: t.owner_id, task: t.task,
      outcomeLabel: "eksekutor E2B", memoryLabel: "E2B",
    };
    const sid = t.run_id ?? "";
    if (!sid) {
      const err = "sandbox id hilang di ledger";
      await finishAgentTask(env, t.id, "failed", "", err);
      await finalizeAgentTask({ ...base, st: "failed", result: "", error: err, flagged: false });
      finished++;
      continue;
    }
    const probe = await probeE2bRun(env, sid);
    if (probe.status === "running") continue; // still working — poll again next tick
    await e2bKillSandbox(env, sid).catch(() => {});
    if (probe.status === "gone") {
      const err = probe.error ?? "sandbox tidak lagi ada; hasil tidak diterima (mungkin timeout sandbox)";
      await finishAgentTask(env, t.id, "failed", "", err);
      await finalizeAgentTask({ ...base, st: "failed", result: "", error: err, flagged: false });
      finished++;
      continue;
    }
    const raw = sanitizeAgentReport(probe.output ?? "");
    const flagged = flagAgentReport(raw);
    const rc = e2bParseExitCode(raw);
    const clean = e2bStripMarker(raw);
    if (rc === 0) {
      await finalizeAgentTask({ ...base, st: "done", result: clean, error: "", flagged });
    } else {
      await finalizeAgentTask({ ...base, st: "failed", result: clean, error: `proses keluar kode ${rc ?? "?"}`, flagged });
    }
    finished++;
  }
  return finished;
}

// Re-export for callers that only need the shared payload pieces.
export { buildExecutorPayload, stripDeepResearchFlag, usesDeepResearchProtocol };
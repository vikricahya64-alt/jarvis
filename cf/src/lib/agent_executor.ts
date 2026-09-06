//=====================================================================
// agent_executor.ts — serverless delegation to a FREE cloud executor.
//
// Principle: JARVIS (CF free tier) can't run arbitrary process/binaries
// (10ms CPU, no persistent shell). Instead it "borrows" opencode's
// orchestration + real-world execution by queueing a task to an
// ephemeral VM owned by GitHub (GitHub Actions, free 2k min/mo), which
// runs `opencode run` headless against the SAME OpenAI-compatible
// provider JARVIS already pays for (OpenRouter) → zero extra cost.
//
// Flow: webhook stores task (agent_tasks, mig 0016) → GitHub
// repository_dispatch → workflow fetches LLM keys from /agent/env →
// runs opencode → POSTs result to /agent/done → worker DMs owner.
// Fail-closed: any dispatch problem leaves the row pending; the owner
// is told in the chat, never silently dropped.
//=====================================================================

import { Env } from "./db";
import { fetchWithTimeout } from "./resilience";

const GITHUB_API = "https://api.github.com/repos/";

export type DelegateResult = { runId?: string; error?: string };

/** True when the cloud executor is fully configured. */
export function agentExecutorConfigured(env: Env): boolean {
  const repo = env.GITHUB_REPO ?? "";
  return Boolean(env.AGENT_TOKEN && env.GITHUB_TOKEN && /^[^/\s]+\/[^/\s]+$/.test(repo));
}

/** Queue a task to the GitHub repository_dispatch webhook. Returns a run id
 *  when accepted, or an error token on failure (never throws). */
export async function delegateToGithub(
  env: Env,
  taskId: number,
  task: string,
): Promise<DelegateResult> {
  const repo = env.GITHUB_REPO ?? "";
  const token = env.GITHUB_TOKEN ?? "";
  if (!repo || !token) return { error: "executor-not-configured" };
  try {
    const res = await fetchWithTimeout(
      `${GITHUB_API}${repo}/dispatches`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "Content-Type": "application/json",
          "User-Agent": "jarvis-sovereign",
          "X-GitHub-Api-Version": "2022-11-28",
        },
        body: JSON.stringify({
          event_type: "jarvis-task",
          client_payload: { task_id: String(taskId), task: task.slice(0, 3800) },
        }),
      },
      15000,
    );
    if (!res.ok) return { error: `github_http_${res.status}` };
    return {};
  } catch (e) {
    return { error: `dispatch_failed:${String(e).slice(0, 80)}` };
  }
}

// ---------------------------------------------------------------------
// Report sanitizer (output rail for /agent/done).
//
// The runner sends whatever opencode produced. Before we persist + DM it,
// we (1) strip ANSI/control clutter so the DM is clean and typed safely,
// (2) scan for obvious prompt-injection / override patterns so a poisoned
// task result can NEVER silently redirect JARVIS. We only WARN on flags —
// the owner keeps full autonomy, but the warning makes the risk visible.
// Both helpers are pure and fail-closed (never throw).
// ---------------------------------------------------------------------

const ANSI_RE = /\u001b\[[0-9;]*[A-Za-z]/g;

/** Strip ANSI escape sequences + stray control chars from runner output. */
export function sanitizeAgentReport(text: string): string {
  try {
    return (text ?? "")
      .replace(ANSI_RE, "")
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
      .replace(/\r/g, "")
      .replace(/\n{4,}/g, "\n\n\n")
      .trim();
  } catch {
    return "";
  }
}

const SUSPICIOUS_PATTERNS = [
  /\bignore\s+(all\s+|the\s+|your\s+)?(previous|prior|earlier|above)\s+(instructions|prompts?|rules?|context|chat)?\b/i,
  /\babaikan\s+(semua\s+)?(instruksi|perintah|aturan|konteks)(\s+sebelumnya)?\b/i,
  /\bdisregard\s+previous\b/i,
  /\bsaya\s+(telah|sudah)\s+(mengambil\s+alih|memegang\s+kendali)\b/i,
  /\b(override|bypass)\s+(the\s+)?(constitutional|covenant|guardrail|owner)\b/i,
];

/**
 * Lightweight prompt-injection / override flag on runner output. Pure scan —
 * the caller decides (JARVIS warns the owner, never follows or drops it).
 */
export function flagAgentReport(text: string): boolean {
  try {
    return SUSPICIOUS_PATTERNS.some((re) => re.test(text ?? ""));
  } catch {
    return false;
  }
}
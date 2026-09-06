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
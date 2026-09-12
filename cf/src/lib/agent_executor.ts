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
import { vercelBaseUrl } from "./vercel";

const GITHUB_API = "https://api.github.com/repos/";

export type DelegateResult = { runId?: string; error?: string; truncated?: boolean };

/** Batas payload instruksi (repository_dispatch client_payload aman jauh di
 *  bawah batas GitHub; 4000 menyisakan ruang untuk protokol). Dipangkas BUKAN
 *  buta: bila instruksi melewati batas, warning terlihat ditambahkan di akhir
 *  sehingga runner & owner sadar ada bagian yang terpotong (fail-visible). */
const PAYLOAD_CAP = 4000;
const TRUNCATION_NOTICE = "\n\n…⚠ instruksi terpotong melebihi batas kirim. Jalankan kembali sebagian lebih pendek bila perlu.";

/** Shared across executors: compose the payload sent/written to a borrowed
 *  executor — optional deep-research protocol first, then hard truncation
 *  with a visible notice. Pure and deterministic; used by both the GitHub
 *  executor and the E2B sandbox executor so every borrower obeys the SAME
 *  payload contract. */
export function buildExecutorPayload(task: string, opts: { riset: boolean }): { payload: string; truncated: boolean } {
  const cleanTask = stripDeepResearchFlag(task);
  const base = opts.riset ? `${cleanTask}${DEEP_RESEARCH_PROTOCOL}` : cleanTask;
  const truncated = base.length > PAYLOAD_CAP;
  const payload = truncated ? `${base.slice(0, PAYLOAD_CAP)}${TRUNCATION_NOTICE}` : base;
  return { payload, truncated };
}

/** True when the delegated task carries the "--riset" flag. */
export function usesDeepResearchProtocol(task: string): boolean {
  return /^--riset\b/i.test((task ?? "").trimStart());
}

/** Strip the "--riset" flag (forward the rest verbatim). */
export function stripDeepResearchFlag(task: string): string {
  return usesDeepResearchProtocol(task)
    ? task.trimStart().replace(/^--riset\b\s*/i, "").trim()
    : task;
}

/** Source-cited report protocol appended ONLY when the owner opts in with the
 *  "--riset" prefix (P2 deep-research parity): the executor must separate
 *  verifiable facts from judgments and give a live source URL per claim.
 *  Default delegation forwards the task VERBATIM (pure bridge) so the report
 *  faithfully answers the literal request without extra scaffolding. */
export const DEEP_RESEARCH_PROTOCOL = `

PROTOKOL LAPORAN (wajib):
1. Pisahkan FAKTA vs ANALISIS dalam laporan akhir.
2. Tiap klaim/fakta penting diberi sumber URL yang nyata (1-3 per poin).
3. Tulis ringkasan singkat di awal (maks 120 kata) dalam Bahasa Indonesia.
4. Jangan menyebut angka tanpa sumber. Jika ragu, tandai "perlu verifikasi".
5. Daftar sumber lengkap di bagian akhir.`;

/** Deterministic warning string when a dispatch succeeded but the instruction
 *  was truncated to the payload cap. Callers append it to the ok-message so
 *  the owner is never silently misled about what the runner received. */
export function truncationWarning(sent: DelegateResult): string {
  return sent.truncated
    ? "\n⚠️ Instruksinya *panjang* dan terpotong saat dikirim (batas aman). Hasil mungkin tak penuh — bagi jadi beberapa tugas lebih pendek bila perlu."
    : "";
}

/** Queue a task to the GitHub repository_dispatch webhook — via the Vercel
 *  Connector FIRST (token lives there, not in this worker), falling back to a
 *  direct GitHub API call when the connector is unconfigured/unreachable.
 *  Returns a run id when accepted, or an error token on failure (never throws).
 *  Fail-closed chain: connector → direct GitHub → error token. `opts.riset`
 *  force-appends the source-citation protocol (used by the negotiated add-path
 *  where the compiled instruction no longer carries the raw `--riset` prefix). */
export async function delegateToGithub(
  env: Env,
  taskId: number,
  task: string,
  opts: { riset?: boolean } = {},
): Promise<DelegateResult> {
  const repo = env.GITHUB_REPO ?? "";
  const token = env.GITHUB_TOKEN ?? "";

  const wantRiset = opts.riset === true || usesDeepResearchProtocol(task);
  const { payload, truncated } = buildExecutorPayload(task, { riset: wantRiset });

  if (!repo) return { error: "executor-not-configured", truncated };
  const [owner, repoName] = repo.split("/");

  // Path 1: Vercel Connector (repository_dispatch with token server-side).
  if (env.VERCEL_CONNECTOR_URL && env.VERCEL_CONNECTOR_TOKEN && owner && repoName) {
    const dispatched = await dispatchViaConnector(env, { owner, repo: repoName, taskId, task: payload });
    if (dispatched.ok) {
      await recordDispatchAudit(env, taskId, repo, task, "connector");
      return { truncated };
    }
    console.error(`[delegate] connector path failed (${dispatched.error}) — using direct GitHub`);
  }

  // Path 2: direct GitHub API (legacy fallback when connector is unavailable).
  if (!token) return { error: "executor-not-configured", truncated };
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
          client_payload: { task_id: String(taskId), task: payload },
        }),
      },
      15000,
    );
    if (!res.ok) return { error: `github_http_${res.status}`, truncated };
    await recordDispatchAudit(env, taskId, repo, task, "direct");
    return { truncated };
  } catch (e) {
    return { error: `dispatch_failed:${String(e).slice(0, 80)}`, truncated };
  }
}

/** repository_dispatch via the Vercel Connector (bounded, never throws). */
async function dispatchViaConnector(
  env: Env,
  opts: { owner: string; repo: string; taskId: number; task: string },
): Promise<{ ok: boolean; error?: string }> {
  try {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 15_000);
    try {
      const res = await fetch(`${vercelBaseUrl(env)}/api/actions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${env.VERCEL_CONNECTOR_TOKEN}`,
        },
        body: JSON.stringify({
          action: "repository_dispatch",
          owner: opts.owner,
          repo: opts.repo,
          event_type: "jarvis-task",
          client_payload: { task_id: String(opts.taskId), task: opts.task },
        }),
        signal: ac.signal,
      });
      if (!res.ok) return { ok: false, error: `connector_http_${res.status}` };
      const data = (await res.json().catch(() => null)) as { success?: boolean } | null;
      return data?.success === false ? { ok: false, error: "connector_rejected" } : { ok: true };
    } finally {
      clearTimeout(timer);
    }
  } catch (e) {
    return { ok: false, error: `connector_failed:${String(e).slice(0, 80)}` };
  }
}

/** Immutable dispatch audit record in KV (gateguard; never breaks dispatch). */
async function recordDispatchAudit(
  env: Env,
  taskId: number,
  repo: string,
  task: string,
  via: "connector" | "direct",
): Promise<void> {
  if (env.CONFIG_KV) {
    try {
      await env.CONFIG_KV.put(
        `dispatch:${taskId}`,
        JSON.stringify({ ts: Date.now(), repo, via, task: task.slice(0, 200) }),
        { expirationTtl: 7 * 86400 },
      );
    } catch { /* audit is best-effort */ }
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

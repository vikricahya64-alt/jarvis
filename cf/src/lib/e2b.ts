//=====================================================================
// e2b.ts — E2B (e2b.dev) sandbox executor client.
//
// E2B is a FREE-tier "borrowed external executor" of a NEW KIND for
// JARVIS, sitting next to opencode (GitHub Actions): real shell/Python
// execution inside an isolated Firecracker microVM that the free
// Cloudflare sandbox (10ms CPU) cannot do. Hobby tier = FREE forever,
// $100 one-time credits, 20 concurrent sandboxes, no credit card.
//
// Wire contract (live 2026, verified from the public OpenAPI spec):
//   Platform API (https://api.e2b.app, X-API-Key: e2b_...):
//     POST /sandboxes                 create (secure:true -> envdAccessToken)
//     DELETE /sandboxes/{id}          kill
//   Sandbox API/envd (https://sandbox.e2b.app, headers E2b-Sandbox-Id +
//   E2b-Sandbox-Port, X-Access-Token <envdAccessToken>):
//     POST /process.Process/Start    Connect-RPC server-streaming: runs a
//                                     process and streams ProcessEvent frames
//                                     (start / data{stdout|stderr} / end).
//                                     Body = ONE Connect envelope
//                                     [flag(1)][len(4, BE)][JSON]; response
//                                     streams envelopes, last one carries
//                                     flag 0x02 (end-of-stream).
//
// EVERYTHING FAILS CLOSED and never throws (same contract as vercel.ts /
// ai.ts): a missing key, network error, auth failure, or malformed frame
// returns a safe shape the caller degrades from. No key in the Worker ->
// the capability reports as unconfigured and costs nothing.
//=====================================================================

import { Env } from "./db";

const E2B_DEFAULT_BASE = "https://api.e2b.app";
const E2B_SANDBOX_HOST = "https://sandbox.e2b.app";
const E2B_SANDBOX_PORT = 49983;
const E2B_REQUEST_TIMEOUT_MS = 20_000;
/** Hard cap for a single sandbox run (5 min). Contains free-credit burn;
 *  long heavy tasks should move to a prebuilt template later. */
const E2B_RUN_CAP_MS = 300_000;
/** Network wall-time budget for collecting the envd stream (Workers Free
 *  caps a request ~30s; keep the real budget well under it). */
const E2B_COLLECT_MS = 25_000;
const E2B_OUTPUT_LIMIT = 3600;

export interface E2BRunResult {
  ok: boolean;
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  sandboxId?: string;
  error?: string;
}

export function e2bBaseUrl(env: Env): string {
  return (env.E2B_API_URL ?? E2B_DEFAULT_BASE).replace(/\/+$/, "");
}

/** True when the E2B sandbox executor has an API key wired into the Worker. */
export function e2bConfigured(env: Env): boolean {
  return Boolean(env.E2B_API_KEY?.trim());
}

/** Human label of an E2B failure token (fail-open, never leaks internals). */
export function e2bStateHint(error: string | undefined): string {
  if (!error) return "";
  switch (error) {
    case "e2b-empty-task": return "— kosong, beri perintah yang mau dijalankan.";
    case "e2b-not-configured": return "— kunci E2B_API_KEY belum dipasang di Worker.";
    case "e2b-create-network": case "e2b-run-network": case "e2b-kill-network":
      return "— jaringannya waktu habis, coba lagi sebentar.";
    case "e2b_auth_http_401": return "— kunci API ditolak E2B (expired/tidak sah).";
    case "e2b_auth_http_429": return "— batas/kuota E2B sementara tercapai, coba nanti.";
    case "e2b_auth_http_5xx": return "— E2B sedang ada gangguan, coba lagi.";
    case "e2b-no-sandbox-id": case "e2b-no-access-token":
      return "— respons E2B tak lengkap, coba lagi.";
    case "e2b-run_timeout":
      return "— batas waktu eksekusi tercapai (25 detik), sederhanakan perintahnya.";
    case "e2b-no-exit": return "— proses berakhir tanpa status keluar.";
    default: return `(${error})`;
  }
}

/** Create a sandbox via the platform API. Fail-closed. Exposed so the
 *  delegated async executor (e2b_executor.ts) creates its own sandboxes. */
export async function e2bCreateSandbox(
  env: Env,
  task: string,
  owner: number,
  opts: { template?: string; timeoutMs?: number; envVars?: Record<string, string> } = {},
): Promise<{ ok: true; sandboxId: string; accessToken: string } | { ok: false; error: string }> {
  const key = env.E2B_API_KEY?.trim();
  if (!key) return { ok: false, error: "e2b-not-configured" };
  try {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), E2B_REQUEST_TIMEOUT_MS);
    try {
      const timeoutMs = opts.timeoutMs ?? E2B_RUN_CAP_MS;
      const envVars = { JARVIS_TASK: task, JARVIS_TS: String(Date.now()), ...opts.envVars };
      const res = await fetch(`${e2bBaseUrl(env)}/sandboxes`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-API-Key": key,
        },
        body: JSON.stringify({
          templateID: opts.template?.trim() || env.E2B_TEMPLATE?.trim() || "e2b/base",
          timeout: Math.floor(timeoutMs / 1000),
          secure: true,
          allow_internet_access: true,
          metadata: { app: "jarvis", owner: String(owner) },
          envVars,
        }),
        signal: ac.signal,
      });
      if (!res.ok) {
        const code = res.status;
        const tag = code === 401 || code === 403 ? 401 : code === 429 ? 429 : code >= 500 ? 5 : code;
        return { ok: false, error: `e2b_auth_http_${tag}` };
      }
      const data = (await res.json()) as
        | { sandboxID?: string; envdAccessToken?: string | null } | null;
      if (!data || !data.sandboxID) return { ok: false, error: "e2b-no-sandbox-id" };
      if (!data.envdAccessToken) return { ok: false, error: "e2b-no-access-token" };
      return { ok: true, sandboxId: data.sandboxID, accessToken: data.envdAccessToken };
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return { ok: false, error: "e2b-create-network" };
  }
}

/** Kill (delete) a sandbox to stop billing immediately. Best-effort, never throws.
 *  Exposed so the delegated executor (and the poller) can free sandboxes. */
export async function e2bKillSandbox(env: Env, sandboxId: string): Promise<void> {
  const key = env.E2B_API_KEY?.trim();
  if (!key) return;
  try {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), E2B_REQUEST_TIMEOUT_MS);
    try {
      await fetch(`${e2bBaseUrl(env)}/sandboxes/${encodeURIComponent(sandboxId)}`, {
        method: "DELETE",
        headers: { "X-API-Key": key },
        signal: ac.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  } catch { /* kill is best-effort; the sandbox timeout also cleans up */ }
}

/** Recover the envd access token of a running/paused sandbox (the poller
 *  authenticates envd calls later without having stored the secret). */
export async function e2bGetSandboxToken(
  env: Env,
  sandboxId: string,
): Promise<{ ok: true; accessToken: string } | { ok: false; error: string }> {
  const key = env.E2B_API_KEY?.trim();
  if (!key) return { ok: false, error: "e2b-not-configured" };
  try {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), E2B_REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(`${e2bBaseUrl(env)}/sandboxes/${encodeURIComponent(sandboxId)}`, {
        headers: { "X-API-Key": key },
        signal: ac.signal,
      });
      if (!res.ok) {
        const tag = res.status === 401 ? 401 : res.status === 429 ? 429 : res.status >= 500 ? 5 : res.status;
        return { ok: false, error: `e2b_auth_http_${tag}` };
      }
      const data = (await res.json()) as { envdAccessToken?: string | null } | null;
      if (!data?.envdAccessToken) return { ok: false, error: "e2b-no-access-token" };
      return { ok: true, accessToken: data.envdAccessToken };
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return { ok: false, error: "e2b-run-network" };
  }
}

/** Connect wire frames: [flags(1)][len(4, BE)][json payload], repeated.
 *  Data frames carry flag 0x00; the final empty frame carries flag 0x02
 *  (end-of-stream). Returns the JSON payloads decoded from a full raw
 *  frame sequence. */
export function e2bDecodeConnectFrames(raw: Uint8Array): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  let i = 0;
  while (i + 5 <= raw.length) {
    const len =
      (raw[i + 1] << 24) | (raw[i + 2] << 16) | (raw[i + 3] << 8) | raw[i + 4];
    if (i + 5 + len > raw.length) break; // truncated frame -> stop, do not mis-parse
    const payload = raw.subarray(i + 5, i + 5 + len);
    try {
      out.push(JSON.parse(new TextDecoder().decode(payload)) as Record<string, unknown>);
    } catch { /* skip malformed frame */ }
    i += 5 + len;
  }
  return out;
}

/** Textually reconstruct stdout/stderr from the decoded process frames,
 *  honoring the output cap. Returns { stdout, stderr, exitCode?, end: bool }. */
function e2bFramesToText(frames: Array<Record<string, unknown>>): {
  stdout: string;
  stderr: string;
  exitCode?: number;
  ended: boolean;
} {
  let stdout = "";
  let stderr = "";
  let exitCode: number | undefined;
  let ended = false;
  const dec = new TextDecoder();
  const add = (field: string, base64: string) => {
    let s = "";
    try {
      const bin = atob(base64);
      const bytes = new Uint8Array(bin.length);
      for (let k = 0; k < bin.length; k++) bytes[k] = bin.charCodeAt(k);
      s = dec.decode(bytes);
    } catch { s = base64; }
    if (field === "stdout") stdout += s;
    else stderr += s;
  };
  for (const f of frames) {
    const ev = (f as { event?: Record<string, unknown> }).event as
      | { data?: Record<string, string>; end?: { status?: string; exited?: boolean; exitCode?: number } }
      | undefined;
    if (!ev) continue;
    if (ev.data) {
      const d = ev.data as Record<string, string>;
      if (typeof d.stdout === "string") add("stdout", d.stdout);
      if (typeof d.stderr === "string") add("stderr", d.stderr);
    }
    if (ev.end) {
      if (typeof ev.end.exitCode === "number") exitCode = ev.end.exitCode;
      else if (typeof ev.end.status === "string") {
        const m = ev.end.status.match(/exit\s+status\s+(-?\d+)/i);
        if (m) exitCode = Number(m[1]);
      }
      ended = Boolean(ev.end.exited);
    }
  }
  if (stdout.length > E2B_OUTPUT_LIMIT) stdout = stdout.slice(-E2B_OUTPUT_LIMIT);
  if (stderr.length > E2B_OUTPUT_LIMIT) stderr = stderr.slice(-E2B_OUTPUT_LIMIT);
  return { stdout, stderr, exitCode, ended };
}

/** Run ONE script in a fresh E2B sandbox and return its output.
 *  Fail-closed: never throws; every error degrades to a safe shape. */
export async function e2bRun(
  env: Env,
  task: string,
  owner: number,
): Promise<E2BRunResult> {
  const t = (task ?? "").trim();
  if (!t) return { ok: false, error: "e2b-empty-task" };

  const created = await e2bCreateSandbox(env, t, owner);
  if (!created.ok) return { ok: false, error: created.error };

  const started = await e2bStartProcessCollect(env, created.sandboxId, created.accessToken, t, E2B_COLLECT_MS);
  await e2bKillSandbox(env, created.sandboxId);
  if (!started.ok) {
    return { ok: false, sandboxId: created.sandboxId, error: started.error };
  }
  if (!started.ended && started.stdout + started.stderr !== "") {
    return {
      ok: false, sandboxId: created.sandboxId,
      stdout: started.stdout, stderr: started.stderr,
      error: "e2b-run_timeout",
    };
  }
  return {
    ok: true,
    sandboxId: created.sandboxId,
    stdout: started.stdout,
    stderr: started.stderr,
    exitCode: started.exitCode,
  };
}

/** Start ONE bash -lc process in a running sandbox over envd and collect its
 *  stream. THE single wire-contract owner for the Connect envelope (verified
 *  live against api.e2b.app): [flag(1)=0][len(4, BE)][JSON]. Fail-closed. */
export async function e2bStartProcessCollect(
  env: Env,
  sandboxId: string,
  accessToken: string,
  script: string,
  timeoutMs: number,
): Promise<{ ok: boolean; stdout: string; stderr: string; exitCode?: number; ended: boolean; error?: string }> {
  const payload = JSON.stringify({
    process: {
      cmd: "bash",
      args: ["-lc", script],
      envs: { JARVIS_TASK: script },
      cwd: "/home/user",
    },
    pty: null,
    tag: null,
    stdin: false,
  });
  try {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    // Connect server-streaming RPCs frame the request as a single envelope.
    const enc = new TextEncoder();
    const msg = enc.encode(payload);
    const framed = new Uint8Array(5 + msg.length);
    new DataView(framed.buffer).setUint32(1, msg.length, false);
    framed.set(msg, 5);
    const res = await fetch(`${E2B_SANDBOX_HOST}/process.Process/Start`, {
      method: "POST",
      headers: {
        "Content-Type": "application/connect+json",
        Accept: "application/connect+json",
        "Connect-Protocol-Version": "1",
        "Connect-Timeout-Ms": String(timeoutMs),
        "X-Access-Token": accessToken,
        "E2b-Sandbox-Id": sandboxId,
        "E2b-Sandbox-Port": String(E2B_SANDBOX_PORT),
      },
      body: framed,
      signal: ac.signal,
    }).catch(() => null);
    clearTimeout(timer);
    if (!res) return { ok: false, stdout: "", stderr: "", ended: false, error: "e2b-run-network" };
    if (!res.ok) {
      const tag = res.status === 401 ? 401 : res.status === 429 ? 429 : res.status >= 500 ? 5 : res.status;
      return { ok: false, stdout: "", stderr: "", ended: false, error: `e2b_auth_http_${tag}` };
    }
    const raw = await res.arrayBuffer();
    const frames = e2bDecodeConnectFrames(new Uint8Array(raw));
    const text = e2bFramesToText(frames);
    return {
      ok: true,
      stdout: text.stdout,
      stderr: text.stderr,
      exitCode: text.exitCode,
      ended: text.ended,
    };
  } catch {
    return { ok: false, stdout: "", stderr: "", ended: false, error: "e2b-run-network" };
  }
}

/** Short, markdown-safe confirmation of a finished sandbox run. */
export function e2bSummary(res: E2BRunResult, task: string): string {
  const snippet = task.length > 70 ? `${task.slice(0, 70)}…` : task;
  const head = `💻 *E2B — eksekusi sandbox selesai* (${
    res.ok ? "ok" : "gagal"
  }, exit ${res.exitCode ?? "?"})\n\n`;
  const body = [
    res.exitCode === 0 ? `$ ${snippet}` : `⚡ Perintah: \`${snippet}\``,
    res.stdout?.trim() ? `\n\`\`\`\n${res.stdout.trim().slice(0, E2B_OUTPUT_LIMIT)}\n\`\`\`` : "",
    res.ok && res.stderr?.trim() ? `\n*stderr:* \`\`\`\n${res.stderr.trim().slice(0, 800)}\n\`\`\`` : "",
    res.ok && !res.stdout?.trim() && !res.stderr?.trim() ? "*Selesai tanpa output.*" : "",
    !res.ok ? `\n⚠️ ${e2bStateHint(res.error)}` : "",
  ].filter(Boolean).join("");
  return head + body;
}
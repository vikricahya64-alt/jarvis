//=====================================================================
// project_plan.ts — GERBANG EKSEKUSI SATU-SATUNYA untuk eksekutor pihak
// ketiga (E2B). Keputusan eksekusi SELALU di pemilik: JARVIS (negosiator
// + penerjemah) membuat/menyimpan RENCANA, pemilik yang membuka eksekusi
// lewat persetujuan "ya proyek". Tidak ada jalur yang meluncurkan sandbox
// tanpa keputusan pemilik.
//
// Rencana tertunda disimpan di CONFIG_KV (30 menit); meta per-tugas
// (goal asli + kode, 7 hari) dipakai /proyek lanjut untuk iterasi.
// Fail-closed menyeluruh: tanpa rencana/kunci → jawaban ramah, tidak
// pernah membuka sandbox.
//=====================================================================

import { Env, addAgentTask, markAgentTaskRunning, finishAgentTask } from "./db";
import { e2bConfigured } from "./e2b";
import { delegateToE2b } from "./e2b_executor";
import { negotiateGoalTranslate, type ExecutablePlan } from "./translator";

export const PROJECT_PLAN_TTL_S = 30 * 60;
export const PROJECT_META_TTL_S = 7 * 24 * 60 * 60;

export type ExecLanguage = "bash" | "python";
export type ParkedProject = { goal: string; language: ExecLanguage; code: string; ts: number };
export type ProjectMeta = { goal: string; language: ExecLanguage; code: string; ts: number };

export function projectPlanKey(owner: number): string {
  return `proyek_plan:${owner}`;
}

export function projectMetaKey(taskId: number): string {
  return `proyek_meta:${taskId}`;
}

export async function readProjectPlan(env: Env, owner: number): Promise<ParkedProject | null> {
  try {
    const raw = await env.CONFIG_KV.get(projectPlanKey(owner));
    if (!raw) return null;
    const o = JSON.parse(raw) as ParkedProject;
    if (!o?.code) return null;
    const lang = String(o.language ?? "bash");
    return { goal: String(o.goal ?? ""), language: lang === "python" ? "python" : "bash", code: String(o.code), ts: Number(o.ts ?? 0) };
  } catch { return null; }
}

export async function parkProjectPlan(env: Env, owner: number, goal: string, language: ExecLanguage, code: string): Promise<void> {
  await env.CONFIG_KV.put(projectPlanKey(owner), JSON.stringify({ goal, language, code, ts: Date.now() }), {
    expirationTtl: PROJECT_PLAN_TTL_S,
  }).catch(() => {});
}

export async function clearProjectPlan(env: Env, owner: number): Promise<void> {
  await env.CONFIG_KV.delete(projectPlanKey(owner)).catch(() => {});
}

export async function storeProjectMeta(env: Env, taskId: number, goal: string, language: string, code: string): Promise<void> {
  await env.CONFIG_KV.put(projectMetaKey(taskId), JSON.stringify({ goal, language, code, ts: Date.now() }), {
    expirationTtl: PROJECT_META_TTL_S,
  }).catch(() => {});
}

export async function readProjectMeta(env: Env, taskId: number): Promise<ProjectMeta | null> {
  try {
    const raw = await env.CONFIG_KV.get(projectMetaKey(taskId));
    if (!raw) return null;
    const o = JSON.parse(raw) as ProjectMeta;
    if (!o?.goal) return null;
    return { goal: String(o.goal), language: String(o.language ?? "bash") === "python" ? "python" : "bash", code: String(o.code ?? ""), ts: Number(o.ts ?? 0) };
  } catch { return null; }
}

/** Injectable sandbox launcher for tests (default = real E2B delegation). */
export type LaunchDeps = {
  delegate?: (
    env: Env,
    task: string,
    opts?: { riset?: boolean; language?: "bash" | "python" },
  ) => Promise<{ runId?: string; error?: string }>;
};

export type LaunchOutcome =
  | { ok: true; id: number; language: string }
  | { ok: false; reason: "no-plan" | "e2b-not-configured" | "store" | "launch" };

/** Hasil NEGOSIASI + park: sesuatu untuk DITAMPILKAN ke pemilik (rencana)
 *  ATAU pertanyaan klarifikasi yang harus DITERUSKAN (keputusan tetap di
 *  pemilik; JARVIS tidak menebak dan tidak mengeksekusi). */
export type NegotiationPresentation =
  | { kind: "plan"; plan: ExecutablePlan; goal: string }
  | { kind: "ask"; ask: string };

/** Injectable negotiator for tests (default = real groq:translator). */
export type PlanDeps = {
  negotiate?: (env: Env, task: string, opts?: { constraint?: string }) => Promise<
    | { kind: "plan"; plan: ExecutablePlan }
    | { kind: "ask"; ask: string }
    | null
  >;
};

/** NEGOSIASI + TERJEMAH + PARK (keputusan DI PEMILIK): JARVIS bertanya ke
 *  penerjemah pihak ketiga atas nama pemilik; jika rencana → disimpan sebagai
 *  rencana tertunda (30 menit) untuk disetujui pemilik nanti; jika klarifikasi
 *  → dikembalikan untuk DITERUSKAN ke pemilik. Tidak pernah mengeksekusi.
 *  Fail-closed: negotiator gagal / bukan-tugas → null. */
export async function planAndParkProject(
  env: Env,
  owner: number,
  goal: string,
  opts: { constraint?: string } = {},
  deps: PlanDeps = {},
): Promise<NegotiationPresentation | null> {
  try {
    const g = await (deps.negotiate ?? negotiateGoalTranslate)(env, goal, opts);
    if (!g) return null;
    if (g.kind === "ask") return { kind: "ask", ask: g.ask };
    await parkProjectPlan(env, owner, goal, g.plan.language, g.plan.code);
    return { kind: "plan", plan: g.plan, goal };
  } catch {
    return null;
  }
}

/** COMMIT the owner-APPROVED plan: queue on the ledger, launch the sandbox,
 *  and transition the row ONCE with its run id. Only ever called AFTER the
 *  owner said "ya proyek". Never throws.
 *
 *  ORDERING (v11.43 contract, kept here): markAgentTaskRunning transitions
 *  pending→running against `WHERE status='pending'` — it must be called
 *  ONCE, carrying the run_id, AFTER delegation succeeds. A launch error
 *  marks running then finishes failed (finish's guard requires 'running'). */
export async function launchParkedProject(
  env: Env,
  owner: number,
  deps: LaunchDeps = {},
): Promise<LaunchOutcome> {
  try {
    const parked = await readProjectPlan(env, owner);
    if (!parked) return { ok: false, reason: "no-plan" };
    if (!e2bConfigured(env)) return { ok: false, reason: "e2b-not-configured" };
    const id = await addAgentTask(env, owner, parked.code.slice(0, 4000), "e2b");
    if (!id) return { ok: false, reason: "store" };
    // Keep the ORIGINAL goal + code per task so /proyek lanjut <id> can
    // re-translate without the owner re-typing the goal. Best-effort.
    await storeProjectMeta(env, id, parked.goal, parked.language, parked.code);

const delegate = deps.delegate ?? delegateToE2b;
    const { runId, error } = await delegate(env, parked.code, { language: parked.language }).catch(
      () => ({ runId: "", error: "e2b-launch-failed" }),
    );
    if (error) {
      await markAgentTaskRunning(env, id); // pending→running so finish's guard passes
      await finishAgentTask(env, id, "failed", "", error);
      await clearProjectPlan(env, owner);
      return { ok: false, reason: "launch" };
    }
    // SINGLE pending→running transition WITH the sandbox id.
    await markAgentTaskRunning(env, id, runId ?? "");
    await clearProjectPlan(env, owner);
    return { ok: true, id, language: parked.language };
  } catch {
    return { ok: false, reason: "launch" };
  }
}
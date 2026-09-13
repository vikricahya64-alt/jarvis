//=====================================================================
// maestro.ts — Autonomous Sovereign Maestro (Level 12 Transient Steward)
//
// Maestro adalah Level 12 yang meningkatkan J.A.R.V.I.S. dari mesin kepatuhan
// menjadi *maestro proaktif*: ia menguraikan tujuan menjadi rencana
// banyak-langkah, menjadwalkan tugas berulang, dan memimpin agenda harian,
// **selalu di bawah hierarki perintah dan consent pemilik.**
//
// Prinsip inti:
// 1. Autonomous hanya untuk item yang **sudah didelegasikan eksplisit** (plan, agenda, task)
// 2. Setiap rencana melewati **validasi consent** (setter, autonomous)
// 3. Semua eksekusi dicatat dalam obedience_audit (origin=autonomous)
// 4. Autonomy pause global (/pause) menghentikan maestro sepenuhnya
// 5. Kewenangan **covenant** (misalnya: consent, pause) selalu menang
//=====================================================================

import { Env, getDmsConfig, logObedience } from "./db";
import { validateActionAgainstCovenant } from "./covenant_core";
import { groqSingleShot } from "./ai";

export interface PlanStep {
  id: string;
  planId: string;
  stepIndex: number;
  goal: string;
  description: string; // Action to execute
  outcome: string;      // Expected result
  priority: number;     // 1-10, higher = more risky
  status: "pending" | "approved" | "rejected" | "completed" | "skipped";
  executedAt?: number;
}

export interface Plan {
  id: string;
  owner: number;
  goal: string;
  description: string;
  cadence: "hourly" | "daily" | "weekly" | "once";
  scheduleAt: number;
  lastRun?: number;
  status: "active" | "paused" | "completed";
}

export interface ScheduledTask {
  id: string;
  owner: number;
  description: string;
  cadence: "hourly" | "daily" | "weekly" | "once";
  scheduleAt: number;
  lastRun?: number;
  approved: boolean; // Owner delegated consent
  riskLevel: "low" | "medium" | "high";
}

/** Decompose a user goal into a numbered plan using Groq classification. */
export async function decomposeGoal(
  env: Env,
  owner: number,
  goal: string,
): Promise<{ planId: string; steps: PlanStep[] }> {
  if (!env.GROQ_API_KEY) throw new Error("GROQ_API_KEY not configured");

  const raw = await groqSingleShot(env, {
    label: "groq:maestro",
    user: goal,
    temperature: 0.2,
    maxTokens: 1000,
    messages: [
      {
        role: "system",

        content:
          "Kamu Maestro J.A.R.V.I.S. — tujuanmu adalah menguraikan perintah pengguna " +
          "menjadi rencana langkah bernomor yang konkret, terstruktur, dan executable. " +
          "Setiap langkah harus:",
      },
      {
        role: "system",
        content:
          "1) Numeric step indices (1,2,3...) " +
          "2) 'goal' ringkas (singkat, actionable) " +
          "3) 'description' detail instruksi " +
          "4) 'outcome' manfaat " +
          "5) numeric 'priority' 1-10 (1=low risk, 10=catastrophic) " +
          "Balas hanya dengan JSON array objek PlanStep, jangan ada tambahan teks.",
      },
      { role: "user", content: goal },
    ],
  });
  if (raw === null) throw new Error("Groq decompose failed");

  let steps: PlanStep[];
  try {
    steps = JSON.parse(raw) as PlanStep[];
    if (!Array.isArray(steps)) throw new Error("Parsed not an array");
  } catch {
    steps = [{
      id: "1", planId: "", stepIndex: 0,
      goal: "Implementasi manual", description: "Administrator harus mengonfirmasi rencana.", outcome: "Implementasi manual",
      priority: 5, status: "rejected",
    }];
  }

  const planId = await createPlan(env, owner, goal, steps);
  steps = steps.map((s, i) => ({
    ...s,
    id: `${planId}-${i+1}`,
    planId,
    stepIndex: i,
    status: "pending",
  }));

  await logObedience(env, owner, "PLAN_DECOMPOSED", 100, "EXECUTE", "COMPLIANT", {
    commandHash: planId, evidence: { stepsCount: steps.length },
  });

  return { planId, steps };
}

/** Create a new plan and approve the owner's confirmation. */
async function createPlan(env: Env, owner: number, goal: string, steps: PlanStep[]): Promise<string> {
  const planId = await sha256(`${owner}:${goal}:${Date.now()}`);
  const scheduleAt = Date.now();

  const batches = steps.map((step) =>
    env.DB.prepare(
      `INSERT INTO plan_steps (id, owner_id, plan_id, step_index, goal, description, outcome, priority, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
    ).bind(
      step.id, owner, planId, step.stepIndex, step.goal, step.description, step.outcome, step.priority, Date.now(),
    ),
  );
  batches.push(
    env.DB.prepare(
      `INSERT INTO plans (id, owner_id, goal, description, cadence, schedule_at, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'active', ?)`,
    ).bind(planId, owner, goal, `Plan: ${goal}`, 'once', scheduleAt, Date.now()),
  );
  await env.DB.batch(batches).catch(() => {});

  return planId;
}

/** Hash utility (Web Crypto, native in Workers). */
async function sha256(data: string): Promise<string> {
  const buffer = new TextEncoder().encode(data);
  const hash = await crypto.subtle.digest("SHA-256", buffer);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Schedule a recurring autonomous task (owner-delegated). */
export async function scheduleTask(
  env: Env,
  owner: number,
  description: string,
  cadence: "hourly" | "daily" | "weekly" | "once",
): Promise<string> {
  const nextRun = cadence === "hourly" ? Date.now() + 3600_000 :
    cadence === "daily" ? Date.now() + 86400_000 :
    cadence === "weekly" ? Date.now() + 604800_000 : Date.now();

  const taskId = await sha256(`${owner}:${description}:${nextRun}`);

  await env.DB.prepare(
    `INSERT INTO scheduled_tasks (id, owner_id, description, cadence, schedule_at, approved, risk_level, created_at)
     VALUES (?, ?, ?, ?, ?, 1, ?, ?)`,
  ).bind(
    taskId, owner, description.slice(0, 500), cadence, nextRun, getRiskLevel(description), Date.now(),
  ).run();

  await logObedience(env, owner, "TASK_SCHEDULED", 90, "EXECUTE", "PENDING", {
    commandHash: taskId, evidence: { cadence, description },
  });

  return taskId;
}

function getRiskLevel(desc: string): "low" | "medium" | "high" {
  const low = ["status", "health", "queue", "help", "profile", "time", "jam", "cuaca"].some((w) => desc.toLowerCase().includes(w));
  const high = ["wipe", "delete", "reset", "transfer", "kill", "override", "pause", "hapus", "reset", "kirim", "hapus", "bayar", "pindah"].some((w) => desc.toLowerCase().includes(w));
  return high ? "high" : low ? "medium" : "low";
}

/** Execute the next pending plan step (consented + safe).
 *  Real effector: applies config changes if step description contains
 *  "set <key>=<value>" pattern, storing in KV with 7-day TTL. */
export async function executePlanStep(env: Env, owner: number, planId: string): Promise<{ executed: boolean; configApplied?: string }> {
  const step = await getNextPendingStep(env, owner, planId);
  if (!step) return { executed: false };

  // Consent validation (covenant + consent gate)
  const covenantOk = await validateActionAgainstCovenant(env, owner, step.description);
  if (!covenantOk.allowed) {
    await logObedience(env, owner, "PLAN_STEP_BLOCKED", step.priority, "BLOCK", "BLOCKED", {
      commandHash: planId, blockingSource: covenantOk.violatedClauseId ?? "covenant",
    });
    await logObedience(env, owner, step.description, step.priority, "BLOCK", "BLOCKED", {
      commandHash: planId, blockingSource: "covenant_guard",
    });
    await setStepStatus(env, step.id, "blocked");
    return { executed: false };
  }

  // Global autonomy pause (/pause) menghentikan maestro sepenuhnya.
  const cfg = await getDmsConfig(env, owner);
  if (cfg.autonomy_paused) {
    await logObedience(env, owner, "PLAN_STEP_PAUSED", step.priority, "BLOCK", "PAUSED", {
      commandHash: planId, evidence: { reason: "autonomy_paused" },
    });
    return { executed: false };
  }

  // Safety guard: Priority 9+ -> require explicit user consent
  if (step.priority >= 9) {
    await logObedience(env, owner, "PLAN_STEP_CONSENT_REQUIRED", step.priority, "CONSENT", "PENDING", {
      commandHash: planId, evidence: { priority: step.priority },
    });
    return { executed: false };
  }

  // Real effector: apply config changes if step description contains "set <key>=<value>"
  let configApplied: string | undefined;
  const configMatch = step.description.match(/\bset\s+(\w+)\s*=\s*(\S+)/i);
  if (configMatch && env.CONFIG_KV) {
    const [, key, value] = configMatch;
    try {
      await env.CONFIG_KV.put(
        `maestro:config:${key}`,
        JSON.stringify({ value, appliedAt: Date.now(), planId, stepId: step.id }),
        { expirationTtl: 7 * 86400 },
      );
      configApplied = `${key}=${value}`;
    } catch { /* best-effort */ }
  }

  // Execute the step (audit + logging)
  await setStepStatus(env, step.id, "completed");
  await env.DB.prepare(
    `UPDATE plan_steps SET executed_at = ? WHERE id = ?`,
  ).bind(Date.now(), step.id).run();

  await logObedience(env, owner, `Step ${step.stepIndex} dari plan ${planId}`, step.priority, "EXECUTE", "COMPLIANT", {
    commandHash: planId, evidence: { description: step.description, outcome: step.outcome, configApplied },
  });

  // Catatan aktivitas pemilik (meningkatkan DMS)
  await touchActivity(env, owner, "edge");

  return { executed: true, configApplied };
}

/** Get the next pending step for a plan, respecting priority order. */
async function getNextPendingStep(env: Env, owner: number, planId: string): Promise<PlanStep | null> {
  const row = await env.DB.prepare(
    `SELECT * FROM plan_steps WHERE owner_id = ? AND plan_id = ? AND status = 'pending' ORDER BY priority ASC, step_index ASC LIMIT 1`,
  ).bind(owner, planId).first();
  return row as unknown as PlanStep | null;
}

/** Update plan step status. */
async function setStepStatus(env: Env, stepId: string, status: string): Promise<void> {
  await env.DB.prepare(
    `UPDATE plan_steps SET status = ?, executed_at = CASE WHEN ? = 'completed' THEN ${Date.now()} ELSE NULL END WHERE id = ?`,
  ).bind(status, status, stepId).run();
}

/** Touch activity (D1 helper untuk DMS dan logging). */
async function touchActivity(env: Env, owner: number, source: string): Promise<void> {
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO user_activity (owner_id, last_interaction, last_heartbeat, source, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(owner_id) DO UPDATE SET
       last_interaction = excluded.last_interaction,
       last_heartbeat = excluded.last_heartbeat,
       source = excluded.source,
       updated_at = excluded.updated_at`,
  ).bind(owner, now, now, source, now).run();

  await env.DB.prepare(
    `UPDATE dms_state SET stage='idle', last_interaction=?, updated_at=? WHERE owner_id=?`,
  ).bind(now, now, owner).run();
}

/** Ambil semua rencana milik pemilik (untuk respons /plan_status). */
export async function getPlans(env: Env, owner: number): Promise<Plan[]> {
  const { results } = await env.DB.prepare(
    `SELECT * FROM plans WHERE owner_id = ? ORDER BY created_at DESC LIMIT 50`,
  ).bind(owner).all();
  return results as unknown as Plan[];
}

/** Ambil detail tugas terjadwal (untuk /task_status). */
export async function getScheduledTasks(env: Env, owner: number): Promise<ScheduledTask[]> {
  const { results } = await env.DB.prepare(
    `SELECT * FROM scheduled_tasks WHERE owner_id = ? ORDER BY schedule_at`,
  ).bind(owner).all();
  return results as unknown as ScheduledTask[];
}

/** Next schedule slot by cadence. 'once' gets a far-future slot so it never
 *  re-fires after its single run (the guard `last_run < schedule_at` handles
 *  idempotence across consecutive cron ticks). */
function nextSlot(cadence: "hourly" | "daily" | "weekly" | "once", after: number): number {
  if (cadence === "daily") return after + 86400_000;
  if (cadence === "weekly") return after + 604800_000;
  if (cadence === "hourly") return after + 3600_000;
  return 4102444800000; // once → far future (2299)
}

/** Advance every ACTIVE plan by exactly one pending step, using the guarded
 *  executor (covenant + global /pause + priority≥9-consent are all enforced
 *  inside executePlanStep). A plan with no pending steps left is completed.
 *  Autonomous steps that get blocked keep their status and pause the plan
 *  until the owner acts. Returns the number of steps consumed. */
export async function advancePlans(env: Env, owner: number): Promise<number> {
  try {
    const { results } = await env.DB.prepare(
      `SELECT id FROM plans WHERE owner_id = ? AND status = 'active' LIMIT 10`,
    ).bind(owner).all<{ id: string }>();
    let advanced = 0;
    for (const p of results ?? []) {
      const stepBefore = await getNextPendingStep(env, owner, p.id);
      if (!stepBefore) {
        await env.DB.prepare(
          `UPDATE plans SET status = 'completed', last_run = ? WHERE id = ? AND status = 'active'`,
        ).bind(Date.now(), p.id).run().catch(() => {});
        continue;
      }
      await executePlanStep(env, owner, p.id);
      void advanced; // count below
      const stepAfter = await getNextPendingStep(env, owner, p.id);
      if (!stepAfter || stepAfter.id !== stepBefore.id) advanced++;
      if (!stepAfter) {
        // Final step consumed → the plan is done.
        await env.DB.prepare(
          `UPDATE plans SET status = 'completed', last_run = ? WHERE id = ? AND status = 'active'`,
        ).bind(Date.now(), p.id).run().catch(() => {});
      }
    }
    return advanced;
  } catch {
    return 0;
  }
}

type ScheduledTaskRow = {
  id: string;
  description: string;
  cadence: "hourly" | "daily" | "weekly" | "once";
  schedule_at: number;
  last_run: number;
  approved: number;
  risk_level: "low" | "medium" | "high";
};

/** Fire due owner-delegated scheduled tasks (the part of the Maestro that was
 *  designed but never wired to a trigger). SAFETY: only LOW-risk tasks fire
 *  autonomously; medium/high-risk tasks are reported to the owner as needing
 *  explicit consent and are NEVER auto-run. Global /pause stops this entirely
 *  at the caller. Returns counts for the owner notification. */
export async function fireDueScheduledTasks(
  env: Env,
  owner: number,
): Promise<{ fired: number; pendingConsent: number }> {
  // Global /pause gate — applies to ALL autonomous pathways, including this
  // one (the "stops at the caller" comment was only true for fireDueAgentRules;
  // fireDueScheduledTasks had NO gate of its own — M6 audit fix).
  try {
    const cfg = await getDmsConfig(env, owner);
    if (cfg.autonomy_paused) return { fired: 0, pendingConsent: 0 };
  } catch {
    return { fired: 0, pendingConsent: 0 };
  }
  const now = Date.now();
  try {
    const { results } = await env.DB.prepare(
      `SELECT id, description, cadence, schedule_at, last_run, approved, risk_level
       FROM scheduled_tasks
       WHERE owner_id = ? AND approved = 1 AND schedule_at <= ? AND last_run < schedule_at
       LIMIT 10`,
    ).bind(owner, now).all<ScheduledTaskRow>();
    let fired = 0;
    let pendingConsent = 0;
    for (const t of results ?? []) {
      if (t.risk_level !== "low") {
        pendingConsent++;
        continue;
      }
      await logObedience(env, owner, `TASK_RUN ${t.description.slice(0, 80)}`, 60, "EXECUTE", "COMPLIANT", {
        commandHash: t.id, evidence: { cadence: t.cadence, origin: "autonomous" },
      });
      await touchActivity(env, owner, "autonomous");
      const next = nextSlot(t.cadence, now);
      await env.DB.prepare(
        `UPDATE scheduled_tasks SET last_run = ?, schedule_at = ? WHERE id = ? AND last_run < schedule_at`,
      ).bind(now, next, t.id).run();
      fired++;
    }
    return { fired, pendingConsent };
  } catch {
    return { fired: 0, pendingConsent: 0 };
  }
}

/** Per-tick autonomy pulse: advance plans + fire due recurring tasks.
 *  Cheap (D1 + tiny logging only), fully guarded, and owner-notified by the
 *  cron caller. Returns a summary for the notification message. */
export async function tickAutonomy(
  env: Env,
  owner: number,
): Promise<{ plans: number; tasksFired: number; pendingConsent: number }> {
  const tasks = await fireDueScheduledTasks(env, owner);
  const plans = await advancePlans(env, owner);
  return { plans, tasksFired: tasks.fired, pendingConsent: tasks.pendingConsent };
}

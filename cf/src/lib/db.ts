//=====================================================================
// db.ts — D1 helpers (Cloudflare D1 = SQLite at the edge).
// Keeps all SQL in one place and adds the append-only guard for
// obedience_audit. Synchronous against D1's await API.
//=====================================================================

export interface Env {
  DB: D1Database;
  R2_VAULT: R2Bucket;
  CONFIG_KV: KVNamespace;
  TASKS: Queue<unknown>;
  TASKS_DEAD: Queue<unknown>;
  OWNER_TELEGRAM_ID: string;
  APP_ENV?: string;
  TELEGRAM_SECRET?: string;
  TELEGRAM_TOKEN?: string;
  GROQ_API_KEY?: string;
  CLARITY_GATE?: string;
  RISK_CONSENT_THRESHOLD?: string;
  CONSENT_TIMEOUT_S?: string;
  DMS_GRACE_DAYS?: string;
  DMS_STAGE1_HOURS?: string;
  DMS_STAGE2_HOURS?: string;
  QUEUE_RETRY_BACKOFF_MS?: string;
}

export type ResultMeta = { success: boolean; error?: string };

/** Read helpers ---------------------------------------------------- */
export async function getActivity(env: Env, owner: number): Promise<number> {
  try {
    const row = await env.DB.prepare(
      "SELECT last_interaction FROM user_activity WHERE owner_id = ?",
    ).bind(owner).first<{ last_interaction: number }>();
    return row?.last_interaction ?? 0;
  } catch {
    return 0;
  }
}

export async function getDmsState(env: Env, owner: number): Promise<Record<string, unknown> | null> {
  try {
    return await env.DB.prepare(
      "SELECT * FROM dms_state WHERE owner_id = ?",
    ).bind(owner).first();
  } catch {
    return null;
  }
}

/** Record a user interaction (resets DMS + heartbeat). Returns new ts. */
export async function touchActivity(env: Env, owner: number, source = "telegram"): Promise<number> {
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO user_activity (owner_id, last_interaction, last_heartbeat, source, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(owner_id) DO UPDATE SET
       last_interaction=excluded.last_interaction,
       last_heartbeat=excluded.last_heartbeat,
       source=excluded.source,
       updated_at=excluded.updated_at`,
  ).bind(owner, now, now, source, now).run();
  await env.DB.prepare(
    `UPDATE dms_state SET stage='idle', last_interaction=?, updated_at=?
     WHERE owner_id=?`,
  ).bind(now, now, owner).run();
  return now;
}

/** Append-only insert into obedience_audit. Never expose UPDATE/DELETE. */
export async function logObedience(
  env: Env,
  owner: number,
  actionType: string,
  priority: number,
  decision: string,
  compliance: string,
  opts: { commandHash?: string; blockingSource?: string; evidence?: Record<string, unknown> } = {},
): Promise<ResultMeta> {
  try {
    await env.DB.prepare(
      `INSERT INTO obedience_audit
       (owner_id, ts, action_type, user_command_hash, priority, decision, compliance, blocking_source, evidence_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      owner, Date.now(), String(actionType).toUpperCase(),
      opts.commandHash ?? "", priority, decision, compliance.toUpperCase(),
      opts.blockingSource ?? "", JSON.stringify(opts.evidence ?? {}),
    ).run();
    return { success: true };
  } catch (e) {
    return { success: false, error: (e as Error).message };
  }
}

export async function logConsent(
  env: Env,
  owner: number,
  correlationId: string,
  actionDesc: string,
  riskLevel: string,
  decision: string,
  priority: number,
): Promise<ResultMeta> {
  try {
    await env.DB.prepare(
      `INSERT INTO consent_log (owner_id, correlation_id, ts, action_desc, risk_level, decision, priority)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).bind(owner, correlationId, Date.now(), actionDesc, riskLevel, decision, priority).run();
    return { success: true };
  } catch (e) {
    return { success: false, error: (e as Error).message };
  }
}

/** Weekly "obeyed vs blocked" summary for /obedience_report. */
export async function obedienceWeekly(env: Env, owner: number): Promise<(
  | { id: number; compliance: string; decision: string; priority: number; ts: number }
)[]> {
  const since = Date.now() - 7 * 86400_000;
  const { results } = await env.DB.prepare(
    `SELECT id, compliance, decision, priority, ts FROM obedience_audit
     WHERE owner_id = ? AND ts >= ? ORDER BY ts DESC LIMIT 500`,
  ).bind(owner, since).all<{
    id: number; compliance: string; decision: string; priority: number; ts: number;
  }>();
  return results as { id: number; compliance: string; decision: string; priority: number; ts: number }[];
}

/** Queue depth counters for /queue_status. */
export async function queueStatus(env: Env): Promise<Record<string, number>> {
  const mk = async (q: string) => {
    try {
      // D1 cannot introspect queue depth; derive from tasks table presence.
      // We keep a lightweight counters table for producer/consumer activity.
      const r = await env.DB.prepare(
        "SELECT COUNT(*) AS n FROM task_counters WHERE queue = ?",
      ).bind(q).first<{ n: number }>();
      return r?.n ?? 0;
    } catch {
      return 0;
    }
  };
  return { high: await mk("high"), standard: await mk("standard"), low: await mk("low") };
}

// ---------------------------------------------------------------------
// dms_state.config_json helpers (command_rules, autonomy_paused, etc.)
// ---------------------------------------------------------------------
export interface DmsConfig {
  command_rules?: Array<{
    phrase: string;
    disable: boolean;
    at: string;
  }>;
  autonomy_paused?: boolean;
  constitution?: Record<string, unknown>;
  created_by_isr?: boolean;
}

export async function getDmsConfig(env: Env, owner: number): Promise<DmsConfig> {
  try {
    const row = await env.DB.prepare(
      "SELECT config_json FROM dms_state WHERE owner_id = ?",
    ).bind(owner).first<{ config_json: string }>();
    if (!row?.config_json) return {};
    return JSON.parse(row.config_json) as DmsConfig;
  } catch {
    return {};
  }
}

export async function writeDmsConfig(
  env: Env,
  owner: number,
  cfg: DmsConfig,
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO dms_state (owner_id, config_json, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(owner_id) DO UPDATE SET config_json=excluded.config_json, updated_at=excluded.updated_at`,
  ).bind(owner, JSON.stringify(cfg), Date.now()).run();
}
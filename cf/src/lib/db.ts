//=====================================================================
// db.ts — D1 helpers (Cloudflare D1 = SQLite at the edge).
// Keeps all SQL in one place and adds the append-only guard for
// obedience_audit. Synchronous against D1's await API.
//=====================================================================

export interface Env {
  DB: D1Database;
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

// ---------------------------------------------------------------------
// Constitutional violations (append-only guard block log)
// ---------------------------------------------------------------------
export async function logViolation(
  env: Env,
  owner: number,
  actionHash: string,
  violatedPrinciple: string,
  opts: { intent?: string; reasoning?: string; confidence?: number; originModule?: string } = {},
): Promise<ResultMeta> {
  try {
    await env.DB.prepare(
      `INSERT OR IGNORE INTO constitutional_violations
       (owner_id, action_hash, violated_principle, intent, reasoning, confidence, origin_module, blocked_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      owner, actionHash, violatedPrinciple, opts.intent ?? "", opts.reasoning ?? "",
      opts.confidence ?? 1.0, opts.originModule ?? "edge", Date.now(),
    ).run();
    return { success: true };
  } catch (e) {
    return { success: false, error: (e as Error).message };
  }
}

/** Count blocks per principle (for /obedience_report + drift context). */
export async function violationSummary(env: Env, owner: number): Promise<Record<string, number>> {
  try {
    const { results } = await env.DB.prepare(
      `SELECT violated_principle, COUNT(*) AS n FROM constitutional_violations
       WHERE owner_id = ? GROUP BY violated_principle`,
    ).bind(owner).all<{ violated_principle: string; n: number }>();
    const out: Record<string, number> = {};
    for (const r of results) out[r.violated_principle] = r.n;
    return out;
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------------
// Personal constitution (versioned amendments)
// ---------------------------------------------------------------------
export interface ConstitutionRow {
  id: number;
  version: number;
  content_md: string;
  amended_at: number;
  amendment_rationale: string;
  edited_by: string;
}

/** Read the current (highest-version) constitution, or null if unratified. */
export async function getConstitution(env: Env, owner: number): Promise<ConstitutionRow | null> {
  try {
    const row = await env.DB.prepare(
      `SELECT id, version, content_md, amended_at, amendment_rationale, edited_by
       FROM personal_constitution WHERE owner_id = ? ORDER BY version DESC LIMIT 1`,
    ).bind(owner).first<ConstitutionRow>();
    return row ?? null;
  } catch {
    return null;
  }
}

/** Append a new constitution version (amendment). Returns the new version. */
export async function amendConstitution(
  env: Env,
  owner: number,
  contentMd: string,
  opts: { rationale?: string; editedBy?: string } = {},
): Promise<number> {
  const cur = await getConstitution(env, owner);
  const version = (cur?.version ?? 0) + 1;
  await env.DB.prepare(
    `INSERT INTO personal_constitution
     (owner_id, version, content_md, amended_at, amendment_rationale, edited_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).bind(owner, version, contentMd, Date.now(),
    opts.rationale ?? "", opts.editedBy ?? "system", Date.now()).run();
  // Keep the active version in sync with what the fail-closed guard reads.
  const cfg = await getDmsConfig(env, owner);
  cfg.constitution = { content_md: contentMd, version };
  await writeDmsConfig(env, owner, cfg);
  return version;
}

// ---------------------------------------------------------------------
// Value alignment (L9 passive ethical learning port)
// ---------------------------------------------------------------------
export const DRIFT_THRESHOLD_CORRECTIONS = 5;
export const DRIFT_WINDOW_DAYS = 14;
export const PROPOSAL_TTL_DAYS = 7;

/** Insert a correction signal (durable drift counter in interaction_logs). */
export async function recordCorrection(
  env: Env,
  owner: number,
  domain: string,
  opts: { intent?: string; correction_signal?: number; note?: string } = {},
): Promise<{ drift: boolean; domain: string; correctionsInWindow: number }> {
  const dom = (domain || "misc").toLowerCase();
  const now = Date.now();
  const cutoff = now - DRIFT_WINDOW_DAYS * 86400_000;
  await env.DB.prepare(
    `INSERT INTO interaction_logs (owner_id, ts, kind, intent, correction_signal, payload_json)
     VALUES (?, ?, 'correction', ?, ?, ?)`,
  ).bind(owner, now, opts.intent ?? "", opts.correction_signal ?? -1,
    JSON.stringify({ domain: dom, note: opts.note ?? "" })).run();
  const { results } = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM interaction_logs
     WHERE owner_id = ? AND kind='correction' AND ts >= ?`,
  ).bind(owner, cutoff).all<{ n: number }>();
  const count = results?.[0]?.n ?? 0;
  return { drift: count >= DRIFT_THRESHOLD_CORRECTIONS, domain: dom, correctionsInWindow: count };
}

/** Insert a value-update proposal (status pending, expires in TTL). */
export async function proposeValue(
  env: Env,
  owner: number,
  domain: string,
  proposal: string,
  opts: { oldValue?: string; reason?: string; confidence?: number } = {},
): Promise<number> {
  const expiresAt = Date.now() + PROPOSAL_TTL_DAYS * 86400_000;
  const res = await env.DB.prepare(
    `INSERT INTO value_proposals
     (owner_id, ts, domain, old_value, new_proposal, reason, confidence, status, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
  ).bind(owner, Date.now(), (domain || "misc").toLowerCase(),
    opts.oldValue ?? "", proposal, opts.reason ?? "", opts.confidence ?? 0.7, expiresAt).run();
  return res.meta.last_row_id as number;
}

/** Confirm or reject a pending proposal. Returns true if a row was updated. */
export async function resolveProposal(
  env: Env,
  owner: number,
  proposalId: number,
  accept: boolean,
): Promise<boolean> {
  const status = accept ? "confirmed" : "rejected";
  const res = await env.DB.prepare(
    `UPDATE value_proposals SET status=?, confirmed_at=? WHERE id=? AND owner_id=? AND status='pending'`,
  ).bind(status, Date.now(), proposalId, owner).run();
  return (res.meta.changes ?? 0) > 0;
}

/** Mark unconfirmed proposals past TTL as expired. Returns count expired. */
export async function sweepExpiredProposals(env: Env, now = Date.now()): Promise<number> {
  const res = await env.DB.prepare(
    `UPDATE value_proposals SET status='expired'
     WHERE status='pending' AND expires_at <= ?`,
  ).bind(now).run();
  return res.meta.changes ?? 0;
}

/** List an owner's pending proposals (for /confirm_value, /reject_value). */
export async function pendingProposals(
  env: Env,
  owner: number,
  limit = 25,
): Promise<Array<{
  id: number; domain: string; new_proposal: string; old_value: string;
  reason: string; confidence: number; expires_at: number; ts: number;
}>> {
  const { results } = await env.DB.prepare(
    `SELECT id, domain, new_proposal, old_value, reason, confidence, expires_at, ts
     FROM value_proposals WHERE owner_id = ? AND status='pending' ORDER BY ts DESC LIMIT ?`,
  ).bind(owner, limit).all();
  return (results as unknown as {
    id: number; domain: string; new_proposal: string; old_value: string;
    reason: string; confidence: number; expires_at: number; ts: number;
  }[]);
}
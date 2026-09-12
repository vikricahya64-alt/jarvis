//=====================================================================
// db.ts — D1 helpers (Cloudflare D1 = SQLite at the edge).
// Keeps all SQL in one place and adds the append-only guard for
// obedience_audit. Synchronous against D1's await API.
//=====================================================================

import { semanticUpsertMemory } from "./memory_vec";

export interface MemVecIndex {
  upsert(vectors: Array<{ id: string; values: number[]; metadata?: Record<string, string | number> }>): Promise<unknown>;
  query(
    values: number[],
    opts?: { topK?: number; filter?: Record<string, string | number>; returnMetadata?: boolean; returnValues?: boolean },
  ): Promise<unknown>;
}

export interface Env {
  DB: D1Database;
  CONFIG_KV: KVNamespace;
  AI: Ai;
  MEM_VEC?: MemVecIndex;
  AI_GATEWAY_URL?: string;
  OWNER_TELEGRAM_ID: string;
  APP_ENV?: string;
  TELEGRAM_SECRET?: string;
  TELEGRAM_TOKEN?: string;
  GROQ_API_KEY?: string;
  GEMINI_API_KEY?: string;
  GEMINI_API_KEY_BACKUP?: string;
  GEMINI_API_KEY_SECONDARY?: string;
  GEMINI_MODEL?: string;
  OPENROUTER_API_KEY?: string;
  OPENROUTER_MODEL?: string;
  OPENROUTER_DEEP_MODEL?: string;
  NVIDIA_NIM_API_KEY?: string;
  NVIDIA_NIM_MODEL?: string;
  NVIDIA_NIM_DEEP_MODEL?: string;
  CONTEXT7_API_KEY?: string;
  AGENT_TOKEN?: string;
  GITHUB_TOKEN?: string;
  GITHUB_REPO?: string;
  WORKER_URL?: string;
  VERCEL_CONNECTOR_URL?: string;
  VERCEL_CONNECTOR_TOKEN?: string;
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
  // DMS dead-man's switch: only OWNER presence ("telegram" interaction) resets
  // the man-down timer. Autonomous/edge/heartbeat activity must NOT look like
  // the owner is alive (M6: previously every source reset DMS to idle).
  if (source === "telegram") {
    await env.DB.prepare(
      `UPDATE dms_state SET stage='idle', last_interaction=?, updated_at=?
       WHERE owner_id=?`,
    ).bind(now, now, owner).run();
  }
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

/**
 * Fetch the timestamp of the most recent pending consent request for a
 * correlation id (from obedience_audit's CONSENT_REQUEST rows). Used to
 * enforce the consent TTL (default-DENY after the window elapses).
 */
export async function getConsentRequestTs(env: Env, owner: number, corr: string): Promise<number | null> {
  try {
    const row = await env.DB.prepare(
      `SELECT ts FROM obedience_audit
       WHERE owner_id = ? AND action_type = 'CONSENT_REQUEST' AND user_command_hash = ?
       ORDER BY ts DESC LIMIT 1`,
    ).bind(owner, corr).first<{ ts: number }>();
    return row?.ts ?? null;
  } catch {
    return null;
  }
}

/** Detect deletion gaps in append-only audit tables. Append-only means id is
 *  monotonically increasing; if COUNT(*) < MAX(id) there is a gap (tampering
 *  or an accidental DELETE). Zero-risk read-only check exposed via /audit_status. */
export async function auditIntegrity(env: Env): Promise<Record<string, { count: number; maxId: number; gap: boolean }>> {
  const tables = ["obedience_audit", "consent_log", "constitutional_violations"] as const;
  const out: Record<string, { count: number; maxId: number; gap: boolean }> = {};
  for (const t of tables) {
    try {
      const row = await env.DB.prepare(`SELECT COUNT(*) AS c, COALESCE(MAX(id),0) AS m FROM ${t}`).first<{ c: number; m: number }>();
      const count = row?.c ?? 0;
      const maxId = row?.m ?? 0;
      out[t] = { count, maxId, gap: maxId > count };
    } catch {
      out[t] = { count: -1, maxId: -1, gap: false }; // table unavailable → no alarm
    }
  }
  return out;
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
  privacy_mode?: boolean;
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
  // Version computed ATOMICALLY inside D1 (MAX(version)+1 evaluated during the
  // insert, serialized by SQLite's write lock). The old app-side
  // read→increment→write RMW could hand two concurrent amendments the SAME
  // version number (config_json overwrite + duplicate version rows).
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO personal_constitution
     (owner_id, version, content_md, amended_at, amendment_rationale, edited_by, created_at)
     SELECT ?, COALESCE(MAX(version), 0) + 1, ?, ?, ?, ?, ?
     FROM personal_constitution WHERE owner_id = ?`,
  ).bind(owner, contentMd, now, opts.rationale ?? "", opts.editedBy ?? "system", now, owner).run();
  const row = await env.DB.prepare(
    `SELECT version FROM personal_constitution WHERE owner_id = ? ORDER BY version DESC LIMIT 1`,
  ).bind(owner).first<{ version: number }>();
  const version = row?.version ?? 1;
  // Keep the active version in sync with what the fail-closed guard reads.
  // Re-read config AFTER the insert so we never persist a pre-insert snapshot.
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

// ---------------------------------------------------------------------
// Passive Emotional Learning (L9 extension)
// ---------------------------------------------------------------------
// Stores emotional response patterns to adapt future responses.
// When user corrects emotional tone, learn and adapt.

/** Store emotional response pattern for a topic/user pair.
 *  Helps adapt tone when direct emotion detection fails. */
export async function storeEmotionalPattern(
  env: Env,
  _owner: number,
  topic: string,
  emotion: string,
  responseTone: string,
  success: boolean, // true if user accepted, false if corrected
): Promise<void> {
  const content = `[emotional_pattern] Topic: ${topic} | Detected: ${emotion} | Tone: ${responseTone} | Success: ${success}`;
  const importance = success ? 1.5 : 2.0; // Corrections are more important
  await rememberMemorySmart(env, content, {
    type: "fact",
    tags: ["emotional_pattern", topic.toLowerCase().slice(0, 50)],
    importance,
    source: "emotional_learning",
  });
}

/** Retrieve emotional patterns for a topic to adapt response tone. */
export async function getEmotionalPatterns(
  env: Env,
  _owner: number,
  topic: string,
): Promise<Array<{ emotion: string; tone: string; success: boolean }>> {
  try {
    const tail = topic.trim().replace(/[^\w\s-]/g, " ").slice(0, 60);
    if (!tail) return [];
    // Build an explicit AND query with each token QUOTED. A bare tail string is
    // unsafe as an FTS5 query — a user topic containing operator tokens
    // ("OR", "AND", "NOT") changes semantics or errors out, and an unquoted
    // multi-token string's implicit operator is tokenizer-dependent. Quoting +
    // explicit AND makes the match deterministic.
    const tokens = tail.split(/\s+/).filter(Boolean);
    const q = tokens.map((t) => `"${t}"`).join(" AND ");
    if (!q) return [];
    const { results } = await env.DB.prepare(
      `SELECT m.content
       FROM memories_fts
       JOIN memories m ON m.rowid = memories_fts.rowid
       WHERE memories_fts MATCH ? AND m.source = 'emotional_learning'
       ORDER BY bm25(memories_fts, 10.0, 5.0, 2.0) ASC
       LIMIT 3`,
    ).bind(q).all<{ content: string }>();
    
    return (results ?? []).map(r => {
      const match = r.content.match(/Detected: (.+?) \| Tone: (.+?) \| Success: (true|false)/);
      return match ? {
        emotion: match[1],
        tone: match[2],
        success: match[3] === "true",
      } : null;
    }).filter((p): p is NonNullable<typeof p> => p !== null);
  } catch {
    return [];
  }
}

/** Get the best response tone for a topic based on learned patterns. */
export async function getBestResponseTone(
  env: Env,
  owner: number,
  topic: string,
): Promise<string | null> {
  const patterns = await getEmotionalPatterns(env, owner, topic);
  if (patterns.length === 0) return null;
  
  // Count successes per tone
  const toneCounts: Record<string, { success: number; total: number }> = {};
  for (const p of patterns) {
    if (!toneCounts[p.tone]) toneCounts[p.tone] = { success: 0, total: 0 };
    toneCounts[p.tone].total++;
    if (p.success) toneCounts[p.tone].success++;
  }
  
  // Return tone with highest success rate (min 2 uses)
  let best: string | null = null;
  let bestRate = 0;
  for (const [tone, counts] of Object.entries(toneCounts)) {
    if (counts.total >= 2) {
      const rate = counts.success / counts.total;
      if (rate > bestRate) {
        bestRate = rate;
        best = tone;
      }
    }
  }
  
  return best;
}

/** Record a task counter for a queue class (used by producer side). */
export async function recordTaskCounters(env: Env, queue: string, owner: number): Promise<void> {
  try {
    await env.DB.prepare(
      `INSERT INTO task_counters (queue, owner_id, created_at) VALUES (?, ?, ?)`,
    ).bind(queue, owner, Date.now()).run();
  } catch { /* availability */ }
}

/** m9-v11.7: true when a persisted turn is an internal-state DUMP (the
 *  hallucinated "Audit Status" echo: WM block replayed verbatim, or an
 *  assistant reply that reproduced Tugas/Langkah/Catatan/Keyakinan lines).
 *  Such turns must never be re-injected into context (recentContext) nor
 *  persisted again (appendMemory) — otherwise the drift self-perpetuates even
 *  after the WM injection gates are fixed. */
export function isInternalEchoDump(content: string): boolean {
  if (!content) return false;
  return (
    /\[(?:Memori kerja|Kenangan relevan|Ringkasan)\]/.test(content) ||
    /^\s*(?:Audit Status|Langkah selesai\s*:|Catatan percakapan|Keyakinan pemahaman\s*:|Tugas aktif\s*:)\s*/im.test(content)
  );
}

/** Admin slash-command stems that are DIAGNOSTIC chatter, not conversation.
 *  Determined deterministically at the webhook edge; they must never reach the
 *  LLM brain nor be replayed into its context. The owner-facing equivalent of
 *  the HTTP admin surface (/status, /audit_status, …). Kept out of the LLM:
 *  a bare "/audit_status" falling through to the model produced the literal
 *  "Audit Status" drift that then anchored every following turn. */
const ADMIN_SLASH_STEMS = new Set([
  "audit_status", "auditstatus", "audit", "status", "dms_status",
  "queue_status", "health", "privacy", "debug_bypass", "obedience_report",
  "checkin", "stop", "kill", "pause", "pause_autonomy", "resume",
  "resume_autonomy", "covenant_status", "debug", "ai_diag", "setwebhook",
]);

/** m9-v11.9: admin/diagnostic chatter is NOT conversation. Matches (a) any
 *  bare slash-command turn for an admin endpoint ("/audit_status", "/status")
 *  and (b) assistant replies that discuss slash-command names or the literal
 *  audit-status drift shapes ("Maksud Anda dengan perintah '/auditstatus'…").
 *  Applied at the write source (appendMemory) and both read paths
 *  (recentContext, searchConversationLog) so these turns can never anchor or
 *  be recalled into the LLM context. Conversational slash commands (/tugas,
 *  /todo, /cari, /mark_stop, …) keep their commands + follow-ups. */
export function isAdminChaff(role: "user" | "assistant", content: string): boolean {
  if (!content) return false;
  const trimmed = content.trim();
  if (role === "user") {
    const m = trimmed.match(/^\/([a-zA-Z_0-9]+)(?:\s+\S.*)?$/);
    return !!m && ADMIN_SLASH_STEMS.has(m[1].toLowerCase());
  }
  return (
    /perintah\s+['"`]?\/(?:audit_status|auditstatus|audit|status|dms_status|queue_status|obedience_report|debug_bypass)/.test(trimmed) ||
    /\/(?:audit_status|auditstatus)\b/i.test(trimmed) ||
    /(?:audit\s*status|status\s+audit)\s*(?:percakapan|dialog|cek|status|keadaan|logging|tindakan|anda|kamu)?\b/i.test(trimmed)
  );
}

/** Append a turn to the conversation log (bounded). Returns true. When
 *  privacy_mode is on, the write is skipped (owner `/privacy on` switch). */
export async function appendMemory(env: Env, owner: number, role: "user" | "assistant", content: string, searchUsed = ""): Promise<void> {
  try {
    if ((await (await getDmsConfig(env, owner)).privacy_mode)) return;
    // Never re-persist an internal-state dump (m9-v11.7) nor admin/diagnostic
    // chatter (m9-v11.9) — both are machine-generated noise that would replay
    // into the LLM as "conversation" and anchor it onto admin concepts.
    if (isAdminChaff(role, content)) return;
    if (role === "assistant" && isInternalEchoDump(content)) return;
    await env.DB.prepare(
      `INSERT INTO conversation_log (owner_id, ts, role, content, search_used) VALUES (?, ?, ?, ?, ?)`,
    ).bind(owner, Date.now(), role, content.slice(0, 2000), searchUsed).run();
    // Keep bounded to ~100 turns per owner (cheap SQLite DELETE with LIMIT).
    await env.DB.prepare(
      `DELETE FROM conversation_log WHERE id IN (
        SELECT id FROM conversation_log WHERE owner_id = ? ORDER BY ts ASC LIMIT -1 OFFSET 100
      )`,
    ).bind(owner).run().catch(() => {});
  } catch { /* availability */ }
}

/** m9-v11.8: search OLDER conversation turns (ts < beforeTs) whose content
 *  shares significant terms with the current message — the human "I remember
 *  we talked about X earlier" recall that lets one chat roam across topics.
 *  Owner-bounded (~100 rows) so a per-term LIKE scan is cheap. Internal-state
 *  dumps are excluded; results ranked by distinct term hits. */
export async function searchConversationLog(
  env: Env,
  owner: number,
  terms: string[],
  n = 6,
  beforeTs = Infinity,
): Promise<Array<{ role: string; content: string; ts: number }>> {
  try {
    const clean = terms.filter((t) => /^[a-z0-9]{3,}$/i.test(t)).map((t) => t.toLowerCase());
    if (clean.length === 0) return [];
    const placeholders = clean.map(() => `content LIKE ?`).join(" OR ");
    const params: Array<string | number> = [owner, beforeTs, ...clean.map((t) => `%${t}%`)];
    const { results } = await env.DB.prepare(
      `SELECT role, content, ts FROM conversation_log
       WHERE owner_id = ? AND ts < ?
         AND (${placeholders})
       ORDER BY ts DESC LIMIT ?`,
    ).bind(...params, Math.min(120, n * 8)).all<{ role: string; content: string; ts: number }>();
    const scored = (results ?? [])
      .filter((r) => !isAdminChaff(r.role as "user" | "assistant", r.content))
      .filter((r) => r.role !== "assistant" || !isInternalEchoDump(r.content))
      .map((r) => {
        const rc = (r.content || "").toLowerCase();
        const hits = clean.filter((t) => rc.includes(t)).length;
        return { role: r.role, content: r.content, ts: r.ts, hits };
      })
      .sort((a, b) => (b.hits - a.hits) || (b.ts - a.ts))
      .slice(0, n);
    return scored.map(({ role, content, ts }) => ({ role, content, ts }));
  } catch {
    return [];
  }
}

/** Retrieve the last N turns of conversation context for the LLM. */
export async function recentContext(env: Env, owner: number, n = 6): Promise<Array<{ role: string; content: string; ts?: number }>> {
  try {
    const { results } = await env.DB.prepare(
      `SELECT role, content, ts FROM conversation_log WHERE owner_id = ? ORDER BY ts DESC LIMIT ?`,
    ).bind(owner, n).all<{ role: string; content: string; ts: number }>();
    // m9-v11.7: never hand an internal-state dump back to any consumer — the
    // persisted echo would keep steering new turns into the same drift.
    // m9-v11.9: admin/diagnostic chatter is excluded too, so a stale
    // "/audit_status" or its reply can no longer anchor the next 6 turns.
    return (results ?? [])
      .filter((r) => !isAdminChaff(r.role as "user" | "assistant", r.content))
      .filter((r) => r.role !== "assistant" || !isInternalEchoDump(r.content))
      .reverse().map((r) => ({ role: r.role, content: r.content, ts: r.ts }));
  } catch {
    return [];
  }
}

/** Prune old conversation turns (keep last keep_days) to bound storage. */
export async function pruneConversationLog(env: Env, owner: number, keepDays = 7): Promise<void> {
  try {
    const cutoff = Date.now() - keepDays * 86400_000;
    await env.DB.prepare(
      `DELETE FROM conversation_log WHERE owner_id = ? AND ts < ?`,
    ).bind(owner, cutoff).run().catch(() => {});
  } catch { /* availability */ }
}
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

// ---------------------------------------------------------------------
// Persistent memory (FTS5-indexed) — adopted from public-intelligence
// references: `memories` + `memories_fts` virtual table with sync triggers.
// ---------------------------------------------------------------------

/** Store a curated memory (fact/decision/context/person) into the FTS5 index. */
export async function rememberMemory(
  env: Env,
  content: string,
  opts: {
    type?: "fact" | "decision" | "context" | "person";
    tags?: string[];
    importance?: number;
    source?: string;
    ttlMs?: number;
  } = {},
): Promise<void> {
  const now = Date.now();
  const id = (() => {
    try {
      const c = (globalThis as { crypto?: { randomUUID: () => string } }).crypto;
      if (c?.randomUUID) return c.randomUUID();
    } catch { /* fall through */ }
    return `${now}-${Math.random().toString(16).slice(2)}`;
  })();
  const expires = opts.ttlMs ? now + opts.ttlMs : 0;
  try {
    await env.DB.prepare(
      `INSERT INTO memories (id, type, content, tags, importance, source, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      id,
      opts.type ?? "fact",
      String(content).slice(0, 2000),
      JSON.stringify(opts.tags ?? []),
      opts.importance ?? 1,
      opts.source ?? "turn",
      now,
      expires,
    ).run();
    // m9-v11.18 SEMANTIC MEMORY: mirror this memory into Vectorize (free) for
    // meaning-based recall. Fire-and-forget — keyword FTS remains the fallback
    // and semantic failure never blocks persistence.
    void semanticUpsertMemory(env, id, content, opts.type ?? "fact").catch(() => {});
  } catch { /* availability */ }
}

/** BM25 keyword retrieval over memories (D1 native FTS5). Returns top k. */
export async function searchMemory(
  env: Env,
  query: string,
  k = 5,
): Promise<Array<{ id: string; type: string; content: string; importance: number }>> {
  try {
    const tail = query.trim().replace(/[^\w\s-]/g, " ").slice(0, 60);
    if (!tail) return [];
    const { results } = await env.DB.prepare(
      `SELECT m.rowid, m.id, m.type, m.content, m.importance,
              bm25(memories_fts, 10.0, 5.0, 2.0) AS rank
       FROM memories_fts
       JOIN memories m ON m.rowid = memories_fts.rowid
       WHERE memories_fts MATCH ?
       ORDER BY rank ASC, m.importance DESC
       LIMIT ?`,
    ).bind(tail, k).all<{ rowid: number; id: string; type: string; content: string; importance: number }>();
    const rows = results ?? [];
    // Bump recency/access so consolidation knows which memories stay useful.
    if (rows.length > 0) {
      await env.DB.prepare(
        `UPDATE memories SET access_count=access_count+1, last_retrieved=?
         WHERE rowid IN (${rows.map(() => "?").join(",")})`,
      ).bind(Date.now(), ...rows.map((r) => r.rowid)).run().catch(() => {});
    }
    return rows.map((r) => ({ id: r.id, type: r.type, content: r.content, importance: r.importance }));
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------
// Self-Learning: Store learned knowledge from web search
// ---------------------------------------------------------------------

/** Store knowledge learned from web search results.
 *  Auto-tags as "learned" with high importance for future retrieval. */
export async function storeLearnedKnowledge(
  env: Env,
  topic: string,
  knowledge: string,
  source = "web_search",
): Promise<void> {
  const content = `[${topic}] ${knowledge}`.slice(0, 2000);
  await rememberMemorySmart(env, content, {
    type: "fact",
    tags: ["learned", topic.toLowerCase().slice(0, 50)],
    importance: 2.5, // High importance for learned knowledge
    source,
  });
}

/** Check if a topic is already known in memory.
 *  Returns true if relevant memories exist with high confidence. */
export async function isTopicKnown(
  env: Env,
  topic: string,
  minImportance = 2.0,
): Promise<boolean> {
  try {
    const tail = topic.trim().replace(/[^\w\s-]/g, " ").slice(0, 60);
    if (!tail) return false;
    const { results } = await env.DB.prepare(
      `SELECT m.rowid, m.importance
       FROM memories_fts
       JOIN memories m ON m.rowid = memories_fts.rowid
       WHERE memories_fts MATCH ?
       ORDER BY bm25(memories_fts, 10.0, 5.0, 2.0) ASC
       LIMIT 1`,
    ).bind(tail).all<{ rowid: number; importance: number }>();
    return (results?.[0]?.importance ?? 0) >= minImportance;
  } catch {
    return false;
  }
}

/** Delete expired memories (call from cron; frees D1 + keeps FTS5 tidy). */
export async function sweepExpiredMemories(env: Env, now = Date.now()): Promise<number> {
  try {
    const res = await env.DB.prepare(
      `DELETE FROM memories WHERE expires_at IS NOT NULL AND expires_at != 0 AND expires_at < ?`,
    ).bind(now).run();
    return res.meta.changes ?? 0;
  } catch {
    return 0;
  }
}

// ---------------------------------------------------------------------
// Memory Importance Auto-Scoring (2025-2026 SOTA)
// ---------------------------------------------------------------------
// Referensi: Mem0 (2025), Observational Memory (VentureBeat 2025),
// MemoryOS (EMNLP 2025). Importance dihitung otomatis dari sinyal konten,
// bukan manual.

/** Sinyal pentingnya sebuah memori berdasarkan konten. */
function computeImportance(content: string, type: string): number {
  let score = 1; // default

  // Tipe memori mempengaruhi skor dasar
  if (type === "decision") score += 1; // keputusan lebih penting dari fakta
  if (type === "person") score += 0.5; // info orang berguna untuk personalisasi

  // Sinyal konten
  const low = content.toLowerCase();

  // Memori yang mengandung angka/date/nama biasanya factual & penting
  if (/\d{4}[-\/]\d{2}[-\/]\d{2}/.test(content)) score += 0.5; // tanggal
  if (/\b(?:penting|important|critical|urgent|darurat|wajib)\b/i.test(low)) score += 1;
  if (/\b(?:putuskan|decided|pilih|choose|tetapkan|set)\b/i.test(low)) score += 0.5;

  // Memori yang sangat panjang atau sangat pendek = kurang penting
  if (content.length < 20) score -= 0.5;
  if (content.length > 500) score -= 0.3;

  // Memori yang mengandung kata kerja spesifik lebih berguna
  if (/\b(?:ingatkan|remind|jadwalkan|schedule|tolong|bantu)\b/i.test(low)) score += 0.5;

  return Math.max(0.5, Math.min(3, score));
}

/** Store a curated memory dengan auto-importance scoring. */
export async function rememberMemorySmart(
  env: Env,
  content: string,
  opts: {
    type?: "fact" | "decision" | "context" | "person";
    tags?: string[];
    importance?: number; // override otomatis jika disediakan
    source?: string;
    ttlMs?: number;
  } = {},
): Promise<void> {
  const importance = opts.importance ?? computeImportance(content, opts.type ?? "fact");
  await rememberMemory(env, content, { ...opts, importance });
}

// ---------------------------------------------------------------------
// Forgetting Curve (Ebbinghaus Decay)
// ---------------------------------------------------------------------
// Referensi: FadeMem, PMORS, Generative Agents recency. Memori yang
// tidak pernah diakses secara bertahap kehilangan importance-nya.

/** Half-life decay: importance berkurang setengah setiap N hari tanpa akses. */
const MEMORY_DECAY_HALF_LIFE_DAYS = 30;

/** Apply Ebbinghaus forgetting curve ke semua memori aktif.
 *  Memori yang baru diakses tidak decay. Panggil dari cron harian. */
export async function decayMemories(
  env: Env,
  now = Date.now(),
): Promise<{ decayed: number; removed: number }> {
  const halfLifeMs = MEMORY_DECAY_HALF_LIFE_DAYS * 86400_000;
  let decayed = 0;
  let removed = 0;

  try {
    // Decay: kurangi importance untuk memori yang sudah tua. Memori yang BARU
    // diakses (last_retrieved dalam 14 hari) tidak decay; yang tak pernah atau
    // lama tak diakses (>14 hari) tetap decay — sebelumnya syarat
    // `last_retrieved = 0/NULL` saja membuat memori yang pernah diakses sekali
    // tak pernah melupakan pentingnya (M6).
    const stale = await env.DB.prepare(
      `SELECT rowid, importance, last_retrieved, created_at FROM memories
       WHERE importance > 0.5 AND created_at < ?
       AND (last_retrieved = 0 OR last_retrieved IS NULL OR last_retrieved < ?)`,
    ).bind(now - 7 * 86400_000, now - 14 * 86400_000).all<{
      rowid: number; importance: number; last_retrieved: number; created_at: number;
    }>();

    for (const row of (stale.results ?? [])) {
      const age = now - (row.last_retrieved || row.created_at);
      const decayFactor = Math.pow(0.5, age / halfLifeMs);
      const newImportance = Math.max(0.5, row.importance * decayFactor);

      if (newImportance < row.importance) {
        await env.DB.prepare(
          `UPDATE memories SET importance = ? WHERE rowid = ?`,
        ).bind(Math.round(newImportance * 100) / 100, row.rowid).run();
        decayed++;
      }
    }

    // Hapus memori yang sudah sangat tidak penting dan tidak pernah diakses
    const cleanup = await env.DB.prepare(
      `DELETE FROM memories WHERE importance <= 0.5 AND access_count = 0
       AND created_at < ? AND (expires_at = 0 OR expires_at IS NULL)`,
    ).bind(now - 60 * 86400_000).run();
    removed = cleanup.meta.changes ?? 0;
  } catch { /* availability */ }

  return { decayed, removed };
}

// ---------------------------------------------------------------------
// Observational Memory (VentureBeat 2025)
// ---------------------------------------------------------------------
// Format: "[Tanggal] Observasi tentang user/preferensi/kejadian."
// Structured, dated notes yang ringkas tapi bisa dirujuk dalam reasoning.

/** Simpan observasi terstruktur tentang user. */
export async function saveObservation(
  env: Env,
  _owner: number,
  observation: string,
  category: string = "general",
): Promise<void> {
  const dated = `[${new Date().toISOString().slice(0, 10)}] ${observation}`;
  await rememberMemorySmart(env, dated, {
    type: "context",
    tags: ["observation", category],
    importance: 1.5, // observasi lebih penting dari fakta biasa
    source: "observation",
  });
}

/** Ambil observasi terbaru tentang user. */
export async function getRecentObservations(
  env: Env,
  k = 5,
): Promise<string[]> {
  try {
    const { results } = await env.DB.prepare(
      `SELECT content FROM memories
       WHERE type = 'context' AND tags LIKE '%observation%'
       ORDER BY created_at DESC LIMIT ?`,
    ).bind(k).all<{ content: string }>();
    return (results ?? []).map(r => r.content);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------
// Memory Consolidation Loop (coordinated with loop_scheduler)
// ---------------------------------------------------------------------
// Combines: decay → sweep expired → cleanup low-value → observation compaction.
// Single coordinated pass instead of independent cron jobs.

export interface ConsolidationResult {
  decayed: number;
  swept: number;
  cleaned: number;
  observationsCompacted: number;
}

/** Consolidate all memory maintenance in a single coordinated loop.
 *  Called by loop_scheduler instead of independent cron jobs. */
export async function consolidateMemories(
  env: Env,
  now = Date.now(),
): Promise<ConsolidationResult> {
  const result: ConsolidationResult = { decayed: 0, swept: 0, cleaned: 0, observationsCompacted: 0 };

  try {
    // 1) Ebbinghaus decay on all memories
    const decay = await decayMemories(env, now);
    result.decayed = decay.decayed;

    // 2) Sweep expired memories (TTL-based)
    result.swept = await sweepExpiredMemories(env, now);

    // 3) Cleanup of low-value never-accessed memories already happens INSIDE
    //    decayMemories (it deletes the same rows and reports them as `removed`).
    //    A second DELETE here was a redundant pass on every cron tick.
    result.cleaned = decay.removed;

    // 4) Compact old observations: merge similar observations into summary
    const oldObs = await env.DB.prepare(
      `SELECT rowid, content, created_at FROM memories
       WHERE type = 'context' AND tags LIKE '%observation%'
       AND created_at < ?
       ORDER BY created_at ASC LIMIT 20`,
    ).bind(now - 30 * 86400_000).all<{ rowid: number; content: string; created_at: number }>();

    // If we have many old observations, mark the oldest for archival
    if ((oldObs.results?.length ?? 0) > 10) {
      const toArchive = oldObs.results!.slice(0, 5);
      for (const obs of toArchive) {
        await env.DB.prepare(
          `UPDATE memories SET expires_at = ? WHERE rowid = ?`,
        ).bind(now, obs.rowid).run().catch(() => {});
        result.observationsCompacted++;
      }
    }
  } catch { /* availability */ }

  return result;
}

// ---------------------------------------------------------------------
// Reminders (owner-only; D1 table `reminders`, mig 0014).
// One-off timed notifications fired by the per-minute cron. Fail-closed:
// returns safe defaults / 0 on any error and never throws.
// ---------------------------------------------------------------------

export interface ReminderItem {
  id: number;
  owner_id: number;
  text: string;
  due_at: number;
  notified: number;
  repeat: string;
  created_at: number;
}

/** Insert a reminder. repeat '' = once; 'hourly' | 'daily' | 'weekly' rolls to
 *  the next slot after firing. Returns its id, or 0 on failure/invalid input. */
export async function addReminder(
  env: Env,
  owner: number,
  text: string,
  dueAt: number,
  repeat: "" | "hourly" | "daily" | "weekly" = "",
): Promise<number> {
  try {
    const clean = text.trim();
    if (!clean || !Number.isFinite(dueAt) || dueAt <= 0) return 0;
    const rep = repeat;
    const res = await env.DB.prepare(
      `INSERT INTO reminders (owner_id, text, due_at, notified, repeat, created_at) VALUES (?, ?, ?, 0, ?, ?)`,
    ).bind(owner, clean, Math.floor(dueAt), rep, Date.now()).run();
    return Number(res.meta.last_row_id ?? res.meta.changes ?? 0);
  } catch {
    return 0;
  }
}

/** List the owner's not-yet-fired reminders, soonest first. */
export async function listReminders(env: Env, owner: number): Promise<ReminderItem[]> {
  try {
    const { results } = await env.DB.prepare(
      `SELECT id, owner_id, text, due_at, notified, repeat, created_at FROM reminders
       WHERE owner_id = ? AND notified = 0
       ORDER BY due_at ASC LIMIT 100`,
    ).bind(owner).all<ReminderItem>();
    return results ?? [];
  } catch {
    return [];
  }
}

/** Cancel a reminder by numeric id (owner-scoped). Returns true if cancelled. */
export async function cancelReminderById(env: Env, owner: number, id: number): Promise<boolean> {
  try {
    const res = await env.DB.prepare(
      `DELETE FROM reminders WHERE owner_id = ? AND id = ? AND notified = 0`,
    ).bind(owner, id).run();
    return (res.meta.changes ?? 0) > 0;
  } catch {
    return false;
  }
}

/** Find all due-but-unnotified reminders across owners. Marks one-off rows
 *  notified FIRST (before any send) so a crash mid-send never double-fires;
 *  recurring rows are rolled to their next slot (still unnotified) so the next
 *  tick re-fires them. Returns the payload so the caller (cron) can deliver
 *  best-effort notifications. */
export async function checkDueReminders(env: Env): Promise<Array<{ ownerId: number; text: string; dueAt: number }>> {
  const now = Date.now();
  try {
    const { results } = await env.DB.prepare(
      `SELECT id, owner_id, text, due_at, notified, repeat FROM reminders WHERE notified = 0 AND due_at <= ? LIMIT 100`,
    ).bind(now).all<{ id: number; owner_id: number; text: string; due_at: number; repeat: string }>();
    const due = results ?? [];
    for (const r of due) {
      if (r.repeat === "daily" || r.repeat === "weekly" || r.repeat === "hourly") {
        const step = r.repeat === "daily" ? 86400_000 : r.repeat === "weekly" ? 604800_000 : 3600_000;
        let next = r.due_at + step;
        while (next <= now) next += step; // skip catch-up bursts
        await env.DB.prepare(
          `UPDATE reminders SET due_at = ? WHERE id = ? AND notified = 0`,
        ).bind(next, r.id).run().catch(() => {});
      } else {
        await env.DB.prepare(
          `UPDATE reminders SET notified = 1 WHERE id = ? AND notified = 0`,
        ).bind(r.id).run().catch(() => {});
      }
    }
    return due.map((r) => ({ ownerId: r.owner_id, text: r.text, dueAt: r.due_at }));
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------
// Serverless delegation ledger — agent_tasks (mig 0016).
// Heavy digital-work tasks queued for a free cloud executor (GitHub
// Actions + opencode). All helpers fail-closed: they return safe defaults
// (0 / [] / null / false) instead of throwing, so the webhook always
// answers gracefully. Statuses: pending → running → done|failed|rejected.
// ---------------------------------------------------------------------

export interface AgentTaskItem {
  id: number;
  owner_id: number;
  task: string;
  executor: string;
  status: string;
  run_id: string | null;
  created_at: number;
  started_at: number | null;
  finished_at: number | null;
  result: string | null;
  error: string | null;
  artifact_url: string | null;
  rule_id: number | null;
}

export interface AgentTaskRule {
  id: number;
  owner_id: number;
  task: string;
  recur_spec: string;
  next_fire_at: number;
  last_fire_at: number | null;
  active: number;
  created_at: number;
}

/** Insert a delegation task. Returns its id, or 0 on failure/invalid input. */
export async function addAgentTask(env: Env, owner: number, task: string, ruleId?: number): Promise<number> {
  try {
    const clean = task.trim();
    if (!clean || clean.length < 3 || clean.length > 4000) return 0;
    const res = await env.DB.prepare(
      `INSERT INTO agent_tasks (owner_id, task, executor, status, created_at, rule_id) VALUES (?, ?, 'github', 'pending', ?, ?)`,
    ).bind(owner, clean, Date.now(), ruleId ?? null).run();
    return Number(res.meta.last_row_id ?? res.meta.changes ?? 0);
  } catch {
    return 0;
  }
}

/** Mark a task as dispatched (running) with an optional executor run id.
 *  Called on dispatch SUCCESS regardless of whether GitHub returned a run id
 *  (dispatches API returns 204 without one), so a wedged runner can't leave
 *  the task silently "pending" forever (M6 stale-cleanup hole). */
export async function markAgentTaskRunning(env: Env, id: number, runId = ""): Promise<void> {
  try {
    await env.DB.prepare(
      `UPDATE agent_tasks SET status = 'running', run_id = ?, started_at = ? WHERE id = ? AND status = 'pending'`,
    ).bind(runId || "", Date.now(), id).run();
  } catch { /* best-effort */ }
}

/** Reset a previously terminal task (done/failed) back to 'pending' so a
 *  "/tugas lanjut <id>" re-dispatch can transition it again. Without this the
 *  row stayed terminal and markAgentTaskRunning was a silent no-op — the fresh
 *  GitHub run finished into a 409 "already terminal" at /agent/done and the
 *  result was discarded without ever reaching the owner (contract mismatch). */
export async function restartAgentTask(env: Env, id: number): Promise<void> {
  try {
    await env.DB.prepare(
      `UPDATE agent_tasks SET status = 'pending', run_id = '', started_at = NULL,
         finished_at = NULL, result = NULL, error = NULL, artifact_url = NULL
       WHERE id = ? AND status IN ('done', 'failed')`,
    ).bind(id).run();
  } catch { /* best-effort */ }
}

/** Finish a task with the executor's report (done or failed). */
export async function finishAgentTask(
  env: Env,
  id: number,
  status: "done" | "failed",
  result: string,
  error?: string,
  artifactUrl = "",
): Promise<void> {
  try {
    const now = Date.now();
    const artifact = artifactUrl.trim() ? artifactUrl.trim().slice(0, 400) : null;
    // status='running' guard: only the FIRST report finalizes the task
    // (replays/duplicates become no-ops at the DB layer too — M6).
    if (status === "failed") {
      await env.DB.prepare(
        `UPDATE agent_tasks SET status = ?, error = ?, artifact_url = ?, finished_at = ? WHERE id = ? AND status = 'running'`,
      ).bind(status, (error ?? result).slice(0, 6000), artifact, now, id).run();
    } else {
      await env.DB.prepare(
        `UPDATE agent_tasks SET status = ?, result = ?, artifact_url = ?, finished_at = ? WHERE id = ? AND status = 'running'`,
      ).bind(status, result.slice(0, 60000), artifact, now, id).run();
    }
  } catch { /* best-effort */ }
}

/**
 * Timeout guard for the GH runner: tasks stuck "running" longer than the
 * executor window are failed with an explicit message (fail-closed; the owner
 * is then told the result was never reported).
 */
export async function failStaleAgentTasks(env: Env, timeoutMs = 30 * 60 * 1000): Promise<number> {
  try {
    const cutoff = Date.now() - timeoutMs;
    const { meta } = await env.DB.prepare(
      `UPDATE agent_tasks SET status = 'failed',
         error = ?, finished_at = ?
       WHERE (status = 'running' AND started_at IS NOT NULL AND started_at < ?)
          OR (status = 'pending' AND created_at < ?)`,
    ).bind(
      `executor timeout (no report within ${Math.round(timeoutMs / 60000)} menit)`,
      Date.now(),
      cutoff,
      Date.now() - 24 * 60 * 60 * 1000,
    ).run();
    return Number(meta.changes ?? 0);
  } catch {
    return 0;
  }
}

/** TTL cleanup of terminal agent tasks (keeps D1 slim on the free tier). */
export async function pruneOldAgentTasks(
  env: Env,
  ttlMs = 14 * 24 * 3600 * 1000,
  limit = 50,
): Promise<number> {
  try {
    const cutoff = Date.now() - ttlMs;
    const { meta } = await env.DB.prepare(
      `DELETE FROM agent_tasks
       WHERE status IN ('done', 'failed', 'rejected')
         AND finished_at IS NOT NULL AND finished_at < ?
       LIMIT ?`,
    ).bind(cutoff, Math.max(1, Math.min(200, limit))).run();
    return Number(meta.changes ?? 0);
  } catch {
    return 0;
  }
}

// ---------------------------------------------------------------------
// Recurring heavy-task rules (mig 0018). A row = repeating template; each
// fire creates a real agent_tasks instance. All helpers fail-closed.
// ---------------------------------------------------------------------

/** Create a recurring rule. Returns its id, or 0 on failure/invalid input. */
export async function addAgentRule(
  env: Env,
  owner: number,
  task: string,
  recurSpec: string,
  nextFireAt: number,
): Promise<number> {
  try {
    const clean = task.trim();
    if (!clean || clean.length < 3 || clean.length > 4000) return 0;
    if (!recurSpec.trim()) return 0;
    const res = await env.DB.prepare(
      `INSERT INTO agent_task_rules (owner_id, task, recur_spec, next_fire_at, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).bind(owner, clean, recurSpec.trim(), Math.max(Date.now(), nextFireAt), Date.now()).run();
    return Number(res.meta.last_row_id ?? res.meta.changes ?? 0);
  } catch {
    return 0;
  }
}

/** List the owner's rules, soonest-next first. */
export async function listAgentRules(env: Env, owner: number): Promise<AgentTaskRule[]> {
  try {
    const { results } = await env.DB.prepare(
      `SELECT id, owner_id, task, recur_spec, next_fire_at, last_fire_at, active, created_at
       FROM agent_task_rules WHERE owner_id = ? ORDER BY next_fire_at ASC, id DESC`,
    ).bind(owner).all<AgentTaskRule>();
    return results ?? [];
  } catch {
    return [];
  }
}

/** Owner-scoped delete; returns true when a row was removed. */
export async function deleteAgentRule(env: Env, owner: number, id: number): Promise<boolean> {
  try {
    const { meta } = await env.DB.prepare(
      `DELETE FROM agent_task_rules WHERE id = ? AND owner_id = ?`,
    ).bind(id, owner).run();
    return Number(meta.changes ?? 0) > 0;
  } catch {
    return false;
  }
}

/** Pause/resume a rule (owner-scoped). Returns true when a row changed. */
export async function setAgentRuleActive(env: Env, owner: number, id: number, active: boolean): Promise<boolean> {
  try {
    const { meta } = await env.DB.prepare(
      `UPDATE agent_task_rules SET active = ? WHERE id = ? AND owner_id = ?`,
    ).bind(active ? 1 : 0, id, owner).run();
    return Number(meta.changes ?? 0) > 0;
  } catch {
    return false;
  }
}

/** Due rules (active, fire time passed, newest rules first). Bounded. */
export async function getDueAgentRules(env: Env, now: number, limit = 3): Promise<AgentTaskRule[]> {
  try {
    const { results } = await env.DB.prepare(
      `SELECT id, owner_id, task, recur_spec, next_fire_at, last_fire_at, active, created_at
       FROM agent_task_rules
       WHERE active = 1 AND next_fire_at <= ?
       ORDER BY next_fire_at ASC
       LIMIT ?`,
    ).bind(now, Math.max(1, Math.min(10, limit))).all<AgentTaskRule>();
    return results ?? [];
  } catch {
    return [];
  }
}

/** After a fire: record when it ran and when the next run is due. */
export async function updateAgentRuleFired(
  env: Env,
  id: number,
  lastFireAt: number,
  nextFireAt: number,
): Promise<boolean> {
  try {
    const res = await env.DB.prepare(
      `UPDATE agent_task_rules SET last_fire_at = ?, next_fire_at = ? WHERE id = ?`,
    ).bind(lastFireAt, nextFireAt, id).run();
    return (res.meta.changes ?? 0) > 0;
  } catch (e) {
    console.error("[agent_rules] updateAgentRuleFired FAILED", String(e).slice(0, 200));
    return false;
  }
}

/** Fetch one task row, or null. */
export async function getAgentTask(env: Env, id: number): Promise<AgentTaskItem | null> {
  try {
    const row = await env.DB.prepare(
      `SELECT id, owner_id, task, executor, status, run_id, created_at, started_at, finished_at, result, error, artifact_url, rule_id
       FROM agent_tasks WHERE id = ?`,
    ).bind(id).first<AgentTaskItem>();
    return row ?? null;
  } catch {
    return null;
  }
}

/** List the owner's tasks, newest first (limited). */
export async function listAgentTasks(env: Env, owner: number, limit = 20): Promise<AgentTaskItem[]> {
  try {
    const { results } = await env.DB.prepare(
      `SELECT id, owner_id, task, executor, status, run_id, created_at, started_at, finished_at, result, error, artifact_url, rule_id
       FROM agent_tasks WHERE owner_id = ? ORDER BY id DESC LIMIT ?`,
    ).bind(owner, Math.max(1, Math.min(100, limit))).all<AgentTaskItem>();
    return results ?? [];
  } catch {
    return [];
  }
}

/** Delete one of the owner's tasks (retryable rows only: pending/failed/done).
 *  Running tasks can't be force-removed, so a runaway row isn't silently lost. */
export async function deleteAgentTask(env: Env, owner: number, id: number): Promise<boolean> {
  try {
    const res = await env.DB.prepare(
      `DELETE FROM agent_tasks WHERE id = ? AND owner_id = ? AND status IN ('pending','failed','done')`,
    ).bind(id, owner).run();
    return (res.meta.changes ?? 0) > 0;
  } catch {
    return false;
  }
}

/** Recent executor activity (last `hours`), for the morning briefing. */
export async function statAgentTasksRecent(
  env: Env,
  since: number,
): Promise<{ done: number; failed: number; pending: number; latestArtifact: string }> {
  try {
    const { results } = await env.DB.prepare(
      `SELECT status, COUNT(*) AS n, MAX(CASE WHEN artifact_url IS NOT NULL AND artifact_url <> '' THEN id ELSE 0 END) AS last_art_id
       FROM agent_tasks WHERE created_at >= ? GROUP BY status`,
    ).bind(since).all<{ status: string; n: number; last_art_id: number }>();
    const rows = results ?? [];
    const pick = (s: string) => rows.find((r) => r.status === s)?.n ?? 0;
    let latestArtifact = "";
    const lastId = Math.max(...rows.map((r) => r.last_art_id || 0));
    if (lastId > 0) {
      const row = await env.DB.prepare(
        `SELECT artifact_url FROM agent_tasks WHERE id = ?`,
      ).bind(lastId).first<{ artifact_url: string }>();
      latestArtifact = row?.artifact_url ?? "";
    }
    return { done: pick("done"), failed: pick("failed"), pending: pick("pending"), latestArtifact };
  } catch {
    return { done: 0, failed: 0, pending: 0, latestArtifact: "" };
  }
}

// ---------------------------------------------------------------------
// Todo list (owner-only personal vault; D1 table `todos`, mig 0011).
// All functions fail-closed: they return safe defaults / throw-able states
// that the caller (webhook) turns into a graceful message — never silent.
// ---------------------------------------------------------------------

export interface TodoItem {
  id: number;
  text: string;
  done: number;
  created_at: number;
}

/** Insert a new todo. Returns its id, or 0 on failure. */
export async function addTodo(env: Env, owner: number, text: string): Promise<number> {
  try {
    const clean = text.trim();
    if (!clean) return 0;
    const res = await env.DB.prepare(
      `INSERT INTO todos (owner_id, text, done, created_at) VALUES (?, ?, 0, ?)`,
    ).bind(owner, clean, Date.now()).run();
    return Number(res.meta.last_row_id ?? res.meta.changes ?? 0);
  } catch {
    return 0;
  }
}

/** List the owner's open (undone) todos, newest first. */
export async function listTodos(env: Env, owner: number): Promise<TodoItem[]> {
  try {
    const { results } = await env.DB.prepare(
      `SELECT id, text, done, created_at FROM todos
       WHERE owner_id = ? AND done = 0
       ORDER BY created_at DESC LIMIT 200`,
    ).bind(owner).all<TodoItem>();
    return results ?? [];
  } catch {
    return [];
  }
}

/** Delete a todo by numeric id (owner-scoped). Returns true if deleted. */
export async function deleteTodoById(env: Env, owner: number, id: number): Promise<boolean> {
  try {
    const res = await env.DB.prepare(
      `DELETE FROM todos WHERE owner_id = ? AND id = ?`,
    ).bind(owner, id).run();
    return (res.meta.changes ?? 0) > 0;
  } catch {
    return false;
  }
}

/** Normalize text for fuzzy matching: lowercase, collapse whitespace, drop
 *  punctuation so "beli, telur!" and "beli telur" (or "Beli  Telur") compare
 *  identically. */
export function normForMatch(s: string): string {
  return (s || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Extract the meaningful target out of a delete request. Strips leading todo
 *  verbs/particles ("hapus todo ...", "delete task ...") and stray lead-in
 *  numbering ("3", "no 3") so over-qualified phrasing still matches. Exported
 *  for unit tests. Returns "" when nothing actionable remains. */
export function todoDeleteKey(needle: string): string {
  return normForMatch(needle)
    .replace(
      /^(?:(?:hapus(?:kan)?|delete|remove|del|todo|tugas|task|item|yang|buat)\s+)+/i,
      "",
    )
    .replace(/^(?:no\s*)?\d+(?:\.|\))?\s+(?=\S)/i, "")
    .trim();
}

/** Delete the owner's todo(s) whose text fuzzy-matches the needle:
 *  - needle is a case/space/punctuation-insensitive substring of the item, or
 *  - the whole (normalized) item text is a substring of the request (the user
 *    restated the item with a little extra context), or
 *  - every meaningful token of the needle appears in the item (order-insensitive
 *    coverage, e.g. "telur di beli" vs "beli telur").
 *  Fail-closed: returns 0 on any error and never throws. Exact numeric ids are
 *  handled by deleteTodoById; this is the fuzzy "hapus todo telur" path. */
export async function deleteTodoByText(env: Env, owner: number, needle: string): Promise<number> {
  try {
    const key = todoDeleteKey(needle);
    if (!key) return 0;
    const tokens = key.split(" ").filter((w) => w.length > 1);
    const items = await listTodos(env, owner);
    if (items.length === 0) return 0;
    const targets = items.filter((it) => {
      const t = normForMatch(it.text);
      if (!t) return false;
      if (t.includes(key)) return true;
      if (key.includes(t) && key.length - t.length < Math.max(t.length, 6)) return true;
      if (tokens.length > 0 && tokens.every((w) => t.includes(w))) return true;
      return false;
    });
    if (targets.length === 0) return 0;
    let deleted = 0;
    for (const t of targets.slice(0, 5)) {
      if (await deleteTodoById(env, owner, t.id)) deleted++;
    }
    return deleted;
  } catch {
    return 0;
  }
}

// ---------------------------------------------------------------------
// E-commerce & Sales (mig 0012, D1 tables: products, customers, orders,
// order_items). All functions owner-scoped, fail-closed.
// ---------------------------------------------------------------------

// ---- Product CRUD ----------------------------------------------------

export interface Product {
  id: number; owner_id: number; name: string; sku: string | null;
  description: string | null; price: number; cost: number; stock: number;
  min_stock: number; unit: string; category: string | null;
  status: string; created_at: number; updated_at: number;
}

export async function addProduct(
  env: Env, owner: number, name: string, price: number, stock: number,
  opts: { sku?: string; description?: string; category?: string; cost?: number; unit?: string; min_stock?: number } = {},
): Promise<number> {
  try {
    const clean = name.trim();
    if (!clean || price < 0) return 0;
    const res = await env.DB.prepare(
      `INSERT INTO products (owner_id, name, sku, description, price, cost, stock, min_stock, unit, category, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
    ).bind(
      owner, clean, opts.sku ?? null, opts.description ?? null,
      price, opts.cost ?? 0, stock, opts.min_stock ?? 5,
      opts.unit ?? "pcs", opts.category ?? null,
      Date.now(), Date.now(),
    ).run();
    return Number(res.meta.last_row_id ?? 0);
  } catch { return 0; }
}

export async function listProducts(env: Env, owner: number, status = "active"): Promise<Product[]> {
  try {
    const { results } = await env.DB.prepare(
      `SELECT * FROM products WHERE owner_id = ? AND status = ? ORDER BY name COLLATE NOCASE`,
    ).bind(owner, status).all<Product>();
    return results ?? [];
  } catch { return []; }
}

export async function getProduct(env: Env, owner: number, id: number): Promise<Product | null> {
  try {
    return await env.DB.prepare(
      `SELECT * FROM products WHERE owner_id = ? AND id = ?`,
    ).bind(owner, id).first<Product>() ?? null;
  } catch { return null; }
}

export async function updateProduct(
  env: Env, owner: number, id: number,
  fields: Partial<Pick<Product, "name" | "price" | "cost" | "stock" | "min_stock" | "unit" | "category" | "sku" | "description" | "status">>,
): Promise<boolean> {
  try {
    const sets: string[] = [];
    const vals: unknown[] = [];
    for (const [k, v] of Object.entries(fields)) {
      if (v !== undefined) { sets.push(`${k} = ?`); vals.push(v); }
    }
    if (!sets.length) return false;
    sets.push("updated_at = ?");
    vals.push(Date.now(), owner, id);
    const res = await env.DB.prepare(
      `UPDATE products SET ${sets.join(", ")} WHERE owner_id = ? AND id = ?`,
    ).bind(...vals).run();
    return (res.meta.changes ?? 0) > 0;
  } catch { return false; }
}

export async function deleteProduct(env: Env, owner: number, id: number): Promise<boolean> {
  try {
    const res = await env.DB.prepare(
      `DELETE FROM products WHERE owner_id = ? AND id = ?`,
    ).bind(owner, id).run();
    return (res.meta.changes ?? 0) > 0;
  } catch { return false; }
}

export async function adjustStock(env: Env, owner: number, id: number, delta: number): Promise<boolean> {
  try {
    const res = await env.DB.prepare(
      `UPDATE products SET stock = MAX(0, stock + ?), updated_at = ? WHERE owner_id = ? AND id = ?`,
    ).bind(delta, Date.now(), owner, id).run();
    return (res.meta.changes ?? 0) > 0;
  } catch { return false; }
}

export async function lowStockProducts(env: Env, owner: number): Promise<Product[]> {
  try {
    const { results } = await env.DB.prepare(
      `SELECT * FROM products WHERE owner_id = ? AND status = 'active' AND stock <= min_stock ORDER BY stock ASC`,
    ).bind(owner).all<Product>();
    return results ?? [];
  } catch { return []; }
}

// ---- Customer CRUD ---------------------------------------------------

export interface Customer {
  id: number; owner_id: number; name: string; phone: string | null;
  email: string | null; address: string | null; platform: string;
  notes: string | null; created_at: number;
}

export async function addCustomer(
  env: Env, owner: number, name: string,
  opts: { phone?: string; email?: string; address?: string; platform?: string; notes?: string } = {},
): Promise<number> {
  try {
    const clean = name.trim();
    if (!clean) return 0;
    const res = await env.DB.prepare(
      `INSERT INTO customers (owner_id, name, phone, email, address, platform, notes, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      owner, clean, opts.phone ?? null, opts.email ?? null,
      opts.address ?? null, opts.platform ?? "offline", opts.notes ?? null, Date.now(),
    ).run();
    return Number(res.meta.last_row_id ?? 0);
  } catch { return 0; }
}

export async function listCustomers(env: Env, owner: number): Promise<Customer[]> {
  try {
    const { results } = await env.DB.prepare(
      `SELECT * FROM customers WHERE owner_id = ? ORDER BY name COLLATE NOCASE`,
    ).bind(owner).all<Customer>();
    return results ?? [];
  } catch { return []; }
}

export async function getCustomer(env: Env, owner: number, id: number): Promise<Customer | null> {
  try {
    return await env.DB.prepare(
      `SELECT * FROM customers WHERE owner_id = ? AND id = ?`,
    ).bind(owner, id).first<Customer>() ?? null;
  } catch { return null; }
}

export async function searchCustomer(env: Env, owner: number, needle: string): Promise<Customer | null> {
  try {
    return await env.DB.prepare(
      `SELECT * FROM customers WHERE owner_id = ? AND name LIKE ? COLLATE NOCASE LIMIT 1`,
    ).bind(owner, `%${needle}%`).first<Customer>() ?? null;
  } catch { return null; }
}

// ---- Order CRUD ------------------------------------------------------

export interface OrderItem {
  id: number; order_id: number; product_id: number | null;
  product_name: string; qty: number; unit_price: number; subtotal: number;
}

export interface Order {
  id: number; owner_id: number; customer_name: string | null;
  platform: string; status: string; total: number; discount: number;
  shipping_cost: number; notes: string | null; created_at: number; updated_at: number;
  items?: OrderItem[];
}

export interface OrderInput {
  customer_name?: string;
  platform?: string;
  discount?: number;
  shipping_cost?: number;
  notes?: string;
  items: Array<{ product_id?: number; product_name: string; qty: number; unit_price: number }>;
}

/** Create an order with items in a batch. Returns order id or 0. */
export async function createOrder(env: Env, owner: number, input: OrderInput): Promise<number> {
  try {
    let total = 0;
    const itemRows = input.items.map((it) => {
      const sub = it.qty * it.unit_price;
      total += sub;
      return { ...it, subtotal: sub };
    });
    total = total - (input.discount ?? 0) + (input.shipping_cost ?? 0);
    if (total < 0) total = 0;

    const insertOrder = env.DB.prepare(
      `INSERT INTO orders (owner_id, customer_name, platform, status, total, discount, shipping_cost, notes, created_at, updated_at)
       VALUES (?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?)`,
    ).bind(
      owner, input.customer_name ?? null, input.platform ?? "offline",
      total, input.discount ?? 0, input.shipping_cost ?? 0, input.notes ?? null,
      Date.now(), Date.now(),
    );
    const batch = [insertOrder];
    for (const it of itemRows) {
      batch.push(env.DB.prepare(
        `INSERT INTO order_items (order_id, product_id, product_name, qty, unit_price, subtotal)
         VALUES (last_insert_rowid(), ?, ?, ?, ?, ?)`,
      ).bind(it.product_id ?? null, it.product_name, it.qty, it.unit_price, it.subtotal));
    }
    const results = await env.DB.batch(batch);
    const orderId = Number(results[0]?.meta?.last_row_id ?? 0);

    // Decrease stock for items with product_id
    for (const it of itemRows) {
      if (it.product_id) await adjustStock(env, owner, it.product_id, -it.qty);
    }
    return orderId;
  } catch { return 0; }
}

export async function listOrders(env: Env, owner: number, status?: string): Promise<Order[]> {
  try {
    const q = status
      ? [`SELECT * FROM orders WHERE owner_id = ? AND status = ? ORDER BY created_at DESC LIMIT 50`, owner, status]
      : [`SELECT * FROM orders WHERE owner_id = ? ORDER BY created_at DESC LIMIT 50`, owner];
    const { results } = await env.DB.prepare(q[0] as string).bind(...q.slice(1)).all<Order>();
    return results ?? [];
  } catch { return []; }
}

export async function getOrder(env: Env, owner: number, id: number): Promise<Order | null> {
  try {
    const order = await env.DB.prepare(
      `SELECT * FROM orders WHERE owner_id = ? AND id = ?`,
    ).bind(owner, id).first<Order>();
    if (!order) return null;
    const { results } = await env.DB.prepare(
      `SELECT * FROM order_items WHERE order_id = ?`,
    ).bind(id).all<OrderItem>();
    return { ...order, items: results ?? [] };
  } catch { return null; }
}

export async function updateOrderStatus(env: Env, owner: number, id: number, status: string): Promise<boolean> {
  try {
    const valid = ["pending", "confirmed", "paid", "shipped", "delivered", "completed", "cancelled"];
    if (!valid.includes(status)) return false;
    const res = await env.DB.prepare(
      `UPDATE orders SET status = ?, updated_at = ? WHERE owner_id = ? AND id = ?`,
    ).bind(status, Date.now(), owner, id).run();
    return (res.meta.changes ?? 0) > 0;
  } catch { return false; }
}

// ---- Sales Report ----------------------------------------------------

export interface SalesSummary {
  total_orders: number;
  total_revenue: number;
  total_cost: number;
  profit: number;
  avg_order: number;
  top_products: Array<{ name: string; qty: number; revenue: number }>;
}

export async function salesReport(env: Env, owner: number, fromTs: number, toTs: number): Promise<SalesSummary> {
  const empty: SalesSummary = { total_orders: 0, total_revenue: 0, total_cost: 0, profit: 0, avg_order: 0, top_products: [] };
  try {
    const agg = await env.DB.prepare(
      `SELECT COUNT(*) as cnt, COALESCE(SUM(total),0) as revenue, COALESCE(SUM(shipping_cost),0) as shipping FROM orders
       WHERE owner_id = ? AND created_at BETWEEN ? AND ? AND status != 'cancelled'`,
    ).bind(owner, fromTs, toTs).first<{ cnt: number; revenue: number; shipping: number }>();
    const totalOrders = agg?.cnt ?? 0;
    // Omzet = apa yang benar-benar dibayar customer (sudah net diskon + ongkir).
    const totalRevenue = agg?.revenue ?? 0;

    const costAgg = await env.DB.prepare(
      `SELECT COALESCE(SUM(oi.subtotal),0) as item_rev,
              COALESCE(SUM(oi.qty * COALESCE(p.cost, 0)),0) as item_cost
       FROM order_items oi
       JOIN orders o ON o.id = oi.order_id
       LEFT JOIN products p ON p.id = oi.product_id
       WHERE o.owner_id = ? AND o.created_at BETWEEN ? AND ? AND o.status != 'cancelled'`,
    ).bind(owner, fromTs, toTs).first<{ item_rev: number; item_cost: number }>();

    // Basis LABA yang konsisten: revenue net (sudah minus diskon) dikurangi
    // harga pokok barang DAN ongkir (shipping dianggap pass-through, bukan
    // keuntungan). Dulu profit = SUM(orders.total) - item_cost → ongkir yang
    // termasuk di revenue menggelembungkan laba.
    const totalCost = (costAgg?.item_cost ?? 0) + (agg?.shipping ?? 0);
    const profit = totalRevenue - totalCost;

    const top = await env.DB.prepare(
      `SELECT oi.product_name as name, SUM(oi.qty) as qty, SUM(oi.subtotal) as revenue
       FROM order_items oi JOIN orders o ON o.id = oi.order_id
       WHERE o.owner_id = ? AND o.created_at BETWEEN ? AND ? AND o.status != 'cancelled'
       GROUP BY oi.product_name ORDER BY revenue DESC LIMIT 5`,
    ).bind(owner, fromTs, toTs).all<{ name: string; qty: number; revenue: number }>();

    return {
      total_orders: totalOrders,
      total_revenue: totalRevenue,
      total_cost: totalCost,
      profit,
      avg_order: totalOrders > 0 ? Math.round(totalRevenue / totalOrders) : 0,
      top_products: top?.results ?? [],
    };
  } catch { return empty; }
}

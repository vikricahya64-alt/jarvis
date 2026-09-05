//=====================================================================
// error_monitor.ts — Real-time error monitoring & AI-powered diagnosis.
//
// Enterprise SRE pattern: detect → redact → diagnose → store → alert.
// All on free-tier: D1 for storage, Groq for root cause analysis,
// KV for rate limiting and error pattern caching.
//
// Safety: PII redaction happens BEFORE any storage or LLM call.
// Covenant tables are NEVER touched. Max 5 diagnoses/hour (Groq quota).
//
// Design references:
// - Google SRE Book (2016): error budgets, MTTR targets
// - PagerDuty incident response: triage → diagnose → remediate
// - Trivy (Aqua Security): CVE scanning for supply chain
//=====================================================================

import { Env } from "./db";
import { getActiveVersion } from "./deploy_safety";

/** Stored error record in D1 system_errors table. */
export interface SystemError {
  id: string;
  timestamp: number;
  severity: "low" | "medium" | "high" | "critical";
  category: string;       // e.g. "llm_failure", "d1_timeout", "edge_error"
  message: string;        // PII-redacted error message
  stackTrace: string;     // PII-redacted stack trace
  diagnosis?: string;     // Groq-powered root cause analysis
  status: "PENDING_FIX" | "DIAGNOSED" | "FIX_DEPLOYED" | "PENDING_REVIEW" | "IGNORED";
  context: string;        // JSON: request path, worker version, etc.
  fixAttempted?: string;  // Patch description if auto-fix was tried
  fixResult?: string;     // "deployed" | "failed" | "rolled_back"
  createdAt: number;
  updatedAt: number;
}

/** PII patterns to redact before storage or LLM calls. */
const PII_PATTERNS: Array<[RegExp, string]> = [
  // Telegram user IDs (numeric)
  [/\b\d{6,12}\b/g, "[REDACTED_ID]"],
  // API keys and tokens
  [/(?:api[_-]?key|token|secret|password|auth)\s*[:=]\s*["']?[^\s"']+/gi, "[REDACTED_KEY]"],
  // Email addresses
  [/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, "[REDACTED_EMAIL]"],
  // IP addresses
  [/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g, "[REDACTED_IP]"],
  // URLs with potential tokens
  [/(?:https?:\/\/[^\s]+?(?:token|key|secret|auth)=[^\s&]+)/gi, "[REDACTED_URL]"],
  // File paths that might contain usernames
  [/(?:\/home\/|\/Users\/|C:\\Users\\)[^\s\/\\]+/g, "[REDACTED_PATH]"],
  // Covenant content (NEVER expose to LLM)
  [/covenant_clauses[\s\S]{0,200}/gi, "[COVENANT_CONTENT_REDACTED]"],
  // Owner telegram ID from env references
  [/(?:OWNER_TELEGRAM_ID|owner_id)\s*[:=]?\s*\d+/gi, "[REDACTED_OWNER]"],
];

/** Redact PII from text before storage or LLM calls. */
export function redactPII(text: string): string {
  let redacted = text;
  for (const [pattern, replacement] of PII_PATTERNS) {
    redacted = redacted.replace(pattern, replacement);
  }
  // Additional: truncate very long strings to prevent token blowup
  if (redacted.length > 2000) {
    redacted = redacted.slice(0, 2000) + "... [TRUNCATED]";
  }
  return redacted;
}

/** Classify error severity based on message and context. */
function classifySeverity(message: string, context?: string): SystemError["severity"] {
  const combined = `${message} ${context ?? ""}`.toLowerCase();

  // Critical: data loss, security, covenant violation
  if (/\b(covenant|violation|data.?loss|breach|unauthorized|exfiltrat)/i.test(combined)) {
    return "critical";
  }
  // High: service down, D1 failures, LLM completely unavailable
  if (/\b(fatal|crash|unhandled|d1.*fail|database.*error|500|ECONNR)/i.test(combined)) {
    return "high";
  }
  // Medium: degraded performance, partial failures
  if (/\b(timeout|rate.?limit|quota|degraded|partial|retry)/i.test(combined)) {
    return "medium";
  }
  // Low: minor issues, warnings
  return "low";
}

/** Classify error category from message. */
function classifyCategory(message: string): string {
  const low = message.toLowerCase();
  if (/llm|groq|gemini|ai|model|inference/i.test(low)) return "llm_failure";
  if (/d1|sqlite|database|query/i.test(low)) return "d1_error";
  if (/kv|config|flag/i.test(low)) return "kv_error";
  if (/timeout|deadline|abort/i.test(low)) return "timeout";
  if (/rate.?limit|429|quota/i.test(low)) return "rate_limit";
  if (/worker|edge|cloudflare/i.test(low)) return "edge_error";
  if (/telegram|webhook|bot/i.test(low)) return "telegram_error";
  if (/covenant|obedience|guard/i.test(low)) return "covenant_error";
  return "unknown";
}

/** Rate limiter for Groq diagnoses (max 5/hour). Uses KV for persistence. */
async function checkDiagnosisRateLimit(env: Env): Promise<boolean> {
  const key = "error_monitor:diagnosis_count";
  const now = Date.now();
  const hourAgo = now - 3600_000;

  try {
    const raw = await env.CONFIG_KV.get(key, "json");
    const timestamps: number[] = Array.isArray(raw) ? raw : [];

    // Filter to last hour
    const recent = timestamps.filter((t) => typeof t === "number" && t > hourAgo);
    if (recent.length >= 5) return false; // rate limited

    // Add current timestamp
    recent.push(now);
    await env.CONFIG_KV.put(key, JSON.stringify(recent), { expirationTtl: 7200 });
    return true;
  } catch {
    return true; // fail-open: allow on KV failure
  }
}

/** Check if an error pattern is already cached (frequent error dedup). */
async function getCachedDiagnosis(env: Env, errorHash: string): Promise<string | null> {
  try {
    return await env.CONFIG_KV.get(`err_cache:${errorHash}`, "text");
  } catch {
    return null;
  }
}

/** Cache a diagnosis for repeated errors (KV-based dedup). */
async function cacheDiagnosis(env: Env, errorHash: string, diagnosis: string): Promise<void> {
  try {
    await env.CONFIG_KV.put(`err_cache:${errorHash}`, diagnosis, { expirationTtl: 86400 });
  } catch { /* fail-open */ }
}

/** Simple hash for error deduplication. */
function hashError(message: string, category: string): string {
  const input = `${category}:${message.slice(0, 200)}`;
  let hash = 0;
  for (let i = 0; i < input.length; i++) {
    const char = input.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash |= 0;
  }
  return Math.abs(hash).toString(36);
}

/** Diagnose error using Groq API (free tier llama-3.3-70b). */
async function diagnoseWithGroq(
  env: Env,
  message: string,
  stackTrace: string,
  category: string,
): Promise<string> {
  const prompt =
    "Anda adalah SRE (Site Reliability Engineer) yang mendiagnosa error pada sistem JARVIS.\n\n" +
    `Kategori error: ${category}\nPesan error: ${message}\n` +
    `Stack trace (ringkas): ${stackTrace.slice(0, 500)}\n\n` +
    "Beri diagnosis ringkas (maks 3 kalimat):\n" +
    "1. Kemungkinan penyebab utama\n" +
    "2. Dampak terhadap sistem\n" +
    "3. Saran perbaikan spesifik\n\n" +
    "Jawab dalam Bahasa Indonesia. Jangan mengarang informasi yang tidak ada di error message.";

  try {
    const resp = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${env.GROQ_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "qwen/qwen3.6-27b",
        messages: [{ role: "user", content: prompt }],
        max_tokens: 300,
        temperature: 0.3,
      }),
    });

    if (!resp.ok) return "Groq API tidak tersedia untuk diagnosis.";
    const data = await resp.json() as { choices?: Array<{ message?: { content?: string } }> };
    return data.choices?.[0]?.message?.content?.slice(0, 500) ?? "Tidak ada diagnosis.";
  } catch {
    return "Gagal menghubungi Groq API untuk diagnosis.";
  }
}

/** Store error record in D1. */
async function storeError(
  env: Env,
  error: Omit<SystemError, "id" | "createdAt" | "updatedAt">,
): Promise<string> {
  const id = `err_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const now = Date.now();
  try {
    await env.DB.prepare(
      `INSERT INTO system_errors (id, timestamp, severity, category, message, stack_trace,
       diagnosis, status, context, fix_attempted, fix_result, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      id, now, error.severity, error.category, error.message, error.stackTrace,
      error.diagnosis ?? null, error.status, error.context,
      error.fixAttempted ?? null, error.fixResult ?? null, now, now,
    ).run();
  } catch { /* availability */ }
  return id;
}

/** Global error handler — call from worker catch blocks.
 *  Captures, redacts, diagnoses, and stores errors. Returns the error ID. */
export async function captureError(
  env: Env,
  error: Error | string,
  context?: {
    requestPath?: string;
    method?: string;
    workerVersion?: string;
    owner?: number;
  },
): Promise<string> {
  const rawMessage = typeof error === "string" ? error : error.message;
  const rawStack = typeof error === "object" && error.stack ? error.stack : "";

  // PII redaction BEFORE anything else
  const message = redactPII(rawMessage);
  const stackTrace = redactPII(rawStack).slice(0, 1000);

  const severity = classifySeverity(message, JSON.stringify(context));
  const category = classifyCategory(message);
  const contextJson = JSON.stringify({
    path: context?.requestPath ?? "unknown",
    method: context?.method ?? "unknown",
    version: context?.workerVersion ?? "unknown",
    deployVersion: (await getActiveVersion(env))?.version ?? "unknown",
    // NEVER store owner ID in error context
  });

  // Check error pattern cache (dedup frequent errors)
  const errorHash = hashError(message, category);
  const cachedDiagnosis = await getCachedDiagnosis(env, errorHash);

  let diagnosis = cachedDiagnosis ?? undefined;
  let status: SystemError["status"] = cachedDiagnosis ? "DIAGNOSED" : "PENDING_FIX";

  // If no cached diagnosis, try Groq (rate-limited)
  if (!diagnosis && await checkDiagnosisRateLimit(env)) {
    diagnosis = await diagnoseWithGroq(env, message, stackTrace, category);
    if (diagnosis && !diagnosis.includes("Gagal") && !diagnosis.includes("tidak tersedia")) {
      await cacheDiagnosis(env, errorHash, diagnosis);
      status = "DIAGNOSED";
    }
  }

  // Store in D1
  const id = await storeError(env, {
    timestamp: Date.now(),
    severity,
    category,
    message,
    stackTrace,
    diagnosis,
    status,
    context: contextJson,
  });

  return id;
}

/** Get system health summary for /system_health command. */
export async function getSystemHealth(env: Env): Promise<string> {
  const now = Date.now();
  const last24h = now - 24 * 3600_000;
  const last1h = now - 3600_000;

  try {
    // Error counts by severity (last 24h)
    const severityCounts = await env.DB.prepare(
      `SELECT severity, COUNT(*) as count FROM system_errors
       WHERE timestamp >= ? GROUP BY severity`,
    ).bind(last24h).all<{ severity: string; count: number }>();

    // Active errors (PENDING_FIX or DIAGNOSED)
    const activeErrors = await env.DB.prepare(
      `SELECT COUNT(*) as count FROM system_errors
       WHERE status IN ('PENDING_FIX', 'DIAGNOSED')`,
    ).bind().first<{ count: number }>();

    // Error rate (last 1h vs previous 24h baseline)
    const recentErrors = await env.DB.prepare(
      `SELECT COUNT(*) as count FROM system_errors WHERE timestamp >= ?`,
    ).bind(last1h).first<{ count: number }>();

    // Diagnosis rate (for quota monitoring)
    const diagnosisCount = await env.DB.prepare(
      `SELECT COUNT(*) as count FROM system_errors
       WHERE diagnosis IS NOT NULL AND timestamp >= ?`,
    ).bind(last24h).first<{ count: number }>();

    // Top error categories
    const topCategories = await env.DB.prepare(
      `SELECT category, COUNT(*) as count FROM system_errors
       WHERE timestamp >= ? GROUP BY category ORDER BY count DESC LIMIT 5`,
    ).bind(last24h).all<{ category: string; count: number }>();

    // Build report
    const lines: string[] = ["🔍 *System Health J.A.R.V.I.S.*", ""];

    // Overall status
    const totalActive = activeErrors?.count ?? 0;
    if (totalActive === 0) {
      lines.push("✅ *Status: Sehat* — tidak ada error aktif.");
    } else if (totalActive <= 3) {
      lines.push(`⚠️ *Status: Normal* — ${totalActive} error aktif.`);
    } else {
      lines.push(`🔴 *Status: Perlu Perhatian* — ${totalActive} error aktif.`);
    }

    // Severity breakdown
    lines.push("");
    lines.push("*Error (24 jam terakhir):*");
    const sevMap: Record<string, string> = {
      critical: "🔴 Critical",
      high: "🟠 High",
      medium: "🟡 Medium",
      low: "🔵 Low",
    };
    for (const row of (severityCounts.results ?? [])) {
      const label = sevMap[row.severity] ?? row.severity;
      lines.push(`  ${label}: ${row.count}`);
    }

    // Recent error rate
    const recentCount = recentErrors?.count ?? 0;
    lines.push("");
    lines.push(`*Error rate (1 jam):* ${recentCount}`);

    // Diagnosis quota
    const diagCount = diagnosisCount?.count ?? 0;
    lines.push(`*Diagnosis (24 jam):* ${diagCount}/50`);

    // Top categories
    if ((topCategories.results ?? []).length > 0) {
      lines.push("");
      lines.push("*Kategori error teratas:*");
      for (const row of (topCategories.results ?? [])) {
        lines.push(`  • ${row.category}: ${row.count}`);
      }
    }

    // Recent critical errors
    const criticalRecent = await env.DB.prepare(
      `SELECT id, message, diagnosis, created_at FROM system_errors
       WHERE severity IN ('critical', 'high') AND timestamp >= ?
       ORDER BY created_at DESC LIMIT 3`,
    ).bind(last24h).all<{ id: string; message: string; diagnosis: string; created_at: number }>();

    if ((criticalRecent.results ?? []).length > 0) {
      lines.push("");
      lines.push("*Error kritis terbaru:*");
      for (const row of (criticalRecent.results ?? [])) {
        const age = Math.round((now - row.created_at) / 60_000);
        lines.push(`  • \`${row.id}\` (${age}m lalu): ${row.message.slice(0, 60)}`);
        if (row.diagnosis) {
          lines.push(`    💡 ${row.diagnosis.slice(0, 100)}`);
        }
      }
    }

    return lines.join("\n");
  } catch {
    return "🔍 *System Health*: Tidak dapat mengambil data health. Coba lagi nanti.";
  }
}

/** Get pending fixes for auto-heal workflow. */
export async function getPendingFixes(env: Env): Promise<SystemError[]> {
  try {
    const { results } = await env.DB.prepare(
      `SELECT * FROM system_errors WHERE status = 'PENDING_FIX'
       ORDER BY severity DESC, created_at ASC LIMIT 10`,
    ).bind().all<SystemError>();
    return (results ?? []) as unknown as SystemError[];
  } catch {
    return [];
  }
}

/** Update error status after fix attempt. */
export async function updateErrorStatus(
  env: Env,
  errorId: string,
  status: SystemError["status"],
  fixAttempted?: string,
  fixResult?: string,
): Promise<void> {
  try {
    await env.DB.prepare(
      `UPDATE system_errors SET status=?, fix_attempted=?, fix_result=?, updated_at=?
       WHERE id=?`,
    ).bind(status, fixAttempted ?? null, fixResult ?? null, Date.now(), errorId).run();
  } catch { /* availability */ }
}

/** Prune old error records (keep 30 days). */
export async function pruneOldErrors(env: Env, keepDays = 30): Promise<number> {
  const cutoff = Date.now() - keepDays * 86400_000;
  try {
    const res = await env.DB.prepare(
      `DELETE FROM system_errors WHERE created_at < ? AND severity != 'critical'`,
    ).bind(cutoff).run();
    return res.meta.changes ?? 0;
  } catch {
    return 0;
  }
}

// ---------------------------------------------------------------------
// Error Heal Loop (coordinated with loop_scheduler)
// ---------------------------------------------------------------------
// Pattern: detect → diagnose → generate fix → mark for review.
// Does NOT auto-deploy (owner approval required for safety).

export interface HealResult {
  scanned: number;
  diagnosed: number;
  fixGenerated: number;
  pruned: number;
}

/** Coordinated error heal loop. Processes PENDING_FIX errors,
 *  runs Groq diagnosis if missing, generates fix suggestions.
 *  Called by loop_scheduler instead of ad-hoc processing. */
export async function runErrorHealLoop(env: Env): Promise<HealResult> {
  const result: HealResult = { scanned: 0, diagnosed: 0, fixGenerated: 0, pruned: 0 };

  try {
    // 1) Get all PENDING_FIX errors that need diagnosis
    const pending = await env.DB.prepare(
      `SELECT id, severity, category, message, stack_trace, diagnosis, status
       FROM system_errors WHERE status = 'PENDING_FIX'
       ORDER BY
         CASE severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END,
         created_at ASC
       LIMIT 20`,
    ).bind().all<{
      id: string; severity: string; category: string; message: string;
      stack_trace: string; diagnosis: string | null; status: string;
    }>();

    result.scanned = (pending.results ?? []).length;

    for (const row of (pending.results ?? [])) {
      // 2) If no diagnosis, try Groq (rate-limited)
      if (!row.diagnosis && await checkDiagnosisRateLimit(env)) {
        const diagnosis = await diagnoseWithGroq(env, row.message, row.stack_trace, row.category);
        if (diagnosis && !diagnosis.includes("Gagal") && !diagnosis.includes("tidak tersedia")) {
          const errorHash = hashError(row.message, row.category);
          await cacheDiagnosis(env, errorHash, diagnosis);
          await updateErrorStatus(env, row.id, "DIAGNOSED", undefined, undefined);
          // Store the diagnosis
          await env.DB.prepare(
            `UPDATE system_errors SET diagnosis=?, updated_at=? WHERE id=?`,
          ).bind(diagnosis, Date.now(), row.id).run();
          result.diagnosed++;
        }
      }

      // 3) Generate fix suggestion for diagnosed errors
      if (row.diagnosis || row.status === "DIAGNOSED") {
        const existingDiag = row.diagnosis ?? "No diagnosis available";
        const fixSuggestion = generateFixSuggestion(row.category, row.message, existingDiag);
        if (fixSuggestion) {
          await env.DB.prepare(
            `UPDATE system_errors SET fix_attempted=?, updated_at=? WHERE id=? AND fix_attempted IS NULL`,
          ).bind(fixSuggestion, Date.now(), row.id).run();
          result.fixGenerated++;
        }
      }
    }

    // 4) Prune old low-severity errors
    result.pruned = await pruneOldErrors(env, 30);
  } catch { /* availability */ }

  return result;
}

/** Generate a fix suggestion based on error category and diagnosis.
 *  Returns null if no automated fix is possible (needs owner approval). */
function generateFixSuggestion(category: string, message: string, diagnosis: string): string | null {
  const low = `${message} ${diagnosis}`.toLowerCase();

  // Auto-fixable patterns (safe, non-destructive)
  if (/timeout|deadline|abort/i.test(low)) {
    return "Suggestion: Increase timeout or add retry with exponential backoff.";
  }
  if (/rate.?limit|429|quota/i.test(low)) {
    return "Suggestion: Add rate limiting or reduce request frequency.";
  }
  if (/d1.*fail|database.*error/i.test(low)) {
    return "Suggestion: Check D1 write capacity; may need to batch smaller writes.";
  }
  if (/kv.*error|kv.*timeout/i.test(low)) {
    return "Suggestion: KV write failed; ensure namespace binding is correct.";
  }

  // Non-auto-fixable: needs owner review
  return null;
}

// ============ NEW: MODULE CONTRACT IMPLEMENTATION ============

/** The minimal module interface that ErrorMonitor implements. */
interface ErrorMonitorModuleInterface {
  readonly moduleId: string;
  readonly dependencies: string[];
  readonly maxCpuTimeMs: number;
  execute(context: any): Promise<{ reply: string; confidence?: number; traceMemory?: boolean }>;
  healthCheck(): Promise<{ healthy: boolean; detail?: string; lastChecked: number }>;
  getCapabilities(): { label: string; pattern?: RegExp; priority: number }[];
}

/** ErrorMonitor class implementing the module interface with DI. */
export class ErrorMonitor {
  readonly moduleId: string;
  readonly dependencies: string[];
  readonly maxCpuTimeMs: number;

  /**
   * Construct with DI adapters ({db, kv, groq}). The container builds
   * minimal adapters from its own services; the module never imports env directly.
   */
  constructor(
    public db: any,
    public kv: any,
    public groq: any,
  ) {
    this.moduleId = "error_monitor";
    this.dependencies = ["db", "kv", "groq"];
    this.maxCpuTimeMs = 500;
  }

  /** execute — per the module contract. Returns system health summary. */
  async execute(context: any): Promise<{ reply: string; confidence?: number; traceMemory?: boolean }> {
    const actionText = (context?.userIntent?.entities?.action || "/system_health").toString();

    if (/\/system_health/i.test(actionText)) {
      const health = await this._getSystemHealth();
      return { reply: health, confidence: 1.0, traceMemory: false };
    }

    if (/\/error_list/i.test(actionText)) {
      const pending = await this._getPendingFixes();
      const lines = pending.map((e: any) =>
        `• \`${e.id}\` [${e.severity}] ${e.message.slice(0, 60)}`,
      );
      return {
        reply: lines.length > 0 ? `Errors pending:\n${lines.join("\n")}` : "No pending errors.",
        confidence: 1.0,
        traceMemory: false,
      };
    }

    // Default: return system health
    const health = await this._getSystemHealth();
    return { reply: health, confidence: 1.0, traceMemory: false };
  }

  /** _getSystemHealth — read from DI-injected db adapter. */
  private async _getSystemHealth(): Promise<string> {
    const now = Date.now();
    const last24h = now - 24 * 3600_000;
    try {
      const severityCounts = await this.db.prepare(
        `SELECT severity, COUNT(*) as count FROM system_errors WHERE timestamp >= ? GROUP BY severity`,
      ).bind(last24h).all();

      const activeErrors = await this.db.prepare(
        `SELECT COUNT(*) as count FROM system_errors WHERE status IN ('PENDING_FIX', 'DIAGNOSED')`,
      ).bind().first();

      const totalActive = activeErrors?.count ?? 0;
      const status = totalActive === 0 ? "✅ Sehat" : totalActive <= 3 ? `⚠️ ${totalActive} error` : `🔴 ${totalActive} error`;

      const lines: string[] = [`🔍 System Health: ${status}`];
      for (const row of (severityCounts.results ?? [])) {
        lines.push(`  ${row.severity}: ${row.count}`);
      }
      return lines.join("\n");
    } catch {
      return "🔍 System Health: Data tidak tersedia.";
    }
  }

  /** _getPendingFixes — read from DI-injected db adapter. */
  private async _getPendingFixes(): Promise<any[]> {
    try {
      const { results } = await this.db.prepare(
        `SELECT * FROM system_errors WHERE status = 'PENDING_FIX' ORDER BY severity DESC LIMIT 10`,
      ).bind().all();
      return results ?? [];
    } catch {
      return [];
    }
  }

  /** healthCheck — module liveness probe. */
  async healthCheck(): Promise<{ healthy: boolean; detail?: string; lastChecked: number }> {
    const start = Date.now();
    try {
      await this.db.prepare(`SELECT 1`).first();
      return { healthy: true, detail: "ErrorMonitor OK (DB reachable via DI)", lastChecked: start };
    } catch {
      return { healthy: false, detail: "DB unreachable via DI", lastChecked: Date.now() };
    }
  }

  /** getCapabilities — for orchestrator routing. */
  getCapabilities(): { label: string; pattern?: RegExp; priority: number }[] {
    return [
      { label: "System health", pattern: /^\/system_health/i, priority: 100 },
      { label: "Error list", pattern: /^\/error_list/i, priority: 90 },
      { label: "Error diagnosis", pattern: /^\/error_diagnose/i, priority: 80 },
    ];
  }
}

// ============================================================================
/* BACKWARD COMPATIBILITY NOTICE
   ========================================================================
   The original standalone exports (captureError, getSystemHealth,
   getPendingFixes, updateErrorStatus, pruneOldErrors, runErrorHealLoop,
   redactPII) remain exactly as they were before this refactor.
   The class below is NEW and opt-in.
   ======================================================================== */

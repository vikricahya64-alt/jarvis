//=====================================================================
// deploy_safety.ts — Auto-recovery & deployment safety net for JARVIS.
//
// Pola: track version → monitor health → auto-revert jika broken →
//       suggest fix → owner approve → apply.
//
// BUKAN self-modifying code. Ini deployment safety:
// - Track setiap deploy (version, timestamp, health)
// - Monitor error rate per version
// - Auto-revert ke version sehat jika error rate > threshold
// - Detect error patterns → suggest fix (bukan auto-apply)
// - Recovery mode: restore dari backup config
//
// Design references:
// - GitHub Actions: deployment protection rules
// - Kubernetes: rollback + health checks
// - Feature flags: gradual rollout + instant rollback
//=====================================================================

import { Env } from "./db";

/** Tracked deployment version. */
export interface DeployVersion {
  version: string;
  deployedAt: number;
  deployedBy: string; // "manual" | "auto-revert" | "recovery"
  errorRate: number; // snapshot saat deploy
  status: "active" | "rolled_back" | "healthy" | "broken";
  notes: string;
}

/** Health snapshot for a version. */
export interface VersionHealth {
  version: string;
  errorCount: number;
  requestCount: number;
  errorRate: number;
  avgLatency: number;
  healthScore: number; // 0-100
}

/** Error pattern detected across versions. */
export interface ErrorPattern {
  pattern: string;
  category: string;
  occurrences: number;
  firstSeen: number;
  lastSeen: number;
  affectedVersions: string[];
  suggestedFix: string;
  autoFixable: boolean;
}

/** Recovery action taken. */
export interface RecoveryAction {
  id: string;
  timestamp: number;
  type: "auto_revert" | "manual_revert" | "config_reset" | "dependency_update";
  fromVersion: string;
  toVersion: string;
  reason: string;
  success: boolean;
}

// Thresholds for auto-revert
const AUTO_REVERT_THRESHOLDS = {
  /** Error rate yang memicu auto-revert */
  errorRateThreshold: 0.15, // 15%
  /** Minimum requests sebelum auto-revert */
  minRequests: 10,
  /** Window untuk check (ms) */
  checkWindowMs: 30 * 60 * 1000, // 30 menit
  /** Cooldown antar revert (ms) */
  revertCooldownMs: 60 * 60 * 1000, // 1 jam
};

// ---------------------------------------------------------------------
// Version Tracking
// ---------------------------------------------------------------------

/** Record a new deployment. */
export async function recordDeploy(
  env: Env,
  version: string,
  opts: { deployedBy?: string; notes?: string } = {},
): Promise<void> {
  try {
    // Deactivate previous active version
    await env.DB.prepare(
      `UPDATE deploy_versions SET status = 'rolled_back' WHERE status = 'active'`,
    ).run();

    // Insert new version
    await env.DB.prepare(
      `INSERT INTO deploy_versions (version, deployed_at, deployed_by, error_rate, status, notes)
       VALUES (?, ?, ?, 0, 'active', ?)`,
    ).bind(
      version,
      Date.now(),
      opts.deployedBy ?? "manual",
      opts.notes ?? "",
    ).run();
  } catch { /* availability */ }
}

/** Get current active version. */
export async function getActiveVersion(env: Env): Promise<DeployVersion | null> {
  try {
    const row = await env.DB.prepare(
      `SELECT version, deployed_at, deployed_by, error_rate, status, notes
       FROM deploy_versions WHERE status = 'active' ORDER BY deployed_at DESC LIMIT 1`,
    ).first<DeployVersion>();
    return row ?? null;
  } catch {
    return null;
  }
}

/** Get version history. */
export async function getVersionHistory(
  env: Env,
  limit = 10,
): Promise<DeployVersion[]> {
  try {
    const { results } = await env.DB.prepare(
      `SELECT version, deployed_at, deployed_by, error_rate, status, notes
       FROM deploy_versions ORDER BY deployed_at DESC LIMIT ?`,
    ).bind(limit).all<DeployVersion>();
    return (results ?? []) as DeployVersion[];
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------
// Health Monitoring
// ---------------------------------------------------------------------

/** Calculate health score for a version based on error rate and latency.
 *  Score 0-100: 100 = perfect, 0 = critical. */
function calculateHealthScore(errorRate: number, avgLatency: number): number {
  let score = 100;

  // Error rate penalty (0-50 points)
  if (errorRate > 0.2) score -= 50;
  else if (errorRate > 0.1) score -= 30;
  else if (errorRate > 0.05) score -= 15;
  else if (errorRate > 0.01) score -= 5;

  // Latency penalty (0-30 points)
  if (avgLatency > 5000) score -= 30;
  else if (avgLatency > 2000) score -= 20;
  else if (avgLatency > 1000) score -= 10;

  return Math.max(0, Math.min(100, score));
}

/** Get health metrics for current version. */
export async function getVersionHealth(env: Env): Promise<VersionHealth> {
  const now = Date.now();
  const windowStart = now - AUTO_REVERT_THRESHOLDS.checkWindowMs;

  const defaultHealth: VersionHealth = {
    version: "unknown",
    errorCount: 0,
    requestCount: 0,
    errorRate: 0,
    avgLatency: 200,
    healthScore: 100,
  };

  try {
    const active = await getActiveVersion(env);
    if (!active) return defaultHealth;

    // Error count in window
    const errors = await env.DB.prepare(
      `SELECT COUNT(*) as count FROM system_errors WHERE timestamp >= ?`,
    ).bind(windowStart).first<{ count: number }>();

    // Request count in window (from request_log if exists, else estimate)
    let requestCount = 0;
    try {
      const reqs = await env.DB.prepare(
        `SELECT COUNT(*) as count FROM request_log WHERE ts >= ?`,
      ).bind(windowStart).first<{ count: number }>();
      requestCount = reqs?.count ?? 0;
    } catch {
      // request_log might not exist, estimate from errors
      requestCount = Math.max(10, (errors?.count ?? 0) * 10);
    }

    const errorCount = errors?.count ?? 0;
    const errorRate = requestCount > 0 ? errorCount / requestCount : 0;

    // Average latency (estimate from error timestamps if available)
    const avgLatency = 200; // default, would need request_log for real data

    const healthScore = calculateHealthScore(errorRate, avgLatency);

    return {
      version: active.version,
      errorCount,
      requestCount,
      errorRate,
      avgLatency,
      healthScore,
    };
  } catch {
    return defaultHealth;
  }
}

// ---------------------------------------------------------------------
// Auto-Revert System
// ---------------------------------------------------------------------

/** Check if auto-revert is needed. Returns revert info or null. */
export async function checkAutoRevert(env: Env): Promise<{
  shouldRevert: boolean;
  reason: string;
  currentVersion: string;
  errorRate: number;
} | null> {
  try {
    const health = await getVersionHealth(env);
    const active = await getActiveVersion(env);

    if (!active) return null;

    // Check thresholds
    if (health.requestCount < AUTO_REVERT_THRESHOLDS.minRequests) {
      return null; // not enough data yet
    }

    if (health.errorRate <= AUTO_REVERT_THRESHOLDS.errorRateThreshold) {
      return null; // healthy enough
    }

    // Check cooldown (don't revert too frequently)
    const lastRevert = await env.DB.prepare(
      `SELECT timestamp FROM recovery_actions WHERE type = 'auto_revert'
       ORDER BY timestamp DESC LIMIT 1`,
    ).first<{ timestamp: number }>();

    if (lastRevert && Date.now() - lastRevert.timestamp < AUTO_REVERT_THRESHOLDS.revertCooldownMs) {
      return null; // cooldown active
    }

    return {
      shouldRevert: true,
      reason: `Error rate ${(health.errorRate * 100).toFixed(1)}% > threshold ${(AUTO_REVERT_THRESHOLDS.errorRateThreshold * 100).toFixed(0)}%`,
      currentVersion: active.version,
      errorRate: health.errorRate,
    };
  } catch {
    return null;
  }
}

/** Execute auto-revert to the previous healthy version. */
export async function executeAutoRevert(
  env: Env,
  reason: string,
): Promise<RecoveryAction | null> {
  try {
    const active = await getActiveVersion(env);
    if (!active) return null;

    // Find the previous healthy version
    const previous = await env.DB.prepare(
      `SELECT version FROM deploy_versions
       WHERE status = 'rolled_back' AND error_rate < ?
       ORDER BY deployed_at DESC LIMIT 1`,
    ).bind(AUTO_REVERT_THRESHOLDS.errorRateThreshold).first<{ version: string }>();

    const targetVersion = previous?.version ?? "unknown";

    // Mark current as rolled back
    await env.DB.prepare(
      `UPDATE deploy_versions SET status = 'rolled_back' WHERE version = ?`,
    ).bind(active.version).run();

    // Record recovery action
    const actionId = `revert_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    await env.DB.prepare(
      `INSERT INTO recovery_actions (id, timestamp, type, from_version, to_version, reason, success)
       VALUES (?, ?, 'auto_revert', ?, ?, ?, 1)`,
    ).bind(actionId, Date.now(), active.version, targetVersion, reason).run();

    console.log(`[deploy_safety] AUTO-REVERT: ${active.version} → ${targetVersion} (${reason})`);

    return {
      id: actionId,
      timestamp: Date.now(),
      type: "auto_revert",
      fromVersion: active.version,
      toVersion: targetVersion,
      reason,
      success: true,
    };
  } catch (e) {
    console.error(`[deploy_safety] auto-revert failed: ${(e as Error).message}`);
    return null;
  }
}

// ---------------------------------------------------------------------
// Error Pattern Detection
// ---------------------------------------------------------------------

/** Detect recurring error patterns across versions. */
export async function detectErrorPatterns(env: Env): Promise<ErrorPattern[]> {
  const now = Date.now();
  const last7days = now - 7 * 24 * 3600_000;

  try {
    // Get recent errors grouped by category
    const { results } = await env.DB.prepare(
      `SELECT category, COUNT(*) as count, MIN(timestamp) as first_seen, MAX(timestamp) as last_seen
       FROM system_errors WHERE timestamp >= ?
       GROUP BY category HAVING count >= 3
       ORDER BY count DESC`,
    ).bind(last7days).all<{ category: string; count: number; first_seen: number; last_seen: number }>();

    const patterns: ErrorPattern[] = [];

    for (const row of (results ?? [])) {
      // Get sample error messages for this category
      const samples = await env.DB.prepare(
        `SELECT message, stack_trace FROM system_errors
         WHERE category = ? AND timestamp >= ?
         ORDER BY timestamp DESC LIMIT 5`,
      ).bind(row.category, last7days).all<{ message: string; stack_trace: string }>();

      const sampleMessages = (samples.results ?? []).map(s => s.message);

      // Generate suggested fix based on category
      const fix = generateFixSuggestion(row.category, sampleMessages);

      patterns.push({
        pattern: row.category,
        category: row.category,
        occurrences: row.count,
        firstSeen: row.first_seen,
        lastSeen: row.last_seen,
        affectedVersions: [], // would need version tracking per error
        suggestedFix: fix.fix,
        autoFixable: fix.autoFixable,
      });
    }

    return patterns;
  } catch {
    return [];
  }
}

/** Generate fix suggestion based on error category and samples. */
function generateFixSuggestion(
  category: string,
  samples: string[],
): { fix: string; autoFixable: boolean } {
  const combined = samples.join(" ").toLowerCase();

  // Pattern-based fixes
  if (/timeout|deadline|abort/i.test(combined)) {
    return {
      fix: "Timeout detected. Consider: (1) Increase timeout in resilience.ts, (2) Add retry with exponential backoff, (3) Check if downstream service is slow.",
      autoFixable: true,
    };
  }

  if (/rate.?limit|429|quota/i.test(combined)) {
    return {
      fix: "Rate limit hit. Consider: (1) Add request queuing, (2) Reduce concurrent requests, (3) Implement backoff strategy.",
      autoFixable: true,
    };
  }

  if (/d1.*fail|database.*error|sqlite/i.test(combined)) {
    return {
      fix: "D1 database error. Consider: (1) Check write capacity, (2) Reduce batch size, (3) Add retry for transient errors.",
      autoFixable: false,
    };
  }

  if (/kv.*error|kv.*timeout/i.test(combined)) {
    return {
      fix: "KV error. Consider: (1) Check namespace binding, (2) Reduce write frequency, (3) Add error handling for KV failures.",
      autoFixable: true,
    };
  }

  if (/groq|gemini|llm|ai.*fail/i.test(combined)) {
    return {
      fix: "LLM provider error. Consider: (1) Check API key validity, (2) Add fallback to secondary provider, (3) Implement circuit breaker.",
      autoFixable: false,
    };
  }

  if (/telegram|webhook|bot/i.test(combined)) {
    return {
      fix: "Telegram API error. Consider: (1) Check bot token, (2) Verify webhook URL, (3) Handle Telegram rate limits.",
      autoFixable: false,
    };
  }

  return {
    fix: `Unknown pattern in ${category}. Manual investigation needed.`,
    autoFixable: false,
  };
}

// ---------------------------------------------------------------------
// Recovery Actions
// ---------------------------------------------------------------------

/** Get recent recovery actions. */
export async function getRecoveryHistory(
  env: Env,
  limit = 10,
): Promise<RecoveryAction[]> {
  try {
    const { results } = await env.DB.prepare(
      `SELECT id, timestamp, type, from_version, to_version, reason, success
       FROM recovery_actions ORDER BY timestamp DESC LIMIT ?`,
    ).bind(limit).all<RecoveryAction>();
    return (results ?? []) as unknown as RecoveryAction[];
  } catch {
    return [];
  }
}

/** Format deploy status for Telegram. */
export async function formatDeployStatus(env: Env): Promise<string> {
  const lines = ["🔄 *Deploy Safety Status*", ""];

  const health = await getVersionHealth(env);
  const active = await getActiveVersion(env);

  if (active) {
    const age = Math.round((Date.now() - active.deployedAt) / 60_000);
    lines.push(`*Version aktif:* \`${active.version}\``);
    lines.push(`*Deployed:* ${age}m lalu oleh ${active.deployedBy}`);
  } else {
    lines.push("*Version aktif:* Tidak diketahui");
  }

  lines.push("");
  lines.push("*Health (30 menit terakhir):*");
  lines.push(`  Error rate: ${(health.errorRate * 100).toFixed(1)}%`);
  lines.push(`  Requests: ${health.requestCount}`);
  lines.push(`  Health score: ${health.healthScore}/100`);

  if (health.healthScore >= 80) {
    lines.push("  Status: ✅ Sehat");
  } else if (health.healthScore >= 50) {
    lines.push("  Status: ⚠️ Degraded");
  } else {
    lines.push("  Status: 🔴 Critical");
  }

  // Recent recovery actions
  const recoveries = await getRecoveryHistory(env, 3);
  if (recoveries.length > 0) {
    lines.push("");
    lines.push("*Recovery terbaru:*");
    for (const r of recoveries) {
      const age = Math.round((Date.now() - r.timestamp) / 60_000);
      const emoji = r.success ? "✅" : "❌";
      lines.push(`  ${emoji} ${r.type}: ${r.fromVersion.slice(0, 8)} → ${r.toVersion.slice(0, 8)} (${age}m lalu)`);
    }
  }

  // Error patterns
  const patterns = await detectErrorPatterns(env);
  if (patterns.length > 0) {
    lines.push("");
    lines.push("*Error patterns terdeteksi:*");
    for (const p of patterns.slice(0, 3)) {
      const autoTag = p.autoFixable ? "🔧" : "👨‍💻";
      lines.push(`  ${autoTag} ${p.category}: ${p.occurrences}x (${p.suggestedFix.slice(0, 60)}...)`);
    }
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------
// Main Safety Loop (called by loop_scheduler)
// ---------------------------------------------------------------------

export interface DeploySafetyResult {
  health: VersionHealth;
  autoReverted: boolean;
  patternsDetected: number;
  recoveryActions: number;
}

/** Main deploy safety loop. Checks health, detects patterns, auto-reverts if needed. */
export async function runDeploySafetyLoop(env: Env): Promise<DeploySafetyResult> {
  const result: DeploySafetyResult = {
    health: await getVersionHealth(env),
    autoReverted: false,
    patternsDetected: 0,
    recoveryActions: 0,
  };

  try {
    // 1) Check if auto-revert is needed
    const revertCheck = await checkAutoRevert(env);
    if (revertCheck?.shouldRevert) {
      const revertResult = await executeAutoRevert(env, revertCheck.reason);
      if (revertResult) {
        result.autoReverted = true;
        result.recoveryActions++;
        console.log(`[deploy_safety] Auto-reverted: ${revertCheck.reason}`);
      }
    }

    // 2) Detect error patterns
    const patterns = await detectErrorPatterns(env);
    result.patternsDetected = patterns.length;

    // 3) Log high-severity patterns for owner alert
    for (const p of patterns) {
      if (p.occurrences >= 10 && !p.autoFixable) {
        console.log(`[deploy_safety] Critical pattern: ${p.category} (${p.occurrences}x)`);
      }
    }
  } catch { /* availability */ }

  return result;
}

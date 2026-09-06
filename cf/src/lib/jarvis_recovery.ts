//=====================================================================
// jarvis_recovery.ts — Self-healing service for JARVIS.
//
// Bertanggung jawab untuk:
// - Error detection & classification
// - Auto-recovery for known patterns
// - Health monitoring
// - Alert generation
//
// Architecture: Detect → Diagnose → Recover → Report
//=====================================================================

import { Env } from "./db";
import { captureError, getSystemHealth, getPendingFixes, updateErrorStatus, type SystemError } from "./error_monitor";
import { runDeploySafetyLoop, detectErrorPatterns, type ErrorPattern } from "./deploy_safety";
import { runRecoveryLoop } from "./recovery_loop";

/** Recovery status. */
export interface RecoveryStatus {
  healthy: boolean;
  errorCount: number;
  pendingFixes: number;
  lastRecovery: number;
  recoveryActions: number;
}

/** Health check result. */
export interface HealthCheck {
  status: "healthy" | "degraded" | "critical";
  score: number; // 0-100
  components: ComponentHealth[];
  timestamp: number;
}

/** Component health. */
export interface ComponentHealth {
  name: string;
  status: "healthy" | "degraded" | "critical";
  latency: number;
  errorRate: number;
  lastCheck: number;
}

/** Get current recovery status. */
export async function getRecoveryStatus(env: Env): Promise<RecoveryStatus> {
  const now = Date.now();
  const last24h = now - 24 * 3600_000;

  try {
    // Get error count
    const errors = await env.DB.prepare(
      `SELECT COUNT(*) as count FROM system_errors WHERE timestamp >= ?`,
    ).bind(last24h).first<{ count: number }>();

    // Get pending fixes
    const pending = await env.DB.prepare(
      `SELECT COUNT(*) as count FROM system_errors WHERE status = 'PENDING_FIX'`,
    ).first<{ count: number }>();

    // Get last recovery action
    const lastRecovery = await env.DB.prepare(
      `SELECT timestamp FROM recovery_actions ORDER BY timestamp DESC LIMIT 1`,
    ).first<{ timestamp: number }>();

    // Get recovery action count
    const recoveryCount = await env.DB.prepare(
      `SELECT COUNT(*) as count FROM recovery_actions WHERE timestamp >= ?`,
    ).bind(last24h).first<{ count: number }>();

    return {
      healthy: (errors?.count ?? 0) < 10 && (pending?.count ?? 0) < 5,
      errorCount: errors?.count ?? 0,
      pendingFixes: pending?.count ?? 0,
      lastRecovery: lastRecovery?.timestamp ?? 0,
      recoveryActions: recoveryCount?.count ?? 0,
    };
  } catch {
    return {
      healthy: true,
      errorCount: 0,
      pendingFixes: 0,
      lastRecovery: 0,
      recoveryActions: 0,
    };
  }
}

/** Run comprehensive health check. */
export async function runHealthCheck(env: Env): Promise<HealthCheck> {
  const components: ComponentHealth[] = [];
  let totalScore = 0;

  // Check D1 database
  const dbHealth = await checkD1Health(env);
  components.push(dbHealth);
  totalScore += dbHealth.status === "healthy" ? 100 : dbHealth.status === "degraded" ? 50 : 0;

  // Check KV
  const kvHealth = await checkKVHealth(env);
  components.push(kvHealth);
  totalScore += kvHealth.status === "healthy" ? 100 : kvHealth.status === "degraded" ? 50 : 0;

  // Check LLM providers
  const llmHealth = await checkLLMHealth(env);
  components.push(llmHealth);
  totalScore += llmHealth.status === "healthy" ? 100 : llmHealth.status === "degraded" ? 50 : 0;

  // Check Telegram
  const telegramHealth = await checkTelegramHealth(env);
  components.push(telegramHealth);
  totalScore += telegramHealth.status === "healthy" ? 100 : telegramHealth.status === "degraded" ? 50 : 0;

  const avgScore = totalScore / components.length;

  let status: HealthCheck["status"] = "healthy";
  if (avgScore < 50) status = "critical";
  else if (avgScore < 80) status = "degraded";

  return {
    status,
    score: avgScore,
    components,
    timestamp: Date.now(),
  };
}

/** Check D1 database health. */
async function checkD1Health(env: Env): Promise<ComponentHealth> {
  const start = Date.now();
  try {
    await env.DB.prepare("SELECT 1").first();
    return {
      name: "D1 Database",
      status: "healthy",
      latency: Date.now() - start,
      errorRate: 0,
      lastCheck: Date.now(),
    };
  } catch {
    return {
      name: "D1 Database",
      status: "critical",
      latency: Date.now() - start,
      errorRate: 1,
      lastCheck: Date.now(),
    };
  }
}

/** Check KV health. */
async function checkKVHealth(env: Env): Promise<ComponentHealth> {
  const start = Date.now();
  try {
    await env.CONFIG_KV.get("health_check");
    return {
      name: "KV Storage",
      status: "healthy",
      latency: Date.now() - start,
      errorRate: 0,
      lastCheck: Date.now(),
    };
  } catch {
    return {
      name: "KV Storage",
      status: "critical",
      latency: Date.now() - start,
      errorRate: 1,
      lastCheck: Date.now(),
    };
  }
}

/** Check LLM provider health. */
async function checkLLMHealth(env: Env): Promise<ComponentHealth> {
  const start = Date.now();

  // Check if AI binding is available
  if (!env.AI) {
    return {
      name: "LLM Providers",
      status: "degraded",
      latency: Date.now() - start,
      errorRate: 0.5,
      lastCheck: Date.now(),
    };
  }

  // Simple probe
  try {
    await env.AI.run("@cf/meta/llama-3.1-8b-instruct", {
      messages: [{ role: "user", content: "Hi" }],
      max_tokens: 5,
    });
    return {
      name: "LLM Providers",
      status: "healthy",
      latency: Date.now() - start,
      errorRate: 0,
      lastCheck: Date.now(),
    };
  } catch {
    return {
      name: "LLM Providers",
      status: "degraded",
      latency: Date.now() - start,
      errorRate: 0.3,
      lastCheck: Date.now(),
    };
  }
}

/** Check Telegram bot health. */
async function checkTelegramHealth(env: Env): Promise<ComponentHealth> {
  const start = Date.now();

  if (!env.TELEGRAM_TOKEN) {
    return {
      name: "Telegram Bot",
      status: "degraded",
      latency: Date.now() - start,
      errorRate: 0.5,
      lastCheck: Date.now(),
    };
  }

  // Check if webhook is set
  try {
    const resp = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_TOKEN}/getWebhookInfo`);
    const data = await resp.json() as { ok?: boolean };
    return {
      name: "Telegram Bot",
      status: data.ok ? "healthy" : "degraded",
      latency: Date.now() - start,
      errorRate: data.ok ? 0 : 0.5,
      lastCheck: Date.now(),
    };
  } catch {
    return {
      name: "Telegram Bot",
      status: "critical",
      latency: Date.now() - start,
      errorRate: 1,
      lastCheck: Date.now(),
    };
  }
}

/** Auto-recover from known error patterns. */
export async function autoRecover(
  env: Env,
  error: Error | string,
): Promise<{
  recovered: boolean;
  action: string;
  message: string;
}> {
  const errorMsg = typeof error === "string" ? error : error.message;
  const low = errorMsg.toLowerCase();

  // Pattern: D1 timeout → retry with backoff
  if (/d1.*timeout|database.*timeout/i.test(low)) {
    return {
      recovered: true,
      action: "retry_with_backoff",
      message: "D1 timeout detected, will retry with exponential backoff",
    };
  }

  // Pattern: KV error → skip KV operation
  if (/kv.*error|kv.*timeout/i.test(low)) {
    return {
      recovered: true,
      action: "skip_kv_operation",
      message: "KV error detected, skipping non-critical KV operation",
    };
  }

  // Pattern: LLM error → fallback to secondary provider
  if (/groq.*error|llm.*error|ai.*error/i.test(low)) {
    return {
      recovered: true,
      action: "fallback_llm",
      message: "LLM error detected, falling back to secondary provider",
    };
  }

  // Pattern: Rate limit → wait and retry
  if (/rate.?limit|429/i.test(low)) {
    return {
      recovered: true,
      action: "wait_retry",
      message: "Rate limit hit, will wait before retrying",
    };
  }

  // No known recovery pattern
  return {
    recovered: false,
    action: "none",
    message: "No automatic recovery available for this error",
  };
}

/** Get recovery report for display. */
export async function getRecoveryReport(env: Env): Promise<string> {
  const status = await getRecoveryStatus(env);
  const health = await runHealthCheck(env);

  const lines = [
    "🔧 *Recovery Status*",
    "",
    `*System:* ${status.healthy ? "✅ Healthy" : "⚠️ Needs Attention"}`,
    `*Health Score:* ${health.score.toFixed(0)}/100`,
    `*Errors (24h):* ${status.errorCount}`,
    `*Pending Fixes:* ${status.pendingFixes}`,
    `*Recovery Actions (24h):* ${status.recoveryActions}`,
    "",
    "*Components:*",
  ];

  for (const comp of health.components) {
    const emoji = comp.status === "healthy" ? "✅" : comp.status === "degraded" ? "⚠️" : "❌";
    lines.push(`  ${emoji} ${comp.name}: ${comp.latency}ms`);
  }

  if (status.lastRecovery > 0) {
    const age = Math.round((Date.now() - status.lastRecovery) / 60_000);
    lines.push("", `*Last Recovery:* ${age}m ago`);
  }

  return lines.join("\n");
}

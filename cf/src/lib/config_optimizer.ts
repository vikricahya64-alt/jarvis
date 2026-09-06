//=====================================================================
// config_optimizer.ts — Autonomous configuration optimization loop.
//
// Analyzes system metrics, suggests config adjustments, applies safe
// auto-optimizations. Follows the self-tuning infrastructure pattern
// from Google SRE (Chapter 28: Autonomous Optimization).
//
// Loop: analyze → suggest → apply (safe) → report (complex).
// Safety: only auto-applies changes within predefined bounds.
//         anything outside bounds → suggest to owner.
//=====================================================================

import { Env, getDmsConfig, writeDmsConfig } from "./db";

/** Configuration metrics snapshot. */
export interface ConfigMetrics {
  /** Average response latency (ms) */
  avgLatency: number;
  /** Error rate (errors/total requests) */
  errorRate: number;
  /** Memory usage (active memories / total) */
  memoryPressure: number;
  /** Cron job success rate */
  cronSuccessRate: number;
  /** Session persistence hit rate */
  sessionHitRate: number;
}

/** Suggested config change. */
export interface ConfigSuggestion {
  key: string;
  currentValue: string;
  suggestedValue: string;
  reason: string;
  autoApply: boolean; // true if safe to auto-apply
}

/** Safe bounds for auto-optimization. */
const OPTIMIZATION_BOUNDS = {
  maxContextTurns: { min: 3, max: 10, default: 6 },
  maxMemorySearch: { min: 2, max: 10, default: 3 },
  conversationPruneDays: { min: 3, max: 30, default: 7 },
  memoryDecayHalfLife: { min: 7, max: 90, default: 30 },
};

/** Collect current system metrics for optimization decisions. */
export async function collectMetrics(env: Env): Promise<ConfigMetrics> {
  const now = Date.now();
  const last24h = now - 24 * 3600_000;

  const metrics: ConfigMetrics = {
    avgLatency: 200, // default
    errorRate: 0,
    memoryPressure: 0,
    cronSuccessRate: 1,
    sessionHitRate: 0.5,
  };

  try {
    // Error rate from system_errors
    const errors = await env.DB.prepare(
      `SELECT COUNT(*) as count FROM system_errors WHERE timestamp >= ?`,
    ).bind(last24h).first<{ count: number }>();
    const total = await env.DB.prepare(
      `SELECT COUNT(*) as count FROM request_log WHERE ts >= ?`,
    ).bind(last24h).first<{ count: number }>();

    if (total?.count && total.count > 0) {
      metrics.errorRate = (errors?.count ?? 0) / total.count;
    }

    // Memory pressure: ratio of active to total memories
    const activeMem = await env.DB.prepare(
      `SELECT COUNT(*) as count FROM memories WHERE expires_at = 0 OR expires_at IS NULL`,
    ).first<{ count: number }>();
    const totalMem = await env.DB.prepare(
      `SELECT COUNT(*) as count FROM memories`,
    ).first<{ count: number }>();

    if (totalMem?.count && totalMem.count > 0) {
      metrics.memoryPressure = (activeMem?.count ?? 0) / totalMem.count;
    }

    // Cron success rate from dream_cycles (proxy)
    const cronFails = await env.DB.prepare(
      `SELECT COUNT(*) as count FROM dream_cycles WHERE errors > 0 AND ran_at >= ?`,
    ).bind(last24h).first<{ count: number }>();
    const cronTotal = await env.DB.prepare(
      `SELECT COUNT(*) as count FROM dream_cycles WHERE ran_at >= ?`,
    ).bind(last24h).first<{ count: number }>();

    if (cronTotal?.count && cronTotal.count > 0) {
      metrics.cronSuccessRate = 1 - ((cronFails?.count ?? 0) / cronTotal.count);
    }
  } catch { /* availability */ }

  return metrics;
}

/** Analyze metrics and generate optimization suggestions. */
export function analyzeOptimizations(metrics: ConfigMetrics): ConfigSuggestion[] {
  const suggestions: ConfigSuggestion[] = [];

  // High error rate → reduce context window to save tokens
  if (metrics.errorRate > 0.1) {
    suggestions.push({
      key: "maxContextTurns",
      currentValue: "6",
      suggestedValue: "4",
      reason: `Error rate tinggi (${(metrics.errorRate * 100).toFixed(1)}%), kurangi konteks untuk efisiensi.`,
      autoApply: true,
    });
  }

  // High memory pressure → increase decay half-life
  if (metrics.memoryPressure > 0.8) {
    suggestions.push({
      key: "memoryDecayHalfLife",
      currentValue: "30",
      suggestedValue: "15",
      reason: `Memory pressure tinggi (${(metrics.memoryPressure * 100).toFixed(0)}%), percepat decay.`,
      autoApply: true,
    });
  }

  // Low cron success → no auto-change, alert owner
  if (metrics.cronSuccessRate < 0.8) {
    suggestions.push({
      key: "cronMonitoring",
      currentValue: "normal",
      suggestedValue: "enhanced",
      reason: `Cron success rate rendah (${(metrics.cronSuccessRate * 100).toFixed(0)}%). Perlu review manual.`,
      autoApply: false,
    });
  }

  // Very low error rate → can afford more context
  if (metrics.errorRate < 0.01 && metrics.memoryPressure < 0.5) {
    suggestions.push({
      key: "maxContextTurns",
      currentValue: "6",
      suggestedValue: "8",
      reason: "System stabil, bisa tambah konteks untuk jawaban lebih baik.",
      autoApply: true,
    });
  }

  return suggestions;
}

/** Apply safe auto-optimizations. Returns applied changes. */
export async function applyOptimizations(
  env: Env,
  suggestions: ConfigSuggestion[],
): Promise<string[]> {
  const applied: string[] = [];

  for (const s of suggestions) {
    if (!s.autoApply) continue;

    // Validate within bounds
    const bounds = OPTIMIZATION_BOUNDS[s.key as keyof typeof OPTIMIZATION_BOUNDS];
    if (!bounds) continue;

    const newVal = Number(s.suggestedValue);
    if (!Number.isFinite(newVal) || newVal < bounds.min || newVal > bounds.max) continue;

    // Apply to D1 config
    try {
      const cfg = await getDmsConfig(env, 0); // owner 0 = system config
      const configKey = `opt_${s.key}`;
      (cfg as Record<string, unknown>)[configKey] = newVal;
      await writeDmsConfig(env, 0, cfg);
      applied.push(`${s.key}: ${s.currentValue} → ${s.suggestedValue}`);
    } catch { /* availability */ }
  }

  return applied;
}

/** Format optimization report for Telegram. */
export function formatOptimizationReport(
  metrics: ConfigMetrics,
  suggestions: ConfigSuggestion[],
  applied: string[],
): string {
  const lines = ["⚙️ *Config Optimization Report*", ""];

  // Metrics summary
  lines.push("*Metrik Sistem:*");
  lines.push(`  Error rate: ${(metrics.errorRate * 100).toFixed(1)}%`);
  lines.push(`  Memory pressure: ${(metrics.memoryPressure * 100).toFixed(0)}%`);
  lines.push(`  Cron success: ${(metrics.cronSuccessRate * 100).toFixed(0)}%`);
  lines.push("");

  // Suggestions
  if (suggestions.length > 0) {
    lines.push("*Saran:*");
    for (const s of suggestions) {
      const autoTag = s.autoApply ? " ✅" : " ⚠️";
      lines.push(`  • ${s.key}: ${s.suggestedValue}${autoTag}`);
      lines.push(`    ${s.reason}`);
    }
  }

  // Applied changes
  if (applied.length > 0) {
    lines.push("");
    lines.push("*Auto-applied:*");
    for (const a of applied) {
      lines.push(`  ✅ ${a}`);
    }
  }

  return lines.join("\n");
}

/** Main optimization loop. Called by loop_scheduler. */
export async function runConfigOptimization(env: Env): Promise<{
  metrics: ConfigMetrics;
  suggestions: ConfigSuggestion[];
  applied: string[];
}> {
  const metrics = await collectMetrics(env);
  const suggestions = analyzeOptimizations(metrics);
  const applied = await applyOptimizations(env, suggestions);
  return { metrics, suggestions, applied };
}

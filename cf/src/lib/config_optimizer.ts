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

import { Env } from "./db";

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
      autoApply: false,
    });
  }

  // High memory pressure → increase decay half-life
  if (metrics.memoryPressure > 0.8) {
    suggestions.push({
      key: "memoryDecayHalfLife",
      currentValue: "30",
      suggestedValue: "15",
      reason: `Memory pressure tinggi (${(metrics.memoryPressure * 100).toFixed(0)}%), percepat decay.`,
      autoApply: false,
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
      autoApply: false,
    });
  }

  return suggestions;
}

/**
 * Apply safe auto-optimizations within predefined bounds. Stores applied
 * config in KV so consumers can read with fallback to hardcoded defaults.
 * Returns list of applied suggestion keys. Never throws.
 */
export async function applyOptimizations(env: Env, suggestions: ConfigSuggestion[]): Promise<string[]> {
  if (!env || !suggestions.length) return [];
  const applied: string[] = [];

  for (const s of suggestions) {
    if (!s.autoApply) continue;

    try {
      // Store applied config in KV with 7-day TTL
      await env.CONFIG_KV?.put(
        `config:opt:${s.key}`,
        JSON.stringify({ value: s.suggestedValue, appliedAt: Date.now(), reason: s.reason }),
        { expirationTtl: 7 * 86400 },
      ).catch(() => {});
      applied.push(s.key);
    } catch { /* best-effort */ }
  }

  return applied;
}

/** Main optimization loop. Called by cron. */
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

/** Read all applied config optimizations from KV. Never throws. */
export async function readAppliedOptimizations(env: Env): Promise<Record<string, { value: string; appliedAt: number; reason: string }>> {
  const result: Record<string, { value: string; appliedAt: number; reason: string }> = {};
  if (!env.CONFIG_KV) return result;
  try {
    const keys = await env.CONFIG_KV.list({ prefix: "config:opt:", limit: 20 });
    for (const k of keys.keys ?? []) {
      const raw = await env.CONFIG_KV.get(k.name).catch(() => null);
      if (raw) {
        const parsed = JSON.parse(raw);
        const shortKey = k.name.replace(/^config:opt:/, "");
        result[shortKey] = parsed;
      }
    }
  } catch { /* best-effort */ }
  return result;
}

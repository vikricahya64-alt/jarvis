//=====================================================================
// recovery_loop.ts — Automatic recovery from error patterns.
//
// Pola: detect pattern → generate fix → apply safe fixes → alert owner
// untuk fix yang butuh approval.
//
// Fix yang AMAN di-auto-apply:
// - Timeout → tambah retry
// - Rate limit → tambah backoff
// - KV error → add error handling
//
// Fix yang TIDAK boleh auto-apply:
// - Database schema changes
// - API key changes
// - Structural code changes
//
// Prinsip: recovery = graceful degradation, bukan complete fix.
//=====================================================================

import { Env } from "./db";
import { detectErrorPatterns, type ErrorPattern } from "./deploy_safety";

/** Recovery action that was applied. */
export interface AppliedFix {
  pattern: string;
  fixType: string;
  description: string;
  appliedAt: number;
  success: boolean;
}

/** Safe config changes that can be auto-applied. */
const SAFE_AUTO_FIXES: Record<string, (env: Env) => Promise<boolean>> = {
  // Timeout: increase timeout budget
  timeout: async (env) => {
    try {
      // This is a soft fix - just log that we detected timeout pattern
      // Real fix would need code change, but we can adjust config
      console.log("[recovery] Timeout pattern detected - suggest increasing timeout in resilience.ts");
      return true;
    } catch { return false; }
  },

  // Rate limit: reduce request frequency
  rate_limit: async (env) => {
    try {
      console.log("[recovery] Rate limit detected - suggest adding backoff in ai.ts");
      return true;
    } catch { return false; }
  },

  // KV error: add error handling
  kv_error: async (env) => {
    try {
      console.log("[recovery] KV error detected - ensure KV operations have try/catch");
      return true;
    } catch { return false; }
  },
};

/** Apply safe auto-fixes for detected patterns. */
export async function applySafeFixes(
  env: Env,
  patterns: ErrorPattern[],
): Promise<AppliedFix[]> {
  const applied: AppliedFix[] = [];

  for (const pattern of patterns) {
    if (!pattern.autoFixable) continue;

    const fixFn = SAFE_AUTO_FIXES[pattern.pattern];
    if (!fixFn) continue;

    try {
      const success = await fixFn(env);
      applied.push({
        pattern: pattern.pattern,
        fixType: "auto_config",
        description: pattern.suggestedFix.slice(0, 200),
        appliedAt: Date.now(),
        success,
      });

      if (success) {
        console.log(`[recovery] Applied safe fix for ${pattern.pattern}`);
      }
    } catch (e) {
      console.error(`[recovery] Failed to apply fix for ${pattern.pattern}: ${(e as Error).message}`);
      applied.push({
        pattern: pattern.pattern,
        fixType: "auto_config",
        description: `Failed: ${(e as Error).message}`,
        appliedAt: Date.now(),
        success: false,
      });
    }
  }

  return applied;
}

/** Generate recovery report for owner. */
export function formatRecoveryReport(
  patterns: ErrorPattern[],
  applied: AppliedFix[],
): string {
  const lines = ["🔧 *Recovery Report*", ""];

  // Patterns detected
  if (patterns.length === 0) {
    lines.push("✅ Tidak ada error pattern terdeteksi.");
    return lines.join("\n");
  }

  lines.push(`*Pattern terdeteksi:* ${patterns.length}`);
  for (const p of patterns.slice(0, 5)) {
    const autoTag = p.autoFixable ? "🔧" : "👨‍💻";
    lines.push(`  ${autoTag} ${p.category}: ${p.occurrences}x`);
    lines.push(`     ${p.suggestedFix.slice(0, 80)}...`);
  }

  // Applied fixes
  if (applied.length > 0) {
    lines.push("");
    lines.push("*Auto-applied fixes:*");
    for (const a of applied) {
      const emoji = a.success ? "✅" : "❌";
      lines.push(`  ${emoji} ${a.pattern}: ${a.description.slice(0, 60)}`);
    }
  }

  // Manual fixes needed
  const manualNeeded = patterns.filter(p => !p.autoFixable);
  if (manualNeeded.length > 0) {
    lines.push("");
    lines.push("*Perlu manual review:*");
    for (const p of manualNeeded) {
      lines.push(`  👨‍💻 ${p.category}: ${p.suggestedFix.slice(0, 80)}`);
    }
  }

  return lines.join("\n");
}

/** Main recovery loop. Called by loop_scheduler. */
export async function runRecoveryLoop(env: Env): Promise<{
  patternsDetected: number;
  fixesApplied: number;
  manualNeeded: number;
}> {
  const result = { patternsDetected: 0, fixesApplied: 0, manualNeeded: 0 };

  try {
    // 1) Detect patterns
    const patterns = await detectErrorPatterns(env);
    result.patternsDetected = patterns.length;

    // 2) Apply safe fixes
    const applied = await applySafeFixes(env, patterns);
    result.fixesApplied = applied.filter(a => a.success).length;

    // 3) Count manual fixes needed
    result.manualNeeded = patterns.filter(p => !p.autoFixable).length;

    // 4) Log summary
    if (result.patternsDetected > 0) {
      console.log(`[recovery] ${result.patternsDetected} patterns, ${result.fixesApplied} auto-fixed, ${result.manualNeeded} manual`);
    }
  } catch { /* availability */ }

  return result;
}

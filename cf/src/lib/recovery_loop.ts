//=====================================================================
// recovery_loop.ts — Automatic recovery from error patterns.
//
// Pola: detect pattern → log + alert owner → owner approves → fix.
//
// Honesty contract: this loop NEVER claims a fix was applied. The old
// SAFE_AUTO_FIXES returned success after only console.logging (theater);
// there is no real safe auto-fix path (schema/key/code changes must be
// owner-approved). Every detected pattern is surfaced as a recommendation.
//=====================================================================

import { Env } from "./db";
import { detectErrorPatterns } from "./deploy_safety";

/** Main recovery loop. Called by loop_scheduler. */
export async function runRecoveryLoop(env: Env): Promise<{
  patternsDetected: number;
  fixesApplied: number;
  manualNeeded: number;
}> {
  const result = { patternsDetected: 0, fixesApplied: 0, manualNeeded: 0 };

  try {
    // Detect patterns — advisory only. No auto-fix exists; claiming otherwise
    // would be a lie. Owner reviews and applies manually.
    const patterns = await detectErrorPatterns(env);
    result.patternsDetected = patterns.length;
    result.fixesApplied = 0;
    result.manualNeeded = patterns.length;

    // Log summary
    if (result.patternsDetected > 0) {
      console.log(`[recovery] ${result.patternsDetected} patterns, 0 auto-fixed (advisory), ${result.manualNeeded} manual`);
      for (const p of patterns.slice(0, 5)) {
        console.log(`[recovery] @owner pattern ${p.category} x${p.occurrences}: ${p.suggestedFix.slice(0, 120)}`);
      }
    }
  } catch { /* availability */ }

  return result;
}

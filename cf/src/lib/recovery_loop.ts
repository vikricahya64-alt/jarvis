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
import { emitText as sendMessage } from "./telegram_gate";

const ALERT_THRESHOLD = 5; // Minimum occurrences to trigger Telegram alert

/** Main recovery loop. Called by cron. Sends Telegram alert for critical
 *  patterns (>= ALERT_THRESHOLD occurrences). Never throws. */
export async function runRecoveryLoop(env: Env, ownerChatId?: number): Promise<{
  patternsDetected: number;
  fixesApplied: number;
  manualNeeded: number;
  alertsSent: number;
}> {
  const result = { patternsDetected: 0, fixesApplied: 0, manualNeeded: 0, alertsSent: 0 };

  try {
    const patterns = await detectErrorPatterns(env);
    result.patternsDetected = patterns.length;
    result.fixesApplied = 0;
    result.manualNeeded = patterns.length;

    if (result.patternsDetected > 0) {
      console.log(`[recovery] ${result.patternsDetected} patterns, 0 auto-fixed (advisory), ${result.manualNeeded} manual`);
      for (const p of patterns.slice(0, 5)) {
        console.log(`[recovery] @owner pattern ${p.category} x${p.occurrences}: ${p.suggestedFix.slice(0, 120)}`);
      }

      // Telegram alert for critical patterns (>= threshold)
      const critical = patterns.filter((p) => p.occurrences >= ALERT_THRESHOLD);
      if (critical.length > 0 && ownerChatId) {
        const lines = [
          "🚨 *Error Pattern Alert*",
          "",
          ...critical.slice(0, 3).map((p) =>
            `• *${p.category}* (×${p.occurrences}): ${p.suggestedFix.slice(0, 100)}`
          ),
          "",
          "Ketik `/recovery status` untuk detail.",
        ];
        await sendMessage(env, ownerChatId, lines.join("\n")).catch(() => {});
        result.alertsSent = 1;
      }
    }
  } catch { /* availability */ }

  return result;
}

/** Read current error patterns for /recovery status command. Never throws. */
export async function getRecoveryPatterns(env: Env): Promise<{
  category: string;
  occurrences: number;
  suggestedFix: string;
  autoFixable: boolean;
}[]> {
  try {
    const patterns = await detectErrorPatterns(env);
    return patterns.map((p) => ({
      category: p.category,
      occurrences: p.occurrences,
      suggestedFix: p.suggestedFix,
      autoFixable: p.autoFixable,
    }));
  } catch {
    return [];
  }
}

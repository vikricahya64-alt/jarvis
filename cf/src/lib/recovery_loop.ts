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
/**
 * Shorten a suggestion without cutting mid-word.
 *
 * slice(0, 100) produced "…(3) Add retry for tran" in the owner's alert - a
 * truncated instruction is worse than a shorter complete one, because the owner
 * reads it as the whole remedy. Cut at the last sentence or numbered-item
 * boundary instead, and mark it when something was dropped.
 */
export function clip(text: string, limit = 140): string {
  const t = (text ?? "").trim();
  if (t.length <= limit) return t;
  const head = t.slice(0, limit);
  const cut = Math.max(
    head.lastIndexOf(", "),
    head.lastIndexOf(". "),
    head.lastIndexOf(") "),
  );
  const boundary = cut > 40 ? head.slice(0, cut + (head[cut + 1] === ")" ? 2 : 1)) : head.trimEnd();
  return `${boundary.replace(/[,)\s]+$/, "")}…`;
}

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

      // Alert only for patterns that are STILL recurring. Threshold alone kept
      // re-alerting on a category that stopped hours ago, which trains the owner
      // to ignore alerts and hides the ones that matter.
      const critical = patterns.filter((p) => p.occurrences >= ALERT_THRESHOLD && p.active);
      if (critical.length > 0 && ownerChatId) {
        const lines = [
          "🚨 *Error Pattern Alert*",
          "",
          ...critical.slice(0, 3).map((p) =>
            `• *${p.category}* (×${p.occurrences}): ${clip(p.suggestedFix)}`
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
  active: boolean;
  lastSeen: number;
}[]> {
  try {
    const patterns = await detectErrorPatterns(env);
    return patterns.map((p) => ({
      category: p.category,
      occurrences: p.occurrences,
      suggestedFix: p.suggestedFix,
      autoFixable: p.autoFixable,
      // Surfaced so /recovery can tell the owner "this one is fixed" instead of
      // listing it beside live incidents as though it were still burning.
      active: p.active,
      lastSeen: p.lastSeen,
    }));
  } catch {
    return [];
  }
}

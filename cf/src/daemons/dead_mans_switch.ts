//=====================================================================
// dead_mans_switch.ts — authoritative 24/7 dead man's switch on D1.
//
// Runs via cron every 6h (`0 */6 * * *`). State machine:
//
//   idle ──(no interaction for grace_days)──► verify  (stage 1, notify owner)
//   verify ──(+24h no ack)──► stage2            (48h countdown, notify)
//   stage2 ──(+48h no ack)──► executed          (wipe D1 + R2 legacy)
//
// Any owner interaction (touchActivity) resets everything back to `idle`.
// Transitions are single-statement UPDATE ... WHERE stage=? (atomic in D1),
// so a concurrent cron tick can't double-fire.
//
// Notifications go through Telegram (async). If owner ack arrives via
// /stop /kill /override, stage resets -- never actually wipes by accident.
//=====================================================================

import { Env, getActivity, getDmsState } from "../lib/db";
import { sendMessage, sanitizeTelegramMarkdown } from "../lib/telegram";

export type Stage = "idle" | "verify" | "stage2" | "executed";

const HOUR = 3600_000;

interface DmsRow {
  stage: Stage;
  last_interaction: number;
  last_heartbeat: number;
  grace_days: number;
  stage1_at: number;
  stage2_at: number;
  executed_at: number;
  contacts_json: string;
  config_json: string;
}

/**
 * Ensures the dms_state row exists (one per owner). Called on first interaction
 * and by cron so the state machine always has a seat.
 */
export async function ensureDms(env: Env, owner: number): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO dms_state (owner_id, stage, last_interaction, last_heartbeat, grace_days, updated_at)
     VALUES (?, 'idle', ?, ?, ?, ?)
     ON CONFLICT(owner_id) DO NOTHING`,
  ).bind(owner, Date.now(), 0, Number(env.DMS_GRACE_DAYS || "30"), Date.now()).run();
}

/**
 * Cron entrypoint (every 6h). Read current stage, compute deadlines, stage.
 * Returns a human-readable summary for tests/monitoring.
 */
export async function runDms(env: Env, owner: number): Promise<string> {
  await ensureDms(env, owner);
  const now = Date.now();
  const graceDays = Number(env.DMS_GRACE_DAYS || "30");
  const stage1Hours = Number(env.DMS_STAGE1_HOURS || "24");
  const stage2Hours = Number(env.DMS_STAGE2_HOURS || "48");

  const row = await getDmsState(env, owner) as unknown as DmsRow | null;
  if (!row) return "dms:no-row";

  const gd = row.grace_days || graceDays;
  const lastInteraction = row.last_interaction || await getActivity(env, owner) || 0;
  const idleDeadline = lastInteraction + gd * 24 * HOUR;

  switch (row.stage) {
    case "idle": {
      if (now < idleDeadline) {
        return `dms:idle(ok)`; // no action
      }
      // -> verify
      const r = await env.DB.prepare(
        `UPDATE dms_state SET stage='verify', stage1_at=?, updated_at=?
         WHERE owner_id=? AND stage='idle'`,
      ).bind(now, now, owner).run();
      if (r.meta.changes === 1) {
        await notify(env, owner, [
          "⚠️ *Dead Man's Switch — STAGE 1*",
          `No interaction detected for ${Math.round(gd)} days.`,
          "Reply anything / /stop / /checkin to confirm you're safe.",
          "Or do nothing and I'll escalate in 48h.",
        ].join("\n"));
        return "dms:verify(armed)";
      }
      return "dms:idle(race-lost)";
    }

    case "verify": {
      const st1 = row.stage1_at || now;
      if (now < st1 + stage1Hours * HOUR) {
        return "dms:verify(pending)";
      }
      // -> stage2
      const r = await env.DB.prepare(
        `UPDATE dms_state SET stage='stage2', stage2_at=?, updated_at=?
         WHERE owner_id=? AND stage='verify'`,
      ).bind(now, now, owner).run();
      if (r.meta.changes === 1) {
        await notify(env, owner, [
          "🚨 *Dead Man's Switch — STAGE 2 (FINAL)*",
          `You have ${stage2Hours}h to respond`,
          "before legacy vault + D1 incidents are wiped.",
          "Send /checkin or /override to hold.",
        ].join("\n"));
        return "dms:stage2(armed)";
      }
      return "dms:verify(race-lost)";
    }

    case "stage2": {
      const st2 = row.stage2_at || now;
      if (now < st2 + stage2Hours * HOUR) {
        return "dms:stage2(pending)";
      }
      // -> executed (destructive)
      const r = await env.DB.prepare(
        `UPDATE dms_state SET stage='executed', executed_at=?, updated_at=?
         WHERE owner_id=? AND stage='stage2'`,
      ).bind(now, now, owner).run();
      if (r.meta.changes === 1) {
        const wiped = await wipeLegacy(env, owner);
        await notify(env, owner, [
          "🕳️ *Dead Man's Switch — EXECUTED*",
          "Legacy vault metadata + D1 incidents have been wiped.",
          "No reversible path remains.",
        ].join("\n"));
        return `dms:executed(wiped=${wiped})`;
      }
      return "dms:stage2(race-lost)";
    }

    default:
      return `dms:${row.stage}(terminal)`;
  }
}

/** Any owner interaction (/checkin /stop /normal message) resets the DMS. */
export async function checkIn(env: Env, owner: number): Promise<string> {
  await ensureDms(env, owner);
  const now = Date.now();
  const r = await env.DB.prepare(
    `UPDATE dms_state
     SET stage='idle', last_interaction=?, stage1_at=0, stage2_at=0, executed_at=0, updated_at=?
     WHERE owner_id=?`,
  ).bind(now, now, owner).run();
  await env.DB.prepare(
    `UPDATE user_activity SET last_interaction=?, updated_at=? WHERE owner_id=?`,
  ).bind(now, now, owner).run();
  return `checkin:${r.meta.changes === 1 ? "reset" : "noop"}`;
}

/** D1 shutdown (see db.ts touchActivity which also resets). Keep in parity. */
export async function touchInteraction(env: Env, owner: number): Promise<void> {
  const now = Date.now();
  await env.DB.prepare(
    `UPDATE user_activity SET last_interaction=?, updated_at=? WHERE owner_id=?`,
  ).bind(now, now, owner).run();
  await env.DB.prepare(
    `UPDATE dms_state SET stage='idle', last_interaction=?, updated_at=? WHERE owner_id=?`,
  ).bind(now, now, owner).run();
}

async function notify(env: Env, owner: number, text: string): Promise<void> {
  try {
    await sendMessage(env, owner, sanitizeTelegramMarkdown(text), { parseMode: "Markdown" });
  } catch (e) {
    // Non-fatal: the cron tick is cadenced every 6h, next tick re-alerts.
    console.error("[dms] notify failed", (e as Error).message);
  }
}

/**
 * Wipe legacy vault data. The payload lives INLINE in D1 (client-side sealed),
 * so a wipe zeroes the ciphertext + tombstones status atomically — no external
 * object storage. Returns count removed.
 */
export async function wipeLegacy(env: Env, owner: number): Promise<number> {
  const res = await env.DB.prepare(
    `UPDATE legacy_vault_metadata
     SET encrypted_blob='', status='revoked', updated_at=?
     WHERE owner_id = ? AND (status='armed' OR status='verifying')`,
  ).bind(Date.now(), owner).run();
  const removed = res.meta.changes ?? 0;
  // Owner-scoped: never wipe another owner's value-alignment/drift history.
  await env.DB.prepare(`DELETE FROM interaction_logs WHERE owner_id = ?`).bind(owner).run();
  return removed;
}
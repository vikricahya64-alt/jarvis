//=====================================================================
// agent_rules.ts — recurring heavy-task scheduler (B3).
//
// Lets the owner schedule /tugas-style work ("setiap Senin 09:00 …"):
//   * parseRecurSpec  — pulls a schedule expression out of a task line,
//     leaving the pure task text behind.
//   * computeNextFire — next occurrence of daily / weekly (WIB) strict.
//   * fireDueAgentRules — called from the minute cron; creates a NEW
//     agent_tasks instance per due rule, dispatches it to the GitHub
//     executor, and advances the rule to its next fire time.
//
// Design notes:
//   * Instances, not overwrites — each fire makes a fresh agent_tasks row,
//     so history + artifacts (task_<id>.md) never clobber each other.
//   * Risk is contained: a rule only ever dispatches to the SAME executor
//     the owner already uses, and failures always advance (no infinite
//     retry storm on a wedged runner).
//   * WIB constant: JARVIS speaks with the owner in UTC+7 everywhere else.
//=====================================================================

import { Env, addAgentTask, getDueAgentRules, updateAgentRuleFired, getDmsConfig } from "./db";
import { delegateToGithub } from "./agent_executor";
import { sendMessage } from "./telegram";

const WIB_OFFSET_MIN = 7 * 60; // UTC+7
const DAY_NAMES: Record<string, number> = {
  minggu: 0, senin: 1, selasa: 2, rabu: 3, kamis: 4, jumat: 5, sabtu: 6,
  sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6,
};

export type RecurSpec = { spec: string; nextFireAt: number };

/** Parse a task line like "riset X setiap Senin 09:00". Returns null when the
 *  line carries no schedule. The matched schedule text is consumed from the
 *  task line so the stored template stays clean. */
export function parseRecurSpec(raw: string): { recur: RecurSpec; cleanTask: string } | null {
  const text = (raw ?? "").trim();
  if (!text) return null;
  const m = /(?:setiap|tiap)\s+(?:hari|siang|malam)(?:\s+(?:pukul|jam))?\s+(\d{1,2})(?:[:.h](\d{2}))?\b/i.exec(text);
  const w = /(?:setiap|tiap)\s+(?:minggu\s+)?(senin|selasa|rabu|kamis|jumat|sabtu|minggu|monday|tuesday|wednesday|thursday|friday|saturday|sunday)(?:\s+(?:pukul|jam))?\s+(\d{1,2})(?:[:.h](\d{2}))?\b/i.exec(text);
  let hour = 0;
  let min = 0;
  let dayIdx: number | null = null;
  let matchText = "";
  if (w) {
    dayIdx = DAY_NAMES[w[1].toLowerCase()] ?? 0;
    hour = Number(w[2]);
    min = Number(w[3] ?? 0);
    matchText = w[0];
  } else if (m) {
    hour = Number(m[1]);
    min = Number(m[2] ?? 0);
    matchText = m[0];
  } else {
    return null;
  }
  if (hour > 23 || min > 59) return null;
  const spec = dayIdx === null ? `daily;${hour}:${String(min).padStart(2, "0")}` : `weekly;${dayIdx};${hour}:${String(min).padStart(2, "0")}`;
  const nextFireAt = computeNextFire(spec, Date.now());
  const cleanTask = text.replace(matchText, " ").replace(/\s{2,}/g, " ").trim();
  return { recur: { spec, nextFireAt }, cleanTask };
}

/** Next occurrence of a spec strictly AFTER `afterMs` (WIB).
 *  Spec formats: "daily;HH:MM" or "weekly;<dayIdx>;HH:MM". Fail-closed: a
 *  malformed spec advances to a far-future time (never fires on bad data). */
export function computeNextFire(spec: string, afterMs: number): number {
  const [kind, a, b] = (spec ?? "").split(";");
  let hour = 0;
  let min = 0;
  let dayIdx: number | null = null;
  if (kind === "weekly") {
    dayIdx = Number(a);
    const [h, mm] = (b ?? "").split(":").map((x) => Number(x || 0));
    hour = h;
    min = mm;
  } else {
    const [h, mm] = (a ?? "").split(":").map((x) => Number(x || 0));
    hour = h;
    min = mm;
  }
  if (!Number.isFinite(hour) || !Number.isFinite(min) || hour > 23 || min > 59) {
    return afterMs + 366 * 24 * 3600 * 1000;
  }

  const wibNow = new Date(afterMs + WIB_OFFSET_MIN * 60000);
  const todayDay = wibNow.getUTCDay(); // 0 = Sunday

  if (kind === "daily") {
    const target = hour * 60 + min;
    const today = toEpoch(wibNow, todayDay, target);
    return today > afterMs ? today : today + 24 * 3600 * 1000;
  }

  // weekly: today if not passed, else next matching weekday.
  const target = hour * 60 + min;
  for (let ahead = 0; ahead <= 7; ahead++) {
    const d = (todayDay + ahead) % 7;
    if (d === dayIdx) {
      const time = ahead === 0 ? target : target + 24 * 60 * ahead;
      const cand = toEpoch(wibNow, todayDay, time);
      if (cand > afterMs) return cand;
    }
  }
  return afterMs + 7 * 24 * 3600 * 1000;
}

/** Epoch ms for a WIB datetime described by base-day + minutes-offset-in-day. */
function toEpoch(wibBase: Date, wibDayOfWeek: number, minuteOfDay: number): number {
  const dayMs = wibBase.getTime()
    - ((wibBase.getUTCDay() - wibDayOfWeek) * 24 * 3600 * 1000)
    - (((wibBase.getUTCHours() * 60 + wibBase.getUTCMinutes()) - minuteOfDay) * 60000);
  return dayMs - WIB_OFFSET_MIN * 60000;
}

/** Fire due recurring rules: create an instance, dispatch it, advance the
 *  rule. Returns counts so the cron can log + notify on failures. Never
 *  dispatches more than `limit` per call (free-tier CPU + serialized runner). */
export async function fireDueAgentRules(
  env: Env,
  limit = 3,
): Promise<{ fired: number; failed: number; paused: boolean }> {
  const now = Date.now();
  const due = await getDueAgentRules(env, now, limit);
  let fired = 0;
  let failed = 0;
  let paused = false;
  for (const rule of due) {
    // Global /pause overrides BOTH the maestro and the recurring heavy-task
    // scheduler — a paused owner gets NO autonomous executor runs at all.
    const cfg = await getDmsConfig(env, rule.owner_id);
    if (cfg.autonomy_paused) {
      paused = true;
      continue;
    }
    const next = computeNextFire(rule.recur_spec, now);
    const instanceId = await addAgentTask(env, rule.owner_id, rule.task, rule.id);
    if (!instanceId) {
      const ok = await updateAgentRuleFired(env, rule.id, now, next);
      console.error(`[agent_rules] instans #rule ${rule.id} gagal; advance=${ok}`);
      failed++;
      continue;
    }
    const sent = await delegateToGithub(env, instanceId, rule.task);
    const ok = await updateAgentRuleFired(env, rule.id, now, next);
    console.log(`[agent_rules] rule #${rule.id} fired instans #${instanceId} advance=${ok} next=${new Date(next).toISOString()}`);
    if (sent.error) {
      failed++;
      await sendMessage(env, rule.owner_id,
        `⚠️ Tugas terjadwal #${rule.id} gagal ke eksekutor (${sent.error}). Instans #${instanceId} tersimpan ⏳; jadwal tetap lanjut.`)
        .catch(() => {});
    } else {
      fired++;
      await sendMessage(env, rule.owner_id,
        `🗓️ Jadwal *#${rule.id}* dijalankan — "_${rule.task.slice(0, 90)}…_" (tugas ${instanceId}). Hasil kubalas di sini.`)
        .catch(() => {});
    }
  }
  return { fired, failed, paused };
}
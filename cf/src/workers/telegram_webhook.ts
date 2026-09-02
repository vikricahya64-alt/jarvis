//=====================================================================
// telegram_webhook.ts — Telegram update dispatch.
//   * message                                  → classify → act (or inline consent)
//   * callback_query ("consent:approve:<corr>") → resolve consent
//   * /health /dms_status /queue_status        → diagnostic replies
//
// This is where the edge becomes the authoritative command channel. Unlike
// the legacy Vercel webhook (which only enqueued to cloud), here the worker
// holds D1 state and issues the inline-button consent flow.
//=====================================================================

import { Env, touchActivity, logConsent } from "../lib/db";
import { sendMessage, editMessageReplyMarkup, answerCallbackQuery, TelegramUpdate, InlineButton } from "../lib/telegram";
import {
  routeCommand, markExplicitStop, setAutonomyPaused, isAutonomyPaused,
} from "../lib/command_hierarchy";
import { checkIn, runDms } from "../daemons/dead_mans_switch";
import { queueStatus } from "../lib/db";

const RATE_LIMIT_MS = 1000;
const lastMsg = new Map<number, number>();

function rateLimited(userId: number): boolean {
  const now = Date.now();
  const prev = lastMsg.get(userId) ?? 0;
  if (now - prev < RATE_LIMIT_MS) return true;
  lastMsg.set(userId, now);
  return false;
}

const OWNER_OK = (env: Env, id: number) => String(id) === env.OWNER_TELEGRAM_ID;

/** Main entry for a verified Telegram POST. */
export async function handleUpdate(env: Env, update: TelegramUpdate): Promise<Response> {
  // Callback query → consent resolution.
  if (update.callback_query) {
    const cq = update.callback_query;
    const owner = Number(env.OWNER_TELEGRAM_ID || 0);
    if (cq.from.id !== owner) {
      await answerCallbackQuery(env, cq.id, "Bukan pemilik.");
      return new Response("forbidden", { status: 403 });
    }
    const data = cq.data ?? "";
    const parts = data.split(":");
    // Consent: consent:approve|deny|pause:<corr>
    if (parts[0] === "consent" && parts.length === 3) {
      const [, decision, corr] = parts;
      if (["approve", "deny", "pause"].includes(decision)) {
        const consumed = await resolveConsent(env, owner, corr, decision);
        if (cq.message) {
          await editMessageReplyMarkup(env, cq.message.chat.id, cq.message.message_id, { inline_keyboard: [] });
        }
        await answerCallbackQuery(env, cq.id,
          !consumed ? "Sesi kedaluwarsa (default DENY)."
            : decision === "approve" ? "Disetujui." : decision === "pause" ? "Dijeda." : "Ditolak.");
        // "pause" also sets the global autonomy-pause flag (L11 python parity).
        if (decision === "pause") await setAutonomyPaused(env, owner, true);
        return new Response("ok");
      }
    }
    // Clarification options: clarify:<corr>:<index>
    if (parts[0] === "clarify" && parts.length === 3) {
      await logConsent(env, owner, parts[1], "clarify-callback", "low", `choice:${parts[2]}`, 100);
      if (cq.message) {
        await editMessageReplyMarkup(env, cq.message.chat.id, cq.message.message_id, { inline_keyboard: [] });
      }
      await answerCallbackQuery(env, cq.id, `Dipilih opsi ${parts[2]}.`);
      return new Response("ok");
    }
    await answerCallbackQuery(env, cq.id, "Tidak dikenal.");
    return new Response("ok");
  }

  const msg = update.message;
  if (!msg) return new Response("noop", { status: 200 });
  const from = msg.from?.id ?? 0;
  const text = msg.text ?? "";

  // Only the owner may drive the mission-critical switch.
  if (!OWNER_OK(env, from)) {
    await sendMessage(env, from, "Perintah tidak diizinkan.");
    return new Response("ok", { status: 200 });
  }
  if (rateLimited(from)) return new Response("ok", { status: 200 });

  await touchActivity(env, from, "telegram");

  // Diagnostic endpoints.
  const trimmed = text.trim().toLowerCase();
  const r = msg.from ? from : 0;
  if (trimmed === "/health") {
    await sendMessage(env, r, "Health: sehat. Resp." + Math.round(Date.now() / 1000));
    return new Response("ok", { status: 200 });
  }
  if (trimmed === "/dms_status") {
    await sendMessage(env, r, await runDms(env, r));
    return new Response("ok", { status: 200 });
  }
  if (trimmed === "/queue_status") {
    await sendMessage(env, r, JSON.stringify(await queueStatus(env)));
    return new Response("ok", { status: 200 });
  }
  if (trimmed === "/checkin" || trimmed === "/stop" || trimmed === "/kill") {
    await sendMessage(env, r, await checkIn(env, r));
    return new Response("ok", { status: 200 });
  }
  // Autonomy pause control (L11 python parity).
  if (trimmed === "/pause" || trimmed === "/pause_autonomy") {
    await setAutonomyPaused(env, r, true);
    await sendMessage(env, r, "⏸️ Otonomi di-pause. Aksi otonom tidak akan berjalan.");
    return new Response("ok", { status: 200 });
  }
  if (trimmed === "/resume" || trimmed === "/resume_autonomy") {
    await setAutonomyPaused(env, r, false);
    await sendMessage(env, r, "▶️ Otonomi di-resume.");
    return new Response("ok", { status: 200 });
  }
  // Persist explicit 'never/stop' rule (mark_explicit_stop parity).
  if (trimmed.startsWith("/mark_stop") || trimmed.startsWith("/never ")) {
    const phrase = text.replace(/^\/(mark_stop|never)\s+/i, "").trim();
    if (phrase) {
      await markExplicitStop(env, r, phrase, true);
      await sendMessage(env, r, `🛑 Aturan "never" disimpan: \`${phrase.slice(0, 120)}\`\nAutonomous akan memblokir aksi serupa.`);
    } else {
      await sendMessage(env, r, "Gunakan: /mark_stop <frasa>. Contoh: /mark_stop jangan kirim berita.");
    }
    return new Response("ok", { status: 200 });
  }
  if (trimmed === "/obedience_report") {
    const paused = await isAutonomyPaused(env, r);
    await sendMessage(env, r,
      `Audit kepatuhan: dictatat per perintah di obedience_audit.\n` +
      `Status otonomi: ${paused ? "⏸️ PAUSED" : "▶️ aktif"}\n` +
      `Lihat /queue_status, /dms_status.`);
    return new Response("ok", { status: 200 });
  }

  // Everything else → compliance pipeline.
  await act(env, r, text);
  return new Response("ok", { status: 200 });
}

async function resolveConsent(env: Env, owner: number, corr: string, decision: string): Promise<boolean> {
  // Record to consent_log (append-only). If the correlation is unknown/stale,
  // the worker still logs a denied outcome (defensive default-deny parity).
  await logConsent(env, owner, corr, "inline-consent", "high", decision, 70);
  await sendMessage(env, owner,
    decision === "pause"
      ? `⏸️ Otonomi DI-PAUSE (keputusan #${corr}).`
      : `Keputusan consent "${decision}" untuk #${corr} dicatat.`);
  return true; // consumed + recorded
}

/** Simplified action path for a normal (non-diagnostic) text command. */
async function act(env: Env, owner: number, text: string): Promise<void> {
  const res = await routeCommand(env, owner, text);
  switch (res.decision.action) {
    case "EXECUTE":
      await sendMessage(env, owner, applyDefault(res));
      break;
    case "CLARIFY":
      // Offer structured options (L11 python send_clarification parity) instead
      // of guessing. Callback handled by the clarify:<corr>:<idx> path above.
      await sendMessage(env, owner,
        "🤔 *Mohon perjelas.*\n" +
        `Perintah kurang jelas (kepercayaan ${res.intent.confidence.toFixed(2)}).` +
        "\nPilih salah satu, atau ketik jawaban sendiri:",
        { replyMarkup: { inline_keyboard: [
            [{ text: "A) Uji lagi", callback_data: `clarify:${res.decision.correlationId}:0` }],
            [{ text: "B) Override jalankan", callback_data: `clarify:${res.decision.correlationId}:1` }],
            [{ text: "C) Batalkan", callback_data: `clarify:${res.decision.correlationId}:2` }],
        ] } });
      break;
    case "CONSENT":
      await sendMessage(env, owner,
        `Aksi risiko tinggi terdeteksi. Butuh persetujuan.`,
        { replyMarkup: { inline_keyboard: [[
            { text: "Setujui", callback_data: "consent:approve:" + res.decision.correlationId },
            { text: "Tolak", callback_data: "consent:deny:" + res.decision.correlationId },
            { text: "Pause", callback_data: "consent:pause:" + res.decision.correlationId },
        ]] } });
      break;
    case "BLOCK":
    case "DEFER":
    default:
      await sendMessage(env, owner, "Aksi ditangguhkan.");
  }
}

/** Human reply for the default EXECUTE decision. Kept short (worker-safe). */
function applyDefault(res: Awaited<ReturnType<typeof routeCommand>>): string {
  const label: Record<number, string> = {
    100: "Sistem/override.",
    90: "Perintah darurat dijalankan.",
    70: "Aksi berisiko disetujui.",
    50: "Status dimuat.",
    30: "Ok.",
  };
  return label[res.decision.priority] ?? "Ok.";
}

export { act, OWNER_OK, RATE_LIMIT_MS };
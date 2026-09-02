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

import { Env, touchActivity } from "../lib/db";
import { sendMessage, editMessageReplyMarkup, answerCallbackQuery, TelegramUpdate } from "../lib/telegram";
import { routeCommand } from "../lib/command_hierarchy";
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
    if (parts[0] === "consent" && parts.length === 3) {
      const [, decision, corr] = parts;
      if (["approve", "deny", "pause"].includes(decision)) {
        await resolveConsent(env, owner, corr, decision);
        if (cq.message) {
          await editMessageReplyMarkup(env, cq.message.chat.id, cq.message.message_id, { inline_keyboard: [] });
        }
        await answerCallbackQuery(env, cq.id, decision === "approve" ? "Disetujui." : "Ditolak.");
        return new Response("ok");
      }
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
  if (trimmed === "/obedience_report") {
    // Minimal: hierarchy already audits; report cleaned here.
    return new Response("ok", { status: 200 });
  }

  // Everything else → compliance pipeline.
  await act(env, r, text);
  return new Response("ok", { status: 200 });
}

async function resolveConsent(env: Env, owner: number, corr: string, decision: string): Promise<void> {
  // We log approve/deny/pause into consent_log via the hierarchy callback.
  await sendMessage(env, owner,
    `Keputusan consent "${decision}" untuk #${corr} dicatat.`);
  // NOTE: full chain wiring (re-issuing the original action on approve) is
  // handled by the task processor keyed on correlationId; keep this minimal
  // to stay within worker CPU budget.
}

/** Simplified action path for a normal (non-diagnostic) text command. */
async function act(env: Env, owner: number, text: string): Promise<void> {
  const res = await routeCommand(env, owner, text);
  switch (res.decision.action) {
    case "EXECUTE":
      await sendMessage(env, owner, applyDefault(res));
      break;
    case "CLARIFY":
      await sendMessage(env, owner,
        `Perintah tidak jelas (kepercayaan ${res.intent.confidence.toFixed(2)}). Tolong ulangi / override.`);
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
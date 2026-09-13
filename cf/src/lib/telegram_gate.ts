//=====================================================================
// telegram_gate.ts — SATU PINTU untuk seluruh lalu lintas Telegram
// (input + output), sejalan dengan prinsip pemilik: "input+output 1
// pintu — kemampuan fondasi sebagai otak, kemampuan lain tangan/kaki".
//
// Aturan emas pemilik:
//   1. Modul INI adalah satu-satunya yang boleh memanggil transport
//      lib/telegram.ts (sendMessage & kawan-kawan). Yang lain dilarang
//      mengimpor transport; semuanya lewat sini.
//   2. PINTU MASUK (inbound): handleIncoming() — satu-satunya titik
//      masuk pesan Telegram. Router disuntik (registerUpdateRouter)
//      oleh index.ts untuk menghindari siklus import, sehingga gate
//      tetap pure tanpa dependensi ke webhook.
//   3. PINTU KELUAR (outbound): emitText / emitSmartReply / emitPhoto /
//      emitVoice / emitAnswer / emitEditMarkup — satu-satunya titik
//      keluar. Setiap kiriman TERCATAT (audit) dan, untuk teks yang
//      ber-origin otak (source: "brain"), rail anti-halusinasi
//      diterapkan sebagai lapis kedua (fail-closed) di luar gate di
//      dalam processIntelligence: (a) pesan vague tanpa subjek diulang
//      dicegat → CLARIFY_EMPTY_SUBJECT (byte-identical dengan gate
//      input, idempotent — tidak akan di-gate ulang), (b) kutipan
//      memori yang tidak boleh ("berdasarkan catatan kita" tanpa
//      jangkar) disaring. Notifikasi deterministik (cron/agent/DMS)
//      LULUS tapi tetap teraudit lewat pintu yang sama.
//
// Fail-closed: tanpa router terdaftar, handleIncoming menolak (500)
// dan mencoba memberi tahu pemilik. Tidak ada pesan yang bisa masuk
// tanpa router, dan tidak ada pesan yang bisa keluar tanpa lewat sini.
//=====================================================================

import type { Env } from "./db";
import {
  sendMessage as transportSendMessage,
  deliverSmartReply as transportDeliverSmartReply,
  answerCallbackQuery as transportAnswerCallbackQuery,
  sendPhoto as transportSendPhoto,
  editMessageReplyMarkup as transportEditMessageReplyMarkup,
  sendVoice as transportSendVoice,
  setWebhook,
  setMyCommands,
  getWebhookInfo,
  getMe,
  downloadTelegramFile,
  stripTelegramMarkdown,
  type TelegramUpdate,
  type TelegramMessage,
  type TelegramPhotoSize,
  type TelegramVoice,
  type TelegramDocument,
  type TelegramAudio,
  type TelegramVideo,
  type TelegramVideoNote,
  type InlineButton,
  type DownloadResult,
} from "./telegram";
import { isVagueNoSubject, CLARIFY_EMPTY_SUBJECT } from "./ai";

export type {
  TelegramUpdate, TelegramMessage, TelegramPhotoSize, TelegramVoice,
  TelegramDocument, TelegramAudio, TelegramVideo, TelegramVideoNote,
  InlineButton, DownloadResult,
};

/** Origin of an outbound text. BRAIN = hasil processIntelligence → rail
 *  anti-halusinasi penuh. DETERMINISTIC = notifikasi/balasan tetap
 *  (cron, agent, DMS, diagnostic) → lolos, but still audited. */
export type OutboundSource = "brain" | "deterministic";

// ---------------------------------------------------------------------
// PINTU MASUK (inbound)
// ---------------------------------------------------------------------

export type UpdateRouter = (env: Env, update: TelegramUpdate) => Promise<Response>;

let updateRouter: UpdateRouter | null = null;

/** Inject the inbound router once at boot (index.ts). Fail-closed: until a
 *  router is registered, handleIncoming rejects — no message can silently
 *  be dropped into a void. */
export function registerUpdateRouter(router: UpdateRouter): void {
  updateRouter = router;
  console.log(`[telegram_gate] inbound router registered`);
}

/** THE single inbound door. Every Telegram update (message, callback_query,
 *  edited_message, …) enters here and nowhere else. */
export async function handleIncoming(env: Env, update: TelegramUpdate): Promise<Response> {
  const kind = update.callback_query ? "callback_query" : update.message ? "message" : "unknown";
  console.log(`[telegram_gate] IN update_id=${update.update_id ?? "-"} kind=${kind}`);
  if (!updateRouter) {
    console.error("[telegram_gate] inbound router NOT registered — fail-closed 500");
    return new Response("no router", { status: 500 });
  }
  return updateRouter(env, update);
}

// ---------------------------------------------------------------------
// PINTU KELUAR (outbound) — audit + rail
// ---------------------------------------------------------------------

/** Deterministic rail for brain-origin text leaving the door. Returns the
 *  possibly-rewritten text. Never throws. Fail-closed: a blind reply is
 *  replaced with the byte-identical clarify message used at the input gate
 *  (idempotent — CLARIFY_EMPTY_SUBJECT is not itself vague). */
export function brainExitRail(text: string): string {
  const t = (text ?? "").trim();
  if (!t) return "";
  // (a) Empty-subject re-gate — belt-and-braces for a reply that slipped
  //     past the input gate (e.g. a future non-brain path feeds an LLM).
  if (isVagueNoSubject(t)) return CLARIFY_EMPTY_SUBJECT;
  // (b) Memory-citation scrub: "berdasarkan catatan kita" is only legal when
  //     the topic is present in this conversation's context. At the door we
  //     have NO context — so unanchored citation claims are stripped to a
  //     sober opinion lead instead of a fabricated joint-recollection.
  //     Conservative: only rewrites the standalone claim opener, never the
  //     content after it.
  //     live-veri 2026: juga jebak varian EMOSI ("Berdasarkan kebingungan yang
  //     kamu rasakan tadi") — model mengarang rekam jejak perasaan user dari
  //     memori, padahal subjeknya tak pernah disebut di pesan saat ini.
  if (
    /^berdasarkan catatan kita[,\s]*(?:kamu|anda|kita)?[,\s]*/i.test(t) ||
    /^seperti yang kita sepakati[,\s]+/i.test(t) ||
    /^berdasarkan\s+(?:kebingungan|kekhawatiran|keraguan|kecemasan|perasaan|masalah|kesulitan|keluhan)\b[^.\n]*?\b(?:kamu|anda)\b/i.test(t) ||
    /^seperti yang (?:kamu|anda)(?: rasakan)?\b[^.\n]*?\btadi\b/i.test(t)
  ) {
    return "Menurut ingatanku, " + t.replace(
      /^(?:berdasarkan catatan kita|seperti yang kita sepakati)\b[,\s]*/i,
      "",
    ).replace(
      /^berdasarkan\s+(?:kebingungan|kekhawatiran|keraguan|kecemasan|perasaan|masalah|kesulitan|keluhan)\b[^,\n]*?\b(?:kamu|anda)\b[^,\n]*[,\s]*/i,
      "",
    ).replace(
      /^seperti yang (?:kamu|anda)(?: rasakan)?\b[^,\n]*?\btadi\b[,\s]*/i,
      "",
    ).trim();
  }
  return t;
}

/** Audit line for every outbound send crossing the door. */
function auditOut(kind: string, chatId: number | string, source: string, len: number): void {
  console.log(`[telegram_gate] OUT kind=${kind} chat=${chatId} src=${source} len=${len}`);
}

type EnvLike = { TELEGRAM_TOKEN?: string };

/** Single outbound door for deterministic text notifications (cron, agent,
 *  DMS, diagnostics, media captions, plain replies). Audited; no LLM rail
 *  (it isn't brain text). */
export async function emitText(
  env: EnvLike,
  chatId: number,
  text: string,
  extra: { replyMarkup?: { inline_keyboard: InlineButton[][] }; parseMode?: string } = {},
): Promise<unknown> {
  auditOut("text", chatId, "deterministic", (text ?? "").length);
  return transportSendMessage(env, chatId, text, extra);
}

/** Single outbound door for BRAIN-origin text. Applies the full exit rail
 *  (empty-subject re-gate + memory-citation scrub) BEFORE the transport so
 *  a confirmation reply is never delivered by mistake. Audited. */
export async function emitSmartReply(
  env: EnvLike,
  chatId: number,
  text: string,
  retryDelayMs = 800,
): Promise<void> {
  const safe = brainExitRail(text);
  auditOut("brain", chatId, "brain", (safe ?? "").length);
  await transportDeliverSmartReply(env, chatId, safe, retryDelayMs);
}

/** Outbound photo delivery (imagegen results). Caption is deterministic —
 *  audited, no LLM rail (a generated image can't hallucinate a subject). */
export async function emitPhoto(
  env: EnvLike,
  chatId: number,
  imageBytes: Uint8Array | ArrayBuffer,
  caption: string,
  mime = "image/png",
): Promise<unknown> {
  auditOut("photo", chatId, "deterministic", (caption ?? "").length);
  return transportSendPhoto(env, chatId, imageBytes, caption, mime);
}

/** Outbound voice delivery (TTS results). Audited; deterministic caption. */
export async function emitVoice(
  env: EnvLike,
  chatId: number,
  audioBytes: Uint8Array | ArrayBuffer,
  caption?: string,
  mime = "audio/mpeg",
): Promise<unknown> {
  auditOut("voice", chatId, "deterministic", (caption ?? "").length);
  return transportSendVoice(env, chatId, audioBytes, caption, mime);
}

/** Callback-query answer (consent/clarify buttons). Audited. */
export async function emitAnswer(env: EnvLike, callbackQueryId: string, text?: string): Promise<unknown> {
  auditOut("callback_answer", callbackQueryId, "deterministic", (text ?? "").length);
  return transportAnswerCallbackQuery(env, callbackQueryId, text);
}

/** Inline keyboard edit (button bar removal after confirmation). Audited. */
export async function emitEditMarkup(
  env: EnvLike,
  chatId: number,
  messageId: number,
  replyMarkup: { inline_keyboard: InlineButton[][] },
): Promise<unknown> {
  auditOut("edit_markup", chatId, "deterministic", 0);
  return transportEditMessageReplyMarkup(env, chatId, messageId, replyMarkup);
}

// ---------------------------------------------------------------------
// PROVISIONING / ADMIN passthrough (not message pumps, but still the only
// door: everything Telegram-related crosses this module).
// ---------------------------------------------------------------------

export { setWebhook, setMyCommands, getWebhookInfo, getMe, downloadTelegramFile, stripTelegramMarkdown };
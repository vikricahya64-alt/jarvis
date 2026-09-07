//=====================================================================
// telegram.ts — minimal Telegram Bot API client (fetch-based).
// No external SDK; uses Web Fetch (available in every Worker runtime).
// All methods return parsed JSON; failures throw so callers can retry.
//=====================================================================

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  callback_query?: {
    id: string;
    from: { id: number };
    message?: TelegramMessage;
    data?: string;
  };
}

/** Photo size variant (sendPhoto uploads come back as photo array). */
export interface TelegramPhotoSize {
  file_id: string;
  file_unique_id: string;
  width: number;
  height: number;
  file_size?: number;
}

/** Voice message (file to transcribe). */
export interface TelegramVoice {
  file_id: string;
  file_unique_id: string;
  duration: number;
  mime_type?: string;
  file_size?: number;
}

export interface TelegramDocument {
  file_id: string;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
}

export interface TelegramMessage {
  message_id: number;
  chat: { id: number };
  from?: { id: number; username?: string; first_name?: string };
  text?: string;
  date: number;
  photo?: TelegramPhotoSize[];
  voice?: TelegramVoice;
  document?: TelegramDocument;
  caption?: string;
}

export interface InlineButton {
  text: string;
  callback_data: string;
}

const API = "https://api.telegram.org";

function token(env: { TELEGRAM_TOKEN?: string }): string {
  const t = env.TELEGRAM_TOKEN;
  if (!t) throw new Error("TELEGRAM_TOKEN not configured");
  return t;
}

async function call(
  env: { TELEGRAM_TOKEN?: string },
  method: string,
  body: Record<string, unknown>,
): Promise<unknown> {
  const res = await fetch(`${API}/bot${token(env)}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = (await res.json()) as { ok: boolean; result?: unknown; description?: string };
  if (!res.ok || !data.ok) {
    throw new Error(`Telegram ${method}: ${data.description ?? res.status}`);
  }
  return data.result;
}

const MAX_MSG_LEN = 4000;

/** Sanitize Telegram Markdown special chars so unbalanced formatting never
 *  triggers a MalformedRequest error. Escapes, doesn't strip. */
export function sanitizeTelegramMarkdown(text: string): string {
  return text.replace(/([_*\[\]()~`>#+\-=|{}.!\\])/g, (m) => (m === "*" ? "*" : `\\${m}`));
}

/** Truncate to Telegram's 4096 limit defensively (keep 4000 headroom). */
function truncate(text: string): string {
  if (text.length <= MAX_MSG_LEN) return text;
  return text.slice(0, MAX_MSG_LEN - 16) + "...\n[truncated]";
}

export async function sendMessage(
  env: { TELEGRAM_TOKEN?: string },
  chatId: number,
  text: string,
  extra: { replyMarkup?: { inline_keyboard: InlineButton[][] }; parseMode?: string } = {},
): Promise<unknown> {
  const body: Record<string, unknown> = { chat_id: chatId, text: truncate(text) };
  if (extra.parseMode) body.parse_mode = extra.parseMode;
  if (extra.replyMarkup) body.reply_markup = extra.replyMarkup;
  return call(env, "sendMessage", body);
}

export async function answerCallbackQuery(
  env: { TELEGRAM_TOKEN?: string },
  callbackQueryId: string,
  text?: string,
): Promise<unknown> {
  const body: Record<string, unknown> = { callback_query_id: callbackQueryId };
  if (text) body.text = text;
  return call(env, "answerCallbackQuery", body);
}

/** Send a photo from raw image bytes (multipart/form-data). Used to deliver
 *  locally-generated images (e.g. Workers AI imagegen) to the owner. */
export async function sendPhoto(
  env: { TELEGRAM_TOKEN?: string },
  chatId: number,
  imageBytes: Uint8Array | ArrayBuffer,
  caption: string,
  mime = "image/png",
): Promise<unknown> {
  const form = new FormData();
  const buf = imageBytes instanceof Uint8Array ? imageBytes : new Uint8Array(imageBytes);
  form.append("chat_id", String(chatId));
  const ext = mime === "image/jpeg" ? "jpg" : "png";
  form.append("photo", new Blob([buf as unknown as Blob], { type: mime }), `jarvis_image.${ext}`);
  form.append("caption", truncate(caption));
  const res = await fetch(`${API}/bot${token(env)}/sendPhoto`, { method: "POST", body: form });
  const data = (await res.json()) as { ok: boolean; result?: unknown; description?: string };
  if (!res.ok || !data.ok) {
    throw new Error(`Telegram sendPhoto: ${data.description ?? res.status}`);
  }
  return data.result;
}

export async function editMessageReplyMarkup(
  env: { TELEGRAM_TOKEN?: string },
  chatId: number,
  messageId: number,
  replyMarkup: { inline_keyboard: InlineButton[][] },
): Promise<unknown> {
  return call(env, "editMessageReplyMarkup", {
    chat_id: chatId,
    message_id: messageId,
    reply_markup: replyMarkup,
  });
}

/** Send a voice note from raw audio bytes (multipart/form-data). Currently used
 *  to deliver TTS speech back to the owner (the voice loop: hear → think → speak). */
export async function sendVoice(
  env: { TELEGRAM_TOKEN?: string },
  chatId: number,
  audioBytes: Uint8Array | ArrayBuffer,
  caption?: string,
  mime = "audio/mpeg",
): Promise<unknown> {
  const form = new FormData();
  const buf = audioBytes instanceof Uint8Array ? audioBytes : new Uint8Array(audioBytes);
  form.append("chat_id", String(chatId));
  form.append("voice", new Blob([buf as unknown as Blob], { type: mime }), "jarvis_voice.mp3");
  if (caption) form.append("caption", truncate(caption));
  const res = await fetch(`${API}/bot${token(env)}/sendVoice`, { method: "POST", body: form });
  const data = (await res.json()) as { ok: boolean; result?: unknown; description?: string };
  if (!res.ok || !data.ok) {
    throw new Error(`Telegram sendVoice: ${data.description ?? res.status}`);
  }
  return data.result;
}

export async function setWebhook(
  env: { TELEGRAM_TOKEN?: string },
  url: string,
  secret?: string,
): Promise<unknown> {
  const body: Record<string, unknown> = { url };
  if (secret) body.secret_token = secret;
  return call(env, "setWebhook", body);
}

/** Register the bot's slash command menu so users see what J.A.R.V.I.S. can do.
 *  Idempotent by design; callers may retry daily without harm. */
export async function setMyCommands(env: { TELEGRAM_TOKEN?: string }): Promise<boolean> {
  const commands = [
    { command: "help", description: "Bantuan & daftar perintah" },
    { command: "tugas", description: "Delegasi kerja berat ke eksekutor cloud (/tugas <pekerjaan>)" },
    { command: "reminder", description: "Set pengingat (contoh: /reminder X in 5 menit)" },
    { command: "baca", description: "Baca + ringkas halaman web (/baca <url>)" },
    { command: "suara", description: "Ubah teks jadi pesan suara (/suara <teks>)" },
    { command: "status", description: "Cek kesehatan J.A.R.V.I.S." },
  ];
  try {
    const res = await call(env, "setMyCommands", { commands });
    return Boolean((res as { ok?: boolean })?.ok ?? false);
  } catch {
    return false;
  }
}

export async function getWebhookInfo(
  env: { TELEGRAM_TOKEN?: string },
): Promise<{ url: string; has_custom_certificate: boolean; pending_update_count: number; last_error_date?: number; last_error_message?: string }> {
  return call(env, "getWebhookInfo", {}) as Promise<any>;
}

export async function getMe(
  env: { TELEGRAM_TOKEN?: string },
): Promise<{ id: number; is_bot: boolean; first_name: string; username?: string }> {
  return call(env, "getMe", {}) as Promise<any>;
}

/** Resolve the downstream file (photo/voice) URL and download its bytes.
 *  Telegram serves media on api.telegram.org/file/bot<token>/<file_path>. */
export async function downloadTelegramFile(
  env: { TELEGRAM_TOKEN?: string },
  fileId: string,
): Promise<{ bytes: Uint8Array; mime: string } | null> {
  try {
    const info = (await call(env, "getFile", { file_id: fileId })) as { file_path?: string; file_size?: number };
    if (!info.file_path) return null;
    // Cap download at ~20 MB (Telegram voice/photos are small; generous headroom).
    const res = await fetch(`${API}/file/bot${token(env)}/${info.file_path}`);
    if (!res.ok) return null;
    const mime = res.headers.get("Content-Type") ?? "application/octet-stream";
    return { bytes: new Uint8Array(await res.arrayBuffer()), mime };
  } catch {
    return null;
  }
}
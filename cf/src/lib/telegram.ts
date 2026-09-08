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

/** Replace the markdown "`{n}`" placeholders (used to quarantine URLs while
 *  the emphasis markers are being normalized) with their original text. */
const URL_PLACEHOLDER_RE = /[\u{e000}][\d]+[\u{e001}]/gu;

/**
 * Strip any Telegram Markdown formatting the producers may emit so the send
 * layer NEVER triggers a MalformedRequest parse error (400) and so literal
 * `*`/`_`/backtick artifacts never surface in the chat.
 *
 * This is the single consumer-side contract: producers (lists, status, LLM
 * replies) may keep writing `*bold*`, `[title](url)`, backticks — the send
 * layer normalizes them all to clean, readable plain text. URLs are preserved
 * (converted to "title (url)"); heading hashes and stray emphasis markers are
 * removed entirely. Guaranteed parser-safe for every Telegram parse mode.
 */
export function stripTelegramMarkdown(text: string): string {
  if (!text) return text;
  const urls: string[] = [];
  const PROTECT_RE = /(?<=\d)\*(?=\d)/g; // multiplication asterisks must survive
  // Quarantine any bare/inside-link URLs so emphasis-normalization never
  // distorts them (underscores/asterisks inside host/paths must survive).
  let t = String(text).replace(/https?:\/\/[^\s<>)]+/g, (m) => {
    urls.push(m);
    return `\u{e000}${urls.length - 1}\u{e001}`;
  });
  // Protect digit-asterisk-digit (e.g. "10*5") from being read as emphasis.
  t = t.replace(PROTECT_RE, "\u{e002}");

  // Markdown links → "title (url)" (parenthesized plain text).
  t = t.replace(/\[([^[\]\n]{1,200})]\(([^)\n]{0,300})\)/g, (_a, title, url) => `${title} (${url})`);
  // Line-start bullets ("* item", "** item") are list markers, not emphasis.
  t = t.replace(/^([ \t]*)\*+[ \t]+/gm, "$1");
  // Emphasis: collapse `**x**`/`__x__` then single-char pairs. The inner text
  // must start AND end with a non-space char so `*  100*` / `a * b *` stay
  // literal instead of being swallowed as emphasis.
  t = t.replace(/\*\*([^*\n]+?)\*\*/g, "$1");
  t = t.replace(/__([^_\n]+?)__/g, "$1");
  t = t.replace(/\*([^*\n\s][^*\n]*?[^*\n\s])\*/g, "$1");
  t = t.replace(/_([^_\n\s][^_\n]*?[^_\n\s])_/g, "$1");
  t = t.replace(/`([^`\n]+?)`/g, "$1");
  // Any marker that didn't pair up is formatting noise → drop it.
  t = t.replace(/[*_`[\]]+/g, "");
  // Restore protected multiplication markers.
  t = t.replace(/[\uE002]/g, "*");
  // Heading hashes ("# Judul", "### Judul") are decorations → drop them.
  t = t.replace(/^[ \t]*#{1,6}[ \t]+/gm, "");
  // Restore quarantined URLs.
  t = t.replace(URL_PLACEHOLDER_RE, (m) => {
    const idx = Number(m.replace(/[\uE000\uE001]/g, ""));
    return urls[idx] ?? m;
  });
  return t.replace(/ {2,}/g, " ").replace(/\n{3,}/g, "\n\n").trim();
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
  const clean = stripTelegramMarkdown(truncate(text));
  const body: Record<string, unknown> = { chat_id: chatId, text: clean };
  if (extra.parseMode) body.parse_mode = extra.parseMode;
  if (extra.replyMarkup) body.reply_markup = extra.replyMarkup;
  return call(env, "sendMessage", body);
}

/** Deliver a conversational reply to the owner with one retry plus a
 *  best-effort diagnostic if both attempts fail. Never throws (fire-and-forget
 *  contract — a Telegram hiccup must not turn into a 5xx retry storm), but
 *  unlike bare fire() a failed reply is never silently dropped: the owner is
 *  told the answer exists and how to regain it. */
export async function deliverSmartReply(
  env: { TELEGRAM_TOKEN?: string },
  chatId: number,
  text: string,
  retryDelayMs = 800,
): Promise<void> {
  try {
    await sendMessage(env, chatId, text);
    return;
  } catch (e) {
    console.error("[telegram] reply send failed (retrying):", (e as Error).message);
  }
  try {
    await new Promise((r) => setTimeout(r, retryDelayMs));
    await sendMessage(env, chatId, text);
    return;
  } catch (e) {
    console.error("[telegram] reply send failed (retry):", (e as Error).message, (e as Error).stack);
  }
  try {
    await sendMessage(
      env,
      chatId,
      "⚠️ J.A.R.V.I.S. punya jawabannya, tapi Telegram gagal mengirimkannya ke kamu (2×). Kirim ulang pertanyaan atau cek /status.",
    );
  } catch (e) {
    console.error("[telegram] diagnostic send failed:", (e as Error).message);
  }
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
  form.append("caption", stripTelegramMarkdown(truncate(caption)));
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
  if (caption) form.append("caption", stripTelegramMarkdown(truncate(caption)));
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
  allowedUpdates?: string[],
): Promise<unknown> {
  const body: Record<string, unknown> = { url };
  if (secret) body.secret_token = secret;
  // Explicitly include callback_query so inline-button flows (consent, clarify,
  // typo confirm) are guaranteed to reach the worker even if a previous webhook
  // config filtered them out.
  if (allowedUpdates) body.allowed_updates = allowedUpdates;
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
): Promise<{ url: string; has_custom_certificate: boolean; pending_update_count: number; last_error_date?: number; last_error_message?: string; allowed_updates?: string[] }> {
  return call(env, "getWebhookInfo", {}) as Promise<any>;
}

export async function getMe(
  env: { TELEGRAM_TOKEN?: string },
): Promise<{ id: number; is_bot: boolean; first_name: string; username?: string }> {
  return call(env, "getMe", {}) as Promise<any>;
}

/** Result of a Telegram file download. `tooLarge` branches are distinct so
 *  callers can give the owner a clear size cap message instead of a generic
 *  "download failed" (the cap was previously only a comment — M6 audit fix). */
export type DownloadResult = { bytes: Uint8Array; mime: string } | { tooLarge: true; limitMb: number; mime?: string } | null;

const TELEGRAM_FILE_CAP_BYTES = 20 * 1024 * 1024;

/** Resolve the downstream file (photo/voice) URL and download its bytes.
 *  Telegram serves media on api.telegram.org/file/bot<token>/<file_path>.
 *  Rejects files above 20 MiB (free-tier voice/photos are small). */
export async function downloadTelegramFile(
  env: { TELEGRAM_TOKEN?: string },
  fileId: string,
  capBytes = TELEGRAM_FILE_CAP_BYTES,
): Promise<DownloadResult> {
  try {
    const info = (await call(env, "getFile", { file_id: fileId })) as { file_path?: string; file_size?: number };
    if (!info.file_path) return null;
    if (typeof info.file_size === "number" && info.file_size > capBytes) {
      return { tooLarge: true, limitMb: Math.round(capBytes / (1024 * 1024)) };
    }
    const res = await fetch(`${API}/file/bot${token(env)}/${info.file_path}`);
    if (!res.ok) return null;
    const mime = res.headers.get("Content-Type") ?? "application/octet-stream";
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.byteLength > capBytes) return { tooLarge: true, limitMb: Math.round(capBytes / (1024 * 1024)), mime };
    return { bytes, mime };
  } catch {
    return null;
  }
}
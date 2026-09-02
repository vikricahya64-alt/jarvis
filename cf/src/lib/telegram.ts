//=====================================================================
// telegram.ts — minimal Telegram Bot API client (fetch-based).
// No external SDK; uses Web Fetch (available in every Worker runtime).
// All methods return parsed JSON; failures throw so callers can retry.
//=====================================================================

export interface TelegramMessage {
  message_id: number;
  chat: { id: number };
  from?: { id: number; username?: string; first_name?: string };
  text?: string;
  date: number;
}

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

export async function sendMessage(
  env: { TELEGRAM_TOKEN?: string },
  chatId: number,
  text: string,
  extra: { replyMarkup?: { inline_keyboard: InlineButton[][] }; parseMode?: string } = {},
): Promise<unknown> {
  const body: Record<string, unknown> = { chat_id: chatId, text };
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

export async function setWebhook(
  env: { TELEGRAM_TOKEN?: string },
  url: string,
  secret?: string,
): Promise<unknown> {
  const body: Record<string, unknown> = { url };
  if (secret) body.secret_token = secret;
  return call(env, "setWebhook", body);
}
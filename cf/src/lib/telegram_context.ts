/**
 * Conversation context, taken from Telegram itself.
 *
 * The previous approach reconstructed context from heuristics over an internal
 * store, and kept an anchor that was written after every reply but only ever
 * read by the search path. Nothing read it at the input gate, so a follow-up
 * with no recent turns was indistinguishable from a brand-new question and the
 * model answered an invented subject. Seen in production: a question about the
 * history of inflation was answered about remote-work policy, because the turn
 * before it existed in no store at all and Telegram's own reply_to_message -
 * the one signal that says "I am continuing this" - was not even modelled.
 *
 * This module replaces that with two explicit directions, checked in order:
 *
 *   1. REPLY  - update.message.reply_to_message. The user replied to a specific
 *      message, so that message is the subject. No guessing involved.
 *   2. TODAY  - no reply, but the user has spoken today and the message reads
 *      as a continuation. Continue from the most recent turn of today.
 *   3. NEW    - neither. Treat it as a fresh question with no prior subject.
 *
 * "Today" is deliberate and literal: the log is scoped to the calendar day
 * (Asia/Jakarta, the user's timezone) and expires on its own, so context can
 * never silently jump to a conversation from last week.
 */

import type { Env } from "./db";

export type ContextKind = "reply" | "today" | "new";

export interface TelegramContext {
  kind: ContextKind;
  /** The prior turn this message continues, if any. */
  prior: string;
  /** Subject phrase for the continued topic. */
  topic: string | null;
  /** Human-readable justification, surfaced in diagnostics. */
  reason: string;
  /** Whether the brain should keep the active topic rather than re-extract. */
  isContinuation: boolean;
}

type Turn = { role: "user" | "assistant"; text: string; at: number };

const MAX_TURN_CHARS = 1200;
const MAX_TURNS = 12;

/** Day bucket in the owner's timezone, so "today" means their today. */
function dayKey(now = new Date()): string {
  // Asia/Jakarta is UTC+7 with no DST; using a fixed offset keeps the bucket
  // correct without pulling in a timezone library into the Worker bundle.
  const wib = new Date(now.getTime() + 7 * 3600 * 1000);
  return wib.toISOString().slice(0, 10);
}

function logKey(owner: number): string {
  return `tctx:${owner}:${dayKey()}`;
}

/**
 * Strong, unambiguous "I am continuing that" signals.
 *
 * Deliberately conservative. An earlier version treated any question starting
 * with "apa sejarah..." as a continuation, which misfired on brand-new
 * questions like "apa itu inflasi dan apa yang menyebabkannya dalam sejarah" -
 * the exact message whose follow-up drifted. A wrong "continuation" is far more
 * damaging than a missed one: it hands the model a subject it did not ask
 * about. When a signal is merely suggestive we fall through to direction 3 and
 * supply the day's turns as background instead, which lets the model resolve a
 * reference without us forcing a topic onto it.
 */
const EXPLICIT_CONTINUE =
  /^(lanjutkan|lanjut|lanjutkan|terus(kan)?|kemudian|selain\s+itu|selebihnya|berikutnya|next|later)\b/i;

/**
 * Reference words that can only point at something already said.
 *
 * "itu" needs a guard: in Indonesian it is also the copula in "apa itu X"
 * ("what is X"). Matching it there turned the very first question of a topic -
 * "apa itu inflasi dan apa yang menyebabkannya" - into a continuation, which
 * is precisely the drift. So a bare "itu" only counts when it is not the
 * "apa itu" / "kalau itu" / "atau itu" construction.
 */
const STRONG_ANAPHORA =
  /(?<!\bapa\s)(?<!\bkalau\s)(?<!\batau\s)(?<!\bbenarkah\s)\bitu\b|\bitu\s+yang\b|\b(yang\s+(?:tadi|sebelumnya|di\s+atas)|tersebut|seperti\s+(?:itu|yg\s+itu)|kebijakan\s+itu|sistem\s+itu|caranya\s+itu|alasan\s+itu|sebabnya\s+itu)\b/i;

/** Short bare follow-ups with no subject of their own. */
const BARE_FOLLOWUP =
  /^(lalu\s+)?(sebabnya|kenapa|mengapa|kapan|siapa|dimana|jelaskan|teruskan|contohnya|masih|dan\s+lalu)\s*\??$/i;

/** True when the message refers back with high confidence. */
export function looksLikeContinuation(text: string): boolean {
  const t = (text ?? "").trim();
  if (t.length === 0) return false;
  if (EXPLICIT_CONTINUE.test(t)) return true;
  if (STRONG_ANAPHORA.test(t)) return true;
  if (BARE_FOLLOWUP.test(t)) return true;
  // A very short message in a live conversation is a follow-up by nature.
  if (t.length <= 12) return true;
  return false;
}

/** Cheap topic phrase for a prior turn, without importing the whole AI stack. */
function topicOf(text: string): string {
  return (text ?? "")
    .replace(/^[^a-zA-Z0-9]+/, "")
    .split(/[.?!;\n]/)[0]
    .slice(0, 80)
    .trim();
}

async function readToday(env: Env, owner: number): Promise<Turn[]> {
  try {
    const raw = await env.CONFIG_KV?.get(logKey(owner), "json").catch(() => null);
    return Array.isArray(raw) ? (raw as Turn[]) : [];
  } catch {
    return [];
  }
}

/** Append a turn to today's log. Bounded, and a no-op when the text is empty. */
export async function recordTurn(
  env: Env,
  owner: number,
  role: "user" | "assistant",
  text: string,
): Promise<void> {
  const t = (text ?? "").trim();
  if (!t || !env.CONFIG_KV) return;
  try {
    const turns = await readToday(env, owner);
    const last = turns[turns.length - 1];
    // Avoid storing the same turn twice (echoes, retries).
    if (last && last.role === role && last.text === t) return;
    turns.push({ role, text: t.slice(0, MAX_TURN_CHARS), at: Date.now() });
    const trimmed = turns.slice(-MAX_TURNS);
    // 26h TTL: long enough to cover "still today" past midnight in the user's
    // own timezone, short enough that it cannot become a stale transcript.
    await env.CONFIG_KV.put(logKey(owner), JSON.stringify(trimmed), {
      expirationTtl: 93_600,
    }).catch(() => {});
  } catch {
    // Context bookkeeping must never break a reply.
  }
}

/**
 * The two-direction check. `replyToText` is the text of
 * update.message.reply_to_message, if Telegram sent one.
 */
export async function resolveTelegramContext(
  env: Env,
  owner: number,
  text: string,
  replyToText?: string,
): Promise<TelegramContext> {
  // Direction 1 - Telegram told us exactly which message this continues.
  const replied = (replyToText ?? "").trim();
  if (replied) {
    return {
      kind: "reply",
      prior: replied.slice(0, 2000),
      topic: topicOf(replied),
      reason: "lanjutan ke pesan yang di-reply (sinyal Telegram)",
      isContinuation: true,
    };
  }

  // Direction 2 - same day, and the message reads as a follow-up.
  const turns = await readToday(env, owner);
  if (turns.length > 0 && looksLikeContinuation(text)) {
    const lastUser = [...turns].reverse().find((x) => x.role === "user");
    const lastAny = turns[turns.length - 1];
    const prior = lastUser?.text ?? lastAny.text;
    return {
      kind: "today",
      prior: prior.slice(0, 2000),
      topic: topicOf(prior),
      reason: `lanjutan ke giliran hari ini (${turns.length} giliran tercatat)`,
      isContinuation: true,
    };
  }
  // A non-continuation-shaped message after a busy day is still worth having
  // the day's turns as background, but it must NOT be treated as a
  // continuation - that is the drift that produced an invented subject.
  if (turns.length > 0) {
    return {
      kind: "new",
      prior: turns.map((x) => `${x.role}: ${x.text}`).join("\n").slice(0, 2000),
      topic: null,
      reason: "konteks baru; giliran hari ini hanya sebagai latar belakang",
      isContinuation: false,
    };
  }

  return {
    kind: "new",
    prior: "",
    topic: null,
    reason: "konteks baru; tidak ada pesan di atas dan belum ada giliran hari ini",
    isContinuation: false,
  };
}
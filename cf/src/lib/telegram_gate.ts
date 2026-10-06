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
import { isVagueNoSubject, CLARIFY_EMPTY_SUBJECT, extractTopic } from "./ai";

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

// ============================================================================
// GATED OUTPUT FILTER (Prinsip: SwiGLU Output Gate)
// ============================================================================

/** Threshold output gate score. Di bawah threshold → block output (fail-closed).
 *  Score ≥ 0.6 dianggap aman. Skor dihitung dari: subject match (40%),
 *  memory citation validity (30%), output length sanity (20%), no fabrication
 *  signals (10%). */
const OUTPUT_GATE_THRESHOLD = 0.6;

/** Hard cap karakter output brain. Response lebih panjang dari ini dipotong
 *  di batas kalimat terakhir + catatan "ketik lanjut". 800 char ≈ 150 kata
 *  ≈ 3-5 kalimat pendek + pertanyaan lanjutan. Hemat ~60-70% output tokens. */
const RESPONSE_HARD_CAP = 700;

/** Cari posisi karakter terakhir berupa titik/panic/tanda seru sebelum maxLen.
 *  Jika tidak ditemukan, potong di spasi terakhir sebelum maxLen. */
function findLastSentenceBoundary(text: string, maxLen: number): number {
  const slice = text.slice(0, maxLen);
  // Cari titik/panic/tanda seru terakhir
  const lastPeriod = Math.max(slice.lastIndexOf(". "), slice.lastIndexOf(".\n"), slice.lastIndexOf("? "), slice.lastIndexOf("?\n"), slice.lastIndexOf("! "), slice.lastIndexOf("!\n"));
  if (lastPeriod > maxLen * 0.5) return lastPeriod + 1;
  // Fallback: spasi terakhir (potong di word boundary)
  const lastSpace = slice.lastIndexOf(" ");
  return lastSpace > maxLen * 0.5 ? lastSpace : maxLen;
}

/**
 * Hitung output gate score secara deterministik (0 token, <1ms).
 * Skor komposit dari 4 sinyal untuk mendeteksi output yang tidak match
 * dengan input (kasus halusinasi yang terlewat regex).
 *
 * Bobot: subjectMatch=40%, memoryCitation=30%, lengthSanity=20%, noFabrication=10%
 */
function computeOutputGateScore(output: string, inputTopic: string | null): number {
  const t = (output ?? "").trim();
  if (!t) return 0;

  let score = 0;

  // 1. Subject match (40%): apakah output menyebut/mengacu subjek dari input?
  const subjectScore = (() => {
    if (!inputTopic) return 0.5; // No topic → netral
    const topicLower = inputTopic.toLowerCase();
    const outputLower = t.toLowerCase();
    const topicWords = topicLower.split(/\s+/).filter((w) => w.length > 3);
    if (topicWords.length === 0) return 0.5;
    const matches = topicWords.filter((w) => outputLower.includes(w)).length;
    return matches / topicWords.length;
  })();
  score += 0.4 * subjectScore;

  // 2. Memory citation validity (30%): "menurut ingatanku" harus diikuti fakta
  const citationScore = (() => {
    const hasCitation = /menurut ingatanku|berdasarkan catatan/i.test(t);
    if (!hasCitation) return 1.0; // Tidak ada kutipan → aman
    const afterCitation = t.replace(/^(?:menurut ingatanku|berdasarkan catatan)[^.]*\.\s*/i, "");
    return afterCitation.length > 20 ? 1.0 : 0.3;
  })();
  score += 0.3 * citationScore;

  // 3. Length sanity (20%): output terlalu pendek atau terlalu panjang = suspicious
  const lengthScore = (() => {
    const len = t.length;
    if (len < 10) return 0.2;
    if (len > 3000) return 0.4;
    if (len < 30) return 0.6;
    return 1.0;
  })();
  score += 0.2 * lengthScore;

  // 4. No fabrication signals (10%): cek indikator halusinasi umum + template markdown
  const fabricationScore = (() => {
    const suspiciousPatterns = [
      /https?:\/\/[^\s)]{80,}/,
      /(\b\w+\b)\s+\1\s+\1\s+\1/,
      /(?:saya|aku) (?:tidak|tak) (?:tahu|paham|mengerti) (?:apa|siapa|dimana|kapan)/i,
      /^#+\s+(Nama Lengkap|Ringkasan Profesional|Pengalaman Kerja|Pendidikan|Keterampilan)/i,
      /^```(?:markdown|text)/i,
    ];
    const suspiciousCount = suspiciousPatterns.filter((p) => p.test(t)).length;
    return suspiciousCount === 0 ? 1.0 : 0.4;
  })();
  score += 0.1 * fabricationScore;

  return Math.min(1, Math.max(0, score));
}

// ============================================================================
// INJECTION SCANNER (deterministik, 0 token)
// ============================================================================

/** Deteksi pola prompt injection di output. Jika LLM mengulang pola injection
 *  dari input user (atau mengarang injection sendiri), output diblokir.
 *  Regex-only, 0 token, <1ms. */
function scanInjectionAttempt(text: string): boolean {
  const t = (text ?? "").toLowerCase().trim();
  const patterns = [
    /(?:ignore|abaikan|skip|lewati)\s+(?:all|semua|seluruh)\s+(?:previous|sebelumnya|prior|lama)/i,
    /(?:you\s+are\s+now|kamu\s+sekarang\s+adalah|kamu\s+adalah\s+sekarang)/i,
    /(?:system\s+prompt|instruksi\s+sistem|perintah\s+sistem)/i,
    /(?:DAN\s+mode|developer\s+mode|debug\s+mode|root\s+mode)/i,
    /(?:reveal|tampilkan|keluarkan|show|output)\s+(?:your|system|semua)\s+(?:prompt|instruksi|perintah)/i,
    /(?:pretend|aku\s+akan\s+menyamar|berpura-pura)\s+(?:you\s+are|kamu\s+adalah)/i,
    /(?:jailbreak|bypass\s+safety|lewati\s+keamanan)/i,
  ];
  return patterns.some((p) => p.test(t));
}

/** Deterministic rail for brain-origin text leaving the door. Returns the
 *  possibly-rewritten text. Never throws. Fail-closed: a blind reply is
 *  replaced with the byte-identical clarify message used at the input gate
 *  (idempotent — CLARIFY_EMPTY_SUBJECT is not itself vague).
 *
 *  inputTopic: opsional, topik dari pesan input (untuk output gate scoring).
 *  Jika disediakan, output gate score dihitung dan output yang score-nya
 *  di bawah OUTPUT_GATE_THRESHOLD (0.6) diblokir. */
/**
 * Strip research apparatus from text on its way to a chat.
 *
 * Applied to EVERY brain reply at the exit, not only to the grounded-answer
 * path, because a citation marker is meaningless in a Telegram chat whichever
 * route produced it. This is a transport concern, not a judgement about meaning,
 * so it is deterministic and costs nothing.
 *
 * Handles the forms actually observed in production: 【1†https://...】,
 * 【https://...】, and a trailing "Sumber: https://a, https://b" line.
 */
export function stripResearchApparatus(text: string): string {
  let t = String(text ?? "");
  if (!t) return t;
  // Bracketed citation markers carrying a source, a URL or a confidence tag.
  t = t.replace(/【[^】]{0,200}?(?:†|https?:\/\/|www\.)[^】]{0,200}】/g, " ");
  // Any other bracketed reference left over (footnote markers, source tags).
  t = t.replace(/【\s*(?:\d+|sumber|source|cf|high|medium|low)\s*†?[^】]{0,120}】/gi, " ");
  // A trailing source line.
  t = t.replace(/\n{0,2}\s*(?:sumber|sumber:|sources?|referensi)\s*:\s*\S+(\s*,\s*\S+)*\s*$/i, "");
  // Inline URLs left in prose - a chat reply does not need the raw link.
  t = t.replace(/\s*\(?<?https?:\/\/\S+>?\)?/g, "");
  t = t.replace(/[ \t]+/g, " ").replace(/\s+([,.;:!?])/g, "$1").replace(/\n{3,}/g, "\n\n");
  return t.trim();
}

export function brainExitRail(text: string, inputTopic?: string, clipLength = true): string {
  let t = (text ?? "").trim();
  if (!t) return "";
  // (x) Injection scan — block output yang mengandung pola prompt injection.
  //     Jika LLM mengulang pola injection dari input, output diblokir.
  if (scanInjectionAttempt(t)) return CLARIFY_EMPTY_SUBJECT;
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
  // (b2) Research apparatus is stripped BEFORE the gates run, so relevance and
  //      citation scoring judge the sentence the user will actually read and
  //      not the brackets around it.
  if (stripResearchApparatus(t) !== t) t = stripResearchApparatus(t);

  // (c) GATED OUTPUT FILTER (Prinsip: SwiGLU Output Gate): skor output
  //     terhadap input. Score < 0.6 = output tidak match → block.
  //     Deterministik, 0 token, <1ms. Selalu jalan jika inputTopic disediakan;
  //     skip jika null (deterministic paths tanpa topik).
  if (inputTopic !== undefined) {
    const gateScore = computeOutputGateScore(t, inputTopic ?? "general");
    if (gateScore < OUTPUT_GATE_THRESHOLD) {
      return CLARIFY_EMPTY_SUBJECT;
    }
  }
  // (d) RESPONSE LENGTH HARD CAP (800 char): pastikan output padat.
  //     Cari batas kalimat terakhir sebelum cap, potong, tambah catatan.
  if (t.length > RESPONSE_HARD_CAP) {
    const cut = findLastSentenceBoundary(t, RESPONSE_HARD_CAP);
    return t.slice(0, cut).trim() + "\n\n📌 Jawaban terpotong — ketik \"lanjut\" untuk bagian berikutnya.";
  }
  return t;
}

/** Audit line for every outbound send crossing the door. */
function auditOut(kind: string, chatId: number | string, source: string, len: number): void {
  console.log(`[telegram_gate] OUT kind=${kind} chat=${chatId} src=${source} len=${len}`);
}

type EnvLike = { TELEGRAM_TOKEN?: string; CONFIG_KV?: KVNamespace };

/** Single outbound door for deterministic text notifications (cron, agent,
 *  DMS, diagnostics, media captions, plain replies). Audited; no LLM rail
 *  (it isn't brain text). Minimal content gate: strip very long fabricated URLs. */
export async function emitText(
  env: EnvLike,
  chatId: number,
  text: string,
  extra: { replyMarkup?: { inline_keyboard: InlineButton[][] }; parseMode?: string } = {},
): Promise<unknown> {
  let safe = (text ?? "").trim();
  // Minimal gate: strip very long fabricated URLs (deterministic, 0 token)
  safe = safe.replace(/https?:\/\/[^\s)]{80,}/g, "[link]").trim();
  auditOut("text", chatId, "deterministic", safe.length);
  return transportSendMessage(env, chatId, safe, extra);
}

/** Single outbound door for BRAIN-origin text. Applies the full exit rail
 *  (empty-subject re-gate + memory-citation scrub + output gate scoring)
 *  BEFORE the transport so a confirmation reply is never delivered by mistake.
 *  inputTopic: opsional, topik dari pesan input (untuk output gate). */
/**
 * Split a full answer into parts that each fit RESPONSE_HARD_CAP, cutting only
 * at sentence boundaries so no part ends mid-word.
 *
 * Returns every part, not just the first. The previous version returned a
 * clipped string and told the user to type "lanjut" - but nothing stored the
 * rest, so that word could only ever produce a refusal. The promise was
 * unbacked. This returns the remainder so it can actually be kept.
 */
export function splitForTelegram(text: string): string[] {
  const t = (text ?? "").trim();
  if (!t) return [];
  if (t.length <= RESPONSE_HARD_CAP) return [t];

  const parts: string[] = [];
  let rest = t;
  while (rest.length > RESPONSE_HARD_CAP) {
    const cut = findLastSentenceBoundary(rest, RESPONSE_HARD_CAP);
    // A boundary that yields no progress would loop forever; fall back to a
    // hard cut rather than spinning on text with no sentence punctuation.
    if (cut <= 0) {
      parts.push(rest.slice(0, RESPONSE_HARD_CAP).trim());
      rest = rest.slice(RESPONSE_HARD_CAP);
      continue;
    }
    parts.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) parts.push(rest);
  return parts.filter((p) => p.length > 0);
}

/** Key holding the not-yet-delivered remainder of an answer, per chat. */
export function pendingReplyKey(chatId: number): string {
  return `pending_reply:${chatId}`;
}

export async function emitSmartReply(
  env: EnvLike,
  chatId: number,
  text: string,
  retryDelayMs = 800,
  inputTopic?: string,
): Promise<void> {
  // Gate the text WITHOUT clipping: the gates must see the whole answer, and
  // the splitter owns length so the remainder can be kept for "lanjut".
  // Splitting the raw text instead - as an earlier version did when the gated
  // copy came out short - silently bypassed every gate on this path.
  const gated = brainExitRail(text, inputTopic, false);
  const parts = splitForTelegram(gated);
  const first = parts[0] ?? "";
  const rest = parts.slice(1);

  if (rest.length > 0 && env.CONFIG_KV) {
    // Stored with a TTL so an abandoned answer expires instead of resurfacing
    // hours later as a stale fragment.
    await env.CONFIG_KV.put(pendingReplyKey(chatId), JSON.stringify(rest), {
      expirationTtl: 600,
    }).catch(() => undefined);
  } else if (env.CONFIG_KV) {
    // Nothing outstanding: clear any stale remainder so "lanjut" cannot deliver
    // text that belongs to an older exchange.
    await env.CONFIG_KV.delete(pendingReplyKey(chatId)).catch(() => undefined);
  }

  auditOut("brain", chatId, "brain", (first ?? "").length);
  await transportDeliverSmartReply(
    env,
    chatId,
    rest.length > 0
      ? `${first}\n\n\ud83d\udccc Lanjut ketik "lanjut" untuk bagian berikutnya.`
      : first,
    retryDelayMs,
  );
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
/**
 * True only for a bare continuation word. Anything longer is a real message
 * and must go to the pipeline - this is a control word, not a heuristic.
 */
export function isContinuationWord(text: string): boolean {
  // Only a bare control word, optionally with politeness particles. Free
  // trailing words are NOT accepted: "lanjutin ya bang" is a sentence the user
  // actually wrote, and swallowing it would eat a real message.
  return /^(lanjut|lajut|lanjutin|lanjutkan|teruskan|terus|selengkapnya|sambungkan|sambung|continue|next|lagi)[.!?…]*$|^(lanjut|lajut|lanjutin|lanjutkan|teruskan|terus|selengkapnya|sambung|continue|next|lagi)(\s+(dong|ya|yuk|deh|tolong|aja|sih|pls|please))*[.!?…]*$/i.test(
    (text ?? "").trim(),
  );
}

/**
 * Deliver the next stored part of an answer. Returns false when nothing is
 * outstanding. Each call consumes one part and keeps the rest for the next.
 */
export async function servePendingReply(
  env: EnvLike,
  chatId: number,
): Promise<boolean> {
  const raw = await env.CONFIG_KV?.get(pendingReplyKey(chatId));
  if (!raw) return false;
  let parts: string[];
  try {
    parts = JSON.parse(raw) as string[];
  } catch {
    return false;
  }
  if (!Array.isArray(parts) || parts.length === 0) return false;

  const next = parts[0];
  const remaining = parts.slice(1);
  if (remaining.length > 0) {
    await env.CONFIG_KV!.put(pendingReplyKey(chatId), JSON.stringify(remaining), {
      expirationTtl: 600,
    }).catch(() => undefined);
  } else {
    await env.CONFIG_KV!.delete(pendingReplyKey(chatId)).catch(() => undefined);
  }
  await transportDeliverSmartReply(
    env,
    chatId,
    remaining.length > 0
      ? `${next}\n\n\ud83d\udccc Lanjut ketik "lanjut" untuk bagian berikutnya.`
      : next,
  );
  return true;
}

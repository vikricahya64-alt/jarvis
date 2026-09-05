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

import { Env, touchActivity, logConsent, getConsentRequestTs, getDmsConfig, writeDmsConfig } from "../lib/db";
import { addTodo, listTodos, deleteTodoById, deleteTodoByText } from "../lib/db";
import {
  addProduct, listProducts, getProduct, updateProduct, deleteProduct, adjustStock, lowStockProducts,
  addCustomer, listCustomers, searchCustomer,
  createOrder, listOrders, getOrder, updateOrderStatus, salesReport,
  type Product, type Order, type OrderInput,
} from "../lib/db";
import { sendMessage, editMessageReplyMarkup, answerCallbackQuery, TelegramUpdate, InlineButton } from "../lib/telegram";
import {
  routeCommand, markExplicitStop, setAutonomyPaused, isAutonomyPaused, redact,
  setPrivacyMode, isPrivacyMode,
} from "../lib/command_hierarchy";
import { checkIn, runDms } from "../daemons/dead_mans_switch";
import { queueStatus, recordTaskCounters, recentContext } from "../lib/db";
import { searchAndSynthesize, extractTopic, parseTranslate, translateText, isFollowUpQuery, resolveFollowUpAnchor } from "../lib/ai";
import { normalizeInput, isEmptyInput } from "../lib/normalize";
import { saveSessionToKV, loadSessionFromKV } from "../lib/context_manager";
import { saveObservation } from "../lib/db";
import { processMessage, type MessageContext } from "../lib/jarvis_core";
import { JARVIS_IDENTITY, SELF_REF_RE } from "../lib/identity";
import { covenantStatusText, signClause } from "../lib/covenant_core";
import { identityStatusText } from "../lib/identity_anchor";
import { getPlans, getScheduledTasks } from "../lib/maestro";
import { getDegradationStatus } from "../lib/degradation";
import {
  listInsights, setPreference, disablePreference, getActivePreferences,
  auditPhantomRules, reflectOnTurn,
} from "../lib/evolution";
import { listSuggestions, resolveSuggestion } from "../lib/predictive";
import {
  getGreeting, ERRORS, STATUS, SEARCH, SUGGESTIONS, HELP,
} from "../lib/messages";

const RATE_LIMIT_MS = 1000;

/**
 * KV-backed rate limiter. Cloudflare Workers are stateless per invocation, so
 * the old in-memory Map did nothing across calls. Now we persist the last-message
 * timestamp per user and fall back to "allow" if KV is unavailable (single-owner
 * resilience over strictness). Returns true if the user is being rate-limited.
 */
async function rateLimited(env: Env, userId: number): Promise<boolean> {
  const key = `rl:${userId}`;
  const now = Date.now();
  try {
    const prev = await env.CONFIG_KV.get(key);
    if (prev != null && now - Number(prev) < RATE_LIMIT_MS) return true;
    await env.CONFIG_KV.put(key, String(now), { expirationTtl: RATE_LIMIT_MS / 1000 + 2 });
    return false;
  } catch {
    return false; // availability over strictness for a single owner
  }
}

const OWNER_OK = (env: Env, id: number) => String(id) === env.OWNER_TELEGRAM_ID;

/** Fire-and-forget Telegram call: never throw so a downstream Telegram outage
 *  can't turn into a 5xx that makes Telegram retry the whole webhook (retry
 *  storm budget burn). Logs and continues. */
async function fire<T>(p: Promise<T>): Promise<void> {
  try {
    await p;
  } catch (e) {
    console.error("[telegram] send failed", (e as Error).message);
  }
}

/** Wrap an owner diagnostic command so a transient D1/KV error still yields a
 *  helpful reply instead of silently dropping the command (which would make it
 *  look unresponsive). Falls back to a graceful message on failure. */
async function safeDBReply<T>(
  env: Env,
  chatId: number,
  produce: () => Promise<string>,
  fallback = "Terjadi kesalahan membaca data. Coba lagi sebentar.",
): Promise<void> {
  let text: string;
  try {
    text = await produce();
  } catch (e) {
    console.error("[telegram] diagnostic db error", (e as Error).message);
    text = fallback;
  }
  await fire(sendMessage(env, chatId, text));
}

/** Main entry for a verified Telegram POST. */
export async function handleUpdate(env: Env, update: TelegramUpdate): Promise<Response> {
  // Callback query → consent resolution.
  if (update.callback_query) {
    const cq = update.callback_query;
    const owner = Number(env.OWNER_TELEGRAM_ID || 0);
    if (cq.from.id !== owner) {
      await fire(answerCallbackQuery(env, cq.id, "Bukan pemilik."));
      return new Response("forbidden", { status: 403 });
    }
    const data = cq.data ?? "";
    const parts = data.split(":");
    // Consent — L11 schema `consent:<corr>:yes|no|pause` (default-DENY 60s).
    if (parts[0] === "consent" && parts.length === 3) {
      const [, corr, verdict] = parts;
      if (["yes", "no", "pause"].includes(verdict)) {
        const consumed = await resolveConsent(env, owner, corr, verdict);
        if (cq.message) {
          await fire(editMessageReplyMarkup(env, cq.message.chat.id, cq.message.message_id, { inline_keyboard: [] }));
        }
        await fire(answerCallbackQuery(env, cq.id,
          !consumed ? "Sesi kedaluwarsa (default DENY)."
            : verdict === "yes" ? "Disetujui." : verdict === "pause" ? "Dijeda." : "Ditolak."));
        // "pause" also sets the global autonomy-pause flag (L11 python parity).
        if (verdict === "pause") await setAutonomyPaused(env, owner, true);
        return new Response("ok");
      }
    }
    // Clarification options: clarify:<corr>:<index>
    if (parts[0] === "clarify" && parts.length === 3) {
      const idx = parts[2];
      const cmd = await env.CONFIG_KV.get(`clarify:${parts[1]}`).catch(() => null);
      await logConsent(env, owner, redact(parts[1]), "clarify-callback", "low", `choice:${idx}`, 100);
      if (cq.message) {
        await fire(editMessageReplyMarkup(env, cq.message.chat.id, cq.message.message_id, { inline_keyboard: [] }));
      }
      if (!cmd) {
        // Context expired (TTL 5min) or not found → refuse, don't guess.
        await fire(answerCallbackQuery(env, cq.id, "Konteks clarify kedaluwarsa. Kirim ulang perintah."));
        return new Response("ok");
      }
      if (idx === "0") {
        // A) Re-run classification with the stored text (ambiguity may clear).
        await fire(answerCallbackQuery(env, cq.id, "Uji lagi..."));
        await act(env, owner, cmd);
      } else if (idx === "1") {
        // B) Override: force execute (logged as an owner override, audited).
        await fire(answerCallbackQuery(env, cq.id, "Override dijalankan."));
        await forceExecute(env, owner, cmd);
      } else {
        // C) Cancel.
        await fire(answerCallbackQuery(env, cq.id, "Dibatalkan."));
      }
      await env.CONFIG_KV.delete(`clarify:${parts[1]}`).catch(() => {/* best-effort */});
      return new Response("ok");
    }
    await fire(answerCallbackQuery(env, cq.id, "Tidak dikenal."));
    return new Response("ok");
  }

  const msg = update.message;
  if (!msg) return new Response("noop", { status: 200 });
  const from = msg.from?.id ?? 0;
  // Normalize real-world owner input (slang/typo/whitespace/emoji) so greetings,
  // search topics, translate requests and commands aren't mis-routed to the
  // fail-closed "Aksi ditangguhkan." path. Empty payloads (sticker/photo/gif or
  // emoji-only) are answered helpfully instead of falling through to "Ok.".
  const rawText = msg.text ?? "";
  const text = normalizeInput(rawText);

  // Only the owner may drive the mission-critical switch.
  if (!OWNER_OK(env, from)) {
    await fire(sendMessage(env, from, "Maaf, saya hanya melayani pemilik saya."));
    return new Response("ok", { status: 200 });
  }
  if (await rateLimited(env, from)) return new Response("ok", { status: 200 });

  // Best-effort activity touch — a transient D1 error must NEVER silently drop
  // the user's message. Fire-and-forget; the reply path is independent.
  touchActivity(env, from, "telegram").catch(() => {});

  // Load sesi dari KV setelah cold start (persistensi across restarts)
  loadSessionFromKV(env, from).catch(() => {});

  // Non-text payloads (sticker/photo/gif/voice) or text with no meaningful
  // content (pure emoji/punctuation) get a helpful nudge, never a dead "Ok.".
  if (isEmptyInput(text)) {
    await fire(sendMessage(env, from,
      `${getGreeting(new Date().getUTCHours() + 7)} Kirim teks, atau gunakan /cari <topik> untuk mencari informasi.`));
    return new Response("ok", { status: 200 });
  }

  // Diagnostic endpoints.
  const trimmed = text.trim().toLowerCase();
  const r = msg.from ? from : 0;
  if (trimmed === "/health") {
    await fire(sendMessage(env, r, "Health: sehat. Resp." + Math.round(Date.now() / 1000)));
    return new Response("ok", { status: 200 });
  }
  if (trimmed === "/dms_status") {
    await safeDBReply(env, r, () => runDms(env, r));
    return new Response("ok", { status: 200 });
  }
  if (trimmed === "/queue_status") {
    await safeDBReply(env, r, () => queueStatus(env).then((q) => JSON.stringify(q)));
    return new Response("ok", { status: 200 });
  }
  // /debug_bypass — temporarily bypass orchestrator for admin verification.
  // Sets a KV flag for 5 minutes; all subsequent messages skip the orchestrator
  // and fall through to the original act() pipeline. Admin-only.
  if (trimmed === "/debug_bypass") {
    if (!OWNER_OK(env, r)) {
      await fire(sendMessage(env, r, "Admin only."));
      return new Response("ok", { status: 200 });
    }
    try {
      await env.CONFIG_KV.put("debug_bypass", "1", { expirationTtl: 300 });
      await fire(sendMessage(env, r, "🔓 Orchestrator BYPASS active for 5 minutes. All messages use legacy act() pipeline."));
    } catch {
      await fire(sendMessage(env, r, "Failed to set bypass flag."));
    }
    return new Response("ok", { status: 200 });
  }
  if (trimmed === "/status") {
    await safeDBReply(env, r, async () => {
      const paused = await isAutonomyPaused(env, r);
      return statusReport(paused);
    });
    return new Response("ok", { status: 200 });
  }
  if (trimmed === "/help") {
    const lines = [HELP.header, ""];
    for (const s of HELP.sections) {
      lines.push(`*${s.title}*`);
      lines.push(s.items);
      lines.push("");
    }
    lines.push("Ketik pertanyaan apa saja — JARVIS akan menjawab secara natural.");
    await fire(sendMessage(env, r, lines.join("\n")));
    return new Response("ok", { status: 200 });
  }
  if (trimmed === "/checkin" || trimmed === "/stop" || trimmed === "/kill") {
    await fire(sendMessage(env, r, await checkIn(env, r)));
    return new Response("ok", { status: 200 });
  }
  // Autonomy pause control (L11 python parity).
  if (trimmed === "/pause" || trimmed === "/pause_autonomy") {
    await setAutonomyPaused(env, r, true);
    await fire(sendMessage(env, r, "⏸️ Otonomi di-pause. Aksi otonom tidak akan berjalan."));
    return new Response("ok", { status: 200 });
  }
  if (trimmed === "/resume" || trimmed === "/resume_autonomy") {
    await setAutonomyPaused(env, r, false);
    await fire(sendMessage(env, r, "▶️ Otonomi di-resume."));
    return new Response("ok", { status: 200 });
  }
  // Privacy mode under the owner's direct control: /privacy reports state,
  // /privacy on|off toggles strict privacy (stops persisting conversation
  // memory/history). Runs as an explicit owner command — never "ditangguhkan".
  if (trimmed === "/privacy on") {
    await setPrivacyMode(env, r, true);
    await fire(sendMessage(env, r,
      "🔒 Mode privasi KETAT AKTIF.\n" +
      "Ingatan percakapan baru tidak akan disimpan. Anda tinggal /privacy off untuk kembali normal."));
    return new Response("ok", { status: 200 });
  }
  if (trimmed === "/privacy off") {
    await setPrivacyMode(env, r, false);
    await fire(sendMessage(env, r,
      "🔓 Mode privasi NONAKTIF.\nIngatan percakapan kembali disimpan."));
    return new Response("ok", { status: 200 });
  }
  if (trimmed === "/privacy") {
    await safeDBReply(env, r, async () => {
      const on = await isPrivacyMode(env, r);
      return "🔐 *Status Privasi*\n" +
        `Mode: ${on ? "✅ KETAT (ingatan off)" : "⚪ Normal (ingatan on)"}\n` +
        "Gunakan: `/privacy on` untuk hentikan penyimpanan, `/privacy off` untuk lanjut.";
    });
    return new Response("ok", { status: 200 });
  }
  if (trimmed.startsWith("/privacy") && !/^\/privacy( on| off)?$/.test(trimmed)) {
    await fire(sendMessage(env, r, "Gunakan: /privacy (on|off)."));
    return new Response("ok", { status: 200 });
  }
  // Persist explicit 'never/stop' rule (mark_explicit_stop parity).
  if (trimmed.startsWith("/mark_stop") || trimmed.startsWith("/never ")) {
    const phrase = rawText.replace(/^\/(mark_stop|never)\s+/i, "").trim();
    if (phrase) {
      await markExplicitStop(env, r, phrase, true);
      await fire(sendMessage(env, r, `🛑 Aturan "never" disimpan: \`${phrase.slice(0, 120)}\`\nAutonomous akan memblokir aksi serupa.`));
    } else {
      await fire(sendMessage(env, r, "Gunakan: /mark_stop <frasa>. Contoh: /mark_stop jangan kirim berita."));
    }
    return new Response("ok", { status: 200 });
  }
  if (trimmed === "/obedience_report") {
    const paused = await isAutonomyPaused(env, r);
    await fire(sendMessage(env, r,
      `Audit kepatuhan: dictatat per perintah di obedience_audit.\n` +
      `Status otonomi: ${paused ? "⏸️ PAUSED" : "▶️ aktif"}\n` +
      `Lihat /queue_status, /dms_status.`));
    return new Response("ok", { status: 200 });
  }

  // /cari without a topic (or bare /search) would otherwise be classified as a
  // command-prefixed SYSTEM (tier 100) → confusing "Sistem/override." Be helpful
  // instead: show usage. With a topic ("/cari <topik>") it flows into the real
  // EXECUTE path where extractTopic() triggers DDG search + Groq synthesis.
  if (trimmed === "/cari" || trimmed === "/search" || trimmed === "/cari " || trimmed === "/search ") {
    await fire(sendMessage(env, r,
      "Gunakan: /cari <topik>\nContoh: /cari artikel sejarah komputer\n" +
      "Menjalankan pencarian web (DuckDuckGo) + rangkum AI."));
    return new Response("ok", { status: 200 });
  }

  // ------------------------------------------------------------------
  // Level 12 (Transcendent Steward) — covenant / identity / sunset / degradation
  // ------------------------------------------------------------------
  if (trimmed === "/covenant_status") {
    await safeDBReply(env, r, () => covenantStatusText(env));
    return new Response("ok", { status: 200 });
  }
  if (trimmed === "/covenant_sign") {
    const clause = rawText.replace(/^\/covenant_sign\s+/i, "").trim();
    if (!clause) {
      await fire(sendMessage(env, r,
        "Gunakan: /covenant_sign <klausa>\nKlausa ditandatangani immutable (INSERT-only, tak bisa diubah)."));
    } else {
      const clauseId = `ov-${String(r)}-${clause.length}`;
      const version = await signClause(env, clauseId, clause);
      await fire(sendMessage(env, r,
        version != null
          ? `📜 Klausa covenant ditandatangani (id=\`${clauseId}\`, v${version}). Append-only & immutable.`
          : "Gagal menandatangani klausa. Coba lagi."));
    }
    return new Response("ok", { status: 200 });
  }
  if (trimmed === "/identity_verify") {
    await safeDBReply(env, r, () => identityStatusText(env));
    return new Response("ok", { status: 200 });
  }
  if (trimmed === "/sunset_preview") {
    await fire(sendMessage(env, r,
      "🌅 *Preview Sunset* (hanya evaluasi — tak ada aksi ireversibel dipicu).\n" +
      "Modul sunset bersifat reading-only; inisiasi memerlukan formulir manual + konfirmasi ganda pemilik."));
    return new Response("ok", { status: 200 });
  }
  if (trimmed === "/degradation_status") {
    await safeDBReply(env, r, async () => {
      const status = await getDegradationStatus(env);
      return `📉 *Degradasi*\nSisa kuota: ${status.remainingPct}%\n` +
        `Fitur dinonaktifkan: ${status.disabledFeatures.length ? status.disabledFeatures.join(", ") : "tidak ada"}`;
    });
    return new Response("ok", { status: 200 });
  }
  if (trimmed === "/maestro_status") {
    await safeDBReply(env, r, async () => {
      const [plans, tasks] = await Promise.all([getPlans(env, r), getScheduledTasks(env, r)]);
      const planLines = plans.length
        ? plans.map((p) => `• ${p.status} — ${p.goal.slice(0, 40)}`).join("\n")
        : "Belum ada rencana.";
      const taskLines = tasks.length
        ? tasks.map((t) => `• ${t.cadence} ${t.approved ? "✅" : "⚠️"} — ${t.description.slice(0, 40)}`).join("\n")
        : "Belum ada tugas terjadwal.";
      return `🪝 *Maestro*\n*Rencana* (n=${plans.length}):\n${planLines}\n\n*Tugas* (n=${tasks.length}):\n${taskLines}`;
    });
    return new Response("ok", { status: 200 });
  }

  // ------------------------------------------------------------------
  // Level 13 (Reflective Apprentice) — self-improvement surface.
  // Everything is append-only, evidence-warranted, and owner-overridable.
  // ------------------------------------------------------------------
  if (trimmed === "/reflect") {
    await fire(sendMessage(env, r,
      "🧠 *Refleksi*\nJ.A.R.V.I.S. merefleksikan output ~1 ronde setelah tugas kompleks, " +
      "mencatat kritik + versi perbaikan di \`reflection_log\`, lalu mengonsolidasikan " +
      "pola menjadi \`insights\` setiap pagi (cron 0 7).\n" +
      "Lihat: /insights · /audit-phantom"));
    return new Response("ok", { status: 200 });
  }
  if (trimmed === "/insights") {
    await safeDBReply(env, r, async () => {
      const insights = await listInsights(env, false);
      if (insights.length === 0) return "💡 Belum ada insight. J.A.R.V.I.S. masih belajar dari pengalaman Anda.";
      const lines = insights.map((i) =>
        `• #${i.id} [${i.category}] c=${i.confidence.toFixed(2)} bukti=${i.evidenceCount}\n  ${i.ruleText.slice(0, 120)}`,
      ).join("\n");
      return `💡 *Insights yang dipelajari* (${insights.length})\n${lines}\n\nNonaktifkan: /disable-insight <id>`;
    });
    return new Response("ok", { status: 200 });
  }
  if (trimmed.startsWith("/disable-insight")) {
    const id = Number(rawText.replace(/^\/disable-insight\s*/i, "").trim());
    if (!id) { await fire(sendMessage(env, r, "Gunakan: /disable-insight <id>")); return new Response("ok", { status: 200 }); }
    try {
      const rr = await env.DB.prepare(`UPDATE insights SET disabled=1 WHERE id=? AND disabled=0`).bind(id).run();
      await fire(sendMessage(env, r, rr.meta.changes > 0 ? `📵 Insight #${id} dinonaktifkan.` : `Tidak ada insight aktif #${id}.`));
    } catch { await fire(sendMessage(env, r, "Gagal menonaktifkan insight.")); }
    return new Response("ok", { status: 200 });
  }
  if (trimmed === "/audit-phantom") {
    await safeDBReply(env, r, async () => `🛡️ *Audit Phantom*\n${await auditPhantomRules(env)}`);
    return new Response("ok", { status: 200 });
  }
  if (trimmed === "/preferences" || trimmed === "/prefs") {
    await safeDBReply(env, r, async () => {
      const prefs = await getActivePreferences(env);
      if (prefs.length === 0) return "⚙️ Belum ada preferensi. Setel: /set-preference <kunci> = <nilai>";
      const lines = prefs.map((p) => `• \`${p.key}\` = ${p.value.slice(0, 60)} (${p.source}, c=${p.confidence.toFixed(2)})`).join("\n");
      return `⚙️ *Preferensi aktif*\n${lines}\n\nNonaktifkan: /disable-preference <kunci>`;
    });
    return new Response("ok", { status: 200 });
  }
  const setPref = trimmed.match(/^\/set-preference\s+(.+?)\s*=\s*(.+)$/);
  if (setPref) {
    await fire(sendMessage(env, r, await setPreference(env, setPref[1], setPref[2])));
    return new Response("ok", { status: 200 });
  }
  if (trimmed.startsWith("/disable-preference")) {
    const key = rawText.replace(/^\/disable-preference\s*/i, "").trim();
    await fire(sendMessage(env, r, await disablePreference(env, key)));
    return new Response("ok", { status: 200 });
  }
  // "/set-preference" but malformed (no "=").
  if (trimmed.startsWith("/set-preference")) {
    await fire(sendMessage(env, r, "Gunakan: /set-preference <kunci> = <nilai>. Contoh: /set-preference format = markdown singkat"));
    return new Response("ok", { status: 200 });
  }

  // ------------------------------------------------------------------
  // Predictive Steward (L16) — /suggestions + /suggestion accept|dismiss <id>.
  // Read-only owner commands: listing offers and resolving them never executes
  // anything; the offer->act path stays under the owner's explicit next step.
  // `r` is already OWNER_OK (single-owner), so no extra auth needed here.
  // ------------------------------------------------------------------
  if (trimmed === "/suggestions") {
    await safeDBReply(env, r, async () => {
      const list = await listSuggestions(env, r);
      if (list.length === 0) return "💡 Tidak ada saran terbuka. Saran baru muncul di briefing pagi bila ada yang penting.";
      const lines = list.map((s) =>
        `• (${s.id}) [${s.category}] ${s.text} — \`/${s.status === "offered" ? "offered" : s.status}\``).join("\n");
      return `💡 *Saran terbuka*\n${lines}\n\nAksi: /suggestion accept <id> · /suggestion dismiss <id>`;
    });
    return new Response("ok", { status: 200 });
  }
  const sugCmd = trimmed.match(/^\/suggestion\s+(accept|dismiss)\s+(\d+)$/);
  if (sugCmd) {
    const action = sugCmd[1] as "accept" | "dismiss";
    const id = Number(sugCmd[2]);
    await fire(sendMessage(env, r, await resolveSuggestion(env, r, id, action)));
    return new Response("ok", { status: 200 });
  }
  if (trimmed.startsWith("/suggestion")) {
    await fire(sendMessage(env, r, "Gunakan: /suggestion accept <id> atau /suggestion dismiss <id>. Lihat /suggestions."));
    return new Response("ok", { status: 200 });
  }

  // Friendly greeting (INFO, no action) — answered warmly instead of falling
  // into the fail-closed guard. Greetings don't trigger any autonomous step.
  // ONLY pure greetings (<=2 short words) match; a greeting followed by a real
  // request (e.g. "halo tolong bantu kabari bisnis") flows into the compliance
  // pipeline instead of being swallowed by a canned greeting reply.
  const pureGreeting = /^(halo|hai|hi|hello|hey|pagi|siang|sore|malam|assalamualaikum|assalamu'alaikum|selamat)(\s*(bro|bang|kak|pak|bu|sir|boss|cuk|gan|min))?[\s!.,]*$/i;
  if (trimmed === "/start" || pureGreeting.test(trimmed)) {
    await fire(sendMessage(env, r,
      "Halo. J.A.R.V.I.S. siap. Ketik /status untuk kondisi sistem, atau /health untuk uji sehat."));
    return new Response("ok", { status: 200 });
  }

  // Personal todo list — owner-only, handled as an explicit command BEFORE the
  // compliance pipeline so destructive-looking phrases ("hapus todo telur")
  // never get swallowed by the fail-closed DEFER for generic "hapus" verbs.
  //   /todo                → list open todos
  //   /todo add <teks>     → add
  //   /todo del <id|teks>  → delete by id or by text match
  //   "tambah todo <teks>" / "hapus todo <teks>" → same, natural language
  //   /todo done <id>      → mark done
  if (isTodoCommand(trimmed, text)) {
    await handleTodoCommand(env, r, text);
    return new Response("ok", { status: 200 });
  }

  // E-commerce / shop commands — explicit command BEFORE compliance pipeline.
  if (isShopCommand(trimmed, text)) {
    await handleShopCommand(env, r, text);
    return new Response("ok", { status: 200 });
  }

  // Self-referential questions — answer directly without LLM to guarantee
  // accuracy. These ask about JARVIS's own identity/capabilities.
  // Uses the SINGLE SOURCE OF TRUTH from identity.ts.
  // Strip Telegram group "Username:" prefix (same as normalizeInput) so the
  // ^ anchor in SELF_REF_RE works regardless of group display formatting.
  const cleaned = trimmed.replace(/^[^:]+:\s*\n?\s*/i, "").trim();
  if (SELF_REF_RE.test(cleaned)) {
    await fire(sendMessage(env, r, JARVIS_IDENTITY.selfRefReply));
    return new Response("ok", { status: 200 });
  }

  // Everything else → compliance pipeline.
  try {
    await act(env, r, text);
  } catch (e) {
    console.error("[webhook] act() threw:", (e as Error).message);
    await fire(sendMessage(env, r, "Maaf, terjadi kesalahan internal. Coba lagi sebentar."));
  }
  return new Response("ok", { status: 200 });
}

async function resolveConsent(env: Env, owner: number, corr: string, decision: string): Promise<boolean> {
  // Enforce consent TTL (default-DENY). If the request was raised longer ago
  // than CONSENT_TIMEOUT_S (default 60s) and no matching request row exists,
  // treat as expired → deny. L11 python default-deny parity.
  const timeoutMs = Number(env.CONSENT_TIMEOUT_S || "60") * 1000;
  const requestedTs = await getConsentRequestTs(env, owner, corr);
  const expired = requestedTs != null && Date.now() - requestedTs > timeoutMs;
  const effective = expired ? "timeout" : decision;
  // Record to consent_log (append-only). Redact the correlation id so raw
  // PII/command hashes from the wire never persist verbatim.
  await logConsent(env, owner, redact(corr), "inline-consent", "high", effective, 70);
  await fire(sendMessage(env, owner,
    effective === "pause"
      ? "⏸️ Otonomi DI-PAUSE."
      : effective === "timeout"
        ? `⏰ Sesi consent kedaluwarsa (default DENY).`
        : `Keputusan consent "${effective}" dicatat.`));
  return !expired; // consumed (in-time) only
}

/** Simplified action path for a normal (non-diagnostic) text command. */
async function act(env: Env, owner: number, text: string): Promise<void> {
  const res = await routeCommand(env, owner, text);
  switch (res.decision.action) {
    case "EXECUTE":
      // Translation is a dedicated read-only request handled BEFORE the generic
      // search path so it never falls through to the bare "Ok." reply.
      // - "Terjemahkan <teks>" / "translate <teks>": translate inline text.
      // - "Terjemahkan" (bare) / "Terjemahkan ke <bahasa>": translate the last
      //   assistant analysis from conversation context (fail-closed: if no prior
      //   assistant reply exists, sends a graceful fallback message).
      if (/^\s*(?:terjemahkan|translate)/i.test(text)) {
        const tr = parseTranslate(text);
        if (tr) {
          const translated = await translateText(env, tr.source, tr.target);
          const out = translated
            ? (tr.target ? `Terjemahan (${tr.target}):\n` : "Terjemahan:\n") + translated
            : `Maaf, gagal menerjemahkan saat ini. Coba lagi sebentar.`;
          await recordTaskCounters(env, "translate", owner);
          await fire(sendMessage(env, owner, out));
          break;
        }
        // Bare translate: pull last assistant reply from conversation context.
        const ctx = await recentContext(env, owner, 10);
        const lastAssistant = [...ctx].reverse().find((c) => c.role === "assistant");
        if (lastAssistant && lastAssistant.content.length > 30) {
          const translated = await translateText(env, lastAssistant.content, null);
          const out = translated
            ? `Terjemahan analisis terakhir:\n\n${translated}`
            : `Maaf, gagal menerjemahkan analisis saat ini. Coba lagi sebentar.`;
          await recordTaskCounters(env, "translate", owner);
          await fire(sendMessage(env, owner, out));
          break;
        }
        // Nothing to translate: fall through to generic (will show "Ok.")
      }
      const topic = extractTopic(text);
      if (topic) {
        // Friendly info/query EXECUTE → real search + synthesis (searchAndSynthesize
        // already persists user+assistant turns; do NOT append a duplicate here).
        const r = await searchAndSynthesize(env, owner, text, topic);
        // Observasi: user tertarik pada topik ini (untuk personalisasi di masa depan)
        saveObservation(env, owner, `User menanyakan tentang: ${topic}`, "interest").catch(() => {});
        await recordTaskCounters(env, "standard", owner);
        await fire(sendMessage(env, owner, r.reply));
        break;
      }
      // Level 15 FOLLOW-UP: an explicit follow-up request that carries no fresh
      // topic marker (e.g. "lebih dalam", "yang tadi", "terus, kan?") resolves
      // against the most recent assistant analysis and deepens THAT answer —
      // instead of wrongly falling to "Ok.". Fail-closed: no prior analysis or
      // not a follow-up → fall through to the generic reply.
      if (isFollowUpQuery(text)) {
        const ctx = await recentContext(env, owner, 8).catch(() => []);
        const anchor = resolveFollowUpAnchor(ctx);
        if (anchor) {
          const r = await searchAndSynthesize(env, owner, text, anchor.topic);
          await recordTaskCounters(env, "standard", owner);
          await fire(sendMessage(env, owner, r.reply));
          break;
        }
      }
      await fire(sendMessage(env, owner, await applyDefault(env, owner, res, text)));
      break;
    case "CLARIFY":
      // Offer structured options (L11 python send_clarification parity) instead
      // of guessing. Callback dispatched by the clarify:<corr>:<idx> path above.
      // Persist the original command so the callback can re-route (TTL 5min).
      await env.CONFIG_KV.put(`clarify:${res.decision.correlationId}`, text, { expirationTtl: 300 })
        .catch(() => {/* degrade: callback won't re-route, user re-sends */});
      await fire(sendMessage(env, owner,
        `🤔 Saya kurang yakin dengan permintaan ini (kepercayaan ${(res.intent.confidence * 100).toFixed(0)}%).\n\n` +
        `Bisa jelaskan lebih lanjut, atau pilih salah satu:`,
        { replyMarkup: { inline_keyboard: [
            [{ text: "🔄 Coba lagi", callback_data: `clarify:${res.decision.correlationId}:0` }],
            [{ text: "⚡ Jalankan saja", callback_data: `clarify:${res.decision.correlationId}:1` }],
            [{ text: "❌ Batalkan", callback_data: `clarify:${res.decision.correlationId}:2` }],
        ] } }));
      break;
    case "CONSENT":
      await fire(sendMessage(env, owner,
        `⚠️ Aksi ini perlu persetujuan Anda:`,
        { replyMarkup: { inline_keyboard: [[
            { text: "✅ Setujui", callback_data: "consent:" + res.decision.correlationId + ":yes" },
            { text: "❌ Tolak", callback_data: "consent:" + res.decision.correlationId + ":no" },
            { text: "⏸️ Pause", callback_data: "consent:" + res.decision.correlationId + ":pause" },
        ]] } }));
      break;
    case "BLOCK":
    case "DEFER":
    default:
      await fire(sendMessage(env, owner, "Aksi ini saya tunda dulu. Kalau perlu sekarang, coba perjelas permintaannya."));
  }
  // Simpan sesi ke KV untuk persistensi across cold starts (fire-and-forget)
  saveSessionToKV(env, owner).catch(() => {});
}

/**
 * Owner "Override jalankan" from a clarify dialog. We deliberately re-run the
 * full compliance pipeline via act() rather than bypass it: the constitutional
 * guard / dangerous-action blocks AND consent gates still apply, so an owner
 * override can never force a genuinely prohibited action. This is the L11
 * "send_clarification -> forced execute" parity, minus any guard bypass.
 */
async function forceExecute(env: Env, owner: number, text: string): Promise<void> {
  await act(env, owner, text);
}

/** Human reply for the default EXECUTE decision. Uses jarvis_core for conversation. */
async function applyDefault(
  env: Env,
  owner: number,
  res: Awaited<ReturnType<typeof routeCommand>>,
  rawText = "",
): Promise<string> {
  const label: Record<number, string> = {
    100: "Sistem dijalankan.",
    90: "Perintah darurat dijalankan.",
    70: "Aksi ini saya jalankan.",
    50: "Status dimuat.",
    30: "Siap.",
  };
  if (extractTopic(rawText)) {
    return SEARCH.searching(rawText);
  }
  // For general conversation, route through the jarvis_core conversation
  // pipeline so real questions get an actual AI answer — never a canned
  // acknowledgement. System/emergency acks (priority 100/90) keep their
  // short acknowledgement; everything else with meaningful text goes to AI.
  const priority = res.decision.priority;
  if (priority < 90 && rawText.length > 3) {
    try {
      const ctx: MessageContext = { owner, text: rawText, source: "telegram" };
      const jarvisRes = await processMessage(env, ctx);
      if (jarvisRes.text && jarvisRes.text.length > 5) {
        return jarvisRes.text;
      }
    } catch { /* fall back to label below */ }
  }
  return label[priority] ?? "Siap.";
}

/** Compose the /status reply. */
function statusReport(paused: boolean): string {
  const lines = [
    `📊 *Status J.A.R.V.I.S.*`,
    ``,
    `Otonomi: ${paused ? "⏸️ dijeda — sementara nonaktif." : "▶️ aktif — semua sistem jalan."}`,
    ``,
    `${STATUS.systemOk}`,
    ``,
    `Perintah: /health · /dms_status · /queue_status · /pause · /resume · /obedience_report · /todo`,
  ];
  return lines.join("\n");
}

// ---------------------------------------------------------------------
// Todo list command handling (owner-only; explicit commands bypass the
// compliance pipeline so "hapus todo telur" is parsed here, not DEFERed).
// ---------------------------------------------------------------------

/** True when the trimmed/raw text is a todo command (slash or natural language). */
function isTodoCommand(trimmed: string, raw: string): boolean {
  const lower = raw.trim().toLowerCase();
  // Slash forms.
  if (trimmed.startsWith("/todo")) return true;
  // Natural-language forms: "tambah todo ..." / "hapus todo ..." / "buat todo ..."
  if (/^(tambah|tambahkan|buat|buatkan|catat|catatkan|simpan|add|hapus|hapuskan|delete|remove|del|done|selesai|cek)\s+(todo|task|tugas)\b/i.test(lower)) return true;
  // Bare "todo" listing.
  if (/^todo\b/i.test(lower) || lower === "list todo" || lower === "todo list") return true;
  return false;
}

/** Execute a parsed todo command and reply to the owner. Fail-closed: a D1
 *  error surfaces a graceful message (never a silent drop or a crash). */
async function handleTodoCommand(env: Env, owner: number, raw: string): Promise<void> {
  const trimmed = raw.trim();
  const lower = trimmed.toLowerCase();

  // --- Add: "/todo add teks", "/todo tambah teks", "tambah todo teks",
  //         "buat todo teks", "add todo teks" (beberapa kata setara "tambah") ---
  const addMatch = trimmed.match(
    /^(?:\/todo\s+(?:add|tambah)|tambah(?:kan)?|buat(?:kan)?|catat(?:kan)?|simpan|add|buat)\s+(?:todo|task|tugas)\s+(.+)$/i,
  );
  if (addMatch?.[1]) {
    const itemText = addMatch[1].trim();
    const id = await addTodo(env, owner, itemText);
    if (id > 0) {
      await fire(sendMessage(env, owner, `✅ Todo ditambahkan: *${itemText.slice(0, 120)}* (id ${id}).`));
    } else {
      await fire(sendMessage(env, owner, "Gagal menyimpan todo (error D1). Coba lagi sebentar."));
    }
    return;
  }

  // --- Mark done: "/todo done <id>", "done todo <id>", "selesai todo <id>" ---
  const doneMatch = trimmed.match(
    /^(?:\/todo\s+(?:done)|done|selesai|sudah)\s+(?:todo|task|tugas)?\s*(\d+)$/i,
  );
  if (doneMatch?.[1]) {
    const id = Number(doneMatch[1]);
    const ok = await markTodoDone(env, owner, id);
    await fire(sendMessage(env, owner, ok ? `✅ Todo #${id} ditandai selesai.` : `Tidak ada todo #${id} yang terbuka.`));
    return;
  }

  // --- Delete: "/todo del <id|teks>", "/todo delete <teks>", "hapus todo <teks>",
  //             "delete todo <teks>" ---
  const delMatch = trimmed.match(
    /^(?:\/todo\s+(?:del|delete|remove|hapus)|hapus(?:kan)?|delete|remove|del)\s+(?:todo|task|tugas)\s+(.+)$/i,
  );
  if (delMatch?.[1]) {
    const needle = delMatch[1].trim();
    if (/^\d+$/.test(needle)) {
      const idNum = Number(needle);
      const ok = await deleteTodoById(env, owner, idNum);
      await fire(sendMessage(env, owner,
        ok ? `🗑️ Todo #${idNum} dihapus.` : `Tidak ada todo #${idNum}.`));
      return;
    }
    const deleted = await deleteTodoByText(env, owner, needle);
    if (deleted > 0) {
      await fire(sendMessage(env, owner, `🗑️ ${deleted} todo yang cocok dengan "${needle.slice(0, 60)}" dihapus.`));
    } else {
      await fire(sendMessage(env, owner, `Tidak ada todo yang cocok dengan "${needle.slice(0, 60)}".`));
    }
    return;
  }

  // --- List (default: "/todo", "todo", "todo list", "list todo") ---
  const items = await listTodos(env, owner);
  if (items.length === 0) {
    await fire(sendMessage(env, owner,
      "📝 *Daftar Todo*\n\nKosong. Tambah: /todo add <teks> atau \"tambah todo beli susu\"."));
    return;
  }
  const lines = items.map((t, i) => `${i + 1}. [#${t.id}] ${t.text}`).slice(0, 50);
  await fire(sendMessage(env, owner, `📝 *Daftar Todo* (${items.length})\n\n${lines.join("\n")}`));
}

/** Mark an open todo as done (owner-scoped). Returns true on success. */
async function markTodoDone(env: Env, owner: number, id: number): Promise<boolean> {
  try {
    const res = await env.DB.prepare(
      `UPDATE todos SET done = 1, completed_at = ? WHERE owner_id = ? AND id = ? AND done = 0`,
    ).bind(Date.now(), owner, id).run();
    return (res.meta.changes ?? 0) > 0;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------
// E-commerce / Shop command handling (owner-only; explicit commands
// bypass the compliance pipeline).
// ---------------------------------------------------------------------

const Rp = (n: number): string => `Rp${Math.round(n).toLocaleString("id-ID")}`;

function isShopCommand(trimmed: string, raw: string): boolean {
  const lower = raw.trim().toLowerCase();
  if (trimmed.startsWith("/shop") || trimmed.startsWith("/produk") || trimmed.startsWith("/stok") ||
      trimmed.startsWith("/pesanan") || trimmed.startsWith("/pelanggan") || trimmed.startsWith("/invoice") ||
      trimmed.startsWith("/laporan")) return true;
  if (/^(tambah|tambahkan|buat|buatkan|catat|simpan|add)\s+(produk|product|barang)\b/i.test(lower)) return true;
  if (/^(tambah|tambahkan|buat|buatkan)\s+(pelanggan|customer)\b/i.test(lower)) return true;
  if (/^(buat|catat|tambah)\s+(pesanan|order|penjualan)\b/i.test(lower)) return true;
  if (/^(cek|lihat|tampil)\s+(stok|stock)\b/i.test(lower)) return true;
  if (/^(buat|cetak|print)\s+invoice\b/i.test(lower)) return true;
  if (/^laporan\s+(penjualan|jual)\b/i.test(lower)) return true;
  if (/^(list|daftar)\s+(produk|product|barang|pesanan|order|pelanggan|customer)\b/i.test(lower)) return true;
  return false;
}

function generateInvoice(order: Order): string {
  const lines: string[] = [];
  lines.push(`📋 *INVOICE #${order.id}*`);
  lines.push(`Tanggal: ${new Date(order.created_at).toLocaleDateString("id-ID")}`);
  if (order.customer_name) lines.push(`Pelanggan: ${order.customer_name}`);
  if (order.platform && order.platform !== "offline") lines.push(`Platform: ${order.platform}`);
  lines.push("");
  if (order.items && order.items.length > 0) {
    for (let i = 0; i < order.items.length; i++) {
      const it = order.items[i];
      lines.push(`${i + 1}. ${it.product_name} x${it.qty}  ${Rp(it.unit_price)}  =  ${Rp(it.subtotal)}`);
    }
  }
  lines.push("");
  if (order.discount > 0) lines.push(`Diskon: -${Rp(order.discount)}`);
  if (order.shipping_cost > 0) lines.push(`Ongkir: ${Rp(order.shipping_cost)}`);
  lines.push(`*TOTAL: ${Rp(order.total)}*`);
  lines.push("");
  lines.push(`Status: ${order.status.toUpperCase()}`);
  lines.push("Terima kasih atas pembelian Anda! 🙏");
  return lines.join("\n");
}

async function handleShopCommand(env: Env, owner: number, raw: string): Promise<void> {
  const trimmed = raw.trim();
  const lower = trimmed.toLowerCase();

  // --- /shop or "daftar produk" ---
  if (trimmed === "/shop" || /^daftar\s+(produk|product|barang)/i.test(lower) ||
      trimmed === "/produk" || /^list\s+(produk|product|barang)/i.test(lower)) {
    const products = await listProducts(env, owner);
    if (products.length === 0) {
      await fire(sendMessage(env, owner,
        "📦 *Produk*\n\nBelum ada produk. Tambah: /shop add <nama> <harga> <stok>"));
      return;
    }
    const lines = products.map((p, i) =>
      `${i + 1}. [#${p.id}] *${p.name}* — ${Rp(p.price)} | Stok: ${p.stock}${p.sku ? ` | SKU: ${p.sku}` : ""}`
    );
    await fire(sendMessage(env, owner, `📦 *Daftar Produk* (${products.length})\n\n${lines.join("\n")}`));
    return;
  }

  // --- /shop add <name> <price> <stock> [description] ---
  const addProdMatch = trimmed.match(
    /^(?:\/shop\s+(?:add|tambah)|tambah(?:kan)?|buat(?:kan)?|catat(?:kan)?|simpan|add)\s+(?:produk|product|barang)\s+(.+)$/i,
  );
  if (addProdMatch?.[1]) {
    const args = addProdMatch[1].trim();
    // Parse: name | price | stock | [description]
    // Try pipe-separated first: "Sepatu | 200000 | 50 | Sepatu sport"
    const pipeParts = args.split("|").map(s => s.trim());
    if (pipeParts.length >= 3) {
      const name = pipeParts[0];
      const price = Number(pipeParts[1]);
      const stock = Number(pipeParts[2]);
      const desc = pipeParts[3] || undefined;
      if (!name || isNaN(price) || isNaN(stock)) {
        await fire(sendMessage(env, owner, "Format: tambah produk <nama> | <harga> | <stok> | [deskripsi]"));
        return;
      }
      const id = await addProduct(env, owner, name, price, stock, { description: desc });
      if (id > 0) {
        await fire(sendMessage(env, owner, `✅ Produk ditambahkan: *${name}* — ${Rp(price)} | Stok: ${stock} (id ${id})`));
      } else {
        await fire(sendMessage(env, owner, "Gagal menyimpan produk (error D1)."));
      }
      return;
    }
    // Space-separated: "Sepatu 200000 50"
    const spaceParts = args.split(/\s+/);
    if (spaceParts.length >= 3) {
      const name = spaceParts[0];
      const price = Number(spaceParts[1]);
      const stock = Number(spaceParts[2]);
      if (!name || isNaN(price) || isNaN(stock)) {
        await fire(sendMessage(env, owner, "Format: tambah produk <nama> <harga> <stok>"));
        return;
      }
      const id = await addProduct(env, owner, name, price, stock);
      if (id > 0) {
        await fire(sendMessage(env, owner, `✅ Produk ditambahkan: *${name}* — ${Rp(price)} | Stok: ${stock} (id ${id})`));
      } else {
        await fire(sendMessage(env, owner, "Gagal menyimpan produk (error D1)."));
      }
      return;
    }
    await fire(sendMessage(env, owner, "Format: tambah produk <nama> | <harga> | <stok> | [deskripsi]"));
    return;
  }

  // --- /shop order list or "daftar pesanan" ---
  if (trimmed === "/pesanan" || /^daftar\s+(pesanan|order|penjualan)/i.test(lower) ||
      /^list\s+(pesanan|order)/i.test(lower)) {
    const orders = await listOrders(env, owner);
    if (orders.length === 0) {
      await fire(sendMessage(env, owner,
        "🛒 *Pesanan*\n\nBelum ada pesanan. Buat: /shop order <pelanggan> <produk> x<jumlah>"));
      return;
    }
    const lines = orders.slice(0, 20).map(o =>
      `#${o.id} | ${o.customer_name ?? "-"} | ${Rp(o.total)} | ${o.status} | ${new Date(o.created_at).toLocaleDateString("id-ID")}`
    );
    await fire(sendMessage(env, owner, `🛒 *Daftar Pesanan* (${orders.length})\n\n${lines.join("\n")}`));
    return;
  }

  // --- /shop order <customer> <product> x<qty> [harga] ---
  const orderMatch = trimmed.match(
    /^(?:\/shop\s+order|buat(?:kan)?|catat(?:kan)?)\s+(?:pesanan|order|penjualan)?\s*(.+)$/i,
  );
  if (orderMatch?.[1]) {
    const args = orderMatch[1].trim();
    // Parse: "Budi | Sepatu x2 | Kaos x1" or "Budi Sepatu 2"
    const pipeParts = args.split("|").map(s => s.trim());
    if (pipeParts.length < 2) {
      await fire(sendMessage(env, owner,
        "Format: buat pesanan <pelanggan> | <produk> x<jumlah> | [produk2 x<jumlah2]\n" +
        "Contoh: buat pesanan Budi | Sepatu x2 | Kaos x1"));
      return;
    }
    const customerName = pipeParts[0];
    const items: OrderInput["items"] = [];
    // Fetch products ONCE before the loop (N+1 prevention)
    const allProducts = await listProducts(env, owner);
    for (let i = 1; i < pipeParts.length; i++) {
      const itemStr = pipeParts[i];
      // "Sepatu x2" or "Sepatu 2" or "Sepatu x2 150000"
      const m = itemStr.match(/^(.+?)\s+x?(\d+)(?:\s+(\d+))?$/i);
      if (!m) continue;
      const productName = m[1].trim();
      const qty = Number(m[2]);
      const found = allProducts.find(p => p.name.toLowerCase() === productName.toLowerCase());
      const unitPrice = found ? found.price : (m[3] ? Number(m[3]) : 0);
      items.push({ product_id: found?.id, product_name: productName, qty, unit_price: unitPrice });
    }
    if (items.length === 0) {
      await fire(sendMessage(env, owner, "Format: buat pesanan <pelanggan> | <produk> x<jumlah>"));
      return;
    }
    const orderId = await createOrder(env, owner, { customer_name: customerName, items });
    if (orderId > 0) {
      const order = await getOrder(env, owner, orderId);
      const total = order?.total ?? items.reduce((s, it) => s + it.qty * it.unit_price, 0);
      await fire(sendMessage(env, owner,
        `✅ Pesanan #${orderId} dibuat untuk *${customerName}*. Total: ${Rp(total)}`));
      // Low stock alert
      const low = await lowStockProducts(env, owner);
      if (low.length > 0) {
        const alertLines = low.map(p => `⚠️ *${p.name}* — stok: ${p.stock} (min: ${p.min_stock})`);
        await fire(sendMessage(env, owner, `📦 *Stok Menipis:*\n${alertLines.join("\n")}`));
      }
    } else {
      await fire(sendMessage(env, owner, "Gagal membuat pesanan (error D1)."));
    }
    return;
  }

  // --- /shop invoice <order_id> or "buat invoice <id>" ---
  const invoiceMatch = trimmed.match(
    /^(?:\/(?:shop\s+)?invoice|buat|cetak|print)\s+(?:invoice\s+)?(\d+)$/i,
  );
  if (invoiceMatch?.[1]) {
    const id = Number(invoiceMatch[1]);
    const order = await getOrder(env, owner, id);
    if (!order) {
      await fire(sendMessage(env, owner, `Pesanan #${id} tidak ditemukan.`));
      return;
    }
    const invoice = generateInvoice(order);
    await fire(sendMessage(env, owner, invoice));
    return;
  }

  // --- /shop status <order_id> <new_status> or "status pesanan <id> <status>" ---
  const statusMatch = trimmed.match(
    /^(?:\/shop\s+status|update\s+status)\s+(\d+)\s+(pending|confirmed|paid|shipped|delivered|completed|cancelled)$/i,
  );
  if (statusMatch?.[1] && statusMatch?.[2]) {
    const id = Number(statusMatch[1]);
    const status = statusMatch[2].toLowerCase();
    const ok = await updateOrderStatus(env, owner, id, status);
    await fire(sendMessage(env, owner,
      ok ? `✅ Pesanan #${id} → status *${status}*`
        : `Gagal update status pesanan #${id}. Pastikan ID benar.`));
    return;
  }

  // --- /shop stok or "cek stok" ---
  if (trimmed === "/stok" || /^cek\s+(stok|stock)/i.test(lower)) {
    const products = await listProducts(env, owner);
    if (products.length === 0) {
      await fire(sendMessage(env, owner, "📦 Belum ada produk. Tambah: /shop add <nama> <harga> <stok>"));
      return;
    }
    const lines = products.map(p => {
      const warn = p.stock <= p.min_stock ? " ⚠️" : "";
      return `${p.name}: *${p.stock}* ${p.unit}${warn}`;
    });
    const low = await lowStockProducts(env, owner);
    const header = low.length > 0 ? `⚠️ *${low.length} produk stok menipis!*\n\n` : "";
    await fire(sendMessage(env, owner, `${header}📦 *Stok Produk*\n\n${lines.join("\n")}`));
    return;
  }

  // --- /shop report or "laporan penjualan" ---
  if (trimmed === "/laporan" || /^laporan\s+(penjualan|jual)/i.test(lower)) {
    const now = Date.now();
    const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
    const weekAgo = now - 7 * 86400_000;
    const [daily, weekly] = await Promise.all([
      salesReport(env, owner, todayStart.getTime(), now),
      salesReport(env, owner, weekAgo, now),
    ]);
    const lines: string[] = [];
    lines.push("📊 *Laporan Penjualan*\n");
    lines.push("*Hari Ini:*");
    lines.push(`  Pesanan: ${daily.total_orders} | Omzet: ${Rp(daily.total_revenue)} | Laba: ${Rp(daily.profit)}`);
    if (daily.top_products.length > 0) {
      lines.push(`  Produk terlaris: ${daily.top_products[0].name} (${daily.top_products[0].qty} pcs)`);
    }
    lines.push("");
    lines.push("*7 Hari Terakhir:*");
    lines.push(`  Pesanan: ${weekly.total_orders} | Omzet: ${Rp(weekly.total_revenue)} | Laba: ${Rp(weekly.profit)}`);
    if (weekly.top_products.length > 0) {
      const topList = weekly.top_products.slice(0, 3).map(p => `${p.name} (${p.qty} pcs)`).join(", ");
      lines.push(`  Produk terlaris: ${topList}`);
    }
    await fire(sendMessage(env, owner, lines.join("\n")));
    return;
  }

  // --- /shop customer list or "daftar pelanggan" ---
  if (/^daftar\s+(pelanggan|customer)/i.test(lower) || /^list\s+(pelanggan|customer)/i.test(lower)) {
    const customers = await listCustomers(env, owner);
    if (customers.length === 0) {
      await fire(sendMessage(env, owner, "👤 Belum ada pelanggan. Tambah: /shop customer <nama> | [telepon]"));
      return;
    }
    const lines = customers.slice(0, 20).map((c, i) =>
      `${i + 1}. [#${c.id}] *${c.name}*${c.phone ? ` — ${c.phone}` : ""}${c.platform !== "offline" ? ` (${c.platform})` : ""}`
    );
    await fire(sendMessage(env, owner, `👤 *Daftar Pelanggan* (${customers.length})\n\n${lines.join("\n")}`));
    return;
  }

  // --- /shop customer <name> | [phone] | [address] ---
  const custMatch = trimmed.match(
    /^(?:\/shop\s+customer|tambah(?:kan)?|buat(?:kan)?)\s+(?:pelanggan|customer)\s+(.+)$/i,
  );
  if (custMatch?.[1]) {
    const parts = custMatch[1].split("|").map(s => s.trim());
    const name = parts[0];
    if (!name) {
      await fire(sendMessage(env, owner, "Format: tambah pelanggan <nama> | [telepon] | [alamat]"));
      return;
    }
    const id = await addCustomer(env, owner, name, {
      phone: parts[1] || undefined,
      address: parts[2] || undefined,
    });
    if (id > 0) {
      await fire(sendMessage(env, owner, `✅ Pelanggan ditambahkan: *${name}* (id ${id})`));
    } else {
      await fire(sendMessage(env, owner, "Gagal menyimpan pelanggan (error D1)."));
    }
    return;
  }

  // --- /shop edit <id> price=<n> stock=<n> ---
  const editMatch = trimmed.match(
    /^\/shop\s+edit\s+(\d+)\s+(.+)$/i,
  );
  if (editMatch?.[1] && editMatch?.[2]) {
    const id = Number(editMatch[1]);
    const fields: Record<string, unknown> = {};
    const priceMatch = editMatch[2].match(/price=(\d+)/i);
    const stockMatch = editMatch[2].match(/stock=(\d+)/i);
    if (priceMatch) fields.price = Number(priceMatch[1]);
    if (stockMatch) fields.stock = Number(stockMatch[1]);
    if (Object.keys(fields).length === 0) {
      await fire(sendMessage(env, owner, "Format: /shop edit <id> price=<harga> stock=<stok>"));
      return;
    }
    const ok = await updateProduct(env, owner, id, fields);
    await fire(sendMessage(env, owner,
      ok ? `✅ Produk #${id} diperbarui.`
        : `Gagal update produk #${id}. Pastikan ID benar.`));
    return;
  }

  // --- Fallback: show /shop help ---
  await fire(sendMessage(env, owner,
    "🛒 *J.A.R.V.I.S. Shop*\n\n" +
    "*Produk:*\n" +
    "  /shop — daftar produk\n" +
    "  tambah produk <nama> | <harga> | <stok>\n" +
    "  /shop edit <id> price=<harga> stock=<stok>\n\n" +
    "*Pesanan:*\n" +
    "  /pesanan — daftar pesanan\n" +
    "  buat pesanan <pelanggan> | <produk> x<jumlah>\n" +
    "  /shop status <id> <status>\n\n" +
    "*Lainnya:*\n" +
    "  /stok — cek stok\n" +
    "  /shop invoice <id> — cetak invoice\n" +
    "  /laporan — laporan penjualan\n" +
    "  tambah pelanggan <nama> | [telepon]\n" +
    "  daftar pelanggan"));
}

export { act, OWNER_OK, RATE_LIMIT_MS };
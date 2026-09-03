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

import { Env, touchActivity, logConsent, getConsentRequestTs, getDmsConfig, writeDmsConfig, DmsConfig } from "../lib/db";
import { sendMessage, editMessageReplyMarkup, answerCallbackQuery, TelegramUpdate, InlineButton } from "../lib/telegram";
import {
  routeCommand, markExplicitStop, setAutonomyPaused, isAutonomyPaused, redact,
  setPrivacyMode, isPrivacyMode,
} from "../lib/command_hierarchy";
import { checkIn, runDms } from "../daemons/dead_mans_switch";
import { queueStatus, recordTaskCounters, appendMemory, rememberMemory, recentContext } from "../lib/db";
import { searchAndSynthesize, extractTopic, parseTranslate, translateText } from "../lib/ai";
import { covenantStatusText, signClause } from "../lib/covenant_core";
import { identityStatusText } from "../lib/identity_anchor";
import { getPlans, getScheduledTasks } from "../lib/maestro";
import { getDegradationStatus } from "../lib/degradation";
import {
  listInsights, setPreference, disablePreference, getActivePreferences,
  auditPhantomRules, reflectOnTurn, getBehaviorContext,
} from "../lib/evolution";

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
  const text = msg.text ?? "";

  // Only the owner may drive the mission-critical switch.
  if (!OWNER_OK(env, from)) {
    await fire(sendMessage(env, from, "Perintah tidak diizinkan."));
    return new Response("ok", { status: 200 });
  }
  if (await rateLimited(env, from)) return new Response("ok", { status: 200 });

  await touchActivity(env, from, "telegram");

  // Diagnostic endpoints.
  const trimmed = text.trim().toLowerCase();
  const r = msg.from ? from : 0;
  if (trimmed === "/health") {
    await fire(sendMessage(env, r, "Health: sehat. Resp." + Math.round(Date.now() / 1000)));
    return new Response("ok", { status: 200 });
  }
  if (trimmed === "/dms_status") {
    await fire(sendMessage(env, r, await runDms(env, r)));
    return new Response("ok", { status: 200 });
  }
  if (trimmed === "/queue_status") {
    await fire(sendMessage(env, r, JSON.stringify(await queueStatus(env))));
    return new Response("ok", { status: 200 });
  }
  if (trimmed === "/status") {
    const [paused, cfg] = await Promise.all([
      isAutonomyPaused(env, r),
      getStatusConfig(env, r),
    ]);
    await fire(sendMessage(env, r, statusReport(cfg, paused)));
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
    const on = await isPrivacyMode(env, r);
    await fire(sendMessage(env, r,
      "🔐 *Status Privasi*\n" +
      `Mode: ${on ? "✅ KETAT (ingatan off)" : "⚪ Normal (ingatan on)"}\n` +
      "Gunakan: `/privacy on` untuk hentikan penyimpanan, `/privacy off` untuk lanjut."));
    return new Response("ok", { status: 200 });
  }
  if (trimmed.startsWith("/privacy") && !/^\/privacy( on| off)?$/.test(trimmed)) {
    await fire(sendMessage(env, r, "Gunakan: /privacy (on|off)."));
    return new Response("ok", { status: 200 });
  }
  // Persist explicit 'never/stop' rule (mark_explicit_stop parity).
  if (trimmed.startsWith("/mark_stop") || trimmed.startsWith("/never ")) {
    const phrase = text.replace(/^\/(mark_stop|never)\s+/i, "").trim();
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
    await fire(sendMessage(env, r, await covenantStatusText(env)));
    return new Response("ok", { status: 200 });
  }
  if (trimmed === "/covenant_sign") {
    const clause = text.replace(/^\/covenant_sign\s+/i, "").trim();
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
    const status = await identityStatusText(env);
    await fire(sendMessage(env, r, status));
    return new Response("ok", { status: 200 });
  }
  if (trimmed === "/sunset_preview") {
    await fire(sendMessage(env, r,
      "🌅 *Preview Sunset* (hanya evaluasi — tak ada aksi ireversibel dipicu).\n" +
      "Modul sunset bersifat reading-only; inisiasi memerlukan formulir manual + konfirmasi ganda pemilik."));
    return new Response("ok", { status: 200 });
  }
  if (trimmed === "/degradation_status") {
    const status = await getDegradationStatus(env);
    await fire(sendMessage(env, r,
      `📉 *Degradasi*\nSisa kuota: ${status.remainingPct}%\n` +
      `Fitur dinonaktifkan: ${status.disabledFeatures.length ? status.disabledFeatures.join(", ") : "tidak ada"}`));
    return new Response("ok", { status: 200 });
  }
  if (trimmed === "/maestro_status") {
    const [plans, tasks] = await Promise.all([getPlans(env, r), getScheduledTasks(env, r)]);
    const planLines = plans.length
      ? plans.map((p) => `• ${p.status} — ${p.goal.slice(0, 40)}`).join("\n")
      : "Belum ada rencana.";
    const taskLines = tasks.length
      ? tasks.map((t) => `• ${t.cadence} ${t.approved ? "✅" : "⚠️"} — ${t.description.slice(0, 40)}`).join("\n")
      : "Belum ada tugas terjadwal.";
    await fire(sendMessage(env, r,
      `🪝 *Maestro*\n*Rencana* (n=${plans.length}):\n${planLines}\n\n*Tugas* (n=${tasks.length}):\n${taskLines}`));
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
    const insights = await listInsights(env, false);
    if (insights.length === 0) {
      await fire(sendMessage(env, r, "💡 Belum ada insight. J.A.R.V.I.S. masih belajar dari pengalaman Anda."));
    } else {
      const lines = insights.map((i) =>
        `• #${i.id} [${i.category}] c=${i.confidence.toFixed(2)} bukti=${i.evidenceCount}\n  ${i.ruleText.slice(0, 120)}`,
      ).join("\n");
      await fire(sendMessage(env, r,
        `💡 *Insights yang dipelajari* (${insights.length})\n${lines}\n\nNonaktifkan: /disable-insight <id>`));
    }
    return new Response("ok", { status: 200 });
  }
  if (trimmed.startsWith("/disable-insight")) {
    const id = Number(text.replace(/^\/disable-insight\s*/i, "").trim());
    if (!id) { await fire(sendMessage(env, r, "Gunakan: /disable-insight <id>")); return new Response("ok", { status: 200 }); }
    try {
      const rr = await env.DB.prepare(`UPDATE insights SET disabled=1 WHERE id=? AND disabled=0`).bind(id).run();
      await fire(sendMessage(env, r, rr.meta.changes > 0 ? `📵 Insight #${id} dinonaktifkan.` : `Tidak ada insight aktif #${id}.`));
    } catch { await fire(sendMessage(env, r, "Gagal menonaktifkan insight.")); }
    return new Response("ok", { status: 200 });
  }
  if (trimmed === "/audit-phantom") {
    const audit = await auditPhantomRules(env);
    await fire(sendMessage(env, r, `🛡️ *Audit Phantom*\n${audit}`));
    return new Response("ok", { status: 200 });
  }
  if (trimmed === "/preferences" || trimmed === "/prefs") {
    const prefs = await getActivePreferences(env);
    if (prefs.length === 0) {
      await fire(sendMessage(env, r, "⚙️ Belum ada preferensi. Setel: /set-preference <kunci> = <nilai>"));
    } else {
      const lines = prefs.map((p) => `• \`${p.key}\` = ${p.value.slice(0, 60)} (${p.source}, c=${p.confidence.toFixed(2)})`).join("\n");
      await fire(sendMessage(env, r, `⚙️ *Preferensi aktif*\n${lines}\n\nNonaktifkan: /disable-preference <kunci>`));
    }
    return new Response("ok", { status: 200 });
  }
  const setPref = trimmed.match(/^\/set-preference\s+(.+?)\s*=\s*(.+)$/);
  if (setPref) {
    await fire(sendMessage(env, r, await setPreference(env, setPref[1], setPref[2])));
    return new Response("ok", { status: 200 });
  }
  if (trimmed.startsWith("/disable-preference")) {
    const key = text.replace(/^\/disable-preference\s*/i, "").trim();
    await fire(sendMessage(env, r, await disablePreference(env, key)));
    return new Response("ok", { status: 200 });
  }
  // "/set-preference" but malformed (no "=").
  if (trimmed.startsWith("/set-preference")) {
    await fire(sendMessage(env, r, "Gunakan: /set-preference <kunci> = <nilai>. Contoh: /set-preference format = markdown singkat"));
    return new Response("ok", { status: 200 });
  }

  // ------------------------------------------------------------------
  // Constitution ratification — OWNER-ONLY (enforced by OWNER_OK above, so only
  // the owner's Telegram ID can reach this). The owner's word sits ABOVE the
  // ratification gate: /ratify explicitly encodes the sovereignty constitution,
  // flipping the guard from fail-closed whitelist to the owner-ratified rules.
  // ------------------------------------------------------------------
  if (trimmed === "/ratify") {
    const principle = text.replace(/^\/ratify\s+/i, "").trim();
    if (!principle) {
      await fire(sendMessage(env, r,
        "Gunakan: /ratify <prinsip>\nContoh: /ratify jangan hapus data tanpa persetujuan\n" +
        "Ini menandai konstitusi sebagai diratifikasi oleh pemilik dan menambah aturan kustom."));
      return new Response("ok", { status: 200 });
    }
    const cfg = await getDmsConfig(env, r);
    const constitution = cfg.constitution && typeof cfg.constitution === "object"
      ? { ...cfg.constitution }
      : {};
    const key = `p${Date.now()}`;
    (constitution as Record<string, unknown>)[key] = principle.slice(0, 300);
    await writeDmsConfig(env, r, { ...cfg, constitution });
    await fire(sendMessage(env, r,
      `🧾 Konstitusi diratifikasi.\n` +
      `Aturan ditambahkan: \`${principle.slice(0, 300)}\n` +
      `Status konstitusi kini ✅ diratifikasi (owner: ${String(r)}).`));
    return new Response("ok", { status: 200 });
  }

  // Friendly greeting (INFO, no action) — answered warmly instead of falling
  // into the fail-closed guard. Greetings don't trigger any autonomous step.
  if (trimmed === "/start" || /^(halo|hai|hi|hello|hey|pagi|siang|sore|malam|assalamualaikum|assalamu'alaikum|selamat)/.test(trimmed)) {
    await fire(sendMessage(env, r,
      "Halo. J.A.R.V.I.S. siap. Ketik /status untuk kondisi sistem, atau /health untuk uji sehat."));
    return new Response("ok", { status: 200 });
  }

  // Everything else → compliance pipeline.
  await act(env, r, text);
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
        // Friendly info/query EXECUTE → real search + synthesis (+ memory).
        const r = await searchAndSynthesize(env, owner, text, topic);
        await appendMemory(env, owner, "assistant", r.reply, topic);
        await recordTaskCounters(env, "standard", owner);
        await fire(sendMessage(env, owner, r.reply));
        break;
      }
      await fire(sendMessage(env, owner, applyDefault(res, text)));
      break;
    case "CLARIFY":
      // Offer structured options (L11 python send_clarification parity) instead
      // of guessing. Callback dispatched by the clarify:<corr>:<idx> path above.
      // Persist the original command so the callback can re-route (TTL 5min).
      await env.CONFIG_KV.put(`clarify:${res.decision.correlationId}`, text, { expirationTtl: 300 })
        .catch(() => {/* degrade: callback won't re-route, user re-sends */});
      await fire(sendMessage(env, owner,
        "🤔 *Mohon perjelas.*\n" +
        `Perintah kurang jelas (kepercayaan ${res.intent.confidence.toFixed(2)}).` +
        "\nPilih salah satu, atau ketik jawaban sendiri:",
        { replyMarkup: { inline_keyboard: [
            [{ text: "A) Uji lagi", callback_data: `clarify:${res.decision.correlationId}:0` }],
            [{ text: "B) Override jalankan", callback_data: `clarify:${res.decision.correlationId}:1` }],
            [{ text: "C) Batalkan", callback_data: `clarify:${res.decision.correlationId}:2` }],
        ] } }));
      break;
    case "CONSENT":
      await fire(sendMessage(env, owner,
        `Aksi risiko tinggi terdeteksi. Butuh persetujuan.`,
        { replyMarkup: { inline_keyboard: [[
            { text: "Setujui", callback_data: "consent:" + res.decision.correlationId + ":yes" },
            { text: "Tolak", callback_data: "consent:" + res.decision.correlationId + ":no" },
            { text: "Pause", callback_data: "consent:" + res.decision.correlationId + ":pause" },
        ]] } }));
      break;
    case "BLOCK":
    case "DEFER":
    default:
      await fire(sendMessage(env, owner, "Aksi ditangguhkan."));
  }
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

/** Human reply for the default EXECUTE decision. Kept short (worker-safe). */
function applyDefault(res: Awaited<ReturnType<typeof routeCommand>>, rawText = ""): string {
  const label: Record<number, string> = {
    100: "Sistem/override.",
    90: "Perintah darurat dijalankan.",
    70: "Aksi berisiko disetujui.",
    50: "Status dimuat.",
    30: "Ok.",
  };
  if (extractTopic(rawText)) {
    // Topic is handled by the real search+generative path in act(); this is
    // only a defensive fallback if that path is ever bypassed.
    return "Mencari topik itu. Kirim ulang jika perlu jawaban lebih dalam.";
  }
  return label[res.decision.priority] ?? "Ok.";
}

/** Read whether the owner has ratified a constitution (for /status). */
async function getStatusConfig(env: Env, owner: number): Promise<{ constitutionRatified: boolean }> {
  const cfg: DmsConfig = await getDmsConfig(env, owner);
  const constitutionRatified =
    !!cfg.constitution && typeof cfg.constitution === "object" && Object.keys(cfg.constitution).length > 0;
  return { constitutionRatified };
}

/** Compose the /status reply. */
function statusReport(cfg: { constitutionRatified: boolean }, paused: boolean): string {
  const lines = [
    "📊 *Status J.A.R.V.I.S.*",
    "",
    `• Otonomi: ${paused ? "⏸️ PAUSED" : "▶️ aktif"}`,
    `• Konstitusi: ${cfg.constitutionRatified ? "✅ diratifikasi" : "⚠️ belum diratifikasi (modus fail-closed)"}`,
    ``,
    `Perintah: /health · /dms_status · /queue_status · /pause · /resume · /obedience_report · /ratify`,
  ];
  return lines.join("\n");
}

export { act, OWNER_OK, RATE_LIMIT_MS };
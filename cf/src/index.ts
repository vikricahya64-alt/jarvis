//=====================================================================
// index.ts — single Worker entry (Cloudflare).
// Routes: /healthz, /webhook (Telegram), /setwebhook, /setup, /status,
//         /debug, queue consumer, and cron (scheduled) dispatch.
//
// The free-tier budget (10ms CPU/req, 100k req/day, ≤5 crons) means this
// worker must be small; heavy or cadenced work lives in the DMS daemon and
// the queue consumer, both bounded. All GOTCHA-free, no external SDK.
//=====================================================================

import { Env, auditIntegrity, sweepExpiredProposals, obedienceWeekly, violationSummary, sweepExpiredMemories, consolidateMemories, checkDueReminders, getAgentTask, finishAgentTask, listAgentTasks, failStaleAgentTasks, pruneOldAgentTasks, rememberMemory } from "./lib/db";
import { sanitizeAgentReport, flagAgentReport } from "./lib/agent_executor";
import { fireDueAgentRules } from "./lib/agent_rules";
import { handleUpdate, ensureWebhook } from "./workers/telegram_webhook";
import { setWebhook, sendMessage, getWebhookInfo, getMe, setMyCommands } from "./lib/telegram";
import { runDms } from "./daemons/dead_mans_switch";

import { requireCert } from "./lib/zero_trust";
import { covenantHash } from "./lib/covenant_core";
import { createEpoch, markEpochVerified } from "./lib/identity_anchor";
import { refreshQuotaSnapshot as monitorRefresh } from "./lib/monitor";
import { ddgSearch } from "./lib/ai";
import { acquireCronLock, releaseCronLock } from "./lib/resilience";
import { generateMorningBriefing, runEvolutionLoop, runInsightLifecycle } from "./lib/evolution";
import { runGapUpgradeLoop } from "./lib/gap_upgrade";
import { tickAutonomy } from "./lib/maestro";
import { syncAllSessions } from "./lib/context_manager";
import { runErrorHealLoop } from "./lib/error_monitor";
import { runConfigOptimization } from "./lib/config_optimizer";
import { runDeploySafetyLoop } from "./lib/deploy_safety";
import { runRecoveryLoop } from "./lib/recovery_loop";

const GROQ_MODELS_URL = "https://api.groq.com/openai/v1/models";
const WORKER_URL = "https://jarvis-sovereign.vikricahya64.workers.dev";

const OWNER = (env: Env) => Number(env.OWNER_TELEGRAM_ID || 0);

/** Log request to D1 for monitoring (fire-and-forget). */
async function logRequest(env: Env, path: string, method: string, status: number, startMs: number): Promise<void> {
  const latency = Date.now() - startMs;
  const error = status >= 500 ? 1 : 0;
  try {
    await env.DB.prepare(
      `INSERT INTO request_log (ts, path, method, status_code, latency_ms, error) VALUES (?, ?, ?, ?, ?, ?)`,
    ).bind(Date.now(), path.slice(0, 100), method, status, latency, error).run();
  } catch { /* availability */ }
}

/** Fail-closed visibility: when handleUpdate throws, tell the owner instead of
 *  silently swallowing the message. Best-effort — never throws. */
async function notifyOwnerFailure(
  env: Env,
  update: { callback_query?: { message?: { chat?: { id?: number } } }; message?: { chat?: { id?: number } } },
): Promise<void> {
  try {
    const chatId = update?.callback_query?.message?.chat?.id
      ?? update?.message?.chat?.id
      ?? Number(env.OWNER_TELEGRAM_ID || 0);
    if (!chatId || !env.TELEGRAM_TOKEN) return;
    await sendMessage(
      env,
      chatId,
      "⚠️ Ada gangguan teknis sedang kuperbaiki — mohon ulangi pesan sebentar lagi.",
    );
  } catch { /* availability */ }
}

/** Cron: finalize a new identity epoch and enforce covenant binding. */
async function finalizeIdentityEpoch(env: Env): Promise<void> {
  try {
    const covenantHashVal = await covenantHash(env);
    const previousEpochId = await getCurrentEpochId(env);
    const newEpochId = await createEpoch(env, previousEpochId, covenantHashVal);
    await markEpochVerified(env, newEpochId);
    console.log(`[cron] identity_epoch: ${newEpochId} verified`);
  } catch (e) {
    console.error("[cron] identity_epoch failed", (e as Error).message);
  }
}

async function getCurrentEpochId(env: Env): Promise<string | null> {
  const row = await env.DB.prepare(
    `SELECT epoch_id FROM identity_epochs ORDER BY timestamp DESC LIMIT 1`,
  ).first();
  return (row as { epoch_id: string } | null)?.epoch_id ?? null;
}

/** Register the slash-command menu once a day (KV-guarded, resets often so a
 *  bot upgrade re-publishes the menu). Fail-closed: never throws. */
async function ensureTelegramCommands(env: Env): Promise<void> {
  try {
    const last = await env.CONFIG_KV.get("tg_commands_set");
    if (last === "1") return;
    const ok = await setMyCommands(env);
    if (ok) {
      await env.CONFIG_KV.put("tg_commands_set", "1", { expirationTtl: 82800 }).catch(() => {});
    }
  } catch { /* availability over verbosity */ }
}

/** Environment-adaptive privileged-endpoint gate. */
function certOr(request: Request, fallback: boolean): boolean {
  const hasCertHeaders =
    request.headers.has("Cloudflare-Client-Cert-Verified") &&
    request.headers.has("Cloudflare-Client-Cert-Subject");
  if (!hasCertHeaders) return fallback;
  return requireCert(request).ok;
}

/** Compose + send the Sunday obedience report to the owner via Telegram. */
async function sendWeeklyObedienceReport(env: Env, owner: number): Promise<void> {
  const rows = await obedienceWeekly(env, owner);
  const violated = await violationSummary(env, owner);
  let executed = 0;
  let blocked = 0;
  let pending = 0;
  for (const r of rows) {
    if (r.compliance === "COMPLIANT") executed++;
    else if (r.compliance === "BLOCKED") blocked++;
    else if (r.compliance === "PENDING") pending++;
  }
  const violations = Object.entries(violated)
    .map(([k, v]) => `• ${k}: ${v}×`)
    .join("\n") || "Tidak ada blok konstitusi minggu ini.";
  const lines = [
    "📋 *Laporan Kepatuhan Mingguan J.A.R.V.I.S.*",
    "",
    `Periode: 7 hari terakhir (n=${rows.length})`,
    `• Di-eksekusi (COMPLIANT): ${executed}`,
    `• Diblokir (BLOCKED): ${blocked}`,
    `• Menunggu (PENDING): ${pending}`,
    "",
    `Pelanggaran konstitusi:\n${violations}`,
    "",
    `Lihat /audit_status atau /status untuk detail.`,
  ];
  try {
    await sendMessage(env, owner, lines.join("\n"));
  } catch (e) {
    console.error("[cron] obedience_report send failed", (e as Error).message);
  }
}

export default {
  //----------------------------------------------------------------------
  // HTTP fetch handler
  //----------------------------------------------------------------------
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;
    const startMs = Date.now();

    const respond = async (res: Promise<Response> | Response): Promise<Response> => {
      const r = await res;
      logRequest(env, path, method, r.status, startMs).catch(() => {});
      return r;
    };

    //------------------------------------------------------------------
    // PUBLIC ENDPOINTS (no auth)
    //------------------------------------------------------------------

    // Health check — always 200 if worker is alive.
    if (path === "/healthz") {
      return respond(Response.json({
        ok: true,
        ts: Date.now(),
env: env.APP_ENV ?? "unknown",
        version: "m9-v11.8",
      }));
    }

    //------------------------------------------------------------------
    // TELEGRAM WEBHOOK (secret header verified by Telegram)
    //------------------------------------------------------------------
    if (path === "/webhook") {
      if (method !== "POST") return respond(new Response("POST only", { status: 405 }));
      // Verify Telegram's secret token header (if configured).
      if (env.TELEGRAM_SECRET) {
        const got = request.headers.get("x-telegram-bot-api-secret-token");
        if (got !== env.TELEGRAM_SECRET) {
          return respond(new Response("unauthorized", { status: 401 }));
        }
      }
      let update: Parameters<typeof handleUpdate>[1];
      try {
        update = (await request.json()) as Parameters<typeof handleUpdate>[1];
      } catch {
        return respond(new Response("bad json", { status: 400 }));
      }
      // Idempotency: dedupe by update_id (KV, 48h TTL).
      const updId = update?.update_id;
      if (updId != null) {
        try {
          const seen = await env.CONFIG_KV.get(`upd:${updId}`);
          if (seen) return respond(new Response("ok", { status: 200 }));
        } catch { /* availability over dedupe */ }
        let res: Response;
        try {
          res = await handleUpdate(env, update);
        } catch (e) {
          console.error("[webhook] handleUpdate error:", (e as Error).message, (e as Error).stack);
          // NEVER silent: any internal exception still tells the owner what
          // happened instead of dropping their message without a trace.
          await notifyOwnerFailure(env, update);
          res = new Response("ok", { status: 200 }); // always 200 to prevent Telegram retry storm
        }
        await env.CONFIG_KV.put(`upd:${updId}`, "1", { expirationTtl: 172800 }).catch(() => {});
        return respond(res);
      }
      let res2: Response;
      try {
        res2 = await handleUpdate(env, update);
      } catch (e) {
        console.error("[webhook] handleUpdate error:", (e as Error).message);
        await notifyOwnerFailure(env, update);
        res2 = new Response("ok", { status: 200 });
      }
      return respond(res2);
    }

    //------------------------------------------------------------------
    // AUTHENTICATED ENDPOINTS (require token)
    //------------------------------------------------------------------
    const tokenParam = url.searchParams.get("token");
    const isAuth = tokenParam === env.TELEGRAM_SECRET || tokenParam === env.TELEGRAM_TOKEN;
    const authed = certOr(request, isAuth);

    // /setup — re-configure Telegram webhook (owner only).
    if (path === "/setup") {
      if (!authed) return respond(new Response("unauthorized", { status: 401 }));
      const webhookUrl = url.searchParams.get("url") ?? WORKER_URL + "/webhook";
      try {
        await setWebhook(env, webhookUrl, env.TELEGRAM_SECRET);
        await ensureTelegramCommands(env);
        const info = await getWebhookInfo(env);
        return respond(Response.json({
          ok: true,
          webhook: { url: webhookUrl, configured: true },
          telegram: {
            current_url: info.url,
            pending_updates: info.pending_update_count,
            last_error: info.last_error_message ?? null,
          },
        }));
      } catch (e) {
        return respond(Response.json({ ok: false, error: (e as Error).message }, { status: 500 }));
      }
    }

    // /status — comprehensive system status (owner only).
    if (path === "/status") {
      if (!authed) return respond(new Response("unauthorized", { status: 401 }));
      const owner = OWNER(env);
      try {
        // Check D1
        const d1Ok = await env.DB.prepare("SELECT 1").first().then(() => true).catch(() => false);
        // Check KV
        const kvOk = await env.CONFIG_KV.get("__probe__").then(() => true).catch(() => true);
        // Check Telegram bot
        let botInfo = "unknown";
        try {
          const me = await getMe(env);
          botInfo = `@${me.username ?? "unknown"} (${me.first_name})`;
        } catch { botInfo = "error"; }
        // Check webhook
        let webhookInfo = "unknown";
        try {
          const wh = await getWebhookInfo(env);
          webhookInfo = wh.url ? `set (${wh.pending_update_count} pending)` : "NOT SET";
        } catch { webhookInfo = "error"; }

        return respond(Response.json({
          ok: true,
ts: Date.now(),
          version: "m9-v11.8",
          systems: {
            d1: d1Ok ? "✅" : "❌",
            kv: kvOk ? "✅" : "❌",
            telegram_bot: botInfo,
            webhook: webhookInfo,
            owner_id: owner,
          },
          env: env.APP_ENV ?? "unknown",
        }));
      } catch (e) {
        return respond(Response.json({ ok: false, error: (e as Error).message }, { status: 500 }));
      }
    }

    // /debug — webhook diagnostic (owner only, no secrets exposed).
    if (path === "/debug") {
      if (!authed) return respond(new Response("unauthorized", { status: 401 }));
      const diag: Record<string, unknown> = { ts: Date.now() };
      try {
        const wh = await getWebhookInfo(env);
        diag.webhook = {
          url: wh.url,
          pending: wh.pending_update_count,
          has_custom_cert: wh.has_custom_certificate,
          last_error: wh.last_error_message ?? null,
        };
      } catch (e) {
        diag.webhook = { error: (e as Error).message };
      }
      diag.config = {
        has_telegram_secret: Boolean(env.TELEGRAM_SECRET),
        has_telegram_token: Boolean(env.TELEGRAM_TOKEN),
        has_groq_key: Boolean(env.GROQ_API_KEY),
        has_openrouter_key: Boolean(env.OPENROUTER_API_KEY),
        owner_id: OWNER(env),
      };
      return respond(Response.json(diag));
    }

    // /setwebhook — legacy webhook setter.
    if (path === "/setwebhook") {
      if (!authed) return respond(new Response("unauthorized", { status: 401 }));
      const target = url.searchParams.get("url") ?? WORKER_URL + "/webhook";
      await setWebhook(env, target, env.TELEGRAM_SECRET);
      await ensureTelegramCommands(env);
      return respond(Response.json({ ok: true, target }));
    }

    // /ai_diag — AI/search diagnostic.
    if (path === "/ai_diag") {
      if (!authed) return respond(new Response("unauthorized", { status: 401 }));
      const key = env.GROQ_API_KEY ?? "";
      const ddgProbe = await ddgSearch(env, "sejarah komputer").then((r) => (r ? r.slice(0, 60) : null)).catch(() => null);
      let groqModels = "unset";
      if (key) {
        try {
          const res = await fetch(GROQ_MODELS_URL, { headers: { Authorization: `Bearer ${key}` } });
          groqModels = res.ok ? "ok" : `http_${res.status}`;
        } catch { groqModels = "err"; }
      }
      return respond(Response.json({
        ok: true,
        groqKey: key ? `set(len=${key.length})` : "unset",
        groqModels,
        ddg: ddgProbe ? "reachable" : "unreachable",
        ddgProbe,
        ts: Date.now(),
      }));
    }

    // /audit_status — read-only audit integrity report.
    if (path === "/audit_status") {
      if (!authed) return respond(new Response("unauthorized", { status: 401 }));
      const summary = await auditIntegrity(env);
      return respond(Response.json({ ok: true, ts: Date.now(), ...summary }));
    }

    //------------------------------------------------------------------
    // AGENT executor callbacks (GitHub Actions ↔ worker bridge)
    // These let JARVIS "borrow" real-world execution from a FREE cloud VM
    // (opencode headless on a GitHub runner). Auth = AGENT_TOKEN (a shared
    // secret also stored as a GitHub Actions secret + worker secret).
    //------------------------------------------------------------------

    // /agent/env?key=<ALLOWED> — the workflow fetches the LLM key it needs to
    // run opencode, so the provider key lives ONLY in the worker env (already
    // there) and never needs to be duplicated into GitHub.
    if (path === "/agent/env") {
      const tok = url.searchParams.get("token");
      if (!env.AGENT_TOKEN || tok !== env.AGENT_TOKEN) {
        return respond(new Response("unauthorized", { status: 401 }));
      }
      const key = url.searchParams.get("key") ?? "";
      const ALLOWED = new Set([
        "OPENROUTER_API_KEY", "OPENROUTER_MODEL", "GROQ_API_KEY",
        "GEMINI_API_KEY", "GEMINI_API_KEY_BACKUP", "GEMINI_API_KEY_SECONDARY", "GEMINI_MODEL",
      ]);
      if (!ALLOWED.has(key)) return respond(new Response("forbidden", { status: 403 }));
      const value = (env as unknown as Record<string, string | undefined>)[key] ?? "";
      return respond(Response.json({ ok: Boolean(value), key, value }));
    }

    // /agent/done — the executor reports the task outcome. Verified by
    // AGENT_TOKEN; updates D1 and DMs the owner (best-effort).
    if (path === "/agent/done") {
      const tok = url.searchParams.get("token");
      if (!env.AGENT_TOKEN || tok !== env.AGENT_TOKEN) {
        return respond(new Response("unauthorized", { status: 401 }));
      }
      if (method !== "POST") return respond(new Response("POST only", { status: 405 }));
      let body: { task_id?: number; status?: string; result?: string; error?: string; artifact_url?: string };
      try {
        body = (await request.json()) as typeof body;
      } catch {
        return respond(new Response("bad json", { status: 400 }));
      }
      const tid = Number(body?.task_id);
      const st = body?.status;
      if (!Number.isFinite(tid) || tid <= 0) return respond(new Response("bad task_id", { status: 400 }));
      const task = await getAgentTask(env, tid);
      if (!task) return respond(new Response("no such task", { status: 404 }));
      if (st !== "done" && st !== "failed") return respond(new Response("bad status", { status: 400 }));
      // Replay/duplicate guard (M6): only the FIRST report from the executor
      // wins. A finished task must never be re-finalized or re-DM'd by a
      // replayed (or malicious re-posted) /agent/done with the same token.
      if (task.status !== "running") {
        return respond(new Response("already terminal", { status: 409 }));
      }
      const rawResult = sanitizeAgentReport(body?.result ?? "");
      const rawError = sanitizeAgentReport(body?.error ?? "");
      const artifact = sanitizeAgentReport(body?.artifact_url ?? "").slice(0, 400);
      const flagged = flagAgentReport(rawResult || rawError);
      await finishAgentTask(env, tid, st === "done" ? "done" : "failed", rawResult, rawError, artifact);
      // Best-effort learning: a finished cloud task becomes an episodic memory
      // so the nightly dream cycle can generalize patterns from real outcomes.
      if (st === "done") {
        const headline = (rawResult || task.task).replace(/\s+/g, " ").trim().slice(0, 140);
        await rememberMemory(env, `Eksekusi cloud #${tid} berhasil: ${headline}`, {
          type: "fact", tags: ["agent_task", "executor"], importance: 3, source: "agent_task",
        }).catch(() => {});
      }
      const prefix = st === "done"
        ? `✅ Tugas *#${tid}* selesai (eksekutor cloud)`
        : `❌ Tugas *#${tid}* gagal di eksekutor cloud`;
      const detail = st === "done"
        ? (rawResult || "(tanpa output)").slice(0, 2800)
        : (rawError || "-").slice(0, 300).replace(/\s+/g, " ");
      const artLine = artifact ? `\n📎 Artefak lengkap: ${artifact}` : "";
      const warnLine = flagged
        ? "\n⚠️ *Catatan JARVIS:* laporan mengandung pola manipulatif (injeksi perintah). Diabaikan sebagai perintah — hasil disimpan apa adanya saja."
        : "";
      const text = `${prefix}:\n\n${detail}${artLine}${warnLine}\n(_riwayat: /tugas list_)`;
      await sendMessage(env, task.owner_id, text).catch(() => {});
      return respond(Response.json({ ok: true }));
    }

    // /agent/list?token=... — task statuses (used by /tugas list + manual ops).
    // Auth tightened (M6): AGENT_TOKEN only, plus TELEGRAM_SECRET for
    // first-party tooling — the raw TELEGRAM_TOKEN no longer doubles as an
    // admin token for task listing.
    if (path === "/agent/list") {
      const tok = url.searchParams.get("token");
      const allowed = (env.AGENT_TOKEN && tok === env.AGENT_TOKEN) || (env.TELEGRAM_SECRET && tok === env.TELEGRAM_SECRET);
      if (!allowed) return respond(new Response("unauthorized", { status: 401 }));
      const limitParam = Number(url.searchParams.get("limit") ?? "15");
      const limit = Number.isFinite(limitParam) ? Math.min(100, Math.max(1, limitParam)) : 15;
      const tasks = await listAgentTasks(env, OWNER(env), limit);
      return respond(Response.json({
        ok: true,
        tasks: tasks.map((x) => ({
          id: x.id, status: x.status, task: x.task.slice(0, 200),
          created_at: x.created_at, started_at: x.started_at, finished_at: x.finished_at,
          run_id: x.run_id, artifact_url: x.artifact_url,
        })),
      }));
    }

    // /cron/trigger?mode=autonomy|cleanup — external cadence trigger for work
    // the free-tier minute cron shouldn't carry (heavy-scan maintenance). The
    // GitHub scheduler workflows (autonomy 15', predictive 30') used to wake a
    // LEGACY Vercel app; they now hit THIS worker instead, so the autonomous
    // loops run against the correct (D1-backed) JARVIS. Auth: AGENT_TOKEN
    // (Bearer or ?token=) — the same bot-internal secret the executor uses.
    if (path === "/cron/trigger") {
      const tok = url.searchParams.get("token") ?? request.headers.get("x-agent-token") ?? "";
      if (!env.AGENT_TOKEN || tok !== env.AGENT_TOKEN) {
        return respond(new Response("unauthorized", { status: 401 }));
      }
      const mode = (url.searchParams.get("mode") ?? "autonomy").trim();
      if (mode === "autonomy") {
        const stale = await failStaleAgentTasks(env);
        const pruned = await pruneOldAgentTasks(env);
        return respond(Response.json({ ok: true, mode, actions: { stale_failed: stale, pruned } }));
      }
      if (mode === "cleanup") {
        const mem = await sweepExpiredMemories(env);
        const prop = await sweepExpiredProposals(env);
        return respond(Response.json({ ok: true, mode, actions: { memories_swept: mem, proposals_swept: prop } }));
      }
      return respond(new Response("bad mode", { status: 400 }));
    }

    // /dl/:uuid — one-time-ish temp file for the executor (B1 document
    // analysis). The webhook stores the (≤15 MiB) document under a random
    // uuid in CONFIG_KV with a 30-min TTL; the runner downloads it here.
    // Unguessable uuid + short TTL is the free-tier-safe trade-off.
    if (path.startsWith("/dl/")) {
      const uuid = decodeURIComponent(path.slice(4));
      const stored = await env.CONFIG_KV.get(`dl:${uuid}`).catch(() => null);
      if (!stored) return respond(new Response("not found", { status: 404 }));
      try {
        const rec = JSON.parse(stored) as { mime?: string; b64?: string; s?: string };
        if (!rec.b64) return respond(new Response("not found", { status: 404 }));
        const q = new URL(url).searchParams;
        if (rec.s && q.get("s") !== rec.s) return respond(new Response("forbidden", { status: 403 }));
        const bytes = Uint8Array.from(atob(rec.b64), (c) => c.charCodeAt(0));
        return respond(new Response(bytes, {
          headers: { "Content-Type": rec.mime ?? "application/octet-stream" },
        }));
      } catch {
        return respond(new Response("bad payload", { status: 400 }));
      }
    }

    //------------------------------------------------------------------
    // CATCH-ALL
    //------------------------------------------------------------------
    return respond(new Response("not found", { status: 404 }));
  },

  //----------------------------------------------------------------------
  // Scheduled (cron) handler — dispatch by trigger name.
  //----------------------------------------------------------------------
  async scheduled(controller: ScheduledController, env: Env): Promise<void> {
    const cron = controller.cron;
    const owner = OWNER(env);
    const start = Date.now();

    const lockName = `cron:${cron}`;
    const haveLock = await acquireCronLock(env, lockName);
    if (!haveLock) {
      console.log(`[cron:${cron}] skipped (lock held) (${Date.now() - start}ms)`);
      return;
    }

    try {
      if (cron === "0 */6 * * *") {
        const msg = await runDms(env, owner);
        console.log(`[cron] dms: ${msg} (${Date.now() - start}ms)`);
        await finalizeIdentityEpoch(env);
        await monitorRefresh(env, owner);
        const memResult = await consolidateMemories(env);
        console.log(`[cron] memory_loop: decayed=${memResult.decayed} swept=${memResult.swept} cleaned=${memResult.cleaned} (${Date.now() - start}ms)`);
        const sessionResult = await syncAllSessions(env);
        console.log(`[cron] session_loop: saved=${sessionResult.saved} pruned=${sessionResult.pruned} (${Date.now() - start}ms)`);
        const healResult = await runErrorHealLoop(env);
        console.log(`[cron] error_loop: scanned=${healResult.scanned} diagnosed=${healResult.diagnosed} fixes=${healResult.fixGenerated} (${Date.now() - start}ms)`);
        const safetyResult = await runDeploySafetyLoop(env);
        console.log(`[cron] deploy_safety: health=${safetyResult.health.healthScore} reverted=${safetyResult.autoReverted} patterns=${safetyResult.patternsDetected} (${Date.now() - start}ms)`);
        const recoveryResult = await runRecoveryLoop(env);
        console.log(`[cron] recovery: patterns=${recoveryResult.patternsDetected} auto_fixed=${recoveryResult.fixesApplied} manual=${recoveryResult.manualNeeded} (${Date.now() - start}ms)`);
      } else if (cron === "0 3 * * *") {
        const expired = await sweepExpiredProposals(env);
        console.log(`[cron] value_alignment: ${expired} expired (${Date.now() - start}ms)`);
        const insightLife = await runInsightLifecycle(env);
        console.log(`[cron] insight_lifecycle: validated=${insightLife.validated} promoted=${insightLife.promoted} (${Date.now() - start}ms)`);
        await ensureTelegramCommands(env);
        const optResult = await runConfigOptimization(env);
        console.log(`[cron] config_opt: applied=${optResult.applied.length} suggestions=${optResult.suggestions.length} (${Date.now() - start}ms)`);
      } else if (cron === "0 8 * * 0" || cron === "0 8 * * *") {
        const isSunday = new Date().getUTCDay() === 0;
        if (isSunday) {
          await sendWeeklyObedienceReport(env, owner);
          console.log(`[cron] obedience_report: sent (${Date.now() - start}ms)`);
        } else {
          console.log(`[cron] obedience_report: skip (not Sunday)`);
        }
      } else if (cron === "0 7 * * *") {
        const evoResult = await runEvolutionLoop(env);
        console.log(`[cron] evolution_loop: scanned=${evoResult.dreamResult.scanned} insights=${evoResult.dreamResult.insightsExtracted} affinity_cats=${evoResult.affinityCategories} drift=${evoResult.driftDetected} (${Date.now() - start}ms)`);
        const gapUp = await runGapUpgradeLoop(env);
        console.log(`[cron] gap_upgrade: rows=${gapUp.analyzed} gapped=${gapUp.proposed.length} opened=${gapUp.opened} deduped=${gapUp.deduped} (${Date.now() - start}ms)`);
        const briefing = await generateMorningBriefing(env, owner);
        // A nursing gap with a fresh auto-proposal joins the briefing (one message).
        const briefingText =
          briefing && gapUp.opened > 0
            ? `${briefing}\n\n🩺 *Auto-proposal gap→upgrade*\n${gapUp.proposed
                .map((p) => `  • *${p.cap}* — ${p.failureClass} (×${p.count}): ${p.fix}`)
                .join("\n")}`
            : briefing;
        if (briefingText) {
          await sendMessage(env, owner, briefingText);
          console.log(`[cron] morning_briefing: sent ${briefingText.length} chars`);
        } else {
          console.log(`[cron] morning_briefing: skip`);
        }
      } else if (cron === "* * * * *") {
        const due = await checkDueReminders(env);
        if (due.length) {
          for (const r of due) {
            await sendMessage(env, r.ownerId,
              `⏰ *Pengingat*\n\n${r.text}\n\n(Sudah selesai? kirim /reminder hapus <id> untuk menonaktifkan, atau abaikan.)`
            ).catch(() => {/* best-effort: marking already done on the D1 side */});
          }
          console.log(`[cron] reminders: fired=${due.length} (${Date.now() - start}ms)`);
        }
        // Autonomy pulse: advance delegated plans one step + fire due recurring
        // tasks (both LOW-risk only, covenant + /pause-guarded). Owner is
        // notified only when something actually moved.
        const auto = await tickAutonomy(env, owner);
        if (auto.plans > 0 || auto.tasksFired > 0 || auto.pendingConsent > 0) {
          const lines = [
            auto.plans > 0 ? `⚙️ ${auto.plans} langkah rencana otonom dijalankan.` : "",
            auto.tasksFired > 0 ? `✅ ${auto.tasksFired} tugas terjadwal otomatis dijalankan.` : "",
            auto.pendingConsent > 0 ? `⚠️ ${auto.pendingConsent} tugas terjadwal (risk menengah/tinggi) menunggu persetujuan — tidak dijalankan otomatis.` : "",
          ].filter(Boolean);
          await sendMessage(env, owner, lines.join("\n") + "\n(_sementara berhenti: /pause_)").catch(() => {});
          console.log(`[cron] autonomy: plans=${auto.plans} tasks=${auto.tasksFired} consent=${auto.pendingConsent} (${Date.now() - start}ms)`);
        }
        // Recurring heavy tasks: create instances for due rules + dispatch.
        const rules = await fireDueAgentRules(env);
        if (rules.fired > 0 || rules.failed > 0) {
          console.log(`[cron] agent_rules: fired=${rules.fired} failed=${rules.failed} (${Date.now() - start}ms)`);
        } else if (rules.paused) {
          console.log(`[cron] agent_rules: paused /pause aktif`);
        }
        // M8-v25: self-heal the Telegram webhook config (explicitly include
        // callback_query in allowed_updates) and drain any straggling cron work.
        await ensureWebhook(env);
      }
    } catch (e) {
      console.error(`[cron:${cron}] failed`, (e as Error).message);
    } finally {
      await new Promise((r) => setTimeout(r, 0));
      await releaseCronLock(env, lockName);
    }
  },
} satisfies ExportedHandler<Env>;

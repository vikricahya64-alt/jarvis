//=====================================================================
// index.ts — single Worker entry (Cloudflare).
// Routes: /healthz, /webhook (Telegram), /setwebhook, /setup, /status,
//         /debug, queue consumer, and cron (scheduled) dispatch.
//
// The free-tier budget (10ms CPU/req, 100k req/day, ≤5 crons) means this
// worker must be small; heavy or cadenced work lives in the DMS daemon and
// the queue consumer, both bounded. All GOTCHA-free, no external SDK.
//=====================================================================

import { Env, auditIntegrity, sweepExpiredProposals, obedienceWeekly, violationSummary, sweepExpiredMemories, consolidateMemories } from "./lib/db";
import { handleUpdate } from "./workers/telegram_webhook";
import { setWebhook, sendMessage, getWebhookInfo, getMe } from "./lib/telegram";
import { runDms } from "./daemons/dead_mans_switch";
import { processMessage, escalateToDms, TaskMessage } from "./workers/task_processor";
import { requireCert } from "./lib/zero_trust";
import { covenantStatusText, validateActionAgainstCovenant, signClause, isCovenantManagement, covenantHash } from "./lib/covenant_core";
import { identityStatusText, createEpoch, verifyContinuity, markEpochVerified } from "./lib/identity_anchor";
import { refreshQuotaSnapshot as monitorRefresh } from "./lib/monitor";
import { ddgSearch } from "./lib/ai";
import { acquireCronLock, releaseCronLock } from "./lib/resilience";
import { runDreamCycle, generateMorningBriefing, decayPreferences, runEvolutionLoop } from "./lib/evolution";
import { offerSuggestions } from "./lib/predictive";
import { syncAllSessions } from "./lib/context_manager";
import { runErrorHealLoop } from "./lib/error_monitor";
import { runConfigOptimization } from "./lib/config_optimizer";
import { runDeploySafetyLoop, recordDeploy } from "./lib/deploy_safety";
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

/** Environment-adaptive privileged-endpoint gate. */
function certOr(request: Request, fallback: boolean): boolean {
  const hasCertHeaders =
    request.headers.has("Cloudflare-Client-Cert-Verified") &&
    request.headers.has("Cloudflare-Client-Cert-Subject");
  if (!hasCertHeaders) return fallback;
  return requireCert(request).ok;
}

/** Read a numeric env var with a default. */
function numberOrDefault(env: Env, key: string, dflt: number): number {
  const raw = env[key as keyof Env];
  if (typeof raw !== "string" || raw === "") return dflt;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : dflt;
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
        version: "7b188158",
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
          version: "7b188158",
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
        const briefing = await generateMorningBriefing(env, owner);
        if (briefing) {
          await sendMessage(env, owner, briefing);
          console.log(`[cron] morning_briefing: sent ${briefing.length} chars`);
        } else {
          console.log(`[cron] morning_briefing: skip`);
        }
        const sugg = await offerSuggestions(env, owner);
        if (sugg) {
          await sendMessage(env, owner, sugg);
          console.log(`[cron] suggestions: sent ${sugg.length} chars`);
        } else {
          console.log(`[cron] suggestions: skip`);
        }
      }
    } catch (e) {
      console.error(`[cron:${cron}] failed`, (e as Error).message);
    } finally {
      await new Promise((r) => setTimeout(r, 0));
      await releaseCronLock(env, lockName);
    }
  },

  //----------------------------------------------------------------------
  // Queue consumer entry — bound consumer ("jarvis-tasks").
  //----------------------------------------------------------------------
  async queue(batch: MessageBatch<unknown>, env: Env): Promise<void> {
    for (const message of batch.messages) {
      const msg = message.body as TaskMessage;
      const outcome = await processMessage(env, msg);
      if (outcome === "ok") {
        message.ack();
      } else if (outcome === "retry") {
        const attemptsSoFar = message.attempts ?? 1;
        const maxRetries = numberOrDefault(env, "QUEUE_MAX_RETRIES", 3);
        if (attemptsSoFar >= maxRetries) {
          await escalateToDms(env, msg.ownerId, `queue_dlq for ${msg.correlationId}`);
        }
      }
    }
  },
} satisfies ExportedHandler<Env>;

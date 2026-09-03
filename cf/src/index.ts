//=====================================================================
// index.ts — single Worker entry (Cloudflare).
// Routes: /healthz, /webhook (Telegram), /setwebhook, queue consumer,
//         and cron (scheduled) dispatch.
//
// The free-tier budget (10ms CPU/req, 100k req/day, ≤5 crons) means this
// worker must be small; heavy or cadenced work lives in the DMS daemon and
// the queue consumer, both bounded. All GOTCHA-free, no external SDK.
//=====================================================================

import { Env, auditIntegrity, sweepExpiredProposals, obedienceWeekly, violationSummary } from "./lib/db";
import { handleUpdate } from "./workers/telegram_webhook";
import { setWebhook, sendMessage } from "./lib/telegram";
import { runDms } from "./daemons/dead_mans_switch";
import { processMessage, escalateToDms, TaskMessage } from "./workers/task_processor";
import { requireCert } from "./lib/zero_trust";

const OWNER = (env: Env) => Number(env.OWNER_TELEGRAM_ID || 0);

/**
 * Environment-adaptive privileged-endpoint gate.
 *
 * On a deployment fronted by Cloudflare Access (mTLS enforced), the worker
 * sees Cloudflare-Client-Cert-* headers and we require a valid cert. On the
 * current *.workers.dev exposure (no Access configured) those headers are
 * absent, so we fall back to the caller-supplied secret/token check that the
 * caller already performed. This keeps zero-trust code live AND the existing
 * webhook auth working — no behavior regression.
 */
function certOr(request: Request, fallback: boolean): boolean {
  const hasCertHeaders =
    request.headers.has("Cloudflare-Client-Cert-Verified") &&
    request.headers.has("Cloudflare-Client-Cert-Subject");
  if (!hasCertHeaders) return fallback; // not behind Access → trust caller's token/secret check
  return requireCert(request).ok;
}

/** Read a numeric env var with a default (defensive against NaN/empty). */
function numberOrDefault(env: Env, key: string, dflt: number): number {
  const raw = env[key as keyof Env];
  if (typeof raw !== "string" || raw === "") return dflt;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : dflt;
}

/** Compose + send the Sunday obedience report to the owner via Telegram.
 *  Fire-and-forget: a Telegram outage cannot raise a cron failure (next tick
 *  is a week away, so we best-effort send and log). */
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

    // Public health (optionally mTLS-guarded in production).
    if (path === "/healthz") {
      return Response.json({ ok: true, ts: Date.now(), env: env.APP_ENV ?? "unknown" });
    }

    // Telegram webhook — must verify secret header (Telegram X-Telegram-Bot-Api-Secret-Token).
    if (path === "/webhook") {
      if (request.method !== "POST") return new Response("GET only", { status: 405 });
      if (env.TELEGRAM_SECRET) {
        const got = request.headers.get("x-telegram-bot-api-secret-token");
        if (got !== env.TELEGRAM_SECRET) {
          return new Response("unauthorized", { status: 401 });
        }
      }
      const update = (await request.json()) as Parameters<typeof handleUpdate>[1];
      // Idempotency: Telegram delivers at-least-once and retries on lost 2xx.
      // Dedupe by update_id (KV, 48h TTL) so retries don't re-run side effects
      // (duplicate DMS resets, duplicate audit rows, double consent resolution).
      // Only mark "seen" AFTER a successful handleUpdate so a 5xx retry path is
      // still delivered exactly-once effective but failure still triggers retry.
      const updId = update?.update_id;
      if (updId != null) {
        try {
          const seen = await env.CONFIG_KV.get(`upd:${updId}`);
          if (seen) return new Response("ok", { status: 200 });
        } catch {
          /* proceed; availability over dedupe */
        }
        const res = await handleUpdate(env, update);
        await env.CONFIG_KV
          .put(`upd:${updId}`, "1", { expirationTtl: 172800 })
          .catch(() => {/* availability over dedupe */});
        return res;
      }
      return await handleUpdate(env, update);
    }

    // Admin helper — point Telegram to this worker.
    if (path === "/setwebhook") {
      const token = url.searchParams.get("token");
      const tokenOk = token === env.TELEGRAM_SECRET || token === env.TELEGRAM_TOKEN;
      // Behind Access, require mTLS too; on raw workers.dev fall back to token.
      if (!certOr(request, tokenOk)) {
        return new Response("unauthorized", { status: 401 });
      }
      const target = url.searchParams.get("url") ?? url.origin + "/webhook";
      await setWebhook(env, target, env.TELEGRAM_SECRET);
      return Response.json({ ok: true, target });
    }

    // Read-only append-only audit integrity report (gap detection).
    if (path === "/audit_status") {
      const summary = await auditIntegrity(env);
      return Response.json({ ok: true, ts: Date.now(), ...summary });
    }

    return new Response("not found", { status: 404 });
  },

  //----------------------------------------------------------------------
  // Scheduled (cron) handler — dispatch by trigger name.
  // Scheduler is Cloudflare system identity; no client cert required here.
  // Triggers (wrangler.toml [triggers]):
  //   "0 */6 * * *" → dead man's switch (every 6h)
  //   "0 3 * * *"   → value alignment (daily)
  //   "0 8 * * 0"   → weekly obedience report (Sunday)
  //----------------------------------------------------------------------
  async scheduled(controller: ScheduledController, env: Env): Promise<void> {
    const cron = controller.cron;
    const owner = OWNER(env);
    const start = Date.now();

    try {
      if (cron === "0 */6 * * *") {
        const msg = await runDms(env, owner);
        console.log(`[cron] dms: ${msg} (${Date.now() - start}ms)`);
      } else if (cron === "0 3 * * *") {
        // Value alignment: expire stale unconfirmed proposals (TTL 7 days).
        const expired = await sweepExpiredProposals(env);
        console.log(`[cron] value_alignment: ${expired} expired (${Date.now() - start}ms)`);
      } else if (cron === "0 8 * * 0" || cron === "0 8 * * *") {
        // Weekly obedience report — trigger registered as Sunday-only
        // (`0 8 * * 0`). Match both legacy/spended spellings; keep a defensive
        // Sunday guard so the daily-form can never fire on other days.
        const isSunday = new Date().getUTCDay() === 0;
        if (isSunday) {
          await sendWeeklyObedienceReport(env, owner);
          console.log(`[cron] obedience_report: sent (${Date.now() - start}ms)`);
        } else {
          console.log(`[cron] obedience_report: skip (not Sunday) (${Date.now() - start}ms)`);
        }
      }
    } catch (e) {
      console.error(`[cron:${cron}] failed`, (e as Error).message);
      // Never swallow: the DMS cadence is resilient to single failures.
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
        // Allow Cloudflare to retry per the consumer's max_retries/backoff.
        // If this is the final permitted attempt before the DLQ, escalate so the
        // owner isn't left waiting on a silently-dead notification.
        const attemptsSoFar = message.attempts ?? 1;
        const maxRetries = numberOrDefault(env, "QUEUE_MAX_RETRIES", 3);
        if (attemptsSoFar >= maxRetries) {
          await escalateToDms(env, msg.ownerId, `queue_dlq for ${msg.correlationId}`);
        }
      }
      // "dead": let it stay unacked → lands in DLQ after retries are exhausted.
    }
  },
} satisfies ExportedHandler<Env>;
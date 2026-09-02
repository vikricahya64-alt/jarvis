//=====================================================================
// index.ts — single Worker entry (Cloudflare).
// Routes: /healthz, /webhook (Telegram), /setwebhook, queue consumer,
//         and cron (scheduled) dispatch.
//
// The free-tier budget (10ms CPU/req, 100k req/day, ≤5 crons) means this
// worker must be small; heavy or cadenced work lives in the DMS daemon and
// the queue consumer, both bounded. All GOTCHA-free, no external SDK.
//=====================================================================

import { Env, sweepExpiredProposals } from "./lib/db";
import { handleUpdate } from "./workers/telegram_webhook";
import { setWebhook } from "./lib/telegram";
import { runDms } from "./daemons/dead_mans_switch";
import { processMessage, TaskMessage } from "./workers/task_processor";

const OWNER = (env: Env) => Number(env.OWNER_TELEGRAM_ID || 0);

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
      return await handleUpdate(env, update);
    }

    // Admin helper — point Telegram to this worker.
    if (path === "/setwebhook") {
      const token = url.searchParams.get("token");
      if (token !== env.TELEGRAM_SECRET && token !== env.TELEGRAM_TOKEN) {
        return new Response("unauthorized", { status: 401 });
      }
      const target = url.searchParams.get("url") ?? url.origin + "/webhook";
      await setWebhook(env, target, env.TELEGRAM_SECRET);
      return Response.json({ ok: true, target });
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
      } else if (cron === "0 8 * * *") {
        // Weekly obedience report — Cloudflare disallows `*` DOM + numeric DOW,
        // so this runs daily and only dispatches on Sunday.
        const isSunday = new Date().getUTCDay() === 0;
        console.log(`[cron] obedience_report: ${isSunday ? "dispatch" : "skip"} (${Date.now() - start}ms)`);
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
      const outcome = await processMessage(env, message.body as TaskMessage);
      if (outcome === "ok") {
        message.ack();
      } else if (outcome === "retry") {
        // allow Cloudflare to retry per the consumer's max_retries/backoff config
      }
      // "dead": let it stay unacked → lands in DLQ after retries are exhausted.
    }
  },
} satisfies ExportedHandler<Env>;
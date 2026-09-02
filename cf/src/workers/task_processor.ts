//=====================================================================
// task_processor.ts — Queue consumer.
//
// Consumes messages from TASKS queue (bound consumer in wrangler.toml),
// routes by priority class, applies retry/backoff, and escalates to the DMS
// on repeated failure. Worker shares the 10ms CPU budget with the webhook,
// so each task must stay tiny; heavy suff is rebound to the DMS daemon.
//=====================================================================

import { Env, logObedience } from "../lib/db";
import { sendMessage } from "../lib/telegram";
import { TIERS } from "../lib/command_hierarchy";

export interface TaskMessage {
  correlationId: string;
  ownerId: number;
  priority: number;
  kind: "telegram_reply" | "obedience_audit" | "dms_notify" | "internal";
  payload: Record<string, unknown>;
}

export const CONSUMER_NAME = "task_processor";
export const CONSUMER_BALANCER = "lowest-task-count";

const backoff = (env: Env, n: number) =>
  Number(env.QUEUE_RETRY_BACKOFF_MS || "1000") * Math.min(2 ** n, 8);

/**
 * Process one queue batch/batch message. Returns ok/retry/dead. In Cloudflare
 * Queues, a consumer `batch()` receives messages; we call this per message.
 */
export async function processMessage(env: Env, msg: TaskMessage): Promise<"ok" | "retry" | "dead"> {
  let outcome: "ok" | "retry" | "dead" = "ok";
  try {
    const owner = msg.ownerId;
    switch (msg.kind) {
      case "telegram_reply": {
        const text = msg.payload.text || "";
        if (!text) {
          outcome = "ok"; // no-op
          break;
        }
        await sendMessage(env, owner, String(text));
        await logObedience(env, owner, "AUTONOMOUS_ACTION", msg.priority, "EXECUTE", "COMPLIANT", {
          evidence: { kind: msg.kind, correlationId: msg.correlationId },
        });
        break;
      }
      case "dms_notify": {
        await sendMessage(env, owner, String(msg.payload.text || "DMS notification"));
        outcome = "ok";
        break;
      }
      case "obedience_audit": {
        await logObedience(env, owner, "AUTONOMOUS_ACTION", msg.priority, "EXECUTE", "COMPLIANT", {
          evidence: { source: msg.payload.source },
        });
        outcome = "ok";
        break;
      }
      default: {
        outcome = "ok"; // unknown kind → drop, don't loop
        break;
      }
    }
  } catch (e) {
    console.error("[task] msg failed", msg.correlationId, (e as Error).message);
    // Non-deterministic failures retry; transient only. Backoff in consumer.
    outcome = "retry";
  }
  return outcome;
}

/** Consumer entry for Queues batching. Not used directly in index; declared
 *  for completeness — Cloudflare calls batch() on the consumer binding. */
export async function consumeBatch(env: Env, messages: TaskMessage[]): Promise<void> {
  for (const m of messages) {
    // backoff is magaged by the queue retry policy in wrangler; we just run.
    await processMessage(env, m);
  }
}

/** Escalate a stuck task to the DMS after max_retries is hit. */
export async function escalateToDms(env: Env, owner: number, error: string): Promise<void> {
  await logObedience(env, owner, "AUTONOMOUS_ACTION", TIERS.DANGEROUS, "DEFER", "BLOCKED", {
    evidence: { escalation: "queue_dn", error },
  });
  try {
    await sendMessage(env, owner, "⚠️ Satu task menunggu terlalu lama di antrian. Memeriksa status DMS.");
  } catch {
    /* fire-and-forget */
  }
}
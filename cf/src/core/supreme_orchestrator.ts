/* ======================================================================
   SUPREME ORCHESTRATOR — Single Source of Truth for ALL Message Flow
   ======================================================================
   
   RESPONSIBILITIES (NO business logic beyond routing + validation):
   1. Intent extraction (via SELF_REF_RE + detectIntent)
   2. Covenant/compliance validation
   3. Context sanitization (Context Hygiene Protocol)
   4. Module selection & DI-instantiation
   5. Sequential execution (never parallel module calls without queue)
   6. Response assembly with guaranteed fallback
   
   ALL existing endpoints MUST route through this orchestrator during migration.
   /debug_bypass provides a temporary escape hatch for admin verification.
   ====================================================================== */

import { Env } from "../lib/db";
import { JARVIS_IDENTITY, SELF_REF_RE } from "../lib/identity";
import { extractTopic } from "../lib/ai";
import { processIntelligence, type IntelligenceResponse } from "../lib/intelligence";
import type { MessageContext, JarvisResponse } from "../lib/jarvis_core";
import { detectIntent } from "../lib/jarvis_core";
import { validateActionAgainstCovenant, type CovenantVerdict } from "../lib/covenant_core";
import { getContainer, type DiContainer } from "./di_container";
import { sanitizeContext } from "../lib/context_sanitizer";
import type { CleanContext } from "../interfaces/module_contract";
import type { JarvisModule, ModuleResult } from "../interfaces/module_contract";

// ---------- Imports for types ----------

/** The Telegram update type from the existing codebase. */
interface TelegramUpdate {
  update_id: number;
  message?: {
    message_id: number;
    from?: { id: number; first_name?: string; username?: string };
    chat: { id: number };
    text?: string;
    date: number;
  };
  callback_query?: {
    id: string;
    from: { id: number; first_name?: string; username?: string };
    data?: string;
    message?: { chat: { id: number } };
  };
}

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

/** The single entry-point return type for webhook handling. */
export interface OrchestratorResult {
  response: Response;
  metrics: { latencyMs: number; module: string; intent: string };
}

// ---------- Helper: rate limiting (identical to current worker) ----------
async function rateLimited(env: Env, userId: number): Promise<boolean> {
  const key = `rl:${userId}`;
  const now = Date.now();
  try {
    const prev = await env.CONFIG_KV.get(key);
    if (prev != null && now - Number(prev) < 1000) return true;
    await env.CONFIG_KV.put(key, String(now), { expirationTtl: 1000 / 1000 + 2 });
    return false;
  } catch {
    return false;
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
    console.error("[orchestrator] send failed", (e as Error).message);
  }
}

// ---------- Core Orchestrator Class ----------

export class SupremeOrchestrator {
  private env: Env;
  private container: DiContainer;

  constructor(env: Env) {
    this.env = env;
    this.container = getContainer(env);
  }

  /** ---------- Public Entry Point ---------- */
  async processUpdate(update: TelegramUpdate): Promise<Response> {
    const startMs = Date.now();
    let moduleName = "unknown";
    let intentName = "unknown";

    try {
      // 1. Rate limiting (same as current worker)
      let ownerId = this.env.OWNER_TELEGRAM_ID ? Number(this.env.OWNER_TELEGRAM_ID) : 0;
      if (update.message?.from?.id) {
        ownerId = update.message.from.id;
      } else if (update.callback_query?.from?.id) {
        ownerId = update.callback_query.from.id;
      }

      if (await rateLimited(this.env, ownerId)) {
        return new Response("ok", { status: 200 });
      }

      // 2. Parse update
      let messageText = "";
      if (update.message && update.message.text) {
        messageText = update.message.text;
      } else if (update.callback_query && update.callback_query.data) {
        // Callback query — extract the original command from KV if available
        const corr = update.callback_query.data.replace(/^consent:/, "");
        const stored = await this.env.CONFIG_KV.get(`clarify:${corr}`);
        messageText = stored || update.callback_query.data;
      } else {
        return new Response("ok", { status: 200 });
      }

      // 3. Intent extraction (single source of truth)
      const parsedIntent = detectIntent(messageText);
      intentName = parsedIntent.intent;
      moduleName = parsedIntent.intent;

      // 4. Self-referential check (fail-closed, before any LLM call)
      // Strip group "Username:" prefix before testing (same as normalizeInput)
      const cleaned = messageText.replace(/^[^:]+:\s*\n?\s*/i, "").trim();
      if (SELF_REF_RE.test(cleaned)) {
        const reply = JARVIS_IDENTITY.selfRefReply;
        return new Response(reply, {
          headers: { "Content-Type": "text/plain; charset=utf-8" },
          status: 200,
        });
      }

      // 5. Check if bypass mode is active (admin debug)
      const bypassActive = await this.env.CONFIG_KV.get("debug_bypass");
      if (bypassActive === "1") {
        // Bypass orchestrator — fall through to legacy act() pipeline
        return this.legacyFallback(messageText, ownerId, startMs);
      }

      // 6. Covenant validation (guard — never route restricted actions)
      const covenantCheck = await validateActionAgainstCovenant(
        this.env,
        ownerId,
        messageText,
      );
      if (!covenantCheck.allowed) {
        const blockedReply = `⚠️ Aksi ini dikonfiskan oleh Konstitusi J.A.R.V.I.S.\n${covenantCheck.reasoning || ""}`.trim();
        return new Response(blockedReply, {
          status: 200,
          headers: { "Content-Type": "text/plain; charset=utf-8" },
        });
      }

      // 7. Context sanitization (Context Hygiene Protocol)
      // Build CleanContext from the parsed intent
      const cleanContext: CleanContext = sanitizeContext({
        userIntent: parsedIntent,
        ownerId,
        relevantHistory: [], // Will be populated if needed
        userPreferences: [],
        culturalTone: "casual",
        honorifics: null,
      });

      // 8. Module selection via registry
      const selected = this.container.getModule(moduleName) ||
                       this.container.getModule(parsedIntent.intent);

      if (selected) {
        // 9. Execute selected module (sequential, no parallel calls)
        const moduleResult = await selected.execute(cleanContext);

        // 10. Assemble response
        const responseText = moduleResult.reply;
        const latencyMs = Date.now() - startMs;

        logRequest(this.env, "/webhook", "POST", 200, latencyMs);

        return new Response(responseText, {
          status: 200,
          headers: { "Content-Type": "text/plain; charset=utf-8" },
        });
      }

      // No registered module for this intent → fall through to intelligence brain
      return this.legacyFallback(messageText, ownerId, startMs);
    } catch (err) {
      console.error("[orchestrator] unexpected error:", (err as Error).message);
      const latencyMs = Date.now() - startMs;
      logRequest(this.env, "/webhook", "POST", 500, latencyMs);
      // Ultimate fail-closed: return identity reply so we never hallucinate
      return new Response(JARVIS_IDENTITY.selfRefReply, {
        status: 200,
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      });
    }
  }

  /** ---------- Fallback: Intelligence Brain ---------- */
  private async legacyFallback(
    rawText: string,
    ownerId: number,
    startMs: number,
  ): Promise<Response> {
    // Delegate to the existing intelligence.ts brain (preserves all existing behavior)
    const brainRes = await processIntelligence(this.env, ownerId, rawText);

    const responseText = brainRes.text;
    const latencyMs = Date.now() - startMs;

    logRequest(this.env, "/webhook", "POST", 200, latencyMs);

    return new Response(responseText, {
      status: 200,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }
}

// ---------- Export singleton factory ----------
export function createOrchestrator(env: Env): SupremeOrchestrator {
  return new SupremeOrchestrator(env);
}
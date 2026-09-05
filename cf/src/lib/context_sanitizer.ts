/* ======================================================================
   CONTEXT SANITIZER — Context Hygiene Protocol
   ======================================================================
   
   MISSION: AI intelligence = Quality of Context, not model size.
   Clean every message's context down to ONLY what's relevant for the
   current intent. Strip ALL technical metadata before sending to Groq.
   
   GUARANTEE: If it's not explicitly in CleanContext, it WILL NOT reach
   the LLM. This is enforced at runtime by DiContainer.sanitizeForModule()
   and at compile time by the CleanContext type.
   ====================================================================== */

import type { CleanContext, ModuleResult } from "../interfaces/module_contract";

/** ---------- Core Sanitization Function ---------- */
export function sanitizeContext(raw: {
  userIntent: any;
  ownerId?: number;
  relevantHistory?: any[];
  userPreferences?: any[];
  culturalTone?: "formal" | "casual" | "emergency";
  honorifics?: string | null;
  conversationMode?: string;
}): CleanContext {
  // Extract only the fields we need; drop everything else.
  // This is the runtime guard: even if something slips past the type system,
  // it won't reach the LLM because we only carry forward what's listed below.

  const { userIntent } = raw;

  // Build the CleanContext with ONLY allowed fields.
  const clean: CleanContext = {
    // 1. userIntent — parsed from detectIntent() + SELF_REF_RE check
    userIntent: {
      intent: userIntent?.intent || "general",
      confidence: userIntent?.confidence ?? 0.5,
      entities: userIntent?.entities || {},
    },

    // 2. relevantHistory — 5 most recent messages, topic-filtered.
    //    The caller (orchestrator) is responsible for passing only relevant
    //    history; the sanitizer enforces the cap at 5.
    relevantHistory: (raw.relevantHistory || [])
      .filter((m: any) => m && typeof m.content === "string")
      .slice(-5)
      .map((m: any) => ({
        role: (m.role || "user") as "user" | "assistant",
        content: m.content.substring(0, 1000),
      })),

    // 3. userPreferences — domain-scoped only (passed through if present)
    userPreferences: (raw.userPreferences || [])
      .filter((p: any) => p && p.key && p.value)
      .slice(0, 10),

    // 4. culturalTone — explicitly set based on user profile; defaults to "casual"
    culturalTone: raw.culturalTone || "casual",

    // 5. honorifics — from user profile, or null
    honorifics: raw.honorifics !== undefined ? raw.honorifics : null,

    // 6. conversationMode — from intelligence.ts perception, optional
    conversationMode: raw.conversationMode,
  };

  return clean;
}

/** ---------- Module Execute Wrapper ---------- */
/** Wrap a module's execute() call so that IF the module somehow reaches
 *  for technical metadata, the sanitizer cuts it off before the LLM sees it.
 *  This is the safety net: triple-layer defense (type system + runtime +
 *  orchestrator routing guard). */
export async function safeExecute(
  executeFn: (context: CleanContext) => Promise<ModuleResult>,
  context: CleanContext,
): Promise<ModuleResult> {
  // Execute with sanitized context — any non-CleanContext fields the module
  // accidentally references will be undefined, causing safe fallback behavior.
  const sanitized = sanitizeContext({ userIntent: context.userIntent });
  return executeFn(sanitized);
}

/** ---------- Historical Measurement Hook ---------- */
/**
 * Track intent accuracy before/after sanitization.
 * Called by the orchestrator after each request to build the quality metric.
 * NOT sent to the LLM — this is pure monitoring.
 */
export function recordIntentAccuracy(
  originalIntent: string,
  perceivedIntentAfterSanitize: string,
  success: boolean,
): void {
  const tag = success ? "✅" : "❌";
  console.log(`[context_sanitizer] intent=${originalIntent}->${perceivedIntentAfterSanitize} success=${success} ${tag}`);
}
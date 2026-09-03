//=====================================================================
// command_hierarchy.ts — absolute command fidelity + consent engine.
//
// Levels: 100/SYSTEM override > 90/emergency > 70/dangerous > 50/utility
//         > 30/informational. Introduced in L11 python, now TypeScript and
//         the AUTHORITATIVE path on the edge (D1 dms_state + consent_log).
//
// Model: priority is decided by (a) explicit `/override` marker, (b) Groq
// single-shot classification with a clarity gate, (c) fallback heuristics.
// Risk above RISK_CONSENT_THRESHOLD with ambiguity => inline clarify/consent.
//
// Bypasses (NEVER blocked, but still audited):
//   * `/stop`, `/kill`, `/override`, `/resume` at the emergency tier.
//   * Owner telegram ID match (env.OWNER_TELEGRAM_ID).
//=====================================================================

import { Env, logObedience, logViolation, getDmsConfig, writeDmsConfig, DmsConfig } from "./db";
import { validateAction, riskScore } from "./constitutional_guard";

export const TIERS = {
  SYSTEM: 100, // override from cert/system
  EMERGENCY: 90, // /stop /kill /override /resume
  DANGEROUS: 70, // wipe /delete /reset /transfer
  UTILITY: 50, // query, status, dms_status
  INFO: 30, // informational /help /obedience_report
} as const;

export type TierKey = keyof typeof TIERS;

export interface ClassifiedIntent {
  priority: number;
  confidence: number;
  label: string;
  riskLevel: "low" | "medium" | "high";
  riskScore?: number; // 0..1, keyword parity with python _local_risk
  isExplicit?: boolean; // python detect_intent "is_explicit"
  source?: string; // "prefix" | "groq" | "fallback_ambiguous" | "heuristic"
  intentSummary?: string; // python detect_intent "intent_summary"
}

export interface Decision {
  action: "EXECUTE" | "BLOCK" | "DEFER" | "CLARIFY" | "CONSENT";
  compliance: "COMPLIANT" | "BLOCKED" | "PENDING";
  priority: number;
  reason?: string;
  correlationId?: string;
}

const EMERGENCY_WORDS = ["/stop", "/kill", "/override", "/resume", "/kill force"];
const DANGEROUS_WORDS = [
  "wipe", "delete all", "reset", "transfer legacy", "pause dms", "disarm",
  "release vault", "erase node", "destroy backup",
];
const UTILITY_WORDS = ["dms_status", "queue_status", "health", "status", "audit_log"];
const INFO_WORDS = ["/help", "help", "/obedience_report", "introduce"];
// Command-prefixed text is inherently EXPLICIT (bypasses LLM clarity check).
// Mirrors python COMMAND_PREFIXES: "/", tolong, please, lakukan, harap,
// stop, kill, override, jangan, never.
const COMMAND_PREFIXES = [
  "/", "tolong ", "please ", "lakukan ", "harap ",
  "stop ", "kill ", "override ", "jangan ", "never ",
];

function hash(s: string): string {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/** Fast deterministic fallback when Groq UNavailable (offline/clarity lower). */
export function heuristicClassify(text: string): ClassifiedIntent {
  const raw = text || "";
  const lower = raw.toLowerCase();
  const score = riskScore(raw);
  if (EMERGENCY_WORDS.some((w) => lower.includes(w))) {
    return { priority: TIERS.EMERGENCY, confidence: 1.0, label: "emergency_control", riskLevel: "high", riskScore: 0.9, isExplicit: true, source: "prefix" };
  }
  if (DANGEROUS_WORDS.some((w) => lower.includes(w))) {
    return { priority: TIERS.DANGEROUS, confidence: 0.9, label: "dangerous_action", riskLevel: "high", riskScore: score, isExplicit: false, source: "heuristic" };
  }
  if (/^\/(override|resume|stop|kill)/.test(lower)) {
    return { priority: TIERS.EMERGENCY, confidence: 1.0, label: "override", riskLevel: "high", riskScore: 0.9, isExplicit: true, source: "prefix" };
  }
  // Known slash/utility diagnostic commands keep their low tier.
  if (UTILITY_WORDS.some((w) => lower.includes(w))) {
    return { priority: TIERS.UTILITY, confidence: 0.9, label: "utility_query", riskLevel: "low", riskScore: 0.1, isExplicit: true, source: "prefix" };
  }
  if (INFO_WORDS.some((w) => lower.includes(w))) {
    return { priority: TIERS.INFO, confidence: 0.95, label: "info", riskLevel: "low", riskScore: 0.1, isExplicit: true, source: "prefix" };
  }
  // Command-prefixed text is inherently explicit (clarity=1, no LLM needed).
  if (COMMAND_PREFIXES.some((p) => p === "/" ? lower.startsWith("/") : lower.startsWith(p))) {
    const dangerScore = score;
    const risk = dangerScore >= 0.6 ? "high" : dangerScore >= 0.3 ? "medium" : "low";
    return { priority: TIERS.SYSTEM, confidence: 1.0, label: "explicit_command", riskLevel: risk, riskScore: dangerScore, isExplicit: true, source: "prefix" };
  }
  return { priority: TIERS.INFO, confidence: 0.5, label: "general", riskLevel: "low", riskScore: score, isExplicit: false, source: "fallback_ambiguous" };
}

/**
 * Origin-driven priority evaluation (python `evaluate_priority` parity).
 *   * user/command + explicit intent   -> EXPLICIT_USER_CMD (100), EXECUTE
 *   * user/command free-text, clarity>=gate -> EXPLICIT_USER_CMD (100), EXECUTE
 *   * user/command free-text, clarity<gate  -> EXPLICIT_USER_CMD (100), CLARIFY
 *   * autonomous                          -> PRE_APPROVED_AUTONOMY (70), EXECUTE
 *                                               (consent finalized downstream)
 *   * predictive/proactive/suggestion     -> PREDICTIVE_SUGGESTION (50), DEFER
 *                                               (never auto-runs)
 *   * unknown                             -> CONSTITUTIONAL_GUARD (90), DEFER
 */
export function evaluatePriority(
  origin: string,
  intent: ClassifiedIntent,
  clarityGate = 0.95,
): { priority: number; priorityName: string; decision: string; source: string } {
  const o = (origin || "").toLowerCase();
  if (o === "user" || o === "command") {
    if (intent.isExplicit) {
      return { priority: TIERS.SYSTEM, priorityName: "EXPLICIT_USER_CMD", decision: "EXECUTE", source: intent.source ?? "prefix" };
    }
    // Free text, not explicit.
    if (intent.confidence < clarityGate) {
      return { priority: TIERS.SYSTEM, priorityName: "EXPLICIT_USER_CMD", decision: "CLARIFY", source: "clarity_gate" };
    }
    return { priority: TIERS.SYSTEM, priorityName: "EXPLICIT_USER_CMD", decision: "EXECUTE", source: intent.source ?? "groq" };
  }
  if (o === "autonomous") {
    return { priority: TIERS.DANGEROUS, priorityName: "PRE_APPROVED_AUTONOMY", decision: "EXECUTE", source: "autonomy" };
  }
  if (o === "predictive" || o === "proactive" || o === "suggestion") {
    return { priority: TIERS.UTILITY, priorityName: "PREDICTIVE_SUGGESTION", decision: "DEFER", source: "predictive" };
  }
  return { priority: TIERS.EMERGENCY, priorityName: "CONSTITUTIONAL_GUARD", decision: "DEFER", source: "unknown" };
}

/**
 * Groq single-shot classification. Async network call — does NOT consume the
 * worker's 10ms CPU budget (no CPU-bound work; I/O waits on the wire). This is
 * the whole reason the edge can still do "intelligent" intent here.
 */
export async function groqClassify(
  env: Env,
  text: string,
): Promise<ClassifiedIntent | null> {
  const key = env.GROQ_API_KEY;
  if (!key) return null;
  try {
    const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        model: "llama-3.3-70b-versatile",
        temperature: 0,
        messages: [
          {
            role: "system",
            content:
              "Classify the user's request for a sovereignty AI assistant. " +
              "Return ONLY JSON: {priority:int, confidence:float, label:string, risk:low|medium|high}. " +
              `Priority tiers: ${TIERS.SYSTEM}=cerondere/system override, ` +
              `${TIERS.EMERGENCY}=emergency control (/stop /kill /override /resume), ` +
              `${TIERS.DANGEROUS}=destructive/transfer action, ${TIERS.UTILITY}=status/query, ` +
              `${TIERS.INFO}=informational/help.` +
              "cap confidence at 1.0. Respond in one line only.",
          },
          { role: "user", content: text },
        ],
      }),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    const raw = data.choices?.[0]?.message?.content ?? "";
    const m = raw.match(/\{[\s\S]*\}/);
    if (!m) return null;
    const parsed = JSON.parse(m[0]) as {
      priority?: number; confidence?: number; label?: string; risk?: string;
    };
    return {
      priority: Number(parsed.priority) || TIERS.INFO,
      confidence: Math.min(1, Math.max(0, Number(parsed.confidence) || 0)),
      label: parsed.label ?? "general",
      riskLevel: (parsed.risk as "low" | "medium" | "high") ?? "low",
      riskScore: riskScore(text),
      isExplicit: Number(parsed.confidence || 0) >= 0.95,
      source: "groq",
      intentSummary: text.slice(0, 200),
    };
  } catch {
    return null;
  }
}

export interface HierarchyResult {
  decision: Decision;
  intent: ClassifiedIntent;
  cmdHash: string;
}

/**
 * Decision pipeline for one command. Pure-ish (I/O for Groq + audit only).
Implements:
  * clarity gate (CLARITY_GATE, default 0.95): low-confidence ambiguous => CLARIFY/retry
  * consent gate (risk high/medium at the consent threshold): inline approve/deny/pause/timeout
  * emergency/override bypasses: always EXECUTE (still audited)
  * append-only audit regardless of outcome.
 */
export async function routeCommand(
  env: Env,
  owner: number,
  rawText: string,
  opts: { origin?: "user" | "autonomous" | "predictive" } = {},
): Promise<HierarchyResult> {
  const gate = Number(env.CLARITY_GATE || "0.95");
  const consentThreshold = Number(env.RISK_CONSENT_THRESHOLD || "0.3");
  const cmdHash = hash(rawText);
  const origin = opts.origin ?? "user";

  // Load persistent state (never/stop rules, autonomy pause, constitution).
  const cfg = await getDmsConfig(env, owner);
  const rules = cfg.command_rules ?? [];

  // Emergency override words are always honoured (still logged).
  const lower = rawText.toLowerCase();
  const isEmergency =
    EMERGENCY_WORDS.some((w) => lower.includes(w)) ||
    /^\/(override|resume|stop|kill)/.test(lower);

  if (isEmergency) {
    const decision: Decision = {
      action: "EXECUTE",
      compliance: "COMPLIANT",
      priority: TIERS.EMERGENCY,
      reason: "Emergency override (unconditional).",
      correlationId: cmdHash,
    };
    await logObedience(env, owner, "EMERGENCY_OVERRIDE", TIERS.EMERGENCY, "EXECUTE", "COMPLIANT", {
      commandHash: cmdHash,
      evidence: { via: "hierarchy", intent: "emergency_control" },
    });
    return {
      decision,
      intent: { priority: TIERS.EMERGENCY, confidence: 1.0, label: "emergency_control", riskLevel: "high", riskScore: 0.9 },
      cmdHash,
    };
  }

  // Otherwise classify via Groq first, fallback heuristics on miss.
  const groq = await groqClassify(env, rawText);
  // Ownership principle: a "/"-prefixed command IS an explicit owner command.
  // Never let Groq's low-confidence classification demote it to DEFER/BLOCK —
  // the owner's direct command outranks any autonomous ambiguity heuristic.
  // Still audited, and still subject to "never"/something and constitutional stop.
  const slashExplicit = /^\s*\//.test(rawText);
  const intent = (groq && !slashExplicit) ? groq : heuristicClassify(rawText);
  const clarityOk = slashExplicit || intent.confidence >= gate;

  // Predictive/proactive suggestions still DEFER (never auto-run) — that is an
  // origin rule, not a Groq-confidence thing, and never an owner command.
  if (origin !== "user") {
    const pri0 = evaluatePriority(origin, intent, gate);
    if (pri0.decision === "DEFER") {
      const decision: Decision = {
        action: "DEFER", compliance: "BLOCKED", priority: pri0.priority,
        reason: "Non-user origin — deferred (never auto-runs).",
        correlationId: cmdHash,
      };
      await logObedience(env, owner, "AUTONOMOUS_ACTION", pri0.priority, "DEFER", "PENDING", {
        commandHash: cmdHash, evidence: { source: pri0.source, label: intent.label },
      });
      return { decision, intent, cmdHash };
    }
  }

  // AUTONOMY PAUSE: if the owner paused autonomy, autonomous/predictive actions
  // never run. Explicit user commands still honoured (user intent > pause).
  if (cfg.autonomy_paused && origin !== "user") {
    const decision: Decision = {
      action: "DEFER",
      compliance: "BLOCKED",
      priority: intent.priority,
      reason: "Autonomy is paused (owner /pause).",
      correlationId: cmdHash,
    };
    await logObedience(env, owner, "AUTONOMOUS_ACTION", intent.priority, "DEFER", "BLOCKED", {
      commandHash: cmdHash,
      evidence: { paused: true, label: intent.label },
    });
    return { decision, intent, cmdHash };
  }

  // CONSTITUTIONAL GUARD (fail-closed) for actions that could act — applies to
  // user explicit high-risk and autonomous/predictive alike.
  const guard = validateAction(rawText, {
    origin,
    risk: intent.riskScore,
    commandRules: rules,
    constitution: cfg.constitution,
  });
  if (!guard.allowed) {
    const decision: Decision = {
      action: "BLOCK",
      compliance: "BLOCKED",
      priority: intent.priority,
      reason: `Constitutional guard: ${guard.violated_principle}`,
      correlationId: cmdHash,
    };
    await logObedience(env, owner, "USER_COMMAND", intent.priority, "BLOCK", "BLOCKED", {
      commandHash: cmdHash,
      blockingSource: guard.violated_principle ?? "constitution",
      evidence: { reasoning: guard.reasoning, origin },
    });
    // Append-only constitutional violations log (L9 parity).
    await logViolation(env, owner, cmdHash, guard.violated_principle ?? "constitution", {
      intent: rawText.slice(0, 300),
      reasoning: guard.reasoning,
      confidence: guard.confidence,
      originModule: "edge",
    });
    return { decision, intent, cmdHash };
  }

  // Low clarity + meaningful priority => ask for clarification before acting.
  if (!clarityOk && intent.priority >= TIERS.DANGEROUS) {
    const decision: Decision = {
      action: "CLARIFY",
      compliance: "PENDING",
      priority: intent.priority,
      reason: `Ambiguous high-priority intent (conf=${intent.confidence.toFixed(2)}<${gate}).`,
      correlationId: cmdHash,
    };
    await logObedience(env, owner, "USER_COMMAND", intent.priority, "CLARIFY", "PENDING", {
      commandHash: cmdHash,
      evidence: { confidence: intent.confidence, label: intent.label },
    });
    return { decision, intent, cmdHash };
  }

  // Consent gate for medium/high risk utilities (unless already unambiguous
  // low-clarity). Outcome → consent separately.
  const needsConsent =
    (intent.riskLevel === "high" || intent.riskLevel === "medium") &&
    intent.priority >= TIERS.DANGEROUS;

  if (needsConsent) {
    const decision: Decision = {
      action: "CONSENT",
      compliance: "PENDING",
      priority: intent.priority,
      reason: "High/medium-risk action requires explicit consent.",
      correlationId: cmdHash,
    };
    await logObedience(env, owner, "CONSENT_REQUEST", intent.priority, "CONSENT", "PENDING", {
      commandHash: cmdHash,
      evidence: { confidence: intent.confidence, risk: intent.riskLevel, label: intent.label },
    });
    return { decision, intent, cmdHash };
  }

  // Low-clarity terminal "restricted" utility that is otherwise safe.
  if (!clarityOk && intent.priority >= TIERS.UTILITY) {
    const decision: Decision = {
      action: "DEFER",
      compliance: "BLOCKED",
      priority: intent.priority,
      reason: "Utility request with low confidence — deferred to clarification.",
      correlationId: cmdHash,
    };
    await logObedience(env, owner, "USER_COMMAND", intent.priority, "DEFER", "BLOCKED", {
      commandHash: cmdHash,
      evidence: { confidence: intent.confidence },
    });
    return { decision, intent, cmdHash };
  }

  const decision: Decision = {
    action: "EXECUTE",
    compliance: "COMPLIANT",
    priority: intent.priority,
    reason: "Cleared by clarity + risk gates.",
    correlationId: cmdHash,
  };
  await logObedience(env, owner, "USER_COMMAND", intent.priority, "EXECUTE", "COMPLIANT", {
    commandHash: cmdHash,
    evidence: { confidence: intent.confidence, label: intent.label, risk: intent.riskLevel },
  });
  return { decision, intent, cmdHash };
}

/**
 * Persist an explicit 'never/stop/jangan' instruction as a long-lived command
 * rule so future autonomous actions respect it (python `_store_intent_rule`).
 */
export async function markExplicitStop(env: Env, owner: number, text: string, disable = true): Promise<void> {
  const cfg = await getDmsConfig(env, owner);
  const rules = cfg.command_rules ?? [];
  rules.push({ phrase: (text || "").slice(0, 300), disable, at: new Date().toISOString() });
  cfg.command_rules = rules.slice(-200);
  await writeDmsConfig(env, owner, cfg);
}

/** Set/reset the global autonomy pause flag (python `autonomy_paused`). */
export async function setAutonomyPaused(env: Env, owner: number, paused: boolean): Promise<void> {
  const cfg = await getDmsConfig(env, owner);
  cfg.autonomy_paused = paused;
  await writeDmsConfig(env, owner, cfg);
}

/** Whether autonomy is currently paused for this owner. */
export async function isAutonomyPaused(env: Env, owner: number): Promise<boolean> {
  return (await getDmsConfig(env, owner)).autonomy_paused ?? false;
}

/** Enable/disable strict privacy mode (stops persisting conversation memory).
 *  Owner command `/privacy on|off` — under the owner's direct control. */
export async function setPrivacyMode(env: Env, owner: number, on: boolean): Promise<void> {
  const cfg = await getDmsConfig(env, owner);
  cfg.privacy_mode = on;
  await writeDmsConfig(env, owner, cfg);
}

/** Current privacy mode for this owner. */
export async function isPrivacyMode(env: Env, owner: number): Promise<boolean> {
  return (await getDmsConfig(env, owner)).privacy_mode ?? false;
}

/** Mask sensitive ids before persisting (L11 `_redact` parity). */
export function redact(value: string): string {
  if (!value) return "";
  const val = String(value);
  if (val.length <= 4) return "***";
  return val.slice(0, 4) + "…redacted/" + val.length;
}
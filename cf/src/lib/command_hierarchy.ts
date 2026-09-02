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

import { Env, logObedience, logConsent } from "./db";

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
  const lower = text.toLowerCase();
  if (EMERGENCY_WORDS.some((w) => lower.includes(w))) {
    return { priority: TIERS.EMERGENCY, confidence: 1.0, label: "emergency_control", riskLevel: "high" };
  }
  if (DANGEROUS_WORDS.some((w) => lower.includes(w))) {
    return { priority: TIERS.DANGEROUS, confidence: 0.9, label: "dangerous_action", riskLevel: "high" };
  }
  if (/^\/(override|resume|stop|kill)/.test(lower)) {
    return { priority: TIERS.EMERGENCY, confidence: 1.0, label: "override", riskLevel: "high" };
  }
  if (UTILITY_WORDS.some((w) => lower.includes(w))) {
    return { priority: TIERS.UTILITY, confidence: 0.8, label: "utility_query", riskLevel: "low" };
  }
  if (INFO_WORDS.some((w) => lower.includes(w))) {
    return { priority: TIERS.INFO, confidence: 0.9, label: "info", riskLevel: "low" };
  }
  return { priority: TIERS.INFO, confidence: 0.5, label: "general", riskLevel: "low" };
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
): Promise<HierarchyResult> {
  const gate = Number(env.CLARITY_GATE || "0.95");
  const consentThreshold = Number(env.RISK_CONSENT_THRESHOLD || "0.3");
  const cmdHash = hash(rawText);

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
      intent: { priority: TIERS.EMERGENCY, confidence: 1.0, label: "emergency_control", riskLevel: "high" },
      cmdHash,
    };
  }

  // Otherwise classify via Groq first, fallback heuristics on miss.
  const groq = await groqClassify(env, rawText);
  const intent = groq ?? heuristicClassify(rawText);
  const clarityOk = intent.confidence >= gate;

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

/** Resolve an inline-button consent/callback into its command chain. */
export async function resolveCallback(
  env: Env,
  owner: number,
  correlationId: string,
  decision: "approve" | "deny" | "pause" | "timeout",
): Promise<void> {
  await logConsent(env, owner, correlationId, "inline-callback", "low", decision, TIERS.DANGEROUS);
}
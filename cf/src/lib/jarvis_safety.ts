//=====================================================================
// jarvis_safety.ts — Safety & compliance service for JARVIS.
//
// Bertanggung jawab untuk:
// - Constitutional guard enforcement
// - Action validation
// - Audit logging
// - Privacy protection
// - Rate limiting
//
// Architecture: Layered safety with fail-closed defaults
// 1. Input validation
// 2. Constitutional guard
// 3. Rate limiting
// 4. Audit logging
// 5. Privacy protection
//=====================================================================

import { Env, logObedience, logViolation, logConsent } from "./db";
import { validateAction, type GuardResult } from "./constitutional_guard";

/** Safety check result. */
export interface SafetyResult {
  allowed: boolean;
  reason: string;
  tier: number;
  confidence: number;
  requiresConsent: boolean;
  auditRequired: boolean;
}

/** Rate limit state. */
export interface RateLimitState {
  allowed: boolean;
  remaining: number;
  resetAt: number;
  retryAfter: number;
}

/** Privacy level. */
export type PrivacyLevel = "public" | "private" | "confidential" | "secret";

/** Validate a user message for safety. */
export function validateMessage(
  text: string,
  opts: {
    owner: number;
    source: string;
    groupId?: number;
  },
): SafetyResult {
  const low = text.toLowerCase();

  // Check for dangerous content
  const dangerousPatterns = [
    /\b(?:hack|exploit|bypass|override|force|crack)\b/i,
    /\b(?:delete|remove|destroy|drop|truncate)\b.*(?:table|database|data|file)/i,
    /\b(?:api[_-]?key|token|secret|password)\s*[:=]\s*\S+/i,
    /(?:https?:\/\/[^\s]+?(?:token|key|secret)=[^\s&]+)/i,
  ];

  for (const pattern of dangerousPatterns) {
    if (pattern.test(text)) {
      return {
        allowed: false,
        reason: "Message contains potentially dangerous content",
        tier: 100,
        confidence: 0.9,
        requiresConsent: false,
        auditRequired: true,
      };
    }
  }

  // Check for privacy-sensitive content
  const privacyPatterns = [
    /\b\d{6,12}\b/g, // Telegram user IDs
    /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, // Emails
    /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g, // IP addresses
  ];

  let hasPrivacyContent = false;
  for (const pattern of privacyPatterns) {
    if (pattern.test(text)) {
      hasPrivacyContent = true;
      break;
    }
  }

  return {
    allowed: true,
    reason: "Message validated",
    tier: 0,
    confidence: 0.5,
    requiresConsent: hasPrivacyContent,
    auditRequired: hasPrivacyContent,
  };
}

/** Validate an action before execution. */
export async function validateActionSafety(
  env: Env,
  action: string,
  opts: {
    owner: number;
    source: string;
    correlationId?: string;
  },
): Promise<SafetyResult> {
  // 1) Constitutional guard check
  const guardResult = validateAction(action, {});

  if (!guardResult.allowed) {
    // Log violation
    await logViolation(env, opts.owner, "", guardResult.violated_principle ?? "unknown", {
      intent: action.slice(0, 100),
      reasoning: guardResult.reasoning,
      confidence: guardResult.confidence,
      originModule: "safety",
    });

    return {
      allowed: false,
      reason: guardResult.reasoning,
      tier: 100,
      confidence: guardResult.confidence,
      requiresConsent: false,
      auditRequired: true,
    };
  }

  // 2) Check if consent is required (tier based on confidence)
  const tier = Math.round(guardResult.confidence * 100);
  const requiresConsent = tier >= 70;

  if (requiresConsent && opts.correlationId) {
    // Log consent request
    await logConsent(
      env,
      opts.owner,
      opts.correlationId,
      action.slice(0, 200),
      tier >= 100 ? "emergency" : "high",
      "PENDING",
      tier,
    );
  }

  // 3) Audit logging
  await logObedience(
    env,
    opts.owner,
    "ACTION_VALIDATED",
    tier,
    "VALIDATED",
    "COMPLIANT",
    {
      commandHash: opts.correlationId,
      blockingSource: guardResult.reasoning,
      evidence: { action: action.slice(0, 200) },
    },
  );

  return {
    allowed: true,
    reason: "Action validated",
    tier,
    confidence: guardResult.confidence,
    requiresConsent,
    auditRequired: tier >= 50,
  };
}

/** Check rate limits for a user. */
export async function checkRateLimit(
  env: Env,
  owner: number,
  action: string,
): Promise<RateLimitState> {
  const now = Date.now();
  const windowMs = 60 * 1000; // 1 minute window
  const maxRequests = 30; // 30 requests per minute

  try {
    const key = `ratelimit:${owner}:${action}`;
    const raw = await env.CONFIG_KV.get(key, "json");
    const timestamps: number[] = Array.isArray(raw) ? raw : [];

    // Filter to current window
    const recent = timestamps.filter(t => t > now - windowMs);

    if (recent.length >= maxRequests) {
      const oldest = Math.min(...recent);
      const retryAfter = Math.max(0, oldest + windowMs - now);
      return {
        allowed: false,
        remaining: 0,
        resetAt: oldest + windowMs,
        retryAfter,
      };
    }

    // Add current timestamp
    recent.push(now);
    await env.CONFIG_KV.put(key, JSON.stringify(recent), { expirationTtl: 120 });

    return {
      allowed: true,
      remaining: maxRequests - recent.length,
      resetAt: now + windowMs,
      retryAfter: 0,
    };
  } catch {
    // Fail-open: allow on KV failure
    return {
      allowed: true,
      remaining: maxRequests,
      resetAt: now + windowMs,
      retryAfter: 0,
    };
  }
}

/** Protect PII in text before storage or LLM calls. */
export function protectPII(text: string): string {
  let protectedText = text;

  // Redact Telegram user IDs
  protectedText = protectedText.replace(/\b\d{6,12}\b/g, "[REDACTED_ID]");

  // Redact API keys and tokens
  protectedText = protectedText.replace(
    /(?:api[_-]?key|token|secret|password|auth)\s*[:=]\s*["']?[^\s"']+/gi,
    "[REDACTED_KEY]",
  );

  // Redact email addresses
  protectedText = protectedText.replace(
    /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g,
    "[REDACTED_EMAIL]",
  );

  // Redact IP addresses
  protectedText = protectedText.replace(
    /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g,
    "[REDACTED_IP]",
  );

  // Redact URLs with potential tokens
  protectedText = protectedText.replace(
    /(?:https?:\/\/[^\s]+?(?:token|key|secret|auth)=[^\s&]+)/gi,
    "[REDACTED_URL]",
  );

  return protectedText;
}

/** Get privacy level for content. */
export function getPrivacyLevel(text: string): PrivacyLevel {
  const low = text.toLowerCase();

  // Secret: contains API keys, passwords, tokens
  if (/\b(?:api[_-]?key|token|secret|password|auth)\s*[:=]\s*\S+/i.test(low)) {
    return "secret";
  }

  // Confidential: contains PII
  if (/\b\d{6,12}\b/.test(text) || /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/.test(text)) {
    return "confidential";
  }

  // Private: personal opinions, preferences
  if (/\b(?:saya|aku|menurutku|pribadi|personal)\b/i.test(low)) {
    return "private";
  }

  // Public: general information
  return "public";
}

/** Format safety status for display. */
export function formatSafetyStatus(
  rateLimit: RateLimitState,
  privacyLevel: PrivacyLevel,
): string {
  const lines = [
    "🛡️ *Safety Status*",
    "",
    `*Rate Limit:* ${rateLimit.allowed ? "✅ Allowed" : "❌ Blocked"}`,
    `  Remaining: ${rateLimit.remaining}`,
    `  Reset in: ${Math.round((rateLimit.resetAt - Date.now()) / 1000)}s`,
    "",
    `*Privacy Level:* ${privacyLevel}`,
  ];

  return lines.join("\n");
}

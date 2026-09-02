//=====================================================================
// zero_trust.ts — Cloudflare mTLS + context injection + policy.
//
// Level 10/11: the automation surface must never trust the de-facto channel.
// We rely on Cloudflare's managed certificate client auth:
//   * A client certificate is REQUIRED to reach the worker over Nginx/Cloudflare
//     Access silently re-enforces it (separate from app logic).
//   * App-layer validation of the client-cert subject header protects the
//     worker's own endpoints if exposed on *.workers.dev without Access.
//
// Headers injected by Cloudflare when a client cert is presented:
//   Cloudflare-Client-Cert-Subject (RFC2253)   — identity
//   Cloudflare-Client-Cert-Verified            — "SUCCESS"
//   Cloudflare-Client-Cert-Issuer
//=====================================================================

import { Env } from "./db";

export interface AuthContext {
  authenticated: boolean;
  ownerId: number | null;
  subjectCN: string | null;
  reason?: string;
}

const SYSADMIN_CN = "jarvis-admin";

/** True if the request presented a valid mutual-TLS client cert. */
export function clientCertVerified(request: Request): boolean {
  const verified = request.headers.get("Cloudflare-Client-Cert-Verified");
  return verified === "SUCCESS";
}

/** Prove the presenting CN (certificate subject) is the owner/admin. */
export function isSystemOperator(request: Request): boolean {
  const subject = request.headers.get("Cloudflare-Client-Cert-Subject") ?? "";
  return subject.includes(`CN=${SYSADMIN_CN}`);
}

/** Enforce certificate caller on any privileged worker endpoint. */
export function requireCert(request: Request): { ok: boolean; error?: string } {
  if (!clientCertVerified(request)) {
    return { ok: false, error: "mTLS not presented (see Cloudflare Access)" };
  }
  if (!isSystemOperator(request)) {
    return { ok: false, error: "certificate CN is not the system operator" };
  }
  return { ok: true };
}

/** Build a minimal auth context from the request + telemetry gate. */
export function buildContext(
  request: Request,
  env: Env,
  telegramId: number | null,
): AuthContext {
  const subject = request.headers.get("Cloudflare-Client-Cert-Subject") ?? null;
  const verified = clientCertVerified(request);
  // In production the tunnel (Access) already requires the cert, so a verified
  // cert is authoritative. On a raw workers.dev exposure, also require CN match.
  const sysOp = isSystemOperator(request);
  const triggeredByTelegram = telegramId !== null && telegramId === Number(env.OWNER_TELEGRAM_ID || 0);

  if (verified && (sysOp || triggeredByTelegram)) {
    return { authenticated: true, ownerId: Number(env.OWNER_TELEGRAM_ID || 0), subjectCN: subject };
  }
  if (verified && !sysOp && !triggeredByTelegram) {
    return { authenticated: false, ownerId: null, subjectCN: subject, reason: "non-operator cert" };
  }
  return { authenticated: false, ownerId: null, subjectCN: subject, reason: "no client cert" };
}

/**
 * Spectrum/Cron sender is Cloudflare itself (system), never a caller cert.
 * Scheduled invocations get their own context.
 */
export function systemContext(env: Env): AuthContext {
  return {
    authenticated: true,
    ownerId: Number(env.OWNER_TELEGRAM_ID || 0) || null,
    subjectCN: "system",
  };
}
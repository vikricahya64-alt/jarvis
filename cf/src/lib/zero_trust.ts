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

/** Enforce certificate caller on any privileged worker endpoint.
 *  Tri-state `verdict`: "allow" (SUCCESS + operator), "deny" (verified FAILED
 *  atau CN bukan operator), "unknown" (header absent/malformed — audited
 *  sebagai tidak-terverifikasi, `.ok` tetap false / fail-closed). */
export function requireCert(request: Request): { ok: boolean; error?: string; verdict: Gate } {
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

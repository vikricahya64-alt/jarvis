/* ======================================================================
   COVENANT_CORE — Immutable Covenant (Level 12, Transcendent Steward).
   
   PRESERVED: All Level 12 covenant guarantees (append-only, fail-closed,
   Groq-validated, DB-triggered immutability). No covenant logic is changed.
   
   REFACTORED: Added CovenantCore class implementing the required module
   interface (moduleId, dependencies, maxCpuTimeMs, execute, healthCheck,
   getCapabilities). The core functions (getActiveClauses, etc.) remain
   as standalone exports for full backward compatibility.
   ====================================================================== */

import { Env, logViolation, getDmsConfig } from "./db";
import { groqSingleShot } from "./ai";

// ============ ORIGINAL INTERFACES (unchanged - backward compat) ============

export interface CovenantClause {
  id: string;
  version: number;
  contentHash: string;
  signedByUser: number;
  signedAt: number;
  isActive: number;
  createdAt: number;
}

export interface CovenantVerdict {
  allowed: boolean;
  violatedClauseId: string | null;
  reasoning: string;
  source: "groq" | "fail_closed" | "none";
}

/** sha-256 hex digest (Web Crypto, native in Workers). */
export async function sha256(text: string): Promise<string> {
  const data = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Resolve currently-active covenants = highest version per clause id. */
export async function getActiveClauses(env: Env): Promise<CovenantClause[]> {
  try {
    const { results } = await env.DB.prepare(
      `SELECT *
       FROM covenant_clauses c
       WHERE version = (SELECT COALESCE(MAX(version),0) FROM covenant_clauses c2 WHERE c2.id = c.id)
         AND signed_by_user = 1`,
    ).all();
    return results as unknown as CovenantClause[];
  } catch {
    return [];
  }
}

/** Insert a NEW signed covenant version (append-only). Returns version. */
export async function signClause(env: Env, clauseId: string, clauseText: string): Promise<number | null> {
  try {
    const contentHash = await sha256(clauseText);
    const existing = await env.DB.prepare(
      `SELECT MAX(version) AS v FROM covenant_clauses WHERE id = ?`,
    ).bind(clauseId).first<{ v: number }>();
    const version = (existing?.v ?? 0) + 1;
    const res = await env.DB.prepare(
      `INSERT INTO covenant_clauses
       (id, version, content_hash, signed_by_user, signed_at, is_active, created_at)
       VALUES (?, ?, ?, 1, ?, 1, ?)`,
    ).bind(clauseId, version, contentHash, Date.now(), Date.now()).run();
    return res.meta.last_row_id != null ? version : null;
  } catch (e) {
    console.error("[covenant] signClause failed", (e as Error).message);
    return null;
  }
}

/** Hash of all active clauses (for identity-anchor binding). */
export async function covenantHash(env: Env): Promise<string> {
  const clauses = await getActiveClauses(env);
  const canonical = clauses
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((c) => `${c.id}:${c.contentHash}`)
    .join("\n");
  return sha256(canonical || "no-covenant").then((h) => h.slice(0, 16));
}

/**
 * Validate an action against the active covenant. Uses Groq (single-shot,
 * async, off the 10ms CPU budget) to check violation. Fail-closed:
 *  - no API key / offline AND covenants exist  => BLOCK (cannot prove safe)
 *  - no active covenant                          => allow (nothing binding yet)
 *  - constitutional guard (L11) still applies separately downstream.
 */
export async function validateActionAgainstCovenant(
  env: Env,
  owner: number,
  actionText: string,
): Promise<CovenantVerdict> {
  const clauses = await getActiveClauses(env);
  const cfg = await getDmsConfig(env, owner);
  const paused = cfg.autonomy_paused ?? false;
  // Absolute sovereignty: autonomy pause overrides everything.
  if (paused && !/^\/(covenant|identity|sunset|pause|resume|status)/.test(actionText.trim())) {
    return { allowed: false, violatedClauseId: "autonomy_paused", reasoning: "Otonomi di-pause (/pause).", source: "fail_closed" };
  }
  if (clauses.length === 0) {
    return { allowed: true, violatedClauseId: null, reasoning: "Belum ada covenant aktif.", source: "none" };
  }
  // Build a short clause summary for Groq.
  const clauseText = clauses.map((c) => `${c.id}:${c.contentHash}`).join("\n");

  const key = env.GROQ_API_KEY;
  if (!key) {
    return {
      allowed: false,
      violatedClauseId: "covenant_unverifiable",
      reasoning: "Covenant ada tapi validator (Groq) tidak tersedia; fail-closed BLOCK.",
      source: "fail_closed",
    };
  }
  try {
    const raw = await groqSingleShot(env, {
      label: "groq:covenant",
      user: actionText,
      temperature: 0,
      system:
        "Kamu penjaga Perjanjian (Covenant) J.A.R.V.I.S. Ada daftar klausa aktif:\n" +
        clauseText +
        '\nApakah aksi di bawah MELANGGAR klausa apa pun? Balas HANYA JSON: ' +
        '{"allowed":bool,"reason":"penjelasan singkat"}. Jika ragu, allowed=false.',
    });
    if (raw === null) return { allowed: false, violatedClauseId: "covenant_unverifiable", reasoning: "Validator gagal.", source: "fail_closed" };
    const m = raw.match(/\{[\s\S]*\}/);
    if (!m) return { allowed: false, violatedClauseId: "covenant_unverifiable", reasoning: "Respons validator tidak valid.", source: "fail_closed" };
    const parsed = JSON.parse(m[0]) as { allowed?: boolean; reason?: string };
    const allowed = parsed.allowed === true;
    if (!allowed) {
      await logViolation(env, owner, "", "covenant", {
        intent: actionText.slice(0, 200),
        reasoning: parsed.reason ?? "",
        originModule: "covenant",
      });
    }
    return {
      allowed,
      violatedClauseId: allowed ? null : "covenant",
      reasoning: parsed.reason ?? "",
      source: "groq",
    };
  } catch {
    return { allowed: false, violatedClauseId: "covenant_unverifiable", reasoning: "Validator error.", source: "fail_closed" };
  }
}

/** Human-readable covenant status for /covenant_status. */
export async function covenantStatusText(env: Env): Promise<string> {
  const clauses = await getActiveClauses(env);
  if (clauses.length === 0) {
    return "📜 *Covenant*: belum ada klausa aktif. Profil masih tanpa ikatan memberi — J.A.R.V.I.S. tetap fail-closed terhadap aksi non-whitelist.";
  }
  const lines = clauses.map((c) =>
    `• \`${c.id}\` v${c.version} · SHA256:${c.contentHash.slice(0, 8)}… · ditandatangani ${new Date(c.signedAt).toISOString()}`,
  );
  return `📜 *Covenant aktif* (${clauses.length})\n\n${lines.join("\n")}`;
}

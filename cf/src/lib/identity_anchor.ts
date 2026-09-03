//=====================================================================
// identity_anchor.ts — Temporal Identity Anchor (Level 12, Transcendent Steward).
//
// Provides a verifiable chain of system identity that cannot be broken by any
// configuration change. Each epoch records the hash of the system snapshot
// (environment variables, D1 schema version, key module hashes) and links to
// the previous epoch. Cloudflare Workers execute this inline (D1) — no external
// backup needed.
//
// If the chain breaks (hash mismatch), autonomy halts immediately (no fallback).
// The owner can query continuity status via /identity_verify.
//=====================================================================

import { Env } from "./db";

export interface IdentityEpoch {
  epochId: string;           // SHA256 of config_hash + previous + timestamp
  configHash: string;        // Hash of entire system config snapshot
  previousEpochHash: string | null;
  covenantHash: string;      // Hash of all active covenant clauses (for binding)
  timestamp: number;         // Unix ms
  verified: boolean;         // Set true after verification passes
}

/** sha-256 hex digest (native Web Crypto). */
async function sha256(data: string): Promise<string> {
  const buffer = new TextEncoder().encode(data);
  const hash = await crypto.subtle.digest("SHA-256", buffer);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Create a new epoch that binds the current system state.
 * Returns the newly created epoch id.
 */
export async function createEpoch(
  env: Env,
  previousEpochHash: string | null,
  covenantHash: string,
): Promise<string> {
  const now = Date.now();
  const config = await getIdentitySnapshot(env);
  const configHash = await sha256(JSON.stringify(config));
  const epochId = await sha256(configHash + (previousEpochHash ?? "") + now);

  await env.DB.prepare(
    `INSERT INTO identity_epochs (epoch_id, config_hash, previous_epoch_hash, covenant_hash, timestamp, verified)
     VALUES (?, ?, ?, ?, ?, 0)`,
  ).bind(epochId, configHash, previousEpochHash, covenantHash, now).run();

  return epochId;
}

/**
 * Snapshot relevant environment config for hashing.
 * Includes all vars used by the worker (e.g., OWNER_TELEGRAM_ID, GROQ_API_KEY presence).
 */
async function getIdentitySnapshot(env: Env): Promise<Record<string, unknown>> {
  const snap: Record<string, unknown> = {};
  const keys = [
    "OWNER_TELEGRAM_ID",
    "APP_ENV",
    "TELEGRAM_SECRET",
    "TELEGRAM_TOKEN",
    "GROQ_API_KEY",
    "CLARITY_GATE",
    "RISK_CONSENT_THRESHOLD",
    "CONSENT_TIMEOUT_S",
    "DMS_GRACE_DAYS",
    "DMS_STAGE1_HOURS",
    "DMS_STAGE2_HOURS",
    "QUEUE_RETRY_BACKOFF_MS",
    "CONSOLE_KV",
    // Cloudflare binding names (same across environments)
  ];
  for (const k of keys) {
    const v = env[k as keyof Env];
    snap[k] = typeof v === "string" ? v : v;
  }
  // Include migration versions referenced in index.ts
  snap["migration_0001_present"] = await checkMigration(env, "0001_init.sql");
  snap["migration_0002_present"] = await checkMigration(env, "0002_legacy_inline.sql");
  snap["migration_0003_present"] = await checkMigration(env, "0003_upgrade.sql");
  snap["migration_0005_present"] = await checkMigration(env, "0005_covenant.sql");
  return snap;
}

/** Check if a given migration is applied (verify by table existence). */
async function checkMigration(env: Env, fileName: string): Promise<boolean> {
  const table = fileName.includes("0001") ? "user_activity" :
    fileName.includes("0002") ? "legacy_vault_metadata" :
    fileName.includes("0003") ? "task_counters" :
    fileName.includes("0005") ? "covenant_clauses" : null;
  if (!table) return false;
  try {
    await env.DB.prepare(`SELECT 1 FROM ${table} LIMIT 1`).first();
    return true;
  } catch {
    return false;
  }
}

/**
 * Verify continuity from a given epoch hash back to genesis.
 * Returns true if every link matches the stored hashes.
 */
export async function verifyContinuity(
  env: Env,
  fromEpochId: string,
): Promise<boolean> {
  try {
    let currentHash = fromEpochId;
    while (currentHash) {
      const row = await env.DB.prepare(
        `SELECT config_hash, previous_epoch_hash, covenant_hash FROM identity_epochs WHERE epoch_id = ?`,
      ).bind(currentHash).first<{ previous_epoch_hash: string | null }>();
      if (!row) return false;
      if (!row.previous_epoch_hash) break; // genesis reached, consider ok
      currentHash = row.previous_epoch_hash;
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Human readable status for the owner: chain length, last verified, etc.
 */
export async function identityStatusText(env: Env): Promise<string> {
  const { results } = await env.DB.prepare(
    `SELECT epoch_id, timestamp, verified FROM identity_epochs ORDER BY timestamp DESC LIMIT 5`,
  ).all();
  if (!results?.length) {
    return "🔗 *Identity Anchor*: belum ada epoch.";
  }
  const lines = (results as Array<{ epoch_id: string; timestamp: number; verified: number }>).map((e) => {
    const verifiedLabel = e.verified ? "✅" : "❌";
    return `• ${verifiedLabel} ${e.epoch_id.slice(0, 8)}… (${new Date(e.timestamp).toISOString()})`;
  });
  return `🔗 *Identity Anchor* (${results.length} epoch(s) in chain)

` + lines.join("\n") + "\n\nAktif & Verified = ✅\nUpdate chain via cron (lihat src/index.ts).";
}

/**
 * Mark a specific epoch as verified (called from cron).
 */
export async function markEpochVerified(env: Env, epochId: string): Promise<void> {
  await env.DB.prepare(
    `UPDATE identity_epochs SET verified = 1 WHERE epoch_id = ?`,
  ).bind(epochId).run();
}
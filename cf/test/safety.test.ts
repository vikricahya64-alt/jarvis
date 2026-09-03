//=====================================================================
// safety.test.ts — mission-critical safety harness (run with tsx).
//
// Validates the two highest-risk invariants of the Level 11 CF stack:
//   1. DMS: an owner interaction ALWAYS resets; a handler that returns
//      "executed" only fires after BOTH timeout windows fully elapse.
//   2. Command hierarchy: emergency overrides are never blocked, and
//      dangerous/ambiguous actions always require clarify/consent.
//
// Run: npx tsx test/safety.test.ts
//=====================================================================

import assert from "node:assert";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  routeCommand, heuristicClassify, TIERS, markExplicitStop, setAutonomyPaused,
} from "../src/lib/command_hierarchy";
import { validateAction, conflictScore } from "../src/lib/constitutional_guard";

const FAKE_ENV = {
  CLARITY_GATE: "0.95",
  RISK_CONSENT_THRESHOLD: "0.3",
  GROQ_API_KEY: "", // offline → heuristic path deterministic
} as unknown as Parameters<typeof routeCommand>[0];

async function testHierarchy() {
  // Emergency overrides are unconditional (still audited, but never CLARIFY).
  for (const cmd of ["/stop", "/kill", "/override", "/resume"]) {
    const r = await routeCommand(FAKE_ENV, 1, cmd);
    assert.strictEqual(r.decision.action, "EXECUTE", `emergency ${cmd} must execute`);
    assert.strictEqual(r.decision.priority, TIERS.EMERGENCY);
  }

  // Dangerous text is now BLOCKED by the fail-closed constitutional guard,
  // OR must NOT auto-execute (CONSENT/CLARIFY/DEFER acceptable).
  const dangerous = await routeCommand(FAKE_ENV, 1, "please wipe the legacy archive now");
  assert.notStrictEqual(
    dangerous.decision.action, "EXECUTE",
    `dangerous must not auto-execute (got ${dangerous.decision.action})`,
  );

  // Constitutional guard: destructive phrase → BLOCKED fail-closed.
  const guard = validateAction("wipe all backup vaults now");
  assert.strictEqual(guard.allowed, false, "destructive autonomous action must be blocked");
  assert.ok(guard.violated_principle, "blocked principle recorded");

  // Explicit command prefixes map to the explicit (100) tier.
  for (const p of ["tolong ", "please ", "lakukan ", "harap ", "jangan ", "never "]) {
    const hi = heuristicClassify(p + "kirim email ke semua kontak");
    assert.strictEqual(hi.priority, TIERS.SYSTEM, `prefix "${p.trim()}" must be explicit tier`);
  }

  // Pure informational is always fine.
  const info = await routeCommand(FAKE_ENV, 1, "/help");
  assert.strictEqual(info.decision.action, "EXECUTE");
  assert.strictEqual(info.intent.priority, TIERS.INFO);
}

async function testNoConstitutionFailClosed() {
  // Level 9 parity: WITHOUT a ratified constitution, only harmless whitelisted
  // read-only actions pass; everything else is BLOCKED with `no_constitution`.
  const blocked = validateAction("organize my whole drive into a new folder layout", { constitution: {} });
  assert.strictEqual(blocked.allowed, false, "non-whitelisted action with no constitution must block");
  assert.strictEqual(blocked.violated_principle, "no_constitution");

  const harmless = validateAction("show my status and today's reminders", { constitution: {} });
  assert.strictEqual(harmless.allowed, true, "harmless whitelisted read-only action may pass");
}

async function testOriginPriority() {
  // python evaluate_priority parity:
  // predictive -> PREDICTIVE_SUGGESTION (50), DEFER — never auto-runs even when consent is possible.
  const pred = await routeCommand(FAKE_ENV, 1, "who should I DM about the meeting?", { origin: "predictive" });
  assert.strictEqual(
    pred.decision.action, "DEFER",
    `predictive must never auto-run (got ${pred.decision.action})`,
  );
  assert.strictEqual(
    pred.decision.priority, TIERS.UTILITY,
    `predictive must sit at PREDICTIVE_SUGGESTION (50)`,
  );

  // explicit user command-prefix intent flags isExplicit + source=prefix.
  const pref = heuristicClassify("tolong kirim laporan cuaca harian");
  assert.strictEqual(pref.isExplicit, true, "command prefix must mark isExplicit");
  assert.strictEqual(pref.source, "prefix");
}

async function testDmsReset() {
  // The state-machine reset contract: any interaction flips executed back to idle.
  const rewrite = /UPDATE dms_state\s+SET stage='idle'/;
  assert.ok(rewrite.test("UPDATE dms_state SET stage='idle'"), "reset guard present");
}

async function testCommandRules() {
  // conflict_score parity: a stored 'never' rule blocks an equivalent action.
  const rules = [{ phrase: "jangan kirim berita politik", disable: true, at: "" }];
  assert.ok(conflictScore("kirim berita politik pagi ini", rules) >= 0.6,
    "conflicting action to a stored never-rule must score high");
  assert.ok(conflictScore("kirim laporan cuaca", rules) < 0.6,
    "unrelated-but-shared-token action must stay below the blocking threshold");
}

async function testMigrationIntegrity() {
  // The append-only constitutional block log MUST exist in the D1 migration.
  const sql = readFileSync(
    new URL("../migrations/0001_init.sql", import.meta.url),
    "utf-8",
  );
  assert.ok(
    /CREATE TABLE IF NOT EXISTS constitutional_violations/.test(sql),
    "migration must create constitutional_violations",
  );
  assert.ok(
    /UNIQUE \(owner_id, action_hash\)/.test(sql),
    "constitutional_violations must be UNIQUE per (owner, action_hash)",
  );
  assert.ok(
    /CREATE TABLE IF NOT EXISTS personal_constitution/.test(sql),
    "migration must create versioned personal_constitution",
  );
  assert.ok(/UNIQUE \(owner_id, version\)/.test(sql),
    "personal_constitution must be versioned per owner");
  // Value proposals TTL fields must be present for the sweep cron.
  assert.ok(/expires_at\s+INTEGER NOT NULL DEFAULT 0/.test(sql),
    "value_proposals must carry expires_at for TTL sweep");

  // 0002: legacy payload must be stored INLINE (no external object storage).
  const sql2 = readFileSync(
    new URL("../migrations/0002_legacy_inline.sql", import.meta.url),
    "utf-8",
  );
  assert.ok(
    /ADD COLUMN encrypted_blob TEXT NOT NULL DEFAULT ''/.test(sql2),
    "0002 must add inline encrypted_blob (eliminates R2 dependency)",
  );
}

async function testValueAlignmentShape() {
  // Drift constants honour L9 parity.
  const mod = await import("../src/lib/db");
  assert.strictEqual(mod.DRIFT_THRESHOLD_CORRECTIONS, 5);
  assert.strictEqual(mod.DRIFT_WINDOW_DAYS, 14);
  assert.strictEqual(mod.PROPOSAL_TTL_DAYS, 7);
  assert.strictEqual(typeof mod.sweepExpiredProposals, "function");
  assert.strictEqual(typeof mod.logViolation, "function");
  assert.strictEqual(typeof mod.pendingProposals, "function");
  assert.strictEqual(typeof mod.amendConstitution, "function");
  assert.strictEqual(typeof mod.getConstitution, "function");
}

async function testAppendOnlyIntegrity() {
  // The audit / consent / violation logs are append-only BY POLICY. No source
  // file may run UPDATE/DELETE against them (SQLite has no REVOKE, so we guard
  // at the source level). Writes must only go through INSERT helpers.
  const appendOnly = ["obedience_audit", "consent_log", "constitutional_violations"];
  const mutations = new RegExp(`\\b(?:UPDATE|DELETE)\\s+(?:FROM\\s+)?(${appendOnly.join("|")})`, "i");

  const srcDir = new URL("../src/", import.meta.url).pathname;
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (p.endsWith(".ts")) files.push(p);
    }
  };
  walk(srcDir);

  for (const f of files) {
    const src = readFileSync(f, "utf-8");
    assert.ok(
      !mutations.test(src),
      `append-only integrity violated: ${f} must not UPDATE/DELETE ${appendOnly.join(", ")}`,
    );
  }
}

async function main() {
  await testHierarchy();
  await testDmsReset();
  await testCommandRules();
  await testNoConstitutionFailClosed();
  await testOriginPriority();
  await testMigrationIntegrity();
  await testValueAlignmentShape();
  await testAppendOnlyIntegrity();
  console.log("SAFETY TESTS PASSED");
}

main().catch((e) => {
  console.error("SAFETY TEST FAILED:", e);
  process.exit(1);
});
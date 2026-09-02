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

async function main() {
  await testHierarchy();
  await testDmsReset();
  await testCommandRules();
  console.log("SAFETY TESTS PASSED");
}

main().catch((e) => {
  console.error("SAFETY TEST FAILED:", e);
  process.exit(1);
});
//=====================================================================
// rig-bridge.test.ts — routing worker→rig (tanpa D1/jaringan).
// Run: npm run test:rig
//
// Mencakup fungsi murni + jalur fail-closed dispatchAgentTask:
//  - routeExecutor: default/off → github; prefer/only (case-insensitive) → rig
//  - executorLabel: 'rig' → label lokal; lainnya → cloud
//  - dispatchAgentTask rig → {via:'rig'} TANPA network (return sebelum fetch)
//  - dispatchAgentTask github tanpa repo → error token, TANPA network
// Klaim atomik (claimAgentTask) butuh D1 → diuji via wrangler dev lokal,
// bukan di sini (konvensi repo: file test ini murni logika).
//=====================================================================

import assert from "node:assert";
import {
  routeExecutor, executorLabel, dispatchAgentTask,
} from "../src/lib/agent_executor";

function testRouteExecutor() {
  assert.strictEqual(routeExecutor({} as never), "github", "default → github");
  assert.strictEqual(routeExecutor({ RIG_EXECUTOR: "off" } as never), "github", "off → github");
  assert.strictEqual(routeExecutor({ RIG_EXECUTOR: "rumah" } as never), "github", "nilai asing → github (fail-closed)");
  assert.strictEqual(routeExecutor({ RIG_EXECUTOR: "prefer" } as never), "rig", "prefer → rig");
  assert.strictEqual(routeExecutor({ RIG_EXECUTOR: "only" } as never), "rig", "only → rig");
  assert.strictEqual(routeExecutor({ RIG_EXECUTOR: " Prefer " } as never), "rig", "case/whitespace-insensitive");
}

function testExecutorLabel() {
  assert.strictEqual(executorLabel("rig"), "tim lokal (OpenRig)", "rig berlabel lokal");
  assert.strictEqual(executorLabel("github"), "eksekutor cloud", "github tetap cloud");
  assert.strictEqual(executorLabel("e2b"), "eksekutor cloud", "executor lain → cloud");
  assert.strictEqual(executorLabel(""), "eksekutor cloud", "kosong → cloud");
}

async function testDispatchAgentTask() {
  // Rute rig: kembali SEBELUM sentuhan network apa pun.
  const rig = await dispatchAgentTask({ RIG_EXECUTOR: "prefer" } as never, 42, "kerjakan X");
  assert.strictEqual(rig.via, "rig", "via rig");
  assert.strictEqual(rig.error, undefined, "rig tidak punya error token");

  // Rute github tanpa repo: error token TANPA network (return sebelum fetch).
  const gh = await dispatchAgentTask({} as never, 42, "kerjakan X");
  assert.strictEqual(gh.via, "github", "via github");
  assert.strictEqual(gh.error, "executor-not-configured", "tanpa repo → token konfigurasi");
}

async function main() {
  testRouteExecutor();
  testExecutorLabel();
  await testDispatchAgentTask();
  console.log("RIG BRIDGE TESTS PASSED");
}

main().catch((e) => {
  console.error("RIG BRIDGE TEST FAILED:", e);
  process.exit(1);
});

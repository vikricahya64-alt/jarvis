//=====================================================================
// executor_selection.ts — KECERDASAN CABANG: pilih eksekutor berdasarkan
// OUTPUT yang dihasilkan (evidence-driven), bukan predikat statis saja.
//
// PRINSIP SUBSTITUSI (arahan pemilik): jika kemampuan pinjaman kategori
// eksekutor eksternal dapat menggantikan kemampuan lain dengan output yang
// SAMA atau LEBIH BAIK, gantikan. Penerapan paling jelas di jalur riset:
//   - jalur cepat (inline `search_synthesize`, meminjam search + LLM) — murah,
//     tapi kala mesin pencari mati ia hanya bisa menghasilkan jawaban model
//     TANPA sumber terverifikasi (grounded=false).
//   - eksekutor sandbox E2B (pihak ketiga konsep-sistem penuh: shell, python,
//     internet, git) — output STRICTLY BETTER untuk riset asli (tools nyata,
//     kutipan sumber, kerja agentik), di-orkestrasi melalui ledger agent_tasks.
//
// ATAURAN: jalur cepat tetap dipakai selagi output-nya ter-grounding. Hanya
// ketika output inline TERBUKTI lebih buruk (grounded=false pada topik riset
// yang sudah ter-konfirmasi) cabangnya beralih ke eksekutor pihak ketiga.
// E2B hanyalah contoh pertama — tipe `ConceptExecutor` adalah kontrak plugin,
// calon berikutnya: GitHub/open-code, Vercel connector task, dll.
//
// Fail-closed menyeluruh: tanpa kunci → null; predikat murni & sinkron;
// kegagalan delegasi tercatat sebagai baris tugas gagal yang terlihat, tidak
// pernah hilang diam-diam. Tidak ada outbound pada jalur keputusan panas.
//=====================================================================

import { Env } from "./db";
import { e2bConfigured } from "./e2b";
import { delegateToE2b } from "./e2b_executor";
import { addAgentTask, markAgentTaskRunning, finishAgentTask } from "./db";

/** Concept-system executors JARVIS can hand a task to as the THIRD PARTY
 *  (each implements the same delegation contract: ledger + detached run +
 *  poll + DM). Adding a platform = adding its tag + a configured check. */
export type ConceptExecutor = "e2b";
export const CONCEPT_EXECUTORS: ConceptExecutor[] = ["e2b"];

/** Which concept-system executor is wired (synchronous, key-based, no
 *  network). Deterministic: no key → null, so the hot path never probes. */
export function pickEscalationExecutor(env: Env): ConceptExecutor | null {
  return e2bConfigured(env) ? "e2b" : null;
}

/** The output-shaped result of `searchAndSynthesize` we judge by. Null-safe:
 *  a missing/empty shape is treated as not-escalatable (fail-closed keep). */
export type SynthesisEvidence = {
  reply?: string | null;
  source?: string | null;
  grounded?: boolean;
};

/** PURE, deterministic judgment: only an UNAMBIGUOUSLY ungrounded synthesis
 *  (LLM answered with ZERO search evidence) deserves an executor switch.
 *  Canned / self-referential / grounded replies stay on their own paths. */
export function shouldEscalateToConceptExecutor(res: SynthesisEvidence | null): boolean {
  if (!res) return false;
  if (!res.reply) return false;
  if (res.source === "canned" || res.source === "self_ref") return false;
  return res.grounded === false;
}

/** COMMIT the escalation: queue the research task on the ledger and launch
 *  the sandbox NOW (E2B's own poller completes + DMs it). Returns the ack
 *  text for the owner, or null when nothing to escalate / not configured.
 *  Never throws. */
export async function maybeEscalateToE2b(
  env: Env,
  owner: number,
  task: string,
  res: SynthesisEvidence | null,
): Promise<string | null> {
  try {
    if (!shouldEscalateToConceptExecutor(res)) return null;
    if (pickEscalationExecutor(env) !== "e2b") return null;
    const clean = (task || "").trim();
    if (!clean || clean.length < 3) return null;

    const id = await addAgentTask(env, owner, clean.slice(0, 4000), "e2b");
    if (!id) return null;
    await markAgentTaskRunning(env, id);

    const { runId, error } = await delegateToE2b(env, clean).catch(() => ({ runId: "", error: "e2b-escalate-error" }));
    if (error) {
      await finishAgentTask(env, id, "failed", "", error);
      return null;
    }
    await markAgentTaskRunning(env, id, runId ?? "");
    return (
      `🍃 Topik ini kuselidiki lewat jalur riset cepat, tapi hasilnya tidak punya sumber terverifikasi — ` +
      `sebaiknya tidak kusampaikan sebagai riset. Aku *pinjam eksekutor sandbox E2B* ` +
      `(pihak ketiga, konsep-sistem penuh) untuk mengerjakannya. ` +
      `Hasil akan langsung di-DM ke kamu (riwayat: /tugas list).`
    );
  } catch {
    return null;
  }
}
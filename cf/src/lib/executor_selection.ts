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
import { translateTaskToExecutable, type ExecutablePlan } from "./translator";

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

/** Injectable side-effects for tests (defaults are the real implementations).
 *  Kept tiny so the ordering contract can be verified WITHOUT network/DB. */
export type EscalateDeps = {
  translate?: (env: Env, task: string, opts?: { constraint?: string }) => Promise<ExecutablePlan | null>;
  delegate?: (env: Env, task: string, opts?: { riset?: boolean }) => Promise<{ runId?: string; error?: string }>;
};

/** COMMIT the escalation: translate the owner's goal into an executable
 *  (JARVIS = third-party interpreter), queue it on the ledger, and launch the
 *  sandbox NOW (E2B's own poller completes + DMs it). Returns the ack text
 *  for the owner, or null when nothing to escalate / not configured.
 *
 *  ORDERING CONTRACT (v11.43 fix): markAgentTaskRunning transitions
 *  pending→running against `WHERE status='pending'` — calling it TWICE (once
 *  blank, once with the sandbox id) makes the second a NO-OP and the run_id
 *  never lands on the ledger ("sandbox id hilang"). Therefore the sandbox is
 *  launched FIRST, then the row transitions ONCE with its run_id; a launch
 *  error marks it running and finishes it failed (finish needs status
 *  'running' to pass its own guard). Never throws. */
export async function maybeEscalateToE2b(
  env: Env,
  owner: number,
  task: string,
  res: SynthesisEvidence | null,
  deps: EscalateDeps = {},
): Promise<string | null> {
  try {
    if (!shouldEscalateToConceptExecutor(res)) return null;
    if (pickEscalationExecutor(env) !== "e2b") return null;
    const clean = (task ?? "").trim();
    if (!clean || clean.length < 3) return null;

    // JARVIS as the third-party interpreter: turn the owner's natural-language
    // goal into a bash/python executable the sandbox can actually run. The
    // E2B runner executes bash — raw prose would just fail. Translation
    // failure falls back to the raw text (older etask semantics), never throws.
    const translate = deps.translate ?? translateTaskToExecutable;
    const plan = await translate(env, clean).catch(() => null);
    const runnable = plan && plan.code ? plan.code : clean;

    const id = await addAgentTask(env, owner, runnable.slice(0, 4000), "e2b");
    if (!id) return null;

    const delegate = deps.delegate ?? delegateToE2b;
    const { runId, error } = await delegate(env, runnable).catch(
      () => ({ runId: "", error: "e2b-escalate-error" }),
    );
    if (error) {
      await markAgentTaskRunning(env, id); // pending→running so finish's guard passes
      await finishAgentTask(env, id, "failed", "", error);
      return null;
    }
    await markAgentTaskRunning(env, id, runId ?? ""); // SINGLE transition WITH the sandbox id
    const translatedNote = plan
      ? ` Saya sudah menerjemahkannya menjadi skrip *${plan.language}* yang dieksekusi sandbox.`
      : "";
    return (
      `🍃 Topik ini kuselidiki lewat jalur riset cepat, tapi hasilnya tidak punya sumber terverifikasi — ` +
      `sebaiknya tidak kusampaikan sebagai riset. Aku *pinjam eksekutor sandbox E2B* ` +
      `(pihak ketiga, konsep-sistem penuh) untuk mengerjakannya.${translatedNote} ` +
      `Hasil akan langsung di-DM ke kamu (riwayat: /tugas list).`
    );
  } catch {
    return null;
  }
}
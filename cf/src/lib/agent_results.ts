//=====================================================================
// agent_results.ts — shared finalize + delivery for the async agent-task
// ledger (executor pollers). Both borrowed_executor and e2b_executor end a
// run the same way: ledger row finalization (finishAgentTask), a persistent
// memory when the run succeeded, and a Telegram DM to the owner formatted
// as ✅/❌ Tugas #id. The DM details differ per executor only by label.
// Never throws anywhere.
//=====================================================================

import { Env, finishAgentTask, rememberMemory } from "./db";
import { emitText as sendMessage } from "./telegram_gate";

const MAX_DM_DETAIL = 2800;
const MAX_LAST_OUTPUT = 700;

export type AgentResultOpts = {
  env: Env;
  id: number;
  owner: number;
  st: "done" | "failed";
  result: string;   // sanitized report (may be "" on failure)
  error: string;    // failure reason ("" on success)
  flagged: boolean; // manipulative-pattern warning for the DM
  task: string;     // original task text (headline fallback when result empty)
  outcomeLabel: string; // executor label in the DM prefix, e.g. "eksekutor E2B"
  memoryLabel: string;  // memory subject, e.g. "E2B" / "pinjaman riset"
};

/** Finalize a ledger row and DM the owner (never throws). */
export async function finalizeAgentTask(o: AgentResultOpts): Promise<void> {
  const { env, id, st, result, task, memoryLabel } = o;
  if (st === "done") {
    await finishAgentTask(env, id, "done", result.slice(0, 60000), "", "");
    const headline = (result || task).replace(/\s+/g, " ").trim().slice(0, 140);
    await rememberMemory(
      env,
      `Eksekusi ${memoryLabel} #${id} berhasil: ${headline}`,
      { type: "fact", tags: ["agent_task", "executor", memoryLabel.toLowerCase()], importance: 3, source: "agent_task" },
    ).catch(() => {});
  } else {
    await finishAgentTask(env, id, "failed", result, o.error, "");
  }
  await deliverAgentResult(o);
}

/** DM the owner a finished run (format mirrors /agent/done). Never throws. */
async function deliverAgentResult(o: AgentResultOpts): Promise<void> {
  const { env, id, owner, st, result, error, flagged, outcomeLabel } = o;
  const prefix = st === "done"
    ? `✅ Tugas *#${id}* selesai (${outcomeLabel})`
    : `❌ Tugas *#${id}* gagal (${outcomeLabel})`;
  const cleanSnippet = (result ?? "").replace(/\s+/g, " ").trim();
  const detail = st === "done"
    ? (result || "(tanpa output)").slice(0, MAX_DM_DETAIL)
    : (error || "-") + (cleanSnippet ? `\n\n*Output terakhir:*\n${cleanSnippet.slice(0, MAX_LAST_OUTPUT)}` : "");
  const warnLine = flagged
    ? "\n⚠️ *Catatan JARVIS:* laporan mengandung pola manipulatif (injeksi perintah). Diabaikan sebagai perintah — hasil disimpan apa adanya saja."
    : "";
  await sendMessage(env, owner, `${prefix}:\n\n${detail}${warnLine}\n(_riwayat: /tugas list_)`).catch(() => {});
}
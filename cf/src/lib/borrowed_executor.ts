//=====================================================================
// borrowed_executor.ts — DELEGASI ASYNC untuk EKSEKUTOR EKSTERNAL kategori
// data/search/media (generalisasi penuh sistem /etask ke semua pinjaman).
//
// /e2b (sync) + /etask (async, ledger) meminjam E2B; /tugas meminjam
// GitHub Actions + opencode. Di sini pola yang SAMA diterapkan ke eksekutor
// eksternal yang tersisa — data/search/media — melalui runner JARVIS di
// sisi kami yang memakai platform pinjaman itu untuk mengerjakan tugas:
//
//   /pinjam riset  <topik>   → searchAndSynthesize (Pinjam: DDG/Bing/SearX
//                              + LLM groq/openrouter/gemini)
//   /pinjam docs   <library> → Context7 grounding docs (Pinjam: Context7)
//   /pinjam figma  <fileKey> → Figma read via Vercel Connector
//   /pinjam notion <query>   → Notion search/query via Connector
//   /pinjam cuaca  <kota>    → Open-Meteo forecast
//
// KATEGORI = EKSEKUTOR EKSTERNAL: JARVIS TIDAK membangun ulang kemampuan
// mereka; ia MEMINJAM platform yang mengeksekusi dengan kemampuan penuh.
// Seluruh alur memakai sistem yang sama dengan eksekutor lain: ledger
// agent_tasks (executor='borrowed:<id>'), pelaksanaan oleh cron poller,
// sanitasi + flag injeksi, dan DM hasil ke pemilik (mirip /agent/done).
// Fail-closed di semua jalur: tidak pernah throw; eksekutor yang tak dikenal
// atau hasil kosong menjadi tugas gagal dengan alasan yang terlihat, bukan
// hilang diam-diam. Payload cap + truncation notice dipakai bersama.
//=====================================================================

import { Env, listBorrowedAgentTasks } from "./db";
import { sanitizeAgentReport, flagAgentReport } from "./agent_executor";
import { finalizeAgentTask } from "./agent_results";
import { searchAndSynthesize } from "./ai";
import { lookupLibraryDocs } from "./context7";
import { readFigmaViaVercel, notionSearchViaVercel } from "./vercel";
import { getWeatherText } from "./weather";

export type BorrowedExecutorId = "riset" | "docs" | "figma" | "notion" | "cuaca";

export const BORROWED_EXECUTOR_IDS: BorrowedExecutorId[] = [
  "riset", "docs", "figma", "notion", "cuaca",
];

/** Tag stored in agent_tasks.executor so the poller can pick the row back up. */
export const borrowedExecutorTag = (id: BorrowedExecutorId): string => `borrowed:${id}`;

export type BorrowedResolve = { executor: BorrowedExecutorId | null; body: string };
export type NormalizedTask = { tag: string; body: string };

/** Pure: parse "<eksekutor> <tugas>" into a resolved executor + task body.
 *  Unknown/empty executor → { executor: null, body } (caller rejects). */
export function parseBorrowedTarget(text: string): BorrowedResolve {
  const t = (text ?? "").trim();
  const m = t.split(/\s+(.+)/s);
  const head = (m[0] ?? "").toLowerCase();
  const body = (m[1] ?? "").trim();
  if (BORROWED_EXECUTOR_IDS.includes(head as BorrowedExecutorId)) {
    return { executor: head as BorrowedExecutorId, body };
  }
  return { executor: null, body: t };
}

/** Pure: normalize an executor tag row back into (id, stripped body). */
export function parseBorrowedRow(task: string, tag: string): NormalizedTask {
  const id = (tag ?? "").replace(/^borrowed:/, "") as BorrowedExecutorId;
  const body = (task ?? "")
    .replace(new RegExp(`^${id}\\s+`, "i"), "")
    .replace(/^borrowed:[a-z]+\s+/i, "")
    .trim();
  return { tag: borrowedExecutorTag(id), body };
}

/** Human label (markdown-safe) for the poller's outcome prefix. */
export function borrowedExecutorLabel(id: BorrowedExecutorId): string {
  switch (id) {
    case "riset": return "riset web (DDG/Bing/SearX + LLM)";
    case "docs": return "dokumentasi Context7";
    case "figma": return "file Figma";
    case "notion": return "database Notion";
    case "cuaca": return "cuaca Open-Meteo";
  }
}

/** Pure: build the riset report honoring evidence. A synthesis produced with
 *  ZERO search output is not verified research — the report must carry a clear
 *  ungrounded notice (never a confident ✅). Grounded replies pass through. */
export function borrowedRisetReport(reply: string, grounded: boolean): string {
  if (grounded) return reply;
  return `${reply}\n\n⚠️ _Catatan JARVIS: tidak ada hasil pencarian terverifikasi saat eksekusi — ringkasan di atas berdasar pengetahuan model, bukan riset ter-grounding. Coba lagi nanti atau pakai \`/pinjam docs <library>\`._`;
}

/** Execute ONE borrowed task to a string report (fail-closed → "" on any
 *  error; the poller turns empty reports into a failed row). */
export async function runBorrowedExecutor(
  env: Env,
  id: BorrowedExecutorId,
  body: string,
  owner = 0,
): Promise<string> {
  const b = body || "";
  if (!b.trim()) return "";
  switch (id) {
    case "riset": {
      const res = await searchAndSynthesize(env, owner, b, b, {
        replyLang: "id",
      }).catch(() => null);
      if (!res?.reply || res.source === "canned") return "";
      // EVIDENCE HONESTY: route through the pure transform so ungrounded
      // output is visibly labeled, not dressed up as verified research.
      return borrowedRisetReport(res.reply, res.grounded ?? false);
    }
    case "docs": {
      const res = await lookupLibraryDocs(env, b).catch(() => ({ reply: null, ok: false, reason: "api_down" } as const));
      if (res.ok && res.reply) return res.reply;
      return ""; // unreported failure surface
    }
    case "figma": {
      const res = await readFigmaViaVercel(env, b).catch(() => null);
      return res?.summary ?? "";
    }
    case "notion": {
      const rows = await notionSearchViaVercel(env, b).catch(() => []);
      if (!rows.length) return "";
      return "🔎 *Hasil pencarian Notion*\n" +
        rows.map((r, i) => `${i + 1}. ${r.title} — \`${r.id.slice(0, 16)}\` (${r.kind})`).join("\n");
    }
    case "cuaca": {
      return await getWeatherText(b).catch(() => "");
    }
    default:
      return ""; // unknown id → fail-closed empty report
  }
}

/** Per-minute cron poller: execute pending borrowed-executor runs on the
 *  ledger, sanitize, DM the owner each report (mirrors /etask poller).
 *  Returns the number of tasks finalized this tick. Never throws. */
export async function pollBorrowedRuns(env: Env, limit = 6): Promise<number> {
  const rows = await listBorrowedAgentTasks(env, limit);
  let finished = 0;
  for (const t of rows) {
    const parsed = parseBorrowedRow(t.task, t.executor ?? "");
    const id = parsed.tag.replace(/^borrowed:/, "") as BorrowedExecutorId;
    const report = await runBorrowedExecutor(env, id, parsed.body, t.owner_id);
    const raw = sanitizeAgentReport(report);
    const flagged = flagAgentReport(raw);
    const base = {
      env, id: t.id, owner: t.owner_id, task: t.task, flagged,
      outcomeLabel: "eksekutor pinjaman", memoryLabel: `pinjaman ${id}`,
      executorType: "borrowed" as const,
    };
    if (!raw) {
      await finalizeAgentTask({ ...base, st: "failed", result: "", error: `eksekutor ${id} tidak menghasilkan hasil` });
      finished++;
      continue;
    }
    await finalizeAgentTask({ ...base, st: "done", result: raw, error: "" });
    finished++;
  }
  return finished;
}
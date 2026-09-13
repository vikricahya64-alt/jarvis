//=====================================================================
// gap_upgrade.ts — PHASE 4: gap→upgrade auto-proposal loop.
//
// Observability first, automation second (Alice Labs / R. Kumar HALT
// protocol): the failure ledgers (verifier.tallyGate + failure.tallyFailure)
// are aggregated across a rolling window by failure.readFailureLedger, and
// EVERY significant, recurring gap becomes a STRUCTURED, DEDUPLICATED
// auto-proposal — a candidate fix for a specific capability + failure
// class. Proposals are proposals: detection is deterministic and free of
// LLM calls (budgeted, fail-open), human/beat-verification applies before
// the proposed change is merged.
//
// Dedupe contract: one OPEN slot per (capability, failure class). Within the
// same rolling window a resolved gap is NOT re-proposed (an applied/rejected
// stamp suppresses the duplicate); when the window rolls over, the gap is
// measured again and re-proposed if still resident.
//
// All KV writes are fire-and-forget best-effort (never throws to caller).
//=====================================================================

import { Env } from "./db";
import { readFailureLedger, type FailureClass, type FailurePath } from "./failure";
import { getCapability } from "./capability_registry";

// ---------------------------------------------------------------------------
// Tuning
// ---------------------------------------------------------------------------

/** Rolling window length (days) for gap aggregation. */
export const GAP_LEDGER_DAYS = 7;
/** Minimum window count for a (cap, class) pair to count as a gap. */
export const GAP_MIN_7D = 3;

export type GapStatus = "open" | "applied" | "rejected";

export interface GapProposal {
  cap: string;
  failureClass: FailureClass;
  count: number;
  windowStart: number;
  ts: number;
  fix: string;
  fixDetail?: string;
  status: GapStatus;
}

/** Map ledger tally path → registry capability id (single source of truth). */
export function capIdForPath(path: FailurePath): string {
  switch (path) {
    case "translate": return "translate";
    case "understand": return "understand";
    case "context7": return "context7";
    case "borrowed": return "search";
    case "e2b": return "search";
    case "search_synth":
    case "subagents":
    default:
      return "search";
  }
}

/** Window anchor: start of today in ms UTC. */
export function windowStart(now = Date.now()): number {
  const d = new Date(now);
  d.setUTCHours(0, 0, 0, 0);
  return d.getTime();
}

// ---------------------------------------------------------------------------
// Candidate fix hints (deterministic; no LLM in the detection loop)
// ---------------------------------------------------------------------------

const GAP_FIX_HINTS: Record<string, string> = {
  "search_synth:truncated":
    "Sintesis terlalu panjang untuk max_tokens — naikkan budget token / perpendek instruksi agar penjelasan selesai.",
  "search_synth:repetitive":
    "Follow-up mengulang anchor — pertajam ambang isRepetitiveText atau pisahkan deteksi topik-baru dengan lebih tegas.",
  "search_synth:raw_dump":
    "HTML/JSON bocor ke jawaban — kuatkan perintah anti-leak dan rapatkan filter isRawDumpText di pipeline.",
  "search_synth:non_answer":
    "Provider hanya melempar tautan/stub — perkuat instruksi 'jawab utuh' dan naikkan kualitas query.",
  "search_synth:timeout":
    "Pencarian/provider batas waktu — naikkan timeout fetch atau tambah failover sumber.",
  "search_synth:blocked":
    "Sumber memblokir/scrape ditolak — ganti sumber cadangan (Bing/API) atau kurangi frekuensi permintaan.",
  "subagents:raw_dump":
    "Hasil sub-agent bocor markah — perketat tidy di perakitan analisis akhir.",
  "subagents:repetitive":
    "Analisis riset mengulang anchor — perkuat instruksi non-repetisi di orchestrateResearch.",
  "subagents:non_answer":
    "Perakitan riset menghasilkan stub — pastikan bagian temuan benar-benar diisi sebelum dirangkum.",
  "translate:timeout":
    "Penerjemahan terputus waktu — naikkan timeout/retry translateText atau failover provider.",
  "translate:blocked":
    "Provider translate menolak — tambah cadangan provider/format ulang permintaan.",
  "translate:empty":
    "translateText kosong — pantau apakah sumber pesan kosong sebelum diproses.",
  "understand:empty":
    "Klarifikasi LLM gagal menghasilkan — fallback tanya lintas format atau perkuat prompt memahami.",
  "context7:empty":
    "Docs library tidak ditemukan — perluas matcher cleanLibrary / tambah alias repo.",
  "context7:timeout":
    "API context7 lambat — naikkan timeout atau tambah cache per library.",
  "context7:blocked":
    "context7.com menolak — kurangi frekuensi / pakai jalur cadangan.",
  "borrowed:raw_dump":
    "Output borrowed executor bocor markah — rapatkan sanitasi di runBorrowedExecutor.",
  "borrowed:non_answer":
    "Borrowed executor mengembalikan stub/error — perkuat penanganan error di pollBorrowedRuns.",
  "borrowed:truncated":
    "Output borrowed executor terpotong — naikkan batas output atau bagilah tugas.",
  "e2b:raw_dump":
    "Output E2B sandbox bocor JSON/code — perkuat filter di e2bOutcome.",
  "e2b:non_answer":
    "E2B mengembalikan error stub — periksa exit code sebelum persist.",
  "e2b:truncated":
    "Output E2B terpotong — naikkan E2B_OUTPUT_LIMIT atau fragmentasi output.",
};

export function fixHintFor(path: FailurePath, cls: FailureClass, count = 1): string {
  const base = GAP_FIX_HINTS[`${path}:${cls}`]
    ?? `Gap berulang di ${path} (${cls}) — tinjau kontrak capability dan pipeline terkait.`;
  if (count >= 10) return `[KRITIS ×${count}] ${base} — prioritas tinggi, perlu perbaikan segera.`;
  if (count >= 5) return `[Signifikan ×${count}] ${base} — pola berulang, tinjau dalam sprint berikutnya.`;
  if (count >= 3) return `[Observasi ×${count}] ${base}`;
  return base;
}

// ---------------------------------------------------------------------------
// KV layout
// ---------------------------------------------------------------------------

const openKey = (cap: string, cls: string) => `selfprop:open:${cap}:${cls}`;
const doneKey = (cap: string, cls: string) => `selfprop:done:${cap}:${cls}`;

// ---------------------------------------------------------------------------
// Loop
// ---------------------------------------------------------------------------

export interface GapUpgradeResult {
  analyzed: number;
  proposed: GapProposal[];
  opened: number;
  deduped: number;
}

/** Run one gap→upgrade pass: aggregate the ledger window, flag recurring
 *  gaps, and open (or re-open after window roll) deduplicated proposals.
 *  Deterministic, zero LLM calls, never throws. */
export async function runGapUpgradeLoop(env: Env): Promise<GapUpgradeResult> {
  const result: GapUpgradeResult = { analyzed: 0, proposed: [], opened: 0, deduped: 0 };
  if (!env) return result;
  try {
    const rows = await readFailureLedger(env, GAP_LEDGER_DAYS);
    result.analyzed = rows.length;
    const anchor = windowStart();

    for (const row of rows) {
      if (!row.count || row.count < GAP_MIN_7D) continue;
      const cap = capIdForPath(row.path);
      const cls = row.failureClass;
      const openRaw = await env.CONFIG_KV?.get(openKey(cap, cls)).catch(() => null);
      const open = openRaw ? safeParse(openRaw) : null;
      if (open && open.windowStart === anchor) {
        result.deduped += 1;
        continue;
      }
      // Suppress re-proposing a gap that was already resolved THIS window.
      const doneRaw = await env.CONFIG_KV?.get(doneKey(cap, cls)).catch(() => null);
      const done = doneRaw ? safeParse(doneRaw) : null;
      if (done && done.windowStart === anchor && done.ts > (open?.ts ?? 0)) {
        result.deduped += 1;
        continue;
      }

      const proposal: GapProposal = {
        cap,
        failureClass: cls,
        count: row.count,
        windowStart: anchor,
        ts: Date.now(),
        fix: fixHintFor(row.path, cls, row.count),
        status: "open",
      };
      await env.CONFIG_KV?.put(openKey(cap, cls), JSON.stringify(proposal), { expirationTtl: 21 * 86400 }).catch(() => {});
      result.proposed.push(proposal);
      result.opened += 1;
    }
  } catch { /* best-effort */ }

  return result;
}

/** Resolve an OPEN proposal (applied/rejected). An audit stamp is kept for the
 *  current window so the same gap is not re-proposed until the window rolls. */
export async function resolveGapProposal(
  env: Env,
  cap: string,
  cls: FailureClass,
  status: Exclude<GapStatus, "open">,
): Promise<boolean> {
  if (!env) return false;
  try {
    const raw = await env.CONFIG_KV?.get(openKey(cap, cls)).catch(() => null);
    if (!raw) return false;
    const p = safeParse(raw) as GapProposal;
    p.status = status;
    p.ts = Date.now();
    await env.CONFIG_KV?.put(doneKey(cap, cls), JSON.stringify(p), { expirationTtl: 21 * 86400 }).catch(() => {});
    await env.CONFIG_KV?.delete(openKey(cap, cls)).catch(() => {});
    return true;
  } catch {
    return false;
  }
}

/** Read OPEN proposals across known capability × failure-class slots.
 *  Deterministic (registry-bound), never throws. */
export async function listGapProposals(env: Env): Promise<GapProposal[]> {
  const out: GapProposal[] = [];
  if (!env) return out;
  const classes: FailureClass[] = [
    "raw_dump", "non_answer", "truncated", "repetitive", "empty", "timeout", "blocked", "stale",
  ];
  const caps = ["search", "translate", "understand", "context7"];
  try {
    for (const cap of caps) {
      for (const cls of classes) {
        const raw = await env.CONFIG_KV?.get(openKey(cap, cls)).catch(() => null);
        if (!raw) continue;
        const p = safeParse(raw) as GapProposal;
        if (p && p.status === "open") out.push(p);
      }
    }
  } catch { /* best-effort */ }
  return out.sort((a, b) => b.count - a.count);
}

/** Compact markdown summary of open auto-proposals (for /status + briefing). */
export async function describeGapProposals(env: Env): Promise<string> {
  const open = await listGapProposals(env);
  if (!open.length) return "";
  const capLabel = (c: string) => getCapability(c as never)?.label ?? c;
  return (
    "*Auto-proposals (gap→upgrade, 7 hari)*\n" +
    open.map((p) => `  • *${capLabel(p.cap)}* — ${p.failureClass} (×${p.count}): ${p.fix}`).join("\n")
  );
}

/** Parse a KV JSON blob safely and return null on anything unexpected. */
function safeParse(raw: string): GapProposal | null {
  try {
    const p = JSON.parse(raw) as GapProposal;
    return p && typeof p === "object" && typeof p.fix === "string" ? p : null;
  } catch {
    return null;
  }
}
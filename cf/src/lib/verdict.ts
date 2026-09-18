//=====================================================================
// verdict.ts — canonical tri-state gate contract.
//
// Semua gate JARVIS bernilai dua (true/false). Proposal pemilik: tambah
// status ketiga "unknown" sesuai konteks gate, tanpa membuat perilaku
// fail-closed runtuh. Modul ini adalah kontrak tunggalnya:
//
//   Gate = "allow" | "deny" | "unknown"
//
//   - allow  : bukti CUKUP dan mengarah ke izin.
//   - deny   : bukti CUKUP dan mengarah ke blokir (fail-closed keras).
//   - unknown: bukti TIDAK cukup / konflik / validator tak tersedia —
//              TIDAK PERNAH lolos begitu saja. Di jalur keamanan → dianggap
//              deny + audit reason; di jalur pemahaman/bukti → rute ke
//              klarifikasi (relevance park, ask_search, dst).
//
// Modul ini DEPENDENCY-FREE (tanpa import runtime) supaya tidak ada siklus
// dengan gate gate lain. Mapper string-pinned (GateVerdict/AnswerMode/action)
// memakai string literal inline — bukan import type — supaya verifier/
// confidence_router/command_hierarchy TIDAK berubah kontraknya dan test
// strictEqual yang memin eratnya tetap hijau.
//=====================================================================

export type Gate = "allow" | "deny" | "unknown";

export interface Verdict {
  verdict: Gate;
  reason: string;
}

/** true hanya ketika verdict eksplisit "allow". */
export function gateAllows(g: Gate | { verdict: Gate; reason?: string }): boolean {
  return (typeof g === "string" ? g : g.verdict) === "allow";
}

/** true ketika verdict berupa deny ATAU unknown (fail-closed view). */
export function gateBlocks(g: Gate | { verdict: Gate; reason?: string }): boolean {
  const v = typeof g === "string" ? g : g.verdict;
  return v === "deny" || v === "unknown";
}

export function gateUnknown(g: Gate | { verdict: Gate; reason?: string }): boolean {
  return (typeof g === "string" ? g : g.verdict) === "unknown";
}

export function toVerdict(g: Gate, reason: string): Verdict {
  return { verdict: g, reason };
}

/**
 * AND-composition untuk jalur KEAMANAN (fail-closed):
 *   satu deny  -> deny   (blokir menang)
 *   satu unknown + tanpa deny -> unknown (tidak boleh lolos)
 *   semua allow -> allow
 * Konflik (allow vs deny) tercatat dalam reason; deny selalu menang.
 */
export function andGates(...vs: Array<{ verdict: Gate; reason?: string }>): Verdict {
  const denies = vs.filter((v) => v.verdict === "deny");
  if (denies.length > 0) {
    const conflicts = vs.filter((v) => v.verdict === "allow").map((v) => v.reason ?? "?").join(" | ");
    return {
      verdict: "deny",
      reason: conflicts
        ? `gate_conflict: deny("${denies[0]?.reason ?? "?"}") vs allow("${conflicts}")`
        : `deny("${denies[0]?.reason ?? "?"}")`,
    };
  }
  const unknowns = vs.filter((v) => v.verdict === "unknown");
  if (unknowns.length > 0) {
    return {
      verdict: "unknown",
      reason: `unknown(${unknowns.map((v) => v.reason ?? "?").join(" + ")})`,
    };
  }
  return { verdict: "allow", reason: vs.map((v) => v.reason ?? "?").filter(Boolean).join(" + ") || "all_gates_allow" };
}

/**
 * OR-composition untuk jalur PEMAHAMAN/BUKTI (satu izin cukup):
 *   satu allow -> allow
 *   tanpa allow, satu unknown -> unknown
 *   semua deny -> deny
 * Unknown menang atas deny: jalan ke klarifikasi, bukan blokir keras.
 */
export function orGates(...vs: Array<{ verdict: Gate; reason?: string }>): Verdict {
  const allows = vs.filter((v) => v.verdict === "allow");
  if (allows.length > 0) {
    return { verdict: "allow", reason: `allow(${allows.map((v) => v.reason ?? "?").join(" + ")})` };
  }
  const unknowns = vs.filter((v) => v.verdict === "unknown");
  if (unknowns.length > 0) {
    return { verdict: "unknown", reason: `unknown(${unknowns.map((v) => v.reason ?? "?").join(" + ")})` };
  }
  return { verdict: "deny", reason: `deny(${vs.map((v) => v.reason ?? "?").join(" + ")})` };
}

// ============================================================================
// Mapper dari gate string-pinned (tanpa mengubah kontrak fungsi aslinya).
// String literal inline — tidak impor tipe → zero siklus runtime.
// ============================================================================

/** Map output-quality verdict (verifier.gateVerdict) ke Gate.
 *  "ok" -> allow; "unknown" tidak muncul dari gateVerdict (blank sudah
 *  non_answer); seluruh failure class -> deny. textLen memberi sinyal
 *  borderline yang terlalu pendek untuk dinilai. */
export function verdictToGate(
  v: "raw_dump" | "non_answer" | "truncated" | "repetitive" | "ok",
  textLen = 0,
): Gate {
  if (v === "ok") return textLen > 0 && textLen < 3 ? "unknown" : "allow";
  if (v === "truncated" || v === "non_answer") return textLen > 0 && textLen < 3 ? "unknown" : "deny";
  return "deny";
}

/** Map mode jawab (confidence_router.decideAnswerMode) ke Gate:
 *  direct -> allow; ask_search/clarify -> unknown (rute klarifikasi). */
export function answerModeToGate(m: "direct" | "ask_search" | "clarify"): Gate {
  return m === "direct" ? "allow" : "unknown";
}

/** Map hierarki keputusan (command_hierarchy Decision.action) ke Gate:
 *  EXECUTE -> allow; BLOCK/DEFER -> deny; CLARIFY/CONSENT -> unknown. */
export function hierarchyActionToGate(
  a: "EXECUTE" | "BLOCK" | "DEFER" | "CLARIFY" | "CONSENT",
): Gate {
  if (a === "EXECUTE") return "allow";
  if (a === "BLOCK" || a === "DEFER") return "deny";
  return "unknown";
}
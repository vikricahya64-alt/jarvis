//=====================================================================
// executor_selection.ts — KECERDASAN CABANG: pilih eksekutor berdasarkan
// OUTPUT yang dihasilkan (evidence-driven), bukan predikat statis saja.
//
// PRINSIP SUBSTITUSI (arahan pemilik): jika kemampuan pinjaman kategori
// eksekutor eksternal dapat menggantikan kemampuan lain dengan output yang
// SAMA atau LEBIH BAIK, gantikan. Penerapan paling jelas di jalur riset:
//   - jalur cepat (inline `search_synthesize`, meminjam search + LLM) — murah,
//     tapi kala hasilnya TIDAK benar-benar bersumber ia hanya model knowledge.
//   - eksekutor sandbox E2B (pihak ketiga konsep-sistem penuh: shell, python,
//     internet, git) — output STRICTLY BETTER untuk riset asli (tools nyata,
//     kutipan sumber, kerja agentik), di-orkestrasi melalui ledger agent_tasks.
//
// PERAN (v11.45, koreksi konsep): JARVIS adalah NEGOSIATOR + PENERJEMAH
// keinginan pemilik. Ia berdiri SEPENUHNYA di sisi pemilik; yang "pihak
// ketiga" adalah PENERJEMAH (groq:translator) dan EKSEKUTOR (E2B) yang
// dinegosiasikan/diawasi JARVIS. KEPUTUSAN EKSEKUSI SELALU DI PEMILIK:
// JARVIS menyusun + menerjemahkan rencana, menyimpannya, dan meminta
// persetujuan ("ya proyek") — TIDAK ADA jalur yang membuka sandbox tanpa
// keputusan pemilik (koreksi dari v11.41 yang meluncurkan langsung).
//
// Fail-closed menyeluruh: tanpa kunci → null; tanpa rencana terjemahan →
// null; keputusan predikat murni; tidak ada outbound pada jalur keputusan.
//=====================================================================

import { Env } from "./db";
import { e2bConfigured } from "./e2b";
import { parkProjectPlan } from "./project_plan";
import { negotiateGoalTranslate } from "./translator";

/** Concept-system executors JARVIS can hand a task to as the THIRD PARTY
 *  (each implements the same delegation contract: ledger + detached run +
 *  poll + DM, gated by the owner's approval). Adding a platform = adding
 *  its tag + a configured check. */
export type ConceptExecutor = "e2b";
export const CONCEPT_EXECUTORS: ConceptExecutor[] = ["e2b"];

/** Which concept-system executor is wired (synchronous, key-based, no
 *  network). Deterministic: no key → null, so the hot path never probes. */
export function pickEscalationExecutor(env: Env): ConceptExecutor | null {
  return e2bConfigured(env) ? "e2b" : null;
}

/** The output-shaped result of `searchAndSynthesize` we judge by. Null-safe:
 *  a missing/empty shape is treated as not-escalatable (fail-closed keep).
 *  `citedSources`/`hitsAvailable` (v11.45) let JARVIS judge whether the
 *  answer was grounded BY THE ANSWER (cites real URLs) not just by the fact
 *  that a search happened at all. */
export type SynthesisEvidence = {
  reply?: string | null;
  source?: string | null;
  grounded?: boolean;
  citedSources?: number;
  hitsAvailable?: number;
  /** Apakah mesin pencari benar-benar DIPANGGIL untuk menjawab ini (false =
   *  jawaban dari memori/kenal-topik tanpa pencarian). v11.49: penanda untuk
   *  gerbang evidence — butir bersumber yang dijawab tanpa mencari berarti
   *  model knowledge yang dipoles, bukan hasil ambil-butir yang sah. */
  searched?: boolean;
};

/** PURE, deterministic judgment #1: only an UNAMBIGUOUSLY ungrounded synthesis
 *  (LLM answered with ZERO search evidence) deserves an executor switch.
 *  Canned / self-referential / grounded replies stay on their own paths. */
export function shouldEscalateToConceptExecutor(res: SynthesisEvidence | null): boolean {
  if (!res) return false;
  if (!res.reply) return false;
  if (res.source === "canned" || res.source === "self_ref") return false;
  return res.grounded === false;
}

/** Permintaan riset yang MENUNTUT butir bersumber (angka/daftar/artikel/berita
 *  terbaru) — jawaban tanpa SATU pun kutipan tidak bisa dipercaya di sini.
 *  v11.49: di-export sebagai satu sumber; dipakai BOTH oleh gerbang evidence
 *  (ikat: jawaban wajib mengutip) DAN oleh ai.ts (halangi memori-shortcut di
 *  jalur ambil-butir — jangan pernah menjawab butir tanpa mencari). */
export function isSourcingAsk(text: string): boolean {
  return SOURCING_ASK_RE.test((text ?? "").trim());
}
const SOURCING_ASK_RE =
  /(artikel|berita|daftar|list|link|sumber|betapa|berapa|nilai|teratas|terbaru|rangkum|ringkas|sebutkan|tuliskan?\s+\d|\btop\s+\d|\b\d+\s+(artikel|hasil|item|putaran))/i;

/** PURE, deterministic judgment #2 (v11.45 "jawaban harus benar-benar
 *  bersumber"): mesin pencari MEMBERI sumber (hitsAvailable>0) TAPI jawaban
 *  yang dikirim mengutip NOL sumber nyata (citedSources===0) pada permintaan
 *  yang eksplisit menuntut butir — itu model knowledge, bukan riset. JARVIS
 *  sebagai negosiator menolaknya dan menawarkan eksekutor yang sebenarnya.
 *
 *  v11.49 FIX (kasus live): follow-up yang topiknya sudah "dikenal" membuat
 *  search SKIPPED (memori-shortcut) → hitsAvailable=0, jadi gerbang lama
 *  (butuh hits>0) tidak pernah menyala → jawaban memori yang mengkarang
 *  (CNBC/The Verge/Reuters padahal tidak ditarik) lolos apa adanya. Sekarang:
 *  sourcing-ask + nol kutipan → eskalasi bila (a) hit benar-benar ada tapi
 *  tidak dikutip, ATAU (b) pencarian bahkan tidak dijalankan (searched=false). */
export function shouldEscalateByAnswerEvidence(res: SynthesisEvidence | null, askText: string): boolean {
  if (!res) return false;
  if (!res.reply) return false;
  if (res.source === "canned" || res.source === "self_ref") return false;
  if (res.grounded === false) return true;
  if (!isSourcingAsk(askText)) return false;
  if ((res.citedSources ?? 0) > 0) return false;
  return (res.hitsAvailable ?? 0) > 0 || res.searched === false;
}

/** Injectable side-effects for tests (defaults are the real implementations).
 *  Kept tiny so the negotiation contract can be verified WITHOUT network/DB. */
export type EscalateDeps = {
  negotiate?: (env: Env, task: string, opts?: { constraint?: string }) => Promise<
    | { kind: "plan"; plan: { language: "bash" | "python"; code: string; steps: string[]; summary: string } }
    | { kind: "ask"; ask: string }
    | null
  >;
  park?: (env: Env, owner: number, goal: string, language: string, code: string) => Promise<void>;
};

/** NEGOSIASI riset yang output-nya terbukti tidak bersumber: JARVIS
 *  menerjemahkan keinginan pemilik menjadi rencana eksekusi, MENYIMPANNYA,
 *  dan meminta keputusan pemilik. TIDAK ADA sandbox yang dibuka di sini —
 *  eksekusi terjadi hanya setelah pemilik menyetujui ("ya proyek"). Returns
 *  the message for the owner, or null when nothing to escalate/configured. */
export async function maybeEscalateToE2b(
  env: Env,
  owner: number,
  task: string,
  res: SynthesisEvidence | null,
  deps: EscalateDeps = {},
): Promise<string | null> {
  try {
    if (pickEscalationExecutor(env) !== "e2b") return null;
    const clean = (task ?? "").trim();
    if (!clean || clean.length < 3) return null;
    const should =
      shouldEscalateToConceptExecutor(res) || shouldEscalateByAnswerEvidence(res, clean);
    if (!should) return null;

    // JARVIS (negosiator): tanya penerjemah pihak ketiga atas nama pemilik.
    const negotiate = deps.negotiate ?? negotiateGoalTranslate;
    const g = await negotiate(env, clean).catch(() => null);
    if (!g) return null; // terjemahan gagal → jangan lanjutkan tanpa rencana

    if (g.kind === "ask") {
      // Penerjemah menilai tujuan belum jelas → NEGOSIASI: tanya balik pemilik.
      return (
        `🤝 Sebagai negosiatormu, aku sudah menanyakan tujuan ini ke penerjemah pihak ketiga. ` +
        `Ia butuh klarifikasi sebelum bisa membuat rencana:\n\n_${g.ask}_\n\n` +
        `Tuliskan ulang tujuannya (dengan detail), dan aku akan susun rencananya.`
      );
    }

    const plan = g.plan;
    const park = deps.park ?? parkProjectPlan;
    await park(env, owner, clean, plan.language, plan.code);
    const stepsLines = plan.steps.map((s, i) => `  ${i + 1}. ${s}`).join("\n");
    return (
      `🍃 Hasil riset cepat tidak punya sumber terverifikasi — sebagai *negosiator* ` +
      `(bukan sekadar pihak ketiga) aku sudah *menerjemahkan keinginanmu menjadi skrip* ` +
      `*${plan.language}* untuk eksekutor sandbox E2B (pihak ketiga yang menjalankan). ` +
      `*Keputusan eksekusi tetap di kamu*. Rencana tersimpan 30 menit.\n\n` +
      `*Tujuan:* ${clean.slice(0, 220)}\n` +
      `*Langkah yang akan dikerjakan:*\n${stepsLines}\n\n` +
      `Balas *ya proyek* untuk membuka sandbox dan menjalankannya — hasil akan di-DM (riwayat: /tugas list).`
    );
  } catch {
    return null;
  }
}
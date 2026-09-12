//=====================================================================
// capability_registry.ts — CAPABILITY REGISTRY + canonical router (control
// plane as a tool, Alice Labs agent-registry pattern).
//
// Single source of truth for every JARVIS capability:
//   - contract table: id, label, intent↔approach mapping, classification
//     priority, webhook-pre order, fallback target, required deps, error
//     codes, and the metrics key for the gap→upgrade tally (verifier.ts).
//   - canonical triggers (predicate) for the pre-brain capabilities
//     (translate / prompt_master / context7) — the SAME predicate drives the
//     webhook EXECUTE cascade AND the brain's classifyIntent(), so the two
//     routers can no longer drift apart (was fragmented regexes in both).
//   - read-only describeCapabilities() for introspection.
//
// IMPORTANT: classifiers that carry real nuance (emergency, design,
// self_referential, search depth) keep their logic in intelligence.ts /
// subagents.ts / identity.ts; the registry DOCUMENTS their contract but
// does not re-implement the trigger (no duplicated regex to rot).
// Fail-closed: every lookup here is pure & synchronous.
//=====================================================================

import { isPromptMasterRequest } from "./prompt_master";
import { isContext7Request } from "./context7";
import { SELF_REF_RE } from "./identity";
import { projectPlanKey } from "./project_plan";

export type CapabilityId =
  | "self_referential"
  | "emergency"
  | "prompt_master"
  | "context7"
  | "design"
  | "translate"
  | "search"
  | "followup"
  | "capability_branch"
  | "understand"
  | "command"
  | "chat"
  | "question";

// ============================================================================
// FONDASI (SANDARAN SEMUA KEMAMPUAN) — dimasukkan pemilik (m9-v11.32:
// komprehensi 1-5 + kemampuan cabang; m9-v11.47/49: tersurat; m9-v11.51:
// SEMUA kemampuan fondasi menyangga SEMUA kemampuan). Tidak ada kemampuan yang
// bertumpu hanya pada SATU fondasi — setiap kemampuan (otak & perintah) punya
// vision (kenapa ada) dan tersandar pada SELURUH kemampuan fondasi
// (foundations = ALL_FOUNDATIONS). Menambah kemampuan = mengisi fields ini
// juga; tes memaksakannya (testFoundationAnchoring). Fail-closed: tanpa
// visi/sandaran penuh → tes gagal, registri tidak meloloskan entri.
// ============================================================================

export type FoundationId =
  | "f1_teks"
  | "f2_literasi"
  | "f3_bahasa"
  | "f4_bidang"
  | "f5_sesi"
  | "f6_pahami"
  | "f7_cabang";

/** Label visi tiap fondasi — sebaran SATU sumber untuk pengetahuan-diri. */
export const FOUNDATION_LABELS: Record<FoundationId, string> = {
  f1_teks: "Memahami teks/tulisan dalam bentuk apa pun",
  f2_literasi: "Memahami semua literasi (gaul, formal, teknis, akademik, kreatif)",
  f3_bahasa: "Memahami semua bahasa manusia",
  f4_bidang: "Memahami semua bidang ilmu pengetahuan",
  f5_sesi: "Adaptasi per sesi pemilik",
  f6_pahami: "Pahami & gunakan semua kemampuan secara tepat",
  f7_cabang: "Gunakan kemampuan sesuai output terbaik (substitusi)",
};

/** SELURUH kemampuan fondasi — SANDARAN SETIAP kemampuan (m9-v11.51).
 *  Prinsip pemilik: tidak ada kemampuan yang bertumpu hanya pada SATU fondasi;
 *  SEMUA kemampuan fondasi menyangga SEMUA kemampuan. Setiap kontrak registri
 *  memakai daftar penuh ini (foundations: ALL_FOUNDATIONS); testFoundationAnchoring
 *  memaksakannya — fail-closed: tanpa sandaran penuh, registri tak meloloskan. */
export const ALL_FOUNDATIONS: FoundationId[] = [
  "f1_teks",
  "f2_literasi",
  "f3_bahasa",
  "f4_bidang",
  "f5_sesi",
  "f6_pahami",
  "f7_cabang",
];

export interface CapabilityContract {
  id: CapabilityId;
  /** Indonesian display label (user-facing). */
  label: string;
  /** One-line description of what the capability does. */
  brief: string;
  /** VISI (kenapa ada / cahaya yang diwujudkan) — bukan sekadar "bisa apa". */
  vision: string;
  /** SELURUH kemampuan fondasi yang MENYANGGA kemampuan ini (ALL_FOUNDATIONS) —
   *  JARVIS tidak pernah berjalan 'sebagian'; tak ada fondasi yang terpisah. */
  foundations: FoundationId[];
  /** The brain's IntentResult.type that this capability maps to. */
  intent: string;
  /** The brain's Strategy.approach used to execute this capability. */
  approach: string;
  /** Brain classifier priority (higher = checked earlier). */
  priority: number;
  /** Routed by the webhook PRE-BRAIN cascade (before the big search/media funnel). */
  webhookPre?: boolean;
  /** Order within the webhook pre cascade (lower = earlier). */
  webhookOrder?: number;
  /** Canonical trigger predicate — shared by BOTH routers when present. */
  predicate?: (text: string) => boolean;
  /** Degrade target when the capability handler fails (fail-closed chain). */
  fallbackId: string;
  /** Environment/workflow dependencies the capability needs to run. */
  requires: string[];
  /** Enumerable failure classes the capability can surface (verifier taxonomy). */
  errorCodes: string[];
  /** tally metric path for the gap→upgrade loop (verifier.tallyGate). */
  metricsKey: string;
}

/** Ordered-by-priority contract table (also fixes webhook-pre order). */
export const CAPABILITY_CONTRACTS: CapabilityContract[] = [
  {
    id: "self_referential",
    label: "Identitas Diri",
    brief: "Menjawab 'siapa kamu / apa yang bisa kamu lakukan' langsung dari sumber tunggal identitas, tanpa LLM eksternal.",
    vision: "Membaca pertanyaan 'siapa kamu' sebagai TEKS pemilik (f1) dan menjawab dari sumber identitas tunggal — siapa aku untuk pemilik inilah (f5).",
    foundations: ALL_FOUNDATIONS,
    intent: "self_referential",
    approach: "self_referential",
    priority: 900,
    predicate: (t) => SELF_REF_RE.test((t || "").trim().toLowerCase()),
    fallbackId: "self_referential",
    requires: [],
    errorCodes: [],
    metricsKey: "self_ref",
  },
  {
    id: "emergency",
    label: "Darurat",
    brief: "Menghentikan/override yang dinyatakan tegas (standalone marker, bukan topik yang dideskripsikan).",
    vision: "Menegaskan prioritas sesi pemilik (f5): memahami teks perintah dengan TEGAS (f1) — menghentikan pekerjaan sebagai kepatuhan, bukan nafsu mematikan.",
    foundations: ALL_FOUNDATIONS,
    intent: "emergency",
    approach: "simple_llm",
    priority: 890,
    fallbackId: "simple_llm",
    requires: [],
    errorCodes: ["TIMEOUT"],
    metricsKey: "emergency",
  },
  {
    id: "prompt_master",
    label: "Prompt-Master",
    brief: "Menyusun prompt optimal untuk tool AI target (skill prompt-master v1.8.0, sistem override).",
    vision: "Menghargai literasi teknis (f2) dan bidang target (f4): dari teks permintaan (f1) dihasilkan prompt paling tepat bagi tool AI — memakai kemampuan lain dengan benar (f6).",
    foundations: ALL_FOUNDATIONS,
    intent: "prompt_writer",
    approach: "prompt_master",
    priority: 800,
    webhookPre: true,
    webhookOrder: 2,
    predicate: (t) => isPromptMasterRequest(t),
    fallbackId: "simple_llm",
    requires: ["llm"],
    errorCodes: ["EMPTY", "TIMEOUT"],
    metricsKey: "prompt_master",
  },
  {
    id: "context7",
    label: "Context7 Docs",
    brief: "Menyediakan dokumentasi library terbaru (context7.com) untuk grounding anti-halusinasi.",
    vision: "Grounding anti-halusinasi lintas bidang (f4): dokumentasi teknis (f2) dibaca sebagai teks (f1) agar klaim selalu tertaut sumber nyata.",
    foundations: ALL_FOUNDATIONS,
    intent: "context7",
    approach: "context7_docs",
    priority: 790,
    webhookPre: true,
    webhookOrder: 3,
    predicate: (t) => isContext7Request(t),
    fallbackId: "simple_llm",
    requires: ["fetch", "CONTEXT7_API_KEY?"],
    errorCodes: ["EMPTY", "TIMEOUT", "BLOCKED"],
    metricsKey: "context7",
  },
  {
    id: "design",
    label: "Desain & Visual",
    brief: "Menghasilkan konsep desain + render gambar (flux) untuk permintaan kreatif.",
    vision: "Menerjemahkan permintaan kreatif (f1/f2/f4) menjadi output visual — sesuatu untuk pemilik, gaya seleranya (f5).",
    foundations: ALL_FOUNDATIONS,
    intent: "design",
    approach: "orchestrate_design",
    priority: 780,
    fallbackId: "search_synthesize",
    requires: ["AI"],
    errorCodes: ["EMPTY"],
    metricsKey: "design",
  },
  {
    id: "translate",
    label: "Terjemahan",
    brief: "Menerjemahkan teks (atau analisis terakhir bila tanpa target).",
    vision: "Menjembatani semua bahasa manusia (f3): memahami teks sumber (f1) lintas suatu ragam literasi (f2) dan menyampaikan kembali dengan setia kepada pemilik.",
    foundations: ALL_FOUNDATIONS,
    intent: "translation",
    approach: "translate",
    priority: 770,
    webhookPre: true,
    webhookOrder: 1,
    predicate: (t) => isTranslateCapRequest(t),
    fallbackId: "simple_llm",
    requires: ["llm"],
    errorCodes: ["EMPTY", "TIMEOUT"],
    metricsKey: "translate",
  },
  {
    id: "search",
    label: "Riset & Pencarian",
    brief: "Sintesis berbasis web (single-pass) dan riset mendalam orkestrator-worker untuk topik kompleks.",
    vision: "Mengumpulkan butir dari SEMUA bidang ilmu (f4) lewat teks sumber nyata (f1/f2), dengan verifikasi — dan bila output tak bersumber, cabang substitusi (f7/f6) mengambil alih.",
    foundations: ALL_FOUNDATIONS,
    intent: "search",
    approach: "search_synthesize",
    priority: 620,
    fallbackId: "canned",
    requires: ["fetch", "llm"],
    errorCodes: ["EMPTY", "TIMEOUT", "STALE"],
    metricsKey: "search_synth",
  },
  {
    id: "followup",
    label: "Lanjutan (Follow-up)",
    brief: "Memperdalam analisis terakhir dengan anchor yang konsisten; anti-repetisi.",
    vision: "Memperdalam garis pemikiran yang sama (f1/f4) dengan jangkar yang konsisten — adaptasi pada konteks sesi pemilik (f5), menolak mengulang (anti-repetisi).",
    foundations: ALL_FOUNDATIONS,
    intent: "search",
    approach: "search_synthesize",
    priority: 610,
    fallbackId: "canned",
    requires: ["kv"],
    errorCodes: ["REPETITIVE", "STALE"],
    metricsKey: "search_synth",
  },
  {
    id: "capability_branch",
    label: "Kemampuan Cabang (Substitusi Output)",
    brief: "Memilih kapabilitas/eksekutor yang output-nya SAMA atau LEBIH BAIK (prinsip substitusi yang dimasukkan pemilik): jawaban riset yang tidak benar-benar bersumber — grounded=false ATAU butir yang diminta (artikel/daftar/berita) tak mengutip sumber nyata — ditolak negosiator, rencana di-park, eksekutor konsep-sistem (E2B) yang sebenarnya berjalan HANYA setelah persetujuan pemilik. Fail-closed: tanpa eksekutor, jawaban inline tetap dipertahankan.",
    vision: "Menegakkan prinsip pemilik 'gunakan kemampuan sesuai output terbaik' (dirinya sendiri, f7): menilai hasil berbasis bukti dan mengganti ke eksekutor yang output-nya SAMA/LEBIH BAIK demi pemilik (f5) — bagian dari memakai semua kemampuan dengan tepat (f6).",
    foundations: ALL_FOUNDATIONS,
    intent: "research_escalated",
    approach: "evidence_substitution",
    priority: 610,
    fallbackId: "search",
    requires: ["llm", "e2b"],
    errorCodes: [],
    metricsKey: "capability_branch",
  },
  {
    id: "understand",
    label: "Pemahaman Maksud",
    brief: "Menerka keinginan pada input ambigu, atau bertanya klarifikasi alami.",
    vision: "INTI SANDARAN: memahami maksud pemilik PASTI lewat seluruh fondasi 1-5 — profil komprehensi (teks/literasi/bahasa/bidang/sesi) terjun menjadi persepsi, lalu menerka / bertanya sesuai f6.",
    foundations: ALL_FOUNDATIONS,
    intent: "understand",
    approach: "understand_intent",
    priority: 500,
    fallbackId: "simple_llm",
    requires: ["llm"],
    errorCodes: ["EMPTY"],
    metricsKey: "understand",
  },
  {
    id: "command",
    label: "Perintah",
    brief: "Perintah eksplisit (todo, reminder, pengaturan) via jalur brain.",
    vision: "Membaca teks perintah (f1) dan menunaikannya sebagai kepatuhan pada sesi pemilik (f5) — memilih jalur yang tepat (f6).",
    foundations: ALL_FOUNDATIONS,
    intent: "command",
    approach: "simple_llm",
    priority: 400,
    fallbackId: "simple_llm",
    requires: [],
    errorCodes: [],
    metricsKey: "command",
  },
  {
    id: "chat",
    label: "Obrolan",
    brief: "Sapaan ringan / obrolan kasual.",
    vision: "Sapaan ringan (f1/f2) yang hangat dan adaptif pada nada pemilik (f5).",
    foundations: ALL_FOUNDATIONS,
    intent: "chat",
    approach: "simple_llm",
    priority: 300,
    fallbackId: "simple_llm",
    requires: [],
    errorCodes: [],
    metricsKey: "chat",
  },
  {
    id: "question",
    label: "Pertanyaan Umum",
    brief: "Pertanyaan umum ke jalur LLM sederhana.",
    vision: "Menjawab pertanyaan dari semua bidang (f4) dalam bahasa dan tingkat literasi pemilik (f2/f3/f5).",
    foundations: ALL_FOUNDATIONS,
    intent: "question",
    approach: "simple_llm",
    priority: 200,
    fallbackId: "simple_llm",
    requires: [],
    errorCodes: [],
    metricsKey: "question",
  },
];

/** Canonical translate trigger, shared by webhook AND brain. Mirrors the old
 *  webhook head-regex but guards a word boundary so verb-like words
 *  ("translated …", "translation …", mid-sentence "tolong terjemahkan")
 *  no longer misfire, while preserving the old head-verb semantics:
 *  verb-only ("terjemahkan") and verb + target-language-only ("terjemahkan ke
 *  bahasa inggris") still route to the dedicated translate chain (which
 *  resolves the previous analysis when there is no inline text). */
export function isTranslateCapRequest(text: string): boolean {
  const t = (text ?? "").trim();
  if (!t) return false;
  return /^\s*(?:terjemahkan|translate)(?![\w-])/i.test(t);
}

const byId = new Map<CapabilityId, CapabilityContract>(
  CAPABILITY_CONTRACTS.map((c) => [c.id, c]),
);

export function getCapability(id: CapabilityId): CapabilityContract | undefined {
  return byId.get(id);
}

/** Resolve the FIRST matching capability (with a predicate) for `text`,
 *  scanning in priority order. `ids` narrows the candidate set so callers can
 *  preserve their own precedence (e.g. brain checks design before translation
 *  while webhook checks translation first). */
export function capabilityIntent(
  text: string,
  opts: { ids?: CapabilityId[] } = {},
): { id: CapabilityId; intent: string } | null {
  const want = opts.ids ? new Set(opts.ids) : null;
  for (const c of CAPABILITY_CONTRACTS) {
    if (want && !want.has(c.id)) continue;
    if (!c.predicate) continue;
    try {
      if (c.predicate(text)) return { id: c.id, intent: c.intent };
    } catch { /* a throwing predicate must never break routing */ }
  }
  return null;
}

/** Webhook PRE-BRAIN router: first webhookPre capability in webhook order.
 *  Returns its contract (callers switch on `id` to dispatch). */
export function matchWebhookPreCapability(text: string): CapabilityContract | null {
  if (!text) return null;
  const pre = CAPABILITY_CONTRACTS
    .filter((c) => c.webhookPre)
    .sort((a, b) => (a.webhookOrder ?? 0) - (b.webhookOrder ?? 0));
  for (const c of pre) {
    if (!c.predicate) continue;
    try {
      if (c.predicate(text)) return c;
    } catch { /* never break routing on a predicate error */ }
  }
  return null;
}

/** Strategy.approach for an intent (contract-backed), or null when the intent
 *  has no dedicated capability (caller falls back to simple_llm). */
export function approachForIntent(intent: string): string | null {
  for (const c of CAPABILITY_CONTRACTS) {
    if (c.intent === intent) return c.approach;
  }
  return null;
}

/** ONE source of truth for affirmative approval words (owner decision).
 *  Used by the proyek/etask parked-approval gate AND future parked intents so
 *  no capability invents its own approval vocabulary. Fail-closed: the WHOLE
 *  message must be a single approval word + optional punctuation — "ya deh",
 *  "ya tapi nanti", "ya proyek" (multi-token phrase is handled explicitly by
 *  the proyek parked contract) never auto-approve. */
export const STRICT_APPROVAL_RE =
  /^\s*(?:ya|iya|y|yes|yoi|sip|oke|ok|okay|siap|setuju|go|gas|gaskeun|lanjut|jalan|jalankan|eksekusi)\s*[.!?…]*\s*$/i;

// ============================================================================
// WEBHOOK-BOUND CAPABILITY CONTRACTS (command plane)
// ============================================================================
// Daftar kemampuan yang dieksekusi oleh webhook (bukan brain) — bersama
// kontrak brain di atas, ini SATU REGISTRI SEMUA kemampuan JARVIS:
// ide tambah kapabilitas = tambah satu entri di sini/atas, bukan regex liar
// di webhook. `parked` = intent tertunda yang menunggu balasan pemilik.

export interface ParkedContract {
  /** Kunci KV yang menandai intent tertunda (nilai truthy = sedang menunggu). */
  key: (owner: number) => string;
  /** "simple": pesan harus cocok salah satu resumeWords (tegas).
   *  "always": pesan teks apa pun (non-slash) resume sesi itu (mis. Q&A nego). */
  kind: "simple" | "always";
  /** Kata/simbol pemilik yang me-resume intent (kind "simple" hanya). */
  resumeWords?: RegExp[];
  /** Handler yang harus dipanggil webhook saat resume (polimorfisme handler). */
  handler: "relevance_resume" | "nego_resume" | "project_approval";
  /** Deskripsi kontrak (untuk dokumentasi-diri /kemampuan). */
  note: string;
}

export interface CommandCapabilitySpec {
  id: string;
  label: string;
  /** satu baris kontrak teks: APA yang dilakukan. */
  brief: string;
  /** VISI (kenapa ada) — bukan sekadar "bisa apa". */
  vision: string;
  /** Sandaran: SELURUH kemampuan fondasi (ALL_FOUNDATIONS) menyangga kemampuan ini. */
  foundations: FoundationId[];
  /** pemicu deterministik untuk bentuk slash (dipakai router & /kemampuan). */
  commandPattern: RegExp;
  /** varian bahasa alami (opsional). */
  naturalPattern?: RegExp;
  /** izin sensitif, teks (satu-satunya sumber dokumentasi izin). */
  permissionHint?: string;
  /** intent tertunda yang dimiliki kemampuan ini (urutan = prioritas resume). */
  parked?: ParkedContract[];
}

/** Registri kemampuan webhook, URUTAN = urutan dispatch webhook (perintah
 *  eksplisit lebih dulu daripada kemampuan berat). `parked` diurutkan
 *  per-kemampuan sesuai prioritas resume. */
export const CAPABILITY_COMMANDS: CommandCapabilitySpec[] = [
  {
    id: "sistem",
    label: "Sistem & Diagnostik",
    brief: "Cek kesehatan, status otonomi, bantuan, daftar kemampuan, antrean, audit.",
    vision: "Membaca status sebagai teks (f1) dan menyajikan kondisi JARVIS yang jujur kepada pemilik (f5) agar penggunaan semua kemampuan terkendali (f6).",
    foundations: ALL_FOUNDATIONS,
    commandPattern: /^\/(?:health|status|help|kemampuan|dms_status|queue_status|debug_bypass|dms|queue|obj|status_panen)\b/i,
  },
  {
    id: "todo",
    label: "Todo",
    brief: "Kelola daftar tugas ringan: tambah, hapus, tandai selesai, lihat.",
    vision: "Menjaga eksternalisasi memori pemilik (f5): memahami teks perintah (f1) dan menjalankannya dengan tepat (f6).",
    foundations: ALL_FOUNDATIONS,
    commandPattern: /^\/todo\b/i,
    naturalPattern: /^(?:tambah|tambahkan|buat|buatkan|catat|catatkan|simpan|add)\s+(?:todo|task|tugas)\b|^(?:hapus|hapuskan|delete|remove|del)\b|^todo\b|^(?:cek|check|lihat|daftar)\s+(?:todo|task|tugas)\b|^(?:done|selesai)\s+(?:todo|task|tugas)\b/i,
  },
  {
    id: "reminder",
    label: "Pengingat",
    brief: "Buat pengingat sekali jalan/jadwal (menit/jam/waktu absolut), lihat, hapus.",
    vision: "Menopang adaptasi sesi pemilik (f5): memahami kata waktu lintas ragam (f1/f2) lalu menepati janji pada pemilik.",
    foundations: ALL_FOUNDATIONS,
    commandPattern: /^\/reminder\b/i,
    naturalPattern: /^ingatkan\b/i,
  },
  {
    id: "etask",
    label: "Task Eksekutor (E2B)",
    brief: "Sama seperti /proyek: negosiasi + terjemahan → rencana diparkir → pemilik menyetujui. Tidak ada eksekusi tanpa persetujuan.",
    vision: "Menjalankan pekerjaan berat pemilik dengan output yang PASTI lebih baik (f7 cabang): memahami bidang tugas (f4), keputusan & persetujuan tetap di pemilik (f5/f6).",
    foundations: ALL_FOUNDATIONS,
    commandPattern: /^\/etask\b/i,
    permissionHint: "sandbox E2B HANYA setelah persetujuan pemilik ('ya proyek').",
    parked: [
      {
        key: (o) => projectPlanKey(o),
        kind: "simple",
        resumeWords: [/^ya proyek\b/i, STRICT_APPROVAL_RE],
        handler: "project_approval",
        note: "Persetujuan rencana → sandbox E2B dibuka (SATU-SATUNYA gerbang eksekusi).",
      },
    ],
  },
  {
    id: "pinjam",
    label: "Pinjam Eksekutor",
    brief: "Delegasi async ke eksekutor eksternal (riset, docs, figma, notion, cuaca) — dieksekusi platform itu, hasil dipoll & di-DM.",
    vision: "Meminjam platform lain menggantikan output yang tak cukup (f7): bidang bebas dipahami (f4), peminjaman semata demi pemilik (f5).",
    foundations: ALL_FOUNDATIONS,
    commandPattern: /^\/pinjam\b/i,
  },
  {
    id: "tugas",
    label: "Tugas Cloud (opencode)",
    brief: "Delegasi kerja berat ke eksekutor cloud (GitHub Actions + opencode), jadwal berulang, lanjut/tanya/hapus riwayat.",
    vision: "Mendelegasikan kerja berat ke eksekutor cloud (f7) dengan memahami bidang (f4); jadwal/riwayat milik pemilik (f5) dan dikelola tepat (f6).",
    foundations: ALL_FOUNDATIONS,
    commandPattern: /^\/(?:tugas|delegasi|delegate)\b/i,
    naturalPattern: /^delegasikan\b|^(?:kerjakan|jalankan)\b.*\bopencode\b/i,
    parked: [
      {
        key: (o) => `relevance_wait:${o}`,
        kind: "simple",
        resumeWords: [/^(?:1|2|ya|oke|ok|tidak|bukan)$/i],
        handler: "relevance_resume",
        note: "Gate relevansi meminta konfirmasi topik sebelum eskalasi.",
      },
      {
        key: (o) => `nego:${o}`,
        kind: "always",
        handler: "nego_resume",
        note: "Sesi negosiasi /tugas (jawab pertanyaan / konfirmasi GO-batal).",
      },
    ],
  },
  {
    id: "proyek",
    label: "Proyek (E2B)",
    brief: "Negosiator+penerjemah menyusun rencana eksekusi, DITAMPILKAN dulu, eksekusi menunggu persetujuan pemilik.",
    vision: "Contoh utuh fondasi 1-5 bekerja bersama: keinginan pemilik dipahami (f1/f2/f3), bidang tugas dimengerti (f4), disesuaikan sesi (f5), lalu DIJADIKAN rencana yang keputusannya di pemilik (f6).",
    foundations: ALL_FOUNDATIONS,
    commandPattern: /^\/proyek\b|^ya proyek\b/i,
    permissionHint: "sandbox E2B HANYA setelah persetujuan pemilik ('ya proyek').",
    parked: [
      {
        key: (o) => projectPlanKey(o),
        kind: "simple",
        resumeWords: [/^ya proyek\b/i, STRICT_APPROVAL_RE],
        handler: "project_approval",
        note: "AKSES CEPAT: \"ya\"/\"oke\"/\"setuju\"/\"siap\" juga = persetujuan pemilik saat rencana tertunda (bukan cuma 'ya proyek'). Tanpa rencana tertunda, 'ya' tetap obrolan biasa.",
      },
    ],
  },
  {
    id: "connector",
    label: "Connector (Figma/Notion)",
    brief: "Baca struktur file Figma / cari database Notion melalui Vercel Connector (secret di sana).",
    vision: "Membaca dokumen desain/data (f1/f2/f4) atas nama pemilik (f5) tanpa pernah mengubahnya — penglihatan, bukan aksi.",
    foundations: ALL_FOUNDATIONS,
    commandPattern: /^\/(?:figma|notion|connector)\b/i,
  },
  {
    id: "e2b",
    label: "E2B Mentah",
    brief: "Jalankan skrip shell/Python mentah di sandbox Firecracker (gate oleh keputusan pemilik).",
    vision: "Eksekusi mentah bidang bebas (f4) yang dibuka HANYA oleh keputusan pemilik (f5/f6) — eksekutor dipilih karena substitusi (f7).",
    foundations: ALL_FOUNDATIONS,
    commandPattern: /^\/e2b\b/i,
    permissionHint: "eksekusi sandbox.",
  },
  {
    id: "baca",
    label: "Baca Halaman",
    brief: "Baca + ringkas sebuah URL (HTML di-fetch, hasil digest Bahasa Indonesia).",
    vision: "Memahami teks halaman apa pun (f1/f2) dan menyampaikan sari sungguhan untuk pemilik (f5) — membaca, bukan bergosip.",
    foundations: ALL_FOUNDATIONS,
    commandPattern: /^\/(?:baca|ringkas)\b/i,
    naturalPattern: /^(?:baca|ringkas(?:kan)?|bacain|ringkaskan)\b.*https?:\/\//i,
  },
  {
    id: "suara",
    label: "TTS Suara",
    brief: "Ucapkan teks pendek sebagai voice note.",
    vision: "Menyuarakan teks (f1) dalam bahasa pemilik (f3), dengan nada yang disesuaikan sesi (f5).",
    foundations: ALL_FOUNDATIONS,
    commandPattern: /^\/(?:suara|sound|voice|ucapkan)\b/i,
    naturalPattern: /^(?:suarakan|ucapkan)\s+/i,
  },
  {
    id: "kota",
    label: "Kota & Cuaca",
    brief: "Simpan kota / tampilkan prakiraan cuaca.",
    vision: "Data bidang lingkungan (f4) untuk kebutuhan LOKAL dan rutin pemilik (f5).",
    foundations: ALL_FOUNDATIONS,
    commandPattern: /^\/(?:kota|setkota|city)\b/i,
  },
  {
    id: "shop",
    label: "E-commerce",
    brief: "Produk, stok, pesanan, pelanggan, invoice, laporan penjualan.",
    vision: "Mengolah data dagang pemilik (f4) dari teks perintah (f1) — semua demi kelancaran usahanya (f5).",
    foundations: ALL_FOUNDATIONS,
    commandPattern: /^\/(?:shop|produk|stok|pesanan|pelanggan|invoice|laporan)\b/i,
    naturalPattern: /^(?:tambah|tambahkan|buat|buatkan|catat|simpan|add)\s+(?:produk|product|barang)\b|^(?:buat|catat|tambah)\s+(?:pesanan|order|penjualan)\b|^(?:cek|lihat|tampil)\s+(?:stok|stock)\b|^laporan\s+(?:penjualan|jual)\b|^(?:list|daftar)\s+(?:produk|product|barang|pesanan|order|pelanggan|customer)\b/i,
  },
];

/** Resolve kemampuan webhook untuk teks (slash ATAU bahasa alami), dalam
 *  urutan kontrak. Fail-closed: tidak cocok → null → pipeline normal
 *  (intelligence/brain); jangan pernah salah-eksekusi. */
export function resolveCommandCapability(text: string, raw = ""): CommandCapabilitySpec | null {
  const t = (text ?? "").trim();
  if (!t) return null;
  for (const c of CAPABILITY_COMMANDS) {
    try {
      if (c.commandPattern.test(t)) return c;
      if (c.naturalPattern) {
        const r = raw && raw !== t ? raw : t;
        if (c.naturalPattern.test(r)) return c;
      }
    } catch { /* predicate tidak boleh merusak routing */ }
  }
  return null;
}

/** Apakah pesan cocok kata-resume sebuah kontrak parked (tanpa cek KV).
 *  Dipakai webhook untuk mengumpulkan kandidat; kehadiran KV diverifikasi
 *  terpisah (resolveParkedResume). */
export function resolveParkedResumeWords(
  spec: CommandCapabilitySpec,
  text: string,
): ParkedContract | null {
  const t = (text ?? "").trim();
  for (const p of spec.parked ?? []) {
    if (p.kind === "always") {
      if (!/^\//.test(t)) return p;
      continue;
    }
    if ((p.resumeWords ?? []).some((r) => r.test(t))) return p;
  }
  return null;
}

/** Markdown summary CAPABILITY BRAIN (inti), for introspection (legacy name
 *  kept — old tests + /help UX contract). */
export function describeCapabilities(): string {
  const rows = [...CAPABILITY_CONTRACTS]
    .sort((a, b) => a.priority - b.priority)
    .filter((c) => c.predicate || c.id === "design" || c.id === "search" || c.id === "followup")
    .map(
      (c) =>
        `• *${c.label}* — ${c.brief}` +
        (c.predicate ? `\n  Trigger: *${capabilityTriggerHint(c)}*` : "") +
        `\n  Fallback: ${c.fallbackId} | Error: ${c.errorCodes.join(", ") || "—"}`,
    );
  return `🧩 *Capabilities J.A.R.V.I.S. (${rows.length})*\n\n` + rows.join("\n\n");
}

/** Markdown summary SEMUA kemampuan (brain + command), dibaca dari kontrak
 *  TEKS — introspeksi diri yang dibangkitkan dari registri (bukan diketik
 *  tangan). m9-v11.51: SEMUA kemampuan fondasi menjadi SANDARAN SEMUA
 *  kemampuan — tidak ada kemampuan yang bertumpu hanya pada satu fondasi. */
export function describeAllCapabilities(): string {
  const fondasi = (Object.keys(FOUNDATION_LABELS) as FoundationId[])
    .map((f) => `• *${f}* — ${FOUNDATION_LABELS[f]}`)
    .join("\n");
  const anchored = (fnds: FoundationId[]) =>
    fnds.length === ALL_FOUNDATIONS.length && ALL_FOUNDATIONS.every((f) => fnds.includes(f))
      ? "SEMUA kemampuan fondasi (f1·f2·f3·f4·f5·f6·f7)"
      : fnds.join(" · ");
  const brain = CAPABILITY_CONTRACTS.map((c) => `• *${c.label}* — ${c.brief}\n  🏛 sandaran: ${anchored(c.foundations)}\n  ✨ visi: ${c.vision}`);
  const cmds = CAPABILITY_COMMANDS.map(
    (c) =>
      `• *${c.label}* — ${c.brief}\n  🏛 sandaran: ${anchored(c.foundations)}\n  ✨ visi: ${c.vision}` +
      (c.parked?.length ? `\n  ⏳ menunggu: ${c.parked.map((p) => p.note).join(" · ")}` : "") +
      (c.permissionHint ? `\n  🔐 izin: *${c.permissionHint}*` : ""),
  );
  return (
    `🧩 *Kemampuan fondasi J.A.R.V.I.S.* — setiap entri adalah kontrak teks di registri; kemampuan baru = satu entri baru + visi & sandaran penuh, router & pengetahuan-diri ikut otomatis.\n\n` +
    `*Fondasi — SANDARAN SEMUA KEMAMPUAN* (tidak ada kemampuan yang bertumpu hanya pada satu fondasi; SELURUH fondasi ini menyangga SETIAP kemampuan, f6 sebagai payung di atasnya):\n${fondasi}\n\n` +
    `*Otak (inti):*\n${brain.join("\n")}\n\n` +
    `*Perintah (webhook):*\n${cmds.join("\n")}`
  );
}

/** Blok singkat untuk system prompt LLM — dibangkitkan dari registri teks,
 *  agar model mengenali kemampuan nyata JARVIS (bukan mengarang). m9-v11.51:
 *  SELURUH kemampuan fondasi menyangga SEMUA kemampuan (tak ada tuple
 *  per-kemampuan — kapabilitas bukan milik satu fondasi). */
export function capabilityContextBlock(): string {
  const brain = CAPABILITY_CONTRACTS.map((c) => `${c.id}: ${c.brief}`);
  const cmds = CAPABILITY_COMMANDS.map((c) => `${c.id}: ${c.brief}`);
  return (
    `KEMAMPUAN DIRI (registri fondasi — jangan mengarang di luar ini):\n` +
    `Fondasi sandaran SEMUA kemampuan: ${(Object.keys(FOUNDATION_LABELS) as FoundationId[]).map((f) => `${f}=${FOUNDATION_LABELS[f]}`).join(" | ")}\n` +
    `Setiap kemampuan TERSANDAR pada SEMUA kemampuan fondasi di atas (f1..f7), bukan satu fondasi. Inti: ${brain.join(" | ")}\n` +
    `Perintah: ${cmds.join(" | ")}\n` +
    `Gunakan kemampuan yang paling tepat untuk pesan pemilik. Eksekusi sandbox/eksekutor HANYA setelah pemilik menyetujui.`
  );
}

/** Human hint of the trigger pattern for a predicated capability. */
function capabilityTriggerHint(c: CapabilityContract): string {
  switch (c.id) {
    case "translate": return "terjemahkan/translate <teks> atau <ke bahasa> <teks>";
    case "prompt_master": return "kata 'prompt' / 'prompting' di permintaan";
    case "context7": return "'cara pakai <library>', 'docs untuk <library>', 'ctx7: /org/repo'";
    case "self_referential": return "siapa kamu / apa yang bisa kamu lakukan";
    default: return "tidak dipublikasikan";
  }
}
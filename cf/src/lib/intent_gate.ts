// INTENT GATE — gerbang 2-arah GLOBAL untuk seluruh command plane (m9-v11.53)
//
// BUG LIVE YANG DIREPRODUKSI (owner):
//   Sesi negosiasi /tugas parked di KV, lalu owner mengirim
//   "/tugas hapus semua tugas pending".
//   resolveParkedResume() berjalan SEBELUM rantai command dan mencocokkan
//   "hapus" ke resumeWords kontrak `tugas` -> pesan DIMAKAN sebagai "jawaban
//   pertanyaan 1/3". Perintah destruktif tak pernah sampai handler, dan
//   JARVIS bertanya "Format output yang diinginkan?" untuk perintah yang
//   sudah jelas. Intent owner di-rewrite oleh gerbang lain.
//
// 4 ATURAN (berlaku untuk SEMUA kapabilitas, bukan per-pola):
//   1. VERIFIED   - cocok aturan deterministik. WAJIB menang atas parked-
//                  resume. Nol LLM, nol klarifikasi.
//   2. UNVERIFIED - dicoba diperbaiki (repair) dulu secara deterministik
//                  (head-verb + stopword-strip + noun kapabilitas).
//   3. LLM 2-ARAH - hanya boleh memilih intent DARI TABEL TERTUTUP. Di luar
//                  tabel / skor < ambang / LLM mati = TIDAK TERVERIFIKASI.
//                  Anti-halusinasi: tak ada aksi dieksekusi dari intent yang
//                  tak lolos verifikasi.
//   4. PARKED     - hanya untuk input yang tak terverifikasi sbg perintah.
//                  Slash ATAU verba destruktif tidak boleh dimakan jawaban.
//
// OPTIMASI KECEPATAN (urutan layer — inilah yang membuatnya cepat):
//   L0 shape      regex lokal, 0 token, <1ms (dialog biasa keluar di sini,
//                 jadi jalur chat tetap nol-LLM).
//   L1 verified   match aturan -> LANGSUNG, 0 panggilan LLM.
//   L2 repair     head-verb/stopword lokal -> LANGSUNG, 0 panggilan LLM.
//   L3 llm verify HANYA sisa yang gitu: timeout pendek, maxTokens kecil,
//                 hasil di-memoize ke KV (pesan identik tak bayar 2x).
//   L4 clarify    output aman, deterministik, zero-LLM.

import type { Env } from "./db";

/** Konfigurasi ambang + jalur LLM. */
export interface VerifyConfig {
  /** Skor minimum agar intent LLM dianggap terverifikasi (0..1). */
  minConfidence?: number;
  /** Pustaka LLM 2-arah. Kalau null/undefined -> L3 dilewati (offline). */
  llm?: (env: Env, prompt: string) => Promise<string | null>;
}

export const VERIFY_MIN_CONFIDENCE = 0.72;

/** Hasil resolusi intent. */
export interface ResolvedIntent {
  /** Slug kapabilitas (pasti ada di INTENT_RULES bila verified). */
  intent: string | null;
  /** true HANYA bila intent benar-benar terverifikasi. */
  verified: boolean;
  /** Asal keputusan — untuk log/audit dan pemangkasan biaya. */
  source:
    | "not_command"
    | "verified_rule"
    | "verified_repair"
    | "verified_llm"
    | "unverified"
    | "llm_unavailable";
  args: string[];
  confidence: number;
  /** true kalau intent destruktif -> wajib konfirmasi, tak pernah diam-diam. */
  destructive: boolean;
  /** Pesan klarifikasi siap kirim (hanya sumber tak terverifikasi). */
  clarify?: string;
  /** Perintah kanonik hasil repair, mis. "/tugas hapus semua pending". */
  canonical?: string;
}

/** Satu entri tabel intent. Tambah kapabilitas baru DI SINI satu kali —
 *  seluruh command plane ikut tahu tanpa sentuh per-handler. */
export interface IntentRule {
  intent: string;
  /** Alias slash (tanpa leading "/"). */
  slash: string[];
  /** Head-verb imperatif (dasar + slang). */
  verbs: string[];
  /** Kata benda kapabilitas — kunci anti-ambigu. "hapus tugas" -> tugas,
   *  "hapus catatan" -> todo. Tanpa noun, intent destruktif TAK BOLEH
   *  ditebak (lihat repairIntent). */
  nouns: string[];
  destructive?: boolean;
}

// === TABEL INTENT TERTUTUP (ground truth JARVIS) ============================

export const INTENT_RULES: IntentRule[] = [
  {
    intent: "tugas",
    slash: ["tugas", "delegasi", "delegate"],
    verbs: ["tugas", "delegasikan", "kerjakan", "jalankan"],
    nouns: ["tugas", "pekerjaan", "delegasi", "serverless", "antrean", "antrian", "queue"],
    destructive: true,
  },
  {
    intent: "todo",
    slash: ["todo", "todos", "todolist"],
    verbs: ["todo", "centang", "selesai"],
    nouns: ["todo", "todos", "catatan", "daftar", "checklist"],
    destructive: true,
  },
  {
    intent: "reminder",
    slash: ["reminder", "remind", "ingat"],
    verbs: ["ingatkan", "reminder", "ingetin"],
    nouns: ["reminder", "pengingat", "ingat"],
  },
  {
    intent: "etask",
    slash: ["etask", "exec"],
    verbs: ["run"],
    nouns: ["script", "shell", "sandbox"],
  },
  {
    intent: "pinjam",
    slash: ["pinjam", "platform"],
    verbs: ["pinjam", "platform"],
    nouns: ["platform", "pinjam"],
  },
  {
    intent: "proyek",
    slash: ["proyek", "project", "plan"],
    verbs: ["proyek", "rencanakan"],
    nouns: ["proyek", "rencana", "project", "plan"],
  },
  {
    intent: "connector",
    slash: ["connector", "figma", "notion"],
    verbs: ["connector", "figma", "notion"],
    nouns: ["connector", "figma", "notion"],
  },
  {
    intent: "e2b",
    slash: ["e2b", "sandbox"],
    verbs: ["sandbox", "e2b"],
    nouns: ["sandbox", "e2b"],
  },
  {
    intent: "baca",
    slash: ["baca", "read", "ringkas"],
    verbs: ["baca", "ringkas", "summarize"],
    nouns: ["halaman", "artikel", "link", "berita"],
  },
  {
    intent: "suara",
    slash: ["suara", "sound", "tts", "bicara"],
    verbs: ["bicara", "suara", "tts"],
    nouns: ["suara", "bicara"],
  },
  {
    intent: "kota",
    slash: ["kota", "cuaca", "weather", "setkota"],
    verbs: ["cuaca", "setkota"],
    nouns: ["cuaca", "kota"],
  },
  {
    intent: "shop",
    slash: ["shop", "beli", "toko"],
    verbs: ["beli", "order"],
    nouns: ["produk", "barang", "toko"],
  },
  { intent: "mcp", slash: ["mcp"], verbs: ["mcp"], nouns: ["mcp", "server"] },
  {
    intent: "status",
    slash: ["status", "health", "dmsstatus", "queuestatus"],
    verbs: ["status", "kesehatan"],
    nouns: ["status", "kesehatan", "antrean"],
  },
  {
    intent: "help",
    slash: ["help", "bantuan", "kemampuan"],
    verbs: ["bantuan", "kemampuan"],
    nouns: ["bantuan", "kemampuan", "perintah"],
  },
  { intent: "pause", slash: ["pause", "jeda", "pause_autonomy"], verbs: ["pause", "jeda"], nouns: ["otonomi", "cron", "jadwal"] },
  { intent: "resume", slash: ["resume", "resume_autonomy"], verbs: ["resume"], nouns: ["otonomi", "cron", "jadwal"] },
];

// === VERBA DESTRUKTIF (butuh kapabilitas eksplisit, tak boleh ditebak) =====

/** Kata kerja yang mengubah state secara destruktif. Sengaja TIDAK dipetakan
 *  ke satu kapabilitas: "hapus ..." tanpa objek = ambigu -> klarifikasi. */
export const DESTRUCTIVE_VERBS =
  /\b(?:hapus|hapusin|hapush|bersihkan|buang|delete|remove|wipe|reset|batalkan)\b/i;

const ALL_SCOPE = /\b(?:semua|seluruh|all)\b/i;
const PENDING_SCOPE = /\b(?:pending|antrean|antrian|queue)\b/i;

const STOPWORDS = new Set([
  "yang", "di", "ke", "dari", "untuk", "pada", "dengan", "dan", "atau", "itu",
  "ini", "semua", "seluruh", "saya", "aku", "kamu", "kita", "anda", "please",
  "tolong", "dong", "silakan", "kah", "sih", "deh", "ya", "aja", "juga", "lagi",
  "sudah", "belum", "harus", "boleh", "sekarang", "segera", "oke", "ok",
  "the", "a", "an", "is", "to", "of", "and", "or", "please", "all", "pending",
]);

// === Utilitas ==============================================================

function norm(s: string): string {
  return (s ?? "").toLowerCase().replace(/\s+/g, " ").trim();
}

/** Bentuk dasar sederhana untuk slang Indonesia ber-imperatifan -in. */
function stem(w: string): string {
  return w.replace(/(?:in|hin|an|kan)$/i, "");
}

// === L0 — SHAPE GATE (0 token, <1ms) =======================================

/** True bila input BERBENTUK perintah. Dialog biasa keluar di sini, sehingga
 *  jalur chat tetap nol-LLM dan nol-latensi. */
export function looksLikeCommand(text: string): boolean {
  const t = norm(text);
  if (!t) return false;
  if (/^\/[a-z]/.test(t)) return true;
  if (DESTRUCTIVE_VERBS.test(t)) return true;
  if (/^(?:tolong|please|tolongkan|silakan)\b/.test(t)) return true;
  const head = t.split(" ")[0];
  if (STOPWORDS.has(head)) return false;
  return INTENT_RULES.some((r) => r.verbs.some((v) => head === v || stem(head) === stem(v)));
}

/** Gate parked-resume. Input yang SUDAH terverifikasi sebagai perintah (slash
 *  ATAU verba destruktif) TIDAK BOLEH dimakan sebagai "jawaban negosiasi".
 *
 *  Sengaja TIDAK menyertakan "lanjut"/"ya"/"oke": itu kata resume yang sah
 *  untuk intent parked, jadi harus sampai ke parked-resume lebih dulu. */
export function isHardCommand(text: string): boolean {
  const t = norm(text);
  if (!t) return false;
  if (/^\/[a-z]/.test(t)) return true;
  return DESTRUCTIVE_VERBS.test(t);
}

// === L1 — VERIFIED RULE (deterministik, 0 LLM) =============================

export interface RuleMatch {
  rule: IntentRule;
  args: string[];
  destructive: boolean;
}

/** L1: cocokkan intent dari aturan deterministik. Null bila tak cocok. */
export function matchRule(text: string): RuleMatch | null {
  const t = norm(text);
  if (!t) return null;

  // Slash: /tugas, /delegasi, /tugas hapus semua pending, ...
  const slash = /^\/([a-z0-9_-]+)\s*(.*)$/.exec(t);
  if (slash) {
    const cmd = slash[1];
    const rest = (slash[2] || "").trim();
    const rule = INTENT_RULES.find((r) => r.slash.includes(cmd));
    if (!rule) return null;
    return {
      rule,
      args: rest ? rest.split(" ").filter(Boolean).slice(0, 12) : [],
      destructive: !!rule.destructive && DESTRUCTIVE_VERBS.test(rest),
    };
  }

  // Imperatif natural dengan head-verb persis ("baca artikel ini", "status").
  const parts = t.split(" ");
  const head = parts[0];
  for (const r of INTENT_RULES) {
    for (const v of r.verbs) {
      if (head === v || stem(head) === stem(v)) {
        return { rule: r, args: parts.slice(1), destructive: false };
      }
    }
  }
  return null;
}

// === L2 — REPAIR DETERMINISTIK (0 LLM) =====================================

/** L2: perbaiki input yang TIDAK terverifikasi, tanpa LLM.
 *
 *  (a) Verba destruktif + NOUN kapabilitas -> intent terverifikasi.
 *      "hapus semua tugas pending" -> tugas (destructive, cakupan pending).
 *      "hapus catatan"             -> todo.
 *  (b) Verba destruktif tanpa noun -> AMBIGU: tak boleh ditebak -> null
 *      (keluar sebagai unverified -> klarifikasi dengan pilihan nyata).
 *  (c) Head-verb + stopword-strip ("tolong hapusin tugas") -> match aturan. */
export function repairIntent(text: string): ResolvedIntent | null {
  const t = norm(text);
  if (!t) return null;
  const parts = t.split(" ").filter(Boolean);
  if (!parts.length) return null;

  const destructive = DESTRUCTIVE_VERBS.test(t);

  // (a)/(b) — kapabilitas eksplisit lewat NOUN.
  if (destructive) {
    for (const r of INTENT_RULES) {
      const hit = r.nouns.some((n) => new RegExp(`\\b${n}\\b`, "i").test(t));
      if (!hit) continue;
      const scope: string[] = [];
      if (ALL_SCOPE.test(t)) scope.push("semua");
      if (PENDING_SCOPE.test(t)) scope.push("pending");
      // WAJIB pertahankan verba destruktif: "/todo" saja akan menambah todo
      // baru, bukan menghapus (bug: "hapus catatan" -> "/todo" = tambah).
      const verb = "hapus";
      const slug = r.slash[0];
      return {
        intent: r.intent,
        verified: true,
        source: "verified_repair",
        args: scope,
        confidence: 0.9,
        destructive: true,
        canonical: `/${slug} ${verb}${scope.length ? ` ${scope.join(" ")}` : ""}`,
      };
    }
    // (b) destruktif tanpa noun -> ambigu, tak boleh ditebak.
    return null;
  }

  // (c) head-verb setelah buang stopword di depan.
  let i = 0;
  while (i < parts.length && STOPWORDS.has(parts[i])) i++;
  const head = parts[i];
  if (!head) return null;
  for (const r of INTENT_RULES) {
    for (const v of r.verbs) {
      if (head === v || stem(head) === stem(v)) {
        return {
          intent: r.intent,
          verified: true,
          source: "verified_repair",
          args: parts.slice(i + 1),
          confidence: 0.85,
          destructive: false,
          canonical: `/${r.slash[0]}`,
        };
      }
    }
  }
  return null;
}

// === L3 — LLM VERIFY 2-ARAH (tabel tertutup) ==============================

/** Instruksi verifikasi: paksa LLM memilih DARI TABEL atau menjawab unknown. */
export function buildVerifyPrompt(text: string): string {
  const table = INTENT_RULES.map((r) => r.intent).join(", ");
  return [
    `Klasifikasikan INTENSI perintah berikut. Pilihan HANYA dari daftar ini:`,
    `[${table}]`,
    ``,
    `Perintah: "${(text || "").slice(0, 200)}"`,
    ``,
    `Balas HANYA JSON: {"intent":"<slug dari daftar atau unknown>",` +
    `"confidence":<float 0..1>,"destructive":<true|false>,"args":[<argumen>]}`,
    `Jika ragu -> intent="unknown" dan confidence rendah. JANGAN menebak di luar daftar.`,
  ].join("\n");
}

/** Parse balasan LLM. Di luar tabel / skor < ambang / JSON rusak = UNVERIFIED
 *  (fail-closed, bukan ".Intent terdekat"). */
export function parseVerify(raw: string | null, text: string): ResolvedIntent {
  const base: ResolvedIntent = {
    intent: null, verified: false, source: "unverified", args: [],
    confidence: 0, destructive: false,
  };
  if (!raw) return { ...base, clarify: clarifyFor(text, null) };

  let obj: unknown = null;
  try {
    const m = /\{[\s\S]*\}/.exec(raw);
    obj = m ? JSON.parse(m[0]) : null;
  } catch { return { ...base, clarify: clarifyFor(text, null) }; }
  if (!obj || typeof obj !== "object") return { ...base, clarify: clarifyFor(text, null) };

  const o = obj as Record<string, unknown>;
  const intent = typeof o.intent === "string" ? o.intent.trim().toLowerCase() : "";
  const conf = typeof o.confidence === "number" ? Math.max(0, Math.min(1, o.confidence)) : 0;
  const args = Array.isArray(o.args)
    ? o.args.filter((a): a is string => typeof a === "string").slice(0, 12)
    : [];

  const rule = INTENT_RULES.find((r) => r.intent === intent);
  if (!rule || conf < VERIFY_MIN_CONFIDENCE) {
    return { ...base, confidence: conf, clarify: clarifyFor(text, rule?.intent ?? null) };
  }

  const destructive = !!rule.destructive && DESTRUCTIVE_VERBS.test(text);
  return {
    intent: rule.intent,
    verified: true,
    source: "verified_llm",
    args,
    confidence: conf,
    destructive,
    canonical: `/${rule.slash[0]}${args.length ? ` ${args.join(" ")}` : ""}`,
  };
}

/** Pertanyaan klarifikasi singkat. Tanpa klaim kapabilitas tak terverifikasi. */
function clarifyFor(text: string, maybe: string | null): string {
  const t = norm(text).slice(0, 60);
  if (maybe) {
    return `Maksudmu perintah *${maybe}*? Perintaannya belum jelas — tulis ulang lebih spesifik, ` +
      `mis. \`/${maybe} <argumen>\`.`;
  }
  return `Perintah "${t}" belum kumertegas. Bisa ulangi dengan format yang lebih jelas? ` +
    `Contoh: /tugas <pekerjaan>, /tugas hapus semua pending, /status.`;
}

/** Pesan klarifikasi untuk intent destruktif yang ambigu — menyebut opsi
 *  nyata, tak pernah menebak lalu mengeksekusi. */
export function destructiveClarify(): string {
  return `Hapus yang mana? Sebutkan objeknya supaya tak salah hapus:\n` +
    `• \`/tugas hapus semua pending\` — semua tugas yang masih mengantre\n` +
    `• \`/tugas hapus <id>\` — satu tugas tertentu\n` +
    `• \`/todo hapus <id>\` — satu catatan todo`;
}

// === Memoize (KV) — jangan bayar LLM 2x untuk pesan identik ================

/** FNV-1a 32-bit: ringan, cukup untuk cache key. */
function memoKey(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return `intent_v:${(h >>> 0).toString(16)}`;
}

async function memoGet(env: Env, text: string): Promise<ResolvedIntent | null> {
  try {
    return ((await env.CONFIG_KV.get(memoKey(text), "json")) as ResolvedIntent) ?? null;
  } catch { return null; }
}

async function memoPut(env: Env, text: string, r: ResolvedIntent): Promise<void> {
  try {
    await env.CONFIG_KV.put(memoKey(text), JSON.stringify(r), { expirationTtl: 300 });
  } catch { /* cache miss tak boleh merusak alur */ }
}

// === Entry point global ===================================================

/** RESOLVE INTENT GLOBAL — dipakai seluruh command plane.
 *
 *  L0 shape -> bukan perintah? keluar (0 token).
 *  L1 rule  -> LANGSUNG (0 LLM).
 *  L2 repair-> LANGSUNG (0 LLM).
 *  L3 llm   -> HANYA sisa, memoized, fail-closed.
 *  L4 clarify-> tak terverifikasi: klarifikasi, anti-halusinasi. */
export async function resolveIntent(
  env: Env,
  text: string,
  cfg: VerifyConfig = {},
): Promise<ResolvedIntent> {
  const t = norm(text);
  if (!t) {
    return { intent: null, verified: false, source: "not_command", args: [], confidence: 0, destructive: false };
  }

  // L0 — dialog biasa: jalur chat tak boleh Paying LLM.
  if (!looksLikeCommand(t)) {
    return { intent: null, verified: false, source: "not_command", args: [], confidence: 0, destructive: false };
  }

  // Cache dulu (hemat LLM untuk pesan berulang).
  const memo = await memoGet(env, t);
  if (memo) return memo;

  // L1 — aturan deterministik.
  const rule = matchRule(t);
  if (rule) {
    const r: ResolvedIntent = {
      intent: rule.rule.intent, verified: true, source: "verified_rule",
      args: rule.args, confidence: 1, destructive: rule.destructive,
    };
    void memoPut(env, t, r);
    return r;
  }

  // L2 — repair deterministik (0 LLM), termasuk live bug "/tugas hapus
  // semua tugas pending" saat negosiasi parked.
  const repaired = repairIntent(t);
  if (repaired) {
    void memoPut(env, t, repaired);
    return repaired;
  }

  // Ambigu destruktif: jangan pernah LLM, jangan pernah tebak — klarifikasi
  // dengan opsi nyata. (Anti-halusinasi, dan juga paling murah.)
  if (DESTRUCTIVE_VERBS.test(t)) {
    const r: ResolvedIntent = {
      intent: null, verified: false, source: "unverified", args: [],
      confidence: 0, destructive: true, clarify: destructiveClarify(),
    };
    void memoPut(env, t, r);
    return r;
  }

  // L3 — LLM verify, hanya untuk sisa yang tak terverifikasi.
  if (!cfg.llm) {
    return { intent: null, verified: false, source: "unverified", args: [], confidence: 0, destructive: false, clarify: clarifyFor(t, null) };
  }

  let raw: string | null = null;
  try {
    raw = await cfg.llm(env, buildVerifyPrompt(t));
  } catch { raw = null; }

  if (raw === null) {
    const r: ResolvedIntent = {
      intent: null, verified: false, source: "llm_unavailable", args: [],
      confidence: 0, destructive: false, clarify: clarifyFor(t, null),
    };
    void memoPut(env, t, r);
    return r;
  }

  const parsed = parseVerify(raw, t);
  void memoPut(env, t, parsed);
  return parsed;
}

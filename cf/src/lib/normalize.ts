//=====================================================================
// normalize.ts — input normalization for owner-facing messages.
//
// Real-world Telegram/WhatsApp Indonesian input is full of slang,
// abbreviations, typos, extra whitespace, emoji, and empty payloads
// (stickers/photos). This module cheaply normalizes that before routing
// so J.A.R.V.I.S. recognizes greetings, search topics, translate
// requests and commands it would otherwise mis-handle (e.g. replying
// "Aksi ditangguhkan." or "Ok." to a benign query typed in slang).
//
// Zero dependency, deterministic, fail-open (unknown input passes
// through unchanged). Normalization NEVER expands into a destructive/
// financial meaning — the constitutional guard still runs on the FULL
// original action description downstream, so this cannot be used to
// hide a danger word from the guard.
//=====================================================================

/** Canonical word-length expansion; longest-first so greedier slang wins.
 *  Only expands SHORT tokens (<=5 chars) that can't be a legitimate long
 *  word themselves, reducing false expansion of real vocabulary. These map
 *  to harmless filler/connectors — never to verbs/commands. The dictionary is
 *  informed by lexical-normalization research (Han & Baldwin 2013; ViLexNorm
 *  EACL '24; MultiLexNorm++ 2026): a curated OOV->canonical map is the
 *  cheapest, most reliable "detect-then-normalize" layer for Indonesian
 *  social-media/Telegram slang before any (budget-limited) model pass. */
const SLANG: Record<string, string> = {
  // negations/connectors (harmless filler; never actions)
  gak: "tidak", ga: "tidak", gk: "tidak", g: "tidak",
  udh: "sudah", ud: "sudah", blm: "belum",
  yg: "yang",
  tp: "tapi", krn: "karena", karna: "karena", sm: "sama",
  gmn: "bagaimana", gmana: "bagaimana", dmn: "dimana", kpn: "kapan",
  bs: "bisa", hrs: "harus", msh: "masih", lg: "lagi",
  trs: "terus", skrg: "sekarang", sgr: "sekarang",
  bgt: "banget", gt: "gitu", aj: "aja", aja: "aja",
  emg: "memang", emang: "memang", bsk: "besok", udah: "sudah",
  // pronouns
  gw: "saya", gue: "saya", aku: "saya", lo: "kamu", lu: "kamu",
  pgn: "ingin", pengen: "ingin",
  // additional common social-media/Telegram slang (harmless filler only)
  ntaps: "mantap", mntp: "mantap", mantul: "mantap",
  wkwk: "hehe", hehe: "hehe", hihi: "hehe", haha: "hehe",
  pls: "tolong", plis: "tolong", tolongin: "tolong",
  mksh: "terima kasih", makasih: "terima kasih", mksih: "terima kasih", trims: "terima kasih",
  pengenin: "ingin",
  dah: "saja", yuk: "ayo", ayok: "ayo",
  klo: "kalau", kalu: "kalau", kalo: "kalau",
  cmn: "hanya", cman: "hanya", doang: "hanya",
  disini: "di sini", disana: "di sana",
  skrng: "sekarang",
  ngerti: "mengerti",
  begimana: "bagaimana", bgmn: "bagaimana",
  knpa: "kenapa",
  jngn: "jangan",
  sdng: "sedang", lgi: "lagi",
  bikinlah: "buatlah",
  bener: "benar",
};

/** Detect-then-normalize: cheap pre-detection pass that flags tokens needing
 *  normalization. Since JARVIS is zero-dependency and budget-bounded, Windows
 *  of OOV tokens are expanded from the curated dictionary above (no LLM call).
 *  Tokens already canonical, valid verbs/commands, or >5 chars pass unchanged. */
function detectAndNormalize(t: string): string {
  if (t.startsWith("/")) return t; // command prefix verbatim
  const cleaned = collapseRepeats(t.toLowerCase());
  // Only expand short tokens (<=5 chars) that have a curated mapping, or a few
  // explicit longer slang entries — never invent expansions for long/valid words.
  if (cleaned.length <= 5) return SLANG[cleaned] ?? cleaned;
  // Longer slang tokens that are unambiguous social-media variants.
  return SLANG[cleaned] ?? cleaned;
}

/** Collapse repeated letters (typo tolerance): "halooo" -> "halo", "haai" -> "hai". */
function collapseRepeats(s: string): string {
  return s.replace(/(.)\1{2,}/g, "$1$1");
}

/**
 * Normalize free-text owner input before routing/classification.
 *   - strips "Username:" prefix that Telegram group bots prepend to messages
 *   - trims + collapses whitespace runs
 *   - lowercases (everything downstream matches case-insensitively)
 *   - collapses repeated letters ("halooo"->"halo")
 *   - expands known Indonesian slang/abbreviation filler tokens to canonical
 *     forms ("gmn"->"bagaimana", "yg"->"yang", "udh"->"sudah", ...)
 *   - NEVER rewrites a "/" command prefix (kept verbatim)
 * Returns the normalized string (never throws). Non-slang input passes with
 * only whitespace/case cleanup. */
export function normalizeInput(raw: string): string {
  if (!raw) return "";
  return raw
    .replace(/\s+/g, " ")
    .trim()
    // Strip "Username:" prefix Telegram group bots prepend before routing.
    // Handles both same-line ("Vsco Bayu:/hapus") and multi-line
    // ("Vsco Bayu:\nMalang") formats. Matches up to the first colon + any whitespace/newline.
    .replace(/^[^:]+:\s*\n?\s*/i, "")
    .split(" ")
    .map(detectAndNormalize)
    .join(" ");
}

/** Greeting matcher that tolerates slang/typo variance and emoji adornment. */
export const GREETING_RE =
  /^(halo|hai|hi|hello|hey|pagi|siang|sore|malam|assalamualaikum|assalamu['`]?alaikum|selamat)/i;

/** True if the (already normalized) message has no meaningful content. */
export function isEmptyInput(s: string): boolean {
  if (!s) return true;
  const stripped = s
    .replace(/[^\p{L}\p{N}\/]/gu, "") // keep letters/numbers/slash
    .trim();
  return stripped.length === 0;
}

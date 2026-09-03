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
 *  to harmless filler/connectors — never to verbs/commands. */
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
};

/** Collapse repeated letters (typo tolerance): "halooo" -> "halo", "haai" -> "hai". */
function collapseRepeats(s: string): string {
  return s.replace(/(.)\1{2,}/g, "$1$1");
}

/**
 * Normalize free-text owner input before routing/classification.
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
    .split(" ")
    .map((t) => {
      if (t.startsWith("/")) return t; // command prefix verbatim
      const cleaned = collapseRepeats(t.toLowerCase());
      return cleaned.length <= 5 ? (SLANG[cleaned] ?? cleaned) : cleaned;
    })
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

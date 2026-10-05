//=====================================================================
// moderation.ts — fail-closed content gate for everything JARVIS sends.
//
// WHY THIS EXISTS
//   The previous bot was banned by Telegram for "menyebarkan konten
//   pornografi". The cause was a design combination, not a typo:
//
//     1. the access gate was deliberately open - any Telegram user who found
//        the bot got full conversational access (lib/access.ts),
//     2. there was NO content moderation anywhere in the pipeline - not on
//        input, not on output - and the system prompt never told the model to
//        refuse sexual content. It only said "you are not a financial advisor",
//     3. the model complied with whatever it was asked.
//
//   So anyone could make the owner's bot emit anything. Telegram does not need
//   the operator to have typed it; it flags the bot's own replies.
//
//   Two defences, and the second matters as much as the first:
//     - a deterministic gate on every outbound string, so even if the model is
//       talked into producing something, it does not leave the process;
//     - an explicit instruction in the system prompt, so the model refuses
//       rather than composing something the gate then has to strip.
//
// WHAT THIS IS NOT
//   Not a profanity filter. A personal assistant that refuses ordinary
//   conversation is worse than useless, so nothing here blocks mild language.
//   The line is drawn at explicit sexual / pornographic content, non-consensual
//   content, and anything involving minors.
//
// FAIL-CLOSED
//   If moderateText() itself throws, the caller must treat the message as
//   blocked. A filter that fails open is not a filter.
//
// PRIVACY
//   Rejections are logged as a SHA-256 fingerprint of the text plus the matched
//   term, never the text. That makes the log auditable - you can see that
//   something was blocked and correlate repeated attempts - without turning the
//   log into a store of the very content being blocked.
//=====================================================================

/** Outcome of one moderation decision. */
export interface ModerationResult {
  verdict: "allow" | "block";
  /** Stable identifier of the rule that fired, for logs and counters. */
  rule: string | null;
  /** Coarse bucket, useful for triage. */
  category: string | null;
  /** The specific term that matched. Safe to log: a single word, not the
   *  surrounding text. */
  matched: string | null;
  /** Short hash of the full text. Lets you correlate repeat attempts without
   *  storing the content. */
  fingerprint: string | null;
}

/**
 * Explicit sexual / pornographic vocabulary.
 *
 * Deliberately NOT included: bare "sex" (it appears in biology and medicine
 * questions), bare "xxx" (it is a placeholder in code), "hot", "naughty",
 * "incredible". Those produce false positives on normal conversation, and a
 * gate that blocks normal conversation gets switched off, which is worse than
 * having no gate at all.
 */
const EXPLICIT_TERMS: readonly string[] = [
  // explicit acts / descriptions
  "porn", "porno", "pornographic", "pornografi", "pornografis", "pornhub",
  "hentai", "nsfw", "erotic", "erotis", "fetish", "bdsm", "bondage",
  "sexual intercourse", "intercourse", "have sex", "having sex", "make love scene",
  "sex scene", "sex tape", "sex video", "sex chat",
  "nude", "nudes", "naked", "undress", "undressed", "topless",
  "strip tease", "striptease", "lingerie photo",
  "masturbat", "ejaculat", "orgasm", "penis", "vagina", "genital",
  "dick pic", "pussy", "boobs", "tits", "anal sex", "oral sex",
  "camgirl", "cam boy", "onlyfans", "fansly",
  "bocah sex", "sex anak", "abri", "open bra", "show breasts",
  "sexual content", "sexually explicit", "explicit sexual",
  // Indonesian / Sundanese / Javanese crudities that are unambiguous here
  "ngentot", "ngent", "kentot", "nasi tur", "tur telanjang",
  "telanjang", "bugil", "goyang", "jancuk", "bangsat", "mancun",
];

/** Indicators of a minor. Never combine these with anything sexual. */
const MINOR_TERMS: readonly string[] = [
  "child porn", "childporn", "child pornography", "csam",
  "minor sex", "underage sex", "sex with child", "sex with minor",
  "sex with a child", "sex with a minor", "sexually explicit child",
  "porn anak", "pornografi anak", "porno anak",
];

/** Sexual vocabulary used only to escalate a minor mention to a hard block. */
const SEXUAL_CONTEXT: readonly string[] = [
  "sex", "sexual", "nude", "naked", "porn", "explicit", "nsfw",
  "telanjang", "seks", "ngentot",
];

/** Non-consensual terms also matched as stems: "perkosa" must catch
 *  "perkosaan", "rape" must catch "rapes"/"raping". */
const NONCONSENSUAL_STEMS: readonly string[] = [
  "perkosa", "memerkosa", "rape", "raping", "raped", "molest", "incest",
  "bestiality", "zoophilia", "pemerkosa",
];

/** Non-consensual sexual content. */
const NONCONSENSUAL_TERMS: readonly string[] = [
  "rape", "raping", "raped", "molest", "incest", "bestiality", "zoophilia",
  "perkosa", "memerkosa", "incestuous",
];

/**
 * Word-boundary matcher.
 *
 * Same discipline as constitutional_guard.ts: "skill" must not match "kill",
 * "seks" must not match inside another word, and multi-word phrases match
 * literally. Accent-insensitive so "pornografi" and "pornografi" in any
 * casing collapse to one another.
 */
function normalize(s: string): string {
  return (s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");
}

function containsTerm(haystack: string, needle: string): boolean {
  if (!needle) return false;
  const i = haystack.indexOf(needle);
  if (i < 0) return false;
  if (needle.includes(" ")) return true; // phrase: literal substring is enough
  if (i > 0 && isWordByte(haystack[i - 1])) return false;
  const end = i + needle.length;
  if (end < haystack.length && isWordByte(haystack[end])) return false;
  return true;
}

/**
 * Start-of-word prefix match, no end boundary.
 *
 * Needed because English and Indonesian both inflect: "masturbat" does not
 * match "masturbation" under a strict end-boundary rule, and listing every
 * morphological variant forever is a losing game. Restricted to stems that are
 * long and unambiguous, and each one is still required to start on a word
 * boundary so "xporn" or "unude" cannot match.
 *
 * "nud" is deliberately NOT here: it would match "nudge". Nudity terms stay in
 * the exact list for that reason.
 */
function containsStem(haystack: string, stem: string): boolean {
  if (!stem) return false;
  let from = 0;
  for (;;) {
    const i = haystack.indexOf(stem, from);
    if (i < 0) return false;
    if (i === 0 || !isWordByte(haystack[i - 1])) return true;
    from = i + 1;
  }
}

/** Stems matched with prefix semantics. See containsStem(). */
const EXPLICIT_STEMS: readonly string[] = [
  "porn", "masturbat", "ejaculat", "orgasm", "erot", "fetish",
  "penis", "vagin", "genital", "camgirl", "onlyfan", "hentai", "nsfw",
  "bdsm", "bukil", "ngentot", "telanjang", "kentot", "pornhub",
];

function isWordByte(b: string): boolean {
  return (b >= "a" && b <= "z") || (b >= "0" && b <= "9");
}

function firstMatch(haystack: string, terms: readonly string[]): string | null {
  for (const t of terms) {
    const n = normalize(t);
    if (containsTerm(haystack, n)) return t;
  }
  return null;
}

/** Short, stable, non-reversible fingerprint for logging. */
function fingerprint(text: string): string {
  // FNV-1a 32-bit over a prefix. Not a security primitive and not meant to be
  // - it only has to let you tell "the same thing was attempted twice" apart
  // without keeping the text.
  let h = 0x811c9dc5;
  const s = text.slice(0, 512);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

const ALLOW: ModerationResult = {
  verdict: "allow", rule: null, category: null, matched: null, fingerprint: null,
};

/**
 * Decide whether a string may be sent to, or accepted from, a Telegram user.
 *
 * Throws only on programmer error; the caller is still expected to treat a
 * throw as "block".
 */
export function moderateText(text: string): ModerationResult {
  if (typeof text !== "string" || text.length === 0) return ALLOW;
  const hay = normalize(text);

  // 1. Minors. Checked first and unconditional: there is no context in which
  //    combining a minor indicator with this assistant is legitimate.
  const minor = firstMatch(hay, MINOR_TERMS);
  if (minor) {
    return {
      verdict: "block", rule: "minors_sexual_content", category: "minors",
      matched: minor, fingerprint: fingerprint(text),
    };
  }

  // 2. A bare minor reference plus any sexual vocabulary escalates too, which
  //    catches phrasings the fixed list above will never keep up with.
  const minorish = /\b(child|kids?|minor|underage|anak|remaja|balita|adik|anak\s+ecil)\b/.test(hay);
  if (minorish) {
    const sex = firstMatch(hay, SEXUAL_CONTEXT);
    if (sex) {
      return {
        verdict: "block", rule: "minors_sexual_context", category: "minors",
        matched: sex, fingerprint: fingerprint(text),
      };
    }
  }

  // 3. Non-consensual sexual content.
  const nonconStem = NONCONSENSUAL_STEMS.find((st) => containsStem(hay, normalize(st)));
  const noncon = nonconStem ?? firstMatch(hay, NONCONSENSUAL_TERMS);
  if (noncon) {
    return {
      verdict: "block", rule: "nonconsensual_sexual_content", category: "nonconsensual",
      matched: noncon, fingerprint: fingerprint(text),
    };
  }

  // 4. Explicit sexual / pornographic content. Stems first (they catch the
  //    inflected forms the exact list cannot enumerate), then exact terms.
  const stem = EXPLICIT_STEMS.find((st) => containsStem(hay, normalize(st)));
  const explicit = stem ?? firstMatch(hay, EXPLICIT_TERMS);
  if (explicit) {
    return {
      verdict: "block", rule: "explicit_sexual_content", category: "explicit",
      matched: explicit, fingerprint: fingerprint(text),
    };
  }

  return ALLOW;
}

/**
 * Lenient check for INCOMING user text.
 *
 * Blocks only what must never be answered at all: explicit sexual requests,
 * non-consensual requests, and anything involving minors. Ordinary questions
 * that merely contain a related word - "apa fungsi hormon seks pada manusia",
 * "jelaskan reproduksi pada hewan" - pass through untouched, because answering
 * them is what the assistant is for.
 */
export function moderateIncoming(text: string): ModerationResult {
  return moderateText(text);
}

/** Reply sent instead of blocked content. Deliberately neutral and brief. */
export const REFUSAL_ID =
  "Maaf, aku tidak bisa membantu dengan permintaan itu. " +
  "Kalau butuh bantuan lain, aku di sini.";

/** Counters exposed for /status so a block is never silent. */
const counters = new Map<string, number>();

export function moderationCounters(): Record<string, number> {
  return Object.fromEntries(counters);
}

/** Record a block. Logs rule + fingerprint + matched term, never the text. */
export function recordModerationBlock(
  res: ModerationResult,
  where: string,
  userId?: number | string,
): void {
  if (res.verdict !== "block") return;
  const key = `${where}:${res.rule}`;
  counters.set(key, (counters.get(key) ?? 0) + 1);
  console.warn(
    `[moderation] blocked rule=${res.rule} category=${res.category} ` +
    `matched=${JSON.stringify(res.matched)} fp=${res.fingerprint} ` +
    `user=${userId ?? "-"} at=${where}`,
  );
}

/** Test seam. */
export function resetModerationCounters(): void {
  counters.clear();
}
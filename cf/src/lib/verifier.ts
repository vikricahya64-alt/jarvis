//=====================================================================
// verifier.ts — deterministic OUTPUT GATE (verification rail).
//
// Catches silent-failure classes AFTER a provider returns, so a broken
// reply never reaches the owner as fact:
//   - raw_dump    : leaked raw HTML/JSON/code/scraper markers instead of a
//                   clean, synthesized answer.
//   - non_answer  : machine error artifacts / URL-only stubs.
//   - truncated   : silent provider cut (single source of truth with the
//                   deterministic repair hint).
//   - repetitive  : a follow-up that merely repeats the anchor analysis.
//
// All pure + conservative — a normal markdown/code answer must NEVER be
// flagged (fenced code is allowed, evaluator-optimizer recovery stays rare).
// A best-effort KV tally (tallyGate) records only NON-ok verdicts per path
// so the gap→upgrade loop can see WHICH capability misfires and how often
// (observability before automation, Alice Labs self-healing pattern).
//
// IMPORTANT: this module must not import from ./ai (ai.ts → verifier.ts is
// the only dependency direction). The canonical truncation helpers live
// HERE; ai.ts re-exports them for compatibility.
//=====================================================================

import { Env } from "./db";

// ==== Truncation: single source of truth (moved from ai.ts) ===============

/** Deterministic repair when the token budget was exhausted: strip any dangling
 *  trailing list marker / unclosed formatting so the listener never receives a
 *  half-cut bullet, then append an honest continuation hint. Applies ONLY when
 *  isLikelyTruncated() says the reply was cut. Never throws. */
export function repairTruncatedReply(reply: string): string {
  let out = (reply ?? "").trim();
  // 1) Drop a lone trailing list marker ("5.", "5)", "- ", "* ").
  out = out.replace(/\s*(?:\n+\s*\d+\.|\n+\s*\d+\)|\n+\s*[-*])\s*$/u, "");
  // 2) Drop an unclosed trailing markdown segment ("**...**" unterminated).
  const openBolds = (out.match(/\*\*/g) ?? []).length;
  if (openBolds % 2 === 1) out = out.replace(/\*\*[^*]*$/u, "");
  // 3) Drop a trailing colon that only opens an item that never got written.
  out = out.replace(/[:：]\s*$/u, "").trim();
  if (!out) return out;
  return `${out}\n\n📌 Jawaban saya terpotong oleh batas panjang — ketik \u201clanjut\u201d untuk bagian berikutnya.`;
}

/** True when a reply most likely got cut mid-sentence by the provider, even
 *  when no finish_reason / pinned-token signal is reported. Long answers that
 *  end on a bare heading or an unpunctuated statement line are the classic
 *  silent-cut signature (e.g. trailing "Proses Machine Learning" with nothing
 *  after it). Short answers and list items / explicit end-punctuation are
 *  trusted as complete. */
export function isLikelyTruncated(text: string): boolean {
  const t = (text ?? "").trim();
  if (t.length < 120) return false;
  const lastLine = (t.split(/\r?\n/).pop() ?? "").trim();
  if (!lastLine) return false;
  if (/[.!?…;：:]$|["'’)」》>`]|\]\s*$/u.test(lastLine)) return false;
  if (/^[-*•·]|\d+[.)]/.test(lastLine)) return false;
  return true;
}

// ==== Raw-dump / machine-artifact detectors ================================

/** True when the text is clearly leaked raw machinery (HTML, scraper markers,
 *  JSON blob, dense code, base64, minified blobs) rather than a real answer.
 *  Conservative: answers dominated by fenced code blocks (a legit code answer)
 *  or by natural-language prose are never flagged. */
export function isRawDumpText(text: string): boolean {
  const t = (text ?? "").trim();
  if (t.length < 60) return false;
  // Answers that are mostly fenced code are legit code answers, not dumps.
  const fenceless = t.replace(/```[\s\S]*?```/g, "");
  const fencedRatio = t.length > 0 ? 1 - fenceless.length / t.length : 0;
  if (fencedRatio > 0.5) return false;

  const lines = t.split(/\r?\n/);
  const lineCount = Math.max(1, lines.length);

  // Strong single-signal markers (HTML leak / scraper leak / module leak).
  const strongSignal =
    /<\/?html\b|<body\b|<!doctype\s*html/i.test(t) ||
    /\bresult__a\b|\bb_algo\b|\buddg=|\|{0,2}\s*ISI HALAMAN\b/i.test(t) ||
    /\bmodule\.exports\b|\bexport default\b|\brequire\(/i.test(t);

  // JSON object leak: many quoted-key lines.
  const keyLineCount = (t.match(/\n\s*"[A-Za-z0-9_]+"\s*:/g) ?? []).length;
  // Careful: conditions must not double-fire on prose like `"Jangan": ...`.
  const jsonBlob = keyLineCount >= 5;

  // Dense code with few prose lines and no fenced block to explain it.
  const codeLineRe =
    /^\s*(?:import\s+\w|export\s+(?:default\s+)?|const\s+\w+\s*=|let\s+\w+\s*=|var\s+\w+\s*=|function\s+\w*\s*\(|class\s+\w+[^:]*\{|return\s+[^a-zA-Z]|}{\s*$|\{\s*$|"[A-Za-z0-9_]+"\s*:)/;
  let codeCount = 0;
  let proseCount = 0;
  for (const line of lines) {
    const l = line.trim();
    if (!l) continue;
    if (codeLineRe.test(l)) { codeCount += 1; continue; }
    const words = l.split(/\s+/).filter(Boolean).length;
    if (words >= 2 && l.length >= 20) proseCount += 1;
  }
  const codeHeavy =
    lineCount >= 6 && codeCount / lineCount >= 0.4 && proseCount / lineCount < 0.5 && keyLineCount === 0;

  // Minified / base64 blobs. Conservative: only whitespace-separated tokens
  // that VALIDATE as base64 (charset + optional padding + length multiple of
  // 4 + mixed-case) count — a long prose run of lowercase letters must never
  // be mistaken for a blob.
  const minified = lines.some((l) => l.length > 220 && !/\s/.test(l) && !/^https?:/.test(l));
  const base64Blob = t.split(/\s+/).some(
    (tok) =>
      tok.length >= 48 &&
      /^[A-Za-z0-9+/]+={0,2}$/.test(tok) &&
      (tok.length % 4 === 0 || /={1,2}$/.test(tok)) &&
      /[A-Z]/.test(tok) &&
      /[a-z]/.test(tok),
  );

  return strongSignal || jsonBlob || codeHeavy || minified || base64Blob;
}

/** True when the reply is a machine error artifact or a URL-only stub — i.e.
 *  something that must never be delivered to the owner as an answer. */
export function isNonAnswerText(text: string): boolean {
  const t = (text ?? "").trim();
  if (!t) return true;
  const head = t.slice(0, 220);
  if (
    /^(?:an error occurred|error[:\s]|failed to |cannot (?:read|connect|parse)|fatal:|uncaught|http[\s\/-]*[45]\d\d|"error"\s*:)/i.test(head)
  ) return true;
  if (/\bECONNRESET\b|\bETIMEDOUT\b|\bENOTFOUND\b|\bECONNREFUSED\b|\bUnhandledRejection\b|\bTypeError\b|\bReferenceError\b/i.test(head)) return true;
  // Mostly-link stub: strip URLs and surrounding markdown, if little prose remains.
  const links = t.match(/https?:\/\/[^\s]+/g) ?? [];
  if (links.length >= 1) {
    const prose = t
      .replace(/https?:\/\/[^\s]+/g, " ")
      .replace(/[📚\*\[\]()#:.;,0-9\n\t]/g, " ")
      .trim()
      .replace(/\s+/g, " ");
    if (prose.length < 40) return true;
  }
  return false;
}

// ==== Repetition detector (follow-up anchor) ===============================

/** Stopwords too common to be informative for overlap measurement. Subset of
 *  the TOPIC_STOP vocabulary used by topicOverlaps (ai.ts) — kept local so the
 *  gate stays dependency-free. */
const REP_STOP = new Set<string>([
  "yang", "itu", "dengan", "dari", "pada", "untuk", "dan", "atau", "dalam", "akan",
  "juga", "kamu", "saya", "anda", "kami", "kita", "mereka", "dia", "ini", "ada",
  "adalah", "di", "ke", "saat", "karena", "kalau", "jika", "maka", "tapi", "namun",
  "agar", "supaya", "bisa", "dapat", "harus", "ingin", "mau", "sudah", "belum",
  "tidak", "bukan", "sangat", "lebih", "cara", "banyak", "sedikit", "tentu",
  "seperti", "baik", "mungkin", "masih", "terus", "lanjut", "detail", "saja",
  "lagi", "kali", "pertama", "secara", "antara", "serta", "dengan", "selalu",
]);

function significantWords(text: string): string[] {
  return (text.match(/[A-Za-z\u00C0-\u024F]+/g) ?? [])
    .map((w) => w.toLowerCase())
    .filter((w) => w.length > 2 && !REP_STOP.has(w));
}

/** True when the reply essentially re-says the anchor (same significant word
 *  pairs in the same order, almost nothing new) — the classic follow-up
 *  repetition failure. Only judged when both sides are substantial. */
export function isRepetitiveText(text: string, anchor: string): boolean {
  if (!anchor || anchor.trim().length < 80) return false;
  const t = (text ?? "").trim();
  if (t.length < 140) return false;
  const a = significantWords(anchor);
  const b = significantWords(t);
  if (a.length < 8 || b.length < 8) return false;
  const aBigrams = new Set<string>();
  for (let i = 0; i < a.length - 1; i++) aBigrams.add(`${a[i]} ${a[i + 1]}`);
  let shared = 0;
  for (let i = 0; i < b.length - 1; i++) {
    if (aBigrams.has(`${b[i]} ${b[i + 1]}`)) shared += 1;
  }
  const overlap = shared / (b.length - 1);
  if (overlap < 0.5) return false;
  const aSet = new Set(a);
  const novel = b.filter((w) => !aSet.has(w)).length;
  const novelRatio = novel / b.length;
  return overlap >= 0.6 && novelRatio < 0.35;
}

// ==== Public gate ==========================================================

export type GateVerdict = "raw_dump" | "non_answer" | "truncated" | "repetitive" | "ok";

/** Classify an LLM reply before it is delivered. Precedence: raw machinery >
 *  non-answer > truncation > anchor repetition > ok. `anchor` is the prior
 *  analysis to compare against for repetition (empty = skip that check). */
export function gateVerdict(text: string, anchor = ""): GateVerdict {
  const t = (text ?? "").trim();
  if (!t) return "non_answer";
  if (isRawDumpText(t)) return "raw_dump";
  if (isNonAnswerText(t)) return "non_answer";
  if (isLikelyTruncated(t)) return "truncated";
  if (isRepetitiveText(t, anchor)) return "repetitive";
  return "ok";
}

// ==== Fabricated-link gate (ground-truth URL validation) ====================

/** Normalize a URL for membership comparison: no scheme, no trailing slash,
 *  no www + fragment/query — so "https://example.com/a/" matches
 *  "example.com/a#sec" for allow-listing. Pure helper. */
export function normalizeLinkForCompare(url: string): string {
  return (url ?? "")
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/^www\./i, "")
    .split(/[?#]/)[0]
    .replace(/\/+$/, "")
    .toLowerCase();
}

/** Strip every URL that is NOT present in `allowedUrls` — the anti-fabrication
 *  rail: an LLM reply may only cite sources the search actually returned.
 *  Fail-closed: a fabricated link is dropped (markdown "[[label](url)]"
 *  keeps the label as plain text), everything else stays untouched. Never
 *  throws; never blocks a full reply; pure + deterministic. */
export function sanitizeUncitedLinks(text: string, allowedUrls: string[]): string {
  const t = (text ?? "").trim();
  if (!t || !allowedUrls?.length) return t;
  const allowed = new Set(allowedUrls.map(normalizeLinkForCompare).filter(Boolean));
  if (allowed.size === 0) return t;

  // Markdown links: [label](url)
  let out = t.replace(/\[([^\]]*)\]\(\s*(https?:\/\/[^\s)]+)\)/g, (_all, label: string, rawUrl: string) => {
    if (allowed.has(normalizeLinkForCompare(rawUrl))) return `[${label}](${rawUrl})`;
    const lbl = (label ?? "").trim();
    return lbl ? `[${lbl}]` : "";
  });
  // Bare URLs (not already inside parentheses, incl. trailing punctuation)
  out = out.replace(/(?<=^|\s)(https?:\/\/[^\s()]+[^\s.,;:)!?'")\]}\]])/g, (rawUrl: string) =>
    allowed.has(normalizeLinkForCompare(rawUrl)) ? rawUrl : "",
  );
  return out.replace(/[ \t]+/g, " ").replace(/ ?\n ?/g, "\n").trim();
}

// ==== Observability: gap→upgrade metric ====================================

/** Best-effort KV tally of NON-ok verdicts per path per day, so the
 *  gap→upgrade loop can see which capability misfires and how often.
 *  100% fire-and-forget — never throws, never blocks a reply. Only records
 *  failures (ok noise skipped), mirroring the cost-ledger pattern. */
export async function tallyGate(env: Env, path: string, verdict: GateVerdict): Promise<void> {
  if (!env || verdict === "ok") return;
  try {
    const d = new Date();
    const key = `gate:${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    const prev = await env.CONFIG_KV?.get(key).catch(() => null);
    const cur = (prev ? JSON.parse(prev) : {}) as Record<string, Record<string, number>>;
    cur[path] = cur[path] ?? {};
    cur[path][verdict] = (cur[path][verdict] ?? 0) + 1;
    await env.CONFIG_KV?.put(key, JSON.stringify(cur), { expirationTtl: 8 * 86400 }).catch(() => {});
  } catch { /* best-effort */ }
}
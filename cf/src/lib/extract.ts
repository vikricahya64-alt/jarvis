//=====================================================================
// extract.ts — Evidence Extractor support: fetch + strip web pages to
// clean text for the quarantined extractor sub-agent (see subagents.ts).
//
// Implements the zero-dependency half of the "Evidence Extractor" role:
//   fetch(url) -> strip HTML/scripts/cruft -> clean text (fail-open).
// The resulting text is UNTRUSTED and must be spotlighted before reaching
// any LLM. Per Cloudflare free-tier limits: each fetch is 1 of 50
// subrequests/invocation; we fetch only a small bounded set of pages.
//
// This is regex-based (no DOM in Workers; zero runtime deps keeps the
// bundle small and the build robust). Fail-open: returns null on any
// error/unreachable so the orchestrator degrades to snippet-only evidence.
//=====================================================================

import { fetchWithTimeout } from "./resilience";

/** Fetch a URL's body and strip it down to readable plain text.
 *  Returns null when unreachable, too large, or non-HTML (fail-open). */
export async function fetchPageText(
  url: string,
  maxBytes = 200_000,
  timeoutMs = 8000,
): Promise<string | null> {
  let res: Response;
  try {
    res = await fetchWithTimeout(url, {
      headers: { "User-Agent": "Mozilla/5.0 (Linux; Android 10)", "Accept-Language": "id,id-ID;q=0.9,en;q=0.8" },
    }, timeoutMs);
  } catch {
    return null;
  }
  if (!res.ok) return null;
  const ct = res.headers.get("content-type") || "";
  if (ct && !/text\/html|text\/plain|application\/xhtml/i.test(ct)) return null;
  const body = await res.text().catch(() => "");
  if (!body || body.length > maxBytes) return null;
  return htmlToText(body);
}

/** Strip HTML to readable text: drop script/style/nav/aside/footer cruft,
 *  remove tags, decode common entities, collapse whitespace. Robust to
 *  partial/malformed HTML (never throws). */
export function htmlToText(html: string): string {
  let s = html;
  // Drop non-content blocks first (their inner text would pollute the rest).
  s = s.replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<(?:nav|aside|footer|header)[^>]*>[\s\S]*?<\/(?:nav|aside|footer|header)>/gi, " ");
  // Remove comment nodes.
  s = s.replace(/<!--[\s\S]*?-->/g, " ");
  // Replace meaningful inline breaks so sentences don't run together.
  s = s.replace(/<\/(?:p|div|li|h[1-6]|tr|section|article|br|blockquote)>/gi, "\n");
  // Strip any remaining tags.
  s = s.replace(/<[^>]+>/g, " ");
  // Decode common HTML entities.
  s = s.replace(/&nbsp;|&#160;/g, " ")
    .replace(/&amp;|&#38;/g, "&")
    .replace(/&lt;|&#60;/g, "<")
    .replace(/&gt;|&#62;/g, ">")
    .replace(/&quot;|&#34;|&ldquo;|&rdquo;/g, '"')
    .replace(/&apos;|&#39;|&lsquo;|&rsquo;/g, "'")
    .replace(/&hellip;|&#8230;/g, "...");
  // Collapse whitespace and trim line noise.
  s = s.replace(/[ \t]+/g, " ").replace(/ ?\n ?/g, "\n").replace(/\n{3,}/g, "\n\n");
  return s.trim();
}

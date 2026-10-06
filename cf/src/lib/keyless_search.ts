/**
 * Keyless retrieval for the answerer.
 *
 * No search API keys. That is a deliberate constraint, so it needs to be
 * measured rather than assumed - and it was measured, per layer, from the
 * worker itself (GET /search_diag), not from a local run:
 *
 *   layer                queries with results   notes
 *   bing-html            3/3                    the ONLY dependable layer
 *   ddg-html-scrape      2/3                    1 returned a bot challenge (202)
 *   ddg-instant-answer   0/3                    HTTP 200 with an empty graph
 *   searxng-json         0/3                    public instance refuses JSON
 *                                              for clients without a key
 *
 * So the chain is one strong layer plus one flaky one. That is a real
 * fragility and is recorded here rather than smoothed over: if Bing changes
 * its markup there is nothing reliable behind it. Reachability checks are not
 * evidence of usefulness here - the blocked scraper answers 202, which looks
 * healthy to a status probe, and the Instant Answer API answers 200 with
 * nothing in it.
 */

export interface Hit {
  title: string;
  url: string;
  snippet: string;
}

function stripTags(s: string): string {
  return s
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ").replace(/\s+/g, " ")
    .trim();
}

async function fetchText(url: string, ms = 9000): Promise<string | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 (Linux; Android 10)",
        "Accept-Language": "id,id;q=0.9,en;q=0.7",
      },
    });
    // A 202 challenge page still returns 200 text, so the body is returned and
    // the caller sees zero parsed results rather than a false "reachable".
    return await res.text();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function bingHits(query: string, limit = 6): Promise<Hit[]> {
  const html = await fetchText(`https://www.bing.com/search?q=${encodeURIComponent(query)}&count=10`);
  if (!html) return [];
  const out: Hit[] = [];
  for (const block of html.match(/<li class="b_algo"[\s\S]*?<\/li>/g) ?? []) {
    const href = block.match(/<h2[^>]*>\s*<a[^>]*href="([^"]+)"/)?.[1];
    const title = stripTags(block.match(/<h2[^>]*>([\s\S]*?)<\/h2>/)?.[1] ?? "");
    const snippet = stripTags(block.match(/<p[^>]*>([\s\S]*?)<\/p>/)?.[1] ?? "");
    if (href && /^https?:/.test(href)) out.push({ title, url: href, snippet });
    if (out.length >= limit) break;
  }
  return out;
}

export async function ddgHits(query: string, limit = 4): Promise<Hit[]> {
  const html = await fetchText(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`);
  if (!html) return [];
  const out: Hit[] = [];
  for (const a of html.match(/class="result__a"[^>]*href="[^"]*"[^>]*>[\s\S]*?<\/a>/g) ?? []) {
    const href = a.match(/href="([^"]+)"/)?.[1];
    const title = stripTags(a.replace(/<[^>]+>/g, " "));
    if (href) out.push({ title, url: href, snippet: "" });
    if (out.length >= limit) break;
  }
  return out;
}

/** Cap by distinct host so the answerer cannot be fed a link farm. */
function dedupeByHost(hits: Hit[], limit: number): Hit[] {
  const seen = new Set<string>();
  const out: Hit[] = [];
  for (const h of hits) {
    let host = "";
    try {
      host = new URL(h.url).hostname.replace(/^www\./, "");
    } catch {
      host = h.url.slice(0, 40);
    }
    if (!host || seen.has(host)) continue;
    seen.add(host);
    out.push(h);
    if (out.length >= limit) break;
  }
  return out;
}

export interface Retrieval {
  hits: Hit[];
  /** Which layers actually contributed, for diagnostics. */
  used: string[];
}

/**
 * Retrieve for the answerer. Bing first because it is the only layer measured
 * reliable; DDG is a best-effort top-up, not a genuine fallback, and `used`
 * records what really answered so the diagnostic never overstates coverage.
 */
export async function retrieveKeyless(query: string, limit = 6): Promise<Retrieval> {
  const [b, d] = await Promise.all([bingHits(query), ddgHits(query)]);
  return {
    hits: dedupeByHost([...b, ...d], limit),
    used: [...(b.length ? ["bing-html"] : []), ...(d.length ? ["ddg-html-scrape"] : [])],
  };
}

/** Rendered passages for the answerer. Numbered so citations stay traceable. */
export function renderPassages(hits: Hit[]): string {
  return hits.map((h, i) => `[${i + 1}] ${h.title}\n${h.snippet}\n${h.url}`).join("\n\n");
}
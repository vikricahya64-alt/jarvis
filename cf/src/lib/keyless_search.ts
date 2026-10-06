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
    // Bing serves more than one markup shape for these blocks, so the href is
    // read tolerantly: first the canonical <h2><a href>, then any absolute http
    // href in the block. The strict form alone dropped every result on some
    // responses - the block existed, so a status probe reported hits, and the
    // pipeline still ended up with zero. A count is not a parse.
    let href = block.match(/<h2[^>]*>\s*<a[^>]*href="(https?:[^"]+)"/i)?.[1];
    if (!href) href = block.match(/href="(https?:[^"]+)"/i)?.[1];
    const title = stripTags(
      block.match(/<h2[^>]*>([\s\S]*?)<\/h2>/i)?.[1]
      ?? block.match(/<a[^>]*>([\s\S]*?)<\/a>/i)?.[1]
      ?? "",
    );
    const snippet = stripTags(block.match(/<p[^>]*>([\s\S]*?)<\/p>/i)?.[1] ?? "");
    if (href) out.push({ title, url: href, snippet });
    if (out.length >= limit) break;
  }
  return out;
}

export async function ddgHits(query: string, limit = 4): Promise<Hit[]> {
  const html = await fetchText(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`);
  if (!html) return [];
  const out: Hit[] = [];
  // The anchor text and the href must be read separately. A single regex over
  // the whole <a> element produced titles that were raw attribute strings
  // (`class="result__a" href="//duckduckgo.com/l/?uddg=..."`) because the match
  // began at `class=` rather than at the tag, so nothing was stripped.
  for (const a of html.match(/<a[^>]*class="[^"]*result__a[^"]*"[^>]*>[\s\S]*?<\/a>/g) ?? []) {
    const href = a.match(/href="([^"]+)"/)?.[1];
    const title = stripTags(a.replace(/<a[^>]*>/i, " ").replace(/<\/a>/i, " "));
    if (!href) continue;
    // DuckDuckGo wraps results in a redirect: //duckduckgo.com/l/?uddg=<encoded>
    // Handing the model a redirect URL is a citation the user cannot open.
    const real = href.includes("uddg=")
      ? decodeURIComponent(href.slice(href.indexOf("uddg=") + 5).split("&")[0])
      : href.startsWith("//")
        ? `https:${href}`
        : href;
    if (!/^https?:/i.test(real)) continue;
    out.push({ title, url: real, snippet: "" });
    if (out.length >= limit) break;
  }
  return out;
}

const STOP_FOR_SEARCH = new Set([
  "yang", "dalam", "segi", "mana", "lebih", "baik", "apa", "atau", "dan", "untuk",
  "dengan", "pada", "dari", "ke", "itu", "ini", "saya", "kamu", "adalah", "tentang",
  "the", "and", "for", "with", "what", "how", "why", "which", "best", "between",
]);

/**
 * Wikipedia as a retrieval layer.
 *
 * Added because the scraped engines are both unreliable in ways that were
 * measured, not assumed: DDG alternates 10 hits / HTTP 202 challenge across
 * consecutive identical requests, and Bing returns an empty parse under repeat
 * load. Wikipedia needs no API key, is not scraped, and returns structured
 * plaintext - which makes it the most dependable layer available, and the right
 * one for exactly the questions this bot is asked ("what is inflation", "the
 * history of forex", "Bretton Woods").
 *
 * Not a web-search replacement: it only knows encyclopaedic articles. It is
 * here so a failed scrape degrades to "encyclopaedic evidence" instead of to
 * "no evidence, refuse to answer".
 */
export async function wikipediaHits(query: string, limit = 3): Promise<Hit[]> {
  const url =
    "https://id.wikipedia.org/w/api.php?action=query&format=json&origin=*" +
    "&generator=search&gsrsearch=" + encodeURIComponent(query) +
    "&gsrlimit=" + String(limit) +
    "&prop=extracts&exintro=1&explaintext=1&exsectionformat=plain";
  // Wikipedia's search is strict: a whole interrogative sentence matches nothing.
  // Take the content words only, and cap the length.
  const keywords = (query ?? "")
    .replace(/\?+$/, "")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOP_FOR_SEARCH.has(w.toLowerCase()))
    .slice(0, 8)
    .join(" ");
  if (!keywords) return [];
  const raw = await fetchText(url.replace(encodeURIComponent(query), encodeURIComponent(keywords)));
  if (!raw) return [];
  try {
    const d = JSON.parse(raw) as {
      query?: { pages?: Record<string, { title?: string; extract?: string }> };
    };
    const pages = Object.values(d?.query?.pages ?? {});
    const out: Hit[] = [];
    for (const p of pages) {
      const title = (p.title ?? "").trim();
      const extract = (p.extract ?? "").replace(/\s+/g, " ").trim();
      if (!title) continue;
      out.push({
        title,
        url: `https://id.wikipedia.org/wiki/${encodeURIComponent(title.replace(/ /g, "_"))}`,
        snippet: extract.slice(0, 400),
      });
    }
    return out;
  } catch {
    return [];
  }
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
  // One retry. DDG alternates between 10 hits and an HTTP 202 bot challenge on
  // consecutive identical requests - measured 10/0/10 across three runs - so a
  // single empty scrape is not evidence that nothing is available. Bing was
  // 5/5, which is why it goes first.
  let b: Hit[] = [];
  let d: Hit[] = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    [b, d] = await Promise.all([bingHits(query), ddgHits(query)]);
    if (b.length + d.length > 0) break;
    if (attempt === 0) await new Promise((r) => setTimeout(r, 400));
  }
  // Only pay for Wikipedia when the web layers came back empty: it is slower
  // than a scrape and narrower in what it can answer.
  let w: Hit[] = [];
  if (b.length + d.length === 0) w = await wikipediaHits(query);
  return {
    hits: dedupeByHost([...b, ...d, ...w], limit),
    used: [
      ...(b.length ? ["bing-html"] : []),
      ...(d.length ? ["ddg-html-scrape"] : []),
      ...(w.length ? ["wikipedia"] : []),
    ],
  };
}

/** Rendered passages for the answerer. Numbered so citations stay traceable. */
export function renderPassages(hits: Hit[]): string {
  return hits.map((h, i) => `[${i + 1}] ${h.title}\n${h.snippet}\n${h.url}`).join("\n\n");
}
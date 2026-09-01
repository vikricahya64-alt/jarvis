"""
Research agent tools: live DuckDuckGo web search (free) and URL scraping.

Search is layered for resilience against rate-limit / CAPTCHA:
  1. duckduckgo-search library (backend 'auto' -> try api, html, lite)
  2. manual scrape of html.duckduckgo.com/html/ (POST)
  3. manual scrape of lite.duckduckgo.com/lite/ (POST)
Plus DuckDuckGo AI Chat (free, no API key, OpenAI-compatible endpoint) which
answers with live web results.

Synchronous implementation to avoid event-loop conflicts inside Vercel
serverless functions.
"""
import html as _html
import json
import re
import urllib.parse

import httpx

try:
    from duckduckgo_search import DDGS
    DDGS_AVAILABLE = True
except ImportError:
    DDGS_AVAILABLE = False

UA = (
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/120.0 Safari/537.36"
)


# ------------------------------------------------------------------
# Web search (layered fallback)
# ------------------------------------------------------------------
def search_web(query: str, max_results: int = 5) -> list:
    """
    Search the web via DuckDuckGo with layered fallbacks. Returns a list of
    dicts: {title, url, snippet}.
    """
    if DDGS_AVAILABLE:
        try:
            with DDGS() as ddgs:
                out = [
                    {
                        "title": r.get("title", ""),
                        "url": _abs_url(r.get("href", "")),
                        "snippet": r.get("body", ""),
                    }
                    for r in ddgs.text(query, max_results=max_results)
                ]
            if out:
                return out
        except Exception:
            pass  # fall through to manual layers

    for scraper in (_ddg_html, _ddg_lite, _bing_search):
        try:
            out = scraper(query, max_results)
            if out:
                return out
        except Exception:
            continue

    return [{
        "title": "Search failed",
        "url": "",
        "snippet": "DuckDuckGo is rate-limiting or unreachable from this network. Try again later.",
    }]


def _ddg_html(query: str, max_results: int) -> list:
    """POST to html.duckduckgo.com/html/ and parse result__a / result__snippet."""
    with httpx.Client(
        headers={"User-Agent": UA, "Accept-Language": "en-US,en;q=0.9"},
        timeout=20,
        follow_redirects=True,
    ) as c:
        resp = c.post(
            "https://html.duckduckgo.com/html/",
            data={"q": query},
            headers={"Content-Type": "application/x-www-form-urlencoded"},
        )
        resp.raise_for_status()
        page = resp.text
    links = re.findall(
        r'<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>(.*?)</a>',
        page,
        flags=re.S | re.I,
    )
    snippets = re.findall(
        r'<a[^>]*class="result__snippet"[^>]*>(.*?)</a>', page, flags=re.S | re.I
    )
    out = []
    for i, (href, title) in enumerate(links[:max_results]):
        snip = snippets[i] if i < len(snippets) else ""
        out.append({
            "title": _clean(title),
            "url": _abs_url(_html.unescape(href)),
            "snippet": _clean(snip),
        })
    return out


def _ddg_lite(query: str, max_results: int) -> list:
    """POST to lite.duckduckgo.com/lite/ and parse result-link / result-snippet."""
    with httpx.Client(
        headers={"User-Agent": UA, "Accept-Language": "en-US,en;q=0.9"},
        timeout=20,
        follow_redirects=True,
    ) as c:
        resp = c.post(
            "https://lite.duckduckgo.com/lite/",
            data={"q": query},
            headers={"Content-Type": "application/x-www-form-urlencoded"},
        )
        resp.raise_for_status()
        page = resp.text
    links = re.findall(
        r'<a[^>]*class="result-link"[^>]*href="([^"]+)"[^>]*>(.*?)</a>',
        page,
        flags=re.S | re.I,
    )
    snippets = re.findall(
        r'<td class="result-snippet">(.*?)</td>', page, flags=re.S | re.I
    )
    out = []
    for i, (href, title) in enumerate(links[:max_results]):
        snip = snippets[i] if i < len(snippets) else ""
        out.append({
            "title": _clean(title),
            "url": _abs_url(_html.unescape(href)),
            "snippet": _clean(snip),
        })
    return out


def _bing_search(query: str, max_results: int) -> list:
    """Scrape Bing SERP (free, no key, friendly to cloud IPs)."""
    with httpx.Client(
        headers={
            "User-Agent": UA,
            "Accept-Language": "en-US,en;q=0.9,id;q=0.8",
        },
        timeout=20,
        follow_redirects=True,
    ) as c:
        resp = c.get(
            "https://www.bing.com/search",
            params={"q": query, "setlang": "en", "cc": "us", "count": str(max_results)},
        )
        resp.raise_for_status()
        page = resp.text
    blocks = re.split(r'<li class="b_algo"', page)[1:]
    out = []
    for block in blocks[:max_results]:
        m = re.search(r'<h2[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>(.*?)</a>', block, re.S)
        if not m:
            continue
        href, title = m.group(1), _clean(m.group(2))
        p = re.search(r"<p[^>]*>(.*?)</p>", block, re.S)
        snip = _clean(p.group(1)) if p else ""
        out.append({"title": title, "url": _bing_real_url(_html.unescape(href)), "snippet": snip})
    return out


def _bing_real_url(url: str) -> str:
    """Decode Bing /ck/a redirect URLs back to the real target."""
    import base64

    if "/ck/a" not in url:
        return url
    par = urllib.parse.parse_qs(urllib.parse.urlsplit(url).query)
    u = (par.get("u") or [""])[0]
    if not u.startswith("a1"):
        return url
    b64 = u[2:]
    b64 += "=" * (-len(b64) % 4)
    try:
        return base64.urlsafe_b64decode(b64).decode("utf-8", "ignore")
    except Exception:
        return url


# ------------------------------------------------------------------
# DuckDuckGo AI Chat (free live web answers) + search_live tool
# ------------------------------------------------------------------
def search_live(query: str, max_chars: int = 1500) -> dict:
    """
    Get a concise, live-web-based answer via DuckDuckGo AI Chat (free, no key).
    Returns {'answer': text}.
    """
    prompt = (
        "Return a concise, fact-based answer to the question below, based on "
        "live web search results. Cite the source domain(s) inline like "
        "(source: example.com). Keep it under 600 words and structured with "
        "short sections. Do not mention that you are an AI.\n\nQuestion: "
        + (query or "")
    )
    try:
        answer = _ddg_ai_chat([{"role": "user", "content": prompt}], max_chars=max_chars)
        if not answer.startswith("DuckDuckGo AI Chat"):
            return {"answer": answer}
        raise RuntimeError(answer)
    except Exception:
        pass

    # DDG AI Chat is blocked from cloud IPs -> fall back to live Bing results.
    try:
        results = search_web(query, max_results=5)
        lines = []
        for i, r in enumerate(results, 1):
            title = r.get("title") or "(no title)"
            snip = r.get("snippet") or ""
            url = r.get("url") or ""
            lines.append(f"{i}. {title}\n{snip}\n{url}")
        body = "\n\n".join(lines) if lines else "Tidak ada hasil."
        return {
            "answer": (
                "Live Q&A tidak tersedia (DuckDuckGo memblokir IP cloud); "
                "berikut hasil pencarian langsung:\n\n" + body
            )[:max_chars]
        }
    except Exception as exc:
        return {"answer": f"Could not reach DuckDuckGo AI Chat: {exc}"}


def _ddg_ai_chat(messages: list, model: str = None, max_chars: int = 1500) -> str:
    """Talk to the free DuckDuckGo AI Chat endpoint (SSE, OpenAI-ish)."""
    import logging

    log = logging.getLogger("jarvis.ddg")
    headers_base = {"User-Agent": UA, "Accept-Language": "en-US,en;q=0.9"}
    with httpx.Client(headers=headers_base, timeout=30) as c:
        st = c.get(
            "https://duckduckgo.com/duckchat/v1/status",
            headers={"x-vqd-accept": "application/json"},
        )
        st.raise_for_status()
        vqd = (
            st.headers.get("x-vqd-4")
            or st.headers.get("x-vqd-hash")
            or st.headers.get("vqd")
        )
        body = {}
        try:
            body = st.json()
        except Exception:
            pass
        if not vqd:
            vqd = body.get("token")
        log.info(
            f"DDG AI status: {st.status_code} vqd={'yes' if vqd else 'NO'} "
            f"ct={st.headers.get('content-type','?')[:40]} "
            f"body={st.text[:200]!r}"
        )
        if not vqd:
            return "DuckDuckGo AI Chat: could not obtain vqd token (status endpoint gave none)."

        models = body.get("models") or []
        chosen = model or next(
            (m["id"] for m in models if str(m.get("provider", "")).lower() == "openai"),
            models[0]["id"] if models else None,
        ) or "gpt-4o-mini"
        log.info(f"DDG AI using model {chosen}")

        payload = {"model": chosen, "messages": messages}
        headers = {
            "Content-Type": "application/json",
            "x-vqd-4": str(vqd),
            "x-vqd-accept": "text/event-stream",
            "x-feature-conversation": (
                '{"allowed-languages":["en","id"],"allowed-ds-groups":[1,2,3,4],'
                '"user":{},"system":""}'
            ),
        }
        chat = c.post(
            "https://duckduckgo.com/duckchat/v1/chat", json=payload, headers=headers
        )
        log.info(
            f"DDG AI chat POST -> {chat.status_code} ct={chat.headers.get('content-type','?')[:40]} "
            f"head={chat.text[:150]!r}"
        )
        if chat.status_code != 200:
            return (
                f"DuckDuckGo AI Chat HTTP {chat.status_code}: "
                f"{chat.text[:200]}"
            )
        raw = chat.text

    pieces = []
    for line in raw.splitlines():
        line = line.strip()
        if not line.startswith("data: "):
            continue
        try:
            obj = json.loads(line[6:])
        except Exception:
            continue
        msg = obj.get("message")
        if obj.get("action") == "error":
            return f"DuckDuckGo AI Chat error: {msg}"
        if msg:
            pieces.append(msg)
    answer = "".join(pieces).strip()
    if answer:
        return answer[:max_chars]
    return raw[:max_chars]


# ------------------------------------------------------------------
# Helpers
# ------------------------------------------------------------------
def scrape_url(url: str, max_chars: int = 4000) -> str:
    """
    Fetch a URL and return its readable text content.

    Args:
        url: The URL to scrape.
        max_chars: Max characters of extracted text to return.

    Returns:
        Plain text content of the page.
    """
    headers = {"User-Agent": UA}
    try:
        with httpx.Client(timeout=20, follow_redirects=True) as client:
            resp = client.get(url, headers=headers)
            resp.raise_for_status()

        text = re.sub(r"<script[^>]*>.*?</script>", " ", resp.text, flags=re.S | re.I)
        text = re.sub(r"<style[^>]*>.*?</style>", " ", text, flags=re.S | re.I)
        text = re.sub(r"<[^>]+>", " ", text)
        text = re.sub(r"\s+", " ", text).strip()
        return text[:max_chars]
    except Exception as exc:
        return f"Error scraping {url}: {exc}"


def _clean(text: str) -> str:
    return _html.unescape(re.sub(r"<[^>]+>", " ", text)).strip()


def _abs_url(url: str) -> str:
    """Resolve DuckDuckGo redirect/relative URLs to absolute https URLs."""
    q = urllib.parse.urlparse(url)
    if q.scheme in ("http", "https"):
        return url
    if q.netloc == "duckduckgo.com" and q.path.startswith("/l/"):
        par = urllib.parse.parse_qs(urllib.parse.unquote(q.query))
        uddg = (par.get("uddg") or [""])[0]
        if uddg:
            return uddg
    if url.startswith("//"):
        return "https:" + url
    return url
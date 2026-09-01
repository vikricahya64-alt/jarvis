"""
Research agent tools: Web search (DuckDuckGo) and URL scraping.

Used by the Researcher agent and exposed to Groq as callable functions.
All functions are async to keep Vercel serverless responsive.
"""
import httpx
import asyncio

try:
    from duckduckgo_search import DDGS
    DDGS_AVAILABLE = True
except ImportError:
    DDGS_AVAILABLE = False


async def search_web(query: str, max_results: int = 5) -> list:
    """
    Search the web via DuckDuckGo and return a cleaned list of results.

    Args:
        query: The search query.
        max_results: Max number of results to return.

    Returns:
        A list of dicts: {title, url, snippet, body}.
    """
    if not DDGS_AVAILABLE:
        return [_offline_result(query)]

    def _search_sync():
        with DDGS() as ddgs:
            results = []
            for r in ddgs.text(query, max_results=max_results):
                results.append({
                    "title": r.get("title", ""),
                    "url": r.get("href", ""),
                    "snippet": r.get("body", ""),
                })
            return results

    try:
        # Run blocking DDGS in a thread to avoid blocking the event loop
        loop = asyncio.get_running_loop()
        results = await loop.run_in_executor(None, _search_sync)
        return results if results else [_offline_result(query)]
    except Exception as exc:
        return [{
            "title": "Search failed",
            "url": "",
            "snippet": f"Could not complete search: {exc}",
        }]


async def scrape_url(url: str, max_chars: int = 4000) -> str:
    """
    Fetch a URL and return its readable text content.

    Args:
        url: The URL to scrape.
        max_chars: Max characters of extracted text to return.

    Returns:
        Plain text content of the page.
    """
    headers = {"User-Agent": "Mozilla/5.0 (compatible; JARVIS-Bot/1.0; +https://github.com)"}
    try:
        async with httpx.AsyncClient(timeout=20, follow_redirects=True) as client:
            resp = await client.get(url, headers=headers)
            resp.raise_for_status()

        # Simple HTML-to-text extraction without heavy dependencies
        import re
        text = re.sub(r"<script[^>]*>.*?</script>", " ", resp.text, flags=re.S | re.I)
        text = re.sub(r"<style[^>]*>.*?</style>", " ", text, flags=re.S | re.I)
        text = re.sub(r"<[^>]+>", " ", text)
        text = re.sub(r"\s+", " ", text).strip()
        return text[:max_chars]
    except Exception as exc:
        return f"Error scraping {url}: {exc}"


def _offline_result(query: str) -> dict:
    return {
        "title": "DuckDuckGo search library not installed",
        "url": "",
        "snippet": f"Install 'duckduckgo-search' to enable live search. Query was: {query}",
    }

"""
Tiny TTL cache for live web-search results (Tavily/DDG), stored in Supabase.

Avoids re-hitting quota for repeated queries. Best-effort: any failure
(including table-not-created) degrades to a cache miss and returns None —
never raises.
"""
import hashlib
import datetime
import httpx
from utils.supabase_client import _config, _auth_headers

_TIMEOUT = httpx.Timeout(15)


def _url() -> str:
    base, _ = _config()
    return f"{base}/rest/v1/search_cache"


def _cache_key(query: str) -> str:
    return hashlib.sha256(query.strip().lower().encode()).hexdigest()


def get_cached(query: str, ttl_seconds: int = 3600):
    """Return cached payload for a query if fresh, else None."""
    try:
        key = _cache_key(query)
        with httpx.Client(timeout=_TIMEOUT) as client:
            r = client.get(
                _url(), params={"select": "payload,created_at",
                                "query": f"eq.{key}"},
                headers=_auth_headers(),
            )
            if r.status_code >= 400:
                return None
            rows = r.json()
        if not rows:
            return None
        created = rows[0].get("created_at")
        if not created:
            return None
        age = (datetime.datetime.now(datetime.timezone.utc)
               - datetime.datetime.fromisoformat(created.replace("Z", "+00:00")))
        if age.total_seconds() > ttl_seconds:
            return None
        return rows[0].get("payload")
    except Exception:
        return None


def set_cache(query: str, payload) -> bool:
    """Upsert a search result into the cache."""
    try:
        key = _cache_key(query)
        with httpx.Client(timeout=_TIMEOUT) as client:
            r = client.post(
                _url(),
                json={"query": key, "payload": payload},
                params={"on_conflict": "query"},
                headers={**_auth_headers(), "Prefer": "resolution=merge-duplicates,return=minimal"},
            )
            return r.status_code < 400
    except Exception:
        return False

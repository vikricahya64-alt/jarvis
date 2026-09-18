"""
Authorization + rate limiting for private integrations.

Every private tool must resolve the real `telegram_chat_id` of the task
owner and confirm they own a `private_connections` row for the provider
BEFORE any token is decrypted or API is touched.
"""
import datetime
import httpx

from utils import supabase_client


def get_connection(telegram_id: int, provider: str):
    """Ownership-checked connection metadata, or None when not connected."""
    base, _ = supabase_client._config()
    with httpx.Client(timeout=supabase_client._TIMEOUT) as client:
        res = client.get(
            f"{base}/rest/v1/private_connections",
            params={
                "select": "*",
                "telegram_chat_id": f"eq.{telegram_id}",
                "provider": f"eq.{provider}",
                "limit": "1",
            },
            headers=supabase_client._auth_headers(),
        )
        supabase_client._raise_for(res, "private_connections.select")
        rows = res.json()
        if not rows:
            return None
        row = rows[0]
        if str(row.get("telegram_chat_id")) != str(telegram_id):
            return None  # hard guard, never reachable with server-side auth
        return row


def list_connections(telegram_id: int) -> list:
    base, _ = supabase_client._config()
    with httpx.Client(timeout=supabase_client._TIMEOUT) as client:
        res = client.get(
            f"{base}/rest/v1/private_connections",
            params={"select": "provider,account_name,updated_at",
                    "telegram_chat_id": f"eq.{telegram_id}"},
            headers=supabase_client._auth_headers(),
        )
        supabase_client._raise_for(res, "private_connections.list")
        return res.json()


def upsert_connection(telegram_id: int, provider: str, account_name: str,
                      secret_name: str, extra: dict = None) -> dict:
    """Create/update a connection row after a successful OAuth flow."""
    base, _ = supabase_client._config()
    payload = {
        "telegram_chat_id": telegram_id,
        "provider": provider,
        "account_name": account_name,
        "secret_name": secret_name,
        "extra": extra or {},
    }
    with httpx.Client(timeout=supabase_client._TIMEOUT) as client:
        res = client.post(
            f"{base}/rest/v1/private_connections",
            json=payload,
            params={"on_conflict": "telegram_chat_id,provider"},
            headers={**_auth_headers_post(), "Prefer": "resolution=merge-duplicates,return=representation"},
        )
        supabase_client._raise_for(res, "private_connections.upsert")
        return res.json()[0]


# ------------------------------------------------------------------
# Rate limiting (autonomous-trigger safety valve)
# ------------------------------------------------------------------
def disconnect_connection(telegram_id: int, provider: str) -> bool:
    """Delete a user's own connection row (and best-effort Vault secret)."""
    base, _ = supabase_client._config()
    row = get_connection(telegram_id, provider)
    if not row:
        return False
    try:
        from utils import vault
        vault.delete_secret(row.get("secret_name", ""))
    except Exception:
        pass
    with httpx.Client(timeout=supabase_client._TIMEOUT) as client:
        res = client.delete(
            f"{base}/rest/v1/private_connections",
            params={"id": f"eq.{row['id']}", "telegram_chat_id": f"eq.{telegram_id}"},
            headers=supabase_client._auth_headers(),
        )
        return res.status_code < 400


def _auth_headers_post():
    return supabase_client._auth_headers()


def check_rate_limit(telegram_id: int, provider: str,
                     window_seconds: int = 3600, limit: int = 20) -> dict:
    """
    Sliding-window quota per (user, provider). Returns {allowed, remaining}.
    Throttles runaway autonomous triggers before they burn provider quota
    or money.
    """
    base, _ = supabase_client._config()
    now = datetime.datetime.utcnow()
    cutoff = (now - datetime.timedelta(seconds=window_seconds)).isoformat()
    try:
        with httpx.Client(timeout=supabase_client._TIMEOUT) as client:
            # Count calls in the current window.
            res = client.get(
                f"{base}/rest/v1/private_usage",
                params={"select": "calls",
                        "telegram_chat_id": f"eq.{telegram_id}",
                        "provider": f"eq.{provider}",
                        "window_start": f"gte.{cutoff}",
                        "limit": "0"},
                headers={**_auth_headers_post(), "Prefer": "count=exact"},
            )
            if res.status_code >= 400:
                return {"allowed": True, "remaining": 1}  # fail-open safe
            cr = res.headers.get("content-range", "*/0")
            try:
                row_count = int(cr.split("/")[1])
            except Exception:
                row_count = 0

            if row_count == 0:
                # Open a fresh window.
                client.post(
                    f"{base}/rest/v1/private_usage",
                    json=[{"telegram_chat_id": telegram_id,
                           "provider": provider, "window_start": now.isoformat(),
                           "calls": 1}],
                    headers={**_auth_headers_post(), "Prefer": "return=minimal"},
                )
                return {"allowed": True, "remaining": limit - 1}

            # Fetch the active window's call count.
            res = client.get(
                f"{base}/rest/v1/private_usage",
                params={"select": "calls",
                        "telegram_chat_id": f"eq.{telegram_id}",
                        "provider": f"eq.{provider}",
                        "window_start": f"gte.{cutoff}",
                        "order": "window_start.desc", "limit": "1"},
                headers=_auth_headers_post(),
            )
            if res.status_code >= 400:
                return {"allowed": True, "remaining": 1}
            rows = res.json()
            calls = rows[0]["calls"] if rows else 0
            if calls >= limit:
                return {"allowed": False, "remaining": 0}
            client.patch(
                f"{base}/rest/v1/private_usage",
                params={"id": f"eq.{rows[0]['id']}"},
                json={"calls": max(calls + 1, 1)},
                headers=_auth_headers_post(),
            )
            return {"allowed": True, "remaining": limit - (calls + 1)}
    except Exception:
        return {"allowed": True, "remaining": 1}
"""
Per-user preferences stored in Supabase `profiles.preferences` (JSONB).

Fail-closed: every helper returns without raising so a transient profile
table issue never crashes the orchestrator/cron pipeline.
"""
import datetime
import httpx

from utils.supabase_client import _config, _auth_headers

_TIMEOUT = 20.0


def _profiles_url():
    base, _ = _config()
    return f"{base}/rest/v1/profiles"


def get_city(telegram_id: int) -> str:
    """The user's saved city, or '' if never set / lookup failed."""
    try:
        with httpx.Client(timeout=_TIMEOUT) as client:
            r = client.get(
                _profiles_url(),
                params={"select": "preferences",
                        "telegram_id": f"eq.{telegram_id}", "limit": "1"},
                headers=_auth_headers(),
            )
            r.raise_for_status()
        rows = r.json()
        if not rows:
            return ""
        prefs = rows[0].get("preferences") or {}
        if not isinstance(prefs, dict):
            return ""
        return str(prefs.get("city", "")).strip()
    except Exception:
        return ""


def set_city(telegram_id: int, city: str) -> dict:
    """Save the user's city (creating the profile row if absent)."""
    city = (city or "").strip()
    if not city:
        return {"success": False, "error": "Nama kota tidak boleh kosong."}
    if len(city) > 80:
        return {"success": False, "error": "Nama kota terlalu panjang."}
    try:
        with httpx.Client(timeout=_TIMEOUT) as client:
            r = client.get(
                _profiles_url(),
                params={"select": "id,preferences",
                        "telegram_id": f"eq.{telegram_id}", "limit": "1"},
                headers=_auth_headers(),
            )
            r.raise_for_status()
            rows = r.json()
            prefs = {}
            if rows:
                existing = rows[0].get("preferences") or {}
                if isinstance(existing, dict):
                    prefs = dict(existing)
            else:
                client.post(
                    _profiles_url(),
                    json={"telegram_id": telegram_id, "preferences": {}},
                    headers={**_auth_headers(), "Prefer": "return=minimal"},
                )
            prefs["city"] = city
            p = client.patch(
                _profiles_url(),
                params={"telegram_id": f"eq.{telegram_id}"},
                json={"preferences": prefs,
                      "updated_at": datetime.datetime.utcnow().isoformat()},
                headers={**_auth_headers(), "Prefer": "return=minimal"},
            )
            if p.status_code >= 400:
                return {"success": False,
                        "error": f"Gagal menyimpan kota: HTTP {p.status_code}"}
        return {"success": True, "city": city}
    except Exception as exc:
        return {"success": False, "error": f"Gagal menyimpan kota: {exc}"}
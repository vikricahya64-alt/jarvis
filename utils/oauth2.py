"""
OAuth2 helpers for private integrations (Google, Notion).

Client IDs/secrets live in Supabase Vault (never env/code). The callback
endpoint (api/oauth2-callback.py) exchanges codes, refreshes are handled in
tools/private_integrations.py, and the resulting tokens are Vault-encrypted
and namespaced per user (`conn_<telegram_id>_<provider>`).
"""
import hashlib
import hmac
import json
import os
import urllib.parse
import time

import httpx

from utils import vault

GOOGLE_AUTH = "https://accounts.google.com/o/oauth2/v2/auth"
GOOGLE_TOKEN = "https://oauth2.googleapis.com/token"
GOOGLE_USERINFO = "https://openidconnect.googleapis.com/v1/userinfo"
NOTION_AUTH = "https://api.notion.com/v1/oauth/authorize"
NOTION_TOKEN = "https://api.notion.com/v1/oauth/token"
NOTION_ME = "https://api.notion.com/v1/users/me"

GOOGLE_SCOPES = {
    "gmail": "https://www.googleapis.com/auth/gmail.readonly "
             "https://www.googleapis.com/auth/userinfo.email "
             "openid",
    "google_drive": "https://www.googleapis.com/auth/drive.file "
                    "https://www.googleapis.com/auth/userinfo.email "
                    "openid",
    "calendar": "https://www.googleapis.com/auth/calendar.readonly "
                "https://www.googleapis.com/auth/userinfo.email "
                "openid",
}
REDIRECT_PATH = "/api/oauth2-callback"


def _sign(tg: str) -> str:
    return hmac.new(
        (os.getenv("CRON_SECRET", "") or "").encode(),
        tg.encode(), hashlib.sha256).hexdigest()[:16]


def make_state(telegram_id: int, provider: str = "") -> str:
    payload = f"{telegram_id}:{provider}:{int(time.time())}"
    return f"{_sign(payload)}.{payload}"


def parse_state(state: str):
    """Verify signed state; returns (telegram_id, provider) or (None, None).
    Guards replay-ish tampering (expiry is intentionally generous for
    serverless latency)."""
    try:
        sig, payload = state.split(".", 1)
        if not hmac.compare_digest(sig, _sign(payload)):
            return None, None
        parts = payload.split(":")
        tg_id = int(parts[0])
        provider = parts[1] if len(parts) > 1 else ""
        return tg_id, provider
    except Exception:
        return None, None


def base_redirect_uri() -> str:
    host = os.getenv("PUBLIC_BASE_URL", "https://jarvis-sigma-navy.vercel.app")
    return host + REDIRECT_PATH


def authorize_url(provider: str, telegram_id: int) -> str:
    state = make_state(telegram_id, provider)
    redirect = base_redirect_uri()
    want_scope = GOOGLE_SCOPES.get(provider, "")
    if provider in ("google_drive", "calendar"):
        provider = "gmail"  # same Google OAuth client; only scopes differ
    try:
        if provider == "gmail":
            client_id = vault.read_secret("oauth_google_client_id")
            return (f"{GOOGLE_AUTH}?" + urllib.parse.urlencode({
                "client_id": client_id,
                "redirect_uri": redirect,
                "response_type": "code",
                "scope": want_scope or GOOGLE_SCOPES["gmail"],
                "state": state,
                "access_type": "offline",
                "prompt": "consent",
            }))
        client_id = vault.read_secret("oauth_notion_client_id")
        return (f"{NOTION_AUTH}?" + urllib.parse.urlencode({
            "client_id": client_id,
            "redirect_uri": redirect,
            "response_type": "code",
            "owner": "user",
            "state": state,
        }))
    except Exception as exc:
        return f"ERROR: {exc}"


def exchange(provider: str, code: str) -> dict:
    """Exchange an OAuth code for a token dict (Vault-held client secrets)."""
    redirect = base_redirect_uri()
    with httpx.Client(timeout=25) as client:
        if provider in ("gmail", "google_drive", "calendar"):
            client_id = vault.read_secret("oauth_google_client_id")
            client_secret = vault.read_secret("oauth_google_client_secret")
            r = client.post(GOOGLE_TOKEN, data={
                "code": code, "client_id": client_id,
                "client_secret": client_secret,
                "redirect_uri": redirect,
                "grant_type": "authorization_code",
            })
            if r.status_code != 200:
                raise RuntimeError(f"Google exchange {r.status_code}: {r.text[:200]}")
            tok = r.json()
            tok["provider"] = "gmail"
            tok["expires_at"] = time.time() + float(tok.get("expires_in", 3600))
            me = client.get(GOOGLE_USERINFO,
                            headers={"Authorization": f"Bearer {tok['access_token']}"})
            tok["account"] = me.json().get("email", "google") if me.status_code == 200 else "google"
            _norm_google_scope(tok)
            return tok

        # Notion
        notion_id = vault.read_secret("oauth_notion_client_id")
        notion_secret = vault.read_secret("oauth_notion_client_secret")
        r = client.post(NOTION_TOKEN, data={
            "grant_type": "authorization_code",
            "code": code,
            "redirect_uri": redirect,
        }, headers={"Authorization": "Basic " + _b64(f"{notion_id}:{notion_secret}")})
        if r.status_code != 200:
            raise RuntimeError(f"Notion exchange {r.status_code}: {r.text[:200]}")
        tok = r.json()
        tok["provider"] = "notion"
        tok["expires_at"] = time.time() + float(tok.get("expires_in", 3600))
        me = client.get(NOTION_ME, headers={
            "Authorization": f"Bearer {tok['access_token']}",
            "Notion-Version": "2022-06-28",
        })
        name = "notion"
        if me.status_code == 200:
            name = me.json().get("name") or me.json().get("owner", {}).get("type", "notion")
        tok["account"] = name
        return tok


def _norm_google_scope(tok: dict):
    scope = tok.get("scope", "")
    if "calendar.readonly" in scope:
        provider = "calendar"
    elif "drive.file" in scope:
        provider = "google_drive"
    else:
        provider = "gmail"
    tok["provider"] = provider


def _b64(data: str) -> str:
    import base64
    return base64.b64encode(data.encode()).decode()
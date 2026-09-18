"""
Private environment integrations (Gmail, Google Drive, Notion).

Security rules enforced here (see also utils/authz.py):
  1. The caller passes the task owner's `telegram_chat_id` from the
     orchestrator — never from model arguments.
  2. A `private_connections` row for (telegram_chat_id, provider) must exist
     before any token is decrypted (ownership check).
  3. The credential is decrypted from Supabase Vault at call time and is
     never stored in code, cached on disk, or logged.
  4. Per-(user, provider) rate limiting guards autonomous triggers.

OAuth tokens are stored in Vault as JSON:
   {"access_token": "...", "refresh_token": "...", "expires_at": 1234567890}
"""
import datetime
import json
import logging

import httpx

from utils import authz, vault, supabase_client

logger = logging.getLogger("private_integrations")

_GOOGLE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token"
_GOOGLE_APIS = {
    "gmail": "https://gmail.googleapis.com/gmail/v1",
    "google_drive": "https://www.googleapis.com/drive/v3",
    "calendar": "https://www.googleapis.com/calendar/v3",
}
_NOTION_API = "https://api.notion.com/v1"


# ------------------------------------------------------------------
# Token helpers (Vault-backed)
# ------------------------------------------------------------------
def _load_token(connection) -> dict:
    secret_name = connection["secret_name"]
    raw = vault.read_secret(secret_name)
    data = json.loads(raw) if raw else {}
    if not data.get("access_token"):
        raise RuntimeError("token tidak ditemukan di Vault")
    return data


def _token_expired(token: dict) -> bool:
    exp = token.get("expires_at")
    return bool(exp) and float(exp) < (datetime.datetime.utcnow().timestamp() + 120)


def _refresh_google_token(connection, token: dict) -> dict:
    """Refresh a Gmail/Drive access_token via Vault-held OAuth client id/secret."""
    try:
        client_id = vault.read_secret("oauth_google_client_id")
        client_secret = vault.read_secret("oauth_google_client_secret")
    except Exception:
        raise RuntimeError("OAuth2 client secret tidak ada di Vault (lihat setup)")
    refresh = token.get("refresh_token")
    if not refresh:
        raise RuntimeError("tidak ada refresh_token; hubungkan ulang via /login")
    r = httpx.post(
        _GOOGLE_TOKEN_ENDPOINT,
        data={
            "client_id": client_id,
            "client_secret": client_secret,
            "refresh_token": refresh,
            "grant_type": "refresh_token",
        },
        timeout=20,
    )
    if r.status_code != 200:
        raise RuntimeError(f"refresh token gagal: {r.text[:150]}")
    data = r.json()
    token["access_token"] = data["access_token"]
    if data.get("expires_in"):
        token["expires_at"] = (datetime.datetime.utcnow().timestamp()
                               + float(data["expires_in"]))
    vault.write_secret(connection["secret_name"], json.dumps(token))
    return token


def _google_headers(connection) -> dict:
    token = _load_token(connection)
    if _token_expired(token):
        token = _refresh_google_token(connection, token)
    return {"Authorization": f"Bearer {token['access_token']}"}


def _notion_headers(connection) -> dict:
    token = _load_token(connection)
    version = connection.get("extra", {}).get("notion_version") or "2022-06-28"
    return {
        "Authorization": f"Bearer {token['access_token']}",
        "Notion-Version": version,
    }


# ------------------------------------------------------------------
# Guard used by all tools
# ------------------------------------------------------------------
def _guard(telegram_id: int, provider: str):
    """Ownership + rate-limit check. Returns connection on success."""
    conn = authz.get_connection(telegram_id, provider)
    if not conn:
        return {"error": (
            f"Akun {provider} belum terhubung. Ketik /login {provider} "
            "untuk menyambungkannya secara aman.")}
    quota = authz.check_rate_limit(telegram_id, provider)
    if not quota.get("allowed"):
        return {"error": (
            f"Batas pemakaian {provider} tercapai (kuota per jam). "
            "Coba lagi nanti.")}
    return conn


# ------------------------------------------------------------------
# Tool: READ GMAIL
# ------------------------------------------------------------------
def read_gmail(telegram_id: int, query: str = "", max_results: int = 5) -> dict:
    conn = _guard(telegram_id, "gmail")
    if isinstance(conn, dict) and conn.get("error"):
        return conn
    try:
        headers = _google_headers(conn)
        with httpx.Client(timeout=25) as client:
            r = client.get(
                f"{_GOOGLE_APIS['gmail']}/users/me/messages",
                params={"q": query or "", "maxResults": max(1, min(max_results, 10))},
                headers=headers,
            )
            if r.status_code != 200:
                return {"error": f"Gmail API {r.status_code}: {r.text[:200]}"}
            ids = [m["id"] for m in r.json().get("messages", [])]

        items = []
        for mid in ids[:5]:
            with httpx.Client(timeout=25) as client:
                rr = client.get(
                    f"{_GOOGLE_APIS['gmail']}/users/me/messages/{mid}",
                    params={"format": "metadata",
                            "metadataHeaders": "Subject,From,Date"},
                    headers=headers,
                )
            if rr.status_code != 200:
                continue
            meta = rr.json()
            hdrs = {h["name"].lower(): h["value"] for h in meta.get("payload", {}).get("headers", [])}
            items.append({
                "id": mid,
                "from": hdrs.get("from", ""),
                "subject": hdrs.get("subject", ""),
                "date": hdrs.get("date", ""),
                "snippet": (meta.get("snippet") or "")[:220],
            })
        return {"success": True, "count": len(items), "messages": items}
    except Exception as exc:
        logger.exception("read_gmail failed")
        return {"error": str(exc)[:200]}


# ------------------------------------------------------------------
# Tool: UPLOAD TO GOOGLE DRIVE
# ------------------------------------------------------------------
def upload_to_drive(telegram_id: int, filename: str, content: str) -> dict:
    conn = _guard(telegram_id, "google_drive")
    if isinstance(conn, dict) and conn.get("error"):
        return conn
    try:
        headers = _google_headers(conn)
        meta = {"name": filename or "file.txt",
                "mimeType": "text/plain"}
        data = (content or "").encode("utf-8")
        # Resumable upload: create the file, then push raw media bytes.
        with httpx.Client(timeout=30) as client:
            r = client.post(
                f"{_GOOGLE_APIS['google_drive']}/files?uploadType=resumable",
                headers={**headers, "X-Upload-Content-Type": "text/plain"},
                json=meta,
            )
            if r.status_code not in (200, 201):
                return {"error": f"Drive API {r.status_code}: {r.text[:200]}"}
            upload_uri = r.headers.get("Location")
            if not upload_uri:
                return {"error": "Drive: upload URI kosong"}
            r2 = client.put(upload_uri, content=data,
                            headers={"Content-Type": "text/plain"})
            file_id = r2.json().get("id")
        return {"success": True, "file_id": file_id,
                "name": filename or "file.txt",
                "view_url": f"https://drive.google.com/file/d/{file_id}/view"}
    except Exception as exc:
        logger.exception("upload_to_drive failed")
        return {"error": str(exc)[:200]}


# ------------------------------------------------------------------
# Tool: GET CALENDAR EVENTS
# ------------------------------------------------------------------
def get_calendar_events(telegram_id: int, days: int = 7,
                        max_results: int = 10) -> dict:
    conn = _guard(telegram_id, "calendar")
    if isinstance(conn, dict) and conn.get("error"):
        return conn
    try:
        headers = _google_headers(conn)
        time_min = datetime.datetime.utcnow().isoformat() + "Z"
        time_max = (datetime.datetime.utcnow()
                    + datetime.timedelta(days=max(1, min(days, 30)))
                    ).isoformat() + "Z"
        with httpx.Client(timeout=25) as client:
            r = client.get(
                f"{_GOOGLE_APIS['calendar']}/calendars/primary/events",
                params={
                    "timeMin": time_min,
                    "timeMax": time_max,
                    "maxResults": max(1, min(max_results, 20)),
                    "singleEvents": "true",
                    "orderBy": "startTime",
                },
                headers=headers,
            )
            if r.status_code != 200:
                return {"error": f"Calendar API {r.status_code}: {r.text[:200]}"}
        items = []
        for ev in r.json().get("items", []):
            when = ev.get("start", {}).get("dateTime") or ev.get("start", {}).get("date")
            items.append({
                "summary": ev.get("summary", "(tanpa judul)"),
                "when": when,
                "where": ev.get("location", ""),
                "link": ev.get("htmlLink", ""),
            })
        return {"success": True, "count": len(items), "days": days, "events": items}
    except Exception as exc:
        logger.exception("get_calendar_events failed")
        return {"error": str(exc)[:200]}


# ------------------------------------------------------------------
# Tool: QUERY NOTION
# ------------------------------------------------------------------
def query_notion(telegram_id: int, query: str = "", limit: int = 5) -> dict:
    conn = _guard(telegram_id, "notion")
    if isinstance(conn, dict) and conn.get("error"):
        return conn
    try:
        headers = _notion_headers(conn)
        payload = {"page_size": min(max(limit, 1), 10)}
        if query.strip():
            payload["query"] = query.strip()
        with httpx.Client(timeout=25) as client:
            r = client.post(f"{_NOTION_API}/search", json=payload, headers=headers)
            if r.status_code != 200:
                return {"error": f"Notion API {r.status_code}: {r.text[:200]}"}
        pages = r.json().get("results", [])
        items = []
        for p in pages:
            props = p.get("properties", {}) if p.get("object") == "page" else {}
            title_hint = ""
            for key in ("title", "Name", "name"):
                if key in props:
                    parts = props[key].get("title") or []
                    title_hint = " ".join(t.get("plain_text", "") for t in parts)
                    break
            items.append({
                "id": p.get("id"),
                "type": p.get("object"),
                "title": title_hint or props.get("Name") or p.get("url", ""),
                "url": p.get("url", ""),
            })
        return {"success": True, "count": len(items), "results": items}
    except Exception as exc:
        logger.exception("query_notion failed")
        return {"error": str(exc)[:200]}


# ------------------------------------------------------------------
# Dispatch used by the orchestrator (telegram_id injected server-side)
# ------------------------------------------------------------------
def dispatch_private(name: str, args: dict, telegram_id: int) -> dict:
    if not telegram_id:
        return {"error": "perlu identitas pengguna"}
    if name == "read_gmail":
        return read_gmail(telegram_id, args.get("query", ""),
                          args.get("max_results", 5))
    if name == "upload_to_drive":
        return upload_to_drive(telegram_id, args.get("filename", "file.txt"),
                               args.get("content", ""))
    if name == "query_notion":
        return query_notion(telegram_id, args.get("query", ""),
                            args.get("limit", 5))
    if name == "get_calendar_events":
        return get_calendar_events(telegram_id,
                                   args.get("days", 7),
                                   args.get("max_results", 10))
    return {"error": f"private tool tak dikenal: {name} | "
                     f"tabel belum dibuat? cek sql/autonomy_schema.sql"}
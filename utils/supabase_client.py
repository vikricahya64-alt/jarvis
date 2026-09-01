"""
Supabase client wrapper: database access + storage upload for artifacts.

Uses the service-role key server-side so the orchestrator can manage
tasks, store chat history, and upload generated files to the Storage bucket.

Implemented with plain httpx calls against the PostgREST REST API. The
official `supabase` SDK's connection pool raises `[Errno 16] Device or
resource busy` inside Vercel serverless, even when everything else (httpx
to Telegram) works fine — so we bypass the SDK entirely.
"""
import os
import base64
import httpx

_SUPABASE_URL = None
_SUPABASE_KEY = None
_TIMEOUT = httpx.Timeout(25)


def _config():
    global _SUPABASE_URL, _SUPABASE_KEY
    if _SUPABASE_URL is None:
        url = (os.getenv("SUPABASE_URL") or "").rstrip("/")
        key = os.getenv("SUPABASE_SERVICE_KEY") or os.getenv("SUPABASE_KEY")
        if not url or not key:
            raise RuntimeError("SUPABASE_URL and SUPABASE_KEY are required")
        _SUPABASE_URL = url
        _SUPABASE_KEY = key
    return _SUPABASE_URL, _SUPABASE_KEY


def _auth_headers(content_type: str = "application/json") -> dict:
    _, key = _config()
    return {
        "apikey": key,
        "Authorization": f"Bearer {key}",
        "Content-Type": content_type,
    }


def _raise_for(response: httpx.Response, ctx: str):
    if response.status_code >= 400:
        raise RuntimeError(f"Supabase {ctx} -> HTTP {response.status_code}: {response.text[:300]}")


# ------------------------------------------------------------------
# Profiles
# ------------------------------------------------------------------
def get_or_create_profile(telegram_id: int, username=None, first_name=None):
    """Fetch or create a profile for a Telegram user."""
    base, _ = _config()
    with httpx.Client(timeout=_TIMEOUT) as client:
        res = client.get(
            f"{base}/rest/v1/profiles",
            params={"select": "*", "telegram_id": f"eq.{telegram_id}"},
            headers=_auth_headers(),
        )
        _raise_for(res, "profiles.select")
        rows = res.json()

        if rows:
            return rows[0]

        payload = {
            "telegram_id": telegram_id,
            "username": username,
            "first_name": first_name,
        }
        res = client.post(
            f"{base}/rest/v1/profiles",
            json=payload,
            headers={**_auth_headers(), "Prefer": "return=representation"},
        )
        _raise_for(res, "profiles.insert")
        return res.json()[0]


# ------------------------------------------------------------------
# Tasks (event-driven queue)
# ------------------------------------------------------------------
def insert_task(telegram_id: int, input_text: str, profile_id=None) -> str:
    """Insert a new PENDING task; returns the task id (UUID)."""
    base, _ = _config()
    payload = {"telegram_id": telegram_id, "input": input_text}
    if profile_id:
        payload["profile_id"] = profile_id
    with httpx.Client(timeout=_TIMEOUT) as client:
        res = client.post(
            f"{base}/rest/v1/tasks",
            json=payload,
            headers={**_auth_headers(), "Prefer": "return=representation"},
        )
        _raise_for(res, "tasks.insert")
        return res.json()[0]["id"]


def update_task(task_id: str, updates: dict):
    """Update a task row (status, result, error, etc.)."""
    base, _ = _config()
    updates.setdefault("updated_at", datetime.datetime.utcnow().isoformat())
    with httpx.Client(timeout=_TIMEOUT) as client:
        res = client.patch(
            f"{base}/rest/v1/tasks",
            params={"id": f"eq.{task_id}"},
            json=updates,
            headers=_auth_headers(),
        )
        _raise_for(res, "tasks.update")


def claim_next_pending():
    """
    Atomically claim the oldest PENDING task and mark it PROCESSING.
    Returns the task dict, or None if there is nothing to process.
    """
    base, _ = _config()
    with httpx.Client(timeout=_TIMEOUT) as client:
        # 1. Find the oldest PENDING task.
        res = client.get(
            f"{base}/rest/v1/tasks",
            params={
                "select": "*",
                "status": "eq.PENDING",
                "order": "created_at.asc",
                "limit": "1",
            },
            headers=_auth_headers(),
        )
        _raise_for(res, "tasks.pending.select")
        rows = res.json()
        if not rows:
            return None

        task = rows[0]

        # 2. Claim it: only transition if still PENDING (guards double-claim).
        res = client.patch(
            f"{base}/rest/v1/tasks",
            params={"id": f"eq.{task['id']}", "status": "eq.PENDING"},
            json={"status": "PROCESSING"},
            headers=_auth_headers(),
        )
        _raise_for(res, "tasks.claim")
        task["status"] = "PROCESSING"
        return task


# ------------------------------------------------------------------
# Chat history (for RAG context)
# ------------------------------------------------------------------
def insert_chat(telegram_id: int, role: str, content: str):
    """Insert a message into chat_history."""
    profile = get_or_create_profile(telegram_id)
    base, _ = _config()
    payload = {
        "telegram_id": telegram_id,
        "profile_id": profile["id"],
        "role": role,
        "content": content,
    }
    with httpx.Client(timeout=_TIMEOUT) as client:
        res = client.post(
            f"{base}/rest/v1/chat_history",
            json=payload,
            headers={**_auth_headers(), "Prefer": "return=minimal"},
        )
        _raise_for(res, "chat_history.insert")


def get_recent_history(telegram_id: int, limit: int = 10):
    """Fetch recent chat history for context injection."""
    base, _ = _config()
    with httpx.Client(timeout=_TIMEOUT) as client:
        res = client.get(
            f"{base}/rest/v1/chat_history",
            params={
                "select": "role,content",
                "telegram_id": f"eq.{telegram_id}",
                "order": "created_at.desc",
                "limit": str(limit),
            },
            headers=_auth_headers(),
        )
        _raise_for(res, "chat_history.select")
        rows = res.json()
        return list(reversed(rows))


# ------------------------------------------------------------------
# Storage: upload artifact files
# ------------------------------------------------------------------
def upload_artifact(filename: str, data_b64: str, mime: str) -> str:
    """
    Upload a base64-encoded file to the 'artifacts' storage bucket.
    Returns the public URL.
    """
    base, _ = _config()
    raw = base64.b64decode(data_b64)
    with httpx.Client(timeout=_TIMEOUT) as client:
        res = client.put(
            f"{base}/storage/v1/object/artifacts/{filename}",
            content=raw,
            headers={**_auth_headers(mime), "x-upsert": "true"},
        )
        _raise_for(res, "storage.upload")
        return f"{base}/storage/v1/object/public/artifacts/{filename}"
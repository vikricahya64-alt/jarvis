"""
Supabase client wrapper: database access + storage upload for artifacts.

Uses the service-role key server-side so the orchestrator can manage
tasks, store chat history, and upload generated files to the Storage bucket.
Synchronous implementation (the Supabase/PostgREST SDK is sync) to avoid
event-loop conflicts inside Vercel serverless functions.
"""
import os
import base64
import datetime
from supabase import create_client, Client

_supabase: Client | None = None


def get_client() -> Client:
    """Lazily initialize the Supabase client (service role)."""
    global _supabase
    if _supabase is None:
        url = os.getenv("SUPABASE_URL")
        key = os.getenv("SUPABASE_SERVICE_KEY") or os.getenv("SUPABASE_KEY")
        if not url or not key:
            raise RuntimeError("SUPABASE_URL and SUPABASE_KEY are required")
        _supabase = create_client(url, key)
    return _supabase


# ------------------------------------------------------------------
# Profiles
# ------------------------------------------------------------------
def get_or_create_profile(telegram_id: int, username=None, first_name=None):
    """Fetch or create a profile for a Telegram user."""
    client = get_client()
    res = client.table("profiles") \
        .select("*").eq("telegram_id", telegram_id).execute()
    rows = res.data

    if rows:
        return rows[0]

    payload = {
        "telegram_id": telegram_id,
        "username": username,
        "first_name": first_name,
    }
    res = client.table("profiles").insert(payload).execute()
    return res.data[0]


# ------------------------------------------------------------------
# Tasks (event-driven queue)
# ------------------------------------------------------------------
def insert_task(telegram_id: int, input_text: str, profile_id=None) -> str:
    """Insert a new PENDING task; returns the task id (UUID)."""
    client = get_client()
    payload = {"telegram_id": telegram_id, "input": input_text}
    if profile_id:
        payload["profile_id"] = profile_id
    res = client.table("tasks").insert(payload).execute()
    return res.data[0]["id"]


def update_task(task_id: str, updates: dict):
    """Update a task row (status, result, error, etc.)."""
    client = get_client()
    updates.setdefault("updated_at", datetime.datetime.utcnow().isoformat())
    client.table("tasks").update(updates).eq("id", task_id).execute()


# ------------------------------------------------------------------
# Chat history (for RAG context)
# ------------------------------------------------------------------
def insert_chat(telegram_id: int, role: str, content: str):
    """Insert a message into chat_history."""
    profile = get_or_create_profile(telegram_id)
    client = get_client()
    client.table("chat_history").insert({
        "telegram_id": telegram_id,
        "profile_id": profile["id"],
        "role": role,
        "content": content,
    }).execute()


def get_recent_history(telegram_id: int, limit: int = 10):
    """Fetch recent chat history for context injection."""
    client = get_client()
    res = client.table("chat_history") \
        .select("role,content") \
        .eq("telegram_id", telegram_id) \
        .order("created_at", desc=True) \
        .limit(limit) \
        .execute()
    return list(reversed(res.data))


# ------------------------------------------------------------------
# Storage: upload artifact files
# ------------------------------------------------------------------
def upload_artifact(filename: str, data_b64: str, mime: str) -> str:
    """
    Upload a base64-encoded file to the 'artifacts' storage bucket.
    Returns the public URL.
    """
    client = get_client()
    raw = base64.b64decode(data_b64)
    client.storage.from_("artifacts").upload(
        filename, raw, {"content-type": mime}
    )
    return client.storage.from_("artifacts").get_public_url(filename)
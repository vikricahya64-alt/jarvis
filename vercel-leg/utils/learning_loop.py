"""
Active learning loop.

After each completed task the orchestrator runs a cheap "reflection": Groq
analyses (user message, tools used, final reply) and extracts durable,
explicit preferences/corrections (e.g. "selalu jangkau ringkas",
"pakai IDR untuk laporan"). Those are stored per-user and injected into the
next task's system prompt via pg_trgm similarity matching — no embedding API
required, consistent with the project's knowledge-base approach.

Everything degrades gracefully when the autonomy tables are missing.
"""
import json
import logging
import re
import httpx

from utils import supabase_client

logger = logging.getLogger("learning_loop")

REFLECTION_LIMIT = 3  # max durable preferences captured per reflection
RETRIEVAL_LIMIT = 4   # max preferences injected per task


def _normalize(text: str) -> str:
    return re.sub(r"\s+", " ", (text or "")).strip().lower()


# ------------------------------------------------------------------
# Store
# ------------------------------------------------------------------
def store_preference(telegram_id: int, preference: str,
                     category: str = "general",
                     source: str = "learned") -> dict:
    """Upsert a learned preference for a user (deduped, idempotent)."""
    pref = _normalize(preference).strip(".-")
    if len(pref) < 4:
        return {"success": False, "error": "terlalu pendek"}
    base, _ = supabase_client._config()
    with httpx.Client(timeout=supabase_client._TIMEOUT) as client:
        headers = supabase_client._auth_headers()
        # Dedupe: exact normalized match already active?
        res = client.get(
            f"{base}/rest/v1/user_preferences",
            params={"select": "id",
                    "telegram_chat_id": f"eq.{telegram_id}",
                    "preference": f"ilike.{pref}",
                    "is_active": "eq.true",
                    "limit": "1"},
            headers=headers,
        )
        if res.status_code == 404:
            return {"success": False, "error": "tabel belum dibuat (jalankan SQL)"}
        supabase_client._raise_for(res, "user_preferences.select")
        if res.json():
            return {"success": True, "note": "sudah ada"}

        res = client.post(
            f"{base}/rest/v1/user_preferences",
            json=[{"telegram_chat_id": telegram_id,
                   "preference": pref, "category": category,
                   "source": source}],
            headers={**headers, "Prefer": "return=minimal"},
        )
        if res.status_code == 404:
            return {"success": False, "error": "tabel belum dibuat (jalankan SQL)"}
        supabase_client._raise_for(res, "user_preferences.insert")
        return {"success": True}


# ------------------------------------------------------------------
# Retrieve (semantic-ish, pg_trgm)
# ------------------------------------------------------------------
def retrieve_preferences(telegram_id: int, query: str,
                         limit: int = RETRIEVAL_LIMIT) -> list:
    """Top preference rows for a user matching the current task text."""
    base, _ = supabase_client._config()
    try:
        with httpx.Client(timeout=supabase_client._TIMEOUT) as client:
            res = client.post(
                f"{base}/rest/v1/rpc/match_user_preferences",
                json={"p_telegram_chat_id": telegram_id,
                      "p_query": query, "p_limit": limit},
                headers=supabase_client._auth_headers(),
            )
            if res.status_code == 404:
                return []
            supabase_client._raise_for(res, "rpc.match_user_preferences")
            return res.json()
    except Exception as exc:
        logger.debug(f"preference retrieval skipped: {exc}")
        return []


def build_preference_block(telegram_id: int, user_input: str) -> str:
    """Human-readable block of learned preferences for the system prompt."""
    rows = retrieve_preferences(telegram_id, user_input)
    if not rows:
        return ""
    lines = ["[Adaptasi dari preferensi pengguna yang pernah dipelajari "
             "(ikuti bila relevan)]"]
    lines += [f"- {r.get('preference', '')}" for r in rows]
    return "\n".join(lines)


# ------------------------------------------------------------------
# Reflection (run after each task completes)
# ------------------------------------------------------------------
def reflect(telegram_id: int, user_input: str, final_text: str,
            tool_names: list, system_prompt_extra: str = "") -> list:
    """
    Ask Groq to extract durable preferences/corrections from the turn.
    Returns a list of preference strings (deduped) already stored.
    """
    try:
        from utils.groq_client import sync_completion
        prompt = (
            "Tugas refleksi singkat. Dari percakapan AI-user berikut, "
            "ekstrak 0–2 perilaku/preferensi yang JELAS dan DURABLE "
            "(mis. 'laporan selalu ringkas', 'pakai IDR', 'hindari kode'). "
            f"JANGAN menambahkan preferensi yang tidak eksplisit di "
            f"percakapan. Keluarkan HANYA JSON array string.\n\n"
            f"PESAN USER: {user_input[:800]}\n"
            f"TOOLS DIPAKAI: {', '.join(tool_names) or '-'}\n"
            f"JAWABAN AI: {final_text[:1200]}"
        )
        from utils.groq_client import _over_deadline
        if _over_deadline():
            return []
        response = sync_completion(
            prompt,
            system_prompt=("You are a conservative preference extractor. "
                           "Output only a JSON array of strings, each under "
                           "160 chars, in the user's language. If unsure, []."),
            tool_choice="none",
        )
        content = (response.choices[0].message.content or "").strip()
        prefs = _parse_preferences(content)
    except Exception as exc:
        logger.debug(f"reflection skipped: {exc}")
        return []

    stored = []
    for pref in prefs[:REFLECTION_LIMIT]:
        try:
            store_preference(telegram_id, pref, source="learned")
            stored.append(pref)
        except Exception as exc:
            logger.debug(f"preference store skipped: {exc}")
    return stored


def _parse_preferences(content: str) -> list:
    """Best-effort JSON-array / bullet extraction from a model reply."""
    m = re.search(r"\[.*?\]", content, re.S)
    if m:
        try:
            data = json.loads(m.group(0))
            if isinstance(data, list):
                return [str(x).strip() for x in data if str(x).strip()]
        except Exception:
            pass
    lines = [re.sub(r"^[\s*\-•]+", "", ln) for ln in content.splitlines()]
    return [ln.strip() for ln in lines if len(ln.strip()) >= 4]
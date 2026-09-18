"""
Emotional Context Engine (Level 5): sentiment / urgency + adaptation hint.

Synchronous on purpose (Vercel serverless rejects asyncio.run -> EBUSY).

Privacy contract:
  * We store ONLY anonymized trend aggregates in `profiles.emotional_trends`
    (e.g. {positive: 12, urgent: 2, last_window_minutes: 60}) — never the
    raw message text that produced them.
  * The `analyze` result is injected into agent SYSTEM_PROMPTs by the
    coordinator, but the raw input text stays in the request path only.

Safety valve: if a user shows sustained negative/urgent tone (>= 3 within
one hour), we raise a flag so the orchestrator switches to minimal
interaction instead of pushing content at them.
"""
import json
import logging
import datetime
import time

from utils import groq_client, supabase_client

logger = logging.getLogger("emotional")

VALVE_WINDOW_SECONDS = 3600
VALVE_THRESHOLD = 3          # >= 3 negative/urgent signals within the window

_ANALYZE_SYSTEM = (
    "Kamu menganalisis nada emosional satu pesan singkat. Keluarkan HANYA "
    'JSON: {"sentiment":"positive|neutral|negative", '
    '"urgency":0-1, "escalate":true/false, "hint":"<1 kalimat saran nada>"}. '
    "Hint harus pendek dan netral. Balas HANYA JSON."
)


def _parse(raw: str):
    start, end = (raw or "").find("{"), (raw or "").rfind("}")
    if start == -1 or end <= start:
        return None
    try:
        obj = json.loads(raw[start:end + 1])
    except Exception:
        return None
    if not isinstance(obj, dict):
        return None
    obj.setdefault("sentiment", "neutral")
    obj.setdefault("urgency", 0.0)
    obj.setdefault("escalate", False)
    obj.setdefault("hint", "")
    return obj


def analyze(telegram_id: int, text: str, max_tokens: int = 120) -> dict:
    """Return emotional context for a single message (best-effort, cheap)."""
    if not text or not text.strip():
        return {"sentiment": "neutral", "urgency": 0.0,
                "escalate": False, "hint": ""}
    try:
        raw = groq_client.plain_completion(
            _ANALYZE_SYSTEM, text[:400], max_tokens=max_tokens, temperature=0.2)
    except Exception:
        return {"sentiment": "neutral", "urgency": 0.0,
                "escalate": False, "hint": ""}
    ctx = _parse(raw) or {"sentiment": "neutral", "urgency": 0.0,
                          "escalate": False, "hint": ""}
    _record(telegram_id, ctx)
    return ctx


def _now_ts() -> float:
    return time.time()


def _neg_flags(telegram_id: int) -> list:
    """Read recent negative/urgent timestamps (anonymized, in-memory window
    mirror + persisted last counts)."""
    return []


def _record(telegram_id: int, ctx: dict):
    """Persist an anonymized aggregate trend (no raw text). Tracks whether
    the safety valve should trip based on recent negative signals."""
    try:
        trends = supabase_client.get_profile(telegram_id).get(
            "emotional_trends") or {}
        if not isinstance(trends, dict):
            trends = {}
        # Keep a rolling count within the current window.
        window = trends.get("window_start") or datetime.datetime.utcnow().isoformat()
        try:
            ws = datetime.datetime.fromisoformat(window)
        except Exception:
            ws = datetime.datetime.utcnow()
        age = (datetime.datetime.utcnow() - ws).total_seconds()
        if age > VALVE_WINDOW_SECONDS:
            trends = {"window_start": datetime.datetime.utcnow().isoformat(),
                      "negative": 0, "urgent": 0, "escalations": 0}
        trends["negative"] = int(trends.get("negative") or 0)
        trends["urgent"] = int(trends.get("urgent") or 0)
        trends["escalations"] = int(trends.get("escalations") or 0)
        if ctx.get("sentiment") == "negative":
            trends["negative"] += 1
        if ctx.get("urgency", 0.0) >= 0.7:
            trends["urgent"] += 1
        if ctx.get("escalate"):
            trends["escalations"] += 1
        supabase_client.set_emotional_trends(telegram_id, trends)
    except Exception:
        pass


def safety_valve(telegram_id: int) -> bool:
    """True when the user should be left alone (minimal interaction)."""
    try:
        trends = supabase_client.get_profile(telegram_id).get(
            "emotional_trends") or {}
        if not isinstance(trends, dict):
            return False
        neg = int(trends.get("negative") or 0)
        urg = int(trends.get("urgent") or 0)
        return (neg + urg) >= VALVE_THRESHOLD
    except Exception:
        return False


def adaptation_hint(telegram_id: int, ctx: dict = None) -> str:
    """One-line hint injected into agent SYSTEM_PROMPT to adapt tone."""
    if safety_valve(telegram_id):
        return ("Jawab dengan singkat dan menenangkan; jangan menawarkan "
                "tindakan tambahan. Hormati kondisi pengguna.")
    sent = (ctx or {}).get("sentiment", "neutral")
    if sent == "positive":
        return "Pengguna tampak positif: pertahankan nada ringan dan ramah."
    if sent == "negative":
        return "Pengguna tampak frustrasi: gunakan nada jelas, empatik, singkat."
    return ""

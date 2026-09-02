"""
Cross-Platform Synthesis (Level 5).

Pulls light signals from connected private services (Gmail, Calendar,
Notion, Drive) and distills them into ONE consolidated "what needs your
attention" insight card with inline Telegram actions (Act on this /
Dismiss). Cards auto-expire after 7 days by TTL; dismissed cards stay
hidden.

Synchronous on purpose (Vercel serverless rejects asyncio.run -> EBUSY).

Privacy & consent:
  * Each service is fetched ONLY if `profiles.service_consent` has the
    matching flag (gmail/calendar/notion/drive) set true.
  * Only the synthesized card text is persisted (payload), never raw
    message/event bodies.
"""
import json
import logging
import datetime

from utils import groq_client, supabase_client, telegram, secure_tools

logger = logging.getLogger("synthesis")

_CARD_TTL_HOURS = 24 * 7   # 7 days
_SYNTH_SYSTEM = (
    "Kamu merangkum sinyal singkat dari beberapa layanan pengguna menjadi "
    "satu kartu prioritas. Input adalah ringkasan singkat (tanpa teks lengkap). "
    'Keluarkan HANYA JSON: {"title":"<12 kata>","summary":"<2 kalimat>",'
    '"priority":"low|medium|high","source":"gmail|calendar|notion|drive|mixed"} '
    "Jangan mengarang. Balas HANYA JSON."
)

_SERVICES = ("gmail", "calendar", "notion", "drive")


def _fetch_service(service: str, telegram_id: int) -> list:
    """Fetch bounded, summarized signals for one service (best-effort)."""
    try:
        if service == "gmail":
            res = secure_tools.read_gmail({"query": "is:unread newer_than:5d",
                                      "limit": 5}, telegram_id)
            if isinstance(res, dict) and "messages" in res:
                return res["messages"][:5]
        elif service == "calendar":
            res = secure_tools.get_calendar_events({"days": 3, "limit": 6},
                                                   telegram_id)
            if isinstance(res, dict) and "events" in res:
                return res["events"][:6]
        elif service == "notion":
            res = secure_tools.query_notion({"query": "", "limit": 5},
                                            telegram_id)
            if isinstance(res, dict) and "results" in res:
                return res["results"][:5]
        elif service == "drive":
            # If supported; otherwise treat as no signal.
            if hasattr(secure_tools, "upload_drive"):
                return []
    except Exception:
        return []
    return []


def _pull_all(telegram_id: int) -> dict:
    consent = supabase_client.read_service_consent(telegram_id)
    pulled = {}
    for svc in _SERVICES:
        if consent.get(svc, False):
            signals = _fetch_service(svc, telegram_id)
            if signals:
                pulled[svc] = signals
    return pulled


def _synthesize_card(pulled: dict) -> dict:
    if not pulled:
        return None
    # Reduce each service's signals to terse, non-raw summaries.
    compact = {}
    for svc, items in pulled.items():
        lst = []
        for it in items[:4]:
            if svc == "gmail":
                lst.append(it.get("subject", it) if isinstance(it, dict) else it)
            elif svc == "calendar":
                lst.append(it.get("summary", it) if isinstance(it, dict) else it)
            else:
                lst.append(it if isinstance(it, str) else
                           (it.get("title") or it.get("name") or "item"))
        compact[svc] = lst[:4]
    try:
        raw = groq_client.plain_completion(
            _SYNTH_SYSTEM, json.dumps(compact, ensure_ascii=False)[:900],
            max_tokens=220, temperature=0.4)
    except Exception as exc:
        logger.error(f"synthesis failed: {exc}")
        return None
    start, end = (raw or "").find("{"), (raw or "").rfind("}")
    if start == -1 or end <= start:
        return None
    try:
        card = json.loads(raw[start:end + 1])
    except Exception:
        return None
    if not isinstance(card, dict) or not card.get("title"):
        return None
    card.setdefault("priority", "medium")
    card.setdefault("source", "mixed")
    return card


def run_synthesis(telegram_id: int) -> dict:
    """Synthesize + persist + send one consolidated insight card."""
    pulled = _pull_all(telegram_id)
    if not pulled:
        return {"pushed": False, "reason": "no_signals"}
    card = _synthesize_card(pulled)
    if not card:
        return {"pushed": False, "reason": "synthesis_failed"}

    payload = {
        "title": card.get("title"),
        "summary": card.get("summary"),
        "priority": card.get("priority"),
        "source": card.get("source"),
        "services": sorted(pulled.keys()),
    }
    priority = {"low": 0, "medium": 1, "high": 2}.get(
        card.get("priority"), 1)
    ok = supabase_client.record_insight(
        telegram_id, "synthesis", payload, priority=priority,
        ttl_hours=_CARD_TTL_HOURS)
    if not ok:
        return {"pushed": False, "reason": "persist_failed"}

    text = (
        f"🔀 *{payload['title']}*\n\n{payload['summary']}\n\n"
        f"Prioritas: {payload['priority'].upper()} · Sumber: {payload['source']}"
    )
    markup = {"inline_keyboard": [[
        {"text": "Act on this", "callback_data": "syn:act"},
        {"text": "Dismiss", "callback_data": "syn:dismiss"},
    ]]}
    try:
        telegram.send_message_keyboard(telegram_id, text, markup)
    except Exception:
        telegram.send_message(telegram_id, text)
    return {"pushed": True, "card": payload}

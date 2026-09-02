"""
Predictive Trigger Engine (Level 5).

Given a user's calendar, unread/mail, pending todos, and behavioral window,
propose ONE proactive (non-intrusive) insight. Implemented to stay free-tier:
the heavy context is gathered server-side via secure_tools + todos, the
insight is Groq-synthesized, and everything is filtered so we never push
noise.

Pipeline (POST /api/analytics/predict):
    gather_context(telegram_id)  -> {calendar, mail, pending_todos, patterns}
    _intrusion_filter(...)       -> drop if not enough signal / already busy
    _backoff_gate(telegram_id)   -> drop if user dismissed 3x recently
    synthesize insight via Groq  -> short, imperatively soft card
    record_insight(ttl)          -> stored in synthesized_insights
    send via Telegram (non-intrusive, with Dismiss action)

Privacy: calendar/mail bodies are only read server-side if the matching
`service_consent` flag is set; raw content is never stored — only the
synthesized insight card is persisted.
"""
import json
import logging
import datetime
from http.server import BaseHTTPRequestHandler

from utils import groq_client, supabase_client, telegram, todos
from utils import secure_tools


def _read_json(self):
    length = int(self.headers.get("Content-Length", 0) or 0)
    body = self.rfile.read(length) if length else b""
    return json.loads(body or b"{}")


def _send_json(self, payload, status):
    data = json.dumps(payload).encode("utf-8")
    self.send_response(status)
    self.send_header("Content-type", "application/json")
    self.send_header("Content-Length", str(len(data)))
    self.end_headers()
    self.wfile.write(data)

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("analytics.predict")

MIN_CONFIDENCE = 0.45
BACKOFF_DISMISSALS = 3
BACKOFF_HOURS = 24
_INSIGHT_SYSTEM = (
    "Kamu menyusun satu kartu wawasan proaktif yang TIDAK mengganggu. "
    "Input adalah sinyal ringkas (agenda, mail, todo). Keluarkan HANYA JSON: "
    '{"title":"<10 kata>","suggestion":"<1-2 kalimat, nada lembut ausoalan>",'
    '"confidence":0-1,"type":"calendar|followup|todo"} '
    "Jika sinyal terlalu lemah, set confidence <0.3. Balas HANYA JSON."
)


# ------------------------------------------------------------------
# Context gathering
# ------------------------------------------------------------------
def _gather_context(telegram_id: int) -> dict:
    consent = supabase_client.read_service_consent(telegram_id)
    ctx = {"calendar": [], "mail": [], "pending_todos": [],
           "behavioral": {}, "consent": consent}

    # Todos: always available (no consent needed).
    try:
        items = todos._get_items(telegram_id, "pending")
        ctx["pending_todos"] = [
            it.get("text") for it in items if isinstance(it, dict)]
    except Exception:
        pass

    if consent.get("calendar", False):
        try:
            res = secure_tools.get_calendar_events(
                {"days": 3, "limit": 10}, telegram_id)
            if isinstance(res, dict) and "events" in res:
                ctx["calendar"] = res["events"][:10]
        except Exception:
            pass

    if consent.get("gmail", False):
        try:
            res = secure_tools.read_gmail(
                {"query": "is:unread newer_than:3d", "limit": 10}, telegram_id)
            if isinstance(res, dict) and "messages" in res:
                ctx["mail"] = res["messages"][:10]
        except Exception:
            pass

    try:
        ctx["behavioral"] = supabase_client.get_behavioral_patterns(
            telegram_id, days=14)
    except Exception:
        pass
    return ctx


# ------------------------------------------------------------------
# Filters
# ------------------------------------------------------------------
def _intrusion_filter(ctx: dict) -> bool:
    """True = we SHOULD not push (no signal / busy / overloaded)."""
    has_events = bool(ctx.get("calendar"))
    has_mail = bool(ctx.get("mail"))
    has_todos = bool(ctx.get("pending_todos"))
    if not (has_events or has_mail or has_todos):
        return True   # nothing to say -> stay quiet
    # If the day is already packed with calendar, do not add more noise.
    if len(ctx.get("calendar") or []) >= 4:
        return True
    return False


def _backoff_gate(telegram_id: int) -> bool:
    """True when we should pause: 3 recent dismissals within a day."""
    recent = supabase_client.get_active_insights(telegram_id, limit=20)
    dismissals = [
        i for i in recent
        if i.get("dismissed") and _within_hours(i.get("updated_at"), 24)]
    return len(dismissals) >= BACKOFF_DISMISSALS


def _within_hours(iso: str, hours: float) -> bool:
    try:
        dt = datetime.datetime.fromisoformat(str(iso)[:19])
        age = (datetime.datetime.utcnow() - dt).total_seconds() / 3600
        return 0 <= age <= hours
    except Exception:
        return False


# ------------------------------------------------------------------
# Synthesis
# ------------------------------------------------------------------
def _synthesize(ctx: dict) -> dict:
    raw_ctx = {
        "calendar": [e.get("summary", e) for e in ctx.get("calendar") or []][:4],
        "mail": [m.get("subject", m) for m in ctx.get("mail") or []][:4],
        "pending_todos": ctx.get("pending_todos")[:5],
        "active_days": len(ctx.get("behavioral") or []),
    }
    if not any(raw_ctx.values()):
        return None
    try:
        raw = groq_client.plain_completion(
            _INSIGHT_SYSTEM, json.dumps(raw_ctx, ensure_ascii=False)[:800],
            max_tokens=200, temperature=0.4)
    except Exception as exc:
        logger.error(f"predict synthesis failed: {exc}")
        return None
    start, end = (raw or "").find("{"), (raw or "").rfind("}")
    if start == -1 or end <= start:
        return None
    try:
        insight = json.loads(raw[start:end + 1])
    except Exception:
        return None
    if not isinstance(insight, dict) or not insight.get("title"):
        return None
    conf = float(insight.get("confidence") or 0)
    insight["confidence"] = conf
    return insight if conf >= MIN_CONFIDENCE else None


# ------------------------------------------------------------------
# Orchestration
# ------------------------------------------------------------------
def run_predict(telegram_id: int, send: bool = True) -> dict:
    """Produce (and optionally send) one proactive insight for a user."""
    if _intrusion_filter(_gather_context(telegram_id)):
        return {"pushed": False, "reason": "low_signal"}
    # Re-gather after filter? Gather once and reuse to avoid double work.
    ctx = _gather_context(telegram_id)
    if _intrusion_filter(ctx):
        return {"pushed": False, "reason": "low_signal"}
    if _backoff_gate(telegram_id):
        return {"pushed": False, "reason": "backoff"}

    insight = _synthesize(ctx)
    if not insight:
        return {"pushed": False, "reason": "low_confidence"}

    card = {
        "title": insight.get("title"),
        "suggestion": insight.get("suggestion"),
        "confidence": insight.get("confidence"),
        "type": insight.get("type", "general"),
        "source_note": "",
    }
    ok = supabase_client.record_insight(
        telegram_id, "predictive", card, priority=1, ttl_hours=72)
    if not ok:
        return {"pushed": False, "reason": "persist_failed"}

    if send:
        text = f"💡 *{card['title']}*\n\n{card['suggestion']}"
        _send_non_intrusive(telegram_id, text)
    return {"pushed": True, "insight": card}


def _send_non_intrusive(telegram_id: int, text: str):
    """Send with a Dismiss inline action so users can quiet the engine."""
    markup = {"inline_keyboard": [[
        {"text": "Dismiss", "callback_data": "pv:dismiss"},
    ]]}
    try:
        telegram.send_message_keyboard(telegram_id, text, markup)
    except Exception:
        telegram.send_message(telegram_id, text)


# ------------------------------------------------------------------
# HTTP endpoint (/api/analytics/predict)
#   POST {"telegram_id": N}             -> run the predictive engine once
#   POST {"telegram_id": N,"dismiss":1} -> mark this user's current card dismissed
# ------------------------------------------------------------------
class handler(BaseHTTPRequestHandler):

    def do_GET(self):
        self._send_json({"ok": True, "service": "jarvis-analytics-predict"}, 200)

    def do_POST(self):
        try:
            body = _read_json(self)
            tid = int(body.get("telegram_id") or
                      self.headers.get("X-Telegram-Id") or 0)
            if not tid:
                return self._send_json({"ok": False, "error": "telegram_id required"}, 400)
            if body.get("dismiss"):
                for row in supabase_client.get_active_insights(tid, "predictive", 1):
                    supabase_client.update_insight(row["id"], {"dismissed": True})
                return self._send_json({"ok": True, "dismissed": True}, 200)
            result = run_predict(tid, send=bool(body.get("send", True)))
            return self._send_json({"ok": True, **result}, 200)
        except Exception as exc:
            logger.exception("predict failed")
            return self._send_json({"ok": False, "error": str(exc)}, 500)

    def _read_json(self):
        return _read_json(self)

    def _send_json(self, payload, status):
        _send_json(self, payload, status)

    def log_message(self, format, *args):
        logger.info("%s - %s" % (self.address_string(), format % args))

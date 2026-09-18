"""
Unified analytics endpoint (Level 5): behavioral profiles, predictive triggers,
and sweep — all in one serverless function to stay within the Hobby-plan 12
function limit.

Routing by path:
  /api/analytics/behavior  GET/POST  — profile ops
  /api/analytics/predict   GET/POST  — predictive engine
  /api/analytics/sweep     GET/POST  — cron sweep + cleanup

Auth: sweep requires Bearer CRON_SECRET; behavior/predict use X-Telegram-Id.
Synchronous on purpose (Vercel serverless free tier, 60s).
"""
import json
import logging
import os
import hmac
import datetime
from http.server import BaseHTTPRequestHandler

from utils import groq_client, supabase_client, telegram, todos
from utils import secure_tools, cross_platform_synthesis

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("analytics")

MIN_CONFIDENCE = 0.45
BACKOFF_DISMISSALS = 3
INSIGHT_SYSTEM = (
    "Kamu menyusun satu kartu wawasan proaktif yang TIDAK mengganggu. "
    "Input adalah sinyal ringkas (agenda, mail, todo). Keluarkan HANYA JSON: "
    '{"title":"<10 kata>","suggestion":"<1-2 kalimat, nada lembut>",'
    '"confidence":0-1,"type":"calendar|followup|todo"} '
    "Jika sinyal terlalu lemah, set confidence <0.3. Balas HANYA JSON."
)


# ------------------------------------------------------------------
# Shared helpers
# ------------------------------------------------------------------
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


def _extract_tid(self, body=None) -> int:
    hs = self.headers.get("X-Telegram-Id")
    if hs:
        try:
            return int(hs)
        except ValueError:
            pass
    if "telegram_id=" in self.path:
        try:
            return int(self.path.split("telegram_id=")[-1].split("&")[0])
        except ValueError:
            pass
    if body:
        try:
            return int(body.get("telegram_id") or 0)
        except (ValueError, TypeError):
            pass
    return 0


def _within_hours(iso_str, hours: float) -> bool:
    try:
        dt = datetime.datetime.fromisoformat(str(iso_str)[:19])
        age = (datetime.datetime.utcnow() - dt).total_seconds() / 3600
        return 0 <= age <= hours
    except Exception:
        return False


# ------------------------------------------------------------------
# Predict engine (inlined from api/analytics/predict.py)
# ------------------------------------------------------------------
def _gather_context(telegram_id: int) -> dict:
    consent = supabase_client.read_service_consent(telegram_id)
    ctx = {"calendar": [], "mail": [], "pending_todos": [],
           "behavioral": {}, "consent": consent}
    try:
        items = todos._get_items(telegram_id, "pending")
        ctx["pending_todos"] = [it.get("text") for it in items if isinstance(it, dict)]
    except Exception:
        pass
    if consent.get("calendar", False):
        try:
            res = secure_tools.get_calendar_events({"days": 3, "limit": 10}, telegram_id)
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
        ctx["behavioral"] = supabase_client.get_behavioral_patterns(telegram_id, days=14)
    except Exception:
        pass
    return ctx


def _intrusion_filter(ctx: dict) -> bool:
    has_events = bool(ctx.get("calendar"))
    has_mail = bool(ctx.get("mail"))
    has_todos = bool(ctx.get("pending_todos"))
    if not (has_events or has_mail or has_todos):
        return True
    if len(ctx.get("calendar") or []) >= 4:
        return True
    return False


def _backoff_gate(telegram_id: int) -> bool:
    recent = supabase_client.get_active_insights(telegram_id, limit=20)
    dismissals = [i for i in recent
                  if i.get("dismissed") and _within_hours(i.get("updated_at"), 24)]
    return len(dismissals) >= BACKOFF_DISMISSALS


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
            INSIGHT_SYSTEM, json.dumps(raw_ctx, ensure_ascii=False)[:800],
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


def _send_non_intrusive(telegram_id: int, text: str):
    markup = {"inline_keyboard": [[{"text": "Dismiss", "callback_data": "pv:dismiss"}]]}
    try:
        telegram.send_message_keyboard(telegram_id, text, markup)
    except Exception:
        telegram.send_message(telegram_id, text)


def run_predict(telegram_id: int, send: bool = True) -> dict:
    if _intrusion_filter(_gather_context(telegram_id)):
        return {"pushed": False, "reason": "low_signal"}
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
    ok = supabase_client.record_insight(telegram_id, "predictive", card, priority=1, ttl_hours=72)
    if not ok:
        return {"pushed": False, "reason": "persist_failed"}
    if send:
        text = f"💡 *{card['title']}*\n\n{card['suggestion']}"
        _send_non_intrusive(telegram_id, text)
    return {"pushed": True, "insight": card}


# ------------------------------------------------------------------
# Sweep engine (inlined from api/analytics/sweep.py)
# ------------------------------------------------------------------
def _run_sweep(mode: str) -> dict:
    ids = supabase_client.get_all_chat_telegram_ids()
    pushed, skipped = 0, 0
    for tid in ids:
        try:
            consent = supabase_client.read_service_consent(tid)
            if mode == "predictive":
                if not consent.get("predictive", False):
                    skipped += 1
                    continue
                res = run_predict(tid, send=True)
            elif mode == "synthesis":
                if not any(consent.get(s) for s in ("gmail", "calendar", "notion", "drive")):
                    skipped += 1
                    continue
                res = cross_platform_synthesis.run_synthesis(tid)
            else:
                raise ValueError(f"unknown mode: {mode}")
            pushed += 1 if res.get("pushed") else 0
            skipped += 0 if res.get("pushed") else 1
        except Exception as exc:
            logger.warning(f"sweep {mode} user {tid} failed: {exc}")
            skipped += 1
    return {"mode": mode, "users_scanned": len(ids), "pushed": pushed, "skipped": skipped}


# ------------------------------------------------------------------
# Route handlers
# ------------------------------------------------------------------
def _behavior_get(self):
    from utils import behavior_analyzer
    tid = _extract_tid(self)
    if not tid:
        return _send_json(self, {"ok": False, "error": "telegram_id required"}, 400)
    force = "force=1" in self.path or "force=true" in self.path
    profile = behavior_analyzer.get_or_update_profile(tid, force=force)
    _send_json(self, {"ok": True, "telegram_id": tid, "profile": profile}, 200)


def _behavior_post(self):
    from utils import behavior_analyzer
    body = _read_json(self)
    tid = _extract_tid(self, body)
    action = body.get("action", "refresh")
    if action == "delete":
        ok = behavior_analyzer.delete_profile(tid)
        _send_json(self, {"ok": ok, "profile": {}}, 200)
    else:
        profile = behavior_analyzer.get_or_update_profile(tid, force=True)
        _send_json(self, {"ok": True, "profile": profile}, 200)


def _predict_get(self):
    _send_json(self, {"ok": True, "service": "jarvis-analytics-predict"}, 200)


def _predict_post(self):
    body = _read_json(self)
    tid = _extract_tid(self, body)
    if not tid:
        return _send_json(self, {"ok": False, "error": "telegram_id required"}, 400)
    if body.get("dismiss"):
        for row in supabase_client.get_active_insights(tid, "predictive", 1):
            supabase_client.update_insight(row["id"], {"dismissed": True})
        return _send_json(self, {"ok": True, "dismissed": True}, 200)
    result = run_predict(tid, send=bool(body.get("send", True)))
    _send_json(self, {"ok": True, **result}, 200)


def _sweep_get(self):
    _send_json(self, {"ok": True, "service": "jarvis-analytics-sweep"}, 200)


def _sweep_post(self):
    provided = self.headers.get("Authorization", "").replace("Bearer ", "")
    secret = os.getenv("CRON_SECRET", "")
    if secret and not hmac.compare_digest(provided, secret):
        return _send_json(self, {"ok": False, "error": "unauthorized"}, 401)
    body = _read_json(self)
    mode = body.get("mode", "predictive")
    if mode == "cleanup":
        removed = supabase_client.cleanup_expired_insights()
        return _send_json(self, {"ok": True, "mode": "cleanup", "removed": removed}, 200)
    result = _run_sweep(mode)
    _send_json(self, {"ok": True, **result}, 200)


def _default_get(self):
    _send_json(self, {"ok": True, "service": "jarvis-analytics"}, 200)


def _default_post(self):
    _send_json(self, {"ok": False, "error": "unknown action"}, 400)


_PATH_MAP = {
    "behavior": (_behavior_get, _behavior_post),
    "predict":  (_predict_get,  _predict_post),
    "sweep":    (_sweep_get,    _sweep_post),
}


# ------------------------------------------------------------------
# HTTP endpoint
# ------------------------------------------------------------------
class handler(BaseHTTPRequestHandler):

    def do_GET(self):
        try:
            route = self._resolve_route()
            route[0](self)
        except Exception as exc:
            logger.exception("analytics GET failed")
            _send_json(self, {"ok": False, "error": str(exc)}, 500)

    def do_POST(self):
        try:
            route = self._resolve_route()
            route[1](self)
        except Exception as exc:
            logger.exception("analytics POST failed")
            _send_json(self, {"ok": False, "error": str(exc)}, 500)

    def _resolve_route(self):
        path = self.path.split("?")[0].split("/")[-1]
        return _PATH_MAP.get(path, (_default_get, _default_post))

    def log_message(self, format, *args):
        logger.info("%s - %s" % (self.address_string(), format % args))

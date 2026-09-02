"""
Predictive / synthesis sweep endpoint (Level 5).

POST /api/analytics/sweep
  {"mode": "predictive"}            -> run predictive engine per consenting user
  {"mode": "synthesis"}             -> run cross-platform synthesis per user
  {"mode": "cleanup"}               -> TTL-clean expired synthesized_insights

Auth: Bearer CRON_SECRET (same as other scheduled endpoints). Returns a
summary of how many users were pushed / skipped so the GitHub Actions
workflow can log progress without exposing any content.

Synchronous on purpose (Vercel serverless rejects asyncio.run -> EBUSY).
"""
import json
import logging
import os
import hmac
from http.server import BaseHTTPRequestHandler

from utils import supabase_client
from api.analytics import predict as predict_engine
from utils import cross_platform_synthesis

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("analytics.sweep")

_PRIVACY_FIELDS = ("behavioral", "predictive", "emotional",
                   "gmail", "calendar", "notion", "drive")


def _consenting_ids() -> list:
    """Distinct users who have chat activity (free PostgREST has no
    'distinct consenting' query, so we filter in-process)."""
    return supabase_client.get_all_chat_telegram_ids()


def _is_consenting(telegram_id: int, feature: str) -> bool:
    try:
        consent = supabase_client.read_service_consent(telegram_id)
    except Exception:
        consent = {}
    # Default: behavioral/predictive/emotional are opt-in (off by default).
    return bool(consent.get(feature, False))


def _run_sweep(mode: str) -> dict:
    ids = _consenting_ids()
    pushed, skipped = 0, 0
    for tid in ids:
        try:
            if mode == "cleanup":
                continue
            if mode == "predictive":
                if not _is_consenting(tid, "predictive"):
                    skipped += 1
                    continue
                res = predict_engine.run_predict(tid, send=True)
            elif mode == "synthesis":
                # Synthesis aggregates multiple services; treat as consenting
                # when any service consent is active.
                consent = supabase_client.read_service_consent(tid)
                if not any(consent.get(s) for s in
                           ("gmail", "calendar", "notion", "drive")):
                    skipped += 1
                    continue
                res = cross_platform_synthesis.run_synthesis(tid)
            else:
                raise ValueError(f"unknown mode: {mode}")
            if res.get("pushed"):
                pushed += 1
            else:
                skipped += 1
        except Exception as exc:
            logger.warning(f"sweep {mode} user {tid} failed: {exc}")
            skipped += 1
    return {"mode": mode, "users_scanned": len(ids),
            "pushed": pushed, "skipped": skipped}


def _run_cleanup() -> int:
    return supabase_client.cleanup_expired_insights()


class handler(BaseHTTPRequestHandler):

    def do_GET(self):
        self._send_json({"ok": True, "service": "jarvis-analytics-sweep"}, 200)

    def do_POST(self):
        # Auth: shared scheduled-secret, like cron-trigger.
        provided = self.headers.get("Authorization", "").replace("Bearer ", "")
        secret = os.getenv("CRON_SECRET", "")
        if secret and not hmac.compare_digest(provided, secret):
            return self._send_json({"ok": False, "error": "unauthorized"}, 401)
        try:
            body = self._read_json()
            mode = body.get("mode", "predictive")
            if mode == "cleanup":
                removed = _run_cleanup()
                return self._send_json(
                    {"ok": True, "mode": "cleanup", "removed": removed}, 200)
            result = _run_sweep(mode)
            return self._send_json({"ok": True, **result}, 200)
        except Exception as exc:
            logger.exception("sweep failed")
            return self._send_json({"ok": False, "error": str(exc)}, 500)

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

    def log_message(self, format, *args):
        logger.info("%s - %s" % (self.address_string(), format % args))

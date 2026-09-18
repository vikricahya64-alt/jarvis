"""
Proactive maintenance endpoint, triggered by the second daily cron:
  1. Sends the user's daily briefing to Telegram.
  2. Compacts long chat histories into the knowledge base (memory).

Protected by the same CRON_SECRET header as /api/cron. Bounded and
non-fatal: each stage is isolated so one failure never aborts the rest.
"""
import os
import json
import logging
from http.server import BaseHTTPRequestHandler

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("maintenance")


def run_maintenance() -> dict:
    """Proactive daily jobs: daily briefing + memory compaction."""
    summary = {}

    try:
        from utils.briefing import send_daily_briefing
        send_daily_briefing()
        summary["briefing"] = "sent"
    except Exception as exc:
        logger.exception("Daily briefing failed")
        summary["briefing"] = f"failed: {exc}"

    try:
        from utils.compaction import compact_all_users
        compact_all_users(threshold=50)
        summary["compaction"] = "done"
    except Exception as exc:
        logger.exception("Memory compaction failed")
        summary["compaction"] = f"failed: {exc}"

    return summary


class handler(BaseHTTPRequestHandler):

    def do_GET(self):
        token = self.headers.get("Authorization", "").replace("Bearer ", "")
        secret = os.getenv("CRON_SECRET", "")
        if secret and token != secret:
            self._send_json({"ok": False, "error": "Unauthorized"}, 401)
            return
        try:
            summary = run_maintenance()
            logger.info(f"Maintenance result: {summary}")
            self._send_json({"ok": True, **summary}, 200)
        except Exception as exc:
            logger.exception("Maintenance worker failed")
            self._send_json({"ok": False, "error": str(exc)}, 500)

    def _send_json(self, payload, status):
        data = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, format, *args):
        logger.info("%s - %s" % (self.address_string(), format % args))
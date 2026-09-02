"""
Behavioral profile endpoint (Level 5).

GET  /api/analytics/behavior?telegram_id=<id>&force=1  -> current profile
POST /api/analytics/behavior  ("action":"delete"|"refresh")  -> privacy ops

Synchronous (Vercel serverless free tier, 60s). No raw messages ever leave
the backend — only the aggregate behavior profile is returned.
"""
import json
import logging
from http.server import BaseHTTPRequestHandler

from utils import behavior_analyzer

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("analytics.behavior")


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


class handler(BaseHTTPRequestHandler):

    def do_GET(self):
        try:
            tid = 0
            if "telegram_id=" in self.path:
                try:
                    tid = int(self.path.split("telegram_id=")[-1].split("&")[0])
                except ValueError:
                    tid = 0
            hs = self.headers.get("X-Telegram-Id")
            if not tid and hs:
                try:
                    tid = int(hs)
                except ValueError:
                    tid = 0
            if not tid:
                return self._send_json(
                    {"ok": False, "error": "telegram_id required"},
                    400)
            force = "force=1" in self.path or "force=true" in self.path
            profile = behavior_analyzer.get_or_update_profile(tid, force=force)
            self._send_json({"ok": True, "telegram_id": tid,
                             "profile": profile}, 200)
        except Exception as exc:
            logger.exception("behavior get failed")
            self._send_json({"ok": False, "error": str(exc)}, 500)

    def do_POST(self):
        try:
            body = _read_json(self)
            tid = int(body.get("telegram_id") or
                      self.headers.get("X-Telegram-Id") or 0)
            action = body.get("action", "refresh")
            if action == "delete":
                ok = behavior_analyzer.delete_profile(tid)
                self._send_json({"ok": ok, "profile": {}}, 200)
            else:
                profile = behavior_analyzer.get_or_update_profile(tid, force=True)
                self._send_json({"ok": True, "profile": profile}, 200)
        except Exception as exc:
            logger.exception("behavior post failed")
            self._send_json({"ok": False, "error": str(exc)}, 500)

    def _read_json(self):
        return _read_json(self)

    def _send_json(self, payload, status):
        _send_json(self, payload, status)

    def log_message(self, format, *args):
        logger.info("%s - %s" % (self.address_string(), format % args))

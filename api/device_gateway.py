"""
Device Gateway (Level 6): secure long-poll bridge between the Vercel core
and the Realme C25s Termux poller.

Why long-poll HTTP instead of a websocket:
  * Vercel serverless cannot hold sockets; long-poll fits naturally.
  * The G85 phone is behind cellular NAT — it must initiate connections.
  * The device polls every N seconds: this endpoint hands back an encrypted
    queued task (if any) and accepts encrypted results.

Endpoints (POST, JSON):
  /api/device/poll   {"telegram_id": N} -> {"ok":true,"task":<envelope>|null}
  /api/device/push   {"telegram_id": N, "queue_id": "...", "response": <envelope>}

Auth: `X-Device-Key` header == DEVICE_SHARED_SECRET (HMAC constant-time).

Synchronous on purpose (Vercel serverless rejects asyncio.run -> EBUSY).
"""
import os
import json
import hmac
import logging
from http.server import BaseHTTPRequestHandler

from utils import supabase_client, device_comm, telegram

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("device_gateway")


def _authorized(headers) -> bool:
    secret = os.getenv("DEVICE_SHARED_SECRET", "")
    if not secret:
        return False
    key = headers.get("X-Device-Key", "")
    return hmac.compare_digest(key, secret)


def _poll(telegram_id: int):
    """Device asks: is there an encrypted task for me?"""
    supabase_client.store_device_heartbeat(telegram_id, {
        "temp_c": None, "ram_pct": None, "threads": None,
        "latency_ms": 0, "model": "Qwen2.5-1.5B",
    })
    row = supabase_client.dequeue_device_task(telegram_id)
    if not row:
        return {"ok": True, "task": None}
    return {"ok": True, "task": {
        "queue_id": row["id"],
        "task_id": row.get("task_id_fk") or row.get("task_id"),
        "envelope": row["envelope"],
    }}


def _push(telegram_id: int, queue_id: str, response_envelope: dict):
    """Device returns an encrypted result; we decrypt + deliver to Telegram."""
    result = device_comm.decrypt_payload(response_envelope)
    task_id = result.get("task_id") or ""
    text = result.get("text", "")
    error = result.get("error")
    supabase_client.complete_device_task(queue_id, task_id,
                                         {"text": text or "ℹ️ Selesai di perangkat.",
                                          "error": error})
    # Deliver to the user with the execution-location indicator.
    try:
        from api.hybrid_router import location_tag
        tag = location_tag("local")
    except Exception:
        tag = "🛡️ Local (Private)"
    body = (tag if not error else "⚠️ Lokal gagal") + "\n\n" + (text or error)
    if telegram_id:
        from utils.telegram import send_message
        send_message(telegram_id, body[:4000])
    return {"ok": True, "delivered": True}


class handler(BaseHTTPRequestHandler):

    def do_GET(self):
        self._send_json({"ok": True, "service": "jarvis-device-gateway"}, 200)

    def do_POST(self):
        if not _authorized(self.headers):
            return self._send_json({"ok": False, "error": "unauthorized"}, 401)
        try:
            body = self._read_json()
            telegram_id = int(body.get("telegram_id") or 0)
            cmd = self.path.split("/")[-1].split("?")[0]
            if cmd == "poll" or "poll" in self.path:
                return self._send_json({"ok": True, **_poll(telegram_id)}, 200)
            if cmd == "push" or "push" in self.path:
                res = _push(telegram_id, body.get("queue_id"),
                            body.get("response") or {})
                return self._send_json({"ok": True, **res}, 200)
            return self._send_json({"ok": False, "error": "unknown cmd"}, 404)
        except Exception as exc:
            logger.exception("device gateway failed")
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
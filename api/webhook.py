"""
Telegram Webhook Handler (entry point).
URL: /api/webhook

Receives updates from Telegram, stores the task in Supabase, then runs the
orchestrator pipeline synchronously before responding. A background thread
is unreliable on Vercel (serverless isolates stop running as soon as the
handler returns), so we process inline. A daily cron (api/cron.py) catches
any task that exceeds the function timeout.

Everything here is synchronous: repeated asyncio.run() in one thread
raises EBUSY inside Vercel serverless, so no event loop is used on the
request path at all.
"""
import os
import json
import hmac
import logging
from http.server import BaseHTTPRequestHandler

from utils import supabase_client
from utils.telegram import send_typing

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("webhook")


def _enqueue(chat_id: int, text: str, username=None, first_name=None) -> str:
    """Record that we are working, create the profile, insert the task."""
    send_typing(chat_id)
    profile = supabase_client.get_or_create_profile(chat_id, username, first_name)
    return supabase_client.insert_task(chat_id, text, profile["id"])


def _notify_failure(chat_id: int):
    """Best-effort Telegram notice when a pipeline crashes mid-run."""
    try:
        from utils.telegram import send_message
        send_message(
            chat_id,
            "Ups, terjadi kendala saat memproses permintaan Anda. "
            "Kendala sudah tercatat dan akan saya coba tangani lagi. "
            "Silakan ulangi jika ini terus berulang. 🙏",
        )
    except Exception:
        pass


class handler(BaseHTTPRequestHandler):

    def do_GET(self):
        self._send_json({"ok": True, "service": "J.A.R.V.I.S. webhook"}, 200)

    def do_POST(self):
        # 1. Verify the request originates from Telegram.
        if not self._verify_signature():
            logger.warning("Invalid Telegram signature rejected")
            return self._send_json({"ok": False, "error": "Invalid signature"}, 403)

        # 2. Parse the body.
        try:
            update = self._read_json()
        except Exception as exc:
            logger.error(f"Bad JSON: {exc}")
            return self._send_json({"ok": False, "error": "Bad JSON"}, 400)

        message = update.get("message") or update.get("edited_message")
        if not message:
            return self._send_json({"ok": True}, 200)

        chat_id = message.get("chat", {}).get("id")
        text = message.get("text") or message.get("caption")
        username = message.get("from", {}).get("username")
        first_name = message.get("from", {}).get("first_name")

        if not text or not chat_id:
            return self._send_json({"ok": True}, 200)

        # 3. Enqueue the task in Supabase with status PENDING.
        try:
            task_id = _enqueue(chat_id, text, username, first_name)
            logger.info(f"Enqueued task {task_id} for chat {chat_id}")
        except Exception as exc:
            logger.exception(f"Failed to enqueue task: {exc}")
            return self._send_json({"ok": False, "error": "Enqueue failed"}, 200)

        # 4. Run the orchestrator pipeline synchronously. A background thread
        #    is unreliable on Vercel (serverless isolates stop running as soon
        #    as the handler returns), leaving tasks PENDING forever. The daily
        #    cron (api/cron.py) acts as a safety net for any task that exceeds
        #    the function timeout.
        try:
            from api.orchestrator import _run_pipeline
            _run_pipeline(task_id, chat_id, text)
            logger.info(f"Pipeline finished for task {task_id}")
        except Exception as exc:
            logger.exception(f"Pipeline failed for task {task_id}: {exc}")
            try:
                supabase_client.update_task(task_id, {
                    "status": "FAILED",
                    "error": str(exc)[:500],
                })
            except Exception:
                pass
            _notify_failure(chat_id)

        return self._send_json({"ok": True, "task_id": task_id}, 200)

    def _read_json(self):
        length = int(self.headers.get("Content-Length", 0) or 0)
        body = self.rfile.read(length) if length else b""
        return json.loads(body or b"{}")

    def _verify_signature(self) -> bool:
        token = self.headers.get("X-Telegram-Bot-Api-Secret-Token", "")
        secret = os.getenv("TELEGRAM_SECRET_TOKEN", "")
        if not secret:
            return True  # loose mode; enable secret in production
        return hmac.compare_digest(token, secret)

    def _send_json(self, payload, status):
        data = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, format, *args):
        logger.info("%s - %s" % (self.address_string(), format % args))
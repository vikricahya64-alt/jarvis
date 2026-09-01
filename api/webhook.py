"""
Telegram Webhook Handler (entry point).
URL: /api/webhook

Receives updates from Telegram, stores the pending task in Supabase,
returns 200 OK immediately, and runs the orchestrator pipeline in a
background thread. This avoids depending on a Supabase Database webhook
(which requires the supabase_admin-owned schema that free projects often
cannot create).
"""
import os
import json
import hmac
import logging
import asyncio
import threading
from http.server import BaseHTTPRequestHandler

from utils import supabase_client
from utils.telegram import send_typing
from api.orchestrator import _run_pipeline

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("webhook")


def _run_in_background(task_id: str, telegram_id: int, user_input: str):
    """Run the orchestrator pipeline in a new event loop on a background thread."""
    try:
        asyncio.run(_run_pipeline(task_id, telegram_id, user_input))
        logger.info(f"Pipeline finished for task {task_id}")
    except Exception as exc:
        logger.exception(f"Background pipeline failed for task {task_id}: {exc}")


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

        # 3. Let the user know we are working (fire-and-forget).
        try:
            asyncio.run(send_typing(chat_id))
        except Exception:
            pass

        # 4. Enqueue the task in Supabase with status PENDING.
        try:
            profile = asyncio.run(
                supabase_client.get_or_create_profile(chat_id, username, first_name)
            )
            task_id = asyncio.run(supabase_client.insert_task(chat_id, text, profile["id"]))
            logger.info(f"Enqueued task {task_id} for chat {chat_id}")
        except Exception as exc:
            logger.error(f"Failed to enqueue task: {exc}")
            return self._send_json({"ok": False, "error": "Enqueue failed"}, 200)

        # 5. Run the orchestrator pipeline in the background, then return
        #    200 immediately (Telegram expects a fast webhook response).
        try:
            thread = threading.Thread(
                target=_run_in_background,
                args=(task_id, chat_id, text),
                daemon=True,
            )
            thread.start()
            logger.info(f"Started background pipeline for task {task_id}")
        except Exception as exc:
            logger.error(f"Failed to start pipeline: {exc}")

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

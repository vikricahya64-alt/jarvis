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


def _has_media(message: dict) -> bool:
    """True when the update carries a non-text attachment best handled by the
    multimodal pipeline (photo/voice/audio/document)."""
    if not message:
        return False
    return bool(message.get("photo") or message.get("voice")
                or message.get("audio") or message.get("document"))


def hybrid_tag(decision: str) -> str:
    """Human-visible execution location indicator (Level 6)."""
    try:
        from api.hybrid_router import location_tag
        return location_tag(decision)
    except Exception:
        return {"local": "🛡️ Local (Private)",
                "force_local": "🛡️ Local (Forced)",
                "fallback": "⚠️ Fallback (Cloud)",
                "force_cloud": "🔵 Cloud (Forced)"}.get(
            decision, "🔵 Cloud (Powerful)")


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

        # 2b. Callback query (inline keyboard taps on todo buttons).
        cb = update.get("callback_query")
        if cb:
            return self._handle_callback(cb)

        message = update.get("message") or update.get("edited_message")
        if not message:
            return self._send_json({"ok": True}, 200)

        # 2c. Non-text media (photo/voice/audio/document): hand off to the
        # dedicated multimodal bridge (rate-limited, size-guarded, its own
        # pipeline) instead of the old inline handlers.
        if _has_media(message):
            try:
                from api import webhook_multimodal
                payload, status = webhook_multimodal.process_update(update)
                return self._send_json(payload, status)
            except Exception as exc:
                logger.exception(f"Multimodal routing failed: {exc}")
                return self._send_json({"ok": True, "handled": "multimodal_error"}, 200)

        chat_id = message.get("chat", {}).get("id")
        text = message.get("text") or message.get("caption")
        username = message.get("from", {}).get("username")
        first_name = message.get("from", {}).get("first_name")
        photo = message.get("photo")

        # Voice memos: transcribe via Groq Whisper, then answer the text.
        voice = message.get("voice") or message.get("audio")
        if voice and not text:
            try:
                send_typing(chat_id)
                from utils.audio import transcribe_voice
                transcript = transcribe_voice(voice.get("file_id"))
                if transcript:
                    text = f"[pesan suara] {transcript}"
                else:
                    return self._send_json({"ok": True}, 200)
            except Exception as exc:
                logger.exception(f"Voice transcription failed: {exc}")
                try:
                    from utils.telegram import send_message
                    send_message(chat_id,
                                 "Maaf, saya gagal membaca pesan suara Anda. 🙏")
                except Exception:
                    pass
                return self._send_json({"ok": True}, 200)

        # Text documents: read .txt/.md/.csv/.json and merge into the prompt.
        doc = message.get("document")
        if doc:
            caption_text = text or ""
            fname = (doc.get("file_name") or "").lower()
            mime = (doc.get("mime_type") or "").lower()
            if (fname.endswith((".txt", ".md", ".csv", ".json", ".log"))
                    or mime.startswith("text/")):
                try:
                    send_typing(chat_id)
                    from utils.download import download_file
                    data = download_file(doc["file_id"])
                    content = data.decode("utf-8", errors="replace")[:6000]
                    if not content.strip():
                        return self._send_json({"ok": True}, 200)
                    text = (f"[dokumen: {doc.get('file_name') or 'file'}]\n"
                            f"{content.strip()}")
                    if caption_text:
                        text += f"\n\nPenjelasan user: {caption_text.strip()}"
                except Exception as exc:
                    logger.exception(f"Document read failed: {exc}")
                    try:
                        from utils.telegram import send_message
                        send_message(
                            chat_id,
                            "Maaf, saya gagal membaca dokumen Anda. 🙏")
                    except Exception:
                        pass
                    return self._send_json({"ok": True}, 200)
            else:
                # Best-effort: extract text from PDF/DOCX/XLSX via E2B.
                try:
                    send_typing(chat_id)
                    import base64
                    from utils.download import download_file
                    from utils.e2b_executor import extract_document
                    data = download_file(doc["file_id"])
                    res = extract_document(fname, base64.b64encode(data).decode())
                    if not res.get("success") or not res.get("text", "").strip():
                        raise RuntimeError(res.get("error", "teks kosong"))
                    content = res["text"].strip()[:6000]
                    text = f"[dokumen: {doc.get('file_name') or 'file'}]\n{content}"
                    caption_text = (message.get("caption") or "").strip()
                    if caption_text:
                        text += f"\n\nPenjelasan user: {caption_text}"
                    logger.info(
                        f"Extracted {len(content)} chars from {fname} via E2B")
                except Exception as exc:
                    logger.exception(f"Doc extraction failed: {exc}")
                    try:
                        from utils.telegram import send_message
                        send_message(
                            chat_id,
                            "Dokumen ini belum bisa saya baca. Kirim format "
                            ".txt/.md/.csv/.json agar saya dapat memprosesnya. 🙏",
                        )
                    except Exception:
                        pass
                    return self._send_json({"ok": True}, 200)

        if not text or not chat_id:
            return self._send_json({"ok": True}, 200)

        # SELF-REFERENTIAL GUARD — answer directly from utils/identity.py
        # (single source of truth) BEFORE any routing decision. This covers
        # EVERY path — local device, cloud pipeline, force_local override —
        # so "siapa kamu" / "apa yang bisa kamu lakukan" NEVER reaches an LLM,
        # which would otherwise hallucinate (e.g. invent that JARVIS is about
        # money). We deliberately do NOT create a task row for this.
        try:
            from utils.identity import is_self_referential, SELF_REF_REPLY
            if is_self_referential(text):
                from utils.telegram import send_message
                send_message(chat_id, SELF_REF_REPLY)
                return self._send_json({"ok": True, "handled": "self_ref"}, 200)
        except Exception as exc:
            logger.exception(f"Self-ref guard failed (continuing): {exc}")

        # Photos: understand via Groq vision (Qwen multimodal), using the
        # caption as the instruction if present.
        if photo:
            try:
                send_typing(chat_id)
                from utils.vision import analyze_photo, _largest_photo
                from utils.telegram import send_message
                file_id = _largest_photo(message)
                answer = analyze_photo(file_id, text or "")
                send_message(chat_id, f"🖼 {answer[:3500]}")
                return self._send_json({"ok": True, "handled": "vision"}, 200)
            except Exception as exc:
                logger.exception(f"Photo analysis failed: {exc}")
                try:
                    from utils.telegram import send_message
                    send_message(
                        chat_id,
                        "Maaf, saya gagal menganalisis foto Anda. 🙏")
                except Exception:
                    pass
                return self._send_json({"ok": True}, 200)

        # 3a. Direct commands run without the agentic pipeline.
        try:
            from utils import commands as commands_utils
            if commands_utils.handle_command(chat_id, text, chat_id):
                logger.info(f"Command handled for chat {chat_id}: {text}")
                return self._send_json({"ok": True, "handled": "command"}, 200)
        except Exception as exc:
            logger.exception(f"Command handler failed: {exc}")

        # 3b. Enqueue the task in Supabase with status PENDING.
        try:
            task_id = _enqueue(chat_id, text, username, first_name)
            logger.info(f"Enqueued task {task_id} for chat {chat_id}")
        except Exception as exc:
            logger.exception(f"Failed to enqueue task: {exc}")
            return self._send_json({"ok": False, "error": "Enqueue failed"}, 200)

        # 3c. Model-router auto-escalation (free-tier deep models). If the
        #     message is confidently heavy (reasoning/code/research) we ask the
        #     opencode workflow to handle it with the strongest :free model and
        #     skip the local pipeline. This RUNS WITH THE NORMAL PIPELINE as
        #     fallback on any failure, so it never degrades the live behavior:
        #     dispatch_opencode returns False (never raises) when the PAT is
        #     missing or the GitHub dispatch fails -> local pipeline proceeds.
        #     Two safety gates keep it from firing on ambiguous input:
        #       (a) short follow-ups with no topic of their own ("riset lebih
        #           lanjut", "lanjutkan") are NOT escalated — a strong model
        #           with the bare phrase and no history fabricates a topic;
        #       (b) when we DO escalate, the recent conversation history is
        #           attached to the prompt so opencode has context to continue.
        try:
            from utils import model_router as mr
            from utils.commands import dispatch_opencode
            if mr.should_escalate(text) and not mr.is_continuation(text):
                mode, model = mr.escalation_plan(text)
                prompt = text
                try:
                    from utils.supabase_client import get_recent_history
                    history = get_recent_history(chat_id, limit=6)
                    if history:
                        ctx = "\n".join(
                            f"- {h.get('role', '?')}: "
                            f"{str(h.get('content', ''))[:300]}"
                            for h in history if h.get("content"))
                        if ctx:
                            prompt = (
                                "Konteks percakapan terakhir (lanjutkan dari "
                                f"sini):\n{ctx}\n\nPertanyaan pemilik: {text}")
                except Exception:
                    pass
                if dispatch_opencode(chat_id, prompt, mode=mode, model=model):
                    logger.info(
                        f"Auto-escalated task for chat {chat_id} ({mode})")
                    return self._send_json(
                        {"ok": True, "handled": "opencode_auto",
                         "mode": mode}, 200)
                logger.info(
                    f"Auto-escalation unavailable ({mode}); local pipeline")
        except Exception as exc:
            logger.exception(f"Auto-escalation error (continuing): {exc}")

        # 4. Hybrid router decides local vs cloud (Level 6). If the local
        #    device is not configured/unreachable, this degrades to cloud.
        #    A background thread is unreliable on Vercel (serverless isolates
        #    stop running as soon as the handler returns), leaving tasks
        #    PENDING forever. The daily cron (api/cron.py) acts as a safety
        #    net for any task that exceeds the function timeout.
        decision = "cloud"
        try:
            from api.hybrid_router import decide, route_and_execute
            d = decide(chat_id, text)
            decision = d["decision"]
        except Exception as exc:
            logger.info(f"hybrid router unavailable ({exc}); using cloud")

        # If routed local, try the device first; route_and_execute falls back
        # to cloud automatically when the device is unreachable.
        try:
            if decision in ("local", "force_local"):
                from api.hybrid_router import route_and_execute
                loc_decision, ok, err, _ = route_and_execute(
                    task_id, chat_id, text)
                if ok:
                    logger.info(f"Local execution ({loc_decision}) for {task_id}")
                    supabase_client.update_task(task_id, {"status": "DONE"})
                    return self._send_json({"ok": True, "task_id": task_id,
                                            "decision": loc_decision}, 200)
                logger.warning(
                    f"Local failed ({err}); seamless fallback for {task_id}")
                decision = "fallback"
        except Exception as exc:
            logger.warning(f"Local dispatch error ({exc}); using cloud")

        try:
            from api.orchestrator import _run_pipeline
            _run_pipeline(task_id, chat_id, text,
                          execution_location=hybrid_tag(decision))
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

    def _handle_callback(self, cb):
        chat = cb.get("message", {}).get("chat", {})
        chat_id = chat.get("id")
        callback_id = cb.get("id")
        data = cb.get("data", "")
        telegram_id = cb.get("from", {}).get("id")
        message_id = cb.get("message", {}).get("message_id", 0)
        if not chat_id or not callback_id:
            return self._send_json({"ok": True}, 200)
        try:
            from utils import commands as commands_utils
            commands_utils._cache_callback_message(callback_id, message_id)
            handled = commands_utils.handle_callback(
                chat_id, callback_id, data, telegram_id)
            if not handled:
                from utils.telegram import answer_callback_query
                answer_callback_query(callback_id, "Aksi tidak dikenali")
        except Exception as exc:
            logger.exception(f"Callback failed: {exc}")
        return self._send_json({"ok": True}, 200)

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
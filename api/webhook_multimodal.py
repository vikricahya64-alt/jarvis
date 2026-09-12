"""
Dedicated multimodal Telegram bridge (Level 4).

Handles non-text updates (photos, voice memos / audio, documents) on their own
endpoint with their own pipeline:
    * per-chat rate limiting (5 requests/minute, in-process token bucket),
    * size guard (max 10 MB/download attempt),
    * modality-specific understanding (Groq vision / Whisper / text-or-E2B
      document extraction),
    * optional knowledge-base storage with metadata (hybrid RAG),
    * routing into the orchestrator — or the swarm when the request is complex.

Signature verification matches api/webhook.py. Everything stays synchronous:
Vercel serverless rejects repeated asyncio.run() in one handler (EBUSY), so no
event loop is used on this path (see api/webhook.py docstring).
"""
import os
import json
import hmac
import time
import logging
from collections import deque
from http.server import BaseHTTPRequestHandler

from utils import supabase_client
from utils.telegram import send_message, send_typing

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("webhook.multimodal")

MAX_REQ_PER_MINUTE = int(os.getenv("MULTIMODAL_RPM", "5"))
MAX_FILE_BYTES = int(os.getenv("MULTIMODAL_MAX_BYTES", str(10 * 1024 * 1024)))

# (chat_id -> deque[timesteps]) — per-isolate token bucket. On serverless a
# new isolate re-seeds the window, which only *starts* empty; the bucket still
# catches bursts and is cheap enough to keep.
_hits: dict = {}


def _rate_limited(chat_id: int) -> bool:
    if chat_id is None:
        return False
    now = time.monotonic()
    dq = _hits.setdefault(chat_id, deque())
    while dq and dq[0] < now - 60:
        dq.popleft()
    if len(dq) >= MAX_REQ_PER_MINUTE:
        return True
    dq.append(now)
    return False


def _size_ok(message: dict) -> bool:
    """max file_size hint across photo sizes / voice / audio / document."""
    smallest = None
    for key in ("photo", "voice", "audio", "video_note", "video", "document"):
        item = message.get(key)
        if isinstance(item, list):  # photo -> sizes list
            sizes = [s.get("file_size") or 0 for s in item]
            smallest = min(sizes) if sizes else 0
        elif isinstance(item, dict):
            smallest = (item.get("file_size") or 0)
        if smallest is not None:
            return smallest <= MAX_FILE_BYTES
    return True


# ------------------------------------------------------------------
# Modality handlers (each returns trimmed text, may raise)
# ------------------------------------------------------------------
def _handle_photo(message: dict, caption: str) -> str:
    from utils.vision import analyze_photo, _largest_photo
    return analyze_photo(_largest_photo(message), caption or "")


def _handle_voice(message: dict) -> str:
    from utils.audio import transcribe_voice
    media = message.get("voice") or message.get("audio")
    transcript = transcribe_voice(media["file_id"])
    if not transcript:
        raise RuntimeError("transkripsi kosong")
    return f"[pesan suara] {transcript}"


def _handle_document(message: dict, caption: str) -> str:
    """Read text files directly; extract PDF/DOCX/XLSX via E2B. Returns a
    summary text embedding the document content for the orchestrator."""
    from utils.download import download_file
    from utils.e2b_executor import extract_document
    import base64

    doc = message["document"]
    fname = (doc.get("file_name") or "file").lower()
    mime = (doc.get("mime_type") or "").lower()
    data = download_file(doc["file_id"])

    if (fname.endswith((".txt", ".md", ".csv", ".json", ".log"))
            or mime.startswith("text/")):
        content = data.decode("utf-8", errors="replace")[:6000].strip()
        if not content:
            raise RuntimeError("dokumen kosong")
    else:
        res = extract_document(fname, base64.b64encode(data).decode())
        if not (res.get("success") and (res.get("text") or "").strip()):
            raise RuntimeError(res.get("error") or "ekstraksi dokumen gagal")
        content = res["text"].strip()[:6000]

    # Knowledge-base store with metadata (hybrid RAG upgrade path).
    try:
        from utils.documents import store_document
        store_document(
            doc.get("file_name") or "dokumen",
            content,
            source="telegram",
            metadata={"kind": "telegram-document", "mime": mime,
                      "size_bytes": len(data)},
        )
    except Exception as exc:
        logger.debug(f"store_document skipped: {exc}")

    text = f"[dokumen: {doc.get('file_name') or 'file'}]\n{content}"
    if caption:
        text += f"\n\nPenjelasan user: {caption.strip()}"
    return text


# ------------------------------------------------------------------
# Text pipeline (orchestrator or swarm)
# ------------------------------------------------------------------
def _enqueue_and_run(chat_id: int, text: str, username=None,
                     first_name=None) -> str:
    profile = supabase_client.get_or_create_profile(chat_id, username, first_name)
    task_id = supabase_client.insert_task(chat_id, text, profile["id"])
    logger.info(f"Multimodal enqueued task {task_id} for chat {chat_id}")

    if _use_swarm(text):
        try:
            from api.swarm_coordinator import handle_parent_task
            handle_parent_task(task_id, chat_id, text)
        except Exception as exc:
            logger.exception(f"Swarm parent failed for {task_id}")
            _mark_failed_and_retry(task_id, chat_id, text, exc)
    else:
        try:
            from api.orchestrator import _run_pipeline
            _run_pipeline(task_id, chat_id, text)
        except Exception as exc:
            _mark_failed_and_retry(task_id, chat_id, text, exc)
    return task_id


def _mark_failed_and_retry(task_id, chat_id, text, exc):
    """Best-effort: record failure, tell the user the task was saved for a
    cron retry instead of dying silently."""
    try:
        supabase_client.update_task(task_id, {
            "status": "FAILED",
            "error": str(exc)[:500],
        })
    except Exception:
        pass
    try:
        send_message(
            chat_id,
            "Ups, proses permintaan ini sempat gagal di jalur multimodal. "
            "Permintaan sudah tercatat; saya akan coba lagi lewat cron. 🙏",
        )
    except Exception:
        pass


def _use_swarm(text: str) -> bool:
    try:
        from api.swarm_coordinator import should_swarm
        return should_swarm(text)
    except Exception:
        return False


# ------------------------------------------------------------------
# Core media processing (shared by this endpoint and the main webhook)
# ------------------------------------------------------------------
def process_update(update: dict) -> tuple:
    """Handle a single Telegram update carrying media.

    Returns (payload_dict, http_status). Raise-free: every branch returns a
    deterministic payload so both call sites (this handler and api/webhook.py,
    which reuses this to keep one media pipeline) can respond cleanly.
    """
    message = update.get("message") or update.get("edited_message")
    if not message:
        return {"ok": True}, 200

    chat_id = message.get("chat", {}).get("id")
    media = _detect_media(message)
    if not media:
        return {"ok": True, "handled": False}, 200

    if _rate_limited(chat_id):
        try:
            send_message(chat_id, "Terlalu banyak permintaan media. "
                                  "Tunggu sebentar (maks 5/menit). ⏳")
        except Exception:
            pass
        return {"ok": True, "handled": "rate_limited"}, 200

    if not _size_ok(message):
        try:
            send_message(chat_id, "File terlalu besar (>10 MB). 🙏")
        except Exception:
            pass
        return {"ok": True, "handled": "too_large"}, 200

    username = message.get("from", {}).get("username")
    first_name = message.get("from", {}).get("first_name")
    caption = message.get("caption") or ""
    kind = media

    try:
        send_typing(chat_id)
        if kind == "photo":
            text = _handle_photo(message, caption)
        elif kind in ("voice", "audio"):
            text = _handle_voice(message)
        else:  # document
            text = _handle_document(message, caption)
    except Exception as exc:
        logger.exception(f"{kind} handling failed: {exc}")
        try:
            msg = {
                "photo": "Maaf, saya gagal menganalisis foto Anda. 🙏",
                "voice": "Maaf, saya gagal membaca pesan suara Anda. 🙏",
                "audio": "Maaf, saya gagal membaca file audio Anda. 🙏",
                "document": "Dokumen belum bisa saya baca. Kirim .txt/.md/"
                            ".csv/.json agar saya dapat memprosesnya. 🙏",
            }.get(kind, "Maaf, saya gagal memproses media ini. 🙏")
            send_message(chat_id, msg)
        except Exception:
            pass
        return {"ok": True, "handled": f"{kind}:error"}, 200

    if not text or not text.strip():
        return {"ok": True, "handled": "empty"}, 200

    try:
        task_id = _enqueue_and_run(chat_id, text.strip(), username, first_name)
        return {"ok": True, "task_id": task_id, "handled": kind}, 200
    except Exception as exc:
        logger.exception(f"Pipeline failed after {kind}: {exc}")
        try:
            send_message(
                chat_id,
                "Ups, ada kendala memproses hasil media Anda. "
                "Kendala sudah tercatat. 🙏",
            )
        except Exception:
            pass
        return {"ok": True, "handled": f"{kind}:pipeline_error"}, 200

# ------------------------------------------------------------------
# HTTP endpoint
# ------------------------------------------------------------------
class handler(BaseHTTPRequestHandler):

    def do_GET(self):
        self._send_json({"ok": True, "service": "J.A.R.V.I.S. multimodal"}, 200)

    def do_POST(self):
        if not self._verify_signature():
            return self._send_json({"ok": False, "error": "Invalid signature"}, 403)
        try:
            update = self._read_json()
        except Exception:
            return self._send_json({"ok": False, "error": "Bad JSON"}, 400)
        payload, status = process_update(update)
        return self._send_json(payload, status)

    # ------------------------------------------------------------------
    def _verify_signature(self) -> bool:
        token = self.headers.get("X-Telegram-Bot-Api-Secret-Token", "")
        secret = os.getenv("TELEGRAM_SECRET_TOKEN", "")
        if not secret:
            return True
        return hmac.compare_digest(token, secret)

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


def _detect_media(message: dict):
    if message.get("photo"):
        return "photo"
    if message.get("voice"):
        return "voice"
    if message.get("audio"):
        return "audio"
    if message.get("document"):
        return "document"
    return None
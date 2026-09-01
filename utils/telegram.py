"""
Telegram Bot API helper: send text messages and documents to users.

Synchronous implementation (httpx.Client) to avoid event-loop issues
inside Vercel serverless functions. The bot API has no streaming/multi
requirement, so sync calls are fine.
"""
import os
import httpx

API_URL = "https://api.telegram.org/bot{token}/{method}"


def get_token() -> str:
    token = os.getenv("TELEGRAM_TOKEN")
    if not token:
        raise RuntimeError("TELEGRAM_TOKEN is not configured")
    return token


def send_message(chat_id: int, text: str, parse_mode: str = None) -> bool:
    """Send a plain/text or HTML message to a chat.

    No parse_mode by default: LLM answers are Markdown, not HTML, and
    sending Markdown with parse_mode=HTML makes Telegram reject the request
    (HTTP 400). Plain text always succeeds; Markdown renders as-is.
    """
    token = get_token()
    url = API_URL.format(token=token, method="sendMessage")
    payload = {"chat_id": chat_id, "text": text}
    if parse_mode:
        payload["parse_mode"] = parse_mode
    try:
        with httpx.Client(timeout=15) as client:
            r = client.post(url, json=payload)
            return r.status_code == 200
    except Exception:
        return False


def send_document(chat_id: int, file_url: str, caption: str = "") -> bool:
    """Send a document/file to a chat by URL (e.g., a Supabase storage URL)."""
    token = get_token()
    url = API_URL.format(token=token, method="sendDocument")
    payload = {
        "chat_id": chat_id,
        "document": file_url,
        "caption": caption,
    }
    try:
        with httpx.Client(timeout=20) as client:
            r = client.post(url, json=payload)
            return r.status_code == 200
    except Exception:
        return False


def send_typing(chat_id: int) -> bool:
    """Send a 'typing...' chat action so the user knows the bot is working."""
    token = get_token()
    url = API_URL.format(token=token, method="sendChatAction")
    payload = {"chat_id": chat_id, "action": "typing"}
    try:
        with httpx.Client(timeout=10) as client:
            r = client.post(url, json=payload)
            return r.status_code == 200
    except Exception:
        return False
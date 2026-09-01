"""
Telegram Bot API helper: send text messages and documents to users.

Uses the Bot API token stored as an environment variable.
"""
import os
import httpx
import asyncio

API_URL = "https://api.telegram.org/bot{token}/{method}"


def get_token() -> str:
    token = os.getenv("TELEGRAM_TOKEN")
    if not token:
        raise RuntimeError("TELEGRAM_TOKEN is not configured")
    return token


async def send_message(chat_id: int, text: str, parse_mode: str = "HTML") -> bool:
    """Send a plain/text or HTML message to a chat."""
    token = get_token()
    url = API_URL.format(token=token, method="sendMessage")
    payload = {"chat_id": chat_id, "text": text}
    if parse_mode:
        payload["parse_mode"] = parse_mode
    try:
        async with httpx.AsyncClient(timeout=15) as client:
            r = await client.post(url, json=payload)
            return r.status_code == 200
    except Exception:
        return False


async def send_document(chat_id: int, file_url: str, caption: str = "") -> bool:
    """Send a document/file to a chat by URL (e.g., a Supabase storage URL)."""
    token = get_token()
    url = API_URL.format(token=token, method="sendDocument")
    payload = {
        "chat_id": chat_id,
        "document": file_url,
        "caption": caption,
    }
    try:
        async with httpx.AsyncClient(timeout=20) as client:
            r = await client.post(url, json=payload)
            return r.status_code == 200
    except Exception:
        return False


async def send_typing(chat_id: int) -> bool:
    """Send a 'typing...' chat action so the user knows the bot is working."""
    token = get_token()
    url = API_URL.format(token=token, method="sendChatAction")
    payload = {"chat_id": chat_id, "action": "typing"}
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            r = await client.post(url, json=payload)
            return r.status_code == 200
    except Exception:
        return False

"""
Shared helpers to download a message file (voice/photo) from Telegram by
file_id via Bot API.
"""
import os
import httpx

BOT_FILE_URL = "https://api.telegram.org/bot{token}/getFile"
DOWNLOAD_URL = "https://api.telegram.org/file/bot{token}/{file_path}"


def get_file_path(file_id: str) -> str:
    token = os.getenv("TELEGRAM_TOKEN")
    with httpx.Client(timeout=15) as client:
        r = client.get(BOT_FILE_URL.format(token=token),
                       params={"file_id": file_id})
        r.raise_for_status()
        data = r.json()
        if not data.get("ok"):
            raise RuntimeError(data.get("description", "getFile failed"))
        path = data["result"].get("file_path")
        if not path:
            raise RuntimeError("file_path kosong (mungkin file >20MB)")
        return path


def download_file(file_id: str) -> bytes:
    token = os.getenv("TELEGRAM_TOKEN")
    path = get_file_path(file_id)
    with httpx.Client(timeout=30) as client:
        r = client.get(DOWNLOAD_URL.format(token=token, file_path=path))
        r.raise_for_status()
        return r.content
"""
Telegram voice-memo transcription via Groq Whisper (free tier, reuses the
existing GROQ_API_KEY). Downloads the audio from Telegram by file_id, then
transcribes it to text. Returns plain text or raises.
"""
import io
import os
import httpx

BOT_FILE_URL = "https://api.telegram.org/bot{token}/getFile"
DOWNLOAD_URL = "https://api.telegram.org/file/bot{token}/{file_path}"


def _get_file_path(token: str, file_id: str) -> str:
    with httpx.Client(timeout=15) as client:
        r = client.get(
            BOT_FILE_URL.format(token=token),
            params={"file_id": file_id},
        )
        r.raise_for_status()
        data = r.json()
        if not data.get("ok"):
            raise RuntimeError(data.get("description", "getFile failed"))
        path = data["result"].get("file_path")
        if not path:
            raise RuntimeError("file_path kosong (mungkin file >20MB)")
        return path


def _download(token: str, file_path: str) -> bytes:
    with httpx.Client(timeout=30) as client:
        r = client.get(DOWNLOAD_URL.format(token=token, file_path=file_path))
        r.raise_for_status()
        return r.content


def transcribe_voice(file_id: str) -> str:
    """Download a Telegram voice file and transcribe it with Groq Whisper."""
    from groq import Groq  # imported lazily: only needed for voice messages

    api_key = os.getenv("GROQ_API_KEY")
    token = os.getenv("TELEGRAM_TOKEN")
    if not api_key or not token:
        raise RuntimeError("GROQ_API_KEY/TELEGRAM_TOKEN not configured")

    path = _get_file_path(token, file_id)
    data = _download(token, path)

    client = Groq(api_key=api_key, timeout=30)
    result = client.audio.transcriptions.create(
        model="whisper-large-v3-turbo",
        file=io.BytesIO(data),
        language="id",
        response_format="text",
    )
    text = result if isinstance(result, str) else getattr(result, "text", "")
    return (text or "").strip()
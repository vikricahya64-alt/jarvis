"""
Telegram voice-memo transcription via Groq Whisper (free tier, reuses the
existing GROQ_API_KEY). Downloads the audio from Telegram by file_id, then
transcribes it to text. Returns plain text or raises.
"""
import io
import os

from utils.download import get_file_path, download_file


def transcribe_voice(file_id: str) -> str:
    """Download a Telegram voice file and transcribe it with Groq Whisper."""
    from groq import Groq  # imported lazily: only needed for voice messages

    api_key = os.getenv("GROQ_API_KEY")
    if not api_key:
        raise RuntimeError("GROQ_API_KEY not configured")

    path = get_file_path(file_id)
    data = download_file(file_id)

    ext = path.rsplit(".", 1)[-1].lower() if "." in path else "ogg"
    if ext not in {"flac", "mp3", "mp4", "mpeg", "mpga", "m4a", "ogg",
                   "opus", "wav", "webm"}:
        ext = "ogg"
    mime = {
        "flac": "audio/flac", "mp3": "audio/mpeg", "mp4": "audio/mp4",
        "mpeg": "audio/mpeg", "mpga": "audio/mpeg", "m4a": "audio/mp4",
        "ogg": "audio/ogg", "opus": "audio/ogg", "wav": "audio/wav",
        "webm": "audio/webm",
    }.get(ext, "audio/ogg")

    client = Groq(api_key=api_key, timeout=30)
    result = client.audio.transcriptions.create(
        model="whisper-large-v3-turbo",
        file=(f"voice.{ext}", io.BytesIO(data), mime),
        language="id",
        response_format="text",
    )
    text = result if isinstance(result, str) else getattr(result, "text", "")
    return (text or "").strip()
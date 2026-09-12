"""
Photo understanding via Groq's multimodal Qwen model (free tier).
Downloads the photo, base64-encodes it, and asks the model to describe it or
answer the user's caption instruction in Indonesian.
"""
import base64
import os
import re

import httpx

VISION_MODEL = "qwen/qwen3.6-27b"
_MAX_TOKENS = 900


def _largest_photo(message: dict) -> str:
    """Return the file_id of the largest photo size in a message."""
    sizes = message.get("photo") or []
    if not sizes:
        raise RuntimeError("tidak ada foto")
    best = max(sizes, key=lambda s: s.get("file_size") or 0)
    return best["file_id"]


def analyze_photo(file_id: str, instruction: str = "") -> str:
    """Describe / answer about a Telegram photo. Returns text (may raise)."""
    from utils.download import download_file

    api_key = os.getenv("GROQ_API_KEY")
    if not api_key:
        raise RuntimeError("GROQ_API_KEY not configured")

    data = download_file(file_id)
    b64 = base64.b64encode(data).decode()
    url = f"data:image/png;base64,{b64}"

    prompt = (
        instruction.strip()
        or "Deskripsikan gambar ini secara detail dalam bahasa Indonesia: "
           "sebutkan objek utama, kondisi, serta teks/tulisan yang terlihat."
    )
    system = (
        "Kamu asisten AI di Telegram. Jawab dalam bahasa Indonesia, ringkas "
        "tapi lengkap, sesuai yang diminta pengguna tentang gambar."
    )

    payload = {
        "model": VISION_MODEL,
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": [
                {"type": "text", "text": prompt},
                {"type": "image_url", "image_url": {"url": url}},
            ]},
        ],
        "temperature": 0.2,
        "max_tokens": _MAX_TOKENS,
    }
    with httpx.Client(timeout=45) as client:
        last_err = ""
        for attempt in range(4):
            r = client.post(
                "https://api.groq.com/openai/v1/chat/completions",
                headers={"Authorization": f"Bearer {api_key}"},
                json=payload,
            )
            if r.status_code == 200:
                break
            body = r.json().get("error", {})
            last_err = body.get("message", r.text)[:200]
            if r.status_code == 503:  # over capacity: brief backoff
                import time
                time.sleep((attempt + 1) * 3)
                continue
            raise RuntimeError(f"Groq vision {r.status_code}: {last_err}")
        else:
            raise RuntimeError(f"Groq vision 503: {last_err}")
    content = r.json()["choices"][0]["message"]["content"] or ""
    return _strip_thinking(content).strip()


def _strip_thinking(content: str) -> str:
    """Remove Qwen's leading 'thinking' reasoning block from the answer."""
    parts = re.split(r"\n\s*response\s*\n", content)
    if len(parts) > 1:
        return parts[-1].strip()
    c = content.strip()
    if c.lower().startswith("thinking"):
        idx = c.find("\n\n")
        if idx != -1 and idx < len(c) * 0.7:
            c = c[idx + 2:]
    return c.strip()
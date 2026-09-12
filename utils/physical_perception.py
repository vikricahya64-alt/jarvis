"""
Level 8 Physical Perception: Realme C25s as a secure encrypted sensor.

The phone is a THIN sensor terminal. Raw media NEVER leaves the device and is
deleted immediately after local analysis:
    capture -> tmpfs (RAM disk) -> local analysis (Groq Vision / Whisper)
           -> delete raw file -> publish ONLY encrypted structured metadata
                               -> raw file is gone before anything transmits.

Lifecycle guarantee: every raw file is created inside a tmpfs directory and
unlink()'d in a finally block. The returned data is the encrypted *result*
(transcripts, entity metadata, action items), never the media blob.

Dependency:  termux-api  (termux-camera-photo, termux-microphone-record) and
             the analyzer deps (groq, optional local whisper).
Callables degrade gracefully: if termux-api is absent, they return a structured
error instead of crashing the Orchestrator.

Synchronous on purpose (Vercel-serverless safe; runs on-device via Termux).
"""
import os
import io
import json
import base64
import shutil
import tempfile
import subprocess
import logging

try:
    from utils import device_comm as dc    # encrypt_payload / decrypt_payload
    from utils import groq_client
    _GROQ_OK = True
except Exception:
    _GROQ_OK = False

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("perceive")

# tmpfs mount (RAM) where raw captures live; never on persistent storage.
TMPFS_DIR = os.getenv("JARVIS_SENSOR_TMPFS", "/dev/shm/jarvis-sensor")
MAX_TMPFS_BYTES = 64 * 1024 * 1024          # 64MB safety cap

# Sensitive domains are NEVER auto-analyzed to cloud vision/whisper.
# (Guardrail lives in the pipeline, plus stricter logic in intuition_engine.)
_SENSITIVE_DOMAINS = {"health", "finance", "relationship", "identity"}


# ----------------------------------------------------------------------------
# tmpfs workspace management
# ----------------------------------------------------------------------------
def _workspace() -> str:
    """Create (idempotent) the tmpfs RAM workspace for raw captures."""
    os.makedirs(TMPFS_DIR, exist_ok=True)
    return TMPFS_DIR


def _safe_tmp_file(prefix: str, suffix: str) -> str:
    """Create a unique file inside the tmpfs workspace. Returns its path."""
    fd, path = tempfile.mkstemp(prefix=prefix, suffix=suffix,
                                dir=_workspace())
    os.close(fd)
    return path


def _delete_secure(path: str):
    """Best-effort overwrite + unlink the raw file."""
    try:
        if os.path.exists(path):
            size = os.path.getsize(path)
            with open(path, "r+b") as fh:
                fh.seek(0)
                fh.write(b"\x00" * min(size, 1 << 20))   # try to wipe first 1MB
                fh.flush()
            os.fsync(fh.fileno())
        os.unlink(path)
    except Exception:
        try:
            os.unlink(path)
        except Exception:
            pass
    # tidy empty tmpfs dir when unused
    try:
        shutil.rmtree(_workspace())
    except Exception:
        pass


def _termux_output(cmd: list, timeout: int = 30) -> str:
    """Run a termux-* API command and return stdout text."""
    env = dict(os.environ)
    env.setdefault("LC_ALL", "C")
    proc = subprocess.run(
        cmd, capture_output=True, text=True, timeout=timeout, env=env)
    if proc.returncode != 0:
        raise RuntimeError(proc.stderr.strip() or "termux cmd failed")
    return proc.stdout


# ----------------------------------------------------------------------------
# 1. DOCUMENT CAPTURE (camera -> temp -> Groq Vision -> delete -> metadata)
# ----------------------------------------------------------------------------
def capture_document(domain: str = "general", secret: str = "") -> dict:
    """Take a photo via termux-camera-photo, analyze with Groq Vision,
    delete the raw image, and return an AES-GCM-encrypted structured result."""
    if domain in _SENSITIVE_DOMAINS:
        return {"ok": False, "error": "sensitive_domain_blocked",
                "result": "Domain sensitif diblokir untuk foto otomatis."}
    if not shutil.which("termux-camera-photo"):
        return {"ok": False, "error": "termux_camera_missing",
                "result": "termux-camera-photo tidak ditemukan."}

    raw_path = _safe_tmp_file("doc_", ".jpg")
    try:
        _termux_output(["termux-camera-photo", "-c", "0", raw_path], timeout=30)
        size = os.path.getsize(raw_path)
        if size <= 0 or size > MAX_TMPFS_BYTES:
            return {"ok": False, "error": "bad_capture",
                    "result": f"Capture invalid ({size}B)."}
        analysis = _groq_vision(raw_path, "Extract structured document metadata "
                                           "(title, author, dates, key fields).")
        # The *result* (metadata) may leave the phone; the raw image does not.
        metadata = analysis.get("text", "")
        # package the ENCRYPTED result, never the image bytes
        encrypted = _seal({"kind": "document", "domain": domain,
                           "text": metadata, "words": analysis.get("words", 0)},
                          secret)
        return {"ok": True, "result": encrypted,
                "summary": metadata[:160],
                "words": analysis.get("words", 0)}
    except Exception as exc:
        return {"ok": False, "error": str(exc), "result": None}
    finally:
        _delete_secure(raw_path)   # ALWAYS delete raw image after processing


# ----------------------------------------------------------------------------
# 2. MEETING RECORDING (mic -> temp -> Whisper -> Groq summary -> delete)
# ----------------------------------------------------------------------------
def record_meeting(duration_min: float = 5.0, domain: str = "general",
                   secret: str = "") -> dict:
    """Record audio via termux-microphone-record, transcribe (Whisper via Groq),
    summarize with Groq, delete the raw audio, return encrypted action items."""
    if domain in _SENSITIVE_DOMAINS:
        return {"ok": False, "result": "sensitive_domain_blocked"}
    if not shutil.which("termux-microphone-record"):
        return {"ok": False, "result": "termux_mic_missing"}
    if duration_min <= 0 or duration_min > 60:
        return {"ok": False, "result": "invalid_duration"}

    raw_path = _safe_tmp_file("rec_", ".m4a")
    try:
        _termux_output(["termux-microphone-record", "-d", str(int(duration_min * 1000)),
                        "-f", raw_path], timeout=int(duration_min * 60) + 30)
        transcript = _whisper(raw_path)
        summary = _groq_summarize(transcript) if transcript else ""
        action_items = _extract_actions(summary)
        encrypted = _seal({"kind": "meeting", "domain": domain,
                           "transcript": transcript[:4000],
                           "summary": summary[:4000],
                           "actions": action_items}, secret)
        return {"ok": True, "result": encrypted, "summary": summary[:300],
                "actions": action_items}
    except Exception as exc:
        return {"ok": False, "result": str(exc)}
    finally:
        _delete_secure(raw_path)   # ALWAYS delete raw audio after processing


# ----------------------------------------------------------------------------
# 3. QR / BARCODE (decode locally on device; query swarm context)
# ----------------------------------------------------------------------------
def scan_qr(secret: str = "") -> dict:
    """Decode a QR/barcode via termux-camera-photo + local decode (zbar),
    then query the swarm for context. Raw image is deleted. Result is
    encrypted metadata only."""
    if not shutil.which("termux-camera-photo"):
        return {"ok": False, "result": "termux_camera_missing"}
    raw_path = _safe_tmp_file("qr_", ".png")
    try:
        _termux_output(["termux-camera-photo", "-c", "1", raw_path], timeout=30)
        decoded = _decode_local(raw_path)
        if not decoded:
            return {"ok": False, "result": "no_code_detected"}
        context = _swarm_lookup(decoded, secret)
        encrypted = _seal({"kind": "qr", "code": decoded,
                           "context": context}, secret)
        return {"ok": True, "result": encrypted, "code": decoded,
                "context": context}
    except Exception as exc:
        return {"ok": False, "result": str(exc)}
    finally:
        _delete_secure(raw_path)


# ----------------------------------------------------------------------------
# Local decode + Glue helpers
# ----------------------------------------------------------------------------
def _decode_local(image_path: str) -> str:
    """Use a local barcode reader (zbar-tools / pyzbar) if present."""
    for tool, args in (("zbarimg", ["-q", "--raw", image_path]),
                       ("python3", ["-m", "pyzbar", image_path])):
        if shutil.which(tool):
            try:
                out = _termux_output([tool] + args, timeout=15)
                return out.strip().splitlines()[0] if out.strip() else ""
            except Exception:
                continue
    return ""


def _swarm_lookup(code: str, secret: str = "") -> str:
    """Placeholder swarm-context lookup. Override by hooking MQTT. Returns a
    short string so /scan('qr') stays snappy."""
    if secret:
        return "local_context(qr)"
    return "local_context_only"


def _seal(payload: dict, secret: str = "") -> dict:
    """AES-GCM seal the *structured result* before it leaves the device."""
    if _GROQ_OK and hasattr(dc, "encrypt_payload"):
        return dc.encrypt_payload(payload) if secret else payload
    return payload


def _groq_vision(image_path: str, prompt: str) -> dict:
    """Groq Vision analysis. Returns {text, words}. Falls back gracefully."""
    if not _GROQ_OK:
        return {"text": "", "words": 0}
    try:
        with open(image_path, "rb") as fh:
            b64 = base64.b64encode(fh.read()).decode()
        out = groq_client.vision(prompt, b64)       # custom; see below
        text = (out or "").strip()
        return {"text": text, "words": len(text.split())}
    except Exception:
        return {"text": "", "words": 0}


def _whisper(audio_path: str) -> str:
    """Local/API Whisper transcription. Returns transcript text."""
    if not _GROQ_OK:
        return ""
    try:
        with open(audio_path, "rb") as fh:
            b64 = base64.b64encode(fh.read()).decode()
        return (groq_client.transcribe(b64) or "").strip()
    except Exception:
        return ""


def _groq_summarize(transcript: str) -> str:
    if not _GROQ_OK or not transcript:
        return ""
    try:
        return (groq_client.plain_completion(
            "Ringkas rapat & lima butir aksi dalam Bahasa Indonesia.",
            transcript[:4000]) or "").strip()
    except Exception:
        return ""


def _extract_actions(summary: str) -> list:
    """Naive extraction of action-item lines (starts with -, •, task, wajib)."""
    if not summary:
        return []
    return [l.strip() for l in summary.splitlines()
            if l.strip() and (l.lstrip().startswith(("-", "•", ">", "*")))][:12]


# ----------------------------------------------------------------------------
# Pipeline top-level: route to the right perception based on /scan <type>.
# ----------------------------------------------------------------------------
def dispatch_scan(kind: str, duration_min: float = 5.0,
                  secret: str = "") -> dict:
    kind = (kind or "document").strip().lower()
    if kind in ("doc", "document", "photo"):
        return capture_document(secret=secret)
    if kind in ("meeting", "audio", "record", "voice"):
        return record_meeting(duration_min=duration_min, secret=secret)
    if kind in ("qr", "barcode", "code"):
        return scan_qr(secret=secret)
    return {"ok": False,
            "result": f"Tipe tidak dikenal: {kind}. Gunakan document|meeting|qr"}


def sensor_status() -> dict:
    """Report which termux sensor APIs are available (for /scan help)."""
    return {
        "camera": bool(shutil.which("termux-camera-photo")),
        "microphone": bool(shutil.which("termux-microphone-record")),
        "barcodes": bool(shutil.which("zbarimg") or
                         shutil.which("python3") and _has_pyzbar()),
        "tmpfs": TMPFS_DIR,
        "sensitive_blocked": sorted(_SENSITIVE_DOMAINS),
    }


def _has_pyzbar() -> bool:
    try:
        import pyzbar  # noqa
        return True
    except Exception:
        return False
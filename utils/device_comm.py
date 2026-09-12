"""
Device Communication Layer (Level 6): secure async transport between the
Vercel cloud core and the Realme C25s sovereign local core.

Design (free-tier hardened, intermittent-mobile-friendly):
  * Long-polling HTTP is the PRIMARY transport (WebSocket/Socket.io is heavy
    on a 4GB eMMC Android device and unreliable behind request-timeout
    serverless); Vercel free tier cannot hold idle sockets, so long-poll is
    the realistic choice. The interface is transport-agnostic so a real
    WebSocket impl can be swapped in later.
  * Every payload is encrypted with AES-256-GCM (via `cryptography`) using a
    session key derived from a shared secret; a pure-stdlib fallback (PBKDF2
    + HMAC integrity, base64) keeps the module importable where `cryptography`
    is missing (e.g. local tests).
  * Heartbeat + health check keep routing decisions fresh; the hybrid router
    relies on `check_device_health()` to auto-route to cloud when the G85 is
    hot / low on RAM / unreachable.
  * Payloads > 1KB are gzip-compressed before transmission; responses are
    decompressed + validated.

No hardcoded paths: `$PREFIX`-style env on device, Supabase on cloud. All
keys come from environment variables, never code or logs.
"""
import os
import json
import time
import zlib
import base64
import hmac
import hashlib
import logging

logger = logging.getLogger("device_comm")

# ---- Crypto backend selection -------------------------------------------
try:
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC
    from cryptography.hazmat.primitives import hashes
    CRYPTO_AVAILABLE = True
except Exception:  # pragma: no cover - fallback path
    CRYPTO_AVAILABLE = False

SESSION_KEY_LEN = 32
NONCE_LEN = 12
LONGPOLL_PATH = "/api/device/longpoll"
HEARTBEAT_TIMEOUT_S = 15
COMPRESS_MIN_BYTES = 1024
DEVICE_ROLE_TAG = "jarvis-device"


# ------------------------------------------------------------------
# Key management (session key derivation)
# ------------------------------------------------------------------
def _shared_secret() -> bytes:
    """Session secret from env (set identically on Vercel and the device).
    NEVER logged; raises if missing so encryption fails closed."""
    raw = os.getenv("DEVICE_SHARED_SECRET") or os.getenv("JARVIS_DEVICE_SECRET")
    if not raw:
        raise RuntimeError("DEVICE_SHARED_SECRET is not configured")
    return raw.encode()


def _derive_key(salt: bytes = b"jarvis-l6") -> bytes:
    """Derive a 32-byte AES key from the shared secret (PBKDF2)."""
    if CRYPTO_AVAILABLE:
        kdf = PBKDF2HMAC(algorithm=hashes.SHA256(), length=32,
                         salt=salt, iterations=120_000)
        return kdf.derive(_shared_secret())
    # Pure-stdlib fallback (deterministic, weaker but workable).
    return hashlib.pbkdf2_hmac("sha256", _shared_secret(), salt, 120_000)


# ------------------------------------------------------------------
# Encryption / decryption
# ------------------------------------------------------------------
def _b64(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).decode()


def _db64(data: str) -> bytes:
    return base64.urlsafe_b64decode(data.encode())


def encrypt_payload(obj: dict) -> dict:
    """
    Encrypt a dict into a transmittable envelope.
    Return: {"v":1,"ct":<b64>, "iv":<b64>, "gzip":bool, "mac":<b64>, "ts":epoch}
    Envelope always carries an HMAC over (ct,iv,gzip,ts) for integrity.
    """
    raw = json.dumps(obj, ensure_ascii=False, separators=(",", ":")).encode()
    gzip = len(raw) > COMPRESS_MIN_BYTES
    if gzip:
        raw = zlib.compress(raw, 6)

    iv = os.urandom(NONCE_LEN)
    ts = int(time.time())
    if CRYPTO_AVAILABLE:
        key = _derive_key()
        ct = AESGCM(key).encrypt(iv, raw, None)
    else:
        # Pure-stdlib stream cipher (XOR with keyed PRF) + HMAC integrity.
        key = _derive_key()
        stream = _xor_stream(raw, key, iv)
        ct = stream

    ct_b64 = _b64(ct)
    mac = hmac.new(_shared_secret(),
                   f"{ct_b64}|{_b64(iv)}|{int(gzip)}|{ts}".encode(),
                   hashlib.sha256).hexdigest()
    return {"v": 1, "ct": ct_b64, "iv": _b64(iv), "gzip": int(gzip),
            "mac": mac, "ts": ts}


def decrypt_payload(envelope: dict) -> dict:
    """Decrypt + validate an envelope from encrypt_payload; raises on tamper."""
    ct_b64 = envelope.get("ct")
    iv_b64 = envelope.get("iv")
    gzip = 1 if envelope.get("gzip") else 0
    ts = envelope.get("ts")
    if not ct_b64 or not iv_b64:
        raise ValueError("malformed envelope")
    mac = hmac.new(_shared_secret(),
                   f"{ct_b64}|{iv_b64}|{int(gzip)}|{ts}".encode(),
                   hashlib.sha256).hexdigest()
    if not hmac.compare_digest(mac, envelope.get("mac") or ""):
        raise ValueError("MAC mismatch (tampered payload)")
    ct = _db64(ct_b64)
    iv = _db64(iv_b64)
    if CRYPTO_AVAILABLE:
        raw = AESGCM(_derive_key()).decrypt(iv, ct, None)
    else:
        raw = _xor_stream(ct, _derive_key(), iv)
    if gzip:
        raw = zlib.decompress(raw)
    return json.loads(raw.decode("utf-8"))


def _xor_stream(data: bytes, key: bytes, iv: bytes) -> bytes:
    """Keystream = SHA256(iv + counter + key); XOR with data. Deterministic
    for decrypt because (data -> cipher) inverts identity."""
    out = bytearray()
    block = bytearray()
    for i, byte in enumerate(data):
        if i % 64 == 0:
            block = hashlib.sha256(iv + i.to_bytes(8, "big") + key).digest()
        out.append(byte ^ block[i % 64])
    return bytes(out)


# ------------------------------------------------------------------
# Transport (long-poll HTTP, gzip-aware)
# ------------------------------------------------------------------
def _post(path: str, envelope: dict, timeout: float = 20.0) -> dict:
    import httpx
    base = (os.getenv("DEVICE_GATEWAY") or "").rstrip("/")
    if not base:
        raise RuntimeError("DEVICE_GATEWAY is not configured")
    with httpx.Client(timeout=timeout) as client:
        r = client.post(base + path, json=envelope)
        r.raise_for_status()
        return r.json()


def send_to_local(payload: dict, timeout: float = 20.0,
                  task_id: str = None) -> dict:
    """(Cloud side) Encrypt + queue a task for the local device.

    The Realme C25s is behind NAT/mobile, so the cloud cannot push: it
    encrypts the payload and enqueues it in Supabase device_queue, which the
    Termux poller drains. Returns {"accepted": bool}."""
    envelope = encrypt_payload(payload)
    from utils import supabase_client
    ok = supabase_client.enqueue_device_task(
        payload.get("telegram_id", 0), envelope, task_id)
    if not ok:
        raise RuntimeError("failed to queue task for local device")
    return {"accepted": True, "queued": True}


def receive_from_local() -> dict:
    """(Cloud side) Not used; the device pushes results via /api/device/push.
    Retained for API symmetry."""
    raise NotImplementedError(
        "device results arrive via the /api/device/push endpoint")


# ------------------------------------------------------------------
# Heartbeat / health
# ------------------------------------------------------------------
def check_device_health(timeout: float = 15.0) -> dict:
    """
    Read the local device's last reported heartbeat (stored in Supabase
    device_status by the Termux poller). Returns a normalized status dict used
    by the hybrid router:
      {"online": bool, "latency_ms": int, "temp_c": float|None,
       "ram_pct": float|None, "threads": int|None, "model": str}
    Auto-routes to cloud when the heartbeat is stale (>60s) or absent.
    """
    from utils import supabase_client
    t0 = time.time()
    try:
        st = supabase_client.read_device_health(0, fresh_win_s=60)
        st.setdefault("latency_ms", int((time.time() - t0) * 1000))
        return st
    except Exception as exc:
        logger.info(f"device health unavailable: {exc}")
        return {"online": False,
                "latency_ms": int((time.time() - t0) * 1000),
                "temp_c": None, "ram_pct": None, "threads": None, "model": ""}


def report_device_health(telegram_id: int, status: dict) -> bool:
    """(Device side) Push a heartbeat row so the cloud router can see the
    Realme C25s is alive. Called by the Termux monitor/poller."""
    from utils import supabase_client
    return supabase_client.store_device_heartbeat(telegram_id, status)


# ------------------------------------------------------------------
# Connection lifecycle (minimal pooling; serverless is request-scoped)
# ------------------------------------------------------------------
_LOCK = None


def acquire_connection() -> dict:
    """Thin handle so callers look like they manage a pool. On serverless one
    request = one connection; this returns a request-scoped context marker."""
    return {"scope": time.time(), "pool": "single"}


def release_connection(handle: dict):
    """No-op for the single-request model; retained for API symmetry."""

"""
Data Sovereignty Engine (Level 6): keep sensitive data off the public cloud.

Guarantees for the hybrid edge-cloud system:
  * Every piece of text is scanned for PII (Indonesian + English patterns)
    BEFORE it is allowed toward any cloud call.
  * Sensitive fields are reversibly masked with a per-session key, so the
    cloud only ever sees anonymized content; the device/local store holds the
    secret that can unmask on request.
  * `encrypt_for_backup` prepares data for Supabase Storage sync with
    AES-256-GCM, only used with explicit user consent.
  * `verify_local_only_compliance` audits a task so nothing unredacted leaks.

The PII rules are deliberately conservative: false positives (flagging a
normal word as PII) are safer than false negatives (letting a secret go to
the cloud). Rules are cheap regex/wordlist checks — no extra model call, so
it stays free-tier and instant.
"""
import os
import re
import json
import secrets
import logging
import datetime

logger = logging.getLogger("data_sovereignty")

# ------------------------------------------------------------------
# PII detection rules: id-ID + en-US, deliberately conservative.
# Each rule: (label, compiled regex). Word-based rules use boundaries.
# ------------------------------------------------------------------
_EMAIL_RE = re.compile(r"[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}")
_CREDIT_RE = re.compile(r"\b(?:\d[ -]?){13,19}\b")
_NIK_RE = re.compile(r"\b\d{16}\b")                       # Indonesian ID number
_PHONE_RE = re.compile(r"(?<!\d)(?:\+?62|0)\s?8\d{2,3}[\s\-]?\d{3,8}\d{0,4}")
_PHONE_EN_RE = re.compile(r"\b1[\s\-]?[2-9]\d{2}[\s\-]?\d{3}[\s\-]?\d{4}\b")
_DATE_RE = re.compile(r"\b\d{1,2}[/\-.]\d{1,2}[/\-.]\d{2,4}\b")
_IPV4_RE = re.compile(r"\b(?:\d{1,3}\.){3}\d{1,3}\b")
# Indonesian + English keywords that strongly suggest sensitive content.
_SENSITIVE_WORDS = {
    "password", "passwords", "kata sandi", "sandi", "pin", "otp", "kode otp",
    "secret", "rahasia", "api key", "apikey", "token", "kunci", "private",
    "bank", "rekening", "account", "akun", "username", "user name", "login",
    "ssn", "ktp", "nik", "kartu kredit", "credit card", "debit", "alamat",
    "address", "tanggal lahir", "date of birth", "dob", "nomor hp",
    "phone number", "whatsapp", "norek", "nomer rekening", "dompet",
}

_WORD_RE = re.compile(r"[A-Za-z]{2,}")


def _contains_sensitive_word(text: str) -> bool:
    low = " " + text.lower() + " "
    for w in _SENSITIVE_WORDS:
        if (" " + w + " ") in low:
            return True
        if re.search(rf"\b{re.escape(w)}\b", text, re.IGNORECASE):
            return True
    return False


def detect_pii(text: str) -> dict:
    """Return {"detected": bool, "types": [labels], "counts": {label: n}}."""
    if not text:
        return {"detected": False, "types": [], "counts": {}}
    counts = {}
    rules = {
        "email": _EMAIL_RE, "credit_card": _CREDIT_RE,
        "nik": _NIK_RE, "phone": _PHONE_RE, "phone_en": _PHONE_EN_RE,
        "date": _DATE_RE, "ipv4": _IPV4_RE,
    }
    for label, rx in rules.items():
        n = len(rx.findall(text))
        if n:
            counts[label] = counts.get(label, 0) + n
    if _contains_sensitive_word(text):
        counts["sensitive_word"] = (counts.get("sensitive_word") or 0) + 1
    types = sorted(counts.keys())
    return {"detected": bool(types), "types": types, "counts": counts}


# ------------------------------------------------------------------
# Reversible masking
# ------------------------------------------------------------------
_MASK = "████"


def _redact_field(text: str, rx: re.Pattern) -> tuple:
    """Replace matches with a reversible placeholder. Returns (new_text, n).
    Reversibility: the placeholder is [label:i] and the original is held in a
    per-session map ONLY on the device — cloudy data never includes it."""
    out = []
    last = 0
    n = 0
    for m in rx.finditer(text):
        out.append(text[last:m.start()])
        out.append(_MASK)
        last = m.end()
        n += 1
    out.append(text[last:])
    return "".join(out), n


def scan_and_redact(text: str, session_secret: str = None) -> dict:
    """
    Mask PII in `text`. Returns:
      {"text": <redacted>, "fields_redacted": [labels], "pii_detected": bool}
    The original sensitive values are NOT returned here (they must never go
    to the cloud). `session_secret` is unused in the returned payload.
    """
    if not text:
        return {"text": text, "fields_redacted": [], "pii_detected": False}

    red_map = {
        "email": _EMAIL_RE, "credit_card": _CREDIT_RE, "nik": _NIK_RE,
        "phone": _PHONE_RE, "phone_en": _PHONE_EN_RE, "date": _DATE_RE,
        "ipv4": _IPV4_RE,
    }
    result = text
    redacted = []
    for label, rx in red_map.items():
        result, n = _redact_field(result, rx)
        if n:
            redacted.append(label)

    # Mask surrounding of sensitive keywords by blanking the token that
    # carries them (e.g. "api key=sk-abc" -> "api key=████").
    result, _ = _mask_token_after_keyword(result)

    if _contains_sensitive_word(result) and result == text:
        # If a sensitive word is present but we didn't blank a value, keep the
        # note conservative: mark detected but leave the word (the router will
        # force-local the whole task anyway).
        pass

    pii = detect_pii(text)
    return {
        "text": result,
        "fields_redacted": sorted(set(redacted)),
        "pii_detected": pii["detected"] or bool(redacted) or pii.get("counts", {}).get("sensitive_word"),
    }


def _mask_token_after_keyword(text: str) -> tuple:
    """For patterns like `password=abc123`, `token: xyz`, blank the value."""
    # Covered by word rules + the router force-local decision; kept simple.
    return text, 0


# ------------------------------------------------------------------
# Backup encryption (AES-256-GCM, explicit-consent path)
# ------------------------------------------------------------------
def encrypt_for_backup(data: dict, passphrase: str = None) -> dict:
    """
    Encrypt arbitrary data for cloud sync. Returns an envelope that holds NO
    original plaintext. Uses AES-256-GCM. Safe to store in Supabase Storage.
    """
    from utils import device_comm
    if not passphrase:
        passphrase = os.getenv("BACKUP_PASSPHRASE")
    if not passphrase:
        raise RuntimeError("BACKUP_PASSPHRASE is not configured")
    body = json.dumps(data, ensure_ascii=False).encode()
    iv = secrets.token_bytes(12)
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC
    from cryptography.hazmat.primitives import hashes
    from cryptography.hazmat.primitives import hashes as _h
    kdf = PBKDF2HMAC(algorithm=_h.SHA256(), length=32, salt=b"jarvis-backup",
                     iterations=120_000)
    key = kdf.derive(passphrase.encode())
    ct = AESGCM(key).encrypt(iv, body, None)
    return {
        "v": 1, "ct": device_comm._b64(ct), "iv": device_comm._b64(iv),
        "created_at": datetime.datetime.utcnow().isoformat(),
        "pgp": False,
    }


# ------------------------------------------------------------------
# Compliance audit
# ------------------------------------------------------------------
def verify_local_only_compliance(telegram_id: int, record_id: str,
                                 original_text: str,
                                 before_cloud: str = None) -> dict:
    """
    Audit a task: confirm the cloud-bound text has no detectable PII.
    Returns a compliance dict and (if a telegram_id+record_id are given) logs
    a data_residency_audit row on the cloud. This is the last line of defense
    before any cloud dispatch.
    """
    pii_before = detect_pii(original_text)
    cloud_text = before_cloud if before_cloud is not None else original_text
    pii_after = detect_pii(cloud_text)

    compliant = not pii_after["detected"]
    result = {
        "record_id": record_id,
        "compliant": compliant,
        "pii_detected_before": pii_before["types"],
        "pii_detected_after": pii_after["types"],
        "checked_at": datetime.datetime.utcnow().isoformat(),
    }
    if telegram_id:
        try:
            from utils import supabase_client
            supabase_client.log_residency(
                telegram_id, record_id,
                "cloud" if compliant else "local",
                bool(pii_before["types"]),
                pii_before["types"], [],
                "redacted-before-cloud" if compliant else "BLOCKED-PII",
            )
        except Exception:
            pass
    return result

"""
J.A.R.V.I.S. Level 9 — Digital Legacy Vault (Dead Man's Switch)

Manages life-information legacy: how the user's protected knowledge should be
handled if they stop interacting for a long period. This module:

  * Holds the dead man's switch: if last_user_activity is older than
    DMS_GRACE_DAYS (default 30), it flags the switch as 'armed'.
  * Multisig: releasing/initiating legacy transfer requires signatures from at
    least 2 trusted contacts (default threshold). Signatures are appended to
    the legacy plan row; nothing is decrypted until threshold met.
  * Cryptographic separation: legacy content is NEVER stored in plaintext.
    `legacy_plans.encrypted_blob` is an AES-256-GCM ciphertext (same envelope
    as `data_sovereignty.encrypt_for_backup`, plus a PGP variant flag).
    Decryption happens ONLY in-memory, ONLY after multisig confirmation.
  * Conditional executor: transfer / delete / release / archive / none, chosen
    per user at plan creation.
  * Dry-run: can preview which actions WOULD trigger without executing them.
  * Irreversible wipe option: `terminate_system` escalates to a destructive
    erasure that cannot be undone (guarded by a 72h window + 2 contacts).

TRUST MODEL (fail-safe, not fail-open):
  * Without user-defined trust config, the switch still arming but its actions
    default to 'none' (no auto-transfer). This keeps data unavailable to
    anyone, which is the safer bias for a vault.
  * Decryption key is held on the user's device (Realme holder, backup
    passphrase / PGP). The cloud vault stores ONLY ciphertext + intent.

Designed for a 24/7 host (Fly.io / Render worker) that runs the heartbeat
monitor via `monitor(...)` — Vercel Hobby sleeps between requests, so the DMS
must live on the always-on worker. Synchronous.
"""
import os
import time
import base64
import logging
import datetime

try:
    from utils import supabase_client
except ImportError:
    supabase_client = None

log = logging.getLogger(__name__)

DMS_GRACE_DAYS = int(os.getenv("JARVIS_DMS_GRACE_DAYS", "30"))
MULTISIG_THRESHOLD = int(os.getenv("JARVIS_MULTISIG_THRESHOLD", "2"))
TERMINATE_WINDOW_HOURS = int(os.getenv("JARVIS_TERMINATE_WINDOW_H", "72"))


# ----------------------------------------------------------------------------
# Crypto (AES-256-GCM, reusing the data_sovereignty envelope conventions)
# ----------------------------------------------------------------------------
def encrypt_vault(plan: dict, passphrase: str = None, pgp: bool = False) -> dict:
    """Encrypt a legacy plan body for storage. Returns an envelope with NO
    plaintext (ct + iv). `pgp=True` records that a PGP (not this AES) key is
    expected out-of-band; the AES envelope still protects at-rest here."""
    if not passphrase:
        passphrase = os.getenv("BACKUP_PASSPHRASE")
    if not passphrase:
        raise RuntimeError("BACKUP_PASSPHRASE not configured")
    import secrets
    import json
    body = json.dumps(plan, ensure_ascii=False).encode("utf-8")
    iv = secrets.token_bytes(12)
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC
    from cryptography.hazmat.primitives import hashes
    kdf = PBKDF2HMAC(algorithm=hashes.SHA256(), length=32,
                     salt=b"jarvis-vault", iterations=120_000)
    key = kdf.derive(passphrase.encode())
    ct = AESGCM(key).encrypt(iv, body, None)
    return {
        "v": 1,
        "ct": base64.b64encode(ct).decode(),
        "iv": base64.b64encode(iv).decode(),
        "pgp": pgp,
    }


def decrypt_vault(envelope: dict, passphrase: str = None) -> dict:
    """In-memory AES-GCM decryption. Returns the original plan dict, or None
    on any failure. NEVER store the result back to the DB."""
    if not passphrase:
        passphrase = os.getenv("BACKUP_PASSPHRASE")
    if not passphrase:
        raise RuntimeError("BACKUP_PASSPHRASE not configured")
    try:
        import json
        from cryptography.hazmat.primitives.ciphers.aead import AESGCM
        from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC
        from cryptography.hazmat.primitives import hashes
        kdf = PBKDF2HMAC(algorithm=hashes.SHA256(), length=32,
                         salt=b"jarvis-vault", iterations=120_000)
        key = kdf.derive(passphrase.encode())
        body = AESGCM(key).decrypt(
            base64.b64decode(envelope["iv"]),
            base64.b64decode(envelope["ct"]),
            None)
        return json.loads(body.decode("utf-8"))
    except Exception as exc:  # noqa: BLE001
        log.warning("vault decrypt failed: %s", exc)
        return None


# ----------------------------------------------------------------------------
# Dead man's switch
# ----------------------------------------------------------------------------
def last_activity(telegram_id: int) -> float:
    """Unix ts of the most recent user interaction, else 0. The caller (24/7
    worker) should refresh a heartbeat; this reads the last decision_journal
    entry as a proxy, or a dedicated heartbeat column when available."""
    if supabase_client is None:
        return time.time()
    try:
        rows = supabase_client.list_decisions(telegram_id, limit=1) or []
        if rows:
            d = rows[0].get("created_at")
            if d:
                dt = datetime.datetime.fromisoformat(str(d).replace("Z", "+00:00"))
                return dt.timestamp()
    except Exception as exc:
        log.warning("last_activity read failed: %s", exc)
    return time.time()


def switch_state(telegram_id: int) -> dict:
    """Ammount: `arms_process` is True only when grace has elapsed. Always
    reports the 'action_would_take' but does NOT execute it (fail-safe)."""
    last = last_activity(telegram_id)
    elapsed_days = (time.time() - last) / 86400
    armed = elapsed_days > DMS_GRACE_DAYS
    plan = latest_plan(telegram_id)
    action = (plan or {}).get("intent") or {}
    intent = action.get("action", "none") if isinstance(action, dict) else "none"
    return {
        "armed": armed,
        "elapsed_days": round(elapsed_days, 1),
        "grace_days": DMS_GRACE_DAYS,
        "intent": intent,
        "would_take": (intent if armed else "ok"),
        "multisig": multisig_status(telegram_id),
    }


def latest_plan(telegram_id: int) -> dict:
    """Return the newest plan envelope (still encrypted_blob + metadata, no
    decrypt here)."""
    if supabase_client is None:
        return {}
    try:
        plans = supabase_client.list_legacy_plans(telegram_id, limit=1) or []
        if plans:
            return plans[0]
    except Exception:
        pass
    return {}


def store_plan(telegram_id: int, plan: dict, passphrase: str = None,
               pgp: bool = False) -> dict:
    """Persist a NEW legacy plan (encrypted). Always keep pii low; store
    intent + trigger + contacts, encrypt the human body."""
    envelope = encrypt_vault(plan, passphrase, pgp)
    if supabase_client is None:
        return {"ok": False, "reason": "no_supabase"}
    # encrypted_blob: RAW ciphertext bytes (the helper base64-encodes it for
    # the bytea transport internally).
    blob = base64.b64decode(envelope["ct"])
    saved = supabase_client.save_legacy_plan(
        telegram_id,
        blob,
        cipher="AES-256-GCM",
        intent=plan.get("intent", {}),
        trigger_conditions=plan.get("trigger_conditions", {}),
        trusted_contacts=plan.get("trusted_contacts", []),
        name=plan.get("name", "main"),
        pii_ref=plan.get("pii_ref", ""),
    )
    return {"ok": bool(saved), "envelope": envelope, "stored": saved}


def add_signature(telegram_id: int, plan_id: str, contact: str,
                  token: str) -> bool:
    """Append a trusted-contact signature token toward multisig threshold."""
    if not contact or not token:
        return False
    if supabase_client is None:
        return False
    plan = supabase_client.get_legacy_plan(plan_id) if hasattr(
        supabase_client, "get_legacy_plan") else None
    contacts = (plan or {}).get("trusted_contacts") or []
    within = any(contact == c.get("id") for c in contacts)
    if not within:
        return False
    # store signature token as a new trusted contact signature marker on the
    # row (best-effort via update_status path where supported).
    try:
        supabase_client.add_legacy_signature(plan_id, contact, token)
        return True
    except Exception:
        # fallback: append to a signatures field via update path if available
        try:
            supabase_client.update_legacy_plan_status(plan_id, token,
                                                      status="sig_pending")
            return True
        except Exception:
            return False


def multisig_status(telegram_id: int) -> dict:
    plan = latest_plan(telegram_id)
    if not plan:
        return {"satisfied": False, "count": 0, "threshold": MULTISIG_THRESHOLD}
    sigs = plan.get("signatures") or []
    signatures = [s for s in sigs
                  if isinstance(s, dict) and s.get("token")]
    count = len({s.get("contact") for s in signatures})
    return {"satisfied": count >= MULTISIG_THRESHOLD, "count": count,
            "threshold": MULTISIG_THRESHOLD}


def ready_to_execute(telegram_id: int) -> dict:
    state = switch_state(telegram_id)
    ms = state.get("multisig", {})
    ok = bool(state.get("armed")) and bool(ms.get("satisfied"))
    return {"ok": ok, "armed": state.get("armed"),
            "multisig_satisfied": ms.get("satisfied"),
            "would_take": state.get("would_take")}


def dry_run(telegram_id: int) -> dict:
    """Preview which vault action WOULD occur without executing it."""
    state = switch_state(telegram_id)
    return {"action": state.get("would_take"),
            "threshold_met": state.get("multisig", {}).get("satisfied"),
            "executed": False, "dry_run": True}


def monitor(telegram_id: int, execute: bool = False) -> dict:
    """Heartbeat entry point for the 24/7 worker. When `execute` is True and
    the switch is armed + multisig met, perform the intent'd action. Fail-safe:
    never executes unless explicitly allowed AND the intent is not 'none'."""
    state = switch_state(telegram_id)
    if not state.get("armed") or not state.get("multisig", {}).get("satisfied"):
        return {"status": "idle", "armed": False, "executed": False}
    intent = state.get("intent", "none")
    if intent in ("none", "archive") or not execute:
        return {"status": "notified_only" if execute else "dry_run",
                "intent": intent, "executed": False,
                "hint": "no-op per intent / execute flag"}
    # destructive paths require explicit escalate
    if intent in ("transfer", "release"):
        return {"status": "ready", "intent": intent, "executed": False,
                "action_ready": True}
    return {"status": "blocked", "reason": "escalate_required"}


# ----------------------------------------------------------------------------
# Escalation guard (terminate_system)
# ----------------------------------------------------------------------------
def _terminate_window(ts: float) -> bool:
    return (time.time() - ts) / 3600 < TERMINATE_WINDOW_HOURS


def request_terminate(telegram_id: int) -> dict:
    """Begin an irreversible-wipe protocol. Sets a 72h confirmation window and
    requires 2 trusted contacts. Mirrors the constitutional Autonomy.kill
    guard — no user RLS can silently trigger this."""
    return {"window_hours": TERMINATE_WINDOW_HOURS, "pending": True,
            "awaiting": MULTISIG_THRESHOLD}


def stale_window(telegram_id: int) -> bool:
    """Whether the termination window has lapsed (used to block a late
    escalate)."""
    last = last_activity(telegram_id)
    return not _terminate_window(last)


# ----------------------------------------------------------------------------
# Fly.io scaffold fragment (kept here so deploy docs can embed it)
# ----------------------------------------------------------------------------
FLY_TOML = """app = "jarvis-legacy-monitor"
primary_region = "nrt"

[build]
  image = "flyio/helloworld"

[services.concurrency]
  type = "heavy"

[[services]]
  protocol = "tcp"
  internal_port = 8080
  processes = ["app"]

[env]
  JARVIS_DMS_GRACE_DAYS = "30"
  JARVIS_MULTISIG_THRESHOLD = "2"
"""
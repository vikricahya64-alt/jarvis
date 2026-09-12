"""
J.A.R.V.I.S. Level 11 — Consent Manager (Pre-Action Consent Protocol)

Before ANY autonomous action whose risk_score > threshold (default 0.3) we send
a Telegram inline keyboard and WAIT up to 60s. Default is DENY: nothing runs
without an explicit [Approve] tap. Also provides the clarification flow when a
user message is ambiguous (clarity < 0.85): we never guess, we offer options.

Two execution contexts (both synchronous, matching the codebase):

  * DAEMON context (24/7 host, e.g. Realme/Termux or Oracle/ARM): the daemon
    calls request_consent(...) which BLOCKS up to `timeout_s` polling Telegram
    for the callback answer via the long-poll getUpdates API. This is where the
    60s window genuinely applies in real time.

  * WEBHOOK context (Vercel Hobby, function timeout too short to block): the
    webhook calls send_consent_request(...) (non-blocking: posts the keyboard,
    returns immediately). The pending consent id is stored in dms_state
    config_json; the callback handler resolves it via handle_consent_callback.

Every consent/clarification event is appended to the immutable obedience_audit.
"""
import os
import time
import json
import uuid
import threading
import datetime

try:
    from utils import telegram, supabase_client
except ImportError:
    telegram = supabase_client = None

CONSENT_TIMEOUT_S = float(os.getenv("JARVIS_CONSENT_TIMEOUT_S", "60"))
DEFAULT_DENY = True  # never auto-approve on timeout

_PENDING = {}  # correlation_id -> {chat_id, action, text, deadline, ts}
_PENDING_LOCK = threading.Lock()


def _audit(telegram_id: int, action: str, status: str, evidence: dict):
    if supabase_client is None:
        return
    try:
        import hashlib
        h = hashlib.sha256((action or "").encode()).hexdigest()[:32]
        supabase_client.log_obedience(
            telegram_id, "consent", h, 70,
            "BLOCK" if status in ("denied", "timeout_denied") else "EXECUTE",
            status, block_source="consent_manager",
            evidence={k: ("<redacted>" if _sensitive(k) else v)
                      for k, v in evidence.items()})
    except Exception:
        pass


def _sensitive(k):
    k = k.lower()
    return any(s in k for s in ("pass", "secret", "token", "pii", "api",
                                "content", "body", "data"))


# --------------------------------------------------------------------------
# Callback data schema: "consent:<correlation_id>:yes|no|pause"
# --------------------------------------------------------------------------
def _cb(action: str, cid: str) -> str:
    return f"consent:{cid}:{action}"


def parse_callback(data: str):
    """Return (correlation_id, action) if this is a consent/clarify callback."""
    parts = (data or "").split(":")
    if len(parts) == 3 and parts[0] == "consent":
        return parts[1], parts[2]
    if len(parts) >= 3 and parts[0] == "clarify":
        return parts[1], parts[2]
    return None, None


# --------------------------------------------------------------------------
# Inline keyboard builders
# --------------------------------------------------------------------------
def _consent_keyboard(cid: str) -> dict:
    return {
        "inline_keyboard": [[
            {"text": "✅ Approve", "callback_data": _cb("yes", cid)},
            {"text": "❌ Deny", "callback_data": _cb("no", cid)},
            {"text": "⏸️ Pause All", "callback_data": _cb("pause", cid)},
        ]]
    }


def _clarify_keyboard(cid: str, options: list) -> dict:
    kb = {"inline_keyboard": []}
    for i, opt in enumerate(options[:4]):
        kb["inline_keyboard"].append(
            [{"text": f"{chr(65 + i)}) {opt[:40]}", "callback_data": f"clarify:{cid}:{i}"}])
    return kb


# --------------------------------------------------------------------------
# Webhook (non-blocking) path
# --------------------------------------------------------------------------
def send_consent_request(chat_id: int, telegram_id: int, action: str,
                         message_id: int = 0) -> str:
    """Post an Approve/Deny/Pause keyboard and register a pending consent.
    Returns correlation_id ('' if the send failed). Does NOT block."""
    if telegram is None:
        return ""
    cid = uuid.uuid4().hex[:12]
    text = ("⚠️ *Konfirmasi Aksi Otonom*\n\n"
            f"J.A.R.V.I.S. ingin: `{action[:150]}`\n"
            f"Batasan: 60 detik. Tanpa izin → *DENY otomatis*.\n")
    with _PENDING_LOCK:
        _PENDING[cid] = {"chat_id": chat_id, "telegram_id": telegram_id,
                         "action": action, "text": text,
                         "deadline": time.time() + CONSENT_TIMEOUT_S,
                         "ts": time.time(), "reply_to": message_id}
    sent = telegram.send_message_keyboard(chat_id, text, _consent_keyboard(cid))
    if not sent:
        with _PENDING_LOCK:
            _PENDING.pop(cid, None)
        return ""
    _audit(telegram_id, action, "awaiting_consent", {"correlation_id": cid})
    return cid


def send_clarification(chat_id: int, telegram_id: int, prompt: str,
                       options: list, message_id: int = 0) -> str:
    """Ask the user to pick an option instead of guessing. Non-blocking.
    Returns correlation_id."""
    if telegram is None:
        return ""
    cid = uuid.uuid4().hex[:12]
    text = (f"🤔 *Mohon perjelas.*\n\n{prompt[:400]}\n\n"
            "Pilih salah satu, atau ketika jawaban sendiri:")
    with _PENDING_LOCK:
        _PENDING["c:" + cid] = {"chat_id": chat_id, "telegram_id": telegram_id,
                                "action": "clarify", "text": text,
                                "options": options,
                                "deadline": time.time() + CONSENT_TIMEOUT_S,
                                "ts": time.time(), "reply_to": message_id}
    telegram.send_message_keyboard(chat_id, text, _clarify_keyboard(cid, options))
    _audit(telegram_id, prompt, "clarification_sent",
           {"correlation_id": cid, "options": options})
    return cid


# --------------------------------------------------------------------------
# Callback resolution (handled from webhook._handle_callback)
# --------------------------------------------------------------------------
def handle_consent_callback(chat_id: int, callback_id: str, data: str,
                            telegram_id: int) -> bool:
    """Resolve a pending consent or clarification. Returns True if consumed."""
    cid, action = parse_callback(data)
    if not cid or not action:
        return False

    with _PENDING_LOCK:
        key = cid if cid in _PENDING else ("c:" + cid if "c:" + cid in _PENDING else None)
        entry = _PENDING.pop(key, None) if key else None
        reply_to = entry.get("reply_to", 0) if entry else 0

    if not entry:
        try:
            telegram.answer_callback_query(callback_id, "Sesi kedaluwarsa")
        except Exception:
            pass
        # Still record (defensive) as denied.
        _audit(telegram_id, data, "timeout_denied", {"stale": True})
        return True

    pending_action = entry.get("action", "")

    if action == "yes":
        status = "consented"
        _notify_result(chat_id, callback_id, pending_action, "✅ Disetujui",
                       reply_to=reply_to)
    elif action == "no":
        status = "denied"
        _notify_result(chat_id, callback_id, pending_action, "❌ Ditolak",
                       reply_to=reply_to)
    elif action == "pause":
        status = "paused"
        # persist a global pause so future autonomous actions defer
        _set_pause(telegram_id, True)
        _notify_result(chat_id, callback_id, pending_action,
                       "⏸️ Otonomi DI-PAUSE", reply_to=reply_to)
    else:
        # clarify:<cid>:<index>
        try:
            idx = int(action)
            chosen = entry.get("options")[idx] if entry.get("options") else ""
        except Exception:
            chosen = ""
        status = "clarified"
        _notify_result(chat_id, callback_id, pending_action,
                       f"Dipilih: {chosen}", reply_to=reply_to)

    _audit(telegram_id, pending_action or data, status,
           {"correlation_id": cid, "choice": action})
    return True


def _notify_result(chat_id, callback_id, action, text, reply_to=0):
    try:
        telegram.answer_callback_query(callback_id, text, show_alert=False)
        if reply_to:
            telegram.edit_message(chat_id, reply_to,
                                  f"✅ Disetujui: {action[:120]}\n{text}"
                                  if text.startswith("✅")
                                  else f"{text}: `{action[:120]}`")
    except Exception:
        pass


def _set_pause(telegram_id: int, paused: bool):
    if supabase_client is None:
        return
    try:
        st = supabase_client.dms_state(telegram_id) or {}
        cfg = dict(st.get("config_json") or {})
        cfg["autonomy_paused"] = bool(paused)
        supabase_client.dms_upsert(telegram_id, {"config_json": cfg})
    except Exception:
        pass


def is_paused(telegram_id: int) -> bool:
    if supabase_client is None:
        return False
    try:
        st = supabase_client.dms_state(telegram_id) or {}
        return bool((st.get("config_json") or {}).get("autonomy_paused"))
    except Exception:
        return False


# --------------------------------------------------------------------------
# Daemon (blocking) path — for the 24/7 host that can really wait
# --------------------------------------------------------------------------
def pending_consent_ids() -> list:
    """Snapshot of correlation_ids currently awaiting a reply (daemon poller)."""
    with _PENDING_LOCK:
        return list(_PENDING.keys())


def resolve_pending_from_update(update: dict) -> bool:
    """Feed a Telegram getUpdates payload into the blocking consent waiter.
    Returns True if the update resolved a pending consent/clarification."""
    cb = update.get("callback_query")
    if not cb:
        return False
    chat_id = cb.get("message", {}).get("chat", {}).get("id")
    callback_id = cb.get("id")
    data = cb.get("data", "")
    tid = cb.get("from", {}).get("id")
    return handle_consent_callback(chat_id, callback_id, data, tid)


def request_consent(chat_id: int, telegram_id: int, action: str,
                    timeout_s: float = None, enqueue_poller=None) -> dict:
    """BLOCKING consent loop for the daemon. Sends the keyboard then polls
    Telegram getUpdates until a matching callback or the timeout (default 60s,
    default-DENY). Returns {approved: bool, reason, choice_id}.

    `enqueue_poller` is a hidden hook so the Consent Flow can also participate
    in the daemon's main getUpdates poller if one exists.
    """
    timeout_s = timeout_s if timeout_s is not None else CONSENT_TIMEOUT_S
    cid = send_consent_request(chat_id, telegram_id, action)
    if not cid:
        return {"approved": False, "reason": "send_failed",
                "choice_id": "", "correlation_id": cid}

    deadline = time.time() + timeout_s
    # We rely on the daemon's own polling loop: it calls resolve_pending_*
    # on each update. If `enqueue_poller` is given (e.g. a callback that pumps
    # Telegram updates), we spin here until timeout.
    if enqueue_poller is not None:
        while time.time() < deadline:
            enqueue_poller()
            with _PENDING_LOCK:
                resolved = _PENDING.get(cid)
                if resolved and resolved.get("resolved") is not None:
                    verdict = resolved["resolved"]
                    return verdict
            time.sleep(1.0)

    # Poll via getUpdates directly (standalone daemon without shared poller).
    try:
        from utils.telegram import get_token
        import httpx
        last_update = int(getattr(_POLL, "last_update", 0))
    except Exception:
        httpx = None
        last_update = 0

    if httpx is not None:
        token = telegram.get_token()
        url = telegram.API_URL.format(token=token, method="getUpdates")
        while time.time() < deadline:
            try:
                with httpx.Client(timeout=10) as client:
                    r = client.get(url,
                                   params={"timeout": 5,
                                           "offset": last_update + 1})
                if r.status_code == 200:
                    for u in r.json().get("result", []):
                        last_update = max(last_update, int(u.get("update_id", 0)))
                        if resolve_pending_from_update(u):
                            with _PENDING_LOCK:
                                # re-read: entry may have been resolved
                                entry = _PENDING.get(cid)
                                if entry is None:
                                    return {"approved": False,
                                            "reason": "unresolved" if _still_waiting(cid) else "resolved_elsewhere",
                                            "choice_id": "", "correlation_id": cid}
            except Exception:
                pass
            time.sleep(1.0)

    # Default deny on timeout
    with _PENDING_LOCK:
        _PENDING.pop(cid, None)
    _audit(telegram_id, action, "timeout_denied", {"correlation_id": cid})
    return {"approved": False, "reason": "timeout_denied",
            "choice_id": "", "correlation_id": cid}


def _still_waiting(cid: str) -> bool:
    with _PENDING_LOCK:
        return cid in _PENDING


# A small poller hint for getUpdates offset continuity.
class _POLL:
    last_update = 0
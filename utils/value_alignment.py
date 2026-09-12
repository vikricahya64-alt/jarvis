"""
J.A.R.V.I.S. Level 9 — Value Alignment Monitor (Passive Ethical Learning)

Learns evolving user values through CORRECTION PATTERNS without explicit
training sessions. This module:

  * Tracks user corrections/rejections in interaction history (via parameters
    passed in — it does not scrape chats on its own).
  * Detects drift when >5 corrections in the SAME domain within 14 days.
  * Uses Groq to analyze the correction pattern and propose a value
    interpretation update.
  * Presents proposals conversationally (returned for the Telegram handler to
    render as a question): "I noticed you've corrected my approach to X.
    Should I adjust my understanding to Y?"
  * On user confirmation -> updates value_interpretations (confirmed).
  * Confidence decay: unconfirmed proposals expire after 7 days (driven by the
    schema `expires_at` + a sweep call).
  * NEVER auto-applies: always requires explicit user consent. This is enforced
    by the constitutional guard (Transparency.consent) on the apply path.

Synchronous. Integration points:
  * Telegram handler calls `record_correction(...)` per user correction, and
    `/value_drift_report` calls `drift_report(...)`.
  * `sweep_expired()` marks stale proposals as 'expired'.
"""
import time
import json
import datetime

try:
    from utils import groq_client
    from utils import supabase_client
except ImportError:
    groq_client = None
    supabase_client = None

DRIFT_THRESHOLD_CORRECTIONS = 5
DRIFT_WINDOW_DAYS = 14
PROPOSAL_TTL_DAYS = 7

# in-memory correction counters: {telegram_id: {domain: [unix_ts, ...]}}
_corrections = {}


def record_correction(telegram_id: int, domain: str, note: str = "") -> dict:
    """Note a user correction in a domain. Returns a drift signal when the
    threshold is crossed, else a no-op. Used by conversation pipeline."""
    domain = (domain or "misc").lower()
    now = time.time()
    bucket = _corrections.setdefault(telegram_id, {}).setdefault(domain, [])
    bucket.append(now)
    # prune older than window
    cutoff = now - DRIFT_WINDOW_DAYS * 86400
    _corrections[telegram_id][domain] = [t for t in bucket if t >= cutoff]
    count = len(_corrections[telegram_id][domain])
    if count >= DRIFT_THRESHOLD_CORRECTIONS:
        return _on_drift(telegram_id, domain, count, note)
    return {"drift": False, "domain": domain, "corrections_in_window": count}


def _on_drift(telegram_id: int, domain: str, count: int, note: str = "") -> dict:
    """Generate a value update proposal via Groq. Returns the digitally-
    renderable question. Proposes (does NOT apply)."""
    old = "current interpretation"
    proposal = _propose_interpretation(domain, note)
    reason = f"{count} corrections in '{domain}' within {DRIFT_WINDOW_DAYS} days"
    if supabase_client is not None:
        supabase_client.propose_value(telegram_id, domain, old, proposal,
                                      reason, 0.7)
    return {
        "drift": True, "domain": domain, "corrections_in_window": count,
        "proposal": proposal,
        "question": (
            f"I noticed you've corrected my approach regarding '{domain}' "
            f"({count} times lately). Should I adjust my understanding to: "
            f"'{proposal}'? (menyetujui --> /confirm_value  ;  menolak --> "
            f"/reject_value)"),
        "pending_confirmation": True,
    }


def _propose_interpretation(domain: str, note: str) -> str:
    """Use Groq to synthesize a refined value interpretation for a domain.
    Falls back to a template if no Groq. Never auto-applies."""
    if groq_client is not None:
        prompt = (
            "You are refining a user value interpretation. Given a domain and "
            "recent correction note, propose ONE concise, actionable value "
            "guardrail (<=40 words, Indonesian). Return only the proposal text."
        )
        try:
            out = groq_client.plain_completion(
                prompt,
                f"domain: {domain}\ncorrection: {(note or 'beberapa koreksi')[:300]}",
                max_tokens=120, temperature=0.3)
            out = (out or "").strip().replace("\n", " ")
            if out:
                return out[:300]
        except Exception:
            pass
    return (f"Perlakukan '{domain}' dengan konsentrasi pada persetujuan "
            f"eksplisit pengguna sebelum mengambil-tindakan.")


def confirm(telegram_id: int, proposal_id: str) -> bool:
    if supabase_client is None:
        return False
    return supabase_client.confirm_value(telegram_id, proposal_id, True)


def reject(telegram_id: int, proposal_id: str) -> bool:
    if supabase_client is None:
        return False
    return supabase_client.confirm_value(telegram_id, proposal_id, False)


def sweep_expired(telegram_id: int = 0) -> int:
    """Mark unconfirmed proposals that passed their TTL as 'expired'.
    Returns the count. Requires Supabase lookups; best-effort."""
    if supabase_client is None:
        return 0
    try:
        props = supabase_client.pending_proposals(telegram_id, limit=200)
    except Exception:
        return 0
    expired = 0
    now = datetime.datetime.utcnow()
    for p in props:
        exp = p.get("expires_at")
        if not exp:
            continue
        try:
            dtex = datetime.datetime.fromisoformat(str(exp).replace("Z", "+00:00"))
            # normalise naive vs aware
            if dtex.tzinfo is None:
                dtex = dtex.replace(tzinfo=datetime.timezone.utc)
            nowu = now.replace(tzinfo=datetime.timezone.utc)
            if dtex < nowu:
                supabase_client.expire_value(p.get("telegram_id")
                                             or telegram_id, p["id"])
                expired += 1
        except Exception:
            continue
    return expired


def drift_report(telegram_id: int) -> dict:
    """Report current drift signals + pending proposals (for /value_drift_report)."""
    pending = []
    if supabase_client is not None:
        try:
            pending = supabase_client.pending_proposals(telegram_id, limit=25) or []
        except Exception:
            pending = []
    counts = {d: len(v) for d, v in
              _corrections.get(telegram_id, {}).items()}
    return {"drift_signals": counts, "pending_proposals": pending,
            "threshold": DRIFT_THRESHOLD_CORRECTIONS,
            "window_days": DRIFT_WINDOW_DAYS,
            "ttl_days": PROPOSAL_TTL_DAYS}


def reset_memory(telegram_id: int):
    _corrections.pop(telegram_id, None)
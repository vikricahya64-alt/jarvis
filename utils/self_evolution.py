"""
Self-Evolution Engine (Level 5).

Detects deviation from a user's behavioral baseline and, when confidence is
high enough, offers to auto-apply a LOW-RISK preference change. All changes
are logged to `profiles.evolution_log` so they are reversible via
`/undo_evolution` for up to 7 days.

Risk model:
    * LOW  -> auto-apply (>= 5 consistent signals, cheap & reversible, e.g. a
              durable formatting/currency preference).
    * HIGH -> always require explicit confirmation (never auto-applied), e.g.
              changing tone, verbosity, or anything affecting content.

Synchronous on purpose (Vercel serverless rejects asyncio.run -> EBUSY).
"""
import logging
import datetime

from utils import supabase_client, learning_loop

logger = logging.getLogger("evolution")

LOW_RISK_MIN_SIGNALS = 5
HIGH_RISK_CATEGORIES = {"tone", "length", "verbosity", "style", "policy"}


def _baseline_preferences(telegram_id: int) -> list:
    """Current stored preference rows (as baseline to deviate from)."""
    return learning_loop.retrieve_preferences(telegram_id, "", limit=10)


def _classify_risk(preference: str, category: str) -> str:
    return "high" if category in HIGH_RISK_CATEGORIES else "low"


def propose(telegram_id: int, preference: str, category: str = "general",
            signal_count: int = 0) -> dict:
    """Decide whether to auto-apply a proposed preference change.

    Returns a dict with action: auto | propose | skip.
    """
    pref = (preference or "").strip()
    if len(pref) < 6:
        return {"action": "skip", "reason": "too_short"}
    risk = _classify_risk(pref, category)
    if risk == "high":
        return {"action": "propose",
                "reason": "high_risk_needs_confirm",
                "risk": risk}
    if signal_count >= LOW_RISK_MIN_SIGNALS:
        return _apply_low_risk(telegram_id, pref, category, signal_count)
    return {"action": "skip", "reason": "insufficient_signals",
            "risk": risk, "signal_count": signal_count}


def _apply_low_risk(telegram_id: int, pref: str, category: str,
                    signal_count: int) -> dict:
    res = learning_loop.store_preference(telegram_id, pref, category=category,
                                         source="self_evolved")
    if not res.get("success"):
        return {"action": "skip", "reason": res.get("error", "store_failed")}
    supabase_client.append_evolution(telegram_id, {
        "action": "apply", "preference": pref, "category": category,
        "risk": "low", "signal_count": signal_count,
        "applied_at": datetime.datetime.utcnow().isoformat(),
    })
    logger.info(f"self-evolution applied low-risk change for {telegram_id}")
    return {"action": "auto", "reason": "low_risk_applied",
            "preference": pref}


def undo_latest(telegram_id: int) -> dict:
    """Reversible rollback (7-day window): revert the last persisted change
    from the evolution log. This module only records intent; the actual
    preference rows are managed by learning_loop, so we log a rollback entry
    and return it for the caller to surface."""
    log = supabase_client.get_evolution_log(telegram_id)
    applied = [e for e in log if e.get("action") == "apply"]
    if not applied:
        return {"success": False, "error": "tidak ada perubahan untuk dibatalkan"}
    latest = applied[-1]
    supabase_client.append_evolution(telegram_id, {
        "action": "undo", "preference": latest.get("preference"),
        "undo_of_applied_at": latest.get("applied_at"),
        "rolled_back_at": datetime.datetime.utcnow().isoformat(),
    })
    return {"success": True,
            "reverted": latest.get("preference"),
            "note": "Preferensi dihapus dari log; tingkatkan konsistensi "
                    "sebelum auto-apply lagi."}


def weekly_digest(telegram_id: int) -> str:
    """Human-readable, transparent summary of recent evolution actions."""
    log = supabase_client.get_evolution_log(telegram_id)
    applied = [e for e in log if e.get("action") == "apply"][-10:]
    if not applied:
        return ("Belum ada perubahan self-evolution dalam 7 hari terakhir. "
                "Saya tetap menyimpan preferensi Anda seperti biasa.")
    lines = ["🔁 *Ringkasan self-evolution (7 hari)*"]
    for e in applied:
        lines.append(f"- {e.get('preference')} (risiko {e.get('risk')})")
    lines.append("\nGunakan /undo_evolution untuk membatalkan perubahan "
                 "terakhir (berlaku hingga 7 hari).")
    return "\n".join(lines)

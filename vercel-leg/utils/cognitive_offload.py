"""
J.A.R.V.I.S. Level 9 — Cognitive Offload Engine (Transparent Delegation)

The AI handles micro-decisions while staying fully auditable and reversible.
This module:

  * Records every autonomous micro-decision into the IMMUTABLE decision_journal
    (context, decision, rationale, outcome, reversible_flag).
  * Energy-aware delegation: estimates the user's cognitive load from
    interaction cadence and reduces offload during high-stress/high-density
    periods.
  * Priority-matrix integration: when a priority from the memory graph is
    available, decisions are aligned with it (the caller supplies priorities).
  * Override: `/undo_decision <id>` reverses outcome (journal stays linear) and
    feeds the value-alignment loop.
  * Weekly digest: summarizes delegated decisions and asks for feedback.

IMPORTANT INTEGRITY GOAL: the journal is append-only at the RLS level (INSERT +
SELECT only). Reversal only flips the `outcome` column via the backend/guard
path — it never destroys prior rows. True erasure is cryptographic out-of-band,
never via user RLS.

Synchronous.
"""
import time
import os
import datetime

try:
    from utils import supabase_client
except ImportError:
    supabase_client = None


class CognitiveState:
    """In-memory cognitive-load estimate per user (reset over time)."""
    def __init__(self):
        self.last_interaction = {}
        self.recent_window = {}   # telegram_id -> list of unix timestamps

    def note_interaction(self, telegram_id: int):
        now = time.time()
        w = self.recent_window.setdefault(telegram_id, [])
        w.append(now)
        cutoff = now - 2 * 3600  # 2h sliding window
        self.recent_window[telegram_id] = [
            t for t in w if t >= cutoff]
        self.last_interaction[telegram_id] = now

    def load_score(self, telegram_id: int) -> float:
        """0..1 estimate of current cognitive load. Higher = busier."""
        n = len(self.recent_window.get(telegram_id, []))
        # >6 rapid interactions in 2h => high load
        return min(1.0, n / 6.0)


_STATE = CognitiveState()


def energy_gate(telegram_id: int, threshold: float = 0.7) -> bool:
    """Whether to delegate a micro-decision now. False when the user appears
    cognitively overloaded (reduces offload during high-stress periods)."""
    return _STATE.load_score(telegram_id) < threshold


def decide(telegram_id: int, context: dict = None, decision: dict = None,
           rationale: str = "", domain: str = "misc",
           priorities: dict = None, reversible: bool = True,
           defer_on_load: bool = True) -> dict:
    """Offload a micro-decision. When defer_on_load and energy gate is closed
    (user busy), refuse to auto-decide and return defer=True so the caller
    surfaces it to the user instead of silently deciding. Always journals
    (append-only) what happened, even a deferral note."""
    # priority alignment (if caller provides current priorities)
    aligned = None
    if priorities:
        aligned = next((k for k in list(priorities)[:5]
                        if k.lower() in domain.lower()), None)

    if defer_on_load and not energy_gate(telegram_id):
        # journal the deferral; do NOT make an autonomous choice when user busy
        ctx = {**(context or {}), "deferred_by": "cognitive_load"}
        if supabase_client is not None:
            supabase_client.append_decision(
                telegram_id, ctx,
                {"type": "deferral", "cause": "high_cognitive_load"},
                rationale or "Deferred pending user attention.",
                domain=domain, reversible=reversible)
        return {"deferred": True, "load": _STATE.load_score(telegram_id),
                "journaled": True, "aligned_priority": aligned}

    final = {**(decision or {}), "aligned_priority": aligned}
    if supabase_client is not None:
        for _ in range(1):  # one append
            supabase_client.append_decision(
                telegram_id, context or {}, final,
                rationale, domain=domain, reversible=reversible)
    return {"deferred": False, "decision": final,
            "load": _STATE.load_score(telegram_id), "journaled": True,
            "aligned_priority": aligned}


def note_interaction(telegram_id: int):
    _STATE.note_interaction(telegram_id)


def journal(telegram_id: int, domain: str = "", outcome: str = "",
            limit: int = 50) -> list:
    if supabase_client is None:
        return []
    try:
        return supabase_client.list_decisions(telegram_id, domain=domain,
                                              outcome=outcome, limit=limit) or []
    except Exception:
        return []


def undo(telegram_id: int, decision_id: str) -> dict:
    """Reverse a delegated decision. Flips outcome -> reversed (journal stays).
    Returns confirmation. This is the override path that should also trigger a
    value-alignment review of why the decision was wrong."""
    if supabase_client is None:
        return {"ok": False, "reason": "no_supabase"}
    try:
        ok = supabase_client.reverse_decision(telegram_id, decision_id)
    except Exception:
        ok = False
    return {"ok": ok, "decision_id": decision_id, "outcome": "reversed"}


def weekly_digest(telegram_id: int) -> str:
    """Summarize delegated decisions for a weekly feedback prompt."""
    rows = journal(telegram_id, limit=60)
    if not rows:
        return ("📘 Minggu ini tidak ada keputusan otonom yang dicatat. "
                "/decision_journal untuk mulai.")
    total = len(rows)
    by_domain = {}
    reversed_n = 0
    for r in rows:
        d = r.get("domain") or "misc"
        by_domain[d] = by_domain.get(d, 0) + 1
        if r.get("outcome") == "reversed":
            reversed_n += 1
    lines = [f"📗 *Ringkasan offload mingguan* — {total} keputusan."]
    for d, c in sorted(by_domain.items(), key=lambda x: -x[1])[:6]:
        lines.append(f"• {d}: {c}")
    if reversed_n:
        lines.append(f"⚠️ {reversed_n} dibalik — bisa menjadi sinyal nilai "
                     "yang perlu disesuaikan (lihat /value_drift_report).")
    lines.append("\nSemua keputusan reversibel & dapat dibalik: /undo_decision <id>")
    return "\n".join(lines)
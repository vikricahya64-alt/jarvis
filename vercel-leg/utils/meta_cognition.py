"""
Meta-Cognition & Self-Audit (Level 7): weekly self-analysis producing concrete
improvement proposals with an immutable audit trail.

Flow: collect performance metrics → Groq analysis → classify risk → LOW risk
auto-fix (reversible) / HIGH risk human review → log to `meta_audit_log`.

Guardrails:
  * Pause switch (`/pause_evolution`) — when set, NO auto-fix is ever applied;
    recommendations are parked for review only.
  * Low-risk proposals (log-level, copy, minor thresholds) auto-apply via the
    existing reversible self_evolution. High-risk (architecture, security-adjacent,
    routing changes) are NEVER auto-applied.
  * Every proposal + decision is appended to Supabase `meta_audit_log`.

Synchronous on purpose (Vercel serverless; no event loop).
"""
import os
import json
import time
import hashlib
import logging
import datetime

from utils import supabase_client

logger = logging.getLogger("meta_cognition")

_AUDIT_SYSTEM = (
    "Kamu adalah arsitek meta-kognitif untuk sistem asisten AI-jarang-serverless. "
    "Analisis metrik performa dan usulkan perbaikan. Output HANYA JSON: "
    '{"summary":"<kalimat>","risk":"low|high",'
    '"recommendation":"<1 usulan konkret>","target_area":"router|model|memory|ux|code"} '
    "HIGH risk = perubahan arsitektur/keamanan/routing global. LOW = copywa/log/threshold."
)
PAUSE_KEY = "meta_pause"


# ------------------------------------------------------------------
# Metrics collection
# ------------------------------------------------------------------
def collect_metrics(telegram_id: int = 0) -> dict:
    """Gather cheap performance signals from Supabase (no heavy queries)."""
    m = {
        "routing": {"local": 0, "cloud": 0, "fallback": 0},
        "repairs_pending": supabase_client.count_self_repair("failed"),
        "repairs_applied": supabase_client.count_self_repair("applied"),
    }
    try:
        rows = supabase_client.get_residency_summary(telegram_id)
        m["routing"] = rows
    except Exception:
        pass
    try:
        m["pending_tasks"] = supabase_client.count_tasks("PENDING")
        m["processing_tasks"] = supabase_client.count_tasks("PROCESSING")
    except Exception:
        pass
    return m


def _pause_state(telegram_id: int) -> bool:
    """Whether evolution is paused (persisted in service_consent JSONB)."""
    try:
        consent = supabase_client.read_service_consent(telegram_id)
        return bool(consent.get(PAUSE_KEY, False))
    except Exception:
        return False


def set_pause(telegram_id: int, paused: bool) -> bool:
    """/pause_evolution toggles the emergency stop for auto-fixes."""
    try:
        consent = supabase_client.read_service_consent(telegram_id)
        consent[PAUSE_KEY] = bool(paused)
        return supabase_client.set_service_consent(telegram_id, consent)
    except Exception:
        return False


# ------------------------------------------------------------------
# Analysis
# ------------------------------------------------------------------
def analyze(metrics: dict, telegram_id: int = 0) -> dict:
    """Ask Groq to propose one improvement. Returns {} on failure/parse error."""
    try:
        from utils import groq_client
        raw = groq_client.plain_completion(
            _AUDIT_SYSTEM, json.dumps(metrics)[:2000],
            max_tokens=220, temperature=0.3)
    except Exception as exc:
        logger.warning("meta analysis failed: %s", exc)
        return {}
    start, end = (raw or "").find("{"), (raw or "").rfind("}")
    if start == -1 or end <= start:
        return {}
    try:
        res = json.loads(raw[start:end + 1])
    except Exception:
        return {}
    if not isinstance(res, dict):
        return {}
    # Normalize risk: anything not explicitly 'high' is 'low'.
    res["risk"] = "high" if str(res.get("risk", "low")) == "high" else "low"
    return res


# ------------------------------------------------------------------
# Apply policy
# ------------------------------------------------------------------
def _apply_recommendation(proposal: dict, telegram_id: int) -> str:
    """Apply a LOW-risk proposal via reversible self_evolution; HIGH parked."""
    risk = proposal.get("risk", "low")
    rec = str(proposal.get("recommendation", ""))[:240]
    target = str(proposal.get("target_area", "ux"))
    if risk == "high":
        return "parked_high_risk"
    if _pause_state(telegram_id):
        return "paused"
    try:
        from utils import self_evolution
        self_evolution.propose(telegram_id, rec, target)
        return "applied_low_risk"
    except Exception as exc:
        logger.warning("auto-fix apply failed: %s", exc)
        return "apply_failed"


# ------------------------------------------------------------------
# Weekly run (cron) / on-demand (/audit_report)
# ------------------------------------------------------------------
def run_weekly_audit(telegram_id: int = 0, persist: bool = True) -> dict:
    """Perform a meta-cognition pass; log to meta_audit_log when persist=True."""
    now = datetime.datetime.utcnow()
    week = f"{now.isocalendar()[0]}-W{now.isocalendar()[1]:02d}"
    metrics = collect_metrics(telegram_id)
    proposal = analyze(metrics, telegram_id)
    status = "proposed"
    if proposal:
        status = _apply_recommendation(proposal, telegram_id)
    if persist:
        supabase_client.record_meta_audit(
            telegram_id, week, metrics, proposal or {},
            risk=proposal.get("risk", "low") if proposal else "low",
            status=status)
    return {"week": week, "metrics": metrics, "proposal": proposal,
            "status": status}


def audit_report(telegram_id: int = 0) -> str:
    """Human-readable /audit_report summary."""
    paused = _pause_state(telegram_id)
    header = "🧠 *Laporan Audit Meta-Kognitif*\n"
    if paused:
        header += "⏸ EVOLUSI SEDANG DI-PAUSE — tidak ada auto-fix.\n"
    rows = supabase_client.latest_meta_audit(telegram_id)
    if not rows:
        return header + "\nBelum ada audit. Jalankan: /audit_report (paksa run)"
    lines = [header]
    for r in rows:
        rec = (r.get("recommendation") or {})
        lines.append(
            f"• {r.get('week')} — risk:{r.get('risk')} · {r.get('status')}\n"
            f"  {(rec.get('summary') or rec.get('recommendation') or '')[:120]}")
    lines.append("\nLanjutkan/matiikan otonomi: /pause_evolution")
    return "\n".join(lines)

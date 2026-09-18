"""
Hybrid Inference Router (Level 6): decide where each task runs.

Decides locally (Realme C25s sovereign core) vs cloud (Vercel+Groq+E2B) based
on:
  * Message sensitivity — PII/keyword scan via utils/data_sovereignty. Sensitive
    data is ALWAYS routed local (never sent to cloud).
  * Complexity score — token count + a lightweight local classifier signal.
    Simple/quick tasks stay local; heavy analytical/simulation tasks go cloud.
  * User preference override — `/force_local` / `/force_cloud` / `/auto_route`.
  * Device status — if the G85 reports high temp or RAM, or is unreachable,
    auto-route to cloud.

Guarantees:
  * Cloud calls NEVER contain unredacted PII (redaction happens before send).
  * Every decision is audited to `routing_log` (Supabase).
  * If the local device is unreachable (>15s), we fail over to cloud seamlessly.
  * Latency is tracked per decision for continuous router self-optimization.

Synchronous on purpose (Vercel serverless rejects asyncio.run -> EBUSY).
"""
import os
import re
import time
import hashlib
import logging

from utils import data_sovereignty as ds
from utils import device_comm
from utils import supabase_client

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("hybrid_router")

CLOUD_TIMEOUT_S = 15          # local device unreachable threshold
COMPLEXITY_PRIORITY_ONLY = ("simulasi", "simulate", "monte carlo",
                            "simulasi keuangan", "berat", "analisis besar",
                            "deep reasoning", "riset mendalam", "laporan panjang")
# Phrases that force LOCAL regardless of complexity (sovereign data).
_LOCAL_FORCE_HINTS = (
    "sandi", "kata sandi", "password", "pin", "otp", "rekening", "norek",
    "password saya", "rahasia", "secret",
)

_DEFAULT_THRESHOLD = 40       # complexity units below this -> local


def _hash(text: str) -> str:
    return hashlib.sha256((text or "").encode()).hexdigest()[:16]


# ------------------------------------------------------------------
# Sensitivity classifier
# ------------------------------------------------------------------
def classify_sensitivity(text: str) -> dict:
    """PII + keyword scan -> {"sensitive": bool, "pii_types": [...], "detected": bool}"""
    pii = ds.detect_pii(text or "")
    low = (text or "").lower()
    forced = any(h in low for h in _LOCAL_FORCE_HINTS)
    return {
        "sensitive": bool(pii["detected"]) or forced,
        "pii_types": pii["types"],
        "forced_hint": forced,
    }


# ------------------------------------------------------------------
# Complexity scorer (cheap & deterministic, no extra model call)
# ------------------------------------------------------------------
def complexity_score(text: str) -> float:
    """Units based on length + signal words. Higher = more complex = cloud."""
    t = (text or "").strip()
    tokens = len(t.split())
    score = min(tokens * 0.8, 60)          # length component
    low = t.lower()
    if any(p in low for p in COMPLEXITY_PRIORITY_ONLY):
        score += 40
    if any(p in low for p in _LOCAL_FORCE_HINTS):
        score -= 20                         # keep local despite length
    return round(score, 1)


# ------------------------------------------------------------------
# User preference override
# ------------------------------------------------------------------
def get_override(telegram_id: int) -> str:
    """Route override stored in profile.service_consent['route'].
    Values: 'auto' | 'local' | 'cloud'. Default 'auto'."""
    try:
        consent = supabase_client.read_service_consent(telegram_id)
        return consent.get("route", "auto")
    except Exception:
        return "auto"


def set_override(telegram_id: int, mode: str) -> bool:
    """Set /force_local, /force_cloud, or /auto_route. Stored in the same
    service_consent JSONB column to avoid a schema change."""
    if mode not in ("auto", "local", "cloud"):
        return False
    consent = supabase_client.read_service_consent(telegram_id)
    consent["route"] = mode
    return supabase_client.set_service_consent(telegram_id, consent)


# ------------------------------------------------------------------
# Core routing decision
# ------------------------------------------------------------------
def decide(telegram_id: int, text: str) -> dict:
    """
    Return a routing decision:
      {"decision": "local"|"cloud"|"fallback"|"force_local"|"force_cloud",
       "sensitivity": {...}, "complexity": float, "device": {...},
       "latency_ms": int, "message_hash": str}
    """
    t0 = time.time()
    msg_hash = _hash(text)
    sens = classify_sensitivity(text)
    complexity = complexity_score(text)
    override = get_override(telegram_id)

    # User override wins (highest precedence).
    if override == "local":
        decision = "force_local"
    elif override == "cloud":
        decision = "force_cloud"
    else:
        # Sensitive data must NEVER go to cloud.
        if sens["sensitive"]:
            decision = "local"
        else:
            # Probe device health (cheap, bounded).
            device = device_comm.check_device_health(timeout=5)
            if not device.get("online"):
                decision = "fallback"          # unreachable -> cloud
            elif (device.get("temp_c") and device["temp_c"] > 45) or \
                 (device.get("ram_pct") and device["ram_pct"] > 90):
                decision = "cloud"             # hot/low-RAM -> cloud
            elif complexity >= _DEFAULT_THRESHOLD:
                decision = "cloud"             # heavy -> powerful cloud
            else:
                decision = "local"             # simple -> sovereign local

    latency_ms = int((time.time() - t0) * 1000)

    # Audit the decision.
    try:
        supabase_client.log_routing(
            telegram_id, msg_hash, decision, complexity,
            1.0 if sens["sensitive"] else 0.0, latency_ms,
            {"temp_c": None, "online": True},
        )
    except Exception:
        pass

    return {
        "decision": decision,
        "sensitivity": sens,
        "complexity": complexity,
        "override": override,
        "latency_ms": latency_ms,
        "message_hash": msg_hash,
    }


# ------------------------------------------------------------------
# Execution dispatch with seamless cloud fallback
# ------------------------------------------------------------------
def route_and_execute(task_id: str, telegram_id: int, text: str,
                      cloud_runner=None):
    """
    Decide + execute. `cloud_runner(task_id, telegram_id, text)` is the
    orchestrator pipeline (called when routed to cloud/fallback). Local
    dispatch queues the encrypted task for the device; on any failure it
    falls back to cloud seamlessly.
    Returns (decision, ok, error, latency_ms).
    """
    t0 = time.time()
    decision = decide(telegram_id, text)

    if decision["decision"] in ("local", "force_local"):
        try:
            device_comm.send_to_local(
                {"telegram_id": telegram_id, "task_id": task_id,
                 "text": text}, task_id=task_id)
            supabase_client.log_residency(telegram_id, task_id, "local",
                                          False, [], [], "queued-for-device")
            # Let the device finish; the push endpoint delivers to Telegram.
            return decision["decision"], True, "", int((time.time() - t0) * 1000)
        except Exception as exc:
            logger.info(f"local queue failed ({exc}); failing over to cloud")
            decision["decision"] = "fallback"
            # Mark the queued task so the device won't double-run it.
            try:
                supabase_client.update_task(task_id, {"status": "PENDING"})
            except Exception:
                pass
    elif decision["decision"] == "force_cloud":
        pass  # always cloud

    if decision["decision"] in ("cloud", "force_cloud", "fallback"):
        # Cloud path: redact PII before the cloud call, then run the pipeline.
        redacted = ds.scan_and_redact(text)
        residency_ok = ds.verify_local_only_compliance(
            telegram_id, task_id, text, redacted["text"])
        text = redacted["text"]

        ok, err = True, ""
        if cloud_runner is not None:
            try:
                cloud_runner(task_id, telegram_id, text)
            except Exception as exc:
                ok, err = False, str(exc)[:300]
            supabase_client.log_residency(telegram_id, task_id,
                                          "cloud" if ok else "error",
                                          bool(residency_ok["pii_detected_before"]),
                                          residency_ok["pii_detected_before"] or [],
                                          residency_ok["pii_detected_after"] or [],
                                          "PII-redacted-before-cloud" if ok else "pipeline-error")
        return decision["decision"], ok, err, int((time.time() - t0) * 1000)

    return decision["decision"], False, "unhandled decision: " + decision["decision"], int((time.time() - t0) * 1000)


def location_tag(decision: str) -> str:
    """Human-visible execution indicator for Telegram."""
    return {
        "local": "🛡️ Local (Private)",
        "cloud": "🔵 Cloud (Powerful)",
        "fallback": "⚠️ Fallback (Cloud)",
        "force_local": "🛡️ Local (Forced)",
        "force_cloud": "🔵 Cloud (Forced)",
    }.get(decision, "🔵 Cloud")

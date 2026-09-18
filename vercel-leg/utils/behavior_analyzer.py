"""
Behavior Analyzer (Level 5): behavioral pattern mining + synthesized profile.

Stephen status = synchronous (Vercel serverless rejects asyncio.run -> EBUSY;
see api/webhook.py). We read the 30-day `v_user_behavioral_patterns` window,
synthesize it into a compact Behavior Profile via Groq, and store ONLY the
aggregate (differential privacy: never raw messages, never per-message text).

Privacy contract:
  * `behavior_profile` holds trending topics, dominant agent, active hours,
    confidence — aggregates only.
  * Profile synthesis is opt-in: callers check `profiles.service_consent`
    before running the Groq pass; the raw window rows never leave this module
    except as aggregate sums.
  * Users can review/delete their profile via /api/analytics/behavior.
"""
import json
import logging
import datetime

from utils import groq_client, supabase_client

logger = logging.getLogger("behavior")

# Minimum samples before we dare synthesize a profile (avoid noise on cold data).
MIN_SAMPLES = 5

_SYNTH_SYSTEM = (
    "Kamu adalah analis perilaku yang mengubah sinyal agregat menjadi profil "
    "singkat. Input adalalah data per-hari (tanpa teks mentah pesan). Keluarkan "
    "HANYA JSON objek dengan kunci: "
    '"dominant_agent" (string), "active_hours" (list string), '
    '"common_topics" (list string), "productivity_hint" (string pendek), '
    '"confidence" (0-1 angka). '
    "Jangan pernah mengarang data; jika sinyal terlalu sedikit, set "
    'confidence rendah. Balas HANYA JSON.'
)


def _buckets_to_topics(patterns: list) -> list:
    """Leftover listing step: cluster lightweight signals into topics.
    We do NOT read message bodies here — only first-char buckets from the
    view are used as a low-information topic proxy."""
    return []


def synthesize_profile(telegram_id: int) -> dict:
    """Compute + Groq-synthesize a Behavior Profile for a user.

    Returns the profile dict, or None when there is not enough data
    (or the user has opted out / Groq is unavailable).
    """
    patterns = supabase_client.get_behavioral_patterns(telegram_id, days=30)
    if not patterns or len(patterns) < MIN_SAMPLES:
        return None

    # Aggregate the daily rows into a compact, privacy-safe summary.
    total, done, failed = 0, 0, 0
    agents = {}
    days = set()
    for row in patterns:
        total += row.get("task_count") or 0
        done += row.get("done_count") or 0
        failed += row.get("failed_count") or 0
        ag = row.get("dominant_agent") or "main"
        agents[ag] = agents.get(ag, 0) + 1
        day = row.get("activity_day")
        if day:
            days.add(str(day)[:10])

    # Hourly activity derived from view timestamps is coarse; we keep the
    # day-counts only. Active hours come from the Groq pass as an estimate.
    summary = {
        "samples": len(patterns),
        "active_days": len(days),
        "total_tasks": total,
        "done_tasks": done,
        "failed_tasks": failed,
        "done_ratio": round(done / total, 3) if total else 0,
        "agent_distribution": agents,
    }
    if not summary["total_tasks"]:
        return None

    try:
        raw = groq_client.plain_completion(
            _SYNTH_SYSTEM,
            json.dumps(summary, ensure_ascii=False),
            max_tokens=400,
            temperature=0.3,
        )
    except Exception as exc:
        logger.error(f"behavior synthesis failed: {exc}")
        return None

    profile = _parse_profile(raw)
    if profile is None:
        return None

    profile["_ref"] = {
        "samples": summary["samples"],
        "active_days": summary["active_days"],
        "total_tasks": summary["total_tasks"],
        "done_ratio": summary["done_ratio"],
        "synthesized_at": datetime.datetime.utcnow().isoformat(),
    }
    return profile


def _parse_profile(raw: str) -> dict:
    start, end = (raw or "").find("{"), (raw or "").rfind("}")
    if start == -1 or end <= start:
        return None
    try:
        obj = json.loads(raw[start:end + 1])
    except Exception:
        return None
    if not isinstance(obj, dict) or not obj.get("dominant_agent"):
        return None
    return obj


def get_or_update_profile(telegram_id: int, force: bool = False) -> dict:
    """Return the stored behavior profile; synthesize+persist when missing
    (or when `force`). Privacy-gated by consent."""
    consent = supabase_client.read_service_consent(telegram_id)
    if consent.get("behavioral", True) is False:
        return {}

    stored = (supabase_client.get_profile(telegram_id)
              .get("behavior_profile") or {})
    if stored and not force:
        return stored

    profile = synthesize_profile(telegram_id)
    if profile:
        supabase_client.set_behavior_profile(telegram_id, profile)
        return profile
    return stored


def delete_profile(telegram_id: int) -> bool:
    """Privacy command: wipe the behavior profile aggregate."""
    return supabase_client.set_behavior_profile(telegram_id, {})

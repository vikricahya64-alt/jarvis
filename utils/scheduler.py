"""
Schedule management for autonomous jobs (table: scheduled_jobs).

Insert/list/delete via the owner's telegram chat id; actual firing happens
in api/cron-trigger.py (CAS-claim on next_run_at). All functions pageable and
fail-soft (return {"error": ...} on Supabase/DB failure).
"""
import datetime
import time

import httpx

from utils.supabase_client import _config, _auth_headers


def create_job(telegram_id: int, interval_minutes: int, prompt: str,
               cron_expr: str = None, name: str = "") -> dict:
    """Create a scheduled job (interval minutes OR a 'M H * * DOW' cron expr)."""
    base, _ = _config()
    if cron_expr:
        next_when = _next_run(0, 1)
    else:
        next_when = _next_run(interval_minutes, 0)
    try:
        with httpx.Client(timeout=10) as client:
            r = client.post(
                f"{base}/rest/v1/scheduled_jobs",
                json={
                    "telegram_chat_id": telegram_id,
                    "name": name or prompt.strip()[:60],
                    "prompt": prompt,
                    "interval_minutes": interval_minutes,
                    "cron_expr": cron_expr,
                    "enabled": True,
                    "next_run_at": next_when,
                },
                headers=_auth_headers(),
                params={"Prefer": "return=representation"},
            )
            if r.status_code >= 400:
                return {"error": f"Gagal simpan jadwal (HTTP {r.status_code}): {r.text[:300]}"}
            rows = r.json() or []
            if not rows:
                return {"error": "Supabase tidak mengembalikan baris"}
            return {"success": True, "job": rows[0]}
    except Exception as exc:
        return {"error": f"Kesalahan jaringan: {exc}"}


# Default Level 3 autonomous jobs (WIB = UTC+7, so the crons below are UTC).
DEFAULT_JOBS = [
    {
        "name": "Morning Briefing",
        "cron": "0 23 * * *",          # 06:00 WIB every day
        "prompt": ("Briefing pagi singkat: cuaca kota saya sekarang dan "
                   "agenda kalender Google saya (get_calendar_events) yang "
                   "akan datang hari ini, jika tersedia."),
    },
    {
        "name": "Weekly Report",
        "cron": "0 10 * * fri",        # Friday 17:00 WIB
        "prompt": ("Buat laporan mingguan singkat: ringkas tugas yang "
                   "selesai minggu ini (todo selesai), skor produktivitas "
                   "hari ini, dan satu saran perbaikan."),
    },
]


def seed_default_jobs(telegram_id: int) -> dict:
    """Create the default Level 3 autonomous jobs idempotently (per user)."""
    created = []
    skipped = []
    for job in DEFAULT_JOBS:
        existing = list_jobs(telegram_id).get("jobs", [])
        if any((j.get("name") or "").strip() == job["name"] for j in existing):
            skipped.append(job["name"])
            continue
        res = create_job(telegram_id, 0, job["prompt"],
                         cron_expr=job["cron"], name=job["name"])
        if res.get("success"):
            created.append(job["name"])
        else:
            skipped.append(f"{job['name']} ({res.get('error', '?')})")
    return {"created": created, "skipped": skipped}


def list_jobs(telegram_id: int) -> dict:
    base, _ = _config()
    try:
        with httpx.Client(timeout=10) as client:
            r = client.get(
                f"{base}/rest/v1/scheduled_jobs",
                params={
                    "select": "*,id",
                    "telegram_chat_id": f"eq.{telegram_id}",
                    "order": "next_run_at.asc",
                },
                headers=_auth_headers(),
            )
            if r.status_code >= 400:
                return {"error": f"Gagal baca jadwal (HTTP {r.status_code})"}
            jobs = r.json() or []
            return {"success": True, "jobs": jobs}
    except Exception as exc:
        return {"error": f"Kesalahan jaringan: {exc}"}


def delete_job(telegram_id: int, job_id: int) -> dict:
    base, _ = _config()
    try:
        with httpx.Client(timeout=10) as client:
            r = client.delete(
                f"{base}/rest/v1/scheduled_jobs",
                params={"id": f"eq.{job_id}",
                        "telegram_chat_id": f"eq.{telegram_id}"},
                headers=_auth_headers(),
            )
            if r.status_code >= 400:
                return {"error": f"Gagal hapus (HTTP {r.status_code})"}
            return {"success": True}
    except Exception as exc:
        return {"error": f"Kesalahan jaringan: {exc}"}


def _next_run(interval_minutes: int, delay_s: int = 0) -> str:
    return (datetime.datetime.now(datetime.timezone.utc)
            + datetime.timedelta(seconds=delay_s, minutes=int(interval_minutes or 0))
            ).isoformat()
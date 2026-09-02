"""
Autonomous scheduler endpoint. URL: /api/cron-trigger

Triggered periodically (GitHub Actions cron OR Supabase pg_cron) WITHOUT any
user message. It:
  1. Pulls due rows from `scheduled_jobs` (enabled, next_run_at <= now).
  2. Claims each via a compare-and-swap on next_run_at so concurrent
     triggers can never double-run a job (this is the rate-limit gate).
  3. Enqueues the job prompt as a PENDING task (the existing worker cref;
     the first due job is also executed inline under the 60s budget).
  4. Advances next_run_at from interval_minutes or a small cron_expr parser.

Auth: `Authorization: Bearer $CRON_SECRET` (same value as Vercel's env var).
"""
import datetime
import json
import logging
import os
import re
from http.server import BaseHTTPRequestHandler

from utils import supabase_client

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("cron-trigger")

MAX_JOBS_PER_RUN = 5        # hard cap per trigger (runaway protection)
INLINE_PROCESS = 1          # how many claimed jobs run immediately

# Day-of-week numbers must match datetime.weekday() (Monday == 0):
# 3-letter, 2-letter and full names all accepted.
_WEEKDAYS = {
    "mon": 0, "tue": 1, "wed": 2, "thu": 3, "fri": 4, "sat": 5, "sun": 6,
    "mo": 0, "tu": 1, "we": 2, "th": 3, "fr": 4, "sa": 5, "su": 6,
    "monday": 0, "tuesday": 1, "wednesday": 2, "thursday": 3,
    "friday": 4, "saturday": 5, "sunday": 6,
}


def _due_jobs(limit: int = MAX_JOBS_PER_RUN) -> list:
    base, _ = supabase_client._config()
    now = datetime.datetime.utcnow().isoformat()
    with __import__("httpx").Client(timeout=supabase_client._TIMEOUT) as client:
        res = client.get(
            f"{base}/rest/v1/scheduled_jobs",
            params={"select": "*", "enabled": "eq.true",
                    "next_run_at": f"lte.{now}",
                    "order": "next_run_at.asc", "limit": str(limit)},
            headers=supabase_client._auth_headers(),
        )
    if res.status_code == 404:
        return []  # table not created yet
    supabase_client._raise_for(res, "scheduled_jobs.select")
    return res.json()


def _compute_next(job: dict, now=None) -> datetime.datetime:
    """Next run time from interval_minutes or a 'M H * * [DOW]' cron expr."""
    now = now or datetime.datetime.utcnow()
    interval = job.get("interval_minutes")
    if interval and int(interval) > 0:
        ref = job.get("last_run_at")
        base = None
        if ref:
            try:
                base = datetime.datetime.fromisoformat(str(ref).replace("Z", "+00:00"))
                base = base.replace(tzinfo=None)
            except Exception:
                base = None
        base = base or now
        return base + datetime.timedelta(minutes=int(interval))

    expr = (job.get("cron_expr") or "").strip()
    m = re.match(r"^(\d{1,2})\s+(\d{1,2})(?:\s+\*\s+\*\s*(\*|[A-Za-z]{2,3}))?$", expr)
    if not m:
        return now + datetime.timedelta(days=1)  # unknown format: retry tomorrow
    minute, hour = int(m.group(1)), int(m.group(2))
    dow = _WEEKDAYS.get((m.group(3) or "*").lower()[:3], None)

    if dow is None:
        cand = now.replace(hour=hour, minute=minute, second=0, microsecond=0)
        if cand <= now:
            cand += datetime.timedelta(days=1)
        return cand

    days_ahead = (dow - now.weekday() - 1) % 7 + 1
    cand = now.replace(hour=hour, minute=minute, second=0, microsecond=0) \
              + datetime.timedelta(days=days_ahead)
    if cand <= now:
        cand += datetime.timedelta(days=7)
    return cand


def _claim(job: dict) -> bool:
    """CAS-claim by patching only when next_run_at still equals the old value."""
    base, _ = supabase_client._config()
    next_run = _compute_next(job).isoformat()
    now = datetime.datetime.utcnow().isoformat()
    payload = {"last_run_at": now, "run_count": job.get("run_count", 0) + 1,
               "next_run_at": next_run}
    with __import__("httpx").Client(timeout=supabase_client._TIMEOUT) as client:
        res = client.patch(
            f"{base}/rest/v1/scheduled_jobs",
            params={"id": f"eq.{job['id']}",
                    "next_run_at": f"eq.{job['next_run_at']}"},
            json=payload,
            headers={**_auth_headers(), "Prefer": "return=representation"},
        )
    if res.status_code == 404:
        return False
    supabase_client._raise_for(res, "scheduled_jobs.claim")
    return bool(res.json())


def _auth_headers():
    return supabase_client._auth_headers()


def _run_job_inline(task_id, telegram_id, prompt):
    """Run one claimed job in this function's window (bounded)."""
    try:
        from utils.groq_client import set_budget
        from api.orchestrator import _run_pipeline
        set_budget(40)
        _run_pipeline(task_id, telegram_id, prompt, autonomous=True)
    except Exception as exc:
        logger.exception(f"inline autonomous run failed: {exc}")


def run_trigger() -> dict:
    jobs = _due_jobs()
    claimed = 0
    enqueued = []
    skipped_dup = 0
    for job in jobs:
        if not _claim(job):
            skipped_dup += 1
            continue
        claimed += 1
        task_id = supabase_client.insert_task(job["telegram_chat_id"],
                                              job["prompt"])
        enqueued.append({"job": job["name"], "task_id": task_id,
                         "telegram_chat_id": job["telegram_chat_id"],
                         "prompt": job["prompt"]})

    inline_task_id = None
    if enqueued:
        first = enqueued[0]
        inline_task_id = first["task_id"]
        _run_job_inline(first["task_id"], first["telegram_chat_id"],
                        first["prompt"])
    return {
        "ok": True,
        "jobs_due": len(jobs),
        "jobs_claimed": claimed,
        "skipped_duplicates": skipped_dup,
        "enqueued": enqueued[:MAX_JOBS_PER_RUN],
        "inline_task": inline_task_id,
    }


class handler(BaseHTTPRequestHandler):

    def do_GET(self):
        try:
            body = run_trigger() if self._authed() else {
                "ok": True, "service": "J.A.R.V.I.S. cron-trigger"}
        except Exception as exc:
            logger.exception("cron-trigger failed")
            body = {"ok": False, "error": str(exc)[:300]}
        self._send_json(body, 200)

    def do_POST(self):
        try:
            if not self._authed():
                return self._send_json({"ok": False, "error": "Unauthorized"}, 401)
            body = run_trigger()
        except Exception as exc:
            logger.exception("cron-trigger POST failed")
            body = {"ok": False, "error": str(exc)[:300]}
        self._send_json(body, 200)

    def _authed(self) -> bool:
        secret = os.getenv("CRON_SECRET", "")
        provided = self.headers.get("Authorization", "").replace("Bearer ", "")
        if not provided:
            from urllib.parse import urlparse, parse_qs
            provided = parse_qs(urlparse(self.path).query).get("secret", [""])[0]
        return bool(secret) and provided == secret

    def _read_json(self):
        length = int(self.headers.get("Content-Length", 0) or 0)
        body = self.rfile.read(length) if length else b""
        return json.loads(body or b"{}")

    def _send_json(self, payload, status):
        data = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, format, *args):
        logger.info("%s - %s" % (self.address_string(), format % args))
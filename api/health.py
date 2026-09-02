"""
Health / monitoring endpoint for J.A.R.V.I.S.
URL: /api/health

Reports dependency liveness (Supabase, Groq, Telegram), queued-task
statistics, and optionally runs a one-shot repair of stuck PROCESSING tasks.

Usage:
  GET /api/health            -> basic checks + task stats
  GET /api/health?full=1     -> also probe the Tavily key (costs quota)
  GET /api/health?repair=1   -> also reset stuck PROCESSING tasks to PENDING

All checks are guarded: one failing dependency degrades the report, never
crashes the endpoint. Responses are sanitized (no secrets, no error text).
"""
import os
import json
import logging
import datetime
import httpx
from http.server import BaseHTTPRequestHandler

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("health")

STUCK_MINUTES = 10


def _ts():
    return datetime.datetime.utcnow().isoformat() + "Z"


def _count(client: httpx.Client, base: str, headers: dict, params: dict) -> int:
    """Count rows matching params via PostgREST's exact count header."""
    res = client.get(
        f"{base}/rest/v1/tasks",
        params={"select": "id", **params},
        headers={**headers, "Prefer": "count=exact"},
    )
    if res.status_code >= 400:
        return -1
    cr = res.headers.get("content-range", "*/0")
    try:
        return int(cr.split("/")[1])
    except Exception:
        return -1


def _collect(full: bool = False, repair: bool = False) -> dict:
    checks = {}

    url = (os.getenv("SUPABASE_URL") or "").rstrip("/")
    supabase_key = os.getenv("SUPABASE_SERVICE_KEY") or os.getenv("SUPABASE_KEY")
    check_supabase = bool(url and supabase_key)

    with httpx.Client(timeout=8) as client:
        # --- Supabase: read one tasks row (cheap, proves key works) ---
        if check_supabase:
            try:
                r = client.get(
                    f"{url}/rest/v1/tasks",
                    params={"select": "id", "limit": "1"},
                    headers={
                        "apikey": supabase_key,
                        "Authorization": f"Bearer {supabase_key}",
                    },
                )
                checks["supabase"] = "up" if r.status_code < 400 else "down"
            except Exception:
                checks["supabase"] = "down"
        else:
            checks["supabase"] = "unconfigured"

        # --- Groq: models list proves the API key works ---
        groq_key = os.getenv("GROQ_API_KEY")
        if groq_key:
            try:
                r = client.get(
                    "https://api.groq.com/openai/v1/models",
                    headers={"Authorization": f"Bearer {groq_key}"},
                )
                checks["groq"] = "up" if r.status_code == 200 else "down"
            except Exception:
                checks["groq"] = "down"
        else:
            checks["groq"] = "unconfigured"

        # --- Telegram: getMe proves the bot token works ---
        tg_token = os.getenv("TELEGRAM_TOKEN")
        if tg_token:
            try:
                r = client.get(f"https://api.telegram.org/bot{tg_token}/getMe")
                checks["telegram"] = (
                    "up" if r.status_code == 200 and (r.json() or {}).get("ok")
                    else "down"
                )
            except Exception:
                checks["telegram"] = "down"
        else:
            checks["telegram"] = "unconfigured"

        # --- Tavily: optional, costs API quota, only with ?full=1 ---
        if full:
            tavily_key = os.getenv("TAVILY_API_KEY")
            if tavily_key:
                try:
                    r = client.post(
                        "https://api.tavily.com/search",
                        json={
                            "api_key": tavily_key,
                            "query": "health check",
                            "max_results": 1,
                            "search_depth": "basic",
                        },
                    )
                    checks["tavily"] = "up" if r.status_code == 200 else "down"
                except Exception:
                    checks["tavily"] = "down"
            else:
                checks["tavily"] = "unconfigured"
        else:
            checks["tavily"] = "skipped"

        # --- Task statistics ---
        tasks = {}
        if check_supabase:
            headers = {
                "apikey": supabase_key,
                "Authorization": f"Bearer {supabase_key}",
            }
            cutoff = (
                datetime.datetime.utcnow() - datetime.timedelta(minutes=STUCK_MINUTES)
            ).isoformat() + "Z"
            day_ago = (
                datetime.datetime.utcnow() - datetime.timedelta(hours=24)
            ).isoformat() + "Z"
            tasks["pending"] = _count(client, url, headers, {"status": "eq.PENDING"})
            tasks["processing"] = _count(client, url, headers, {"status": "eq.PROCESSING"})
            tasks["stuck_processing"] = _count(client, url, headers, {
                "status": "eq.PROCESSING",
                "updated_at": f"lt.{cutoff}",
            })
            tasks["failed_24h"] = _count(client, url, headers, {
                "status": "eq.FAILED",
                "created_at": f"gte.{day_ago}",
            })
            tasks["done_24h"] = _count(client, url, headers, {
                "status": "eq.DONE",
                "created_at": f"gte.{day_ago}",
            })
        else:
            tasks = {"error": "supabase unconfigured"}

    # --- Repair: reset stuck PROCESSING tasks (no need to wait for cron) ---
    repaired = None
    if repair and check_supabase:
        try:
            from utils.supabase_client import reclaim_stale_tasks
            repaired = reclaim_stale_tasks()
        except Exception:
            repaired = -1

    return {"checks": checks, "tasks": tasks, "repaired": repaired}


def _overall(checks: dict) -> str:
    """ok = everything healthy; down = can't operate (Supabase/Groq down);
    degraded = a secondary dependency is down but the bot still works."""
    if checks.get("supabase") == "down" or checks.get("groq") == "down":
        return "down"
    for name, value in checks.items():
        if value == "down":
            return "degraded"
    return "ok"


class handler(BaseHTTPRequestHandler):

    def do_GET(self):
        from urllib.parse import urlparse, parse_qs
        qs = parse_qs(urlparse(self.path).query)
        full = qs.get("full", ["0"])[0] == "1"
        repair = qs.get("repair", ["0"])[0] == "1"
        try:
            data = _collect(full=full, repair=repair)
        except Exception:
            logger.exception("Health check failed")
            return self._send_json({"ok": False, "error": "health check failed"}, 500)

        overall = _overall(data["checks"])
        payload = {
            "ok": overall == "ok",
            "overall": overall,
            "service": "J.A.R.V.I.S.",
            "checks": data["checks"],
            "tasks": data["tasks"],
            "repaired": data["repaired"],
            "ts": _ts(),
        }
        self._send_json(payload, 200 if overall != "down" else 503)

    def _send_json(self, payload, status):
        data = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, format, *args):
        logger.info("%s - %s" % (self.address_string(), format % args))
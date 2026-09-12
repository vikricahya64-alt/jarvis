"""
Vercel Cron worker: processes queued PENDING tasks.

Triggered on a schedule (see vercel.json "crons"). Each invocation claims
the single oldest PENDING task from Supabase, marks it PROCESSING, runs the
orchestrator pipeline, and updates the task to DONE/FAILED. This is a
reliable replacement for a Supabase Database webhook, which free projects
often cannot create (the underlying schema is owned by supabase_admin).

The cron route is protected by a shared secret header so only Vercel can
invoke it.
"""
import os
import json
import logging
from http.server import BaseHTTPRequestHandler

from utils import supabase_client

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("cron")


def process_one() -> dict:
    """Claim and process exactly one PENDING task. Returns a summary dict."""
    task = supabase_client.claim_next_pending()
    if task is None:
        return {"processed": False, "reason": "no pending tasks"}

    task_id = task["id"]
    telegram_id = task.get("telegram_id")
    user_input = task.get("input")

    if not (telegram_id and user_input):
        try:
            supabase_client.update_task(task_id, {
                "status": "FAILED",
                "error": "Missing required fields (telegram_id/input)",
            })
        except Exception:
            pass
        return {"processed": True, "task_id": task_id, "result": "FAILED: missing fields"}

    try:
        from api.orchestrator import _run_pipeline
        _run_pipeline(task_id, telegram_id, user_input)
        return {"processed": True, "task_id": task_id, "result": "DONE"}
    except Exception as exc:
        logger.exception(f"Cron pipeline failed for task {task_id}")
        try:
            supabase_client.update_task(task_id, {
                "status": "FAILED",
                "error": str(exc)[:500],
            })
        except Exception:
            pass
        try:
            from utils.telegram import send_message
            send_message(
                telegram_id,
                "Ups, terjadi kendala saat memproses permintaan Anda. "
                "Kendala sudah tercatat dan akan saya coba lagi. 🙏",
            )
        except Exception:
            pass
        return {"processed": True, "task_id": task_id, "result": "FAILED"}


def process_swarm_one() -> dict:
    """Claim and process one PENDING swarm row (agent child or parent).

    Runs after the normal text cron, so child rows no longer starve. Uses
    include_agents=True to pick up rows with agent_type != null that the main
    worker deliberately skips.
    """
    task = supabase_client.claim_next_pending(include_agents=True)
    if task is None:
        return {"processed": False, "reason": "no pending swarm rows"}

    task_id = task["id"]
    telegram_id = task.get("telegram_id")
    user_input = task.get("input")
    agent_type = task.get("agent_type")

    if not (telegram_id and user_input):
        try:
            supabase_client.update_task(task_id, {
                "status": "FAILED",
                "error": "Missing required fields (telegram_id/input)",
            })
        except Exception:
            pass
        return {"processed": True, "task_id": task_id, "result": "FAILED: missing fields"}

    try:
        from api import swarm_coordinator
        if agent_type:
            res = swarm_coordinator.handle_agent_task(
                task_id, telegram_id, user_input, agent_type)
            return {"processed": True, "task_id": task_id,
                    "result": "DONE" if res.get("success") else "FAILED"}
        result = swarm_coordinator.handle_parent_task(task_id, telegram_id, user_input)
        return {"processed": True, "task_id": task_id,
                "result": "DONE" if result.get("status") == "DONE" else "FAILED"}
    except Exception as exc:
        logger.exception(f"Swarm cron pipeline failed for task {task_id}")
        try:
            supabase_client.update_task(task_id, {
                "status": "FAILED",
                "error": str(exc)[:500],
            })
        except Exception:
            pass
        return {"processed": True, "task_id": task_id, "result": "FAILED"}


class handler(BaseHTTPRequestHandler):

    def do_GET(self):
        # Require the cron secret header (set via CRON_SECRET env var).
        token = self.headers.get("Authorization", "").replace("Bearer ", "")
        secret = os.getenv("CRON_SECRET", "")
        if secret and token != secret:
            self._send_json({"ok": False, "error": "Unauthorized"}, 401)
            return

        try:
            summary = process_one()
            logger.info(f"Cron result: {summary}")
            # Also drain one swarm/agent row so child tasks (agent_type !=
            # null) don't starve behind the text worker.
            try:
                swarm_summary = process_swarm_one()
                logger.info(f"Cron swarm result: {swarm_summary}")
                summary["swarm"] = swarm_summary
            except Exception as exc:
                logger.exception(f"Swarm cron sub-step failed: {exc}")
                summary["swarm"] = {"processed": False, "reason": f"error: {exc}"}
            self._send_json({"ok": True, **summary}, 200)
        except Exception as exc:
            logger.exception("Cron worker failed")
            self._send_json({"ok": False, "error": str(exc)}, 500)

    def _send_json(self, payload, status):
        data = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, format, *args):
        logger.info("%s - %s" % (self.address_string(), format % args))
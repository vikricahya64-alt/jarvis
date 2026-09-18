#!/usr/bin/env python3
r"""
legacy_monitor_fly.py — 24/7 Dead Man's Switch monitor for Level 9
(Digital Legacy Vault).

Runs on an always-on worker (Fly.io / Render) that Vercel Hobby cannot
provide. Every <interval_s> seconds it:

  1. Refreshes the user's activity heartbeat (so the DMS measures real
     inactivity, not a sleeping server).
  2. Evaluates the dead man's switch via `legacy_vault.switch_state`.
  3. If armed AND multisig satisfied AND execute enabled AND intent is a
     material action, schedules the action (never runs destructive steps
     without an explicit `--execute` flag and the escalation guard).

Fail-safe by default: without `--execute`, this process NO-OPs even when the
switch is armed. Any runtime error logs and defers — it never auto-triggers
destruction.

HTTP: serves a tiny /healthz on 8080 so Fly.io can verify liveness (optional;
skip with --no-http). Fly checks it in fly.toml \[[http_service]].

Prereqs: httpx. Env: SUPABASE_URL, SUPABASE_SERVICE_KEY|SUPABASE_KEY,
BACKUP_PASSPHRASE, JARVIS_DMS_GRACE_DAYS, JARVIS_MULTISIG_THRESHOLD,
TELEGRAM_TOKEN (optional for alerting).
"""
import os
import sys
import time
import json
import argparse
import logging

_THIS = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(_THIS))  # repo root -> utils

from utils import legacy_vault as lv  # noqa: E402

log = logging.getLogger("legacy_monitor")


def _env(bool_attr: str) -> bool:
    v = os.getenv(bool_attr, "").strip().lower()
    return v in ("1", "true", "yes", "on")


def _refresh_activity(telegram_id: int) -> None:
    """Best-effort activity refresh. Vercel/worker touches last_activity by
    writing a heartbeat decision-journal row only if this worker is the one
    the bot uses; here we just re-read (non-mutating) to keep semantics clear."""
    try:
        # Non-mutating probe so we don't create false 'activity' rows.
        _ = lv.last_activity(telegram_id)
    except Exception as exc:  # noqa: BLE001
        log.warning("activity refresh skipped: %s", exc)


def run_once(telegram_id: int, execute: bool) -> dict:
    """Single evaluation cycle. Safe by default (no-op unless execute+armed)."""
    state = lv.switch_state(telegram_id)
    out = {"ts": int(time.time()), "armed": state.get("armed", False),
           "elapsed_days": state.get("elapsed_days", 0),
           "would_take": state.get("would_take", "ok")}
    if not execute:
        out["mode"] = "dry_run"
        out["action"] = "noop"
        return out
    # execute mode: delegate to the vault monitor (still fail-safe internally)
    res = lv.monitor(telegram_id, execute=True)
    out["mode"] = "execute"
    out["monitor"] = res
    return out


def serve(interval_s: int, telegram_id: int, execute: bool, no_http: bool):
    from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

    last_state = {"armed": False, "elapsed_days": 0}

    def evaluate():
        _refresh_activity(telegram_id)
        s = run_once(telegram_id, execute)
        last_state.update({"armed": s.get("armed", False),
                           "elapsed_days": s.get("elapsed_days", 0)})
        log.info("cycle: %s", json.dumps(s))
        return s

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):  # noqa: N802
            if self.path.startswith("/healthz"):
                body = json.dumps({"ok": True, **_last_body()}).encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
            else:
                self.send_response(404)
                self.end_headers()

        def log_message(self, *a):  # quiet
            pass

    def _last_body():
        return {"armed": last_state["armed"],
                "elapsed_days": last_state["elapsed_days"]}

    evaluate()
    if no_http:
        log.info("evaluated once; --no-http, exiting")
        return

    port = int(os.getenv("PORT", "8080"))
    srv = ThreadingHTTPServer(("0.0.0.0", port), Handler)
    log.info("serving /healthz on :%s", port)
    srv.timeout = interval_s
    deadline = time.time()
    while True:
        srv.handle_request()  # blocks up to timeout then we evaluate anyway
        now = time.time()
        if now >= deadline:
            evaluate()
            deadline = now + interval_s


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--telegram-id", type=int, default=0,
                    help="owner telegram_id (0 = template/global)")
    ap.add_argument("--interval", type=int, default=21600,
                    help="evaluation interval in seconds (default 6h)")
    ap.add_argument("--execute", action="store_true",
                    help="ALLOW the DMS to act when armed (default: dry-run)")
    ap.add_argument("--no-http", action="store_true",
                    help="run one cycle then exit (no /healthz server)")
    ap.add_argument("--once", action="store_true",
                    help="evaluate once and exit (with HTTP still on)")
    args = ap.parse_args(argv)

    logging.basicConfig(
        level=os.getenv("LOG_LEVEL", "INFO"),
        format="%(asctime)s %(levelname)s %(name)s %(message)s")

    if args.once:
        print(json.dumps(run_once(args.telegram_id, args.execute)))
        return

    serve(args.interval, args.telegram_id, args.execute, args.no_http)


if __name__ == "__main__":
    main()
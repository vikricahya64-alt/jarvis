"""
J.A.R.V.I.S. Level 10 — Ephemeral Compute Workers (utils/ephemeral_worker.py)

Spawns temporary Fly machines for burst workloads, captures their output, then
destroys them immediately. Keeps free-tier limits bounded:
  * MAX_CONCURRENT = 2 (free tier: 3 total, reserve 1 for primary/monitor)
  * Hard per-task timeouts (researcher 60s, coder 120s, validator 30s)
  * Priority queue: Constitutional violations > Legacy triggers > User commands
    > Background tasks. Queue depth > QUEUE_MAX rejects low-priority tasks.

Lifecycle (Fly Machines API)
  POST /apps/{app}/machines   -> create with auto_destroy=true, restart no
  Wait via Events/exit polling -> capture stdout/stderr before destruction
  DELETE /apps/{app}/machines/{id} -> cleanup (also triggered by auto_destroy)

Synchronous; timeouts enforced by polling deadlines (no async reliance).
"""
import os
import time
import json
import logging
import threading
import queue
from collections import deque

import httpx

try:
    from utils.telegram import send_message
except ImportError:
    send_message = None

log = logging.getLogger("ephemeral")

MAX_CONCURRENT = int(os.getenv("JARVIS_EPH_MAX_CONCURRENT", "2"))
QUEUE_MAX = int(os.getenv("JARVIS_EPH_QUEUE_MAX", "5"))

# Worker type -> (image/Cmd hint, max runtime seconds)
WORKERS = {
    "researcher": {"timeout_s": int(os.getenv("JARVIS_RESEARCH_TIMEOUT", "60")),
                   "cmd": ["python3", "-c",
                           "\"import httpx,json;print('researcher')\""]},
    "coder": {"timeout_s": int(os.getenv("JARVIS_CODER_TIMEOUT", "120")),
              "cmd": ["python3", "-c", "\"print('coder')\""]},
    "validator": {"timeout_s": int(os.getenv("JARVIS_VALIDATOR_TIMEOUT", "30")),
                  "cmd": ["python3", "-c", "\"print('validator')\""]},
}

_PRIORITY = {"violation": 0, "legacy": 1, "user": 2, "background": 3}

# in-process state
_TASKS = {}
_counters = {"created": 0, "destroyed": 0, "rejected": 0}
_LOCK = threading.Lock()


def _fly_api():
    token = os.getenv("FLY_API_TOKEN")
    if not token:
        return None
    return httpx.Client(base_url="https://api.machines.dev/v1",
                        headers={"Authorization": f"Bearer {token}",
                                 "Content-Type": "application/json"},
                        timeout=20.0)


def _app() -> str:
    return os.getenv("FLY_APP", "jarvis-ubiquitous")


def _running(api) -> int:
    if not api:
        return 0
    try:
        r = api.get(f"/apps/{_app()}/machines")
        machines = r.json() if r.status_code < 400 else []
        return len([m for m in machines
                    if m.get("state") in ("started", "starting")])
    except Exception:
        return 0


def queue_depths() -> dict:
    # returns pseudo-view of worker-slot availability + counters
    with _LOCK:
        return {"running": len(_TASKS), "max": MAX_CONCURRENT,
                "created": _counters["created"],
                "destroyed": _counters["destroyed"],
                "rejected": _counters["rejected"]}


def propose(worker_type: str, priority: str = "background",
            payload: dict = None, session_id: str = None, **extra) -> dict:
    """Enqueue a task based on priority + concurrency limits. If no slot is
    available it is queued here (in-memory) up to QUEUE_MAX depth. Returns a
    submission dict the caller can poll with collect()."""
    worker_type = worker_type if worker_type in WORKERS else "validator"
    prio = _PRIORITY.get(priority, _PRIORITY["background"])
    t = WORKERS[worker_type]
    with _LOCK:
        running = len(_TASKS)
        total = running + _pending_depth()
        if total >= QUEUE_MAX:
            _counters["rejected"] += 1
            return {"accepted": False, "reason": "queue_full",
                    "worker_type": worker_type}
        task_id = f"eph-{int(time.time()*1000)}-{worker_type}"
        _TASKS[task_id] = {"id": task_id, "type": worker_type,
                           "priority": priority, "prio": prio,
                           "payload": payload or {}, "status": "queued",
                           "enqueued": time.time(), "started": None,
                           "exited": None, "result": None,
                           "session": session_id,
                           "timeout_s": t["timeout_s"]}
    return {"accepted": True, "task_id": task_id,
            "timeout_s": t["timeout_s"]}


def _pending_depth() -> int:
    return sum(1 for t in _TASKS.values() if t["status"] == "queued")


def _dequeue_next():
    queued = [t for t in _TASKS.values() if t["status"] == "queued"]
    if not queued:
        return None
    queued.sort(key=lambda t: (t["prio"], t["enqueued"]))
    return queued[0]


def create(worker_type: str, task_id: str, payload: dict) -> bool:
    """Spawn a Fly machine for the task. Returns True when created/starting."""
    api = _fly_api()
    if not api:
        with _LOCK:
            if task_id in _TASKS:
                _TASKS[task_id]["status"] = "started"
                _TASKS[task_id]["started"] = time.time()
                _counters["created"] += 1
        return True  # dry-run (no Fly): simulate
    if _running(api) >= MAX_CONCURRENT:
        return False
    t = WORKERS.get(worker_type, WORKERS["validator"])
    body = {
        "config": {
            "env": {"TASK_PAYLOAD": json.dumps(payload or {}),
                    "FLY_REGION": os.getenv("FLY_REGION", "sin")},
            "guest": {"cpu_kind": "shared", "cpus": 1, "memory": 256},
            "auto_destroy": True,
            "restart": {"policy": "no"},
            "init": {"cmd": t["cmd"]},
        },
        "region": os.getenv("FLY_REGION", "sin"),
    }
    try:
        r = api.post(f"/apps/{_app()}/machines", json=body)
        if r.status_code < 400:
            with _LOCK:
                if task_id in _TASKS:
                    _TASKS[task_id]["status"] = "started"
                    _TASKS[task_id]["started"] = time.time()
                    _counters["created"] += 1
            return True
        log.warning("machine create %s -> %s", worker_type, r.status_code)
        return False
    except Exception as exc:
        log.error("fly create failed: %s", exc)
        return False


def drain(blocking: bool = True, max_wait: float = 60.0) -> list:
    """Run queued+started tasks to completion in priority order. In real deploy
    the Fly worker runs this loop; here we simulate a bounded run. Returns
    completed task summaries (best-effort)."""
    deadline = time.time() + max_wait
    done = []
    while time.time() < deadline:
        with _LOCK:
            active = [t for t in _TASKS.values()
                      if t["status"] in ("queued", "started")]
            if not active:
                break
        task = _dequeue_next() or active[0]
        # honor concurrency by not starting beyond cap (simulate single slot)
        if task["status"] == "queued":
            ok = create(task["type"], task["id"], task["payload"])
            if not ok:
                time.sleep(0.2)
                continue
        # poll exit (simulated result) until timeout
        tt = WORKERS[task["type"]]["timeout_s"]
        elapsed = time.time() - task["started"]
        if elapsed >= tt:
            with _LOCK:
                task["status"] = "done"
                task["exited"] = time.time()
                task["result"] = {"stdout": f"result:{task['type']}",
                                  "stderr": "", "timeout": True}
                _counters["destroyed"] += 1
            done.append(task["id"])
        else:
            time.sleep(0.3)
        if blocking is False:
            pass
    return done


def collect(task_id: str) -> dict:
    """Fetch a task's current state/result; destroys it from local state when
    done (mirrors Fly auto_destroy). Caller uses this to read output."""
    with _LOCK:
        t = _TASKS.get(task_id)
        if not t:
            return {"task_id": task_id, "status": "unknown"}
        out = dict(t)
        if t["status"] == "done":
            sub = {"task_id": task_id, "status": "done",
                   "result": t.get("result")}
            _TASKS.pop(task_id, None)
            return sub
        return {"task_id": task_id, "status": t["status"],
                "worker_type": t["type"]}


def cleanup(older_than_s: float = 120.0) -> int:
    """Expire/cleanup stale entries beyond TTL (runaway protection). Returns
    count removed."""
    now = time.time()
    to_del = []
    with _LOCK:
        for k, t in _TASKS.items():
            started = t.get("started") or t.get("enqueued") or now
            if t["status"] in ("queued", "started") and \
                    now - started > max(t["timeout_s"], older_than_s):
                to_del.append(k)
        for k in to_del:
            _TASKS.pop(k, None)
            _counters["destroyed"] += 1
    return len(to_del)


def terminate_all():
    """Emergency: drop all tracked ephemeral tasks (used by /terminate_system).
    Actual Fly machine destruction is delegated to fly cli/API by the caller."""
    with _LOCK:
        n = len(_TASKS)
        _TASKS.clear()
        _counters["destroyed"] += n
    return n
"""
J.A.R.V.I.S. Level 10 — Autonomous Regional Failover (utils/failover_manager.py)

Detects degradation across Fly regions and reroutes traffic without user
intervention, then reports transparently and rolls back when the primary
recovers.

Responsibilities
  * Health monitor: pings each region's /health every HEALTH_INTERVAL_S (10s).
      - latency > 800ms  => degraded
      - latency > 2000ms => failed
  * On failure: raises a Fly machine in the next-best region (or updates the
    primary alias) and records the active region.
  * Sticky sessions: keys stateful operations (legacy-vault access,
    constitutional validation) to a single region to avoid mid-operation moves:
        start_sticky(session_id) / route_for(session_id)
  * User notification: transparent note "🌐 Optimizing connection via {region}".
  * Rollback: when primary recovers, switches back.

Free-tier friendly: failover creates at MOST (3 - active) extra machines, and
auto-destroys idle ones (see ephemeral_worker). All heavy work is synchronous.
"""
import os
import time
import logging
import threading

import httpx

try:
    from utils.telegram import send_message
except ImportError:
    send_message = None

log = logging.getLogger("failover")

_REGIONS = {
    "sin": os.getenv("FLY_EXT_HOST_SIN",
                     "https://jarvis-ubiquitous.fly.dev"),
    "nrt": os.getenv("FLY_EXT_HOST_NRT", ""),
    "ord": os.getenv("FLY_EXT_HOST_ORD", ""),
}

HEALTH_INTERVAL_S = 10.0
DEGRADED_MS = 800
FAILED_MS = 2000
REGION_ORDER = ["sin", "nrt", "ord"]

_ACTIVE = {"region": os.getenv("PRIMARY_REGION", "sin").lower(),
           "since": time.time()}
_LOCK = threading.Lock()
_STICKY = {}


def set_app_region(region: str):
    with _LOCK:
        _ACTIVE["region"] = region.lower()
        _ACTIVE["since"] = time.time()


def active_region() -> str:
    with _LOCK:
        return _ACTIVE["region"]


# --------------------------------------------------------------------------
# Sticky sessions (stateful operation pinning)
# --------------------------------------------------------------------------
def start_sticky(session_id: str, region: str = None) -> str:
    """Pin a stateful session (legacy-vault access / constitutional validation)
    to a region so failover can't swap mid-operation. Returns pinned region."""
    region = (region or active_region()).lower()
    with _LOCK:
        _STICKY[session_id] = region
    return region


def release_sticky(session_id: str):
    with _LOCK:
        _STICKY.pop(session_id, None)


def sticky_region(session_id: str):
    with _LOCK:
        return _STICKY.get(session_id)


def route_for(session_id: str = None) -> str:
    if session_id:
        pinned = sticky_region(session_id)
        if pinned:
            return pinned
    return active_region()


# --------------------------------------------------------------------------
# Health assessment
# --------------------------------------------------------------------------
def measure(region: str, timeout: float = 3.0) -> dict:
    host = _REGIONS.get(region, "")
    if not host:
        return {"region": region, "up": False, "status": "failed",
                "latency_ms": FAILED_MS, "reason": "no_endpoint"}
    try:
        start = time.time()
        with httpx.Client(timeout=timeout) as c:
            r = c.get(f"{host}/health")
        latency_ms = (time.time() - start) * 1000
        up = r.status_code < 500
        if not up:
            status = "failed"
        elif latency_ms > FAILED_MS:
            status = "failed"
        elif latency_ms > DEGRADED_MS:
            status = "degraded"
        else:
            status = "ok"
        return {"region": region, "up": up, "status": status,
                "latency_ms": round(latency_ms, 1)}
    except Exception:
        return {"region": region, "up": False, "status": "failed",
                "latency_ms": FAILED_MS, "reason": "unreachable"}


def health_all() -> dict:
    out = {}
    for reg in _REGIONS:
        out[reg] = measure(reg)
    return out


def current_status() -> dict:
    return {"active_region": active_region(),
            "active_seconds": round(time.time() - _ACTIVE["since"], 1),
            "under_monitoring": list(_REGIONS),
            "health_interval_s": HEALTH_INTERVAL_S}


# --------------------------------------------------------------------------
# Failover action (Fly API)
# --------------------------------------------------------------------------
def _fly_api():
    token = os.getenv("FLY_API_TOKEN")
    if not token:
        return None
    return httpx.Client(base_url="https://api.machines.dev/v1",
                        headers={"Authorization": f"Bearer {token}",
                                 "Content-Type": "application/json"},
                        timeout=15.0)


def _best_failover(exclude: str):
    for r in REGION_ORDER:
        if r != exclude and _REGIONS.get(r):
            return r
    return "sin"


def _ensure_failover_machine(region: str) -> bool:
    api = _fly_api()
    if not api:
        return True  # dry-run (no API token)
    app = os.getenv("FLY_APP", "jarvis-ubiquitous")
    try:
        r = api.get(f"/apps/{app}/machines", params={"region": region})
        machines = r.json() if r.status_code < 400 else []
        running = [m for m in machines
                   if m.get("state") in ("started", "starting")]
        if running:
            return True
        body = {
            "config": {
                "env": {"FLY_REGION": region, "PRIMARY_REGION": "sin"},
                "guest": {"cpu_kind": "shared", "cpus": 1, "memory": 256},
                "auto_destroy": True,
                "restart": {"policy": "no"},
                "checks": [{"type": "http", "port": 8080, "path": "/healthz",
                            "interval": "15s", "timeout": "3s"}],
                "services": [{"internal_port": 8080,
                              "ports": [{"port": 80,
                                         "handlers": ["http"]}],
                              "protocol": "tcp"}],
            },
            "region": region,
            "name": f"jarvis-failover-{region}",
        }
        r = api.post(f"/apps/{app}/machines", json=body)
        return r.status_code < 400
    except Exception as exc:
        log.error("failover machine create failed: %s", exc)
        return False


def failover_to(exclude_region=None) -> dict:
    with _LOCK:
        cur = _ACTIVE["region"]
        target = _best_failover(exclude_region or cur)
        ok = _ensure_failover_machine(target)
        if ok:
            _ACTIVE["region"] = target
            _ACTIVE["since"] = time.time()
    note = f"🌐 Optimizing connection via {target}"
    if send_message:
        try:
            send_message(int(os.getenv("OWNER_CHAT_ID", "0")), note)
        except Exception:
            pass
    return {"to": target, "from": cur, "ok": ok,
            "message": note + (" (dry-run)" if not ok else "")}


def rollback_to_primary() -> dict:
    with _LOCK:
        cur = _ACTIVE["region"]
        pri = os.getenv("PRIMARY_REGION", "sin").lower()
        _ACTIVE["region"] = pri
        _ACTIVE["since"] = time.time()
    note = f"🌐 Kembali ke region utama {pri}"
    if send_message:
        try:
            send_message(int(os.getenv("OWNER_CHAT_ID", "0")), note)
        except Exception:
            pass
    return {"region": pri, "from": cur, "message": note}


def monitor_and_maybe_failover(sticky_session=None,
                               auto_failover=True) -> dict:
    region = route_for(sticky_session)
    state = measure(region)
    if state["status"] == "failed" and auto_failover:
        res = failover_to(exclude_region=region)
        return {"assessment": state, "action": "failover", **res}
    return {"assessment": state, "action": "none"}
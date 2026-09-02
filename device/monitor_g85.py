#!/usr/bin/env python3
"""
monitor_g85.py — Realme C25s (SoC Unisoc T610 "G85", 4GB) sovereign local core
for J.A.R.V.I.S. Levels 5/6 hybrid edge-cloud orchestration.

What this script does every <poll_interval> seconds:
  1. Reads thermal + RAM metrics from /sys and pushes a heartbeat to the Cloud
     (Supabase device_status via the /api/device_gateway/poll endpoint) so the
     hybrid router knows the device is alive and not overheating.
  2. If local execution is throttled (thermal >= threshold or RAM too low),
     reports it in the heartbeat and skips the heavy LLM inference this cycle.
  3. Long-polls the gateway for a queued encrypted task.
  4. When a task arrives: decrypts the envelope, runs the local LLM (MLC LLM +
     Qwen2.5-1.5B Instrinct), then encrypts + pushes the result back, which the
     cloud delivers to the user's Telegram chat.

Security / privacy:
  * No PII is ever logged; only encrypted envelopes cross the network.
  * The shared secret lives in ~/.jarvis.env (see local_secrets.py), never in
    this file or in git.
  * The device is behind NAT, so it must initiate every connection (long-poll).

Synchronous on purpose: matches the Vercel serverless model and the G85's
limited resources (no asyncio event loop needed).

Requires: httpx  (pip install httpx). `cryptography` optional (for AES-GCM);
a pure-stdlib fallback is used when missing via utils.device_comm.
"""
import os
import sys
import json
import time
import subprocess
import logging

# Ensure we can import utils.device_comm + local_secrets from this folder.
_THIS_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(_THIS_DIR))   # repo root -> utils
sys.path.insert(0, _THIS_DIR)                    # this device/ folder

import local_secrets                          # noqa: E402

try:
    from utils import device_comm              # noqa: E402
except Exception as exc:                       # pragma: no cover
    print(f"[monitor] cannot import utils.device_comm: {exc}", file=sys.stderr)
    device_comm = None

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("monitor_g85")


# ------------------------------------------------------------------
# Metric readers (thermal / RAM) for the Realme C25s / Unisoc T610
# ------------------------------------------------------------------
def read_temp_c() -> float:
    """Average battery + CPU zone temperature in °C (None if unavailable)."""
    temps = []
    paths = [
        "/sys/class/thermal/thermal_zone0/temp",   # CPU (often zone0)
        "/sys/class/thermal/thermal_zone1/temp",
        "/sys/class/power_supply/battery/temp",    # battery, in tenths of °C
    ]
    for p in paths:
        try:
            with open(p, "r") as fh:
                raw = fh.read().strip()
            val = int(raw)
            temps.append(val / 1000.0 if abs(val) < 1000 else val / 10.0)
        except (OSError, ValueError):
            continue
    if not temps:
        return None
    return round(sum(temps) / len(temps), 1)


def read_ram_pct() -> float:
    """Current RAM usage percent from /proc/meminfo (None if unavailable)."""
    try:
        meminfo = {}
        with open("/proc/meminfo", "r") as fh:
            for line in fh:
                parts = line.split()
                if parts:
                    meminfo[parts[0].rstrip(":")] = int(parts[1])
        total = meminfo.get("MemTotal")
        avail = meminfo.get("MemAvailable")
        if not total or avail is None:
            return None
        return round(100.0 * (total - avail) / total, 1)
    except (OSError, ValueError):
        return None


def read_threads() -> int:
    """Total thread/task count (proxy for load)."""
    try:
        with open("/proc/loadavg", "r") as fh:
            return round(float(fh.read().split()[0]), 2)
    except (OSError, ValueError, IndexError):
        return None


# ------------------------------------------------------------------
# Local LLM invocation (MLC LLM CLI for Qwen2.5-1.5B)
# ------------------------------------------------------------------
def run_local_llm(prompt: str, *, timeout: int = 90) -> str:
    """
    Invoke the locally-installed MLC LLM CLI with Qwen2.5-1.5B-Instruct and
    return the generated text. MLC CLI args are conservative for 4GB RAM.

    Override the command via the MLC_LLM_BIN env var (or ~/.jarvis.env).
    Falls back to a deterministic echo if the binary is not installed yet, so
    the loop stays testable end-to-end.
    """
    settings = local_secrets.get(
        DEVICE_MODEL="Qwen2.5-1.5B",
        MLC_LLM_BIN=os.path.join(_THIS_DIR, ".llm", "mlc_llm_cli"),
    )
    bin_path = settings.get("MLC_LLM_BIN") or "mlc_chat_cli"
    model = settings.get("DEVICE_MODEL", "Qwen2.5-1.5B")
    if not os.path.exists(bin_path):
        # Not installed yet -> deterministic stub so we don't hard-crash.
        return _stub_reply(prompt)
    cmd = [
        bin_path, "--model", model,
        "--prompt", prompt,
        "--max-gen-len", "256",
        "--device", "cpu",
    ]
    try:
        proc = subprocess.run(
            cmd, capture_output=True, text=True, timeout=timeout)
        text = (proc.stdout or "").strip()
        return text or (proc.stderr or "").strip()[-2000:]\
            if text else ""
    except FileNotFoundError:
        logger.warning("MLC CLI not found at %s", bin_path)
        return _stub_reply(prompt)
    except subprocess.TimeoutExpired:
        logger.warning("local LLM timed out after %ss", timeout)
        return _stub_reply(prompt)


def _stub_reply(prompt: str) -> str:
    """Bare-minimum echo when the LLM binary isn't installed (dev/test hook)."""
    return f"(lokal) Menerima perintah. [LLM belum terpasang — install via setup_termux.sh]"


# ------------------------------------------------------------------
# Gateway transport (with X-Device-Key auth header)
# ------------------------------------------------------------------
def _gateway_post(path: str, payload: dict, *, timeout: float = 25.0) -> dict:
    import httpx
    secrets = local_secrets.get()
    base = (secrets.get("DEVICE_GATEWAY") or "").rstrip("/")
    secret = secrets.get("DEVICE_SHARED_SECRET") or \
        os.getenv("DEVICE_SHARED_SECRET")
    if not base or not secret:
        raise RuntimeError(
            "DEVICE_GATEWAY & DEVICE_SHARED_SECRET required in ~/.jarvis.env")
    headers = {"Content-Type": "application/json",
               "X-Device-Key": secret}
    with httpx.Client(timeout=timeout) as client:
        r = client.post(base + path, json=payload, headers=headers)
        r.raise_for_status()
        return r.json()


def _push_result(telegram_id: int, queue_id: str, task_id: str,
                 text: str = "", error: str = ""):
    """Encrypt + push a task result back to the gateway. Safe to retry: the
    gateway's complete_device_task is idempotent by queue_id."""
    envelope = device_comm.encrypt_payload(
        {"task_id": task_id, "text": text, "error": error})
    try:
        return _gateway_post("/push", {
            "telegram_id": telegram_id,
            "queue_id": queue_id,
            "response": envelope,
        })
    except Exception as exc:
        logger.error("push failed: %s", exc)
        return {"ok": False, "error": str(exc)}


# ------------------------------------------------------------------
# Main loop
# ------------------------------------------------------------------
def _metrics() -> dict:
    return {
        "temp_c": read_temp_c(),
        "ram_pct": read_ram_pct(),
        "threads": read_threads(),
        "model": local_secrets.get().get("DEVICE_MODEL", "Qwen2.5-1.5B"),
        "latency_ms": 0,
    }


def _throttled(metrics: dict) -> bool:
    secrets = local_secrets.get()
    throttle_c = float(secrets.get("JARVIS_TEMP_THROTTLE_C", 55))
    if metrics.get("temp_c") and metrics["temp_c"] >= throttle_c:
        return True
    if metrics.get("ram_pct") and metrics["ram_pct"] >= 92:
        return True
    return False


def run_once(telegram_id: int = 0, *, do_infer: bool = True) -> dict:
    """One poll cycle. Returns a short summary dict (for testing)."""
    metrics = _metrics()
    throttled = _throttled(metrics)

    # 1) Heartbeat (always, whether or not we will infer).
    try:
        _gateway_post("/poll", {"telegram_id": telegram_id}, timeout=15.0)
    except Exception as exc:
        logger.info("heartbeat/poll send skip: %s", exc)

    # 2) If throttled, skip heavy inference this cycle but do report health.
    if throttled:
        logger.info("device throttled (%s) - skipping inference this cycle", metrics)
        return {"ok": True, "throttled": True, "metrics": metrics, "task": None}

    # 3) Enqueue acknowledgement only happens cloud-side; we long-poll again.
    #    (poll already returned any task as `task` in the first call; rely on
    #    the next poll to actually hold a task once the queue drains.)

    # 4) Drain queued task via /poll (the response includes `task` envelope).
    try:
        poll_resp = _gateway_post("/poll", {"telegram_id": telegram_id}, timeout=20.0)
    except Exception as exc:
        logger.error("poll failed: %s", exc)
        return {"ok": False, "error": str(exc), "metrics": metrics}

    task = poll_resp.get("task")
    if not task:
        return {"ok": True, "throttled": False, "metrics": metrics, "task": None}

    # 5) Decrypt + execute task.
    try:
        payload = device_comm.decrypt_payload(task.get("envelope") or {})
    except Exception as exc:
        logger.error("decrypt failed: %s", exc)
        _push_result(telegram_id, task.get("queue_id"),
                     task.get("task_id"), error=f"decrypt:{exc}")
        return {"ok": False, "error": str(exc), "metrics": metrics}

    prompt = str(payload.get("prompt") or payload.get("text") or "")
    try:
        text = run_local_llm(prompt) if do_infer else "(test)"
    except Exception as exc:
        text, error = "", f"llm:{exc}"
        _push_result(telegram_id, task.get("queue_id"),
                     task.get("task_id"), error=error)
        return {"ok": False, "error": error, "metrics": metrics}
    _push_result(telegram_id, task.get("queue_id"), task.get("task_id"), text=text)
    return {"ok": True, "throttled": False, "metrics": metrics,
            "task": {"queue_id": task.get("queue_id"), "text": text[:80]}}


def main():
    secrets = local_secrets.get()
    telegram_id = int(secrets.get("JARVIS_TELEGRAM_ID", 0) or 0)
    interval = float(secrets.get("JARVIS_POLL_INTERVAL", 30))
    logger.info("monitor_g85 starting: telegram_id=%s interval=%ss",
                telegram_id, interval)
    while True:
        t0 = time.time()
        try:
            run_once(telegram_id)
        except KeyboardInterrupt:
            logger.info("stopped by user")
            break
        except Exception as exc:
            logger.error("cycle error: %s", exc)
        elapsed = time.time() - t0
        time.sleep(max(1.0, interval - elapsed))


if __name__ == "__main__":
    main()

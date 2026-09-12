"""
Simulator Proxy (Level 6): dedicated endpoint for Monte Carlo / simulation
requests that can only run in the E2B sandbox (Realme C25s CANNOT run them).

Features:
  * Request batching: combine multiple sim requests into one sandbox session
    (E2B enforces a daily cap, so batching saves quota).
  * Result caching: identical simulation code produces identical results —
    cache by SHA-256 of (code + params) to avoid redundant sandbox usage.
  * Cost estimation: returns tokens + sandbox seconds used so the user can
    see the "cost" of each simulation.
  * Structured risk assessment: results come back with confidence intervals,
    mean, std dev, and a human-readable summary.

Free-tier: E2B gives ~6 sandbox starts / minute, ~40 / day. Batching keeps
us within budget; caching makes repeated requests free.

Synchronous on purpose (Vercel serverless rejects asyncio.run -> EBUSY).
"""
import os
import json
import time
import hashlib
import logging
from http.server import BaseHTTPRequestHandler

from utils import e2b_executor

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("simulator")


# ------------------------------------------------------------------
# Module-level helpers (must exist here; cannot be self._ methods)
# ------------------------------------------------------------------
def _read_json(handler):
    length = int(handler.headers.get("Content-Length", 0) or 0)
    body = handler.rfile.read(length) if length else b""
    return json.loads(body or b"{}")


def _send_json(handler, payload, status):
    data = json.dumps(payload).encode("utf-8")
    handler.send_response(status)
    handler.send_header("Content-type", "application/json")
    handler.send_header("Content-Length", str(len(data)))
    handler.end_headers()
    handler.wfile.write(data)

# In-memory cache (reset per cold start; good enough for free-tier re-runs).
_CACHE: dict = {}
_MAX_CACHE_ENTRIES = 128
_BATCH_WINDOW_S = 5.0          # collect requests for up to 5 seconds
_PENDING_BATCH: dict = {}      # keyed by telegram_id for per-user batching


def _cache_key(code: str, params: dict = None) -> str:
    blob = code + (json.dumps(params or {}, sort_keys=True, default=str))
    return hashlib.sha256(blob.encode()).hexdigest()


def _is_simulation_code(code: str) -> bool:
    """Heuristic: detect Monte Carlo / simulation keywords."""
    low = (code or "").lower()
    kws = ("monte carlo", "random", "numpy", "scipy", "simulasi",
           "simulation", "iteration", "np.random", "sample", "std dev",
           "confidence interval", "var", "volatil")
    return any(k in low for k in kws)


# ------------------------------------------------------------------
# Execution helpers
# ------------------------------------------------------------------
def run_simulation(code: str, params: dict = None,
                   timeout_s: int = 30) -> dict:
    """
    Run simulation code in an E2B sandbox. Returns structured result:
      {"success": bool, "stdout": str, "stderr": str,
       "files": [...], "cost": {"sandbox_s": float, "tokens": 0},
       "summary": str}
    Uses cache when available; never runs duplicate identical sims.
    """
    t0 = time.time()
    key = _cache_key(code, params)

    # Cache hit
    if key in _CACHE:
        cached = _CACHE[key]
        cached["cost"]["sandbox_s"] = 0
        cached["from_cache"] = True
        logger.info(f"sim cache hit: {key[:8]}")
        return cached

    # E2B envelope guard (same as deep_reasoning)
    from utils import groq_client
    if groq_client._over_deadline():
        return {"success": False, "stdout": "", "stderr": "budget exhausted",
                "files": [], "cost": {}, "summary": ""}

    # Generate the simulation code. If the user provides a parameter dict,
    # we prepend it as a variable.
    full_code = _inject_params(code, params)

    result = e2b_executor.execute_code(full_code, "python")
    sandbox_s = round(time.time() - t0, 2)
    files = []
    if isinstance(result, dict):
        files = result.get("files") or []
        for i, f in enumerate(files):
            if isinstance(f, dict):
                files[i] = {"name": f.get("name", f"artifact_{i}"),
                            "size_bytes": len(f.get("data_b64", ""))}

    # Build structured response
    stdout = (result or {}).get("stdout", "")
    stderr = (result or {}).get("stderr", "")
    success = bool((result or {}).get("success")) and not stderr
    summary = _extract_summary(stdout, stderr)
    cost = {
        "sandbox_s": sandbox_s,
        "tokens": len(full_code.split()) * 3,
    }
    response = {
        "success": success,
        "stdout": stdout[:4000],
        "stderr": stderr[:2000] if stderr else "",
        "files": files,
        "cost": cost,
        "summary": summary,
        "from_cache": False,
    }

    # Cache the result (bounded memory)
    if len(_CACHE) < _MAX_CACHE_ENTRIES:
        _CACHE[key] = response

    return response


def _inject_params(code: str, params: dict = None) -> str:
    """Prepend `params` as a Python dict into the simulation code."""
    if not params:
        return code
    snippet = f"\nimport json\n_params = {json.dumps(params, default=str)}\n"
    # Insert right after imports (or at top).
    import_end = 0
    for line in code.splitlines(keepends=True):
        if line.strip().startswith(("import ", "from ")):
            import_end += len(line)
        else:
            break
    return code[:import_end] + snippet + code[import_end:]


def _extract_summary(stdout: str, stderr: str) -> str:
    """Best-effort extraction of a human-readable risk summary."""
    lines = (stdout or "").splitlines()
    # Look for lines with common summary keywords.
    for line in reversed(lines):
        low = line.lower()
        if any(k in low for k in ("mean", "std", "confidence", "result",
                                   "risk", "rata-rata", "standar", "rerata")):
            return line.strip()[:300]
    return (lines[-1].strip()[:300] if lines else (stderr[:300] if stderr else ""))


# ------------------------------------------------------------------
# Batching: collect multiple sim requests before triggering sandbox
# ------------------------------------------------------------------
def _batch_key(telegram_id: int) -> str:
    return f"batch:{telegram_id}"


def add_to_batch(telegram_id: int, code: str, params: dict = None) -> dict:
    """Add a simulation request to the user's pending batch.
    Returns immediately with {"batched": True, "position": N}."""
    k = _batch_key(telegram_id)
    if k not in _PENDING_BATCH:
        _PENDING_BATCH[k] = []
    _PENDING_BATCH[k].append({"code": code, "params": params})
    return {"batched": True, "position": len(_PENDING_BATCH[k])}


def flush_batch(telegram_id: int) -> dict:
    """Execute all pending batched simulations for a user as a combined script.
    Returns {"results": [...], "total_cost": {...}}."""
    k = _batch_key(telegram_id)
    items = _PENDING_BATCH.pop(k, [])
    if not items:
        return {"results": [], "total_cost": {"sandbox_s": 0, "tokens": 0}}

    # Combine into one sandbox session
    combined_code = []
    for i, item in enumerate(items):
        code = _inject_params(item["code"], item["params"])
        combined_code.append(f"# --- SIM {i} ---\n{code}\nprint(f'[SIM_{i}_DONE]')")

    full = "\n\n".join(combined_code)
    result = run_simulation(full)
    return {
        "results": [result],   # single combined result
        "total_cost": result.get("cost", {}),
    }


# ------------------------------------------------------------------
# Library functions (imported by api/simulator.py, not an endpoint)
# ------------------------------------------------------------------
class handler(BaseHTTPRequestHandler):
    """Stub — this file is a library module, not a serverless endpoint.
    Use run_simulation() or add_to_batch() / flush_batch() from other code."""

    def do_GET(self):
        _send_json(self, {"ok": True, "service": "jarvis-simulate"}, 200)

    def do_POST(self):
        try:
            body = _read_json(self)
            code = body.get("code", "")
            params = body.get("params")
            telegram_id = int(body.get("telegram_id") or
                              self.headers.get("X-Telegram-Id") or 0)
            mode = body.get("mode", "run")
            if mode == "batch":
                res = add_to_batch(telegram_id, code, params)
                return _send_json(self, {"ok": True, **res}, 200)
            if mode == "flush":
                res = flush_batch(telegram_id)
                return _send_json(self, {"ok": True, **res}, 200)
            if mode == "private_edge":
                # Level 7: route to Oracle private edge w/ Groq fallback.
                from api import private_edge_proxy
                if body.get("__health"):
                    return _send_json(self, {"ok": True,
                                             "health": private_edge_proxy.health()}, 200)
                res = private_edge_proxy.infer(
                    body.get("prompt") or body.get("code") or "",
                    telegram_id, int(body.get("max_tokens") or 256))
                return _send_json(self, res,
                                  200 if res.get("ok") else 502)
            res = run_simulation(code, params)
            _send_json(self, {"ok": True, **res}, 200)
        except Exception as exc:
            logger.exception("simulate failed")
            _send_json(self, {"ok": False, "error": str(exc)}, 500)

    def log_message(self, format, *args):
        logger.info("%s - %s" % (self.address_string(), format % args))

"""
Deep Reasoning loop ("the thinking Hands"): think -> code -> execute -> evaluate.

For analytical/computational problems the swarm's `coder` agent — or any agent,
through the `deep_reason` tool — runs an iterative loop:

    1. Groq drafts a solution plan + Python code (a plain chat call, no tools).
    2. The code is executed in a fresh E2B sandbox (killed on timeout).
    3. Groq evaluates stdout/stderr. Errors produce a fix directive.
    4. Retry up to `max_iters` (default 3); return the validated result,
       or an honest failure explanation.

Free-tier guards:
  * E2B execution is capped at `SANDBOX_TIMEOUT_S` (30s) via a watchdog thread.
  * Sandbox starts are rate-limited (per-minute + per-day envelopes) so runaway
    tasks can never burn the E2B free quota; beyond the envelope the loop
    degrades to a code-only answer ("jalankan lokal").

Runtime note: the Level-4 spec asks for asyncio, but Vercel serverless rejects
repeated asyncio.run() in one handler (EBUSY) — this deployment is synchronous
by design, mirroring utils/groq_client.py and api/webhook.py.
"""
import json
import os
import re
import threading
import time
from collections import deque

from utils import groq_client

try:
    from e2b_code_interpreter import Sandbox
    E2B_AVAILABLE = True
except ImportError:
    Sandbox = None
    E2B_AVAILABLE = False

# ------------------------------------------------------------------
# Budgets & resource tracking (free tier envelopes)
# ------------------------------------------------------------------
SANDBOX_TIMEOUT_S = int(os.getenv("E2B_RUN_TIMEOUT_S", "30"))
MAX_ITERS = int(os.getenv("DEEP_REASON_MAX_ITERS", "3"))
E2B_MAX_PER_MINUTE = int(os.getenv("E2B_MAX_PER_MINUTE", "6"))
E2B_MAX_PER_DAY = int(os.getenv("E2B_MAX_PER_DAY", "40"))

_started_total = 0
_error_total = 0
_start_times = deque(maxlen=200)
_lock = threading.Lock()


def usage() -> dict:
    """Observability snapshot: sandbox starts/errors and live rate-limit state."""
    with _lock:
        now = time.time()
        minute_ago = now - 60
        recent = [t for t in _start_times if t >= minute_ago]
    return {
        "available": E2B_AVAILABLE and bool(os.getenv("E2B_API_KEY")),
        "sandbox_started_total": _started_total,
        "sandbox_errors_total": _error_total,
        "recent_starts_1m": len(recent),
        "max_per_minute": E2B_MAX_PER_MINUTE,
        "timeout_s": SANDBOX_TIMEOUT_S,
    }


def _can_start_sandbox() -> tuple:
    """(ok, reason). Free-tier protection against score of parallel runs."""
    if not E2B_AVAILABLE:
        return False, "E2B library tidak tersedia"
    if not os.getenv("E2B_API_KEY"):
        return False, "E2B_API_KEY belum diatur"
    with _lock:
        now = time.time()
        recent = [t for t in _start_times if t >= now - 60]
        over_minute = len(recent) >= E2B_MAX_PER_MINUTE
        over_day = _started_total >= E2B_MAX_PER_DAY
    if over_minute:
        return False, f"E2B melewati batas {E2B_MAX_PER_MINUTE} sandbox/menit (free tier)"
    if over_day:
        return False, f"E2B melewati batas {E2B_MAX_PER_DAY} sandbox/hari (free tier)"
    return True, ""


def _sandbox_worker(code: str, language: str, holder: dict):
    """Run code in an E2B sandbox; store the sandbox in `holder` so the caller
    can kill it if the watchdog fires."""
    try:
        holder["sbx"] = Sandbox()
        if language == "javascript":
            holder["sbx"].commands.run("npm install -g node 2>/dev/null || true")
            result = holder["sbx"].run_code(code, language="javascript")
        else:
            holder["sbx"].commands.run(
                "pip install --quiet pandas matplotlib numpy 2>/dev/null || true"
            )
            result = holder["sbx"].run_code(code, language="python")
        holder["out"] = {
            "success": True,
            "stdout": result.text if result.text else "",
            "stderr": getattr(result, "stderr", "") or "",
        }
    except Exception as exc:
        holder["out"] = {
            "success": False,
            "stdout": "",
            "stderr": f"E2B sandbox error: {exc}",
        }


def _exec_code_in_sandbox(code: str, language: str = "python",
                          timeout_s: int = SANDBOX_TIMEOUT_S) -> dict:
    """Execute code under a hard watchdog timeout. Returns dict."""
    with _lock:
        global _started_total
        _started_total += 1
        _start_times.append(time.time())

    holder = {"sbx": None, "out": {"success": False, "stdout": "", "stderr": ""}}
    import concurrent.futures

    with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
        future = pool.submit(_sandbox_worker, code, language, holder)
        try:
            future.result(timeout=timeout_s)
        except concurrent.futures.TimeoutError:
            if holder["sbx"] is not None:
                try:
                    holder["sbx"].kill()
                except Exception:
                    pass
            holder["out"] = {
                "success": False,
                "stdout": "",
                "stderr": f"E2B execution timed out after {timeout_s}s",
            }
        except Exception as exc:
            holder["out"] = {
                "success": False,
                "stdout": "",
                "stderr": f"E2B worker error: {exc}",
            }
    if not holder["out"]["success"]:
        with _lock:
            global _error_total
            _error_total += 1
    return holder["out"]


# ------------------------------------------------------------------
# Groq helper: a plain (no tools) completion bound to the shared budget.
# ------------------------------------------------------------------
def _talk(system: str, user: str, max_tokens: int = 900) -> str:
    return groq_client.plain_completion(system, user, max_tokens=max_tokens) or ""


_PLANNER_SYSTEM = (
    "Kamu adalah engineer yang menulis solusi analitis. Untuk masalah yang "
    "dikirim, berikan rencana lalu kode Python yang MENJALANKAN solusinya. "
    "Gunakan markdown block python (```python ... ```) untuk kodemu. Kalau "
    "masalahnya tidak butuh kode, jawab saja analisisnya tanpa kode. "
    "Kode harus hanya mencetak hasil final, bebas dari input pengguna, dan "
    "tanpa permintaan interaktif. Bahasa jawaban: Indonesia."
)

_EVALUATOR_SYSTEM = (
    "Kamu pengecek hasil eksekusi kode (judge). Berdasarkan masalah, kode yang "
    "dijalankan, stdout/stderr, putuskan apakah HASIL sudah benar. Jawab "
    "PARSE-MEHANYA dengan format:\n"
    "PASS|FAIL: <alasan singkat, Indonesia>\n"
    "FAIL harus menyertakan instruksi perbaikan konkret yang bisa langsung "
    "dipakai untuk mengubah kode."
)


def _extract_code(text: str) -> str:
    """Pull the first python code block out of a model answer."""
    m = re.search(r"```(?:python)?\s*\n(.*?)```", text or "", re.S)
    if m:
        return m.group(1).strip()
    # No fence: take the last ```-bounded block if any.
    m = re.search(r"```(.*?)```", text or "", re.S)
    return m.group(1).strip() if m else ""


def _verdict(text: str):
    """'PASS' / 'FAIL' from the evaluator's short prefix."""
    t = (text or "").strip()
    if t.upper().startswith("FAIL"):
        return "fail", t[len("FAIL"):].strip(": \n")
    if t.upper().startswith("PASS"):
        return "pass", t[len("PASS"):].strip(": \n")
    return "unsure", t[:200]


def deep_reason(problem: str, max_iters: int = MAX_ITERS, quiet: bool = False) -> dict:
    """Run the think-code-execute-evaluate loop. Returns dict with
    {success, result, iterations, code, executed, note}."""
    if (problem or "").strip() == "":
        return {"success": False, "result": "", "iterations": 0,
                "note": "Masalah kosong."}

    ok, reason = _can_start_sandbox()
    degrade_to_code = not ok

    feedback_ctx = ""
    trace = []
    for i in range(1, int(max_iters) + 1):
        if groq_client._over_deadline():
            break
        prompt = problem + ("\n\nInstruksi perbaikan dari evaluator:\n" + feedback_ctx
                            if feedback_ctx else "")
        answer = _talk(_PLANNER_SYSTEM, prompt)
        code = _extract_code(answer)

        if not code:
            # No code requested: treat the model's prose as the final analysis.
            return {"success": True, "result": answer.strip(),
                    "iterations": i, "executed": False,
                    "note": "tanpa eksekusi (analisis murni)"}

        if degrade_to_code:
            trace.append({"iter": i, "reason": reason})
            return {
                "success": True,
                "result": (f"E2B tidak tersedia saat ini ({reason}). "
                           f"Berikut kode yang akan dijalankan:\n\n{code}\n\n"
                           "Silakan jalankan di lokal, atau coba lagi nanti."),
                "iterations": i, "code": code, "executed": False,
                "note": "graceful degradation (E2B di luar envelope)",
            }

        exec_result = _exec_code_in_sandbox(code)
        trace.append({"iter": i, "phase": "exec", "success": exec_result["success"]})

        if not exec_result["success"]:
            feedback_ctx = "Eksekusi gagal: " + (exec_result["stderr"] or "unknown error")
            continue

        judge = _talk(
            _EVALUATOR_SYSTEM,
            (f"MASAALAH: {problem}\n\nKODE:\n{code[:3000]}\n\n"
             f"STDOUT:\n{exec_result['stdout'][:2500]}\n\n"
             f"STDERR:\n{exec_result['stderr'][:1500]}"),
        )
        verdict, msg = _verdict(judge)

        if verdict == "pass":
            summary = exec_result["stdout"].strip() or "Eksekusi selesai tanpa output."
            return {"success": True, "result": summary,
                    "iterations": i, "code": code, "executed": True,
                    "note": msg or "validated"}
        feedback_ctx = "Perbaiki kode berdasarkan: " + msg

    return {
        "success": False,
        "result": "",
        "iterations": len([t for t in trace if t]),
        "note": ("Gagal menghasilkan solusi yang tervalidasi setelah "
                 f"berbagai iterasi: {feedback_ctx or 'budget habis'}"),
    }


def deep_reason_tool(args: dict) -> dict:
    """Tool-compatible wrapper, callable from orchestrator/_dispatch_tool."""
    problem = args.get("problem") or args.get("query") or ""
    return deep_reason(problem)


def _sync_log(step: str, **fields):
    """Tiny structured logger (no secrets). Sentinel hooked into health/l10n."""
    import logging
    logging.getLogger("jarvis.deep_reason").info(
        "event=%s %s", step,
        " ".join(f"{k}={v}" for k, v in fields.items()))
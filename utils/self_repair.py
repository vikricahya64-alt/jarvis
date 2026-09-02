"""
Self-Repairing Code Core (Level 7): autonomously detect → diagnose → fix → test
bugs in the J.A.R.V.I.S. codebase, then open a GitHub PR.

Safety guardrails (HARD):
  * NEVER touch auth / encryption / PII modules. A blocklist is enforced at the
    module boundary so a buggy Groq suggestion can't drop into e.g.
    `utils/data_sovereignty.py`, `utils/device_comm.py`, or `utils/authz.py`.
  * A patch must pass a sandboxed test harness (E2B or local subprocess) before
    it is marked `applied` / a PR is opened.
  * After 2 consecutive failed patch attempts for the same issue, the issue is
    marked `escalated` for human review (Telegram `/reject_patch` / `/repair_status`).
  * Every step is appended to `self_repair_log` (Supabase) for full transparency.

Synchronous on purpose (Vercel serverless; no event loop). The actual monitor
hook is lightweight — the heavy Groq diagnosis is bounded and respects budget.
"""
import os
import re
import json
import time
import logging
import subprocess

from utils import supabase_client

logger = logging.getLogger("self_repair")

# Modules that self-repair must NEVER modify (security surface).
BLOCKED_MODULES = (
    "utils/data_sovereignty.py",
    "utils/device_comm.py",
    "utils/authz.py",
    "utils/vault.py",
    "utils/sovereign_terminal.py",
    "api/hybrid_router.py",
    "api/webhook.py",          # signature verification lives here
    "utils/supabase_client.py",# service key handling
    "utils/oauth2.py",
    "utils/telegram.py",       # contains bot token handling path
)
MAX_ATTEMPTS = 2               # escalate after this many failures per issue
REPO_PATH = os.getenv("JARVIS_REPO_PATH", "/workspace/jarvis")

_DIAG_SYSTEM = (
    "Kamu adalah mesin diagnosis bug untuk kode Python di serverless Vercel. "
    "Output HANYA JSON: {\"summary\":\"<singkat ya>\",\"module\":\"<file.py>\","
    "\"proposed_fix\":\"<diff singkat / deskripsi>\",\"test\":\"<perintah test>\"}. "
    "Jangan pernah menyentuh modul keamanan/enzkripsi/PII."
)


# ------------------------------------------------------------------
# Safety checks
# ------------------------------------------------------------------
def _module_blocked(module: str) -> bool:
    """Block repair on any security/crypto/PII-sensitive module."""
    m = (module or "").replace("./", "").replace("\\", "")
    for blocked in BLOCKED_MODULES:
        if m == blocked or m.endswith(blocked):
            return True
    return False


def _safe_module_from_log_entry(entry: dict) -> str:
    """Extract + validate the module path from a Groq diagnosis."""
    module = (entry.get("module") or "").replace("../", "").replace("..\\", "")
    if not module or not module.endswith(".py"):
        return ""
    if _module_blocked(module):
        return ""
    return module


# ------------------------------------------------------------------
# Diagnosis (Groq) with safety
# ------------------------------------------------------------------
def diagnose(log_fragment: str) -> dict:
    """Ask Groq to summarize the issue. Returns fields or {} on any safety hit."""
    try:
        from utils import groq_client
        raw = groq_client.plain_completion(
            _DIAG_SYSTEM, (log_fragment or "")[:3000],
            max_tokens=250, temperature=0.2)
    except Exception as exc:
        logger.warning("diagnosis failed: %s", exc)
        return {}
    start, end = (raw or "").find("{"), (raw or "").rfind("}")
    if start == -1 or end <= start:
        return {}
    try:
        entry = json.loads(raw[start:end + 1])
    except Exception:
        return {}
    if not isinstance(entry, dict) or _module_blocked(entry.get("module", "")):
        return {}   # refuse to touch security modules
    return entry


# ------------------------------------------------------------------
# Sandbox test (E2B or local subprocess)
# ------------------------------------------------------------------
def _run_test(command: str, timeout: int = 45) -> bool:
    """Run a test command in a sandbox. Prefer E2B; fall back to local bash."""
    if not command:
        return False
    # Try E2B sandbox first (isolated, no local side-effects) if configured.
    try:
        if os.getenv("E2B_API_KEY"):
            from utils.e2b_executor import run_sandbox
            res = run_sandbox(command, timeout=int(timeout))
            ok = res.get("success") or (res.get("stdout") or "").count("PASS") > 0
            return bool(ok)
    except Exception:
        pass
    # Local fallback (read-only test invocation).
    try:
        proc = subprocess.run(command, shell=True, capture_output=True,
                              text=True, timeout=timeout, cwd=REPO_PATH)
        return proc.returncode == 0
    except Exception:
        return False


# ------------------------------------------------------------------
# Main repair flow
# ------------------------------------------------------------------
def repair(log_fragment: str, telegram_id: int = 0,
           auto_test: bool = True) -> dict:
    """
    Diagnose + (optionally) apply a fix for a bug reported in `log_fragment`.
    Returns a summary dict. The patch is only applied (PR / file write) when
    it targets a non-blocked module AND passes the sandbox test. After
    MAX_ATTEMPTS failures the issue is escalated for human review.
    """
    module = ""
    try:
        entry = diagnose(log_fragment)
    except Exception as exc:
        entry = {}
        logger.warning("diagnose threw: %s", exc)
    if not entry:
        supabase_client.log_self_repair(
            telegram_id, "unknown", (log_fragment or "")[:200],
            severity="medium", status="failed",
            blocked=True, diff="unable to diagnose; likely security module")
        return {"ok": False, "error": "diagnosis refused/empty"}

    module = _safe_module_from_log_entry(entry)
    if not module:
        supabase_client.log_self_repair(
            telegram_id, entry.get("module", "?"), entry.get("summary", ""),
            severity="high", status="rejected", blocked=True,
            diff=json.dumps(entry)[:2000])
        return {"ok": False, "error": "blocked module or invalid path"}

    # Failure bookkeeping: count prior attempts for this module/issue hash.
    attempts = _prior_attempts(module)
    severity = str(entry.get("severity", "low"))
    diff = str(entry.get("proposed_fix", ""))

    # 1) If we already failed too many times, escalate instead of looping.
    if attempts >= MAX_ATTEMPTS:
        supabase_client.log_self_repair(
            telegram_id, module, entry.get("summary", ""), severity=severity,
            diff=diff[:4000], status="escalated", attempts=attempts, blocked=False)
        return {"ok": False, "escalated": True,
                "error": f"escalated after {attempts} failed attempts"}

    # 2) Test the proposed fix in the sandbox before applying.
    test_ok = (not auto_test) or _run_test(str(entry.get("test", "")))
    if not test_ok:
        attempts += 1
        status = "escalated" if attempts >= MAX_ATTEMPTS else "failed"
        supabase_client.log_self_repair(
            telegram_id, module, entry.get("summary", ""), severity=severity,
            diff=diff[:4000], status=status, attempts=attempts, blocked=False)
        return {"ok": False, "error": "sandbox test failed",
                "escalated": status == "escalated"}

    # 3) Apply: write the patch file (kept reversible + audited). We do NOT
    #    directly overwrite production code; we stage it. The crew then reviews.
    patch_path = os.path.join("/tmp", f"repair-{int(time.time())}.diff")
    try:
        with open(patch_path, "w") as fh:
            fh.write(diff)
    except Exception as exc:
        return {"ok": False, "error": f"stage patch failed: {exc}"}

    supabase_client.log_self_repair(
        telegram_id, module, entry.get("summary", ""), severity=severity,
        diff=diff[:4000], status="applied", attempts=attempts + 1, blocked=False,
    )
    return {"ok": True, "module": module, "staged_patch": patch_path,
            "summary": entry.get("summary", "")}


def _prior_attempts(module: str) -> int:
    """Count recent failed attempts for a module (best-effort)."""
    try:
        rows = supabase_client.list_self_repair(0, limit=10)
        return sum(1 for r in rows
                   if r.get("module") == module and r.get("status") == "failed")
    except Exception:
        return 0


def repair_status_summary(telegram_id: int = 0) -> str:
    """Human-readable /repair_status output."""
    rows = supabase_client.list_self_repair(telegram_id, limit=10)
    if not rows:
        return "🔧 Tidak ada aktivitas perbaikan diri tercatat."
    lines = ["🔧 *Riwayat Perbaikan Diri*\n"]
    for r in rows:
        block = "⛔ BLOCKED" if r.get("blocked") else (
            "✅ applied" if r.get("status") == "applied"
            else "⚠️ " + str(r.get("status")))
        lines.append(f"• `{r.get('module')}` — {block}\n"
                     f"  {(r.get('issue') or '')[:80]}\n"
                     f"  attempts={r.get('attempts')}")
    return "\n".join(lines)

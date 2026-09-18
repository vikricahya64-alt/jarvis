"""
Coder agent: builds and executes code, backed by the Deep Reasoning loop.

E2B sandbox work — including watchdog timeouts and free-tier rate limiting —
lives in utils/deep_reasoning.py. This agent is a thin, resilient wrapper:
if E2B cannot start, it degrades gracefully to a code-only answer and tells
the user to run the snippet locally (Level 4 "self-healing" requirement).
"""
import logging

from utils.deep_reasoning import deep_reason, usage as e2b_usage

AGENT_TYPE = "coder"

logger = logging.getLogger("agent.coder")

SYSTEM_PROMPT = (
    "Kamu adalah agen CODER dalam swarm J.A.R.V.I.S. Tugasmu: mengubah "
    "masalah menjadi kode yang benar-benar dijalankan dan tervalidasi "
    "menggunakan loop deep reasoning (rencana -> kode -> eksekusi E2B -> "
    "evaluasi -> perbaikan). Beri kesimpulan output eksekusi, bukan "
    "pseudocode. Jika E2B sedang tidak tersedia, berikan kode lengkap plus "
    "catatan 'jalankan lokal' dan panduan singkat."
)


def run(telegram_id: int, task_input: str, task_id=None, context=None) -> dict:
    """Execute the coding subtask via the deep-reasoning loop."""
    try:
        res = deep_reason(task_input)
        if res.get("success"):
            note = res.get("note", "")
            result = res["result"]
            if res.get("executed") and note and note != "validated":
                result = f"{result}\n\n({note})"
            return {"success": True, "result": result,
                    "error": "", "tool_names": ["deep_reason"]}
        return {"success": False, "result": "", "error": res.get("note", "deep reason failed"),
                "tool_names": ["deep_reason"]}
    except Exception as exc:
        logger.exception("coder.run failed")
        return {"success": False, "result": "", "error": str(exc)[:400],
                "tool_names": []}


def sandbox_status() -> dict:
    """Expose E2B health for the /api/health + swarm observability."""
    return e2b_usage()
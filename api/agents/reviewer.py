"""
Reviewer agent: quality gate for the swarm.

Checks an agent's output against the original request and rejects answers that
are ungrounded (numbers/sources invented), incomplete, or off-language. The
swarm coordinator uses the verdict + feedback to decide PASS, REVISE (retry
with the feedback appended) or FAIL (escalate to the user after retries).
"""
import logging

from utils import groq_client

AGENT_TYPE = "reviewer"

logger = logging.getLogger("agent.reviewer")

SYSTEM_PROMPT = (
    "Kamu agen REVIEWER dalam swarm J.A.R.V.I.S. Nilai output agen lain "
    "terhadap permintaan asli. Berikan JSON saja (tanpa markdown):\n"
    '{"verdict": "pass" | "revise" | "fail", "issues": [string,...], '
    '"improvement": "satu instruksi perbaikan konkret"}'
)

# Acceptance: a short output is a PASS only when it fully answers; we let the
# LLM judge decide but keep a tiny floor guard.
MIN_BODY_LEN = 12


def _parse_verdict(text: str) -> dict:
    import json as _json
    import re as _re

    t = (text or "").strip()
    m = _re.search(r"\{.*\}", t, _re.S)
    raw = m.group(0) if m else t
    try:
        obj = _json.loads(raw)
        verdict = str(obj.get("verdict", "revise")).lower()
        if verdict not in ("pass", "revise", "fail"):
            verdict = "revise"
        return {
            "verdict": verdict,
            "issues": obj.get("issues", []),
            "improvement": str(obj.get("improvement", "")),
        }
    except Exception:
        if t.upper().startswith("PASS"):
            return {"verdict": "pass", "issues": [], "improvement": ""}
        if t.upper().startswith("FAIL"):
            return {"verdict": "fail", "issues": [t[:200]],
                    "improvement": t[:300]}
        return {"verdict": "revise", "issues": [t[:200]], "improvement": t[:300]}


def run(telegram_id: int, task_input: str, task_id=None, context=None) -> dict:
    """task_input is 'requirement\\n====\\noutput' — the payload the coordinator builds."""
    try:
        if "====\n" not in task_input:
            return {"success": False, "result": "", "error": "format: requirement + output",
                    "tool_names": []}
        requirement, _, output = task_input.partition("====\n")
        if len(output.strip()) < MIN_BODY_LEN:
            return {"success": False, "result": "",
                    "error": "output terlalu pendek untuk direview",
                    "tool_names": []}
        judge_raw = groq_client.plain_completion(
            SYSTEM_PROMPT,
            f"PERMINTAAN:\n{requirement.strip()}\n\nOUTPUT AGENT:\n{output[:4000]}",
            max_tokens=400,
        )
        verdict = _parse_verdict(judge_raw)
        return {"success": True, "result": json_dump(verdict), "error": "",
                "tool_names": []}
    except Exception as exc:
        logger.exception("reviewer.run failed")
        return {"success": False, "result": "", "error": str(exc)[:400],
                "tool_names": []}


def json_dump(obj: dict) -> str:
    import json as _json
    return _json.dumps(obj, ensure_ascii=False)
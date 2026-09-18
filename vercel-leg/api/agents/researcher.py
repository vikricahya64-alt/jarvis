"""
Researcher agent: gathers validated information from the web / the user's own
memory (knowledge base + chat history) and returns evidence-backed answers.

Design:
  * Reuses the orchestrator's tool dispatch (`orchestrator._dispatch_tool`) so
    search/scrape/retrieve_docs/private integrations stay in ONE place.
  * A small synchronous tool loop drives Groq function-calling, exactly like
    the main orchestrator loop (proven on Vercel; no asyncio on the request
    path — see api/webhook.py docstring for the EBUSY rationale).
  * Can invoke `deep_reason` for computational research when the model asks
    for it (the tool definition lives in groq_client.TOOLS).
"""
import json
import logging

from utils import groq_client, supabase_client
from api.orchestrator import _dispatch_tool, _is_failed_result

AGENT_TYPE = "researcher"

logger = logging.getLogger("agent.researcher")

SYSTEM_PROMPT = (
    "Kamu adalah agen PENELITI dalam swarm J.A.R.V.I.S. Tugasmu mengumpulkan "
    "fakta dan bukti untuk melayani permintaan utama pengguna. Prioritaskan "
    "tool pencarian (search_live untuk fakta terkini, search_web untuk daftar "
    "tautan, scrape_url untuk isi halaman, retrieve_docs untuk memori/knowledge "
    "base pengguna). Untuk analisis hitung/komputasi gunakan deep_reason. "
    "Jangan pernah mengarang angka atau kutipan: jika tool kosong, katakan "
    "kosong. Beri jawaban ringkas bernomor dengan sumber (domain). Bahasa: "
    "Indonesia, kecuali pengguna minta bahasa lain."
)

MAX_TOOL_ROUNDS = 4


def _tool_parse(response):
    """Return (tool_calls, text) from a Groq response."""
    msg = response.choices[0].message if response.choices else None
    calls = []
    if msg and msg.tool_calls:
        for tc in msg.tool_calls:
            try:
                args = json.loads(tc.function.arguments or "{}")
            except Exception:
                args = {}
            calls.append({"name": tc.function.name, "arguments": args,
                          "id": tc.id or f"call_{tc.function.name}"})
    return calls, (msg.content if msg else None)


def _run_tool_loop(telegram_id, question):
    """Bounded synchronous tool loop; returns (final_text, tool_names)."""
    context = []
    parts = []
    tool_names = []
    for _round in range(MAX_TOOL_ROUNDS):
        if groq_client._over_deadline():
            break
        resp = groq_client.sync_completion(question, context=context,
                                           system_prompt=SYSTEM_PROMPT)
        calls, text = _tool_parse(resp)
        if text and text.strip():
            parts.append(text.strip())
        if not calls:
            break
        assistant_msg = {
            "role": "assistant",
            "content": text or None,
            "tool_calls": [
                {
                    "id": c["id"],
                    "type": "function",
                    "function": {"name": c["name"],
                                 "arguments": json.dumps(c["arguments"])},
                }
                for c in calls
            ],
        }
        context.append(assistant_msg)
        for c in calls:
            try:
                result = _dispatch_tool(c["name"], c["arguments"], telegram_id)
            except Exception as exc:
                result = {"error": f"tool error: {exc}"}
            tool_names.append(c["name"])
            serializer = (
                json.dumps(result, ensure_ascii=False)[:3000]
                if isinstance(result, (dict, list))
                else str(result)[:3000]
            )
            context.append({"role": "tool", "tool_call_id": c["id"],
                            "content": serializer})
            if _is_failed_result(result) and c["name"] != "deep_reason":
                parts.append(f"⚠ Tool {c['name']} gagal: {serializer[:200]}")
    return "\n\n".join(p for p in parts if p) or "Tidak ada hasil.", tool_names


def run(telegram_id: int, task_input: str, task_id=None, context=None) -> dict:
    """Execute the researcher subtask."""
    try:
        text, tool_names = _run_tool_loop(telegram_id, task_input)
        if text.startswith("Tidak ada hasil."):
            return {"success": False, "result": text,
                    "error": "empty research output", "tool_names": tool_names}
        return {"success": True, "result": text, "error": "",
                "tool_names": tool_names}
    except Exception as exc:
        logger.exception("researcher.run failed")
        msg = str(exc)[:400]
        try:
            supabase_client.update_task(task_id, {"error": msg})
        except Exception:
            pass
        return {"success": False, "result": "", "error": msg,
                "tool_names": []}
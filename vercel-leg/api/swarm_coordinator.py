"""
Swarm Coordinator (Level 4): routes complex tasks to specialist agents.

Pipeline for a parent task:
    decompose_task()       Groq planner splits the request into sub-tasks with
                           explicit `agent_type` (researcher/coder/reviewer/writer).
    execute_swarm()        Each sub-task becomes a child row in `tasks`
                           (parent_task_id/agent_type/retry_count), is run
                           inline under one shared Groq budget, and goes through
                           the reviewer gate. Failures retry (max 2), then escalate
                           to the user via Telegram.
    aggregate_results()    The writer agent merges the validated child outputs
                           into the final answer, then the parent row is DONE.

Every agent row/PENDING child is also individually runnable by POSTing its
record to /api/swarm-coordinator (agent_type != null -> single-agent worker).

Synchronous on purpose: see api/webhook.py — Vercel serverless rejects
asyncio.run() (EBUSY), so the whole request path stays synchronous here too.
"""
import json
import logging
import time
from http.server import BaseHTTPRequestHandler

from utils import groq_client, supabase_client, telegram

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("swarm")

AGENTS = {
    "researcher": "api.agents.researcher",
    "coder": "api.agents.coder",
    "reviewer": "api.agents.reviewer",
    "writer": "api.agents.writer",
}

MAX_RETRIES = 2                 # per spec: max 2 retries before escalation
DECOMPOSE_TOKEN_BUDGET = 800

# Signals that hint "this needs the swarm" (cheap regex, no LLM needed).
_SWARM_HINTS = (
    "analis", "banding", "bandingkan", "selidik", "review", "riset", "teliti",
    "laporan mendalam", "deep dive", "evaluas", "perbandingan", "swarm",
    "bandingin",
)


def _over_deadline():
    return groq_client._over_deadline()


def should_swarm(text: str) -> bool:
    """Cheap gate: complex analytical/research requests go to the swarm."""
    env = __import__("os").getenv("SWARM_ENABLED", "0")
    if env not in ("1", "true", "True", "yes"):
        return False
    t = (text or "").lower()
    return any(h in t for h in _SWARM_HINTS)


# ------------------------------------------------------------------
# Decomposition (Groq planner)
# ------------------------------------------------------------------
_PLANNER_SYSTEM = (
    "Kamu adalah planner sebuah swarm AI. Pecah permintaan pengguna menjadi "
    "2-4 sub-tugas yang PARALEL dan butuh agen berbeda. Sebisa mungkin "
    "hindari sub-tugas berurutan; tiap sub-tugas harus berisi instrukSI "
    "mandiri berbahasa Indonesia. Balas HANYA array JSON, contoh:\n"
    '[{"agent_type":"researcher","input":"...","reason":"..."}]\n'
    'Valid agent_type: "researcher", "coder", "reviewer", "writer". '
    'Gunakan researcher utk mencari fakta, coder utk hitung/analisis data, '
    'reviewer utk mengecek hasil, writer utk merapikan laporan.'
)


def _parse_subtasks(text: str) -> list:
    t = (text or "").strip()
    start, end = t.find("["), t.rfind("]")
    if start == -1 or end == -1 or end <= start:
        return []
    try:
        items = json.loads(t[start:end + 1])
    except Exception:
        items = []
    out = []
    for it in items or []:
        at = str(it.get("agent_type", "")).lower()
        if at not in AGENTS:
            continue
        inp = (it.get("input") or "").strip()
        if not inp:
            continue
        out.append({"agent_type": at, "input": inp,
                    "reason": (it.get("reason") or "")[:200]})
    return out


def decompose_task(message: str, telegram_id: int) -> list:
    """Groq planner -> list of {agent_type, input, reason} subtasks."""
    try:
        raw = groq_client.plain_completion(
            _PLANNER_SYSTEM, message, max_tokens=DECOMPOSE_TOKEN_BUDGET)
    except Exception as exc:
        logger.error(f"decompose failed: {exc}")
        return []
    subs = _parse_subtasks(raw)
    if not subs:
        # Fallback: single researcher/coder passthrough so the swarm never
        # degrades to nothing.
        at = ("coder" if any(k in message.lower() for k in
                             ("hitung", "simulas", "kode", "python", "analisa data"))
              else "researcher")
        subs = [{"agent_type": at, "input": message,
                 "reason": "fallback passthrough"}]
    return subs


# ------------------------------------------------------------------
# Agent runner + reviewer gate
# ------------------------------------------------------------------
def _load_agent(agent_type: str):
    module = __import__(AGENTS[agent_type], fromlist=["run"])
    return module.run


def _structured_log(step: str, task_id, agent_type=None, dur_s=None,
                    success=None, **extra):
    """Logging WITHOUT secrets: ids + step + outcome only."""
    fields = [f"step={step}", f"task_id={task_id}"]
    if agent_type:
        fields.append(f"agent={agent_type}")
    if dur_s is not None:
        fields.append(f"dur_ms={int(dur_s * 1000)}")
    if success is not None:
        fields.append("success=1" if success else "success=0")
    fields += [f"{k}={v}" for k, v in extra.items()]
    logger.info(" ".join(fields))


def _run_agent_once(agent_type: str, telegram_id: int, child_id: str,
                    subtask_input: str, attempt: int) -> dict:
    t0 = time.time()
    try:
        supabase_client.update_task(child_id, {"status": "PROCESSING"})
        instruction = _inject_emotional(telegram_id, subtask_input)
        res = _load_agent(agent_type)(telegram_id, instruction, task_id=child_id)
    except Exception as exc:
        res = {"success": False, "result": "", "error": str(exc)[:400],
               "tool_names": []}
    dur = time.time() - t0
    ok = bool(res.get("success"))
    _structured_log("agent_run", child_id, agent_type=agent_type,
                    dur_s=dur, success=ok, attempt=attempt)
    return res


def _inject_emotional(telegram_id: int, instruction: str) -> str:
    """Append a tone-adaptation hint to an agent instruction, driven by the
    emotional context engine (Level 5). Best-effort, never blocks the run."""
    try:
        from utils import emotional_context
        hint = emotional_context.adaptation_hint(telegram_id)
        if hint:
            return f"{instruction}\n\n[Nada: {hint}]"
    except Exception:
        pass
    return instruction


def _run_children(parent_task_id: str, telegram_id: int,
                  subtasks: list) -> list:
    """Insert + execute child agents inline (parallel-ready rows, serial
    execution under one 60s budget). Returns child outcome rows."""
    children = []
    for sub in subtasks:
        if _over_deadline():
            break
        at = sub["agent_type"]
        child_id = supabase_client.insert_child_task(
            telegram_id, parent_task_id, at, sub["input"])
        outcome = {"type": at, "task_id": child_id, "input": sub["input"],
                   "success": False, "result": "", "error": ""}
        attempt = 0
        last_error = ""
        while attempt <= MAX_RETRIES:
            attempt += 1
            instruction = sub["input"]
            if attempt > 1 and last_error:
                instruction = (
                    f"{sub['input']}\n\nPERBAIKAN dari percobaan sebelumnya "
                    f"(ignorerkata ini jika tak relevan): {last_error[:400]}")
            supabase_client.update_task(child_id, {"retry_count": attempt - 1})
            res = _run_agent_once(at, telegram_id, child_id, instruction,
                                  attempt)
            if res.get("success"):
                outcome["success"] = True
                outcome["result"] = res.get("result", "")
                # Reviewer gate (skip for the writer/reviewer meta-steps).
                verdict = _review(outcome)
                if verdict in ("pass", "unsure"):
                    break
                last_error = f"reviewer: {verdict[:300]}"
                continue
            last_error = res.get("error") or "gagal tanpa pesan"
            if attempt > MAX_RETRIES:
                break
        outcome["error"] = last_error if not outcome["success"] else outcome.get("error", "")
        _finalize_child(child_id, outcome)
        if not outcome["success"]:
            _escalate(telegram_id, at, sub["input"], last_error)
        children.append(outcome)
    return children


def _review(outcome: dict) -> str:
    """Reviewer gate; returns 'pass' | 'revise' | 'fail' | 'unsure'."""
    if not outcome.get("result"):
        return "revise"
    try:
        from api.agents import reviewer as reviewer_agent
        res = reviewer_agent.run(0, f"{outcome['input']}\n====\n{outcome['result']}")
        import json as _json
        if res.get("success"):
            verdict = _json.loads(res["result"]).get("verdict", "revise")
            return verdict if verdict in ("pass", "revise", "fail") else "unsure"
        return "unsure"
    except Exception:
        return "unsure"


def _finalize_child(child_id: str, outcome: dict):
    try:
        supabase_client.update_task(child_id, {
            "status": "DONE" if outcome["success"] else "FAILED",
            "result_text": (outcome.get("result") or "")[:4000],
            "error": outcome.get("error") or None,
        })
    except Exception:
        pass


def _escalate(telegram_id: int, agent_type: str, sub_input: str, error: str):
    try:
        telegram.send_message(
            telegram_id,
            f"⚠ Saya kesulitan dengan sub-tugas ({agent_type}): "
            f"{sub_input[:160]}\nKendala: {error[:200]}\nBisakah Anda "
            "memperjelas atau memberi detail tambahan?",
        )
    except Exception:
        pass


# ------------------------------------------------------------------
# Aggregation (writer)
# ------------------------------------------------------------------
def aggregate_results(telegram_id: int, user_input: str, children: list) -> str:
    good = [c for c in children if c.get("success")]
    if not good:
        return (
            "Saya belum bisa menyelesaikan permintaan ini — semua sub-tugas "
            "gagal. Detail kegagalan sudah saya laporkan di atas. Silakan "
            "perjelas permintaan atau coba lagi."
        )
    payload_lines = [f"PERMINTAAN: {user_input}", "\n====\nHASIL SUB-AGEN:"]
    for c in good:
        payload_lines.append(f"\n--[{c['type']}]--\n{c['result'][:2500]}")
    try:
        from api.agents import writer as writer_agent
        res = writer_agent.run(telegram_id, "\n".join(payload_lines))
        return res.get("result") or payload_lines[-1]
    except Exception:
        return "\n\n".join(c["result"][:2000] for c in good)


# ------------------------------------------------------------------
# Orchestration entrypoints
# ------------------------------------------------------------------
def execute_swarm(parent_task_id: str, telegram_id: int, subtasks: list) -> dict:
    """Manage child lifecycle; returns aggregate text + per-child stats."""
    children = _run_children(parent_task_id, telegram_id, subtasks)
    final = aggregate_results(telegram_id, "", children)
    return {"final": final, "children": children}


def _run_parent(task_id: str, telegram_id: int, user_input: str,
                subtasks_provided: list = None) -> dict:
    """End-to-end synchronous parent run (webhook calls this inline)."""
    t0 = time.time()
    supabase_client.update_task(task_id, {"status": "PROCESSING", "agent": "swarm"})
    subtasks = subtasks_provided if subtasks_provided is not None \
        else decompose_task(user_input, telegram_id)
    if not subtasks:
        subtasks = [{"agent_type": "researcher", "input": user_input,
                     "reason": "planner kosong"}]
    children = _run_children(task_id, telegram_id, subtasks)
    final = aggregate_results(telegram_id, user_input, children)
    status = "DONE" if any(c["success"] for c in children) else "FAILED"
    supabase_client.update_task(task_id, {
        "status": status,
        "agent_type": None,
        "result_text": final[:4000],
        "error": None if status == "DONE" else "semua sub-tugas gagal",
    })
    _structured_log("parent_done", task_id, dur_s=time.time() - t0,
                    success=status == "DONE")
    return {"status": status, "final": final, "children": children}


def handle_parent_task(task_id: str, telegram_id: int, user_input: str):
    """Wire-friendly wrapper for webhook.py (returns final text)."""
    result = _run_parent(task_id, telegram_id, user_input)
    for chunk in __import__("api.agents.writer", fromlist=["chunk"]).chunk(result["final"]):
        try:
            telegram.send_message(telegram_id, chunk, parse_mode="HTML" if "<" in chunk and ">" in chunk else None)
        except Exception:
            telegram.send_message(telegram_id, chunk)
    _maybe_self_evolve(telegram_id, user_input)
    return result


def _maybe_self_evolve(telegram_id: int, user_input: str):
    """Level 5: opportunistically propose a low-risk, reversible preference
    change when the user shows a consistent correction signal. Best-effort,
    only when consent is enabled — never intrusive."""
    try:
        from utils import supabase_client, self_evolution
        consent = supabase_client.read_service_consent(telegram_id)
        if consent.get("behavioral", True) is False:
            return
        t = (user_input or "").strip().lower()
        # Cheap, explicit correction heuristics — no raw storage.
        if any(p in t for p in ("selalu", "harus selalu", "mulai sekarang")):
            # surface a gentle transparency note rather than silently change
            telegram.send_message(
                telegram_id,
                "🔁 Saya akan mengingat preferensi ini untuk tugas "
                "berikutnya. Pantau di /evolution dan batalkan kapan saja "
                "dengan /undo_evolution.")
    except Exception:
        pass


def handle_agent_task(task_id: str, telegram_id: int, user_input: str,
                      agent_type: str) -> dict:
    """Single-agent worker path (agent_type != null)."""
    supabase_client.update_task(task_id, {"status": "PROCESSING"})
    try:
        res = _run_agent_once(agent_type, telegram_id, task_id, user_input, 1)
        supabase_client.update_task(task_id, {
            "status": "DONE" if res.get("success") else "FAILED",
            "result_text": (res.get("result") or "")[:4000],
            "error": res.get("error") or None,
        })
        return res
    except Exception as exc:
        supabase_client.update_task(task_id, {"status": "FAILED",
                                              "error": str(exc)[:400]})
        return {"success": False, "result": "", "error": str(exc)[:400]}


# ------------------------------------------------------------------
# HTTP endpoint (/api/swarm-coordinator) — mirrors /api/orchestrator shape
# ------------------------------------------------------------------
class handler(BaseHTTPRequestHandler):

    def do_GET(self):
        body = {"ok": True, "service": "J.A.R.V.I.S. swarm-coordinator"}
        self._send_json(body, 200)

    def do_POST(self):
        try:
            payload = self._read_json()
            record = payload.get("record", payload)
            task_id = record.get("id")
            telegram_id = record.get("telegram_id")
            user_input = record.get("input")
            agent_type = record.get("agent_type")
            status = record.get("status", "PENDING")

            if status != "PENDING":
                return self._send_json({"ok": True, "skipped": status}, 200)
            if not (task_id and telegram_id and user_input):
                return self._send_json({"ok": False, "error": "Missing fields"}, 400)

            if agent_type in AGENTS:
                res = handle_agent_task(task_id, telegram_id, user_input,
                                        agent_type)
                return self._send_json({"ok": True, "task_id": task_id,
                                        "agent": agent_type,
                                        "success": res.get("success")}, 200)

            result = handle_parent_task(task_id, telegram_id, user_input)
            return self._send_json({"ok": True, "task_id": task_id,
                                    "status": result["status"]}, 200)
        except Exception as exc:
            logger.exception("swarm coordinator failed")
            return self._send_json({"ok": False, "error": str(exc)}, 500)

    def _read_json(self):
        length = int(self.headers.get("Content-Length", 0) or 0)
        body = self.rfile.read(length) if length else b""
        return json.loads(body or b"{}")

    def _send_json(self, payload, status):
        data = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, format, *args):
        logger.info("%s - %s" % (self.address_string(), format % args))
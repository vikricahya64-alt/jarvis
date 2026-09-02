"""
Orchestrator (Planner / central controller).

Triggered by the Telegram webhook (api/webhook.py) in a background thread.
It:
  1. Loads the task from Supabase.
  2. Calls Groq with tool definitions to decide which agent/tool to use.
  3. Executes the chosen tool (search / scrape / E2B code execution).
  4. Optionally generates a file artifact and uploads it to Storage.
  5. Updates the task status and sends the result back to Telegram.

Fully synchronous implementation: Vercel serverless punishes repeated
asyncio.run() in one thread (EBUSY), so everything here runs on a plain
background thread owned by webhook.py.
"""
import os
import json
import logging
from http.server import BaseHTTPRequestHandler

from utils import groq_client, supabase_client, telegram
from utils.search_tools import search_web, scrape_url, search_live
from utils.e2b_executor import execute_code
from utils import documents as documents_utils
from utils import misc_tools, todos

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("orchestrator")


def _extract_tool_calls(response):
    """Extract tool call arguments from a Groq chat completion response."""
    tool_calls = []
    message = response.choices[0].message if response.choices else None
    if message and message.tool_calls:
        for tc in message.tool_calls:
            tool_calls.append({
                "name": tc.function.name,
                "arguments": json.loads(tc.function.arguments or "{}"),
            })
    return tool_calls, (message.content if message else None)


def _run_pipeline(task_id: str, telegram_id: int, user_input: str):
    """The full agentic orchestration pipeline for a single task (sync)."""
    # Bound total Groq time so the whole task fits Vercel's Hobby 60s cap.
    groq_client.set_budget(48)

    # Acquire task (mark PROCESSING).
    supabase_client.update_task(task_id, {"status": "PROCESSING"})
    telegram.send_typing(telegram_id)

    # Load recent history for conversational context (RAG-lite).
    ctx = []
    try:
        history = supabase_client.get_recent_history(telegram_id, limit=6)
        ctx = [{"role": h["role"], "content": h["content"]} for h in history]
    except Exception:
        ctx = []

    # Store the user message for context.
    try:
        supabase_client.insert_chat(telegram_id, "user", user_input)
    except Exception:
        pass

    # 1. Planner: ask Groq to decide the next action(s).
    final_text_parts = []
    final_files = []
    max_iterations = int(os.getenv("MAX_TOOL_ITERATIONS", "3"))

    context = ctx
    consecutive_failures = 0
    for iteration in range(max_iterations):
        response = groq_client.sync_completion(user_input, context=context)
        tool_calls, assistant_text = _extract_tool_calls(response)

        # Accumulate any direct assistant text.
        if assistant_text:
            final_text_parts.append(assistant_text.strip())

        if not tool_calls:
            break  # Model is done; no more tools requested.

        assistant_tool_message = {
            "role": "assistant",
            "content": assistant_text or None,
            "tool_calls": [
                {
                    "id": tc.get("id", f"call_{i}"),
                    "type": "function",
                    "function": {
                        "name": tool_calls[i]["name"],
                        "arguments": json.dumps(tool_calls[i]["arguments"]),
                    },
                }
                for i, tc in enumerate(tool_calls)
            ],
        }
        context = list(context) + [assistant_tool_message]

        for tc in tool_calls:
            name = tc["name"]
            args = tc["arguments"]
            logger.info(f"Executing tool: {name} -> {args}")

            tool_result = _dispatch_tool(name, args, telegram_id)
            logger.info(
                f"Tool {name} result: {json.dumps(tool_result, ensure_ascii=False)[:300]}"
            )
            consecutive_failures = consecutive_failures + 1 if _is_failed_result(tool_result) else 0
            if consecutive_failures >= 2:
                logger.info(f"Tool {name} failing repeatedly; breaking tool loop.")
                break

            # Capture generated files (E2B, make_qr, generate_file) and send
            # only a compact summary back to the model (never the base64 blob).
            payload = tool_result.get("files", []) if isinstance(tool_result, dict) else []
            if isinstance(payload, list):
                for f in payload:
                    final_files.append(f)
            context.append({
                "role": "tool",
                "tool_call_id": tc.get("id", f"call_{iteration}"),
                "content": _tool_context_payload(name, tool_result),
            })

    # 2. Synthesis guard: if the loop ended without any assistant text, ask
    # Groq once more — forced to answer, no more tool calls — to turn the
    # gathered tool context into a final reply.
    if not final_text_parts:
        try:
            synth_resp = groq_client.sync_completion(
                user_input,
                context=context,
                system_prompt=(
                    "Answer the user's question now, directly, in the same "
                    "language as the user. Use the tool results above as the "
                    "basis. Do NOT call any more tools. If the results are not "
                    "useful, say so honestly and briefly."
                ),
                tool_choice="none",
            )
            _, synth_text = _extract_tool_calls(synth_resp)
            if synth_text and synth_text.strip():
                final_text_parts.append(synth_text.strip())
            else:
                final_text_parts.append(
                    "Maaf, saya belum bisa merangkum hasil pencarian yang "
                    "relevan. Coba pertajam pertanyaan Anda."
                )
        except Exception as exc:
            logger.error(f"Synthesis call failed: {exc}")

    # 3. Builder: if files were generated, upload them to Storage.
    result_urls = []
    for f in final_files:
        try:
            url = supabase_client.upload_artifact(
                f["name"], f["data_b64"], f["mime"]
            )
            result_urls.append(url)
            final_text_parts.append(f"📎 File: {f['name']} -> {url}")
        except Exception as exc:
            logger.error(f"Upload failed for {f['name']}: {exc}")

    # 3. Determine final output text.
    final_text = "\n\n".join(part for part in final_text_parts if part) or "No output produced."

    # 4. Store assistant reply for context and finish the task.
    try:
        supabase_client.insert_chat(telegram_id, "assistant", final_text)
    except Exception:
        pass

    supabase_client.update_task(task_id, {
        "status": "DONE",
        "result_text": final_text[:4000],
        "result_url": result_urls[0] if result_urls else None,
        "tool_calls": _tool_calls_json(),
    })

    # 5. Send result back to Telegram.
    _notify_user(telegram_id, final_text, result_urls)


def _tool_context_payload(name: str, result) -> str:
    """Compact summary of a tool result for the model (no base64 blobs)."""
    if isinstance(result, dict) and "files" in result and not result.get("error"):
        files = result["files"]
        names = [f.get("name", "?") for f in files if isinstance(f, dict)] if isinstance(files, list) else []
        slim = {k: v for k, v in result.items() if k != "files"}
        slim["files"] = f"{len(names)} file(s): {', '.join(names)}" if names else "no files"
        return json.dumps(slim, ensure_ascii=False)[:3000]
    return json.dumps(result, ensure_ascii=False)[:3000]


def _is_failed_result(result) -> bool:
    """True when a tool result signals failure so the loop stops re-calling it."""
    # Explicit error payloads always count, regardless of size.
    if isinstance(result, dict):
        if result.get("error"):
            return True
        if result.get("ok") is False or result.get("success") is False:
            return True
    try:
        text = json.dumps(result, ensure_ascii=False).lower()
    except Exception:
        text = str(result).lower()
    if not text:
        return True
    # Heuristic fallback: only when the report *starts with* a failure marker.
    # The old contains() check flagged normal tool content that merely
    # mentioned "error"/"failed" and prematurely killed the tool loop.
    return text.strip().startswith((
        "error", "failed", "could not", "cannot", "no output",
        "rate limit", "gagal", "tidak dapat", "terjadi kesalahan",
        "unknown tool",
    ))


def _dispatch_tool(name: str, args: dict, telegram_id: int = None):
    """Route a tool call to its implementation."""
    if name == "search_web":
        return search_web(args.get("query", ""), args.get("max_results", 5))
    if name == "search_live":
        return search_live(args.get("query", ""))
    if name == "scrape_url":
        return {"content": scrape_url(args.get("url", ""))}
    if name == "execute_code":
        return execute_code(args.get("code", ""), args.get("language", "python"))
    if name == "generate_file":
        return _handle_generate_file(args)
    if name == "store_document":
        return documents_utils.store_document(
            args.get("title", "untitled"), args.get("content", "")
        )
    if name == "retrieve_docs":
        return documents_utils.retrieve_docs(
            args.get("query", ""), args.get("top_k", 5)
        )
    if name == "get_weather":
        return misc_tools.get_weather(args.get("city", ""))
    if name == "convert_currency":
        return misc_tools.convert_currency(
            args.get("amount", 0), args.get("from_currency", ""),
            args.get("to_currency", ""),
        )
    if name == "crypto_price":
        return misc_tools.crypto_price(
            args.get("coin", ""), args.get("currency", "usd")
        )
    if name == "geo_info":
        return misc_tools.geo_info(args.get("ip", ""))
    if name == "shorten_url":
        return misc_tools.shorten_url(args.get("url", ""))
    if name == "translate":
        return misc_tools.translate(
            args.get("text", ""), args.get("target_lang", "id")
        )
    if name == "world_time":
        return misc_tools.world_time(args.get("zone", ""))
    if name == "calculate":
        return misc_tools.calculate(args.get("expression", ""))
    if name == "convert_units":
        return misc_tools.convert_units(
            args.get("value", 0), args.get("from_unit", ""),
            args.get("to_unit", ""),
        )
    if name == "make_qr":
        return misc_tools.make_qr(args.get("data", ""))
    if name == "add_todo":
        return todos.add_todo(telegram_id, args.get("text", ""))
    if name == "list_todos":
        return todos.list_todos(telegram_id, args.get("show", "pending"))
    if name == "done_todo":
        return todos.done_todo(telegram_id, args.get("match", ""))
    if name == "remove_todo":
        return todos.remove_todo(telegram_id, args.get("match", ""))
    return {"error": f"Unknown tool: {name}"}


def _handle_generate_file(args: dict):
    """
    Generate a file artifact directly (CSV/JSON/PNG/PDF/HTML) via an
    E2B sandbox which materializes the file, then we read it back.
    """
    filename = args.get("filename", "artifact.txt")
    content = args.get("content", "")
    kind = args.get("kind", "txt")

    if kind in ("csv", "json", "txt"):
        # Trivial: write content directly, no sandbox needed.
        import base64
        data = content if isinstance(content, str) else json.dumps(content)
        return {
            "success": True,
            "files": [{"name": filename,
                       "data_b64": base64.b64encode(data.encode()).decode(),
                       "mime": _mime(kind)}]
        }

    # png/pdf/html require execution -> use E2B.
    code = _artifact_code(filename, content, kind)
    return execute_code(code, "python")


def _artifact_code(filename: str, content: str, kind: str) -> str:
    if kind == "png":
        return (
            "import matplotlib\nmatplotlib.use('Agg')\n"
            "import matplotlib.pyplot as plt\n"
            "import json, io\n"
            f"data = {content!r}\n"
            "import ast\n"
            "try:\n data = json.loads(data)\nexcept: pass\n"
            "labels = list(data.keys()) if isinstance(data, dict) else list(range(len(data)))\n"
            "values = list(data.values()) if isinstance(data, dict) else data\n"
            "plt.figure(figsize=(8,5))\nplt.bar(labels[:20], values[:20])\n"
            "plt.title('J.A.R.V.I.S. Artifact')\nplt.tight_layout()\n"
            f"plt.savefig('/home/user/{filename}')\nprint('saved')"
        )
    if kind == "html":
        return (
            f"with open('/home/user/{filename}', 'w') as f:\n"
            f"    f.write({content!r})\nprint('saved')"
        )
    if kind == "pdf":
        return (
            "from fpdf import FPDF\n"
            "pdf = FPDF()\npdf.add_page()\npdf.set_font('Arial', size=12)\n"
            f"for line in {content!r}.splitlines():\n    pdf.multi_cell(0,8,line)\n"
            f"pdf.output('/home/user/{filename}')\nprint('saved')"
        )
    return f"with open('/home/user/{filename}','w') as f: f.write({content!r})"


def _mime(kind: str) -> str:
    m = {"csv": "text/csv", "json": "application/json",
         "txt": "text/plain", "png": "image/png",
         "pdf": "application/pdf", "html": "text/html"}
    return m.get(kind, "application/octet-stream")


def _tool_calls_json():
    import datetime
    return {"count": 0, "generated": datetime.datetime.utcnow().isoformat()}


def _notify_user(telegram_id: int, text: str, urls: list):
    """Send the result text (chunked to Telegram's 4096 limit) and files."""
    chunks = _chunk_text(text, 4000)
    for i, chunk in enumerate(chunks):
        telegram.send_message(telegram_id, chunk)
    for url in urls:
        telegram.send_document(telegram_id, url, caption="📎 J.A.R.V.I.S. Artifact")


def _chunk_text(text: str, limit: int = 4000) -> list:
    """Split text into Telegram-safe chunks on newline boundaries."""
    if len(text) <= limit:
        return [text]
    chunks = []
    current = []
    cur_len = 0
    for line in text.splitlines(keepends=True):
        if cur_len + len(line) > limit:
            chunks.append("".join(current))
            current = [line]
            cur_len = len(line)
        else:
            current.append(line)
            cur_len += len(line)
    if current:
        chunks.append("".join(current))
    return chunks or [text[:limit]]


# ------------------------------------------------------------------
# Optional fallback endpoint (can also be triggered manually).
# URL: /api/orchestrator
# ------------------------------------------------------------------
class handler(BaseHTTPRequestHandler):

    def do_GET(self):
        self._send_json({"ok": True, "service": "J.A.R.V.I.S. orchestrator"}, 200)

    def do_POST(self):
        """
        Accepts a webhook payload matching the tasks row shape:
          {"record": {id, telegram_id, input, status, ...}}
        or simply {"id": ..., "telegram_id": ..., "input": ...}.
        """
        try:
            payload = self._read_json()
            record = payload.get("record", payload)
            task_id = record.get("id")
            telegram_id = record.get("telegram_id")
            user_input = record.get("input")
            status = record.get("status", "PENDING")

            if status != "PENDING":
                return self._send_json({"ok": True, "skipped": status}, 200)
            if not (task_id and telegram_id and user_input):
                return self._send_json({"ok": False, "error": "Missing fields"}, 400)

            _run_pipeline(task_id, telegram_id, user_input)

            return self._send_json({"ok": True, "task_id": task_id}, 200)
        except Exception as exc:
            logger.exception("Orchestrator failed")
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
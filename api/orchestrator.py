"""
Orchestrator (Planner / central controller).

Triggered by Supabase Database Webhook when a new task row is inserted
with status PENDING. It:
  1. Loads the task from Supabase.
  2. Calls Groq with tool definitions to decide which agent/tool to use.
  3. Executes the chosen tool (search / scrape / E2B code execution).
  4. Optionally generates a file artifact and uploads it to Storage.
  5. Updates the task status and sends the result back to Telegram.
"""
import os
import json
import logging
import asyncio
from http.server import BaseHTTPRequestHandler

from utils import groq_client, supabase_client, telegram
from utils.search_tools import search_web, scrape_url
from utils.e2b_executor import execute_code

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("orchestrator")

# Map Groq tool function names to our async implementations.
TOOL_REGISTRY = {
    "search_web": search_web,
    "scrape_url": scrape_url,
    "execute_code": execute_code,
}


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


async def _run_pipeline(task_id: str, telegram_id: int, user_input: str):
    """The full agentic orchestration pipeline for a single task."""
    # Acquire task (mark PROCESSING).
    await supabase_client.update_task(task_id, {"status": "PROCESSING"})
    await telegram.send_typing(telegram_id)

    # Load recent history for conversational context (RAG-lite).
    history = []
    try:
        history = await supabase_client.get_recent_history(telegram_id, limit=6)
        ctx = [{"role": h["role"], "content": h["content"]} for h in history]
    except Exception:
        ctx = []

    # Store the user message for context.
    try:
        await supabase_client.insert_chat(telegram_id, "user", user_input)
    except Exception:
        pass

    # 1. Planner: ask Groq to decide the next action(s).
    final_text_parts = []
    final_files = []
    max_iterations = int(os.getenv("MAX_TOOL_ITERATIONS", "3"))

    context = ctx
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
        user_input = user_input  # keep original user request available

        for tc in tool_calls:
            name = tc["name"]
            args = tc["arguments"]
            logger.info(f"Executing tool: {name} -> {args}")

            tool_result = await _dispatch_tool(name, args)
            context.append({
                "role": "tool",
                "tool_call_id": tc.get("id", f"call_{iteration}"),
                "content": json.dumps(tool_result, ensure_ascii=False)[:3000],
            })

            # Capture generated files from E2B execution.
            if name == "execute_code":
                for f in tool_result.get("files", []):
                    final_files.append(f)

    # 2. Builder: if files were generated, upload them to Storage.
    result_urls = []
    for f in final_files:
        try:
            url = await supabase_client.upload_artifact(
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
        await supabase_client.insert_chat(telegram_id, "assistant", final_text)
    except Exception:
        pass

    await supabase_client.update_task(task_id, {
        "status": "DONE",
        "result_text": final_text[:4000],
        "result_url": result_urls[0] if result_urls else None,
        "tool_calls": _tool_calls_json(),
    })

    # 5. Send result back to Telegram.
    await _notify_user(telegram_id, final_text, result_urls)


async def _dispatch_tool(name: str, args: dict):
    """Route a tool call to its async implementation."""
    if name == "search_web":
        return await search_web(args.get("query", ""), args.get("max_results", 5))
    if name == "scrape_url":
        return {"content": await scrape_url(args.get("url", ""))}
    if name == "execute_code":
        return await execute_code(args.get("code", ""), args.get("language", "python"))
    if name == "generate_file":
        return await _handle_generate_file(args)
    return {"error": f"Unknown tool: {name}"}


async def _handle_generate_file(args: dict):
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
    return await execute_code(code, "python")


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


async def _notify_user(telegram_id: int, text: str, urls: list):
    """Send the result text and any file documents back to Telegram."""
    sent_text = await telegram.send_message(telegram_id, text)
    for url in urls:
        await telegram.send_document(telegram_id, url, caption="📎 J.A.R.V.I.S. Artifact")
    return sent_text


# ------------------------------------------------------------------
# Endpoint invoked by Supabase Database Webhook (on task insert)
# URL: /api/orchestrator
# ------------------------------------------------------------------
class handler(BaseHTTPRequestHandler):

    def do_GET(self):
        self._send_json({"ok": True, "service": "J.A.R.V.I.S. orchestrator"}, 200)

    def do_POST(self):
        """
        Supabase database webhook posts the new row here.
        The payload looks like:
          {"type": "INSERT", "record": {id, telegram_id, input, ...}}
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

            # Run the pipeline (bounded execution window).
            asyncio.run(_run_pipeline(task_id, telegram_id, user_input))

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

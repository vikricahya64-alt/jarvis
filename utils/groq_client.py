"""
Groq client wrapper for LLM interaction with function/tool calling.

Uses llama-3.3-70b-versatile and automatically falls back to other
free-tier models if the primary model is unavailable.
"""
import os
import json
import re
import time

try:
    from groq import Groq, AsyncGroq, RateLimitError
    GROQ_AVAILABLE = True
except ImportError:
    Groq = AsyncGroq = RateLimitError = None
    GROQ_AVAILABLE = False

MODEL = os.getenv("GROQ_MODEL", "openai/gpt-oss-20b")
FALLBACK_MODELS = ["openai/gpt-oss-20b", "openai/gpt-oss-120b", "qwen/qwen3.8-27b", "qwen/qwen3.6-27b"]

# Deadline shared across all Groq calls within one pipeline run, so a burst
# of 429s (free tier) or slow fallbacks can never blow Vercel's 60s Hobby cap.
_deadline_ts = None  # set by set_budget(seconds); None = no deadline


def set_budget(seconds: float):
    """Bound total wall-clock time for all in-flight Groq calls."""
    global _deadline_ts
    _deadline_ts = time.monotonic() + seconds


def _over_deadline() -> bool:
    return _deadline_ts is not None and time.monotonic() > _deadline_ts


def _remaining_budget() -> float:
    if _deadline_ts is None:
        return float("inf")
    return max(_deadline_ts - time.monotonic(), 0.0)


def _retry_after_seconds(message: str) -> float:
    """Parse 'try again in 15.3s' hints from Groq 429 messages."""
    m = re.search(r"in\s+([\d.]+)s", message or "")
    return float(m.group(1)) if m else 0.0

# Tool definitions advertised to the model (function calling).
# Kept terse to minimize tokens per call on the free TPM budget.
TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "search_web",
            "description": "Returns top DuckDuckGo web links for a query. Use for link lists.",
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {"type": "string", "description": "Search query."},
                    "max_results": {"type": "integer", "description": "Default 5."},
                },
                "required": ["query"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "scrape_url",
            "description": "Fetch readable text from a URL.",
            "parameters": {
                "type": "object",
                "properties": {"url": {"type": "string", "description": "URL to fetch."}},
                "required": ["url"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "execute_code",
            "description": "Run Python/JS in an E2B sandbox; returns stdout and file paths.",
            "parameters": {
                "type": "object",
                "properties": {
                    "code": {"type": "string", "description": "Full source code."},
                    "language": {
                        "type": "string",
                        "enum": ["python", "javascript"],
                        "description": "Default python.",
                    },
                },
                "required": ["code"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "generate_file",
            "description": "Build a file artifact (csv/json/png/pdf/html) from data.",
            "parameters": {
                "type": "object",
                "properties": {
                    "filename": {"type": "string", "description": "e.g. report.pdf."},
                    "content": {
                        "type": "string",
                        "description": "Raw content / JSON data to render.",
                    },
                    "kind": {
                        "type": "string",
                        "enum": ["csv", "json", "png", "pdf", "html"],
                        "description": "File type.",
                    },
                },
                "required": ["filename", "content"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "search_live",
            "description": "Live web answer via free DuckDuckGo AI Chat. Use for current news/prices/facts needing a direct answer with sources.",
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {"type": "string", "description": "Topic to research."}
                },
                "required": ["query"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "store_document",
            "description": "Save notes/docs to the knowledge base ('simpan', 'ingat').",
            "parameters": {
                "type": "object",
                "properties": {
                    "title": {"type": "string", "description": "Short title."},
                    "content": {"type": "string", "description": "Text to remember."},
                },
                "required": ["title", "content"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "retrieve_docs",
            "description": "Search the knowledge base for saved notes related to a question.",
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {"type": "string", "description": "Search keywords."},
                    "top_k": {"type": "integer", "description": "Default 5."},
                },
                "required": ["query"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_weather",
            "description": "Current weather + today's forecast for a city.",
            "parameters": {
                "type": "object",
                "properties": {"city": {"type": "string", "description": "City name, e.g. Bandung."}},
                "required": ["city"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "convert_currency",
            "description": "Convert an amount between ISO currencies (USD, IDR, EUR...).",
            "parameters": {
                "type": "object",
                "properties": {
                    "amount": {"type": "number", "description": "Amount to convert."},
                    "from_currency": {"type": "string", "description": "ISO code, e.g. USD."},
                    "to_currency": {"type": "string", "description": "ISO code, e.g. IDR."},
                },
                "required": ["amount", "from_currency", "to_currency"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "crypto_price",
            "description": "Current price of a crypto coin (BTC, ETH, SOL...) in a currency.",
            "parameters": {
                "type": "object",
                "properties": {
                    "coin": {"type": "string", "description": "Coin name/symbol, e.g. BTC."},
                    "currency": {"type": "string", "description": "Default usd."},
                },
                "required": ["coin"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "geo_info",
            "description": "Location details (city/country/timezone) for an IP address.",
            "parameters": {
                "type": "object",
                "properties": {"ip": {"type": "string", "description": "IP address; empty = caller IP."}},
                "required": [],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "shorten_url",
            "description": "Shorten a long URL (is.gd/TinyURL).",
            "parameters": {
                "type": "object",
                "properties": {"url": {"type": "string", "description": "URL to shorten."}},
                "required": ["url"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "translate",
            "description": "Translate text into a target language (e.g. en, id, ja).",
            "parameters": {
                "type": "object",
                "properties": {
                    "text": {"type": "string", "description": "Text to translate."},
                    "target_lang": {"type": "string", "description": "Default id."},
                },
                "required": ["text"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "world_time",
            "description": "Current local time for a zone/city (jakarta, tokyo, london...).",
            "parameters": {
                "type": "object",
                "properties": {"zone": {"type": "string", "description": "Zone or city alias; empty = default."}},
                "required": [],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "calculate",
            "description": "Evaluate a math expression safely (e.g. '2*pi*5', 'sqrt(144)+3').",
            "parameters": {
                "type": "object",
                "properties": {"expression": {"type": "string", "description": "Math expression."}},
                "required": ["expression"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "convert_units",
            "description": "Convert units: length, mass, speed, data, temperature (c/f/k).",
            "parameters": {
                "type": "object",
                "properties": {
                    "value": {"type": "number", "description": "Numeric value."},
                    "from_unit": {"type": "string", "description": "e.g. km, mile, kg, lb, mph, mb, c."},
                    "to_unit": {"type": "string", "description": "e.g. m, km, g, kg, km/h, gb, f."},
                },
                "required": ["value", "from_unit", "to_unit"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "make_qr",
            "description": "Generate a QR code PNG image for any text/URL/link.",
            "parameters": {
                "type": "object",
                "properties": {"data": {"type": "string", "description": "Text or URL to encode."}},
                "required": ["data"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "add_todo",
            "description": "Save a personal to-do/reminder item for the user.",
            "parameters": {
                "type": "object",
                "properties": {"text": {"type": "string", "description": "Task description."}},
                "required": ["text"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "list_todos",
            "description": "List the user's to-do items.",
            "parameters": {
                "type": "object",
                "properties": {"show": {"type": "string", "description": "pending (default), done, or all."}},
                "required": [],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "done_todo",
            "description": "Mark a to-do item as done (match by text or number).",
            "parameters": {
                "type": "object",
                "properties": {"match": {"type": "string", "description": "Text/number of the item."}},
                "required": ["match"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "remove_todo",
            "description": "Delete a to-do item (match by text or number).",
            "parameters": {
                "type": "object",
                "properties": {"match": {"type": "string", "description": "Text/number of the item."}},
                "required": ["match"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "read_gmail",
            "description": "Read the user's Gmail inbox (metadata headers + snippets). Requires /login gmail first.",
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {"type": "string", "description": "Gmail search query (e.g. 'from:x subject:y')."},
                    "max_results": {"type": "integer", "description": "Default 5."},
                },
                "required": [],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "upload_to_drive",
            "description": "Upload a text file to the user's Google Drive. Requires /login google_drive first.",
            "parameters": {
                "type": "object",
                "properties": {
                    "filename": {"type": "string", "description": "File name to create."},
                    "content": {"type": "string", "description": "File content."},
                },
                "required": ["filename", "content"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "query_notion",
            "description": "Search the user's Notion workspace. Requires /login notion first.",
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {"type": "string", "description": "Text to search."},
                    "limit": {"type": "integer", "description": "Default 5."},
                },
                "required": [],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_calendar_events",
            "description": "Read the user's upcoming Google Calendar events. Requires /login calendar first.",
            "parameters": {
                "type": "object",
                "properties": {
                    "days": {"type": "integer", "description": "Lookahead in days (default 7)."},
                    "max_results": {"type": "integer", "description": "Default 10."},
                },
                "required": [],
            },
        },
    },
]


def _build_messages(user_input, context=None, system_prompt=None,
                    extra_system=None):
    system = system_prompt or (
        "You are J.A.R.V.I.S., a personal industrial agentic AI. "
        "You orchestrate real work: searching the web, writing and executing code, "
        "and generating file artifacts (CSV, JSON, PNG charts, PDF reports). "
        "When a task requires multiple steps (search -> analyze -> generate file), "
        "call the tools in sequence and combine the results. "
        "If you need to execute code or generate a file, use the corresponding tool "
        "and then report the resulting file URL. "
        "You also have a persistent knowledge base: when the user asks to save or "
        "remember something, call store_document; when a question may relate to "
        "previously saved notes or documents, call retrieve_docs first and answer "
        "based on the retrieved content. "
        "For questions about current events, live data, prices or news, prefer "
        "search_live (DuckDuckGo AI Chat) to get a direct, up-to-date answer; "
        "use search_web when the user explicitly wants a list of links. "
        "Use the utility tools for fast free data: get_weather for forecasts, "
        "convert_currency for exchange rates, crypto_price for crypto prices, "
        "geo_info for IP location, shorten_url for short links, translate for "
        "translations, and world_time for current time in any timezone. "
        "For math use calculate; for unit conversions (length/mass/speed/data/"
        "temperature) use convert_units; for QR codes use make_qr. "
        "You retain a per-user to-do list: add_todo to save a task, "
        "list_todos to show it, done_todo/remove_todo to change it. "
        "Private integrations: read_gmail, upload_to_drive and query_notion "
        "only work for a user who has connected their account via /login. "
        "If such a tool returns 'belum terhubung', tell the user to run "
        "/login <provider> instead of inventing data. "
        "ALWAYS base answers about to-dos, search results, prices, weather, "
        "calculations, and any data on the exact tool output you just "
        "received — never on memory, prior chats, or guesses. If a tool "
        "result is empty, say it's empty; do not invent items."
    )

    if extra_system:
        system = f"{system}\n\n{extra_system}"

    messages = [{"role": "system", "content": system}]
    if context:
        messages.extend(context)
    messages.append({"role": "user", "content": user_input})
    return messages


def sync_completion(user_input, context=None, system_prompt=None,
                    tool_choice="auto", extra_system=None):
    """
    Synchronous wrapper. In Vercel's Flask serverless this is acceptable
    for the orchestrator's bounded execution window.
    """
    if not GROQ_AVAILABLE:
        raise RuntimeError("groq package not installed")

    messages = _build_messages(user_input, context, system_prompt=system_prompt,
                               extra_system=extra_system)

    def _create(model: str, max_tokens: int = 900):
        return client.chat.completions.create(
            model=model,
            messages=messages,
            tools=TOOLS,
            tool_choice=tool_choice,
            temperature=0.3,
            max_tokens=max_tokens,
        )

    client = Groq(
        api_key=os.getenv("GROQ_API_KEY"),
        timeout=20.0,
        max_retries=0,  # we manage retries to respect the shared budget
    )

    attempts = 0
    while True:
        if _over_deadline():
            raise RuntimeError("Groq budget exhausted (deadline hit)")
        try:
            return _create(MODEL)
        except RateLimitError as exc:
            attempts += 1
            if attempts >= 4:
                raise RuntimeError(f"Groq rate limited after {attempts} tries: {exc}")
            wait = _retry_after_seconds(str(exc)) or (2 * attempts)
            time.sleep(min(wait, max(_remaining_budget() - 3, 1)))
        except Exception as exc:
            for model in FALLBACK_MODELS:
                if _over_deadline():
                    raise RuntimeError("Groq budget exhausted (deadline hit)")
                try:
                    return _create(model)
                except Exception:
                    continue
            raise RuntimeError(f"Groq error: {exc}")


async def async_completion(user_input, context=None):
    """Async wrapper using AsyncGroq for higher concurrency."""
    if not GROQ_AVAILABLE:
        raise RuntimeError("groq package not installed")
    client = AsyncGroq(api_key=os.getenv("GROQ_API_KEY"))
    messages = _build_messages(user_input, context)

    try:
        response = await client.chat.completions.create(
            model=MODEL,
            messages=messages,
            tools=TOOLS,
            tool_choice="auto",
            temperature=0.3,
            max_tokens=2000,
        )
        return response
    except Exception as exc:
        for model in FALLBACK_MODELS:
            try:
                response = await client.chat.completions.create(
                    model=model,
                    messages=messages,
                    tools=TOOLS,
                    tool_choice="auto",
                    temperature=0.3,
                    max_tokens=2000,
                )
                return response
            except Exception:
                continue
        raise RuntimeError(f"Groq error: {exc}")

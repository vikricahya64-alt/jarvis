"""
Groq client wrapper for LLM interaction with function/tool calling.

Uses llama-3.3-70b-versatile and automatically falls back to other
free-tier models if the primary model is unavailable.
"""
import os
import json

try:
    from groq import Groq, AsyncGroq
    GROQ_AVAILABLE = True
except ImportError:
    Groq = AsyncGroq = None
    GROQ_AVAILABLE = False

MODEL = os.getenv("GROQ_MODEL", "openai/gpt-oss-20b")
FALLBACK_MODELS = ["openai/gpt-oss-20b", "openai/gpt-oss-120b", "qwen/qwen3.8-27b", "qwen/qwen3.6-27b"]

# Tool definitions advertised to the model (function calling)
TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "search_web",
            "description": "Search the web for real-time information using DuckDuckGo and return top results.",
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {
                        "type": "string",
                        "description": "The search query to look up."
                    },
                    "max_results": {
                        "type": "integer",
                        "description": "Maximum number of results to return (default 5)."
                    }
                },
                "required": ["query"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "scrape_url",
            "description": "Fetch and extract readable text content from a URL.",
            "parameters": {
                "type": "object",
                "properties": {
                    "url": {
                        "type": "string",
                        "description": "The URL to fetch content from."
                    }
                },
                "required": ["url"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "execute_code",
            "description": "Execute Python or JavaScript code in an isolated E2B sandbox. Returns stdout and generated file paths.",
            "parameters": {
                "type": "object",
                "properties": {
                    "code": {
                        "type": "string",
                        "description": "The full source code to execute."
                    },
                    "language": {
                        "type": "string",
                        "enum": ["python", "javascript"],
                        "description": "The language of the code (default python)."
                    }
                },
                "required": ["code"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "generate_file",
            "description": "Generate a file artifact (csv, json, png chart, pdf report) from a data payload and upload it to storage.",
            "parameters": {
                "type": "object",
                "properties": {
                    "filename": {
                        "type": "string",
                        "description": "Desired filename with extension (e.g. report.pdf, chart.png)."
                    },
                    "content": {
                        "type": "string",
                        "description": "The raw content or a JSON description of data to be rendered into the file."
                    },
                    "kind": {
                        "type": "string",
                        "enum": ["csv", "json", "png", "pdf", "html"],
                        "description": "Type of file to generate."
                    }
                },
                "required": ["filename", "content"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "search_live",
            "description": "Get a concise, up-to-date answer based on LIVE web search via DuckDuckGo AI Chat (free, no API key). Ideal when the user needs current facts, news, prices, or a direct answer rather than a list of links. Returns a short structured answer with inline sources.",
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {
                        "type": "string",
                        "description": "The question or topic to research live."
                    }
                },
                "required": ["query"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "store_document",
            "description": "Save a document or notes into J.A.R.V.I.S.'s persistent knowledge base (local memory). Use this when the user says 'simpan', 'ingat', 'remember', or shares reference material they want the bot to know in future answers.",
            "parameters": {
                "type": "object",
                "properties": {
                    "title": {
                        "type": "string",
                        "description": "A short title for the document/notes."
                    },
                    "content": {
                        "type": "string",
                        "description": "The full text/content of the document to remember."
                    }
                },
                "required": ["title", "content"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "retrieve_docs",
            "description": "Search the persistent knowledge base (local memory/documents) for relevant information to answer the user's question. Use this when the question may relate to previously stored notes or documents.",
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {
                        "type": "string",
                        "description": "The search query or keywords to look up."
                    },
                    "top_k": {
                        "type": "integer",
                        "description": "Number of results to return (default 5)."
                    }
                },
                "required": ["query"]
            }
        }
    }
]


def _build_messages(user_input, context=None, system_prompt=None):
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
        "use search_web when the user explicitly wants a list of links."
    )

    messages = [{"role": "system", "content": system}]
    if context:
        messages.extend(context)
    messages.append({"role": "user", "content": user_input})
    return messages


def sync_completion(user_input, context=None):
    """
    Synchronous wrapper. In Vercel's Flask serverless this is acceptable
    for the orchestrator's bounded execution window.
    """
    if not GROQ_AVAILABLE:
        raise RuntimeError("groq package not installed")
    client = Groq(api_key=os.getenv("GROQ_API_KEY"))
    messages = _build_messages(user_input, context)

    try:
        response = client.chat.completions.create(
            model=MODEL,
            messages=messages,
            tools=TOOLS,
            tool_choice="auto",
            temperature=0.3,
            max_tokens=2000,
        )
        return response
    except Exception as exc:
        # Attempt fallback model
        for model in FALLBACK_MODELS:
            try:
                response = client.chat.completions.create(
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

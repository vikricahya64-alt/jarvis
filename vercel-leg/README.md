# J.A.R.V.I.S. — Personal Industrial Agentic AI

A personal agentic AI assistant built **100% on free-tier services**. It orchestrates
real work: searching the web, writing and executing code, and generating file
artifacts (CSV, JSON, PNG charts, PDF reports). You talk to it via Telegram.

## 🏗️ Architecture

```
┌─────────────┐     HTTP      ┌──────────────────┐     INSERT     ┌─────────────────┐
│   Telegram  │ ───────────▶ │  api/webhook.py   │ ────────────▶ │   Supabase      │
│  (User)     │              │  (Vercel Func)     │              │  (tasks table)  │
└─────────────┘              └──────────────────┘              └────────┬────────┘
      ▲                                                                │  DB Webhook
      │  send result                                                     ▼  (on INSERT)
      │                                                      ┌─────────────────────────┐
      └──────────────────────────────────────────────────── │  api/orchestrator.py     │
                                                            │  (Vercel Func)            │
                                                            └────────────┬─────────────┘
                                                                         │  Groq tool-calling
                                                       ┌─────────────────┼─────────────────┐
                                                       │                 │                 │
                                              ┌────────┴─────┐   ┌───────┴───────┐  ┌─────┴──────┐
                                              │  RESEARCHER  │   │    BUILDER    │  │  PLANNER   │
                                              │  search+scrape│  │  E2B sandbox  │  │  (Groq)    │
                                              └──────────────┘   └───────────────┘  └────────────┘
                                                                       │ upload files
                                                                       ▼
                                                              ┌──────────────────┐
                                                              │ Supabase Storage  │
                                                              │ (artifacts bucket)│
                                                              └──────────────────┘
```

## 🧠 3 Modular Agents

| Agent | Role | Tool |
|-------|------|------|
| **Orchestrator (Planner)** | Decides which agent to invoke, breaks tasks into sub-steps | Groq tool-calling |
| **Researcher** | Gathers real-time info | `search_web(query)`, `scrape_url(url)` |
| **Builder** | Writes & runs code to generate files | `execute_code(code, lang)` via E2B |

## 🔄 Orchestration Flow

1. **User sends a Telegram message** → Telegram delivers it to `api/webhook.py`.
2. **`webhook.py` verifies the secret token**, grabs the message, inserts a new row
   into the Supabase `tasks` table with `status='PENDING'`, and **returns 200 OK** instantly.
3. **Supabase Database Webhook** fires on the INSERT and calls `api/orchestrator.py`.
4. **`orchestrator.py`**: marks the task `PROCESSING`, loads chat history (RAG context),
   and calls **Groq** (`llama-3.3-70b-versatile`) with tool definitions.
5. **Groq returns a tool call** (e.g. `search_web`, `execute_code`). The orchestrator
   executes it:
   - Researcher → DuckDuckGo search / scrape.
   - Builder → E2B sandbox runs Python/JS, produces files.
6. Any generated file is **uploaded to Supabase Storage**.
7. Orchestrator updates the task to `DONE` (with `result_text` + `result_url`) and
   **sends the result back to the user via Telegram Bot API**.

## 📁 Folder Structure

```
jarvis/
├── requirements.txt
├── vercel.json
├── .env.example
├── api/
│   ├── __init__.py
│   ├── webhook.py          # Telegram entry point
│   └── orchestrator.py     # Main agentic logic
├── utils/
│   ├── __init__.py
│   ├── groq_client.py      # LLM + tool calling
│   ├── search_tools.py     # DuckDuckGo + scrape
│   ├── e2b_executor.py     # Sandboxed code execution
│   ├── supabase_client.py  # DB + Storage
│   └── telegram.py         # Telegram Bot API
├── sql/
│   └── schema.sql          # Supabase migration + RLS
└── docs/
    └── DEPLOYMENT.md       # Full setup guide
```

## 🧰 Tech Stack (all free tier)

| Layer | Service | Role |
|-------|---------|------|
| Brain | Groq (`llama-3.3-70b-versatile`) | Reasoning + function calling |
| Hands | E2B Code Interpreter | Secure Python/JS execution |
| Memory | Supabase (Postgres + pgvector + Storage) | Long-term memory, RAG, artifacts |
| Interface | Telegram Bot API (webhooks) | Chat with the user |
| Hosting | Vercel Serverless (Python runtime) | Backend endpoints |
| Search | DuckDuckGo (`duckduckgo-search`) | Real-time web data |

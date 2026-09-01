# J.A.R.V.I.S. — Deployment Guide (Step-by-Step)

This guide walks you through deploying J.A.R.V.I.S. entirely on free-tier services:
**Vercel**, **Supabase**, **Groq**, **E2B**, and **Telegram**.

---

## 1. Get the Free API Keys

### a) Groq API Key (Brain)
1. Go to https://console.groq.com and sign up.
2. Create an API key under **API Keys** → **Create API Key**.
3. Copy it (starts with `gsk_`). Model to use: `llama-3.3-70b-versatile`.

### b) Supabase (Memory & Storage)
1. Go to https://supabase.com → **New Project** (free tier).
2. Note your **Project URL** (e.g. `https://xyz.supabase.co`).
3. In **Settings → API**, copy:
   - `anon` public key → `SUPABASE_KEY`
   - `service_role` key → `SUPABASE_SERVICE_KEY` (keep secret!)
4. In the **SQL Editor**, run the entire contents of `sql/schema.sql`.

### c) Telegram Bot Token (Interface)
1. Open @BotFather in Telegram.
2. `/newbot` → choose a name & username.
3. Copy the token (format `123456:ABC-DEF...`) → `TELEGRAM_TOKEN`.
4. Create a random secret string for `TELEGRAM_SECRET_TOKEN` (used to authenticate webhook calls).

### d) E2B API Key (Hands)
1. Go to https://e2b.dev → sign up → **Dashboard**.
2. Copy your API key → `E2B_API_KEY`.

---

## 2. Configure Vercel Serverless

Vercel uses the `api/` directory as file-based Python serverless functions (Python runtime).
Each `.py` file (e.g. `api/webhook.py`, `api/orchestrator.py`) defines a `handler`
class that subclasses `BaseHTTPRequestHandler`.

Include a `vercel.json` that sets `"framework": null` so Vercel uses file-based
`/api` functions instead of forcing a single Flask/FastAPI entrypoint:

```json
{
  "framework": null,
  "functions": {
    "api/webhook.py": { "maxDuration": 10 },
    "api/orchestrator.py": { "maxDuration": 60 }
  }
}
```

### Deploy
```bash
# 1. Install Vercel CLI
npm i -g vercel

# 2. Login
vercel login

# 3. Deploy (from the project folder)
cd jarvis
vercel
```

### Set Environment Variables in Vercel
In **Project → Settings → Environment Variables**, add:

| Name | Value |
|------|-------|
| `GROQ_API_KEY` | `gsk_...` |
| `GROQ_MODEL` | `openai/gpt-oss-20b` |
| `SUPABASE_URL` | `https://xyz.supabase.co` |
| `SUPABASE_KEY` | your anon key |
| `SUPABASE_SERVICE_KEY` | your service_role key |
| `TELEGRAM_TOKEN` | `123456:ABC...` |
| `TELEGRAM_SECRET_TOKEN` | your random secret |
| `E2B_API_KEY` | your E2B key |
| `MAX_TOOL_ITERATIONS` | `3` |

Apply to **Production** (+ Preview/Development as desired). Redeploy.

After deploying, your endpoints are:
- `https://<your-app>.vercel.app/api/webhook`
- `https://<your-app>.vercel.app/api/orchestrator`

---

## 3. Point Telegram to the Webhook

Set the webhook URL with your token (using the token in the URL):

```bash
curl "https://api.telegram.org/bot<TELEGRAM_TOKEN>/setWebhook"
  -d "url=https://<your-app>.vercel.app/api/webhook"
  -d "secret_token=<TELEGRAM_SECRET_TOKEN>"
```

Verify:
```bash
curl "https://api.telegram.org/bot<TELEGRAM_TOKEN>/getWebhookInfo"
```

You should see `"pending_update_count": 0`.

---

## 4. Configure Supabase Database Webhook (triggers orchestrator)

1. Supabase Dashboard → **Database → Webhooks** → **Create a new webhook**.
2. **Type:** PostgreSQL Table.
3. **Table:** `tasks`.
4. **Events:** `INSERT`.
5. **Webhook URL:** `https://<your-app>.vercel.app/api/orchestrator`.
6. **Headers:** `Content-Type: application/json`.
7. Save.

Now, whenever a row is inserted into `tasks`, Supabase POSTs the new record to
`/api/orchestrator`, which runs the pipeline.

---

## 5. Test It

Send a message to your bot in Telegram:

- **Search:** "Cari berita AI terbaru"
- **Code:** "Buatkan program Python untuk menghitung rata-rata dari [1, 4, 9, 16]"
- **Chart:** "Buatkan diagram batang penjualan: Jan 100, Feb 150, Mar 200"

You should see a **typing...** indicator, then the result (text and/or file link)
come back from the bot.

---

## Troubleshooting

| Problem | Fix |
|---------|-----|
| Bot never replies | Check `getWebhookInfo`; ensure Supabase DB webhook is set; check Vercel logs. |
| `handler` "Flask entrypoint" build error | Ensure `vercel.json` sets `"framework": null` and files in `api/` are `BaseHTTPRequestHandler` classes. |
| E2B sandbox fails | Confirm `E2B_API_KEY` is set. Check Vercel logs. |
| 429 from Groq | Free tier has per-minute limits; `MAX_TOOL_ITERATIONS` keeps loops bounded. |
| Files not uploaded | Confirm `artifacts` bucket was created by the SQL script and is public. |

---

## Notes & Conventions

- Webhook returns **200 immediately** so Telegram doesn't retry; the heavy work is deferred.
- Generated artifacts are stored in the public `artifacts` bucket and shared via URL.
- Chat history is stored in `chat_history` with `embedding vector(1536)` for future RAG.
- The `service_role` key is used server-side only (never in client code).

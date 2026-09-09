# J.A.R.V.I.S. — Personal Industrial Agentic AI

A personal agentic AI assistant built **100% on free-tier services**.
You talk to it via Telegram; it searches the web, generates images, plans
recurring tasks, and executes heavy cloud work on ephemeral GitHub VM runners.

## 🏗️ Architecture

Single-spine Cloudflare Worker. Telegram webhook is only a *transport* —
every update flows through one brain (`processIntelligence`):

```
┌────────────┐   webhook    ┌─────────────────────────────────────────────┐
│  Telegram   │ ───────────▶ │         Cloudflare Worker (cf/src)          │
└────────────┘              │  telegram_webhook.ts ──▶ processIntelligence │
                            └───────┬──────────────────────────────────────┘
                                    │
            ┌───────────┬───────────┼───────────────┬──────────────┬───────────┐
            ▼           ▼           ▼               ▼              ▼           ▼
        D1 (db)     KV (cfg)    cron ×5        GitHub Actions   Vercel     Groq/
        memori     DMS/audit   otonomi          /tugas VM      Connector   WorkersAI
        tasks      & vault      loops          ephemeral       Figma/     cascade
                             (dream, dms)       runner       Notion/GitHub   LLM
```

| Layer | Service | Role |
|-------|---------|------|
| Edge | Cloudflare Worker | Single webhook→intelligence spine (100k req/day) |
| Brain | Groq → Workers AI (keyless) → OpenRouter → Gemini | LLM cascade |
| Memory | D1 (SQLite) + KV | Long-term memory, tasks, DMS state |
| Interface | Telegram Bot API | Chat with the owner |
| Heavy executor | GitHub Actions (VM, ephemeral) | `/tugas` arbitrary tasks, opencode headless |
| Integrations | Vercel Connector (`jarvis-connector`) | Figma, Notion, GitHub dispatch, image/text |

## 📁 Folder Structure

```
jarvis/
├── cf/                          # Live stack — Cloudflare Worker
│   ├── src/index.ts             # Routes: /healthz, /webhook, /cron
│   ├── src/workers/telegram_webhook.ts   # Telegram transport + commands
│   ├── src/lib/                 # Brain (ai, intelligence, conversation, …)
│   ├── src/daemons/             # Dead-man's switch
│   ├── migrations/              # D1 schema migrations
│   ├── test/                    # logic + safety test suites
│   ├── wrangler.toml            # D1, KV, 5 cron triggers
│   └── deploy.sh                # setup / migrate / secrets / deploy helper
├── .github/workflows/           # deploy + autonomy + /tugas executor
├── data/personal_constitution.md  # owner's sovereignty constitution source
└── cf/docs/                     # SETUP + architecture reference
```

## 🔄 Orchestration Flow

1. **User sends a Telegram message** → worker webhook receives it.
2. **`telegram_webhook.ts`** owner-gates it, classifies intent, routes commands
   (`/tugas`, `/figma`, `/notion`, `/todo`, …) or feeds free text to the brain.
3. **`processIntelligence`** (one brain) runs comprehension gate, memory recall,
   research synthesis, LLM cascade, anti-fabrication verification.
4. **Heavy work** (`/tugas`) is queued in D1 and dispatched via GitHub Actions
   VM; the VM commits its artifact and reports back to `/agent/done`.
5. **Autonomy** runs on 5 cron triggers (DMS, dream cycle, obedience report,
   insight lifecycle, reminders) all guarded by a cron lock.

## 🧰 Tech Stack (all free tier)

| Layer | Service | Role |
|-------|---------|------|
| Edge | Cloudflare Workers + D1 + KV | Hosting, storage, crons |
| LLM | Groq (key), Workers AI (keyless), OpenRouter, Gemini | Reasoning cascade |
| Text gen keyless | Cloudflare Workers AI (`llama-3.3-70b`) | Zero-key fallback |
| Image | Cloudflare Workers AI (flux) → Pollinations | Generation |
| Integrations | Vercel Connector | Figma/Notion/GitHub APIs (token server-side) |
| Search | DuckDuckGo Instant Answer + HTML scrape | Real-time web data |
| Heavy exec | GitHub Actions ephemeral VM | Arbitrary code/artifacts |

## 🛡️ Operating rules

- **Fail-closed**: guards, cron locks, owner-gating, comprehension gate; a
  doubtful action is blocked, never silently approved.
- **No privileges escalation**: `/tugas` VM runs headless with owner-gated
  dispatch only (no inbound webhook from the VM).
- **Free-tier discipline**: ≤5 crons, bounded CPU/timeouts, provider cascade
  instead of paid upgrades.
- Use `cf/docs/SETUP.md` for provisioning, `cf/deploy.sh` for operations.
# 🤖 J.A.R.V.I.S. — Personal Industrial Agentic AI

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Cloudflare Workers](https://img.shields.io/badge/edge-Cloudflare%20Workers-orange)](https://workers.cloudflare.com/)
[![Telegram Bot](https://img.shields.io/badge/interface-Telegram-26A5E4)](https://core.telegram.org/bots)

A personal agentic AI assistant built **100% on free-tier services**.
You talk to it via Telegram; it searches the web, generates images, plans
recurring tasks, and executes heavy cloud work on ephemeral GitHub VM runners.

> **Live demo**: https://jarvis-sigma-navy-gamma.vercel.app

---

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
| Brain | Groq → Workers AI (keyless) → OpenRouter → Gemini → Antigravity | LLM cascade |
| Memory | D1 (SQLite) + KV + Vectorize | Long-term memory, tasks, DMS state, semantic recall |
| Interface | Telegram Bot API | Chat with the owner |
| Heavy executor | GitHub Actions (VM, ephemeral) | `/tugas` arbitrary tasks, opencode headless |
| Integrations | Vercel Connector (`jarvis-connector`) | Figma, Notion, GitHub dispatch, image/text |
| MCP | `@modelcontextprotocol/server` + `client` (2.1.0) | JARVIS as MCP server (`/mcp`) + client (`/mcp` cmd) |

---

## 📁 Folder Structure

```
jarvis/
├── cf/                          # ✅ LIVE STACK — Cloudflare Worker (TypeScript)
│   ├── src/index.ts             # Routes: /healthz, /webhook, /cron, /mcp, /agent/done
│   ├── src/workers/telegram_webhook.ts   # Telegram transport + commands
│   ├── src/lib/                 # Brain (ai, intelligence, conversation, mcp, …)
│   ├── src/daemons/             # Dead-man's switch
│   ├── migrations/              # D1 schema migrations (0001–0019)
│   ├── test/                    # logic + safety + mcp test suites
│   ├── wrangler.toml            # D1, KV, Vectorize, 5 cron triggers
│   ├── deploy.sh                # setup / migrate / secrets / deploy helper
│   └── docs/                    # SETUP + ARCHITECTURE_REFERENCE
├── vercel-leg/                  # ⚠️ LEGACY STACK — Python/Vercel (backstop, not primary)
│   ├── api/                     # Serverless functions (orchestrator, webhook, cron, …)
│   ├── utils/                   # Python helpers (telegram, memory, tools, …)
│   └── vercel.json              # Legacy routing + crons
├── data/personal_constitution.md  # Owner's sovereignty constitution source
├── artifacts/                   # 🚫 Runtime agent outputs (gitignored, not committed)
├── .github/workflows/           # deploy + autonomy + /tugas executor + opencode
├── SUMMARY.md                   # Working notes / self-referential bug summary
└── README.md                    # This file
```

> **Catatan**: `vercel-leg/` adalah stack lama (Python/Vercel) yang berperan sebagai
> backstop/paralel. Stack aktif adalah `cf/`. Jika tidak lagi dipakai, pertimbangkan
> memindahkannya ke branch `legacy` atau repo terpisah untuk mengurangi clutter.

---

## 🔄 Orchestration Flow

1. **User sends a Telegram message** → worker webhook receives it.
2. **`telegram_webhook.ts`** owner-gates it, classifies intent, routes commands
   (`/tugas`, `/figma`, `/notion`, `/todo`, `/mcp`, …) or feeds free text to the brain.
3. **`processIntelligence`** (one brain) runs comprehension gate, memory recall,
   research synthesis, LLM cascade, anti-fabrication verification.
4. **MCP (both ways)** — `/mcp` is a Model Context Protocol adapter:
   endpoint `/mcp` *exposes* the owner's brain as standard MCP tools (Bearer auth,
   fail-closed), and the `/mcp` Telegram command *calls* allow-listed external MCP
   servers as a client (`MCP_SERVERS` secret, deny-by-default per-server tool list).
5. **Heavy work** (`/tugas`) is queued in D1 and dispatched via GitHub Actions
   VM; the VM commits its artifact and reports back to `/agent/done`.
6. **Autonomy** runs on 5 cron triggers (DMS, dream cycle, obedience report,
   insight lifecycle, reminders) all guarded by a cron lock.

---

## 🧰 Tech Stack (all free tier)

| Layer | Service | Role |
|-------|---------|------|
| Edge | Cloudflare Workers + D1 + KV + Vectorize | Hosting, storage, crons, semantic memory |
| LLM | Groq (key), Workers AI (keyless), OpenRouter, Gemini, Antigravity | Reasoning cascade |
| Text gen keyless | Cloudflare Workers AI (`llama-3.3-70b`) | Zero-key fallback |
| Image | Cloudflare Workers AI (flux) → Pollinations | Generation |
| Integrations | Vercel Connector | Figma/Notion/GitHub APIs (token server-side) |
| Search | DuckDuckGo Instant Answer + HTML scrape | Real-time web data |
| Heavy exec | GitHub Actions ephemeral VM | Arbitrary code/artifacts |

---

## 🚀 Quick Start

```bash
cd cf
npm install
cp .dev.vars.example .dev.vars   # isi dengan token & secret kamu
npm run dev                      # local dev (wrangler dev)
npm run typecheck                # tsc --noEmit
npm run test:safety              # safety guard tests
npm run deploy                   # wrangler deploy
```

Lihat [`cf/docs/SETUP.md`](cf/docs/SETUP.md) untuk provisioning lengkap (D1, KV, Vectorize, secrets, webhook).

---

## 🔐 Secrets & Security

Semua nilai rahasia/pribadi **tidak pernah** di-hardcode di repo:

| Secret | Cara set | Kegunaan |
|--------|----------|----------|
| `TELEGRAM_TOKEN` | `wrangler secret put` | Bot API token |
| `TELEGRAM_SECRET` | `wrangler secret put` | Webhook secret header |
| `OWNER_TELEGRAM_ID` | `wrangler secret put` | ID Telegram pemilik (owner-gating) |
| `GROQ_API_KEY` | `wrangler secret put` | LLM primary |
| `OPENROUTER_API_KEY` | `wrangler secret put` | LLM fallback |
| `AGENT_TOKEN` | `wrangler secret put` + GitHub repo secret | Worker ↔ Actions auth |
| `MCP_ACCESS_TOKEN` | `wrangler secret put` | Bearer auth endpoint `/mcp` |
| `MCP_SERVERS` | `wrangler secret put` | Allow-list MCP server eksternal |
| `CF_API_TOKEN` | GitHub repo secret | Deploy workflow |
| `OC_PAT` | GitHub repo secret | opencode PR creation |

**Prinsip**: fail-closed — jika secret tidak diset, fitur terkait nonaktif atau menolak request, tidak pernah silent-approve.

---

## 🛡️ Operating rules

- **Fail-closed**: guards, cron locks, owner-gating, comprehension gate; a
  doubtful action is blocked, never silently approved.
- **No privileges escalation**: `/tugas` VM runs headless with owner-gated
  dispatch only (no inbound webhook from the VM).
- **Free-tier discipline**: ≤5 crons, bounded CPU/timeouts, provider cascade
  instead of paid upgrades.
- Use `cf/docs/SETUP.md` for provisioning, `cf/deploy.sh` for operations.

---

## 📄 License

[MIT](LICENSE) © 2026 Vikri Cahya

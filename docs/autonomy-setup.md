# J.A.R.V.I.S. Autonomy — Setup Guide

Empowers the bot with: proactive scheduling (cron-trigger), active learning
(preferences), and secure private integrations (Gmail / Google Drive /
Notion / Google Calendar via Supabase Vault + OAuth2). 100% free tier.

---

## 1. Database (Supabase SQL Editor)

1. Open Supabase → **SQL Editor** → New query.
2. Paste the entire contents of **`sql/autonomy_schema.sql`** → **Run**.
   Creates:
   - `user_preferences`, `scheduled_jobs`, `private_connections`, `private_usage`
     (tables + RLS + GRANTs, idempotent).
   - `profiles.preferences` (JSONB, spec-compatible mirror column).
   - `match_user_preferences` (pg_trgm similarity matcher) and
     `match_chat_history` (adaptive-learning context retrieval).
   - `jv_write_secret` / `jv_read_secret` / `jv_delete_secret`
     (SECURITY DEFINER wrappers around pgsodium Vault).
3. Verify with `SELECT * FROM scheduled_jobs LIMIT 1;` → returns a row set (empty).
4. In Telegram: `/initautonomi` → replies "✅ Mode otonom siap" and **seeds the
   two default Level-3 jobs idempotently**:
   - **Morning Briefing** — 06:00 WIB daily (weather + calendar agenda)
   - **Weekly Report** — Friday 17:00 WIB (task recap + tips)

> If Vault RPCs error with `relation "vault.decrypted_secrets" does not exist`,
> enable the **Vault** integration: Project Settings → Extensions → **Vault (pgsodium)**.

---

## 2. GitHub Actions Cron (autonomous trigger)

GitHub Actions gives **unlimited** free cron triggers (Vercel Hobby caps crons).

1. Create repo `.github/workflows/autonomy.yml` (already written — commit it).
2. **GitHub repo → Settings → Secrets → Actions** → add:
   - `CRON_SECRET` = value of the Vercel env var `CRON_SECRET`
     (e.g. `jrv_cron_secret_8f2e9a1c`).
   - `TELEGRAM_TOKEN` + `OWNER_CHAT_ID` (optional, for failure notifications).
3. The workflow POSTs `https://jarvis-sigma-navy.vercel.app/api/cron-trigger`
   every 15 min with `Authorization: Bearer $CRON_SECRET` (3 retries, Telegram
   alert on total failure, overlapping runs are serialized via `concurrency`).

Optional in-database alternative (skip if using GitHub Actions):
enable `pg_cron` + `pg_net` extensions, then uncomment the cron.schedule() block
in `autonomy_schema.sql` and set `app.cron_secret` via
`ALTER ROLE postgres SET app.cron_secret = 'jrv_cron_secret_...'`.

---

## 3. Supabase Vault — storing OAuth client credentials

1. Supabase → **Vault** (Project Settings → page "Vault").
2. Add these secrets (must match `/login`):
   - **Google OAuth app** (see §4):
     - `oauth_google_client_id`
     - `oauth_google_client_secret`
   - **Notion integration** (see §5):
     - `oauth_notion_client_id`
     - `oauth_notion_client_secret`

Verify programmatically:

```bash
curl -s https://jarvis-sigma-navy.vercel.app/api/health?full=1
# or simply run /initautonomi in Telegram
```

---

## 4. Google Cloud Console (Gmail + Drive + Calendar)

1. https://console.cloud.google.com → Create project (or pick existing).
2. **APIs & Services → Enable APIs**:
   - Gmail API
   - Google Drive API
   - Google Calendar API
3. **OAuth consent screen** → External → add your email as a test user.
   - Add scopes listed in `utils/oauth2.py` (`gmail.readonly`, `drive.file`,
     `calendar.readonly`, `userinfo.email`, `openid`).
4. **Credentials → Create OAuth client ID → Web application**:
   - Redirect URI: `https://jarvis-sigma-navy.vercel.app/api/oauth2-callback`
5. Copy **Client ID** and **Client secret** into Vault (§3).
6. In Telegram: `/login gmail` → open link → authorize → done.
   For Drive uploads: `/login google_drive` (scopes differ).
   For calendar summaries: `/login calendar` (read-only).

---

## 5. Notion

1. https://www.notion.so/my-integrations → New integration.
   - **Capabilities**: read content; scopes: workspace.
   - Redirect URL: `https://jarvis-sigma-navy.vercel.app/api/oauth2-callback`
2. Copy **Client ID** and **Client secret** into Vault (§3).
3. In Telegram: `/login notion` → authorize → done.

> Your own workspace pages must be shared with the integration (page → ⋯ →
> Connections → the integration) for `query_notion` to find them.

---

## 6. Deployment

```bash
npx vercel deploy --prod --yes
```

Env vars on Vercel (Project → Settings → Environment Variables, Production):
`SUPABASE_URL`, `SUPABASE_SERVICE_KEY`/`SUPABASE_KEY`, `TELEGRAM_TOKEN`,
`TELEGRAM_SECRET_TOKEN`, `GROQ_API_KEY`, `GROQ_MODEL`, `E2B_API_KEY`,
`TAVILY_API_KEY`, `CRON_SECRET`, `PUBLIC_BASE_URL`
(= `https://jarvis-sigma-navy.vercel.app`).

`vercel.json` already registers cron-trigger + oauth2-callback functions with
maxDuration 60.

---

## 7. Testing checklist

1. [ ] `sql/autonomy_schema.sql` ran in SQL Editor without errors.
2. [ ] `/initautonomi` → "✅ Mode otonom siap" + creates the 2 default jobs.
3. [ ] `/listjadwal` shows **Morning Briefing** (06:00 WIB) and **Weekly Report**
      (Friday 17:00 WIB).
4. [ ] `/jadwal 15 "cek status"` → row created; `/listjadwal` shows it.
5. [ ] GitHub Actions run (Actions tab) → `trigger ok: {"ok":true,...}` and
      within ~15 min the bot messages you with the job prompt's result.
6. [ ] Say "selalu jawab pakai IDR" → the reflection stores a preference;
      ask something financial later → answer format honours it.
7. [ ] Verify learned preferences in DB with:
      `SELECT * FROM user_preferences ORDER BY updated_at DESC LIMIT 5;`
      (should show `source='learned'` rows).
8. [ ] Verify context retrieval works:
      `SELECT * FROM match_chat_history(<telegram_id>, 'harga emas', 3);`
9. [ ] `/login gmail` → browser auth → success message → ask
      "read my latest 3 emails" → summary returned (ownership-guarded).
10. [ ] `/login google_drive` → ask "upload a file 'test.txt' with hello" →
      Drive link returned.
11. [ ] `/login calendar` → ask "apa agenda saya minggu ini" →
      calendar events returned.
12. [ ] `/login notion` → "search notes about X" → Notion results returned.
13. [ ] Rapid-fire autonomous triggers: jobs never double-run (CAS-claim),
      and /status tasks remain bounded.
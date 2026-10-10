# rig-bridge — jembatan poll worker JARVIS ↔ mesin OpenRig

Worker Cloudflare tidak bisa memanggil mesin lokal (tidak ada ingress),
maka arahnya dibalik: **poller di mesin ini** mengambil task (`POST
/agent/claim`), mengeksekusinya headless (mirip runner GitHub Actions yang
digantikan), lalu melapor (`POST /agent/done`). Worker tetap satu-satunya
sumber kebenaran antrean (D1 `agent_tasks`).

```
Telegram /tugas ──▶ worker (executor='rig', pending) ──◀ claim ── poller ──▶ codex exec ──▶ POST /agent/done ──▶ DM owner
```

## Prasyarat

- `RIG_EXECUTOR=prefer` (atau `only`) aktif di worker — lihat `cf/wrangler.toml`.
- `AGENT_TOKEN` sama di worker dan mesin ini.
- `codex` login (atau sesuaikan `EXECUTOR_CMD`), `rig` daemon jalan (opsional,
  hanya untuk mirror antrean ke `rig queue`).

## Konfigurasi (env)

| Env | Wajib | Default | Arti |
|---|---|---|---|
| `JARVIS_WORKER_URL` | ya | — | mis. `https://jarvis-sovereign.vikricahya64.workers.dev` |
| `JARVIS_AGENT_TOKEN` | ya | — | sama dengan secret `AGENT_TOKEN` worker |
| `EXECUTOR_CMD` | tidak | `codex exec` | perintah headless + arg prompt di akhir |
| `POLL_INTERVAL_MS` | tidak | `20000` | jeda saat antrean kosong |
| `RUN_TIMEOUT_MS` | tidak | `1080000` | batas eksekusi (18 mnt, ~ batas GH 20 mnt) |
| `RIG_QUEUE_SEAT` | tidak | `tugas-build@tugas` | tujuan mirror `rig queue create` (best-effort) |
| `RIG_QUEUE_MIRROR` | tidak | `1` | `0` = matikan mirror |

## Dua mode jalan (pilih SATU)

**Mode A — tanpa mesin lokal (disarankan bila tidak punya always-on):**
workflow `.github/workflows/rig-bridge-poll.yml` (cron tiap 15 mnt +
`tombol workflow_dispatch`). Runner ephemeral klaim → eksekusi opencode →
lapor. Tanpa artifact commit (hindari push-race), tanpa mirror rig queue.
Biaya: repo publik → Actions free. Idle run puluhan detik. Syarat: secrets
`AGENT_TOKEN` + `GROQ/OPENROUTER_API_KEY` sudah ada; worker `RIG_EXECUTOR`
aktif. Cukup push file workflow ke repo GitHub — tidak ada langkah lain.

**Mode B — mesin always-on (laptop/VPS):** loop `poller.mjs` di tmux/systemd
+ tim `rig-tugas.yaml` (`rig up`) untuk kerja interaktif lanjutan dan mirror
`rig queue`. Latensi klaim detik-an (bukan 15 menitan).

```bash
# sekali klaim (untuk cron/systemd/uji/runner GH):
JARVIS_WORKER_URL=... JARVIS_AGENT_TOKEN=... node rig-bridge/poller.mjs --once

# loop terus (hanya Mode B, di tmux/systemd mesin always-on):
JARVIS_WORKER_URL=... JARVIS_AGENT_TOKEN=... node rig-bridge/poller.mjs
```

Tim rig-nya (opsional, untuk kerja interaktif lanjutan):

```bash
rig up rig-bridge/rig-tugas.yaml --cwd /path/ke/repo --plan
rig up rig-bridge/rig-tugas.yaml --cwd /path/ke/repo
```

## Kontrak

- Klaim atomik di worker: hanya SATU poller menang per task (yang kalah
  menerima `empty:true`). Jangan bypass — selalu lewat `/agent/claim`.
- `result` ≤ 60000 char, `error` ≤ 3000 char (cermin workflow `jarvis-delegate.yml`).
- Task `running` yang tidak melapor ≤30 mnt otomatis gagal via
  `failStaleAgentTasks` (panggil `/cron/trigger?mode=autonomy` berkala).
- Poller tidak pernah melempar keluar loop; semua kegagalan tercatat di log
  dan (bila klaim sudah terjadi) dilaporkan sebagai `failed` ke `/agent/done`
  agar owner tidak menunggu buta.

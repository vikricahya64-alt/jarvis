# Vercel Deploy Ops (Live source)

> **Peringatan arsitektur:** Repo `main` di GitHub **BUKAN** source yang
> berjalan di Vercel live (`jarvis-sigma-navy.vercel.app`). Source live
> di-download langsung dari deployment produksi terakhir dan harus di-deploy
> darinya — **JANGAN deploy repo main** (WIP refactor keras di `cf/` yang
> menghapus live tools seperti `termux_command`, `set_city`, `get_city`,
> `device_*`, `fetch_doc`, `url_to_info`). Deploy repo main akan merampas
> fungsi JARVIS yang berjalan.

## Ringkasan alur

1. **List deployment** produksi terakhir.
2. **Download file-tree** deployment itu ke `/tmp/opencode/live_vercel`.
3. **Patch** `src/utils/groq_client.py` (OpenRouter fallback) bila diperlukan.
4. **Deploy --prod** via Vercel CLI dari `/tmp/opencode/live_vercel/src`.
5. **Verifikasi** `/api/health` + patch terkonfirmasi di deployment.

## Token (jangan commit)

- **Vercel CLI/proyek:** `REDACTED`
- **Project id:** `prj_g2wlnlYBQwywhHd7Kf4xh8mEpeuL`
- **Org id:** `team_A3bt9OY1HciX6blLRN54JxVc`
- **GitHub PAT (deploy/PR `oc/auto-*`):** `REDACTED`
- **Cloudflare (Worker `jarvis-sovereign`):** `019eb7798d76ffff19fe8f3527f39d47` / `REDACTED`

## Cara deploy eksplisit

```bash
# 1. source live direkonstruksi di
cd /tmp/opencode/live_vercel/src

# 2. project linking sudah ada di .vercel/project.json
#    {"orgId":"team_A3bt9OY1HciX6blLRN54JxVc","projectId":"prj_g2wlnlYBQwywhHd7Kf4xh8mEpeuL"}

# 3. deploy produksi (token melalui env var — CLI menolak `--token` setelah subcommand)
VERCEL_TOKEN='REDACTED' \
  vercel deploy --yes --prod --json
```

- Gunakan `--json` untuk alamat url + deployment id.
- `--token <TOKEN>` **tidak** diakui oleh `vercel deploy`; pakai env `VERCEL_TOKEN`
  atau `vercel --token <TOKEN> deploy` (flag sebelum subcommand) saja.

## Verifikasi

```bash
curl -s https://jarvis-sigma-navy.vercel.app/api/health
# { "ok": true, "overall": "ok", "checks": { "groq": "up", "telegram": "up", "supabase": "up", ... } }

# Konfirmasi patch OpenRouter ada di deployment LIVE (bukan hanya lokal):
# 1. list file -> dapatkan uid src/utils/groq_client.py
curl -s -H "Authorization: Bearer $VERCEL_TOKEN" \
  "https://api.vercel.com/v11/deployments/$DEP/filed"          # BUKAN v11!
curl -s -H "Authorization: Bearer $VERCEL_TOKEN" \
  "https://api.vercel.com/v11/deployments/$DEP/files" | ...    # tree rekursif, cari uid

# 2. download file (v8 endpoint — v13/v11 menolak untuk download file)
curl -s -H "Authorization: Bearer $VERCEL_TOKEN" \
  "https://api.vercel.com/v8/deployments/$DEP/files/$UID"
# respons = {"data":"<base64>"}; decode base64, cari symbol OpenRouter:
#   _openrouter_completion, _plain_fallback, OPENROUTER_MODEL, thinkingmachines/inkling
```

> **Jebakan API Vercel:**
> - List file tree: `/v11/deployments/$DEP/files` → JSON tree rekursif rekursif.
> - Download file: `/v8/deployments/$DEP/files/$UID` → response **`{"data":"<base64>"}`**
>   (base64-decode) — v11/v13 menolak ("Invalid API version"); v6/v4 disabled.
> - Variabel bash `UID` **readonly** — pakai nama variabel lain (mis. `FID`).

## Peringatan keamanan

- Token `vcp_...` punya akses **penuh** project — jangan bocor. Env `OPENROUTER_API_KEY`,
  `OPENROUTER_MODEL`, `GROQ_API_KEY` dsb. berada di project Vercel; value terenkripsi
  (tidak bisa di-decrypt via API tanpa izin khusus).
- Repo GitHub punya GitHub Action `deploy.yml` (CF Worker) yang butuh secret `CF_API_TOKEN`.
  Untuk deploy CF, token di-IP-filter di runner GitHub; untuk keperluan API langsung dari
  IP berubah-ubah lebih aman tambah `CF_ACCOUNT_ID`. Verisi terkini `deploy.yml` tidak
  dibutuhkan untuk Vercel.
- Jangan jadikan repo main source deploy Vercel (lihat peringatan atas). Jika ingin
  menyinkronkan ke git, buat branch khusus (mis. `vercel-live`) dan commit source live saja
  — bukan seluruh repo.
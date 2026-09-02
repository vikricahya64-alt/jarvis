# Level 7 — Setup & Hardware Safety Guide: Sovereign Self-Evolving System

Dokumen ini memandu pemasangan Level 6/7: **Oracle Cloud Always Free** (private
edge), **Tailscale** mesh, **offloaded model evolution** (Colab/Kaggle), serta
**kalibrasi guardrail termal Helio G85**. Sangat patuh pada constraint utama:

> **Realme C25s (Helio G85, 4GB) TIDAK PERNAH menjalankan model berat.**
> Ponsel hanyalah *Sovereign Terminal* — enkripsi, routing, klasifikasi ringan,
> dan I/O aman. Semua inferensi medium-berat → Oracle edge; pelatihan → GPU
> cloud (Colab/Kaggle T4); ponsel hanya Qwen2.5-1.5B-Instruct-Q4_K_M (1024 ctx).

Tangga routing (prioritas tertinggi → rendah):
```
groq cloud (publik)  >  oracle private edge (ARM 4×/24GB)  >  local terminal (Qwen-1.5B)
```

---

## 1. Database: jalankan skema Level 7

Buka **Supabase → SQL Editor** → tempel seluruh isi `sql/level7_schema.sql` →
**Run**. Ini membuat (idempotent, aman dijalankan ulang):

| Tabel | Fungsi |
|-------|--------|
| `self_repair_log` | riwayat perbaikan diri (patch/diff/PR, status, attempts, blocked) |
| `model_adapters` | registry adapter QLoRA (target oracle/phone, sha256, rollback) |
| `replica_registry` | buku besar replika sovereign + identitas PGP unik |
| `genetic_archive` | snapshot DNA permanen di IPFS (CID + sha256 + manifest) |
| `meta_audit_log` | audit meta-kognitif mingguan (immutable) |
| `device_health_metrics` | time-series suhu/RAM/routing/latensi terminal |

Semua RLS menghormati `get_telegram_id()` dan service_role penuh (backend).

---

## 2. Private Cloud Edge — Oracle Cloud Always Free (ARM Ampere, 24GB)

Jalankan **Qwen2.5-7B-Instruct** (atau Llama-3.1-8B) via Ollama; masukkan ke
mesh Tailscale; ekspos HTTPS ke Vercel lewat **Nginx TLS**.

### 2.1 Buat instance ARM
1. Oracle Cloud → **Create VM instance** → **Shape** → `VM.Standard.A1.Flex`
   (ARM Ampere, 4 OCPU / **24 GB RAM** — always-free) → Ubuntu Server 22.04.
2. Dongkrak security list: buka TCP **22** (SSH), **443** (HTTPS), **11434**
   (Ollama, hanya via Tailscale, jangan ekspos publik tanpa auth).
3. SSH masuk.

### 2.2 Docker + Ollama + model
```bash
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER && newgrp docker
docker run -d --name ollama --restart unless-stopped -p 11434:11434 \
  -v ollama:/root/.ollama ollama/ollama
docker exec ollama ollama pull qwen2.5:7b-instruct
docker exec ollama ollama pull qwen2.5:1.5b-instruct
```

### 2.3 Nginx reverse proxy + TLS (untuk Vercel → edge)
Buat `ollama` alias OpenAI-compatible `/v1/chat/completions`:
```nginx
server {
    listen 443 ssl;
    server_name edge.local;
    ssl_certificate     /etc/letsencrypt/live/.../fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/.../privkey.pem;

    # Kunci hanya untuk Vercel (JARVIS_EDGE_AUTH — secret dari env).
    location /v1/chat/completions {
        if ($http_authorization != "Bearer ${EDGE_AUTH}") { return 401; }
        proxy_pass http://127.0.0.1:11434/v1/chat/completions;
        proxy_set_header Host $host;
    }
    location /health { return 200 "ok"; }
}
```
Arahkan DNS/subdomain publik ke IP Oracle. Di Vercel set env:
```
JARVIS_EDGE_URL = https://<subdomain>        # public HTTPS (Nginx)
JARVIS_EDGE_MODEL = qwen2.5:7b-instruct
JARVIS_EDGE_AUTH = <secret>                  # = Bearer token di Nginx
```

### 2.4 Tailscale (mesh ponsel ↔ Oracle ↔ laptop)
```bash
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up --advertise-routes=192.168.0.0/24   # subnet router (opsional)
sudo tailscale up                                      # atau tanpa advertise
tailscale status   # catat IP 100.x untuk ponsel
```

### 2.5 Bootstrap otomatis (disarankan)

Daripada manual, jalankan sekali pada instance **Ubuntu 22.04/24.04** baru
(sebagai sudo) untuk mengotomatiskan 2.2–2.4 sekaligus: Docker + Ollama +
model, Nginx TLS + Let's Encrypt, Tailscale, dan mencetak lembar env Vercel:

```bash
chmod +x scripts/bootstrap_oracle_edge.sh        # sudah +x di repo
EDGE_DOMAIN=edge.example.com \                    # DNS -> IP instance
EDGE_EMAIL=you@example.com \
EDGE_AUTH="$(openssl rand -hex 32)" \
sudo -E ./scripts/bootstrap_oracle_edge.sh
```

Yang dilakukan skrip:
1. Docker + compose + certbot + Nginx + UFW (buka hanya **22/tcp, 443/tcp**).
2. Jalankan **Ollama** terikat `127.0.0.1:11434` (tidak ekspos publik) & pull
   `qwen2.5:7b-instruct`.
3. Susun **Nginx** dengan TLS Let's Encrypt; `/v1/chat/completions` hanya
   boleh diakses dengan header `Authorization: Bearer ${EDGE_AUTH}`; `/health`
   publik.
4. **Tailscale** up (paste auth key bila diminta).
5. Simpan kredensial ke `/root/.edge-credentials` (0600) dan **cetak**:
   - `JARVIS_EDGE_URL`    → `https://<domain>`
   - `JARVIS_EDGE_MODEL`  → `qwen2.5:7b-instruct`
   - `JARVIS_EDGE_AUTH`   → token rahasia
   - contoh `curl` validasi.

Uji lokal dulu:
```bash
curl https://<domain>/health
curl -s https://<domain>/v1/chat/completions \
  -H "Authorization: Bearer <EDGE_AUTH>" \
  -H "Content-Type: application/json" \
  -d '{"model":"qwen2.5:7b-instruct","messages":[{"role":"user","content":"halo"}]}'
```

Setelah `curl` sukses, set ketiganya di Vercel Production & redeploy:
```bash
vercel env add JARVIS_EDGE_URL    production   # https://<domain>
vercel env add JARVIS_EDGE_MODEL  production   # qwen2.5:7b-instruct
vercel env add JARVIS_EDGE_AUTH   production   # token rahasia
vercel deploy --prod --yes
```

Lalu pastikan ladder aktif via health:
```bash
curl -s -X POST https://jarvis-sigma-navy.vercel.app/api/simulator_proxy \
  -H 'Content-Type: application/json' -d '{"mode":"private_edge","__health":true}'
# harap:  "oracle_edge": "up"   (bukan "down")
```

### 2.6 Alternatif: edge Qwen di Colab T4 (tanpa kartu, tanpa Oracle)

Jika Oracle tidak tersedia (butuh verifikasi kartu), gunakan **Colab free T4 GPU**
sebagai edge privat — konsisten dengan filosofi L7 "offload model ke GPU cloud".
Buka `scripts/colab_qwen_edge.ipynb` di Colab:

1. **Runtime → Change runtime type → T4 GPU**.
2. Jalankan sel 1→2: install Ollama & `ollama pull mariojnick/qwen2.5:7b-instruct-q4_k_m`.
3. Sel 3: paste **ngrok authtoken free** (tanpa kartu) → mencetak `JARVIS_EDGE_URL`
   (mis. `https://abcd-123.ngrok-free.app`).
4. Sel 4: smoke test `/health` + `/v1/chat/completions`.
5. Set di Vercel Production, lalu redeploy:
   ```bash
   vercel env add JARVIS_EDGE_URL   production   # https://xxxx.ngrok-free.app
   vercel env add JARVIS_EDGE_MODEL production   # mariojnick/qwen2.5:7b-instruct-q4_k_m
   vercel env add JARVIS_EDGE_AUTH  production   # token ngrok/atau apa pun (lihat catatan)
   vercel deploy --prod --yes
   ```

**⚠️ Catatan keamanan jalur Colab/ngrok:**
- Ollama **tidak** memvalidasi `Authorization`; `JARVIS_EDGE_AUTH` dikirim tapi
  diabaikan di sisi Colab. Artinya URL ngrok = publik & tanpa proteksi selama
  runtime Colab aktif.
- Jaga: jangan kirim data sensitif via edge ini, dan **putus tunnel** (stop
  runtime / cell keep-alive) begitu selesai. Untuk produksi privat sejati
  tetap arahkan ke Oracle (bagian 2.5) yang berlaku proxy auth.
- Colab berhenti setelah beberapa jam idle → `JARVIS_EDGE_URL` mati; health akan
  kembali `"oracle_edge": "down"`, dan system otomatis pakai **Groq fallback**.

---

## 3. Sovereign Terminal (Realme C25s) — sudah di kode

`utils/sovereign_terminal.py` + `utils/local_inference.py` menyediakan:
- `should_run_local()` — guardrail keras: **CPU temp > 40°C** ATAU **RAM > 85%**
  → tolak inferensi lokal, auto-failover ke Oracle/cloud.
- `encrypt_outgoing()/decrypt_incoming()` — AES-256-GCM tiap payload keluar.
- `store_pii()/retrieve_pii()` — SQLCipher lokal, PII **tidak pernah** keluar.
- `tailscale_status()/private_edge_reachable()` — konektivitas mesh.
- `route_decision()` — keputusan rute terkini untuk `/device_health`.

Pemasangan di Termux (lihat `device/setup_termux.sh`):
1. Salin repo via `git clone` di Termux.
2. `bash device/setup_termux.sh`.
3. Isi `~/.jarvis.env`: `DEVICE_SHARED_SECRET`, `JARVIS_EDGE_IP` (Oracle 100.x),
   `LLAMA_CLI`/`MLC_CLI` menuju binari Qwen2.5-1.5B-Q4_K_M.
4. `python device/monitor_g85.py`.

> ⚠️ **DEPRECATED (Level 11):** Jalur on-device `device/setup_termux.sh` dan
> `device/monitor_g85.py` **telah dihapus** (folder `device/` tidak lagi ada).
> Setup Termux on-device dinilai membebani perangkat; DMS + pemrosesan pesan kini
> ditangani Cloudflare D1 worker + Groq (lihat `cf/`). Blok di bawah adalah arsip
> arsitektur L7 asli.

> Engine lokal hanya Qwen2.5-1.5B-...-Q4_K_M, `MAX_CONTEXT_TOKENS=1024`,
> `-ngl 0` (CPU), 4 thread. Lihat `utils/local_inference.py`.

---

## 4. Offloaded Model Evolution (Colab/Kaggle T4)

Pelatihan **hanya** di GPU cloud:

1. Buka `scripts/colab_finetune_qlora.ipynb` di Colab → *Runtime → Change
   runtime type → T4 GPU*.
2. Unggah **dataset terenkripsi** dari ponsel (AES-256-GCM via
   `encrypt_outgoing`), simpan di `data/dataset.json.enc`, set `DATASET_KEY`.
3. Run notebook: Unsloth + QLoRA (4-bit), validasi holdout (`loss_valid`),
   export adapter `.safetensors` + SHA-256.
4. Deploy adapter:

```bash
scripts/sync_adapter_to_edge.sh \
    --adapter ./adapter-<name> \
    --target oracle \
    --host <oracle-tailscale-ip> \
    --user ubuntu
```

Script: transfer via **rsync over Tailscale SSH** → verifikasi SHA-256 local &
remote → daftar di `model_adapters` → **hot-swap Ollama tanpa restart** +
simpan tag rollback (`<name>:rollback`).

---

## 5. Level 7 Telegram Commands

| Perintah | Aksi |
|----------|------|
| `/device_health` | suhu/RAM/mode routing + engine lokal (+ rekam metrik) |
| `/train_model` | picu Colab fine-tuning (T4), daftarkan adapter |
| `/replicate <ip>` | replikasi sovereign ke node (rsync Tailscale + PGP unik) |
| `/replicate_list` | daftar replika |
| `/dna_archive` | buat snapshot DNA & unggah ke IPFS (Pinata) |
| `/dna` | tampilkan CID + instruksi pemulihan |
| `/audit_report` | self-analysis mingguan (low auto-fix / high review) |
| `/repair_status` | antrian perbaikan diri |
| `/pause_evolution` | **stop darurat** semua auto-fix |
| `/reject_patch` | override manusia: tolak patch self-repair |

---

## 6. Kalibrasi Guardrail Termal (Helio G85)

`utils/sovereign_terminal.py` default: **TEMP_LIMIT_C = 40.0**, **RAM_LIMIT_PCT = 85.0**.
Kalibrasi tanpa mengubah kode — lewat env `JARVIS_TEMP_THROTTLE_C` (dipakai
`device/monitor_g85.py`) dan argumen `should_run_local(temp_limit=..., ram_limit=...)`.

Cara mengukur titik aman nyata:
```bash
# baca suhu zona CPU + baterai (helloe G85/Unisoc T610)
cat /sys/class/thermal/thermal_zone0/temp      # /10 -> °C
cat /sys/class/power_supply/battery/temp
cat /proc/meminfo | grep MemTotal
```
Saat stress-test (mis. inferensi):
```bash
cat /sys/class/thermal/thermal_zone0/temp > /tmp/t.log
```
- Jika idle ~35-38°C, naikkan ambang ke **42°C** hanya jika uji menunjukkan
  aman; jangan pernah di atas **45°C** di ponsel ini.
- Jika selalu > 40°C saat idle, ponsel tersumbat/panas → tetapkan `reason
  temp_too_high` permanent, dan seluruh inferensi diarahkan ke Oracle.

Skenario failover yang dijamin kode:
```
CPU > 40°C  -> refuse local -> route to oracle
RAM > 85%   -> refuse local -> route to cloud
metrics None-> refuse local -> route away (protect phone)
oracle down -> collapse to groq cloud
```

---

## 7. Disaster Recovery (dari CID IPFS)

1. Ambil arsip dari gateway:
   ```
   curl -L -o genome.bin https://gateway.pinata.cloud/ipfs/<CID>
   ```
2. Verifikasi integritas (harus sama dengan SHA-256 yang tercatat, lihat `/dna`):
   ```bash
   sha256sum genome.bin
   ```
3. (Opsional) dekompresi `genome.bin` (gzip) untuk baca manifest kode/model.
4. Di node/ponsel baru: buka manual ID → jalankan `:git clone` dari repo →
   restore `~/.jarvis.env` (secret) → jalankan `monitor_g85.py`.
5. Rebuild replika: `/replicate <ip>`, lalu `/dna_archive` untuk menanam versi
   baru DNA.

> Manifest DNA hanya memuat **hash** kode/model + bentuk preferensi — **tidak
> ada log, PII, atau sekret**. Pemulihan penuh butuh secret yang disimpan
> terpisah oleh pemilik.

---

## 8. Uji Keamanan Perangkat (test suite)

`tests/test_level7.py` (17 tes) menguji guardrail, cap konteks, bundle
replikator (tanpa secrets/log/PII), blocklist self-repair, manifest DNA, dan
kebijakan pause/risk meta-kognisi. Jalankan:

```bash
python3 tests/test_level7.py     # atau python -m pytest tests/test_level7.py
```

Constraint keamanan yang diuji **keras** (`test_self_repair_blocks_security_modules`):
self-repair TIDAK PERNAH menyentuh `data_sovereignty`, `device_comm`,
`authz`, `vault`, `sovereign_terminal`, `hybrid_router`, `webhook`,
`supabase_client`, `oauth2`, `telegram`.

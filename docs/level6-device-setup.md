# Level 6 — Setup & Troubleshooting: Realme C25s (Sovereign Local Core)

Dokumen ini memandu pemasangan inti lokal J.A.R.V.I.S. di perangkat **Realme C25s**
(SoC Unisoc T610 "G85", RAM 4GB, penyimpanan 64GB/128GB eMMC) yang berada di belakang
NAT seluler. Perangkat berperan sebagai *sovereign local core*: mengerjakan tugas
lokal, tapi dikontrol & diaudit dari cloud.

Ringkasan arsitektur (Level 6 Hybrid Edge-Cloud):

```
[Telegram] ⇄ [Vercel cloud core] ⇄ [Supabase: routing_log/residency/device_queue/device_status]
                  ▲  up only (NAT)    │
                  └───── [Realme C25s Termux poller]  (monitor_g85.py)
```

## Prasyarat
- Termux terinstal dari F-Droid (bukan Play Store — versi Play usang).
- Izin penyimpanan: `termux-setup-storage`.
- Python tersedia: `pkg install python`.

## 1. Persiapkan kredensial

Cloud & perangkat harus berbagi `DEVICE_SHARED_SECRET` (sudah di-set di Vercel
production). Buat template file secrets lalu isi manual — **jangan commit**:

```bash
cd <repo>/device
bash setup_termux.sh          # buat ~/.jarvis.env, install httpx, dll.
nano ~/.jarvis.env            # SET: DEVICE_SHARED_SECRET, JARVIS_TELEGRAM_ID
```

Isi minimal `~/.jarvis.env`:

```
DEVICE_SHARED_SECRET=<sama dengan di Vercel>
DEVICE_GATEWAY=https://jarvis-sigma-navy.vercel.app/api/device_gateway
DEVICE_MODEL=Qwen2.5-1.5B
JARVIS_TELEGRAM_ID=<chat_id Telegram Anda>
JARVIS_POLL_INTERVAL=30
JARVIS_TEMP_THROTTLE_C=55
MLC_LLM_BIN=/data/data/com.termux/files/home/.llm/mlc_llm_cli
```

> `JARVIS_TELEGRAM_ID` diisi angka chat ID Anda; di cloud gateway `telegram_id`
> dikirim sebagai `0` saat poll/push — sesuaikan kedua sisi bila diperlukan.

## 2. Jalankan poller

```bash
cd <repo>/device
python monitor_g85.py        # foreground; Ctrl-C untuk berhenti
```

Loop melakukan:
1. Baca suhu (thermal zone + baterai) & RAM, lalu **heartbeat** via `POST /poll`.
2. Kalau suhu ≥ `JARVIS_TEMP_THROTTLE_C` (default 55°C) atau RAM ≥ 92% → **skip
   inference** siklus itu (lindungi G85 dari panas/out-of-memory).
3. Long-poll `POST /poll` untuk mengambil task terenkripsi dari `device_queue`.
4. Saat ada task: decrypt → jalankan LLM lokal (Qwen2.5-1.5B) → encrypt hasil →
   `POST /push` → cloud kirim ke Telegram pengguna.

## 3. Instalasi LLM on-device (opsional, besar)

`monitor_g85.py` memakai **stub reply** bila MLC CLI tidak ditemukan — aman untuk uji
end-to-end sebelum mengunduh model besar. Untuk inferensi sungguhan:

```bash
INSTALL_LLM=yes bash setup_termux.sh
# lalu (sesuaikan ke build/arsitektur ARM T610):
mlc_llm convert_weight -q q4f16_1 -o ~/.llm HF://Qwen/Qwen2.5-1.5B-Instruct
```

Catatan: MLC LLM untuk ARM (T610) mungkin butuh wheel kustom. Lihat rilis MLC LLM
dan sesuaikan `MLC_LLM_BIN`. Jika terlalu berat untuk 4GB, alternatif: `llama.cpp`
dengan Qwen2.5-1.5B-Instruct-q4, atau biarkan stub (cloud Groq menangani inferensi,
perangkat hanya untuk tugas yang butuh `local_only`).

## 4. Otomatisasi (jalankan saat layar mati)

Termux bisa menahan proses saat layar mati bila:
- Aktifkan **wakelock** di Termux (icon kunci) untuk menjaga proses CPU berjalan.
- Atau daftarkan job via `termux-job-scheduler` / Termux:Boot agar poller start
  setelah reboot.

## Checklist Deployment (Level 6)

| Item | Status |
|------|--------|
| `sql/level6_schema.sql` dieksekusi (routing_log, residency, device_status, device_queue) | ✅ |
| `DEVICE_SHARED_SECRET` di env Vercel production | ✅ |
| Deploy Vercel sukses (≤ 12 fungsi, rewrites analytics/device) | ✅ |
| `/api/health` → 200 didukung | ✅ |
| `/api/analytics/sweep` (CRON_SECRET) → 200 | ✅ |
| `/api/device_gateway/poll` auth benar → 200, salah → 401 | ✅ |
| `cryptography` ada di `requirements.txt` (AES-GCM) | ✅ |
| `device/monitor_g85.py` import + metric OK | ✅ |
| Perangkat Realme C25s: `~/.jarvis.env` terisi | ☐ |
| End-to-end poll → infer → push → Telegram (dengan perangkat live) | ☐ |

---

## Troubleshooting FAQ

### Q: `/api/device_gateway/poll` mengembalikan 401 walau secret benar?
- Pastikan `DEVICE_SHARED_SECRET` **sudah ada di env Vercel production** dan
  deployment terbaru memuatnya (cek via dashboard, lalu `vercel deploy --prod`).
- Di perangkat, pastikan `~/.jarvis.env` berisi `DEVICE_SHARED_SECRET` persis sama
  (tidak ada spasi/enter aneh). Import `local_secrets` memakai env > file, jadi bila
  ada `DEVICE_SHARED_SECRET` di lingkungan Termux, itu yang dipakai.

### Q: `monitor_g85.py` tidak membaca suhu/RAM?
- Path thermal bervariasi per kernel. Cek manual:
  `ls /sys/class/thermal/` dan `cat /sys/class/thermal/thermal_zone0/temp`.
- `read_temp_c()`/`read_ram_pct()` mengembalikan `None` bila path tidak ada; poller
  tetap jalan (hanya tak dapat throttling berbasis suhu). Ini normal.

### Q: poll berhasil tapi tidak ada task — kenapa?
- Task hanya masuk `device_queue` bila webhook memutuskan rute **local** (mis.
  `/force_local`), dan hanya jika perangkat dianggap sehat (heartbeat ≤ 60 detik).
  Kalau perangkat baru hidup dan belum pernah poll, heartbeat kosong → cloud auto-rute
  ke cloud. Jalankan poller beberapa menit dulu, lalu tes `/force_local`.

### Q: Bagaimana memaksa satu pesan diproses di perangkat?
- Kirim perintah `/force_local <pesan>` di chat; webhook akan *enqueue* task tersandi
  ke `device_queue`. Perangkat meng-*poll*, mengeksekusi, dan mengirim balasan.

### Q: Hasil tidak sampai ke Telegram setelah push sukses?
- Gateway `complete_device_task` idempotent per `queue_id` — aman retry. Pastikan
  `JARVIS_TELEGRAM_ID` benar dan cloud berhasil `send_message`. Cek log Vercel
  (`vercel logs`).

### Q: Enkripsi gagal "MAC mismatch (tampered payload)"?
- Artinya secret berbeda antara cloud & perangkat, ATAU payload rusak di tengah
  jalan. Pastikan kedua sisi memakai `DEVICE_SHARED_SECRET` identik.

### Q: Perangkat panas / RAM penuh saat inferensi?
- `JARVIS_TEMP_THROTTLE_C` default 55°C dan ambang RAM 92% memotong inferensi.
  Turunkan ke 50°C bila perlu. Model Q4 (q4f16_1) lebih ringan; pertimbangkan
  `q4f16_1` vs `q4f32` untuk 4GB.

### Q: `cryptography` tidak terpasang di perangkat?
- `setup_termux.sh` menginstalnya opsional. Tanpa `cryptography`, `device_comm`
  memakai fallback PBKDF2+XOR (masih dengan HMAC integrity), jadi aman. Pasang via
  `pip install cryptography` bila ingin AES-GCM sungguhan.

---

## Keamanan & Privasi (Level 6)
- **Tidak ada PII mentah** di profil/evolution log; query RLS-respecting.
- **Cloud calls tidak pernah memuat PII yang tidak ter-redact** — `scan_and_redact()`
  di `utils/data_sovereignty.py` menyamar alamat email/NIK/kartu/telepon sebelum ke Groq.
- **Cross-platform** butuh consent per-service; **self-evolution** reversible 7 hari.
- Semua keputusan rute tercatat di `routing_log` + `data_residency_audit`.
- Secret hanya di env Vercel & `~/.jarvis.env` (mode 600), **tidak pernah di git/log/client**.

# Level 8 — Setup & Safety Guide: Hive Mind (Swarm + Perception + FL + Memory + Intuition)

Dokumen ini memandu pemasangan **Level 8 Hive Mind**: swarm MQTT-over-Tailscale,
persepsi fisik Realme sebagai sensor, federated learning privat, memory graph
temporal, dan intuition engine Bayesian. Tetap sangat patuh pada constraint inti:

> **Realme C25s (Helio G85, 4GB) TIDAK PERNAH memproses raw media berat.** Raw
> media dari kamera/mikrofon SELALU dibuat di tmpfs (RAM) lalu **dihapus aman**
> segera setelah analisis lokal. Raw media TIDAK PERNAH meninggalkan device.
> Komputasi menengah-berat di-offload ke Oracle/Colab edge.

Arsitektur ringkas:
```
Realme C25s (perception + sensor + memori lokal)
   │  enc. AES-256-GCM  │  MQTT-over-Tailscale / Supabase
   ▼
Oracle/Colab edge  <──>  Aggregator Federated (FedAvg, gradient terenkripsi)
   │  groq cloud (GPT-oss-20b) untuk entity/intuition
   ▼
Supabase (pgvector: memory_nodes/edges, swarm_registry, federated_rounds, intuition_log)
   ▼
Vercel (12 handler tetap; modul L8 = LIBRARY bukan handler)
```

---

## 1. Database: jalankan skema Level 8

Buka **Supabase → SQL Editor** → tempel seluruh isi `sql/level8_schema.sql` →
**Run**. Idempotent (aman dijalankan ulang). Membuat 5 tabel + 1 RPC + RLS:

| Tabel | Fungsi | Catatan keamanan |
|-------|--------|------------------|
| `memory_nodes` | entitas anonymized memory graph | `embedding vector(768)` + IVFFlat cosine; **entity anonymized, PII TIDAK di sini** |
| `memory_edges` | edge berbobot (relation, strength, last_seen) | traversal graph |
| `swarm_node_registry` | identitas peer + capabilities + heartbeat | di-mesh, no port publik |
| `federated_rounds` | provenance round FL | gradient TIDAK disimpan lama |
| `intuition_log` | riwayat intuisi + user_feedback + blocked | audit guardrail |

RPC `search_memory_nodes(p_telegram_id, p_embedding vector(768), p_limit)`
menjalankan similarity cosine via pgvector. Semua RLS menghormati
`get_telegram_id()` + service_role penuh (backend).

> **Siapkan embedding:** free tier tidak punya API embedding — Level 8 memakai
> `utils/memory_graph.embed_text()` (hash n-gram deterministik, 768-d,
> L2-normalized) agar pgvector cosine bermakna **offline & gratis**. Dimensi
> sengaja sama persis dengan `vector(768)` di skema.

---

## 2. Enkripsi & Secret (wajib)

Level 8 memakai `DEVICE_SHARED_SECRET` (sudah ada) untuk AES-256-GCM seal
payload MQTT & gradient federated:

- Set di Vercel: `DEVICE_SHARED_SECRET=…`
- Semua util menolak beroperasi tanpa secret (kecuali fallback v=0 yang akan
  di-`block` untuk gradient — lihat `swarm_coordinator`/`federated_client`).
- Jangan pernah tulis secret ke git/log. Gradien `blocked` (tidak dikirim) bila
  crypto tidak tersedia di node → lebih aman gagal daripada mengirim plaintext.

---

## 3. Orchestrasi Swarm (utils/swarm_coordinator.py)

Library sinkron (bukan handler → count handler tetap 12). Bagian:

- **MQTT broker** hanya via Tailscale IP (tanpa port publik). Env:
  `SWARM_MQTT_HOST` (IP tailnet), `SWARM_MQTT_PORT` (default 1883/8883 TLS),
  `SWARM_MQTT_USER/PASS`, `SWARM_HEARTBEAT_S`, `SWARM_QUEUE_FILE`,
  `SWARM_QUEUE_MAX`.
- **Envelope terenkripsi**: metadata (kind/device/role/ts) plaintext ringan;
  **payload AES-256-GCM (v=1)**; fallback v=0 (SHA256 tanpa enkripsi) hanya
  untuk penggunaan tanpa crypto, dan gradient/raw **diblokir** di v=0.
- **Offline durable queue**: pesan di-queue ke file jsonl bila broker
  unreachable, di-replay (`drain_queue`) saat reconnect — synth `/scan`,
  sensor tak hilang di jaringan terputus.
- Verifikasi: roundtrip crypto + tamper detection + healthy/stale (recent < 2x
  heartbeat interval) sudah diuji.

### Kuota MQTT keberangkatan (command)
- `/swarm_status` — daftar node via `list_swarm_nodes` + `swarm_summary`.
- `/pause_swarm` — emergency pause seluruh publish.

---

## 4. Persepsi Fisik (utils/physical_perception.py + Realme)

Realme membaca lingkungan, **tanpa raw media keluar device**:

| Command | Pipeline | Raw dihapus |
|---------|----------|-------------|
| `/scan document` | `termux-camera-photo` → Groq Vision (`vision(b64)`) → OCR/deskripsi | ya (`_delete_secure`) |
| `/scan meeting` | `termux-microphone-record` → Whisper (`transcribe(b64)`) → ringkasan+action items | ya |
| `/scan qr` | decode zbar/pyzbar → swarm lookup | ya |

- Semua raw file dibuat **di tmpfs** (`$JARVIS_SENSOR_TMPFS`, default
  `/dev/shm/jarvis-sensor`) supaya tidak membakar disk eMMC & memudahkan buka.
- `_delete_secure`: overwrite 1MB + unlink + rmtree — jaminan hapus di `finally`.
- Output enkripsi: `dispatch_scan` merge dengan dict hasil via `_seal` (AES-GCM)
  sebelum dikirim — hanya hasil, bukan media.
- **Guardrail domain**: `capture_document(domain=health|finance|identity|
  relationship)` → diblokir (`sensitive_domain_blocked`). Set `JARVIS_SENSOR_TMPFS`.
- `/clear_sensors`: vacuum tmpfs aman.

### Izin Termux
```
termux-setup-storage
pkg install termux-api python
termux-camera-photo  # minta izin kamera sekali
# mikrofon: termux-microphone-record (izin rekaman)
python -m pip install groq cryptography Pillow pyzbar
```

> **Aturan keras**: fles media selalu di `finally:_delete_secure`; jangan pernah
> menjalankan model text besar di Realme — offload langsung di groq_client.

---

## 5. Federated Learning Privat (scripts/federated_*.py + Flower)

**Kontrak keamanan agregat**: aggregator **tidak pernah** melihat raw data;
hanya gradien terenkripsi.

- **Client** `scripts/federated_client.py` (jalankan di Oracle/Colab; ponsel
  hanya fragmen 1.5B):
  `python scripts/federated_client.py --node g85-01 --round 7 --epochs 1 --out ./fed_out`
  → memuat dataset lokal (SQLCipher Vault, tak pernah dikirim), train LoRA
  lokal, **`seal_delta` AES-256-GCM**, tulis `delta.json + meta.json`
  (hash sha256). Domain sensitif → `blocked`, **tidak dikirim**.
- **Aggregator** `scripts/federated_aggregator.py`:
  `python scripts/federated_aggregator.py --round 7 --deltas ./fed_out/delta.json --holdout-score 0.912`
  → verifikasi auth-tag GCM + sha256 → FedAvg hanya pada delta valid → catat
  provenance ke `federated_rounds` (provenance optional, dipakai bila
  SUPABASE_URL/KEY tersedia), gradient tidak disimpan lama.
- Gradien didekripsi **hanya di memori** untuk langkah FedAvg, lalu dibuang.
- `/federate_status` — lihat round terkini.

> Ponsel = **thin sensor**, bukan pelatih besar. Round yang butuh non-trivial
> fan-out disarankan berjalan di node Oracle/Colab. Holdout score external
> dimasukkan sebagai validation_score di Supabase.

---

## 6. Memory Graph Temporal (utils/memory_graph.py)

- **Store**: `/memory` → conversation → `extract_entities` (Groq json) +
  `extract_relations` (co-occurrence) → `store_conversation`: upsert node (
  `embed_text` 768-d) + reinforce edge (`add_memory_edge` strength decay
  rules). **Entity anonymized; PII tidak masuk graph.**
- **Query**: `/memory <query>` → `query_memory`: embed query → `search_memory`
  (pgvector cosine) → `get_memory_neighbors` (traversal edge) → `decay`
  (exponential half-life 30h → text block untuk orchestrator,
  `memory_context_block`).
- **Privasi**: graph node pakai label anonymized (`concept_<hash>`/`user_*`).
  Data pribadi kaya lain tetap di SQLCipher/Vault.

---

## 7. Intuition Engine Bayesian (utils/intuition_engine.py)

- **Prior**: Beta(alpha, beta) dari riwayat feedback per-domain
  (`intuition_feedback_prior`). Default uninformative Beta(1,1).
- **Posterior**: gabung evidence lokal (keyword+recency, domain-aware) + prior.
- **Firing rule**: HANYA `fired=True` bila posterior > `INTUITION_CONFIDENCE_THRESHOLD`
  (default 0.85) **DAN** impact == high. Sisanya ditekan.
- **Guardrail keras**: `health|finance|relationship|identity` diblokir default
  (`blocked=True` di `intuition_log` → bukti guardrail). Tambahan via
  `/disable_intuition <domain>`.
- **Feedback loop**: `/intuition` hasil → user menandai → `apply_feedback`
  memperbarui prior berikutnya.
- **Safety override**: `/reset_intuition` → `reset_intuition()` menghapus
  history domain (kembali Beta(1,1)).

---

## 8. Deploy & Test

```
vercel deploy --prod
```
- Handler count **tetap 12** — semua modul L8 adalah library.
- Test: `tests/test_level8.py` (lihat langkah akhir refactor) mencakup:
  sensor tmpfs delete, intuition guardrail/confidence, swarm crypto tamper,
  memory graph decay, embedding determinism.

---

## 9. Checklist Peluncuran

- [ ] `sql/level8_schema.sql` ter-apply di Supabase SQL Editor
- [ ] `DEVICE_SHARED_SECRET` ada di Vercel
- [ ] Tailscale mesh aktif; MQTT broker hanya di IP tailnet
- [ ] termux-api + izin kamera/mikrofon di Realme
- [ ] federated_client/aggregator diuji round-trip di Oracle/Colab
- [ ] `/swarm_status`, `/scan`, `/federate_status`, `/memory`, `/intuition`,
      `/pause_swarm` merespon live
- [ ] 12/12 handler, semua test lulus, deploy ke production alias
# Level 4 — Cognitive Orchestrator (Swarm, Deep Reasoning, Hybrid RAG, Multimodal)

Mengupgrade J.A.R.V.I.S. dari agen tunggal menjadi **Cognitive Orchestrator**:
swarm multi-agent (researcher / coder / reviewer / writer) berbasis antrian
database, deep-reasoning loop di E2B, hybrid RAG dengan metadata filtering,
jembatan multimodal Telegram, serta observability/self-healing — semuanya di
jalur **free tier**.

> Semua modul baru **sinkron** secara sengaja. Vercel serverless menolak
> asyncio.run() berulang (EBUSY) dalam satu handler — pola ini sudah
> terdokumentasi di `api/webhook.py`, `utils/deep_reasoning.py`, dan
> `api/swarm_coordinator.py`. Alur request tetap dalam satu fungsi compute
> 60 detik (Hobby).

---

## 1. Prasyarat (Sudah Ada dari Level 3)

- Vercel Hobby (maxDuration 60s), Groq, Supabase, E2B, GitHub Actions.
- `utils/vision.py` (qwen/qwen3.6-27b), `utils/audio.py`
  (whisper-large-v3-turbo), `utils/download.py`, `utils/documents.py`.
- Worker PENDING via `api/cron.py` + GitHub Actions 15 menit.

---

## 2. Migrasi Database (HARUS dijalankan manual)

Sebelum pengujian, jalankan **`sql/level4_schema.sql`** di Supabase SQL Editor.
Tidak bisa dieksekusi otomatis (pg-meta endpoint Supabase mengembalikan 404;
butuh management token / dashboard).

Yang ditambahkan:

| Objek | Isi |
|---|---|
| `tasks` | `+ parent_task_id UUID REFERENCES tasks(id)`, `+ agent_type CHECK(...)`, `+ retry_count INT DEFAULT 0`, index `parent_task_id`, `agent_type` |
| `chat_history` | `+ metadata JSONB`, `+ content_tsv tsvector GENERATED`, GIN index |
| `documents` | `+ metadata JSONB` |
| RPC `match_chat_history_hybrid` | `1.0*word_similarity + 1.0*ts_rank + opt. 1.0*vector cosine`, filter metadata, ORDER BY score |
| view `v_active_tasks` | parent PENDING/PROCESSING + jumlah child aktif |
| RLS | policy `tasks` & `chat_history` via `get_telegram_id()`; GRANT service_role |

> **Legacy mode:** jika migrasi belum dijalankan, kode berjalan aman
> (graceful): `insert_child_task` / kolom `agent_type` / `metadata` akan
> gagal 400 dan di-*fallback*, orchestrator lama tetap dipakai untuk task
> tunggal. Sebaiknya migrate dulu sebelum menguji swarm.

---

## 3. Komponen Baru

```
api/agents/__init__.py      kontrak agent: run() -> {"success","result","error","tool_names"}
api/agents/researcher.py    riset/sumber, evidence-based, bahasa Indonesia
api/agents/coder.py         deep-reasoning loop (E2B), fallback kode lokal
api/agents/reviewer.py      quality gate PASS/REVISE/FAIL
api/agents/writer.py        format final + preferensi pengguna (learning_loop)
api/swarm_coordinator.py    decompose -> jalankan child -> reviewer gate ->
                            retry (max 2) -> escalate -> aggregate (writer);
                            endpoint POST /api/swarm-coordinator (parent/child/tunggal)
api/webhook_multimodal.py   jembatan photo/voice/audio/document: rate-limit
                            5 req/menit, size <=10MB, vision/whisper/ekstraksi,
                            store ke knowledge-base + routing swarm/orchestrator
utils/deep_reasoning.py     think-code-execute-evaluate; watchdog 30s; envelope
                            E2B (6/menit, 40/hari); graceful degradation
utils/groq_client.py        +tool `deep_reason`; +`plain_completion()` (planner/
                            reviewer/writer/evaluator tanpa tool)
utils/supabase_client.py    +insert_child_task; +insert_task(agent/agent_type);
                            claim_next_pending(skip agent rows); +include_agents
```

---

## 4. Variabel Lingkungan Baru (opsional, punya default)

| Var | Default | Fungsi |
|---|---|---|
| `SWARM_ENABLED` | `0` | `1` untuk mengaktifkan routing ke swarm untuk permintaan analitis |
| `MULTIMODAL_RPM` | `5` | rate-limit media per menit per chat |
| `MULTIMODAL_MAX_BYTES` | `10485760` | batas ukuran media (10 MB) |
| `E2B_RUN_TIMEOUT_S` | `30` | timeout eksekusi sandbox (watchdog) |
| `DEEP_REASON_MAX_ITERS` | `3` | iterasi loop deep reasoning |
| `E2B_MAX_PER_MINUTE` | `6` | envelope E2B / menit |
| `E2B_MAX_PER_DAY` | `40` | envelope E2B / hari |

---

## 5. Logging Tanpa Secret

Semua modul baru mencatat **id + langkah + outcome** saja — tidak pernah
membuang token, kunci, atau isi pribadi ke log. Contoh polanya di
`swarm_coordinator._structured_log()`.

---

## 6. Pengujian per Komponen

### a) Deep Reasoning
```
# tanpa E2B key -> graceful degradation, tidak crash
python -c "from utils.deep_reasoning import deep_reason; print(deep_reason('hitung 2+2'))"
# pastikan balasan 'E2B tidak tersedia ... jalankan lokal'
```

### b) Swarm planner (murni, tanpa jaringan)
```
python -c "
from api.swarm_coordinator import _parse_subtasks, should_swarm
print(_parse_subtasks('[{\"agent_type\":\"researcher\",\"input\":\"riset X\"}]'))
print(should_swarm('analisis perbandingan pasar'))
"
```

### c) Jembatan multimodal (fungsi murni)
```
python -c "
from api.webhook_multimodal import _detect_media, _size_ok, _rate_limited
print(_detect_media({'photo':[{'file_size':1}]}))   # photo
print(_size_ok({'document':{'file_size':15000000}})) # False
"
```

### d) Reviewer verdict (murni)
```
python -c "
from api.agents.reviewer import _parse_verdict
print(_parse_verdict('{\"verdict\":\"pass\",\"issues\":[],\"improvement\":\"\"}'))
"
```

### e) Health (+swarm & E2B)
Ambilan `GET /api/health` kini menyertakan `swarm.active_children` dan
`e2b` (envelope). `?repair=1` reset PROCESSING macet.

---

## 7. Alur Kerja Skala Penuh

1. **Multimodal**: media masuk ke `api/webhook` → `_has_media` → dialihkan ke
   `webhook_multimodal.process_update`. Rate-limit + size-guard, lalu pipa
   vision/whisper/ekstraksi dokumen → teks → store knowledge-base (metadata)
   → `_enqueue_and_run`.
2. **Routing**: `SWARM_ENABLED=1` + teks mengandung kata analitis → parent task
   ke coordinator; selain itu orchestrator tunggal (Level 3).
3. **Swarm parent**: Groq planner `decompose_task` → child rows
   (`parent_task_id` + `agent_type`) → tiap child dijalankan inline dengan
   budget Groq bersama, `reviewer` menilai, retry max 2, escalation ke user,
   `writer` menggabung → parent DONE.
4. **Cron swarm** (`process_swarm_one`, `include_agents=True`): menjamin child
   yang tertinggal tetap diproses meski inline timeout.

---

## 8. Monitoring E2B / Observability

- `GET /api/health?full=1` — cek dependency + statistik task + envelope E2B.
- `usage()` dari `utils.deep_reasoning` — counter sandbox start/error,
  capaian per menit/hari.
- Workflow autonomy (GitHub Actions, 15 menit) memanggil `cron-trigger` →
  `cron` → `process_one` + `process_swarm_one`.

---

## 9. Debugging

- **Child tak pernah dijalankan**: pastikan `claim_next_pending()` default
  `include_agents=False` hanya mengambil root; cek `process_swarm_one` terpanggil
  (lihat log `Cron swarm result`).
- **400 pada insert child**: `sql/level4_schema.sql` belum dijalankan.
- **EBUSY / event loop**: ini by-design sinkron; jangan tambahkan
  `asyncio.run()` pada jalur request.
- **E2B kembali kode lokal**: ada di luar envelope / lib hilang — bukan error;
  hasil tetap sukses dengan catatan "jalankan lokal".
- **Sekutu (helper)**: `get_telegram_id()` RLS sudah ada di Vercel schema —
  jangan membuat ulang.

---

## 10. Ringkasan Keputusan

- **Sync bukan asyncio** pada semua jalur request (Vercel EBUSY).
- **Registry tool pusat** = `orchestrator._dispatch_tool` (termasuk
  `deep_reason`) — agent tidak memakai definisi tool sendiri.
- **Decomposition ke DB**: coordinator menulis child ke `tasks` dan menjalankan
  1 child inline; sisanya melalui cron/`claim_next_pending` (budget 60s).
- **Hybrid RAG tanpa embedding API**: `word_similarity` + `ts_rank` +
  optional cosine — gratis.
- **E2B graceful degradation**: tak pernah membunuh child; beri kode lokal.
- **Retry & escalation**: max 2 retry per child; gagal berulang → klarifikasi
  ke user.

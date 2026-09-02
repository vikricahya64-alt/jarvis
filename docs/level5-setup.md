# Level 5 — Sentient Ecosystem (Pattern Mining, Predictive, Emotions, Synthesis, Self-Evolution)

Mengupgrade J.A.R.V.I.S. dari **Cognitive Orchestrator** (Level 4) menjadi
**Sentient Ecosystem**: behavioral pattern mining, predictive trigger engine,
emotional context awareness, cross-platform synthesis, dan self-evolution
yang reversible — semuanya tetap **free tier** dan **privacy-respecting**.

> Tetap **sinkron** secara sengaja (Vercel serverless menolak asyncio.run ->
> EBUSY). Pola ini konsisten dengan `api/webhook.py`, `utils/deep_reasoning.py`,
> `api/swarm_coordinator.py`. Semua jalur request tetap dalam satu fungsi
> compute 60 detik (Hobby).

---

## 1. Prasyarat (Dari Level 4)

- Vercel Hobby, Groq `openai/gpt-oss-20b`, Supabase (Postgres + pgvector),
  E2B, GitHub Actions.
- `sql/level4_schema.sql` sudah dijalankan (swarm + hybrid RAG aktif).
- Private integrations (`utils/secure_tools`, OAuth via `/login`) opsional
  untuk synthesis.

---

## 2. Migrasi Database (HARUS manual)

Jalankan **`sql/level5_schema.sql`** di Supabase SQL Editor (idempotent).
Tidak bisa dieksekusi otomatis (pg-meta endpoint Supabase mengembalikan 404;
pola sama seperti Level 4).

Yang ditambahkan:

| Objek | Isi |
|---|---|
| `profiles` | `+ behavior_profile JSONB`, `+ emotional_trends JSONB`, `+ evolution_log JSONB`, `+ service_consent JSONB`, GIN index `behavior` & `consent` |
| tabel `synthesized_insights` | kartu insight (predictive/synthesis) + TTL `expires_at`; index owner & TTL |
| view `v_user_behavioral_patterns` | jendela 30 hari: `task_count`, `done_count`, `failed_count`, `child_agent_tasks`, `dominant_agent`, `input_start_chars`, `last_activity_at` |
| RLS | policy select/update/insert `synthesized_insights` + update `profiles` via `get_telegram_id()`; GRANT service_role |

> **Catatan view:** `tasks` TIDAK memiliki kolom `user_message` (dari spec
> level 5), jadi source behavior = `tasks.input` + `tasks.agent_type` +
> timestamp + agregat. Topic clustering bisa di-layer nanti lewat
> `chat_history.embedding`. Differential privacy: profil hanya menyimpan
> **agregat**, bukan teks mentah pesan.

---

## 3. Komponen Baru

```
utils/behavior_analyzer.py        baca v_user_behavioral_patterns -> Groq ->
                                  Behavior Profile (agregat) -> simpan
                                  get_or_update_profile / delete_profile
utils/emotional_context.py        sentiment/urgency/adaptation hint per pesan;
                                  safety valve (>=3 negatif/jam -> minimal
                                  interaction); tren anonymized memory
utils/self_evolution.py           deteksi deviasi vs baseline; klasifikasi
                                  risiko; auto-apply low-risk; rollback 7 hari;
                                  weekly digest
utils/cross_platform_synthesis.py ambil sinyal Gmail/Calendar/Notion/Drive
                                  (sesuai consent) -> Groq -> 1 kartu prioritas;
                                  TTL 7 hari; tombol "Act on this"/"Dismiss"
api/analytics/behavior.py         GET/POST profil perilaku (+ delete)
api/analytics/predict.py          predictive engine (context -> confidence ->
                                  intrusion filter -> backoff -> kartu)
api/analytics/sweep.py            cron: iterate user, predict/synthesis/cleanup
utils/commands.py                 + /privacy /profil /undo_evolution /evolution
                                  + callback pv:dismiss / syn:* 
api/swarm_coordinator.py          +inject nada emosional ke agen; +self-evolve
```

---

## 4. Privasi & Etika (Level 5)

- **Differential privacy**: hanya agregat/pattern disimpan di
  `profiles.behavior_profile` / `emotional_trends`; teks mentah tidak pernah
  masuk profil/evolution log.
- **Opt-in**: SEMUA fitur proaktif (predictive, synthesis, emotional,
  behavioral) dimatikan default. Aktifkan via `/privacy on <fitur>`. Perilaku
  default = hanya menjawab saat diminta.
- **Service consent terpisah**: `profiles.service_consent[:gmail|calendar|
  notion|drive]` — synthesis hanya membaca layanan yang diizinkan.
- **Anonimisasi emosi**: `emotional_trends` hanya menyimpan hitungan dalam
  jendela waktu, bukan isi pesan.
- **Safety valve**: jika pengguna menampakkan nada negatif/urgent berulang
  (>=3 dalam 1 jam), orchestrator beralih ke interaksi minimal.
- **Reversibilitas**: semua perubahan self-evolution tercatat di
  `evolution_log`; `/undo_evolution` membatalkan perubahan terakhir hingga
  7 hari. Digest mingguan lewat `/evolution` agar transparan.
- **Non-intrusive chunking**: kartu prediktif punya tombol Dismiss; 3
  dismiss dalam 24 jam -> backoff 24 jam.
- Semua endpoint analitik membutuhkan auth (CRON_SECRET untuk sweep/GitHub
  Actions; endpoint lain membaca `X-Telegram-Id` / body).

---

## 5. Alur Skala Penuh

1. **Pesan normal** (webhook): command diproses langsung (termasuk Level 5).
   Pesan baru dianalisa `emotional_context.analyze()` bila consent emosional
   aktif; coordinator menyuntik `adaptation_hint` ke agen.
2. **Self-evolution**: usulan preferensi low-risk auto-persist setelah
   signal konsisten; semua tercatat di evolution_log.
3. **Predictive** (cron 30 menit via `predictive-triggers.yml`): `sweep` ->
   `predict.run_predict` per user consenting -> intrusion filter -> backoff
   gate -> Groq -> kartu + Dismiss.
4. **Synthesis** (per user, konsisten dengan consent): ambil sinyal antar
   layanan -> 1 kartu prioritas -> Act/Dismiss, TTL 7 hari.
5. **Cleanup**: `sweep?mode=cleanup` menghapus `synthesized_insights` yang
   kedaluwarsa agar DB free-tier tetap ramping.

---

## 6. Pengujian per Komponen

```
# Kartu/parser murni tanpa jaringan
python -c "from api.analytics.predict import _intrusion_filter; print(_intrusion_filter({'calendar':[]}))"   # True (tanpa sinyal)
python -c "from utils.self_evolution import _classify_risk; print(_classify_risk('x','tone'))"              # high

# Analisis emosi (perlu GROQ_API_KEY untuk respons berisi)
GROQ_API_KEY=... python -c "
from utils import emotional_context
print(emotional_context.analyze(0, 'tolong segera selesaikan ini!'))"

# Endpoint
curl -s -X POST <host>/api/analytics/behavior -H 'Content-Type: application/json' \
  -d '{"telegram_id":123,"action":"refresh"}'
```

---

## 7. Deployment

```
vercel deploy --prod --yes
git add -A && git commit -m "level5: sentient ecosystem" && git push origin main
```

Pastikan sebaran env baru (jika ada) ada di Vercel. Sweep butuh `CRON_SECRET`
(GitHub secret, sudah ada dari Level 4).

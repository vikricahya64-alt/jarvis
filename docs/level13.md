# Level 13 — Reflective Apprentice (Belajar dari Pengalaman)

Status: **IMPLEMENTED** — self-improvement yang aman di free-tier (tanpa schema
self-modify, tanpa insight tanpa bukti, tetap di bawah kedaulatan pemilik).
Identitas: J.A.R.V.I.S. L12 adalah *steward* yang memegang kovenan immutable;
L13 mengangkatnya menjadi *pembelajar* yang merefleksikan outputnya,
mengonsolidasikan pengalaman menjadi pelajaran jangka panjang, beradaptasi pada
preferensi pemilik, dan mengantisipasi kebutuhan — semuanya append-only,
berbukti (evidence-warranted), dan bisa dimatikan pemilik.

## 6 Pilar

1. **Verbal Reflection** (bounded 1-ronde; Reflexion / Self-Refine) —
   setelah jawaban kompleks, model kritik menilai rubrik 1-5 + satu perbaikan;
   dicatat di `reflection_log`.
2. **Dreaming Consolidation** (Anthropic "Dreaming" / Mnemosyne BEAM) — cron
   `0 7 * * *`: Light (scan memori 24 jam) → REM (ekstrak 1 insight) →
   Deep (arsip memori lama tak-terpakai), dicatat di `dream_cycles`.
3. **Experiential Insight** (ExpeL) — `insights` = aturan umum yang **wajib**
   didukung ≥3 memori pendukung (phantom-safe).
4. **Proactive Sentinel** — briefing pagi *skip-if-nothing* (tanpa LLM jika
   tak ada yang layak; hindari kebisingan owner).
5. **Adaptive Preference Memory** (PAHF / evolving conditional memory) —
   `owner_preferences` dengan confidence scoring + TTL; set manual via
   `/set-preference` atau diinfer dari pola koreksi.
6. **Metacognitive Guardrails** — tabel append-only; agent **tidak pernah**
   mengubah schema/sistem-prompt sendiri; invalid insight dibuang; owner bisa
   disable insight/preferensi tanpa menghapusnya.

## Alur utama (wiring)

```
jawaban kompleks ─► searchAndSynthesize
   ├─ getBehaviorContext()  → sisipkan preferensi + insight aktif ke konteks LLM
   └─ reflectOnTurn()       → 1 ronde kritik → reflection_log (fire-and-forget)
cron "0 7 * * *" (baru, ke-4 dari 5)
   ├─ decayPreferences()    → confidence/kedaluwarsa preferensi
   ├─ runDreamCycle()       → konsolidasi → insights + arsip + dream_cycles
   └─ generateMorningBriefing() → skip-if-nothing → Telegram
```

## Perintah Telegram baru

`/reflect` · `/insights` · `/disable-insight <id>` · `/audit-phantom` ·
`/preferences` (alias `/prefs`) · `/set-preference <kunci> = <nilai>` ·
`/disable-preference <kunci>`

## Schema (migrasi `0007`)

```
reflection_log   id, created_at, turn_text, output, errors, critique,
                  refined, score, reflected        (append-only)
insights         id, rule_text, category, evidence_ids(JSON), evidence_count,
                  confidence, created_at, last_validated_at, disabled
owner_preferences key(PK), value, source(explicit|inferred), confidence,
                  evidence_count, last_validated_at, disabled, created_at, updated_at
dream_cycles     id, ran_at, memories_scanned, insights_extracted,
                  archived, briefing_sent, errors
memories (+2)    last_retrieved, access_count   (untuk konsolidasi/pruning)
```

## Batasan & kedaulatan

1. Insight/preferensi **append-only**; agent hanya INSERT; schema berubah HANYA
   lewat migrasi pemilik.
2. Insight wajib ≥3 bukti (`MIN_INSIGHT_EVIDENCE`) — tak ada phantom rule
   (lihat `auditPhantomRules`).
3. Refleksi di-fire-and-forget → tak menghambat balasan, tak memicu retry-storm.
4. `/pause` tetap menghentikan otonomi; preferensi/insight TIDAK menimpa
   perintah owner (hanya konteks sirip).
5. Cron naik 3→4 (tetap ≤5 free); `0 7` pakai cron-lock D1 yang ada.

## Verifikasi free-tier

- Semua D1 (no R2/Vectorize/DO/AI Gateway); 2 cron tersisa (5 total).
- Typecheck + safety test (termasuk `testLevel13Evolution`) + apply migrasi
  `0007` + deploy sukses; `/healthz` → 200.

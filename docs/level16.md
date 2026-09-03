# Level 16 — Predictive Steward

J.A.R.V.I.S. menjadi *anticipatory* tanpa menjadi *independen*: ia menawarkan
saran proaktif yang konkret dan read-only kepada pemilik, ditarik dari sinyal
yang sudah ia miliki (preferensi, insight, tugas terjadwal, proposal nilai yang
menunggu), **hanya sebagai tawaran teks**. Bertindak atas saran selalu keputusan
eksplisit pemilik. Origin gate (`predictive => DEFER`, tidak pernah auto-run)
dan guard konstitusional fail-closed tidak berubah — **tidak ada jalur eksekusi
baru**.

## Desain didorong riset (referensi)

| Temuan riset | Penerapan di Level 16 |
|---|---|
| CHI 2025 "Need Help? Designing Proactive AI Assistants" | Timing segalanya; bullet pendek > blok panjang → tawaran satu baris ringkas; digest pagi bukan interrupt per-peristiwa. |
| arXiv Proactive Agent / ProAgentBench (HOTL) | Untuk inisiatif tanpa perintah, hadirkan *suggestion* low-approval (tawaran), bukan eksekusi high-approval. |
| Zylos/IBM | Notification fatigue = failure mode #1 → **digest mode** (gabung briefing pagi cron `0 7`), bukan kirim terpisah; urgency scoring sebelum kirim. |
| Nudge/Zenodo | Alerting fatigue → skip-if-nothing; cap ketat. |
| arXiv "When Help Backfires" (2026) | *Offering* vs *providing*; bantuan unsolicited bisa terasa mengancam → sesedikit mungkin, selalu sebagai tawaran yang bisa ditolak. |
| ACM "Proactive, But Not Creepy" (2026) | Inisiatif diterima bila sah + **jelaskan pemicunya** + kontrol langsung saat menawarkan → setiap saran menyebut provenance (kategori) + `/suggestion accept|dismiss <id>`. |
| Google RecSys '23 "Learning from Negative User Feedback" | Sistem bertanggung jawab harus **belajar dari negative feedback dan mengurangi rekomendasi serupa dengan cepat** → dasar *feedback learning*. |
| Beirlant et al. 2025 "Beyond Explicit and Implicit" | *Dismiss* adalah explicit negative feedback paling andal; sistem harus merespons dengan mengurangi serupa. |
| Jawaheer et al. 2014 "Modeling User Preferences" | Feedback biner sederhana (accept vs dismiss) sudah cukup berguna → pendekatan ringan tanpa ML berat. |
| Grice's Maxims (Think Design 2026) | Jawaban harus *quality* (jangan mengarang, jujur soal ketidakpastian & sumber), *quantity* (cukup, tak berlebihan), *relevance*, *manner* (jelas) → instruksi grounding + ringkas terpusat di prompt JARVIS. |
| Grounding & Citations (Perplexity/FRAG, AI-Overview "11% klaim tak didukung") | Jawaban yang *grounded* dengan sumber yang terlihat meningkatkan trust → prompt wajib "nyatakan sumber/method-nya", saran menyebut provenance, writer mewajibkan sumber per sudut. |
| ScienceDirect 2025 / MDPI 2025 (personalisasi & referensi) | Jawaban kontekstual berdasar pengalaman & penghindaran "feature bloat" → personalisasi per-kategori & cap ketat (≤3). |
| Siemens / intent-modeling SLR (Springer 2024) | Explicit input → jawab cepat; implicit/tidak jelas → klarifikasi, jangan menebak → pipeline normalisasi + follow-up yang sudah ada. |
| FRAG / chatbot-UI fallback | Saat tak bisa menjawab, beri fallback yang jelas & berarah (hasil mentah / akui outage + saran coba lagi), bukan "maaf generik" → `testAnswerGrounding` menjaganya. |

## Komponen

- `src/lib/predictive.ts` — modul inti L16:
  - `gatherSuggestionCandidates(env, owner, alreadyOffered)` — deterministik, tanpa LLM;
    mengumpulkan kandidat dari 4 tipe sinyal, memberi skor **urgency 0..1**, lalu
    memfilter `>= URGENCY_THRESHOLD (0.5)`, mengurutkan menurun, dan memotong ke
    `MAX_OFFER_BATCH (3)`.
    - **approval** (proposal nilai belum divalidasi, L13 warrant) — paling penting;
      urgency naik saat `expires_at` mendekat.
    - **task** — tugas risikotinggi belum disetujui, atau tugas akan berjalan ≤1 hari.
    - **insight** — pelajaran confidence tinggi belum divalidasi (menyalakan warrant loop).
    - **preference** — preferensi eksplisit confidence tinggi (kandidat rutin terendah).
  - `offerSuggestions` — kembali pesan digest siap-Telegram, atau `null` untuk **skip**
    (owner-fatigue guard, fail-open: error DB → skip, tak pernah menghalangi).
  - `listSuggestions` — daftar saran terbuka untuk `/suggestions`.
  - `resolveSuggestion` — pemilik *accept* / *dismiss*. **Accept hanya menandai sinyal**;
    tidak mengeksekusi apa pun (HOTL). **Dismiss = learned dismiss**: sumber tak
    ditawarkan lagi.
  - `feedbackMultipliers` — **feedback learning**: agregat deterministik D1 per kategori
    (`SUM accepted/dismissed` dari tabel `suggestions`) → multiplier `[0.4, 1.0]`.
    Diterapkan ke skor urgency tiap kandidat (`damp`). **Fail-closed**: multiplier hanya
    bisa *menurunkan* urgency dari baseline, tidak pernah menaikkan — kategori yang
    sering di-dismiss akan mereda cepat (merespons negative feedback per riset), sementara
    JARVIS tidak akan pernah jadi lebih intrusif dari desain dasar.
- `migrations/0008_predictive.sql` — tabel `suggestions` (persisten `urgency`, status
  `offered|accepted|dismissed`) + `idx_suggestions_dedup` UNIQUE `WHERE status='offered'`
  (offer-once guard / learned dismiss).
- `src/workers/telegram_webhook.ts` — perintah owner read-only:
  - `/suggestions` → daftar saran terbuka.
  - `/suggestion accept <id>` / `/suggestion dismiss <id>` → resolusi inline.
- `src/index.ts` — digest saran digabung ke cron pagi `0 7` (reuse slot cron yang ada,
  tak menambah hitungan cron; skip saat tidak ada yang penting).

## Kedaulatan & fail-closed

- Saran **hanya tawaran teks**; origin `predictive` selalu DEFER, tidak pernah
  dieksekusi otomatis (diuji di `testLevel16Predictive`).
- Accept/tolak saran tidak menjalankan efek samping — hanya transisi status append-only.
- Learned dismiss memastikan saran yang ditutup pemilik tidak muncul lagi.
- Batch ketat (≤3) + threshold urgency + digest pagi → anti notification-fatigue.

## Pengujian

- `test/safety.test.ts` → `testLevel16Predictive`: cap ≤3, threshold urgency ada, modul
  tak punya jalur eksekusi/schedule, dedup & learned dismiss, migrasi memuat `urgency`
  + unique index, origin gate tetap DEFER.
- `test/logic.test.ts` → `testPredictiveUrgencyRanking`: ranking deterministik approval
  > task/insight > preference, semua kandidat harus lolos threshold, cap batch, dan
  dedup sumber yang sudah ditawarkan (via mock D1 di memori, tanpa LLM).
- `test/safety.test.ts` → `testAnswerGrounding`: regression-guard statis bahwa
  **jawaban input** JARVIS tetap grounded (wajib menyebut sumber/method, dilarang
  mengarang), jujur terhadap ketidakpastian ("Belum terverifikasi:"), dan memberi
  fallback yang jelas & berarah (hasil mentah / akui outage + coba lagi) — bukan
  "maaf generik". Menjaga prinsip Grice + grounding dari temuan riset jawaban-input.

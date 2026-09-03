# Level 17 — Behavioral Steward (Answer-Behavior Alignment)

J.A.R.V.I.S. belajar **menyesuaikan perilaku jawabannya** dari loop
**memori + refleksi → feedback** yang sudah ada, tanpa mengganti parameter model,
tanpa fine-tuning, dan tanpa mengubah sistem prompt. Ini menutup celah yang belum
ada di Level 13–16: refleksi mencatat *kapan* jawaban diperbaiki, dan saran
belajar dari *accept/dismiss*, tapi belum ada lapisan yang menghubungkan **koreksi
jawaban** menjadi **pengubah perilaku jawaban di masa depan**.

Level ini menambahkan satunya: **answer-behavior alignment feedback loop**.

## Desain

- **Sinyal (memori + refleksi)**: `reflection_log` sudah mencatat, setiap kali
  kritik membuat JARVIS *mengubah* jawabannya (`reflected=1`) plus skor rubric
  `score`. Sebuah koreksi = umpan balik negatif implisit terhadap *perilaku
  jawaban* kategori itu.
- **Feedback per kategori**: `behaviorAffinity()` meng-agregat koreksi
  per kategori `behavior|format|tone|timing|safety` menjadi **affinity**
  `[BEHAVIOR_AFFINITY_MIN, 1]`. Kategori yang sering dikoreksi → affinity rendah.
- **Menyesuaikan perilaku jawaban**: `getAnswerBehaviorContext()` — versi
  **fail-closed** dari `getBehaviorContext` — menyuntikkan preferensi pemilik
  (selalu, karena eksplisit) tetapi **menahan pelajaran (insight)** dari kategori
  yang affinity-nya di bawah ambang `BEHAVIOR_AFFINITY_KEEP`. JARVIS *berhenti
  mengulang* perilaku jawaban yang terus ia perbaiki.
- **Wiring fungsional**: kedua jalur produksi jawaban memakai konteks adaptif ini:
  jalur riset single-pass (`ai.ts`) **dan** penulis riset dalam/deep
  (`subagents.ts`). Jadi adaptasi berlaku ke mana pun jawaban dihasilkan.

## Fail-closed & tak pernah permanen

- **Fail-closed (hanya meredam, tak pernah menguatkan)**: affinity selalu
  `<= 1` (netral = identitas). Kategori yang dikoreksi hanya bisa **turun**
  pengaruhnya; tidak pernah dinaikkan melebihi baseline (Learning-from-Negative-
  Feedback RecSys '23; Fail-Closed Alignment '26).
- **Tak pernah di-suppress permanen (stabilized forgetting)**: affinity diberi
  lantai `BEHAVIOR_AFFINITY_MIN > 0`, dan sinyal koreksi di-decay **recency
  (kurva lupa Ebbinghaus / setengah-hidup `BEHAVIOR_HALF_LIFE_DAYS`)** — kategori
  yang *berhenti* dikoreksi akan pulih pengaruhnya seiring waktu (FadeMem; PMORS;
  Generative Agents recency). Ledakan koreksi lama tidak membekukan perilaku
  selamanya.
- **Fail-open**: kegagalan D1 → affinity kosong (semua kategori netral), konteks
  jatuh balik ke versi tak-terfilter sehingga jawaban tak pernah terblokir.
- Append-only: JARVIS hanya membaca `reflection_log`/`insights`; tak mengubah
  skema/prompt sendiri (selaras L13).

## Komponen

- `migrations/0009_behavior_feedback.sql` — `ALTER TABLE reflection_log ADD COLUMN
  category TEXT NOT NULL DEFAULT 'behavior'` (backfill-safe) + index kategori.
- `src/lib/evolution.ts`
  - `BEHAVIOR_AFFINITY_NEUTRAL=1`, `BEHAVIOR_AFFINITY_MIN=0.4`,
    `BEHAVIOR_CORRECTION_SATURATION=3`, `BEHAVIOR_HALF_LIFE_DAYS=14`,
    `BEHAVIOR_AFFINITY_KEEP=0.5`.
  - `reflectOnTurn(env, turnText, output, errors, category="behavior")` — mencatat
    kategori ke reflection_log.
  - `behaviorAffinity(env, now?)` — deterministik: koreksi per kategori di-agregat
    lalu di-decay setengah-hidup → `[MIN, 1]`, fail-closed (tak pernah >1).
  - `getAnswerBehaviorContext(env, topic, now?)` — preferensi selalu + insight
    hanya kategori dengan affinity >= ambang; gagal → fallback tak-terfilter.
- `src/lib/ai.ts`, `src/lib/subagents.ts` — kedua jalur jawaban memakai
  `getAnswerBehaviorContext`.

## Pengujian

- `test/safety.test.ts` → `testBehaviorAlignmentFailClosed`: netral=1 (tak ada
  boosting), lantai `(0,1)` (tak pernah nol / permanen), korreksi tersaturasi →
  lantai; non-koreksi (jawaban tak diubah) **bukan** sinyal negatif; koreksi lama
  → pulih; kedua jalur answer memakai konteks feedback-aware; migrasi 0009 ada.
- `test/logic.test.ts` → `testBehaviorAlignmentRanking`: affinity menurun
  monotonik sebelum lantai; tak pernah > netral; saturasi → lantai; decay recency
  (korreksi lama lebih ringan, sangat lama → ~netral); matematika setengah-hidup
  tepat (0.5 weight pada umur tepat satu half-life → `1 - 0.5/3`).

## Referensi riset adaptif

| Temuan riset | Penerapan di Level 17 |
|---|---|
| Zhao et al., ExpeL (AAAI '24) | Insight berpengalaman dapat **kehilangan pengaruh** saat terbantah oleh contoh negatif → dukungan menahan insight kategori yang gagal. |
| Shinn et al., Reflexion (NeurIPS '23) | Refleksi verbal = "gradien semantik" dari umpan balik biner/scalar yang mengarahkan perilaku berikutnya → `reflected` sebagai sinyal negatif. |
| Madaan et al., Self-Refine (NeurIPS '23) | Self-critique nabat—jawaban yang *diubah* adalah proksi kualitas yang andal; iterasi berlebih punya diminishing return → koreksi sekali, gunakan sebagai sinyal. |
| Bi et al., "Learning from Negative User Feedback" (RecSys '23, Google) | Feedback negatif harus jadi target optimasi eksplisit & mengurangi pola serupa; tak boleh ditingkatkan → **affinity fail-closed tak pernah >1**. |
| Li et al., "Beyond Explicit and Implicit" (CHI '25) | Feedback negatif implisit itu *disengaja* dan layak direspons → `reflected` (jawaban diubah) = signal negatif implisit yang disengaja. |
| Jawaheer et al. 2014 (ACM TiiS) | Gabungkan feedback eksplisit (sparse) + implisit (berlimpah) → agregat per kategori memadukan keduanya. |
| Jin et al., PMORS (WSDM '24) | Kurva lupa Ebbinghaus dijatuhkan pada penalti feedback negatif yang meluruh eksponensial → **decay setengah-hidup** sinyal koreksi. |
| Wei et al., FadeMem ('26) | Memori adaptif dengan *adaptive exponential decay*; memori ter-reinforce lebih lambat lupa → kategori yang berhenti dikoreksi pulih. |
| Park et al., Generative Agents (UIST '23) | Recency (exp. decay) membuat memori terbaru lebih dominan → koreksi baru lebih berat dari yang lama. |
| Stabilized Forgetting (Bayesian Online Learning, '26) | Lantai menjaga agar peluruhan tak pernah benar-benar memusnahkan pengaruh → `BEHAVIOR_AFFINITY_MIN > 0`. |
| Chen et al., RESPECT (ACL '25) | Belajar dari feedback implisit pada interaksi nyata, tanpa anotator → memakai `reflection_log` yang sudah dikumpulkan produksi. |
| Tao et al., CONQORD (ACL Findings '24) | Skor evaluasi-diri terkalibrasi dapat menentukan kapan harus menahan/beralih → agregat skor rubric sebagai ambang suppress. |
| STITCH (ACL Findings '26) / Semantic Context (Müller '25) | Penandaan kategori + suppress yang selektif per kategori → insight diberi tag kategori dan hanya kategori bermasalah yang ditahan. |
| Fail-Closed Alignment (arXiv '26) | "Fail-closed" = meningkatnya inhibisi saat error berulang & gagal aman secara default → netral=1, lantai>0, tak pernah amplifikasi. |

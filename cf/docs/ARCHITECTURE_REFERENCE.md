# Architecture Reference — JARVIS Agent Brains (m8)

Dokumen ini menangkap referensi riset dan kontrak desain yang dipakai saat
refactor arsitektur JARVIS (m8-v10 → m8-v13). Tujuannya: setiap keputusan besar
memiliki jejak + sumber, sehingga upgrade berikutnya (Fase 5+) tidak harus
"menemukan ulang" alasan desain.

---

## 1. Referensi riset (kategori & sumber)

### 1.1 Pola arsitektur agent
- **Anthropic — Building effective agents / multi-agent research system**
  (building blocks: augmented LLM, workflows, agents; pola *hierarchical
  supervisor → specialist*, *orchestrator-workers*, *evaluator-optimizer*).
  - Konsep yang dipakai: JARVIS = **centralized orchestrator-worker**
    (`intelligence.ts` = orchestrator; subagents = workers riset; webhook =
    harness). Delegasi lewat *objective + format + batas* yang eksplisit
    (kontrak `IntentResult`/`Strategy`, `MAX_ANGLES=3`, `MAX_TOTAL_LLM_CALLS=6`).
  - **Anthropic — Agent Skills**: capability modular yang terkompos. Dipakai
    sebagai inspirasi *capability contract*: tiap capability punya trigger,
    input/output schema, error codes, dan fallback — bukan lagi bercampur di
    satu file besar.
  - **Context engineering**: just-in-time retrieval (Context7 untuk grounding
    docs library terbaru; anchor follow-up untuk anti-repetisi).
  - **Harness design / sprint contract**: "setiap komponen meng-encode asumsi
    yang harus di-stress-tested" → mendorong adanya *output gate* (verifier)
    dan *failure taxonomy* (Fase 3).

### 1.2 Control plane & kontrak capability
- **arXiv 2505.06817 (tool orchestrator)**: orchestrator sebagai satu `tool()`
  yang membungkus Tool Registry → Intent Resolver → Routing Handler →
  validators.
  - Dipakai: `capability_registry.ts` = **Tool Registry + Intent Resolver**
    tunggal; router webhook (pre-cascade) dan brain (`classifyIntent`) berbagi
    PREDIKAT yang sama sehingga tidak bisa melenceng (Fase 1).
- **Alice Labs (agent registry + state manager)**: handoff antar-agent butuh
  *kontrak eksplisit*; ada *circuit breaker* dan *loop limit*.
  - Dipakai: `fallbackId`, `requires`, `errorCodes`, `maxRuns` (batch) sebagai
    bagian kontrak; recovery dibatasi budget (Fase 3).
- **Orkes (durable agents)**: idempotency + suspend/resume.
  - Dipakai: dedupe KV `selfprop:*` dengan stamp jendela (Fase 4).

### 1.3 Self-healing
- **alphaXiv 2606.01416 — failure classifier + budgeted recovery**:
  - *Failure classifier*: error dibagi kelas (raw dump/non-answer/truncated/
    repetitive + operasional empty/timeout/blocked/stale).
  - *Budgeted recovery*: tiap kelas punya budget retry/replan/tool-substitusi/
    model-escalation; **Verifier membasmi silent failure**.
  - Dipakai: `verifier.ts` (gate deterministik, Fase 2) + `failure.ts`
    (taxonomy + `budgetedRecovery`, Fase 3).
- **R. Kumar — blast radius & HALT protocol**: *semantic verification gate*
  sebelum release; perubahan tidak langsung diterapkan — selalu melewati
  validasi.
  - Dipakai: `runDeploySafetyLoop` (health score, auto-revert) + proposal-gate
    `gap_upgrade.ts` (auto-proposal TIDAK merged otomatis; menunggu resolusi).

### 1.4 Framework 2026 (survei opsional)
- LangGraph, CrewAI, Mastra, OpenAI Agents SDK — keputusan: **TETAP di
  harness kustom**. Alasan: free-tier (100k req/hari, 10ms CPU, 50 sub-request),
  jejak dependensi minimal, dan seluruh kontrol (gate, budget, tally) sudah
  dibangun di atas harness sendiri. Migrasi framework menambah risiko tanpa
  benefit yang terukur untuk workload saat ini.

---

## 2. Peta celah JARVIS (sebelum refactor)

1. **Tidak ada registry capability tunggal** — trigger tersebar
   (`intelligence.ts` + `telegram_webhook.ts` + `ai.ts`), regex ganda
   (`TRANSLATE_RE` / `BARE_TRANSLATE_RE` di brain vs head-regex di webhook)
   yang bisa melenceng.
2. **Routing dobel** — webhook `EXECUTE` meniru kerja brain (cascade
   terjemahan/prompt_master/context7) dengan predikat yang berbeda.
3. **Tidak ada failure class + budgeted recovery** — silent failure (reply
   terpotong / dump HTML / non-answer) bisa lolos ke pemilik tanpa dideteksi;
   recovery tidak dibatasi budget → risiko loop & boros free tier.
4. **Tidak ada verifier output deterministik** — verifikasi mengandalkan LLM
   opsional / heuristik tak koheren; `semantic_validator.ts` dead code.
5. **Gap tidak diukur** — fallback rate tidak di-roll-up → tidak ada dasar
   kuantitatif untuk upgrade berikutnya.

---

## 3. Roadmap 4 fase (implementasi)

| Fase | Versi  | Isi | File kunci |
|------|--------|-----|------------|
| 1 | m8-v11 | Capability registry + router tunggal | `capability_registry.ts`, `intelligence.ts`, `telegram_webhook.ts` |
| 2 | m8-v10 | Verifier gate deterministik + tally | `verifier.ts`, `ai.ts`, `subagents.ts` |
| 3 | m8-v12 | Failure taxonomy + budgeted recovery | `failure.ts`, `ai.ts`, `subagents.ts` |
| 4 | m8-v13 | Gap→upgrade auto-proposal loop | `gap_upgrade.ts`, `failure.ts`, `index.ts` cron |

Relasi pipeline:
```
user → webhook EXECUTE → matchWebhookPreCapability (registry) ─┐
                                                               ├→ brain act()
        classifyIntent ← capabilityIntent (predikat SAMA) ─────┘
replies → gateVerdict (verifier) → budgetedRecovery (budget ≤1)
        → tallyGate/tallyFailure (ledger harian KV)
        → readFailureLedger (7 hari) → runGapUpgradeLoop → proposal selfprop:* (dedupe)
        → /status + morning briefing
```

---

## 4. Kontrak desain (single source of truth)

### 4.1 Capability contract (`capability_registry.ts`)
`CapabilityContract { id, label, brief, intent, approach, priority,
webhookPre?, webhookOrder?, predicate?, fallbackId, requires, errorCodes,
metricsKey }`
- Trigger canonical (predikat) DIPAKAI untuk webhook pre-cascade DAN brain
  `classifyIntent` — tidak boleh duplikasi regex.
  - `isTranslateCapRequest`: head-verb dengan word-boundary
    (`(?![\w-])`) — "translated…", "jangan terjemahkan…" tidak misfire,
    sedangkan "terjemahkan", "terjemahkan ke <bahasa>" tetap jalan.
  - prompt_master / context7 memakai predikat asli masing-masing
    (`isPromptMasterRequest`, `isContext7Request`).
- `errorCodes` registry OTENTIK vs `OperationalFailure` di `failure.ts`
  (empty|timeout|blocked|stale) 1:1. `metricsKey` = path ledger.

### 4.2 Verifier gate (`verifier.ts`)
`gateVerdict(text, anchor) → raw_dump|non_answer|truncated|repetitive|ok`
- Precedence: raw machinery > non-answer > truncation > repetition > ok.
- Konservatif: markdown/kode fenced TIDAK di-flag. `tallyGate` mencatat hanya
  non-ok per path per hari (KV `gate:YYYY-MM-DD`, TTL 8 hari).
- **Arah dependensi**: verifier TIDAK meng-import ai; truncation helpers
  kanonik tinggal DIsINI; `ai.ts` re-export untuk kompatibilitas.

### 4.3 Budgeted recovery (`failure.ts`)
`recoveryPlan(class) → {strategy, llmBudget}`

| verdict | strategy | llmBudget | deterministik |
|---------|----------|-----------|---------------|
| truncated | repair | 0 | ya (`repairTruncatedReply`) |
| raw_dump / non_answer / repetitive | rewrite | ≤1 | tidak (`recoverReply` guidance) |
| empty/timeout/blocked/stale | degrade | 0 | ya (failover caller) |

`budgetedRecovery` fail-open: minimal kembali ke teks asli, tak pernah throw,
tak pernah loop. Outcome final diverifikasi ulang (`gateVerdict`) + ditally.

### 4.4 Gap→upgrade (`gap_upgrade.ts`)
- Gap = (path, failureClass) dengan count ≥ `GAP_MIN_7D` (3) dalam
  `GAP_LEDGER_DAYS` (7) dari ledger gabungan gate+fail.
- Dedupe KV: slot `selfprop:open:<cap>:<class>`; resolusi stamped
  `selfprop:done:<cap>:<class>` untuk jendela berjalan → gap yang sama tidak
  dipropose ulang sampai jendela bergulir.
- Deteksi 100% deterministik (nol panggilan LLM); `fixHintFor` memberi
  kandidat perbaikan per (path, class). Proposisi menunggu resolusi — tidak
  auto-merge (HALT).

---

## 5. Cara upgrade NEXT (panduan praktis)

1. Ukur dulu: lihat `/status` atau `[cron] gap_upgrade` di log — gap mana yang
   berulang (capability × failure class × count).
2. Propose/apply lewat alur mekanik: `resolveGapProposal(env, cap, cls,
   "applied"|"rejected")` atau biarkan stamp kadaluarsa.
3. Patch dalam versi baru (bump `m<major>-v<n>-<8char>`), jalankan
   `tsc --noEmit`, `npm run test:logic`, `npm run test:safety`, probe, deploy,
   healthz, commit+push.
4. Jika gap hilang di jendela berikutnya → proposal tidak akan dibuka ulang
   (dedupe) → konfirmasi perbaikan nyata lewat ledger yang bersih.

## 6. Catatan constraint (free tier)
- LLM budget agregat: maks 1 panggilan ekstra per recovery; riset mendalam
  ≤6 panggilan total. Provider: Workers AI / Groq (`openai/gpt-oss-120b`) /
  OpenRouter (`qwen/qwen3.6-27b`) / Gemini (`gemma-4-31b-it`) dengan
  max_tokens berbeda (1600/2200/1800).
- Semua observabilitas KV adalah fire-and-forget (tidak pernah memblok reply).
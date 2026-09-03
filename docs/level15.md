# Level 15 — Deep / Recursive Research & Follow-up

Level 14 gave J.A.R.V.I.S. a bounded **orchestrator-worker research pipeline**
(Researcher → parallel Searcher → Evidence Extractor → Writer → Verifier).
Level 15 pushes that same pipeline to be **self-correcting and session-aware**
without leaving the 100% free tier and without ever outranking the owner:

- **Deep / Recursive Research** — after the first Writer draft, a **Critic**
  sub-agent reviews whether the answer truly covers every facet of the owner's
  question. If it finds meaningful coverage gaps **and** there is LLM-call
  headroom, a second search + Writer pass closes those gaps — producing a
  deeper, evidence-backed answer instead of a single shallow pass.
- **Follow-up Resolution** — a follow-up message in the same session ("lebih
  dalam", "yang tadi", "terus, kan?") is anchored to the **most recent
  assistant analysis** and resolves against it, so the next research pass
  *deepens* that analysis rather than treating the follow-up as a brand-new
  topic (which previously fell through to "Ok." / "Aksi ditangguhkan.").

## Design Principles (extends L14)

1. **Self-critique with an explicit role** (Agentic Reflection / self-refine
   patterns). The **Critic** is a bounded worker with *no tools and no
   authority* — it only returns structured JSON
   `{satisfied, gaps[], followupAngles[]}`. The bounded orchestrator decides
   whether/where to spend scarce LLM calls. It cannot act, cannot bypass the
   owner, and answers only to the owner.
2. **Budget-gated recursion (NOT unbounded).** A second research pass runs only
   when (a) the first draft is substantial (`CRITIC_MIN_DRAFT_LEN`), and
   (b) `calls < MAX_TOTAL_LLM_CALLS` headroom remains. `MAX_TOTAL_LLM_CALLS` is
   raised to **6** (researcher + extractor + writer + critic + extractor +
   second writer) — still a hard, small bound. LLM calls are pure I/O-wait
   (10ms CPU unaffected) and Groq free tier is 100k req/day, so this is
   comfortably within free tier.
3. **Deep pass extends, never repeats.** The second Writer is handed the first
   draft as `priorDraft` and instructed to *PERDALAM* (deepen) it with the new
   follow-up evidence — preserving what's already good while closing gaps.
4. **Follow-up is anchored, not rediscovered.** `isFollowUpQuery()` detects
   follow-up phrasing; `resolveFollowUpAnchor()` pulls the most recent assistant
   analysis and threads it into the Researcher so its angles *extend* that
   answer (same cross-agent memory hop idea as L14, but explicit for the
   immediate session turn).
5. **Fail-closed everywhere.** A Critic that fails/is inconclusive returns a
   "satisfied" verdict → we keep the first draft, never burn budget on an
   unconvincing refine. A follow-up with no prior analysis falls back to the
   generic reply. The constitutional guard + retrieval rail (spotlighting) and
   output rail (Verifier) are all unchanged.

## The Deep/Recursive Loop (`src/lib/subagents.ts`)

```
Researcher (1) → [Searcher (0)] → [Extractor (0-1)] → Writer (1)
   └─ if draft >= CRITIC_MIN_DRAFT_LEN and calls < MAX:
        Critic (1)  → {satisfied, gaps[], followupAngles[]}
        └─ if !satisfied and followups and calls < MAX:
             Searcher(followups) (0) → [Extractor (0-1)] → Writer2(priorDraft) (1)
   └─ (optional) Verifier (1) for long replies
Max deep path: 6 LLM calls. Simple/narrow: 1. Everything degrades to single-pass.
```

## Files

- `src/lib/subagents.ts` — `MAX_TOTAL_LLM_CALLS=6`, `CRITIC_MIN_DRAFT_LEN`,
  `CriticVerdict` + `criticValidator`, `criticSystem`, `runCritic()`, the
  budget-gated deep/recursive loop in `orchestrateResearch`, `runResearcher`
  follow-up `anchor`, and `runWriter` `priorDraft` extension.
- `src/lib/ai.ts` — `FOLLOWUP_RE`, `isFollowUpQuery()`, `resolveFollowUpAnchor()`,
  and `searchAndSynthesize` passing the follow-up anchor into orchestration.
- `src/workers/telegram_webhook.ts` — follow-up branch in the EXECUTE path so a
  follow-up without a topic marker deepens the last analysis instead of "Ok.".
- `test/safety.test.ts` — `testLevel15DeepResearch` (budget bounds, Critic
  wiring, priorDraft/deepen prompt, budget-gate regex, follow-up resolution).
- `test/logic.test.ts` — `testFollowUpDetection`.

## Budget / Free-Tier Impact

No new Worker, cron, D1 table, or KV key. LLM calls stay I/O-wait only. Raising
the research cap to 5 is bounded (not unbounded recursion) and only spent on
genuinely deep follow-up research; simple queries still use 1 call.

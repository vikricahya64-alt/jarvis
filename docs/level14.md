# Level 14 — "Orchestrator / Worker" Sub-Agent Layer

J.A.R.V.I.S. is no longer a single-pass assistant. For **complex, multi-facet
research queries** it now runs a **bounded orchestrator-worker sub-agent
pipeline** that decomposes the ask, researches each facet separately, and
synthesizes an evidence-based structured reply. Simple/narrow asks stay on the
cheap single-pass path.

Big-picture principle (same as L13): every sub-agent is **subordinate to the
owner**, every stage is **fail-closed to a real answer** (never a synthetic
block), and it all fits the **100% free tier** (no new Worker, cron, D1, KV —
stays well under 100k req/day, 5 cron slots, existing D1/KV).

## Design (from public reference research, verified during L14)

The design synthesizes widely-used sub-agent/agentic patterns, adapted to a
small LLM (Groq llama + Gemini fallback) on Cloudflare Workers free tier:

1. **Orchestrator-Worker, not swarm** (Anthropic "Building Effective Agents";
   OpenAI Swarm/Agents SDK). An orchestrator decomposes; bounded workers each
   return **typed structured results**; the coordinator synthesizes. We avoid
   free-wheeling handoffs/peer debates that balloon token+latency.
2. **Effort-scaling** (Anthropic multi-agent research system). Sub-agents only
   spawn for genuinely multi-facet asks (`perbandingan…`, `vs`, `bagaimana
   cara`, `langkah…`, `analisis`…). A single narrow topic uses **1 LLM call**.
3. **Structured outputs / schema-driven scaffolding** (Instructor, Pydantic AI).
   Each role returns JSON validated by a runtime schema; a malformed worker
   result is **corrected once** with the validation error (cheap critic), then
   discarded — never force-cast.
4. **Fresh/isolated context per call** (LangChain context isolation; constraint
   drift / peer-preservation research). No shared context window between roles
   (avoids reward-hacking); the **constraint manifest** (owner sovereignty) is
   restated in **every** sub-agent system prompt so it can't drift across hops.
5. **Guardrail layering** (OpenAI Agents SDK rails; NeMo Guardrails) on top of
   the existing constitutional guard:
   - **input rail**: existing `validateAction` / `routeCommand` (fail-closed,
     before any dispatch);
   - **retrieval rail**: raw web snippets are **spotlighted** as untrusted
     (`<<<UNTRUSTED_EXTERNAL_CONTENT>>>`) — OWASP/Anthropic prompt-injection
     defense so a poisoned page can't command the writer;
   - **output rail**: an optional, **stateless** Verifier sub-agent that answers
     ONLY to the owner and **abstains** rather than hallucinate (sparingly, only
     for long multi-facet replies).

## The Pipeline (`src/lib/subagents.ts`)

```
Router (deterministic effort-scaling: isResearchClass?)
  └─ if research-class ──▶ Researcher sub-agent (1 LLM: plans 1..3 angles)
         ▼ (per angle — ALL FANNED OUT IN PARALLEL via Promise.all;
            deterministic DDG, no LLM per angle)
      Searcher (multi-finding: searchTopResults extracts title+url+snippet)
         ▼ (sanitize + spotlight each hit; urls preserved for citation)
      Writer sub-agent (1 LLM: synthesizes cross-angle, evidence-based reply;
                        injects memory + L13 behavior context)
         ▼
      Verifier (optional 1 LLM, only for long replies): output rail / abstain
```

> **Parallel fan-out (enhancement):** the per-angle searches now run **in
> parallel** (`Promise.all`), not sequentially — lowering latency on
> multi-angle research. Each angle is an independent worker with isolated,
> rich evidence: `searchTopResults` returns up to `MAX_FINDINGS_PER_ANGLE`
> structured hits (title, real URL, snippet) per angle, preserving the URL
> for citation while still spotlighting every hit as untrusted. `ddgSearch`
> (single-result) stays untouched for the cheap single-pass path.

**LLM-call budget** (research-backed cap): simple = **1**; complex = **2–3**
(researcher + writer [+ verifier]). `MAX_TOTAL_LLM_CALLS = 3`.

## Fail-Closed Guarantees

- Any sub-agent failure → orchestration returns `null` → caller falls back to
  the **existing single-pass** search+synthesis (`ai.ts`). The owner always
  gets a real reply, never a fabricated block.
- Researcher/verifier JSON malformed twice → discarded → graceful fallback.
- All sub-agents enforce owner sovereignty and ignore instructions embedded in
  external web content.

## Files

- `src/lib/structured.ts` — Instructor-style JSON scaffold + validators.
- `src/lib/subagents.ts` — the orchestrator-worker pipeline + roles
  (parallel fan-out via `gatherAllParallel`).
- `src/lib/ai.ts` — `searchAndSynthesize` now gates orchestration on
  `isResearchClass` for research-class queries, else single-pass; adds
  `searchTopResults` (multi-finding, url-bearing) for the fan-out.
- `test/safety.test.ts` — `testLevel14Subagents` (effort-scaling, budget caps,
  structured-output correction, sovereignty wiring, parallel fan-out)

## Budget / Free-Tier Impact

No new Worker, cron, D1 table, or KV key. LLM calls are I/O-wait only (10ms CPU
budget unaffected). Groq free tier handles 100k req/day; sub-agents only add a
few calls on research-class asks. Telegram reply stays within the 30s window.

//=====================================================================
// capability_registry.ts — CAPABILITY REGISTRY + canonical router (control
// plane as a tool, Alice Labs agent-registry pattern).
//
// Single source of truth for every JARVIS capability:
//   - contract table: id, label, intent↔approach mapping, classification
//     priority, webhook-pre order, fallback target, required deps, error
//     codes, and the metrics key for the gap→upgrade tally (verifier.ts).
//   - canonical triggers (predicate) for the pre-brain capabilities
//     (translate / prompt_master / context7) — the SAME predicate drives the
//     webhook EXECUTE cascade AND the brain's classifyIntent(), so the two
//     routers can no longer drift apart (was fragmented regexes in both).
//   - read-only describeCapabilities() for introspection.
//
// IMPORTANT: classifiers that carry real nuance (emergency, design,
// self_referential, search depth) keep their logic in intelligence.ts /
// subagents.ts / identity.ts; the registry DOCUMENTS their contract but
// does not re-implement the trigger (no duplicated regex to rot).
// Fail-closed: every lookup here is pure & synchronous.
//=====================================================================

import { isPromptMasterRequest } from "./prompt_master";
import { isContext7Request } from "./context7";
import { SELF_REF_RE } from "./identity";

export type CapabilityId =
  | "self_referential"
  | "emergency"
  | "prompt_master"
  | "context7"
  | "design"
  | "translate"
  | "search"
  | "followup"
  | "understand"
  | "command"
  | "chat"
  | "question";

export interface CapabilityContract {
  id: CapabilityId;
  /** Indonesian display label (user-facing). */
  label: string;
  /** One-line description of what the capability does. */
  brief: string;
  /** The brain's IntentResult.type that this capability maps to. */
  intent: string;
  /** The brain's Strategy.approach used to execute this capability. */
  approach: string;
  /** Brain classifier priority (higher = checked earlier). */
  priority: number;
  /** Routed by the webhook PRE-BRAIN cascade (before the big search/media funnel). */
  webhookPre?: boolean;
  /** Order within the webhook pre cascade (lower = earlier). */
  webhookOrder?: number;
  /** Canonical trigger predicate — shared by BOTH routers when present. */
  predicate?: (text: string) => boolean;
  /** Degrade target when the capability handler fails (fail-closed chain). */
  fallbackId: string;
  /** Environment/workflow dependencies the capability needs to run. */
  requires: string[];
  /** Enumerable failure classes the capability can surface (verifier taxonomy). */
  errorCodes: string[];
  /** tally metric path for the gap→upgrade loop (verifier.tallyGate). */
  metricsKey: string;
}

/** Ordered-by-priority contract table (also fixes webhook-pre order). */
export const CAPABILITY_CONTRACTS: CapabilityContract[] = [
  {
    id: "self_referential",
    label: "Identitas Diri",
    brief: "Menjawab 'siapa kamu / apa yang bisa kamu lakukan' langsung dari sumber tunggal identitas, tanpa LLM eksternal.",
    intent: "self_referential",
    approach: "self_referential",
    priority: 900,
    predicate: (t) => SELF_REF_RE.test((t || "").trim().toLowerCase()),
    fallbackId: "self_referential",
    requires: [],
    errorCodes: [],
    metricsKey: "self_ref",
  },
  {
    id: "emergency",
    label: "Darurat",
    brief: "Menghentikan/override yang dinyatakan tegas (standalone marker, bukan topik yang dideskripsikan).",
    intent: "emergency",
    approach: "simple_llm",
    priority: 890,
    fallbackId: "simple_llm",
    requires: [],
    errorCodes: ["TIMEOUT"],
    metricsKey: "emergency",
  },
  {
    id: "prompt_master",
    label: "Prompt-Master",
    brief: "Menyusun prompt optimal untuk tool AI target (skill prompt-master v1.8.0, sistem override).",
    intent: "prompt_writer",
    approach: "prompt_master",
    priority: 800,
    webhookPre: true,
    webhookOrder: 2,
    predicate: (t) => isPromptMasterRequest(t),
    fallbackId: "simple_llm",
    requires: ["llm"],
    errorCodes: ["EMPTY", "TIMEOUT"],
    metricsKey: "prompt_master",
  },
  {
    id: "context7",
    label: "Context7 Docs",
    brief: "Menyediakan dokumentasi library terbaru (context7.com) untuk grounding anti-halusinasi.",
    intent: "context7",
    approach: "context7_docs",
    priority: 790,
    webhookPre: true,
    webhookOrder: 3,
    predicate: (t) => isContext7Request(t),
    fallbackId: "simple_llm",
    requires: ["fetch", "CONTEXT7_API_KEY?"],
    errorCodes: ["EMPTY", "TIMEOUT", "BLOCKED"],
    metricsKey: "context7",
  },
  {
    id: "design",
    label: "Desain & Visual",
    brief: "Menghasilkan konsep desain + render gambar (flux) untuk permintaan kreatif.",
    intent: "design",
    approach: "orchestrate_design",
    priority: 780,
    fallbackId: "search_synthesize",
    requires: ["AI"],
    errorCodes: ["EMPTY"],
    metricsKey: "design",
  },
  {
    id: "translate",
    label: "Terjemahan",
    brief: "Menerjemahkan teks (atau analisis terakhir bila tanpa target).",
    intent: "translation",
    approach: "translate",
    priority: 770,
    webhookPre: true,
    webhookOrder: 1,
    predicate: (t) => isTranslateCapRequest(t),
    fallbackId: "simple_llm",
    requires: ["llm"],
    errorCodes: ["EMPTY", "TIMEOUT"],
    metricsKey: "translate",
  },
  {
    id: "search",
    label: "Riset & Pencarian",
    brief: "Sintesis berbasis web (single-pass) dan riset mendalam orkestrator-worker untuk topik kompleks.",
    intent: "search",
    approach: "search_synthesize",
    priority: 620,
    fallbackId: "canned",
    requires: ["fetch", "llm"],
    errorCodes: ["EMPTY", "TIMEOUT", "STALE"],
    metricsKey: "search_synth",
  },
  {
    id: "followup",
    label: "Lanjutan (Follow-up)",
    brief: "Memperdalam analisis terakhir dengan anchor yang konsisten; anti-repetisi.",
    intent: "search",
    approach: "search_synthesize",
    priority: 610,
    fallbackId: "canned",
    requires: ["kv"],
    errorCodes: ["REPETITIVE", "STALE"],
    metricsKey: "search_synth",
  },
  {
    id: "understand",
    label: "Pemahaman Maksud",
    brief: "Menerka keinginan pada input ambigu, atau bertanya klarifikasi alami.",
    intent: "understand",
    approach: "understand_intent",
    priority: 500,
    fallbackId: "simple_llm",
    requires: ["llm"],
    errorCodes: ["EMPTY"],
    metricsKey: "understand",
  },
  {
    id: "command",
    label: "Perintah",
    brief: "Perintah eksplisit (todo, reminder, pengaturan) via jalur brain.",
    intent: "command",
    approach: "simple_llm",
    priority: 400,
    fallbackId: "simple_llm",
    requires: [],
    errorCodes: [],
    metricsKey: "command",
  },
  {
    id: "chat",
    label: "Obrolan",
    brief: "Sapaan ringan / obrolan kasual.",
    intent: "chat",
    approach: "simple_llm",
    priority: 300,
    fallbackId: "simple_llm",
    requires: [],
    errorCodes: [],
    metricsKey: "chat",
  },
  {
    id: "question",
    label: "Pertanyaan Umum",
    brief: "Pertanyaan umum ke jalur LLM sederhana.",
    intent: "question",
    approach: "simple_llm",
    priority: 200,
    fallbackId: "simple_llm",
    requires: [],
    errorCodes: [],
    metricsKey: "question",
  },
];

/** Canonical translate trigger, shared by webhook AND brain. Mirrors the old
 *  webhook head-regex but guards a word boundary so verb-like words
 *  ("translated …", "translation …", mid-sentence "tolong terjemahkan")
 *  no longer misfire, while preserving the old head-verb semantics:
 *  verb-only ("terjemahkan") and verb + target-language-only ("terjemahkan ke
 *  bahasa inggris") still route to the dedicated translate chain (which
 *  resolves the previous analysis when there is no inline text). */
export function isTranslateCapRequest(text: string): boolean {
  const t = (text ?? "").trim();
  if (!t) return false;
  return /^\s*(?:terjemahkan|translate)(?![\w-])/i.test(t);
}

const byId = new Map<CapabilityId, CapabilityContract>(
  CAPABILITY_CONTRACTS.map((c) => [c.id, c]),
);

export function getCapability(id: CapabilityId): CapabilityContract | undefined {
  return byId.get(id);
}

/** Resolve the FIRST matching capability (with a predicate) for `text`,
 *  scanning in priority order. `ids` narrows the candidate set so callers can
 *  preserve their own precedence (e.g. brain checks design before translation
 *  while webhook checks translation first). */
export function capabilityIntent(
  text: string,
  opts: { ids?: CapabilityId[] } = {},
): { id: CapabilityId; intent: string } | null {
  const want = opts.ids ? new Set(opts.ids) : null;
  for (const c of CAPABILITY_CONTRACTS) {
    if (want && !want.has(c.id)) continue;
    if (!c.predicate) continue;
    try {
      if (c.predicate(text)) return { id: c.id, intent: c.intent };
    } catch { /* a throwing predicate must never break routing */ }
  }
  return null;
}

/** Webhook PRE-BRAIN router: first webhookPre capability in webhook order.
 *  Returns its contract (callers switch on `id` to dispatch). */
export function matchWebhookPreCapability(text: string): CapabilityContract | null {
  if (!text) return null;
  const pre = CAPABILITY_CONTRACTS
    .filter((c) => c.webhookPre)
    .sort((a, b) => (a.webhookOrder ?? 0) - (b.webhookOrder ?? 0));
  for (const c of pre) {
    if (!c.predicate) continue;
    try {
      if (c.predicate(text)) return c;
    } catch { /* never break routing on a predicate error */ }
  }
  return null;
}

/** Strategy.approach for an intent (contract-backed), or null when the intent
 *  has no dedicated capability (caller falls back to simple_llm). */
export function approachForIntent(intent: string): string | null {
  for (const c of CAPABILITY_CONTRACTS) {
    if (c.intent === intent) return c.approach;
  }
  return null;
}

/** Markdown capability summary for introspection / diagnostics (read-only). */
export function describeCapabilities(): string {
  const rows = [...CAPABILITY_CONTRACTS]
    .sort((a, b) => a.priority - b.priority)
    .filter((c) => c.predicate || c.id === "design" || c.id === "search" || c.id === "followup")
    .map(
      (c) =>
        `• *${c.label}* — ${c.brief}` +
        (c.predicate ? `\n  Trigger: *${capabilityTriggerHint(c)}*` : "") +
        `\n  Fallback: ${c.fallbackId} | Error: ${c.errorCodes.join(", ") || "—"}`,
    );
  return `🧩 *Capabilities J.A.R.V.I.S. (${rows.length})*\n\n` + rows.join("\n\n");
}

/** Human hint of the trigger pattern for a predicated capability. */
function capabilityTriggerHint(c: CapabilityContract): string {
  switch (c.id) {
    case "translate": return "terjemahkan/translate <teks> atau <ke bahasa> <teks>";
    case "prompt_master": return "kata 'prompt' / 'prompting' di permintaan";
    case "context7": return "'cara pakai <library>', 'docs untuk <library>', 'ctx7: /org/repo'";
    case "self_referential": return "siapa kamu / apa yang bisa kamu lakukan";
    default: return "tidak dipublikasikan";
  }
}
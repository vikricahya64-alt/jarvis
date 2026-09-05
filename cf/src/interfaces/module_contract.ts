/* ======================================================================
   MODULE CONTRACT — Standardized Interface for ALL JARVIS Modules
   ======================================================================
   
   ENFORCEMENT RULE:
   - Every module MUST implement this exact interface.
   - No exceptions. Modules importing DB/KV/Groq directly will FAIL contract
     validation and block deployment (auto-heal pipeline).
   
   WHY STRICT INTERFACES:
   - Enables Dependency Injection container to swap modules transparently
   - Enables auto-heal to verify contract compliance before patching
   - Guarantees CleanContext never leaks technical metadata to AI
   - Makes unit testing possible (mock implementations)
   ====================================================================== */

// ---------- Shared Types ----------

/** Unique module identifier — used by DI container and registry. */
export type ModuleId = string;

/** Capability descriptor — what a module can do. */
export interface ModuleCapability {
  /** Human-readable label (displayed in /help). */
  label: string;
  /** Optional regex pattern the module handles. */
  pattern?: RegExp;
  /** Priority within its category (higher = preferred). */
  priority: number;
}

/** Health status returned by every module's healthCheck(). */
export interface HealthStatus {
  /** Module is operational. */
  healthy: boolean;
  /** Optional detail message (e.g. "read-only degraded"). */
  detail?: string;
  /** Timestamp of last successful healthCheck (unix ms). */
  lastChecked: number;
}

/** Result returned by every module's execute(). */
export interface ModuleResult {
  /** Human-readable reply text (REQUIRED). */
  reply: string;
  /** Optional structured data to persist (e.g. observation topic). */
  observation?: string;
  /** Optional flag: should this trigger a memory trace? */
  traceMemory?: boolean;
  /** Optional: confidence score (0-1) for the reply. */
  confidence?: number;
}

/** The single contract every module MUST implement. */
export interface JarvisModule {
  /** Unique module identifier — injected by DI container. */
  readonly moduleId: ModuleId;

  /** Ordered list of module names this module depends on (for startup). */
  readonly dependencies: string[];

  /** Maximum CPU time (ms) before the module must yield control. */
  readonly maxCpuTimeMs: number;

  /** execute(context) — the ONLY place business logic lives.
   *  MUST return ModuleResult. NEVER throw outside of fatal DB/KV failure.
   *  MUST NOT reference Groq, D1, KV, or R2 directly — use injected deps. */
  execute(context: CleanContext): Promise<ModuleResult>;

  /** healthCheck() — liveness/readiness probe.
   *  MUST return HealthStatus. Never throws; returns {healthy: false, ...}. */
  healthCheck(): Promise<HealthStatus>;

  /** getCapabilities() — what this module can handle.
   *  Used by the orchestrator for routing. */
  getCapabilities(): ModuleCapability[];
}

/** ---------- CleanContext — What AI Sees ----------

   THE GOLDEN RULE: Nothing below this line reaches the Groq API.
   Any module needing system state MUST request it via DI; the DI container
   strips all technical metadata before passing to execute(). */

export interface CleanContext {
  /** The user's parsed intent (from detectIntent / SELF_REF_RE). */
  userIntent: {
    intent: string;
    confidence: number;
    entities: Record<string, string>;
  };

  /** The 5 most recent RELEVANT messages (topic-filtered, not raw history). */
  relevantHistory: Array<{
    role: "user" | "assistant";
    content: string;
    timestamp?: number;
  }>;

  /** User preferences scoped to the current domain only. */
  userPreferences: Array<{
    key: string;
    value: string;
  }>;

  /** Cultural tone marker — explicitly injected, never guessed. */
  culturalTone: "formal" | "casual" | "emergency";

  /** Optional honorific — "Pak", "Bu", "Mas", etc., or null. */
  honorifics: string | null;

  /** Optional: current conversation mode (from intelligence.ts). */
  conversationMode?: string;
}

// ============================================================================
/* DESIGN RATIONALE (ADR-001)
   ========================================================================

   CONTEXT:
   JARVIS suffered from module ownership ambiguity, cognitive overload due
   to noisy context sent to Groq, and fragile coupling where modules called
   each other directly. The AI appeared "dumb" because it received full
   system state (logs, configs, metrics) as context — signal-to-noise < 10%.

   DECISION:
   Enforce a strict JarvisModule contract with:
   1. Standardized execute(context) → ModuleResult interface
   2. CleanContext that explicitly excludes technical metadata
   3. Dependency Injection via constructor (never import DB/KV/Groq directly)
   4. healthCheck() and getCapabilities() for orchestration

   CONSEQUENCES:
   + AI receives only relevant context → restored intelligence
   + Modules are swappable via DI → easier testing and replacement
   + Auto-heal can validate contracts before patching → safer deployments
   + Single source of truth for routing → eliminated ownership chaos
   - Initial refactoring effort to implement contract in existing modules
   - Some modules may need adapter patterns to wrap existing logic

   BACKWARD COMPATIBILITY:
   All existing standalone function exports (e.g. getActiveClauses,
   captureError) remain unchanged. The new classes are opt-in additions.
   ======================================================================== */
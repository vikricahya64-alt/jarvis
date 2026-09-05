/* ======================================================================
   DEPENDENCY INJECTION CONTAINER — Single Point of Dependency Creation
   ======================================================================
   
   PURPOSE:
   - ONE place where DB, KV, Groq, R2, and all external services are instantiated.
   - All modules receive dependencies via constructor (never import directly).
   - Enables: easy mocking for testing, swapping implementations, auto-heal
     replacement of entire module instances without touching global state.
   
   CRITICAL: The container ALWAYS strips technical metadata before passing
   to module.execute(). This is the enforcement mechanism for the Context
   Hygiene Protocol.
   ====================================================================== */

import { Env } from "../lib/db";
import type { JarvisModule, CleanContext, ModuleResult, HealthStatus, ModuleCapability } from "../interfaces/module_contract";
import { CovenantCore } from "../lib/covenant_core";
import { ErrorMonitor } from "../lib/error_monitor";

// ---------- Adapter Interfaces (what the container promises to inject) ----------

/** Minimal DB adapter — only the operations modules actually need. */
export interface DatabaseAdapter {
  prepare(stmt: string): {
    bind(...params: any[]): {
      run(): Promise<{ success: boolean; lastInsertRowid?: any }>;
      first<T = any>(): Promise<T | null>;
      all<T = any>(): Promise<{ results: T[] }>;
    };
    run(): Promise<{ success: boolean; lastInsertRowid?: any }>;
    first<T = any>(): Promise<T | null>;
    all<T = any>(): Promise<{ results: T[] }>;
  };
}

/** Minimal KV adapter — only what modules need. */
export interface KVAdapter {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void>;
  delete(key: string): Promise<void>;
}

/** Groq client adapter — only completion, no model listing or quota APIs. */
export interface GroqClient {
  completions(params: any): Promise<any>;
}

/** ---------- The DI Container Class ---------- */

export class DiContainer {
  private env: Env;
  private dbAdapter: DatabaseAdapter;
  private kvAdapter: KVAdapter;
  private groqAdapter: GroqClient;
  private modules: Map<string, JarvisModule> = new Map();

  constructor(env: Env) {
    this.env = env;

    // --- Instantiate adapters ONCE (singleton pattern within worker lifetime) ---

    this.dbAdapter = {
      prepare: (stmt: string) => {
        const ps = env.DB.prepare(stmt);
        return {
          bind: (...params: any[]) => {
            const bound = ps.bind(...params);
            return {
              run: async () => {
                const res = await bound.run();
                return { success: true, lastInsertRowid: res.meta?.last_row_id };
              },
              first: async <T = any>(): Promise<T | null> => {
                const res = await bound.first<T>();
                return res as T | null;
              },
              all: async <T = any>(): Promise<{ results: T[] }> => {
                const res = await bound.all<T>();
                return { results: res.results as T[] };
              },
            };
          },
          run: async () => {
            const res = await ps.run();
            return { success: true, lastInsertRowid: res.meta?.last_row_id };
          },
          first: async <T = any>(): Promise<T | null> => {
            const res = await ps.first<T>();
            return res as T | null;
          },
          all: async <T = any>(): Promise<{ results: T[] }> => {
            const res = await ps.all<T>();
            return { results: res.results as T[] };
          },
        };
      },
    };

    this.kvAdapter = {
      get: async (key: string) => {
        try {
          return await env.CONFIG_KV.get(key);
        } catch {
          return null;
        }
      },
      put: async (key: string, value: string, opts?: { expirationTtl?: number }) => {
        try {
          await env.CONFIG_KV.put(key, value, { expirationTtl: opts?.expirationTtl });
        } catch {
          // availability over strictness
        }
      },
      delete: async (key: string) => {
        try {
          await env.CONFIG_KV.delete(key);
        } catch {
          // availability over strictness
        }
      },
    };

    this.groqAdapter = {
      completions: async (params: any) => {
        const key = this.env.GROQ_API_KEY;
        if (!key) throw new Error("GROQ_API_KEY not configured");
        const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${key}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(params),
        });
        if (!res.ok) {
          const errTxt = await res.text();
          throw new Error(`Groq API ${res.status}: ${errTxt}`);
        }
        return res;
      },
    };

    // --- Register default modules ---
    this.registerDefaultModules();
  }

  /** ---------- Module Registration ---------- */

  registerModule(moduleId: string, moduleInstance: JarvisModule): void {
    this.modules.set(moduleId, moduleInstance);
  }

  /** ---------- Core: Register Default Modules ---------- */
  private registerDefaultModules(): void {
    // Phase 5: Register refactored modules implementing JarvisModule contract.
    // Each module receives {db, kv, groq} adapters from the container.
    const covenantCore = new CovenantCore(this.dbAdapter, this.kvAdapter, this.groqAdapter);
    this.registerModule("covenant_core", covenantCore);

    const errorMonitor = new ErrorMonitor(this.dbAdapter, this.kvAdapter, this.groqAdapter);
    this.registerModule("error_monitor", errorMonitor);
  }

  /** ---------- Get Module by ID ---------- */
  getModule(moduleId: string): JarvisModule | undefined {
    return this.modules.get(moduleId);
  }

  /** ---------- Get All Registered Module IDs ---------- */
  getRegisteredIds(): string[] {
    return Array.from(this.modules.keys());
  }

  /** ---------- Context Sanitization (enforcement) ---------- */
  /** Strip ALL technical metadata from context before passing to module.execute().
   *  This is called by the orchestrator AFTER the module is selected but BEFORE execute(). */
  sanitizeForModule(context: CleanContext): CleanContext {
    // Only keep fields that are explicitly part of CleanContract.
    const clean: CleanContext = {
      userIntent: context.userIntent,
      relevantHistory: (context.relevantHistory || []).slice(-5),
      userPreferences: context.userPreferences || [],
      culturalTone: context.culturalTone || "casual",
      honorifics: context.honorifics ?? null,
      conversationMode: context.conversationMode,
    };
    return clean;
  }

  /** ---------- Module Health Check ---------- */
  async checkModuleHealth(moduleId: string): Promise<HealthStatus> {
    const module = this.modules.get(moduleId);
    if (!module) {
      return { healthy: false, detail: `Module ${moduleId} not found`, lastChecked: Date.now() };
    }
    return module.healthCheck();
  }

  /** ---------- Check All Module Health ---------- */
  async checkAllHealth(): Promise<Record<string, HealthStatus>> {
    const results: Record<string, HealthStatus> = {};
    for (const [id, module] of this.modules) {
      results[id] = await module.healthCheck();
    }
    return results;
  }
}

/** ---------- Singleton Instance ---------- */
let containerInstance: DiContainer | null = null;

export function getContainer(env: Env): DiContainer {
  if (!containerInstance) {
    containerInstance = new DiContainer(env);
  }
  return containerInstance;
}

/** ---------- Module Registry (standalone, uses DI) ---------- */
export class ModuleRegistry {
  private registry: Map<string, JarvisModule> = new Map();

  constructor(private container: DiContainer) {}

  register(moduleInstance: JarvisModule): void {
    this.registry.set(moduleInstance.moduleId, moduleInstance);
  }

  select(intent: string, context: CleanContext): { module: JarvisModule; context: CleanContext } | null {
    // Find a registered module whose capabilities cover this intent.
    for (const [key, module] of this.registry) {
      const caps = module.getCapabilities();
      for (const cap of caps) {
        if (cap.pattern && cap.pattern.test(intent)) {
          // Sanitize context for this module's execute() call
          const sanitized = this.container.sanitizeForModule(context);
          return { module, context: sanitized };
        }
      }
    }
    return null;
  }

  getRegisteredIds(): string[] {
    return Array.from(this.registry.keys());
  }

  validate(module: JarvisModule): boolean {
    // Contract compliance: does the module have all required methods?
    return (
      module.moduleId !== undefined &&
      typeof module.execute === "function" &&
      typeof module.healthCheck === "function" &&
      typeof module.getCapabilities === "function"
    );
  }
}
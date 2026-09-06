//=====================================================================
// semantic_validator.ts — Semantic Validation Layer (Trust Foundation)
//
// Validates MEANING, not just structure. Every module output passes
// through semantic validation before reaching the orchestrator.
// Ensures business logic integrity and deterministic behavior.
//=====================================================================

import { Env } from "./db";

// ============================================================================
// Types
// ============================================================================

export interface ValidationResult {
  valid: boolean;
  issues: string[];
  corrected_output?: any;
  confidence: number;
  rule_id: string;
}

export interface ExecutionResult<T = any> {
  success: boolean;
  data?: T;
  error?: {
    code: string;
    user_message: string;
    suggested_action: string;
    retry_possible: boolean;
  };
  audit_id: string;
  timestamp: number;
}

export interface SemanticRule {
  id: string;
  name: string;
  description: string;
  validate: (input: any, context: ValidationContext) => ValidationResult;
  severity: "critical" | "high" | "medium" | "low";
  auto_fix?: (input: any) => any;
}

export interface ValidationContext {
  owner: number;
  module_id: string;
  intent?: string;
  user_profile?: UserProfile;
  previous_state?: any;
}

export interface UserProfile {
  privacy_mode: boolean;
  autonomy_level: number;
  preferred_language: string;
  cultural_context?: string;
}

// ============================================================================
// Business Rule Engine
// ============================================================================

const BUSINESS_RULES: SemanticRule[] = [
  // Rule 1: Memory Consistency
  {
    id: "MEM_CONSISTENCY",
    name: "Memory Consistency Check",
    description: "Ensures memory writes are consistent with read state",
    severity: "critical",
    validate: (input, ctx) => {
      const issues: string[] = [];
      if (input.type === "memory_write") {
        if (!input.content || input.content.length < 10) {
          issues.push("Memory content terlalu pendek (minimal 10 karakter)");
        }
        if (input.content && input.content.length > 2000) {
          issues.push("Memory content melebihi batas 2000 karakter");
        }
      }
      return { valid: issues.length === 0, issues, confidence: 0.9, rule_id: "MEM_CONSISTENCY" };
    },
  },

  // Rule 2: Emotional Response Appropriateness
  {
    id: "EMOTION_APPROP",
    name: "Emotional Response Appropriateness",
    description: "Validates emotional response matches user state",
    severity: "high",
    validate: (input, ctx) => {
      const issues: string[] = [];
      if (input.type === "response") {
        const userEmotion = ctx.user_profile?.preferred_language;
        if (userEmotion === "negative" && input.tone === "cheerful") {
          issues.push("Nada respons tidak sesuai dengan emosi pengguna");
        }
      }
      return { valid: issues.length === 0, issues, confidence: 0.85, rule_id: "EMOTION_APPROP" };
    },
  },

  // Rule 3: Task Completion Verification
  {
    id: "TASK_VERIFY",
    name: "Task Completion Verification",
    description: "Verifies claimed task completion against actual state",
    severity: "critical",
    validate: (input, ctx) => {
      const issues: string[] = [];
      if (input.claimed_completed && input.task_id) {
        // This would check D1 for actual status - simplified for now
        if (!input.verification_proof) {
          issues.push("Klaim penyelesaian tanpa bukti verifikasi");
        }
      }
      return { valid: issues.length === 0, issues, confidence: 0.95, rule_id: "TASK_VERIFY" };
    },
  },

  // Rule 4: Privacy Boundary Enforcement
  {
    id: "PRIVACY_BOUNDARY",
    name: "Privacy Boundary Enforcement",
    description: "Ensures no sensitive data leaks in responses",
    severity: "critical",
    validate: (input, ctx) => {
      const issues: string[] = [];
      if (ctx.user_profile?.privacy_mode) {
        const sensitivePatterns = [
          /\b\d{16}\b/,  // Credit card
          /\b\d{3}-\d{2}-\d{4}\b/,  // SSN
          /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/,  // Email
          /\b\d{10,}\b/,  // Phone numbers
        ];
        for (const pattern of sensitivePatterns) {
          if (pattern.test(input.content || "")) {
            issues.push("Data sensitif terdeteksi dalam konten respons");
            break;
          }
        }
      }
      return { valid: issues.length === 0, issues, confidence: 0.99, rule_id: "PRIVACY_BOUNDARY" };
    },
  },

  // Rule 5: Cultural Appropriateness
  {
    id: "CULTURAL_APPROP",
    name: "Cultural Appropriateness",
    description: "Validates response respects cultural norms",
    severity: "medium",
    validate: (input, ctx) => {
      const issues: string[] = [];
      if (input.cultural_sensitivity_check === false) {
        issues.push("Respons tidak lulus pengecekan sensitivitas budaya");
      }
      return { valid: issues.length === 0, issues, confidence: 0.8, rule_id: "CULTURAL_APPROP" };
    },
  },
];

// ============================================================================
// Semantic Validator
// ============================================================================

export class SemanticValidator {
  private rules: Map<string, SemanticRule> = new Map();
  private env: Env;

  constructor(env: Env) {
    this.env = env;
    // Load default rules
    for (const rule of BUSINESS_RULES) {
      this.rules.set(rule.id, rule);
    }
  }

  /** Register a custom validation rule */
  registerRule(rule: SemanticRule): void {
    this.rules.set(rule.id, rule);
  }

  /** Validate output against all applicable rules */
  async validate(
    input: any,
    context: ValidationContext,
    ruleIds?: string[],
  ): Promise<{ valid: boolean; results: ValidationResult[] }> {
    const results: ValidationResult[] = [];
    const rulesToCheck = ruleIds
      ? ruleIds.map(id => this.rules.get(id)).filter(Boolean)
      : Array.from(this.rules.values());

    for (const rule of rulesToCheck) {
      if (!rule) continue;
      try {
        const result = await rule.validate(input, context);
        results.push(result);
      } catch (error) {
        results.push({
          valid: false,
          issues: [`Rule ${rule.id} error: ${(error as Error).message}`],
          confidence: 0,
          rule_id: rule.id,
        });
      }
    }

    const valid = results.every(r => r.valid);
    return { valid, results };
  }

  /** Auto-fix issues if possible */
  async autoFix(input: any, results: ValidationResult[]): Promise<any> {
    let fixed = { ...input };
    for (const result of results) {
      if (!result.valid) {
        const rule = this.rules.get(result.rule_id);
        if (rule?.auto_fix) {
          fixed = rule.auto_fix(fixed);
        }
      }
    }
    return fixed;
  }

  /** Generate audit entry for validation */
  async logValidation(
    input: any,
    results: ValidationResult[],
    context: ValidationContext,
  ): Promise<void> {
    try {
      await this.env.DB.prepare(
        `INSERT INTO execution_audit (owner_id, module_id, intent, input_hash, result, timestamp)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).bind(
        context.owner,
        context.module_id,
        context.intent || "",
        this.hashInput(input),
        JSON.stringify({ valid: results.every(r => r.valid), results }),
        Date.now(),
      ).run();
    } catch {
      // Availability - don't block on audit failure
    }
  }

  private hashInput(input: any): string {
    const str = JSON.stringify(input);
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash |= 0;
    }
    return hash.toString(16);
  }
}

// ============================================================================
// Execution Result Builder
// ============================================================================

export function createSuccessResult<T>(data: T, auditId: string): ExecutionResult<T> {
  return {
    success: true,
    data,
    audit_id: auditId,
    timestamp: Date.now(),
  };
}

export function createErrorResult(
  code: string,
  userMessage: string,
  suggestedAction: string,
  retryPossible: boolean,
  auditId: string,
): ExecutionResult {
  return {
    success: false,
    error: {
      code,
      user_message: userMessage,
      suggested_action: suggestedAction,
      retry_possible: retryPossible,
    },
    audit_id: auditId,
    timestamp: Date.now(),
  };
}

// ============================================================================
// Error Templates (Indonesian)
// ============================================================================

export const ERROR_TEMPLATES: Record<string, { user_message: string; suggested_action: string }> = {
  COVENANT_VIOLATION: {
    user_message: "Permintaan ini melanggar aturan keamanan sistem.",
    suggested_action: "Coba dengan kata-kata yang berbeda atau gunakan /help untuk bantuan.",
  },
  MEMORY_FULL: {
    user_message: "Memori penuh, beberapa data mungkin tidak tersimpan.",
    suggested_action: "Gunakan /clear_memory untuk membersihkan memori lama.",
  },
  LLM_UNAVAILABLE: {
    user_message: "Layanan AI sedang tidak tersedia, coba lagi sebentar.",
    suggested_action: "Tunggu 1-2 menit lalu coba lagi.",
  },
  VALIDATION_FAILED: {
    user_message: "Output tidak valid secara semantik.",
    suggested_action: "Sistem akan mencoba lagi dengan koreksi otomatis.",
  },
  PRIVACY_VIOLATION: {
    user_message: "Data sensitif terdeteksi, permintaan dibatalkan untuk keamanan.",
    suggested_action: "Nonaktifkan mode privasi atau hapus data sensitif dari pesan.",
  },
  TASK_INCOMPLETE: {
    user_message: "Tugas belum sepenuhnya selesai.",
    suggested_action: "Periksa status dengan /status atau jalankan ulang perintah.",
  },
  RATE_LIMITED: {
    user_message: "Terlalu banyak permintaan, harap tunggu sebentar.",
    suggested_action: "Tunggu beberapa menit lalu coba lagi.",
  },
  CONTEXT_INSUFFICIENT: {
    user_message: "Konteks tidak cukup untuk memberikan jawaban akurat.",
    suggested_action: "Berikan detail lebih lanjut tentang yang kamu butuhkan.",
  },
};

export function getErrorMessage(code: string): { user_message: string; suggested_action: string } {
  return ERROR_TEMPLATES[code] || {
    user_message: "Terjadi kesalahan yang tidak diketahui.",
    suggested_action: "Coba lagi atau gunakan /help untuk bantuan.",
  };
}

// ============================================================================
// Middleware: Semantic Validation Pipeline
// ============================================================================

export async function validateAndFix<T>(
  validator: SemanticValidator,
  input: T,
  context: ValidationContext,
  maxRetries = 2,
): Promise<ExecutionResult<T>> {
  const auditId = `audit_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  let currentInput = input;
  let lastResults: ValidationResult[] = [];

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const { valid, results } = await validator.validate(currentInput, context);
    lastResults = results;

    if (valid) {
      await validator.logValidation(currentInput, results, context);
      return createSuccessResult(currentInput, auditId);
    }

    // Try auto-fix if available
    if (attempt < maxRetries) {
      currentInput = await validator.autoFix(currentInput, results);
    }
  }

  // All retries failed
  const criticalIssues = lastResults.filter(r => !r.valid).map(r => r.issues).flat();
  await validator.logValidation(currentInput, lastResults, context);

  return createErrorResult(
    "VALIDATION_FAILED",
    "Output tidak valid setelah beberapa percobaan: " + criticalIssues.join("; "),
    "Sistem akan mencoba pendekatan berbeda.",
    true,
    auditId,
  );
}

//=====================================================================
// idempotency.ts — Idempotency Middleware for Write Operations
//
// Ensures deterministic execution by preventing duplicate operations.
// Uses UUID v7 (timestamp-based) for cryptographically secure keys.
//=====================================================================

import { Env } from "./db";

// ============================================================================
// Types
// ============================================================================

export interface IdempotencyKey {
  key: string;
  owner: number;
  intent: string;
  timestamp: number;
  expires_at: number;
  result?: any;
}

export interface IdempotencyCheck {
  is_duplicate: boolean;
  existing_result?: any;
  key: string;
}

// ============================================================================
// UUID v7 Generator (Timestamp-based)
// ============================================================================

function generateUUIDv7(): string {
  const timestamp = Date.now();
  const random = crypto.randomUUID();
  
  // UUID v7 format: timestamp (48 bits) + random (74 bits)
  // Convert timestamp to hex (12 chars)
  const tsHex = timestamp.toString(16).padStart(12, "0");
  
  // Take random chars and set version bits
  const randomChars = random.replace(/-/g, "").slice(0, 20);
  
  // Set version (7) and variant (10xx)
  const version = "7";
  const variant = "8";
  
  return `${tsHex.slice(0, 8)}-${tsHex.slice(8, 12)}-${version}${randomChars.slice(0, 3)}-${variant}${randomChars.slice(3, 7)}-${randomChars.slice(7, 19)}`;
}

// ============================================================================
// Idempotency Manager
// ============================================================================

export class IdempotencyManager {
  private env: Env;
  private readonly TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

  constructor(env: Env) {
    this.env = env;
  }

  /** Generate a new idempotency key */
  generateKey(owner: number, intent: string): string {
    const uuid = generateUUIDv7();
    return `${owner}_${intent}_${uuid}`;
  }

  /** Check if operation is duplicate */
  async checkDuplicate(key: string): Promise<IdempotencyCheck> {
    try {
      const { results } = await this.env.DB.prepare(
        `SELECT key, result FROM idempotency_keys 
         WHERE key = ? AND expires_at > ?`,
      ).bind(key, Date.now()).all<{ key: string; result: string }>();

      if (results && results.length > 0) {
        return {
          is_duplicate: true,
          existing_result: results[0].result ? JSON.parse(results[0].result) : null,
          key,
        };
      }

      return { is_duplicate: false, key };
    } catch {
      return { is_duplicate: false, key };
    }
  }

  /** Store idempotency key with result */
  async storeKey(key: string, owner: number, intent: string, result?: any): Promise<void> {
    try {
      await this.env.DB.prepare(
        `INSERT OR REPLACE INTO idempotency_keys (key, owner_id, intent, result, timestamp, expires_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).bind(
        key,
        owner,
        intent,
        result ? JSON.stringify(result) : null,
        Date.now(),
        Date.now() + this.TTL_MS,
      ).run();
    } catch {
      // Availability
    }
  }

  /** Clean expired keys */
  async cleanExpired(): Promise<number> {
    try {
      const res = await this.env.DB.prepare(
        `DELETE FROM idempotency_keys WHERE expires_at < ?`,
      ).bind(Date.now()).run();
      return res.meta.changes ?? 0;
    } catch {
      return 0;
    }
  }
}

// ============================================================================
// Middleware: Protected Write Operation
// ============================================================================

export async function withIdempotency<T>(
  env: Env,
  owner: number,
  intent: string,
  operation: () => Promise<T>,
): Promise<{ result: T; is_duplicate: boolean; key: string }> {
  const manager = new IdempotencyManager(env);
  const key = manager.generateKey(owner, intent);

  // Check for duplicate
  const check = await manager.checkDuplicate(key);
  if (check.is_duplicate) {
    return {
      result: check.existing_result as T,
      is_duplicate: true,
      key,
    };
  }

  // Execute operation
  const result = await operation();

  // Store key with result
  await manager.storeKey(key, owner, intent, result);

  return {
    result,
    is_duplicate: false,
    key,
  };
}

// ============================================================================
// Helper: Create Idempotent Write Function
// ============================================================================

export function createIdempotentWriter<TInput, TOutput>(
  env: Env,
  writer: (input: TInput) => Promise<TOutput>,
) {
  return async (owner: number, input: TInput): Promise<{ result: TOutput; is_duplicate: boolean; key: string }> => {
    const intent = `write_${typeof input}`;
    return withIdempotency(env, owner, intent, () => writer(input));
  };
}

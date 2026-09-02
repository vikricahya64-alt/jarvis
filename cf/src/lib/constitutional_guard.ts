//=====================================================================
// constitutional_guard.ts — fail-closed validation of autonomous actions.
//
// Ported from L11 python (utils/constitutional_guard) to edge TS. In the old
// python it was an importable module; here it is an explicit dependency-free
// rule engine so the edge never needs an extra package. The constitution is
// persisted in dms_state.config_json.constitution and is owner-editable via
// `/value_alignment` confirmations.
//
// A guard is FAIL-CLOSED: if validation can't run or a rule is doubtful,
// the action is BLOCKED (never silently approved).
//=====================================================================

import { Env } from "./db";

export interface GuardResult {
  allowed: boolean;
  violated_principle: string | null;
  reasoning: string;
  confidence: number;
}

/** Built-in immutable principles (the "sovereignty constitution"). */
const PRINCIPLES: Array<{ id: string; key: string; reason: string }> = [
  { id: "no_deceive", key: "deceive/trick/manipulate", reason: "J.A.R.V.I.S. tidak boleh menipu pemilik." },
  { id: "no_destroy", key: "wipe/delete/erase/destroy/terminate", reason: "Tindakan destruktif perlu izin eksplisit." },
  { id: "no_exfiltrate", key: "share/publish/transfer/sell/release", reason: "PII/aset tidak boleh dibocorkan tanpa izin." },
  { id: "no_autonomy_destructive", key: "kill/override/hard reset/full wipe", reason: "Saklar kelangsungan dipegang pemilik." },
  { id: "no_money", key: "money/payment/bayar/transfer uang/otp/identity", reason: "Aksi finansial/identitas butuh persetujuan manusia." },
];

/** Keyword-based autonomous risk estimator (cheap, deterministic). */
export function riskScore(text: string): number {
  const low = (text || "").toLowerCase();
  const high = ["delete", "hapus", "wipe", "terminate", "kill", "transfer",
    "release", "share", "publish", "sell", "money", "payment", "bayar",
    "transfer uang", "password", "pin", "otp", "identity", "publish"];
  const mid = ["send", "kirim", "email", "calendar", "jadwal", "write", "tulis"];
  if (high.some((w) => low.includes(w))) return 0.9;
  if (mid.some((w) => low.includes(w))) return 0.5;
  return 0.1;
}

/**
 * Fail-closed "no constitution" whitelist (python `_ALLOWED_BY_DEFAULT`).
 * When the owner has not yet ratified a constitution, only demonstrably
 * HARMLESS, read-only, reversible actions bypass the guard. Everything else
 * is BLOCKED with `no_constitution`. Match is substring on the action text.
 */
const ALLOWED_BY_DEFAULT: string[] = [
  "status", "/status", "/health", "help", "/help", "/profile", "time",
  "jam", "cuaca", "weather", "/note", "/todo", "/reminder", "set alarm",
  "read my messages", "baca pesan", "show", "tampilkan", "list", "daftar",
  "/list", "/vault list", "what is", "apa itu", "summarize", "ringkas",
  "translate", "terjemahkan", "remind", "rekap", "search", "cari",
];

function isWhitelisted(actionDesc: string): boolean {
  const low = (actionDesc || "").toLowerCase();
  return ALLOWED_BY_DEFAULT.some((k) => low.includes(k));
}

/** Conflict detection vs stored explicit 'never/stop' command rules. */
export function conflictScore(actionDesc: string, rules: Array<{ phrase: string; disable: boolean }> = []): number {
  const low = (actionDesc || "").toLowerCase();
  if (!rules || !low) return 0.0;
  let best = 0.0;
  for (const r of rules) {
    if (!r || !r.disable) continue;
    const phrase = (r.phrase || "").toLowerCase();
    if (!phrase) continue;
    const tokensR = new Set(phrase.split(" ").filter((t) => t.length > 2));
    const tokensA = new Set(low.split(" ").filter((t) => t.length > 2));
    const inter = [...tokensR].filter((t) => tokensA.has(t));
    if (inter.length) {
      const ratio = inter.length / Math.max(1, tokensR.size);
      best = Math.max(best, Math.min(1, ratio));
    }
  }
  return Number(best.toFixed(3));
}

/**
 * Fail-closed autonomy validation. Called on `origin === "user"/"autonomous"`.
 * Returns allowed=false if any principle/rule is violated, guard can't run, or
 * explicit constitution entails. Never returns allowed when in doubt.
 */
export function validateAction(actionDesc: string, options: {
  origin?: string;
  risk?: number;
  commandRules?: Array<{ phrase: string; disable: boolean }>;
  constitution?: Record<string, unknown>;
} = {}): GuardResult {
  const risk = options.risk ?? riskScore(actionDesc);

  // 1) Stored explicit 'never/stop' rules (harder than built-ins).
  const explicitConflict = conflictScore(actionDesc, options.commandRules);
  if (explicitConflict >= 0.6) {
    return {
      allowed: false,
      violated_principle: "command_hierarchy",
      reasoning: `Konflik eksplisit "never/stop" (score ${explicitConflict}).`,
      confidence: 1.0,
    };
  }

  // 2) Built-in principles (substring).
  const low = (actionDesc || "").toLowerCase();
  for (const p of PRINCIPLES) {
    const keys = p.key.split("/");
    if (keys.some((k) => low.includes(k.trim()))) {
      return {
        allowed: false,
        violated_principle: p.id,
        reasoning: p.reason,
        confidence: 1.0,
      };
    }
  }

  // 3) Custom constitution (owner-editable), if any string fields exist.
  if (options.constitution && typeof options.constitution === "object") {
    const customRules = Object.values(options.constitution)
      .filter((v): v is string => typeof v === "string" && v.length > 0)
      .map(String);
    for (const cr of customRules) {
      const ck = cr.toLowerCase().split(" ").filter((t) => t.length > 3).join(" ");
      if (ck && low.includes(ck)) {
        return {
          allowed: false,
          violated_principle: "custom_constitution",
          reasoning: `Kebijakan konstitusi khusus dilanggar: ${cr.slice(0, 80)}`,
          confidence: 1.0,
        };
      }
    }
  }

  // 4) Generic risk: high-risk autonomous without explicit consent signal.
  if (risk > Number(options.constitution?.risk_ceiling ?? 0.9)) {
    return {
      allowed: false,
      violated_principle: "autonomy_risk",
      reasoning: `Autonomous risk ${risk.toFixed(2)} di atas batas konstitusi.`,
      confidence: 1.0,
    };
  }

  // 5) FAIL-CLOSED NO-CONSTITUTION: without a ratified constitution, only
  //    harmless whitelisted read-only actions pass; everything else blocks.
  //    This is the python `validate_action` `no_constitution` behavior — the
  //    single biggest safety upgrade over the naive keyword-only v1 port.
  const hasConstitution =
    !!options.constitution &&
    typeof options.constitution === "object" &&
    Object.keys(options.constitution).length > 0;
  if (!hasConstitution && !isWhitelisted(actionDesc)) {
    return {
      allowed: false,
      violated_principle: "no_constitution",
      reasoning: "Konstitusi belum diratifikasi; aksi non-whitelist diblokir (fail-closed).",
      confidence: 1.0,
    };
  }

  // All clear.
  return {
    allowed: true,
    violated_principle: null,
    reasoning: "Melewati konstitusi (fail-closed).",
    confidence: 1.0,
  };
}

/** Ref number for /value_alignment report of guard hits. */
export function guardStats(hits: GuardResult[]): { blocked: number; allowed: number } {
  return { blocked: hits.filter((h) => !h.allowed).length, allowed: hits.filter((h) => h.allowed).length };
}
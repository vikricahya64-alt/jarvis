//=====================================================================
// structured.ts — Instructor-style structured output scaffolding.
//
// Keeps small-LLM sub-agent calls composable and cheap without a full
// framework: each role returns a TYPED object, not free prose. Validation
// doubles as the critic — malformed worker output is retried once with the
// validation error, then discarded (fail-closed to caller fallback). This
// is the cheapest substitute for a full critic-LLM loop (Madaan Self-Refine
// is too token-heavy for the free tier; SkepticAgent/critic roles are only
// affordable as a one-shot, sparingly — see subagents.ts verifier).
//
// 100% free tier. No new D1/KV/Worker — pure in-memory logic.
//=====================================================================

/** A lightweight runtime validator: given an unknown parsed value, return
 *  null if it's valid, or a human-readable error string. */
export type Validator<T> = (v: unknown) => string | null;

export function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Compose a validator for a set of required fields (string-typed, with
 *  optional per-field predicates). Extra keys are ignored. */
export function stringFieldsValidator<T extends object>(
  fields: Array<[keyof T & string, string]>,
  predicates: Partial<Record<keyof T & string, (s: string) => boolean>> = {},
): Validator<T> {
  return (v) => {
    if (!isObj(v)) return "objektif: bukan objek JSON";
    for (const [key, label] of fields) {
      const fv = v[key as string];
      if (typeof fv !== "string" || !fv.trim()) {
        return `objektif: field '${label}' wajib bertipe string non-kosong`;
      }
      const pred = predicates[key];
      if (pred && !pred(String(fv))) return `objektif: field '${label}' tidak valid`;
    }
    return null;
  };
}

/** Extract a fenced JSON block from free text (```json ... ``` or a bare
 *  {...} region). Returns the matching substring, or null. */
export function extractJsonBlock(text: string): string | null {
  if (!text) return null;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) return fenced[1].trim();
  const bare = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (bare >= 0 && end > bare) return text.slice(bare, end + 1);
  return null;
}

/** Instructor-style: parse `raw` against a validator, and if it fails, do one
 *  corrective re-prompt via `retry(raw, error)` (the caller provides the LLM
 *  retry call). Returns the parsed value or null on final failure. */
export async function parseStructured<T>(
  raw: unknown,
  validator: Validator<T>,
  retry: (error: string) => Promise<string | null>,
): Promise<T | null> {
  if (typeof raw !== "string") return null;
  const block = extractJsonBlock(raw);
  if (!block) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(block);
  } catch {
    return null;
  }
  let err = validator(parsed);
  if (!err) return parsed as T;
  // One corrective pass — cheap critic. If it still fails, fail-closed.
  const again = await retry(err);
  if (!again) return null;
  const block2 = extractJsonBlock(again);
  if (!block2) return null;
  try {
    const parsed2: unknown = JSON.parse(block2);
    if (validator(parsed2) === null) return parsed2 as T;
  } catch {
    /* fall through */
  }
  return null;
}

/** Clean minimal leading punctuation/whitespace from a value intended as a
 *  JSON string (LLMs occasionally wrap values in code fences). */
export function cleanStr(v: unknown): string {
  if (typeof v !== "string") return "";
  return v.trim().replace(/^[`"' ]+|[`"' ]+$/g, "");
}

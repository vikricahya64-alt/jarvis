/**
 * Optional Go/wasm accelerator.
 *
 * This is NOT a replacement for the TypeScript implementations. It is a
 * native implementation of two CPU-bound helpers, held to byte-identical parity
 * by cf/gomod/jarvis_test.go against fixtures generated from the live TS code.
 *
 * Two rules make it safe to ship:
 *
 *  1. Every function has a TS fallback and the TS result is authoritative.
 *     If the module is absent, too large for workerd, fails to boot, or returns
 *     something unexpected, callers get the TS answer. Go is never on the
 *     critical path for correctness.
 *  2. Booting is lazy and happens at most once per isolate. The Go runtime
 *     costs ~600KB of the isolate budget and boot time, so paying it for a
 *     request that never touches these helpers would be pure waste.
 *
 * Measured caveat: this module has NOT been shown to be faster than the JS it
 * mirrors. `performance.now()` does not resolve sub-millisecond values in
 * workerd, so a trustworthy comparison has never been produced. It is wired in
 * behind GO_WASM=off until that measurement exists.
 */

// wasm_exec.js is Go's JS bridge (from $(go env GOROOT)/lib/wasm). It is not a
// module - it assigns globalThis.Go and exports nothing - so it is imported for
// its side effect. Without it the module below cannot boot and silently falls
// back to TypeScript, which is why /wasm_diag reports active:false if this
// import is ever dropped.
import "../../gomod/wasm_exec.js";

// Plain path, not Vite's "?module" suffix: this is bundled by wrangler/esbuild,
// which takes a bare .wasm import (verified in cf/gomod/README.md).
// @ts-ignore -- .wasm has no ambient module declaration
import wasmModule from "../../gomod/jarvis.wasm";

/** The slice of the Go runtime bridge in wasm_exec.js that we actually use. */
type GoRuntime = {
  importObject: WebAssembly.Imports;
  run(instance: WebAssembly.Instance): void;
};

type GoGlobals = {
  goReady?: boolean;
  goNormalize?: (s: string) => string;
  goNormalizeLink?: (s: string) => string;
};

let booting: Promise<GoGlobals | null> | null = null;

/** Disable the Go path without touching call sites. */
function goEnabled(env: { GO_WASM?: string }): boolean {
  return env.GO_WASM !== "off";
}

async function boot(env: { GO_WASM?: string }): Promise<GoGlobals | null> {
  if (booting) return booting;
  booting = (async () => {
    try {
      // wasm_exec.js reaches for fs.writeSync unguarded on Go stdout/stderr.
      // workerd has no fs, so any Go print would otherwise kill the isolate.
      const g = globalThis as unknown as { fs?: unknown; Go?: new () => GoRuntime };
      if (!g.fs) g.fs = { writeSync() {}, write() {} };
      if (typeof g.Go !== "function") return null;

      const go = new g.Go();
      const inst = await WebAssembly.instantiate(wasmModule, go.importObject);
      // Non-blocking: a Go main() that returns tears the isolate down.
      go.run(inst as unknown as WebAssembly.Instance);
      for (let i = 0; i < 400 && !(globalThis as GoGlobals).goReady; i++) {
        await new Promise((r) => setTimeout(r, 5));
      }
      const gg = globalThis as GoGlobals;
      return gg.goReady === true ? gg : null;
    } catch {
      // Any failure means "use the TypeScript path", never an outage.
      return null;
    }
  })();
  return booting;
}

/**
 * Normalize text: lowercase, NFD, strip U+0300..U+036F.
 * Falls back to the TS implementation in src/lib/moderation.ts.
 */
export async function goNormalizeOrTs(env: { GO_WASM?: string }, input: string, tsFallback: () => string): Promise<string> {
  if (!goEnabled(env) || !input) return tsFallback();
  const g = await boot(env);
  if (!g?.goNormalize) return tsFallback();
  try {
    const out = g.goNormalize(input);
    // A native helper that cannot produce a string is a failure, not a value.
    return typeof out === "string" ? out : tsFallback();
  } catch {
    return tsFallback();
  }
}

/**
 * Canonicalize a URL for comparison. Falls back to
 * normalizeLinkForCompare() in src/lib/verifier.ts.
 */
export async function goNormalizeLinkOrTs(env: { GO_WASM?: string }, input: string, tsFallback: () => string): Promise<string> {
  if (!goEnabled(env) || !input) return tsFallback();
  const g = await boot(env);
  if (!g?.goNormalizeLink) return tsFallback();
  try {
    const out = g.goNormalizeLink(input);
    return typeof out === "string" ? out : tsFallback();
  } catch {
    return tsFallback();
  }
}

/** True once the Go runtime is live in this isolate. Diagnostic only. */
export async function goWasmActive(env: { GO_WASM?: string }): Promise<boolean> {
  return goEnabled(env) && (await boot(env)) !== null;
}
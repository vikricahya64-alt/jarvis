# Go → WebAssembly spike (feasibility, measured 2026-10-06)

Question: can Go run inside the existing Cloudflare Workers environment,
without replacing it?

Answer: **yes**, via `GOOS=js GOARCH=wasm` plus a `.wasm` import. Verified by
deploying to real workerd, not a local simulator.

## What worked

```go
func main() {
    js.Global().Set("jarvisNormalize", js.FuncOf(func(_ js.Value, a []js.Value) any {
        return Normalize(a[0].String())
    }))
    js.Global().Set("jarvisReady", true)
    <-make(chan struct{})   // keep the runtime alive
}
```

Built with `GOOS=js GOARCH=wasm go build -ldflags="-s -w"`.
Booted in workerd; the exported function executed correctly
(`"   Halo   DUNIA   transient  "` → `"halo dunia transient"`).

## Packaging rules discovered

- `import wasmModule from "./x.wasm"` (ES module). `[wasm_modules]` in
  wrangler.toml is rejected for ES-module workers.
- Service-worker syntax does accept `[wasm_modules]`, but the rest of `cf/`
  is ESM, so the import form is the one that fits.
- `wasm_exec.js` calls `fs.writeSync` **unguarded** for Go stdout/stderr.
  workerd has no `fs`, so any Go `fmt.Println` crashes the isolate. Provide
  `globalThis.fs = { writeSync(){}, write(){} }` before booting.
- Boot with `go.run(instance)` (non-blocking), then poll for the global your
  `main()` publishes.

## The ceiling (the decisive result)

Uncompressed `.wasm` size is a hard limit, not a soft one:

| binary | result |
|---|---|
| 1.99 MB, no `regexp` | boots |
| 2.04 MB, no `regexp` | boots, `goRuntimeBooted: true` |
| 2.60 MB, **with `regexp`** | **HTTP 503, Cloudflare error 1102** |

Error 1102 is "Worker exceeded resource limits". The ceiling sits between
2.04 MB and 2.60 MB of uncompressed wasm.

This matters because Go's `regexp` (RE2) is the single most attractive reason
to want Go here — linear-time matching, no catastrophic backtracking, the fix
for ReDoS. It is also the exact package that does not fit.

## Honest caveat on performance

Not measured, and this spike did not establish it: `performance.now()` in
workerd did not resolve sub-millisecond values, so every timing came back
`0ms` for both JS and wasm. **No performance conclusion should be drawn from
this directory.** Any claim that Go/wasm is faster here needs a proper
measurement harness first.

## What this rules in / out

- IN: a small Go module for CPU-bound, allocation-heavy helpers, with string
  scanning done by `strings`/`bytes` rather than `regexp`.
- OUT: a wholesale rewrite of `cf/`. 27k lines of TS with verified safety
  properties would not fit in a ~2 MB wasm budget, and moving I/O-bound code
  (D1, KV, Vectorize, cron, webhook) behind a JS↔wasm boundary adds cost
  rather than removing it.

//go:build js && wasm

// Entry point for the WebAssembly build consumed by cf/src/lib/go_wasm.ts.
//
// Kept deliberately small. The whole module has to fit inside the wasm size
// ceiling that workerd enforces (roughly 2.1MB uncompressed - past that the
// isolate fails with Cloudflare error 1102 on every request). Every dependency
// added to jarvis.go is charged against that budget, and
// TestWasmArtifactWithinBudget fails the build if it goes over.
package main

import (
	"syscall/js"

	"jarvis/gomod"
)

func main() {
	js.Global().Set("goNormalize", js.FuncOf(func(_ js.Value, a []js.Value) any {
		return gomod.Normalize(a[0].String())
	}))
	js.Global().Set("goNormalizeLink", js.FuncOf(func(_ js.Value, a []js.Value) any {
		return gomod.NormalizeLink(a[0].String())
	}))

	// Published only after both funcs are registered, so a caller that polls for
	// this never observes a half-initialised module.
	js.Global().Set("goReady", true)

	// Block forever: workerd tears the isolate down when the Go runtime returns,
	// and a returning main() would discard the registered functions.
	<-make(chan struct{})
}
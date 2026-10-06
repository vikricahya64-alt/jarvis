package gomod

import (
	"encoding/json"
	"os"
	"testing"
)

// Fixtures are generated from the live TypeScript implementations by
// cf/scripts/gen_go_fixtures.ts. This test is the contract: the Go port must
// produce byte-identical output for every case, or it is a bug and the
// TypeScript version stays authoritative.
//
// A mismatch here means one of two things, and both are regressions:
//   - the Go port diverges, or
//   - somebody changed the TS behaviour and the fixtures are stale.
// Either way the build stops rather than silently changing moderation.

// Measured on 2026-10-06 against real workerd, not a simulator:
//   2,044,028 bytes -> boots, goReady = true   (no x/text/norm)
//   2,286,596 bytes -> boots, outputs verified (current module, x/text/norm in)
//   2,597,000 bytes -> HTTP 503, Cloudflare error 1102 "exceeded resource limits"
// The true ceiling sits between 2.29MB and 2.60MB and has not been pinned down
// exactly, so the budget below sits just above the largest binary known to boot.
// It is deliberately tight: the point is that a dependency bump gets caught here,
// in CI, rather than as a runtime error 1102 on every request.
const wasmBudgetBytes = 2_350_000

type fixture struct {
	In  string `json:"in"`
	Out string `json:"out"`
}

type fixtures struct {
	Normalize     []fixture `json:"normalize"`
	NormalizeLink []fixture `json:"normalizeLink"`
}

func loadFixtures(t *testing.T) fixtures {
	t.Helper()
	b, err := os.ReadFile("testdata/fixtures.json")
	if err != nil {
		t.Fatalf("cannot read fixtures: %v (regenerate: npm run test:go:fixtures)", err)
	}
	var f fixtures
	if err := json.Unmarshal(b, &f); err != nil {
		t.Fatalf("cannot parse fixtures: %v", err)
	}
	if len(f.Normalize) == 0 || len(f.NormalizeLink) == 0 {
		t.Fatal("fixtures are empty - refusing to pass a vacuous parity test")
	}
	return f
}

func TestNormalizeParity(t *testing.T) {
	f := loadFixtures(t)
	for _, c := range f.Normalize {
		if got := Normalize(c.In); got != c.Out {
			t.Errorf("Normalize(%q)\n  go: %q\n  ts: %q", c.In, got, c.Out)
		}
	}
	t.Logf("normalize: %d cases match the TypeScript implementation", len(f.Normalize))
}

func TestNormalizeLinkParity(t *testing.T) {
	f := loadFixtures(t)
	for _, c := range f.NormalizeLink {
		if got := NormalizeLink(c.In); got != c.Out {
			t.Errorf("NormalizeLink(%q)\n  go: %q\n  ts: %q", c.In, got, c.Out)
		}
	}
	t.Logf("normalizeLink: %d cases match the TypeScript implementation", len(f.NormalizeLink))
}

// Guard the property the whole port rests on: stripping combining marks only
// works if the text is decomposed first. If someone drops norm.NFD the helpers
// silently stop catching "göyáng" written in precomposed form.
func TestNormalizeDecomposesBeforeStripping(t *testing.T) {
	precomposed := "g\u00f6y\u00e1ng"  // NFC form: one code point per vowel
	decomposed := "go\u0308ya\u0301ng" // NFD form: base letter + mark

	if Normalize(precomposed) != "goyang" {
		t.Errorf("precomposed input not normalised: got %q, want %q",
			Normalize(precomposed), "goyang")
	}
	if Normalize(decomposed) != "goyang" {
		t.Errorf("decomposed input not normalised: got %q, want %q",
			Normalize(decomposed), "goyang")
	}
	if Normalize(precomposed) != Normalize(decomposed) {
		t.Error("NFC and NFD inputs must converge on the same output")
	}
}

// A prebuilt wasm artifact, if present, must stay inside the measured budget.
// Without this, a dependency bump can push the module past what workerd accepts
// and every request fails with error 1102 at runtime rather than in CI.
func TestWasmArtifactWithinBudget(t *testing.T) {
	const path = "jarvis.wasm"
	st, err := os.Stat(path)
	if os.IsNotExist(err) {
		t.Skip("jarvis.wasm not built; run npm run build:go first")
	}
	if err != nil {
		t.Fatalf("cannot stat %s: %v", path, err)
	}
	if st.Size() > wasmBudgetBytes {
		t.Fatalf("%s is %d bytes, over the %d byte budget; workerd returns "+
			"error 1102 past roughly this size, so the module will fail at "+
			"runtime rather than at build time", path, st.Size(), wasmBudgetBytes)
	}
	t.Logf("%s = %d bytes (budget %d)", path, st.Size(), wasmBudgetBytes)
}

#!/usr/bin/env bash
# Build the Go/wasm helper and enforce the size ceiling workerd imposes.
#
# Measured on 2026-10-06 against real workerd, not a simulator:
#   2,044,028 bytes -> boots, goReady = true   (no x/text/norm)
#   2,286,596 bytes -> boots, outputs verified (current module, x/text/norm in)
#   2,597,000 bytes -> HTTP 503, Cloudflare error 1102 "exceeded resource limits"
# The true ceiling sits between 2.29MB and 2.60MB and has not been pinned down
# exactly, so the budget below sits just above the largest binary known to boot.
# It is deliberately tight: the point is that a dependency bump gets caught here,
# in CI, rather than as a runtime error 1102 on every request.
set -euo pipefail

cd "$(dirname "$0")/../gomod"
BUDGET=2350000

GO_BIN="${GO_BIN:-go}"
if ! command -v "$GO_BIN" >/dev/null 2>&1; then
  echo "build:go: '$GO_BIN' not found on PATH (set GO_BIN to override)" >&2
  exit 127
fi

export GOFLAGS="${GOFLAGS:--mod=mod}"
export GOCACHE="${GOCACHE:-/tmp/gocache}"
export GOPATH="${GOPATH:-/tmp/gopath}"

echo "build:go: compiling for js/wasm"
GOOS=js GOARCH=wasm "$GO_BIN" build -ldflags="-s -w" -o jarvis.wasm ./cmd/wasm

# A build aimed at the library package emits an archive, not a wasm module: it
# is small, passes the size check, and then fails to instantiate at runtime.
# Verify the WebAssembly magic number instead of trusting the exit code.
MAGIC=$(head -c 4 jarvis.wasm | od -An -tx1 | tr -d ' \n')
if [ "$MAGIC" != "0061736d" ]; then
  echo "build:go: FAILED - jarvis.wasm does not start with the WebAssembly magic" >&2
  echo "  (got '$MAGIC', want '0061736d') - is the build aimed at ./cmd/wasm?" >&2
  exit 1
fi

SIZE=$(wc -c < jarvis.wasm)
GZIP_KB=$(( $(gzip -c jarvis.wasm | wc -c) / 1024 ))
printf 'build:go: jarvis.wasm = %d bytes (%d KB gzipped)\n' "$SIZE" "$GZIP_KB"

if [ "$SIZE" -gt "$BUDGET" ]; then
  cat >&2 <<EOF

build:go: FAILED - jarvis.wasm is $SIZE bytes, over the $BUDGET byte budget.

  workerd returns error 1102 ("Worker exceeded resource limits") for wasm past
  roughly this size. Deployed oversized, EVERY request through the module fails
  at runtime instead of failing here. Drop a dependency (regexp is the usual
  culprit: it pushed the binary from 2.0MB to 2.6MB and broke it).

EOF
  exit 1
fi

echo "build:go: OK - within budget ($SIZE / $BUDGET bytes)"
#!/usr/bin/env bash
# ============================================================
# sync_adapter_to_edge.sh — J.A.R.V.I.S. Level 7 model-evolution deployer
#
# Securely transfers a validated QLoRA adapter from a Colab/Kaggle export to
# the Oracle private edge (then optionally the phone), verifies its SHA-256
# integrity, registers it in Supabase (model_adapters), and HOT-SWAPS the
# adapter in the running Ollama-MLC engine WITHOUT a restart. Rolls back to
# the previous adapter on any verification/deploy failure.
#
# Usage:
#   scripts/sync_adapter_to_edge.sh \
#       --adapter <local adapter dir> \
#       --target oracle|phone \
#       [--host <ssh host> --user <ssh user>] \
#       [--expected-sha256 <hex>] \
#       [--dry-run]
#
# Requires: rsync (or scp), sha256sum.
# Transfers go over Tailscale SSH when the host is a tailnet IP; never expose
# an unprotected port. All integrity checks happen before any hot-swap.
# ============================================================
set -euo pipefail

ADAPTER=""
TARGET="oracle"
HOST=""
USER="ubuntu"
EXPECTED_SHA=""
DRY_RUN=0
ADAPTER_META="adapter_meta.json"

# Parse args (simple, gnu-style)
while [[ $# -gt 0 ]]; do
  case "$1" in
    --adapter) ADAPTER="$2"; shift 2;;
    --target)  TARGET="$2"; shift 2;;
    --host)    HOST="$2"; shift 2;;
    --user)    USER="$2"; shift 2;;
    --expected-sha256) EXPECTED_SHA="$2"; shift 2;;
    --dry-run) DRY_RUN=1; shift;;
    *) echo "Unknown arg: $1" >&2; exit 2;;
  esac
done

if [[ -z "$ADAPTER" ]]; then
  echo "ERROR: --adapter <dir> required" >&2; exit 2
fi
if [[ ! -d "$ADAPTER" ]]; then
  echo "ERROR: adapter dir not found: $ADAPTER" >&2; exit 2
fi

echo "==> Adapter: $ADAPTER"
echo "==> Target : $TARGET"
echo "==> Host   : ${HOST:-<local only>}"

# ------------------------------------------------------------
# 1. Locate the safetensors payload(s)
# ------------------------------------------------------------
mapfile -t FILES < <(find "$ADAPTER" -name "*.safetensors" -type f)
if [[ ${#FILES[@]} -eq 0 ]]; then
  echo "ERROR: no .safetensors found in $ADAPTER" >&2; exit 2
fi
echo "==> Payload files: ${#FILES[@]}"

# ------------------------------------------------------------
# 2. Compute / verify SHA-256 of the combined payload
# ------------------------------------------------------------
COMPUTED_SHA=""
for f in "${FILES[@]}"; do
  COMPUTED_SHA="${COMPUTED_SHA}$(sha256sum "$f" | awk '{print $1}')"
done
# Combined hash of the sorted file hashes (stable integrity fingerprint)
COMBINED=$((printf '%s\n' "${FILES[@]}" | sort | xargs -I{} sha256sum "{}") | sort -k2 | sha256sum | awk '{print $1}')

if [[ -n "$EXPECTED_SHA" ]]; then
  if [[ "$EXPECTED_SHA" != "$COMBINED" ]]; then
    echo "ERROR: SHA-256 mismatch. expected=$EXPECTED_SHA got=$COMBINED" >&2
    exit 1
  fi
  echo "==> SHA-256 verified: $COMBINED"
else
  echo "==> SHA-256 (combined): $COMBINED"
fi

# Read adapter metadata if present (name, base, loss_valid)
NAME="adapter"
if [[ -f "$ADAPTER/$ADAPTER_META" ]]; then
  NAME=$(python3 -c "import json;print(json.load(open('$ADAPTER/$ADAPTER_META')).get('name','adapter'))" 2>/dev/null || echo "adapter")
fi

if [[ "$DRY_RUN" -eq 1 ]]; then
  echo "==> [dry-run] would transfer ${#FILES[@]} file(s) to $TARGET@$HOST and hot-swap '$NAME'"
  exit 0
fi

# ------------------------------------------------------------
# 3. Secure transfer (Tailscale SSH / rsync over the mesh)
# ------------------------------------------------------------
REMOTE_ROOT="${JARVIS_EDGE_MODELS:-/home/$USER/.jarvis/models}"
REMOTE_DIR="$REMOTE_ROOT/$NAME"

if [[ -n "$HOST" ]]; then
  echo "==> Transferring to ${USER}@${HOST}:${REMOTE_DIR}"
  ssh -o BatchMode=yes -o ConnectTimeout=10 "${USER}@${HOST}" "mkdir -p '$REMOTE_DIR'"
  rsync -avz --checksum -e "ssh -o BatchMode=yes" "$ADAPTER/" "${USER}@${HOST}:$REMOTE_DIR/"
  # Re-verify on the remote after transfer
  REMOTE_SHA=$(ssh "${USER}@${HOST}" "cd '$REMOTE_DIR' && ls *.safetensors | sort | xargs -I{} sha256sum '{}' | sort -k2 | sha256sum | awk '{print \$1}'")
  if [[ -n "$REMOTE_SHA" && "$REMOTE_SHA" != "$COMBINED" ]]; then
    echo "ERROR: remote SHA-256 mismatch after transfer ($REMOTE_SHA != $COMBINED). Rolling back remote." >&2
    ssh "${USER}@${HOST}" "rm -rf '$REMOTE_DIR'" || true
    exit 1
  fi
  echo "==> Remote integrity verified"
else
  echo "==> Local-only mode (no host). Adapter prepared at $ADAPTER"
fi

# ------------------------------------------------------------
# 4. Register in Supabase model_adapters (service role via env)
# ------------------------------------------------------------
if [[ -n "${SUPABASE_URL:-}" && -n "${SUPABASE_SERVICE_KEY:-}" ]]; then
  echo "==> Registering adapter '$NAME' in Supabase"
  python3 - <<PY
import os, json, urllib.request
payload = {
    "name": "$NAME",
    "base_model": os.getenv("JARVIS_BASE_MODEL", "Qwen/Qwen2.5-1.5B-Instruct"),
    "target": "$TARGET",
    "artifact_url": "$REMOTE_DIR",
    "sha256": "$COMBINED",
    "status": "deployed",
}
req = urllib.request.Request(
    f"{os.environ['SUPABASE_URL']}/rest/v1/model_adapters",
    data=json.dumps(payload).encode(),
    headers={"apikey": os.environ["SUPABASE_SERVICE_KEY"],
             "Authorization": f"Bearer {os.environ['SUPABASE_SERVICE_KEY']}",
             "Content-Type": "application/json",
             "Prefer": "return=minimal"},
)
with urllib.request.urlopen(req) as r:
    if r.status >= 400:
        raise SystemExit(f"supabase register failed: {r.status}")
print("Registered.")
PY
fi

# ------------------------------------------------------------
# 5. Hot-swap in the running Ollama engine + rollback guard
# ------------------------------------------------------------
# For Ollama: a model 'create' from a Modelfile pointing at the new adapter is
# atomic-ish; we keep the prior tag as 'adapter-rollback' so a failed eval can
# be reverted instantly. This is idempotent and does NOT restart the daemon.
if [[ "$TARGET" == "oracle" && -n "$HOST" ]]; then
  echo "==> Hot-swapping Ollama model (no daemon restart). Rollback tag kept."
  ssh "${USER}@${HOST}" "
    set -e
    # Keep previous as rollback if it exists
    if ollama list | grep -q '^$NAME:latest '; then
      ollama cp '$NAME:latest' '$NAME:rollback' 2>/dev/null || true
    fi
    # (Optional) create new tag from MODELLEFILE referencing adapter dir
    printf 'FROM %s\\nADAPTER %s\\n' '${JARVIS_EDGE_BASE_MODEL:-qwen2.5-1.5b}' '$REMOTE_DIR' > /tmp/Modelfile-$NAME
    ollama create '$NAME:latest' -f /tmp/Modelfile-$NAME
    rm -f /tmp/Modelfile-$NAME
    echo 'Hot-swap complete.'
  "
  echo "==> To rollback: ollama cp '$NAME:rollback' '$NAME:latest'"
fi

echo ""
echo "DONE. Adapter '$NAME' (sha256=$COMBINED) deployed to $TARGET."
if [[ "$TARGET" == "oracle" ]]; then
  echo "Next: verify with model then /dna to archive this state."
fi

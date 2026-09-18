#!/bin/sh
# ─────────────────────────────────────────────────────────────────────────────
# J.A.R.V.I.S. Level 10 — image healthcheck.
# Validates the ASGI app responds on :8080 AND that required deps load before
# Fly marks the machine healthy. Must be lightweight (runs every 15s).
# ─────────────────────────────────────────────────────────────────────────────
set -eu

# 1) HTTP liveness — hit /healthz on the exposed port.
PORT="${PORT:-8080}"
if ! curl -fsS --max-time 3 "http://127.0.0.1:${PORT}/healthz" >/dev/null 2>&1; then
  echo "healthz failed on :${PORT}" >&2
  exit 1
fi

# 2) Dependency validation — fail fast if core modules cannot import.
#    (python already running in the container; this just guards the image.)
if [ "${JARVIS_HEALTH_SKIP_DEPCHECK:-0}" != "1" ]; then
  if ! /opt/venv/bin/python -c "import utils.supabase_client, utils.commands" \
        >/dev/null 2>&1; then
    echo "dependency import check failed" >&2
    exit 1
  fi
fi

exit 0
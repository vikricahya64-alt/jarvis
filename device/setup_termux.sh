#!/data/data/com.termux/files/usr/bin/bash
# setup_termux.sh — Install the sovereign local core for the Realme C25s
# (J.A.R.V.I.S. Level 6 hybrid edge-cloud). Run from within Termux on the phone:
#
#     bash setup_termux.sh
#
# What it does:
#   1. Ensures base Termux packages (python, pip, git, cmake?) are present.
#   2. Installs Python deps for the poller (httpx; cryptography optional).
#   3. Optionally installs MLC LLM CLI and pulls Qwen2.5-1.5B-Instruct-q4f16_1
#      into the local .llm directory for fully-on-device inference.
#   4. Generates a ~/.jarvis.env template (KEEP IT PRIVATE, never commit).
#   5. Optionally registers a cron job so the poller runs in the background.
#
# Security note: the base URL and the shared secret MUST come from the user.
# The script never writes the secret to git or to any cloud log.
#
# Requirements: Termux with storage permission (termux-setup-storage).

set -euo pipefail

VENV="$HOME/.jarvis-venv"
SECRETS_FILE="$HOME/.jarvis.env"
LOG_DIR="${JARVIS_DEVICE_LOG:-/mnt/device_data/.jarvis}"
mkdir -p "$LOG_DIR"

echo "=== 1/5 Base packages ==="
pkg update -y
pkg install -y python git nano || echo "warning: some packages failed (non-fatal)"

echo "=== 2/5 Python deps ==="
python -m venv "$VENV" 2>/dev/null || true   # venv may be unavailable on old pip; fallback below
PYTHON="$VENV/bin/python"
if [ ! -x "$PYTHON" ]; then
  echo "venv unavailable; using system python"
  PYTHON=python
fi
$PYTHON -m pip install --upgrade pip
$PYTHON -m pip install httpx
# 'cryptography' enables AES-256-GCM; optional (pure-stdlib fallback exists).
$PYTHON -m pip install cryptography 2>/dev/null || echo "warning: cryptography not installed (pure-stdlib fallback active)"

echo "=== 3/5 MLC LLM + model (optional, large download) ==="
INSTALL_LLM="${INSTALL_LLM:-no}"
if [ "$INSTALL_LLM" = "yes" ] || [ "${1:-}" = "--llm" ]; then
  mkdir -p "$HOME/.llm"
  # MLC LLM Python wheel + qwen2.5-1.5b-instruct-q4f16_1
  # (MLC distributes via GitHub releases; adjust the URL to your arch/toolchain.)
  $PYTHON -m pip install mlc-llm mlc-ai 2>/dev/null \
    || echo "note: mlc-llm pip install may need a custom wheel; see docs/level6-setup.md for the T610 ARM build."
  echo "To finish model download (large), run:"
  echo "  mlc_llm convert_weight -q q4f16_1 -o $HOME/.llm HF://Qwen/Qwen2.5-1.5B-Instruct"
else
  echo "Skipping MLC LLM install (set INSTALL_LLM=yes or pass --llm)."
  echo "The poller will use a deterministic stub reply until the model is installed."
fi

echo "=== 4/5 Credentials file ==="
if [ ! -f "$SECRETS_FILE" ]; then
  cat > "$SECRETS_FILE" <<'EOF'
# J.A.R.V.I.S. device secrets — KEEP PRIVATE, never commit.
DEVICE_SHARED_SECRET=REPLACE_ME
DEVICE_GATEWAY=https://jarvis-sigma-navy.vercel.app/api/device_gateway
DEVICE_MODEL=Qwen2.5-1.5B
JARVIS_TELEGRAM_ID=0
JARVIS_POLL_INTERVAL=30
JARVIS_TEMP_THROTTLE_C=55
MLC_LLM_BIN=/data/data/com.termux/files/home/.llm/mlc_llm_cli
EOF
  chmod 600 "$SECRETS_FILE"
  echo "Created $SECRETS_FILE — EDIT IT and set DEVICE_SHARED_SECRET, then:"
  echo "  nano $SECRETS_FILE"
else
  echo "$SECRETS_FILE already exists (keeping it)."
fi

echo "=== 5/5 Background runner (cron) ==="
if ! command -v termux-job-scheduler >/dev/null 2>&1; then
  echo "termux-job-scheduler not installed; skip auto-start."
  echo "Run the poller in the foreground with:"
  echo "  $PYTHON $PWD/monitor_g85.py"
else
  echo "termux-job-scheduler present; add a job pointing to monitor_g85.py manually."
fi

echo ""
echo "DONE. Next steps:"
echo "  1) nano ~/.jarvis.env   (set the shared secret + your Telegram ID)"
echo "  2) python monitor_g85.py  (run the poller; Ctrl-C to stop)"
echo "  3) Optional: set INSTALL_LLM=yes to pull the on-device Qwen model."

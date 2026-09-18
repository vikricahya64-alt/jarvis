#!/usr/bin/env bash
set -euo pipefail
# install.sh — bootstrap the J.A.R.V.I.S. dead man's switch daemon on an
# Oracle Cloud Always Free ARM VM (Ubuntu 22.04/24.04).
#
# Run as root (or sudo) on a fresh OCI VM:
#   sudo bash install.sh
#
# Creates:
#   - /opt/jarvis          (app checkout + venv)
#   - /opt/jarvis/.env     (secrets, chmod 600) — you must fill it AFTER
#   - /etc/systemd/system/jarvis-dms.service
#   - opens firewall port 8080 (ufw) for /healthz
#
# Fail-safe: the daemon runs in --dry-run by default. It will NOT trigger any
# destructive action until you explicitly add --execute to the systemd
# ExecStart line in /etc/systemd/system/jarvis-dms.service. Do NOT enable
# execute until you have tested the full flow.

APP_USER="jarvis"
APP_DIR="/opt/jarvis"

echo ">> Creating app user and directory"
id -u "$APP_USER" &>/dev/null || useradd --system --home "$APP_DIR" --shell /usr/sbin/nologin "$APP_USER"
mkdir -p "$APP_DIR"
chown -R "$APP_USER":"$APP_USER" "$APP_DIR"

echo ">> Installing system packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y python3 python3-venv python3-pip git curl

echo ">> Cloning J.A.R.V.I.S. repo into $APP_DIR"
# Replace with your actual repo if deployed from git. If you scp/copy the
# source instead, comment this out and place files directly under $APP_DIR.
if [ ! -d "$APP_DIR/.git" ]; then
  git clone https://github.com/YOUR_ORG/jarvis.git "$APP_DIR"
  chown -R "$APP_USER":"$APP_USER" "$APP_DIR"
fi

echo ">> Creating venv and installing deps"
cd "$APP_DIR"
sudo -u "$APP_USER" python3 -m venv .venv
sudo -u "$APP_USER" ./.venv/bin/pip install --upgrade pip
sudo -u "$APP_USER" ./.venv/bin/pip install -r requirements.txt httpx

echo ">> Installing systemd unit"
cat > /etc/systemd/system/jarvis-dms.service <<'EOF'
[Unit]
Description=J.A.R.V.I.S. Level 9 / 10 Dead Man's Switch daemon
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=jarvis
Group=jarvis
WorkingDirectory=/opt/jarvis
EnvironmentFile=/opt/jarvis/.env
# --execute is DISABLED by design (fail-safe). Remove --no-http only if you
# want the /healthz HTTP server; keep default 6h interval.
ExecStart=/opt/jarvis/.venv/bin/python /opt/jarvis/tools/legacy_monitor_fly.py \
    --telegram-id ${JARVIS_TELEGRAM_ID:-0} \
    --interval ${JARVIS_DMS_INTERVAL:-21600} \
    --no-http
Restart=always
RestartSec=15
# Sandboxing
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ReadWritePaths=/opt/jarvis
Environment=PORT=8080

[Install]
WantedBy=multi-user.target
EOF

echo ">> Creating secrets template (chmod 600); FILL IT IN before starting"
touch "$APP_DIR/.env"
chown "$APP_USER":"$APP_USER" "$APP_DIR/.env"
chmod 600 "$APP_DIR/.env"
if ! grep -q SUPABASE_URL "$APP_DIR/.env" 2>/dev/null; then
  cat >> "$APP_DIR/.env" <<'ENV'
# --- fill these before starting the service ---
SUPABASE_URL=
SUPABASE_SERVICE_KEY=
BACKUP_PASSPHRASE=
TELEGRAM_TOKEN=
JARVIS_DMS_GRACE_DAYS=30
JARVIS_MULTISIG_THRESHOLD=1
LOG_LEVEL=INFO
ENV
fi
chown "$APP_USER":"$APP_USER" "$APP_DIR/.env"

echo ">> Opening ufw port 8080 (if ufw active)"
if command -v ufw >/dev/null 2>&1 && ufw status | grep -q "Status: active"; then
  ufw allow 8080/tcp || true
fi

systemctl daemon-reload
echo
echo "=============================================================================="
echo "NEXT STEPS"
echo "  1. Edit secrets:  sudo nano /opt/jarvis/.env"
echo "  2. Start daemon:  sudo systemctl enable --now jarvis-dms"
echo "  3. Verify:        sudo systemctl status jarvis-dms"
echo "       journalctl -u jarvis-dms -f   # watch 'cycle: {...}' logs"
echo "  4. My SQL show: run once: sudo -u jarvis /opt/jarvis/.venv/bin/python"
echo "       /opt/jarvis/tools/legacy_monitor_fly.py --telegram-id 0 --once"
echo "=============================================================================="
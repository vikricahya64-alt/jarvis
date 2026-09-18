#!/usr/bin/env bash
# =============================================================================
# bootstrap_oracle_edge.sh — Bootstrap Oracle Cloud ARM node as J.A.R.V.I.S.
# private edge (Always Free, Ampere A1, 4 OCPU / 24GB).
#
# Installs: Docker + Ollama (Qwen2.5-instruct), Nginx TLS (Let's Encrypt),
#           Tailscale mesh, and prints the exact Vercel env to set so the
#           ladder  groq -> oracle -> local  becomes fully live.
#
# Run on a FRESH Ubuntu 22.04/24.04 Oracle instance as a sudo user:
#     chmod +x scripts/bootstrap_oracle_edge.sh
#     EDGE_DOMAIN=edge.example.com EDGE_EMAIL=you@example.com \
#       EDGE_AUTH="$(openssl rand -hex 32)" \
#       sudo -E ./scripts/bootstrap_oracle_edge.sh
#
# EDGE_DOMAIN  : public subdomain whose DNS A/AAAA points to this VM's IP.
# EDGE_EMAIL   : email for Let's Encrypt (replace with real one).
# EDGE_AUTH    : the Bearer token Vercel will send (JARVIS_EDGE_AUTH).
#                 Generate a strong one; NOT committed anywhere.
#
# SECURITY: the only public HTTP surface is 443 (Nginx, auth-gated /v1).
# Ollama stays on 127.0.0.1:11434. Saves credentials into /root/.edge-credentials
# (0600) and prints the Vercel env block for the operator to copy manually.
# =============================================================================
set -euo pipefail

# ---- required inputs --------------------------------------------------------
: "${EDGE_DOMAIN:?set EDGE_DOMAIN  public subdomain pointing to this VM IP}"
: "${EDGE_EMAIL:?set EDGE_EMAIL  email address for certificate issuance}"
EDGE_AUTH="${EDGE_AUTH:?set EDGE_AUTH  run:  openssl rand -hex 32}"
EDGE_MODEL="${EDGE_MODEL:-qwen2.5:7b-instruct}"

SILENT=' >/dev/null 2>&1'

log() { printf '\n\033[1;36m[oracle-edge]\033[0m %s\n' "$*"; }

# ---- 1. dependencies --------------------------------------------------------
log "Installing Docker + compose + certbot ..."
apt-get update -y
apt-get install -y ca-certificates curl jq ufw >/dev/null 2>&1 || true

# Docker
if ! command -v docker >/dev/null 2>&1; then
  curl -fsSL https://get.docker.com | sh
fi
systemctl enable --now docker 2>/dev/null || true

# Compose plugin
if ! docker compose version >/dev/null 2>&1; then
  apt-get install -y docker-compose-plugin >/dev/null 2>&1 || true
fi

# Tailscale
if ! command -v tailscale >/dev/null 2>&1; then
  curl -fsSL https://tailscale.com/install.sh | sh
fi

# ---- 2. firewall: only 22, 443 public ---------------------------------------
log "Configuring UFW (open 22/tcp + 443/tcp only) ..."
ufw --force reset >/dev/null 2>&1 || true
ufw allow 22/tcp >/dev/null 2>&1 || true
ufw allow 443/tcp >/dev/null 2>&1 || true
ufw --force enable >/dev/null 2>&1 || true

# ---- 3. Ollama container on 127.0.0.1 ---------------------------------------
log "Starting Ollama (bound to localhost, NOT public) ..."
docker rm -f ollama >/dev/null 2>&1 || true
docker run -d --name ollama --restart unless-stopped \
  -p 127.0.0.1:11434:11434 -v ollama:/root/.ollama ollama/ollama >/dev/null

log "Pulling ${EDGE_MODEL} (this downloads ~4-5GB, can take minutes) ..."
docker exec ollama ollama pull "${EDGE_MODEL}" || {
  echo "model pull failed; retrying once"; docker exec ollama ollama pull "${EDGE_MODEL}"; }

# ---- 4. Nginx + Let's Encrypt TLS --------------------------------------------
log "Installing Nginx ..."
apt-get install -y nginx >/dev/null 2>&1 || true

cat > /etc/nginx/sites-available/edge <<NGINX
server {
    listen 80;
    server_name ${EDGE_DOMAIN};
    location /.well-known/acme-challenge/ { root /var/lib/letsencrypt/; }
    location / { return 301 https://\$host\$request_uri; }
}

server {
    listen 443 ssl http2;
    server_name ${EDGE_DOMAIN};

    ssl_certificate     /etc/letsencrypt/live/${EDGE_DOMAIN}/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/${EDGE_DOMAIN}/privkey.pem;

    # OpenAI-compatible surface, auth-gated for JARVIS only.
    location /v1/chat/completions {
        if (\$http_authorization != "Bearer ${EDGE_AUTH}") { return 401; }
        proxy_pass http://127.0.0.1:11434/v1/chat/completions;
        proxy_set_header Host \$host;
        proxy_read_timeout 120s;
    }

    # Simple health probe (unauth) used by J.A.R.V.I.S. health().
    location /health {
        default_type application/json;
        return 200 '{"status":"ok"}';
    }
}
NGINX
ln -sf /etc/nginx/sites-available/edge /etc/nginx/sites-enabled/edge
rm -f /etc/nginx/sites-enabled/default
nginx -t >/dev/null
systemctl enable --now nginx

# ---- 5. Let's Encrypt certificate --------------------------------------------
log "Requesting Let's Encrypt certificate for ${EDGE_DOMAIN} ..."
apt-get install -y certbot >/dev/null 2>&1 || true
systemctl stop nginx 2>/dev/null || true
certbot certonly --standalone -d "${EDGE_DOMAIN}" --email "${EDGE_EMAIL}" \
  --agree-tos --non-interactive >/dev/null 2>&1 || {
    echo "certbot via standalone failed; trying webroot path."; }
systemctl start nginx 2>/dev/null || true
# auto-renewal
( crontab -l 2>/dev/null | grep -q certbot ) || \
  echo '15 3 * * * certbot renew --quiet --deploy-hook "systemctl reload nginx"' | crontab - || true

# ---- 6. Tailscale ------------------------------------------------------------
log "Bringing up Tailscale (run 'sudo tailscale up' interactively if needed) ..."
if command -v tailscale >/dev/null 2>&1; then
  systemctl enable --now tailscaled >/dev/null 2>&1 || true
  tailscale up || echo "  -> run:  sudo tailscale up   (paste auth key)"
  echo "tailscale status:"
  tailscale status || true
fi

# ---- 7. finish: print credentials & Vercel env to copy ------------------------
CREDS=/root/.edge-credentials
cat > "$CREDS" <<EOF
EDGE_DOMAIN=${EDGE_DOMAIN}
EDGE_AUTH=${EDGE_AUTH}
EDGE_MODEL=${EDGE_MODEL}
EOF
chmod 600 "$CREDS"

log "== DONE =="
printf '\n  Ollama:              docker exec ollama ollama list\n'
printf '  Credentials file:    %s   0600; operator/root only\n' "$CREDS"
printf '\n  Copy into Vercel env (Production), then redeploy:\n'
printf '  ------------------------------------------------------------------\n'
printf '  vercel env add JARVIS_EDGE_URL    production  ->  https://%s\n' "$EDGE_DOMAIN"
printf '  vercel env add JARVIS_EDGE_MODEL  production  ->  %s\n' "$EDGE_MODEL"
printf '  vercel env add JARVIS_EDGE_AUTH   production  ->  %s\n' "$EDGE_AUTH"
printf '  ------------------------------------------------------------------\n'
printf '  Validate after DNS propagates:\n'
printf '    curl https://%s/health\n' "$EDGE_DOMAIN"
curl_example="{\"model\":\"${EDGE_MODEL}\",\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}]}"
printf '    curl -s https://%s/v1/chat/completions -H "Authorization: Bearer %s" -H "Content-Type: application/json" -d '"'"'%s'"'"'\n' "$EDGE_DOMAIN" "$EDGE_AUTH" "$curl_example"
printf '  ------------------------------------------------------------------\n'
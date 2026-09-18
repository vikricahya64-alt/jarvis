#!/data/data/com.termux/files/usr/bin/bash
# JARVIS Termux — start server + cloudflared tunnel
# Run: bash start.sh
# Auto-start via Termux:Boot (see boot/10-jarvis.sh)

termux-wake-lock

SERVER_DIR="$HOME/jarvis-server"
PORT=3900

# Kill previous instances
pkill -f "node $SERVER_DIR/server.js" 2>/dev/null
pkill -f "cloudflared tunnel" 2>/dev/null
sleep 1

# Start server
if [ -f "$SERVER_DIR/server.js" ]; then
    cd "$SERVER_DIR"
    nohup node server.js > server.log 2>&1 &
    echo "Server started (PID $!)"
else
    echo "ERROR: $SERVER_DIR/server.js not found"
    exit 1
fi

# Wait for server
sleep 2

# Start cloudflared tunnel
if command -v cloudflared &> /dev/null; then
    nohup cloudflared tunnel --url http://localhost:$PORT > tunnel.log 2>&1 &
    echo "Tunnel started (PID $!)"
    echo ""
    echo "=== Tunnel URL (copy this) ==="
    sleep 5
    grep -oP 'https://[a-z0-9-]+\.trycloudflare\.com' tunnel.log | head -1
    echo "==============================="
else
    echo "WARNING: cloudflared not installed. Run: pkg install cloudflared"
    echo "Or download: curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-arm64 -o $PREFIX/bin/cloudflared && chmod +x $PREFIX/bin/cloudflared"
fi

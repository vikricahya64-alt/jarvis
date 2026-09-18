#!/data/data/com.termux/files/usr/bin/bash
# JARVIS Termux — auto-start via Termux:Boot
# Install: chmod +x 10-jarvis.sh && cp to ~/.termux/boot/
termux-wake-lock

export PATH="/data/data/com.termux/files/usr/bin:$PATH"

# Wait for network
for i in $(seq 1 30); do
    if ping -c 1 -W 2 1.1.1.1 >/dev/null 2>&1; then break; fi
    sleep 2
done

# Start JARVIS server + tunnel
START_SCRIPT="$HOME/jarvis-server/start.sh"
if [ -f "$START_SCRIPT" ]; then
    bash "$START_SCRIPT"
else
    echo "ERROR: $START_SCRIPT not found"
fi

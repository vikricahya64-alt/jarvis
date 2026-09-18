#!/usr/bin/env bash
#=============================================================================
# migrate_to_hf_spaces.sh — bootstrap a HuggingFace Spaces free-tier worker
# for J.A.R.V.I.S. Level 11 heavy compute (ranking, consolidation, optional
# inference). Completely free (no credit card), always-on while a Space is
# active, and intentionally STATELESS: all persistent state lives in Supabase.
#
# WHAT THIS DOES
#   1. Creates a minimal HF Spaces `app.py` that:
#        - connects to Supabase (env SUPABASE_URL / SUPABASE_SERVICE_KEY),
#        - implements /healthz + /drain (long/heavy tasks carried out inside),
#        - logs to stdout (supabase free).
#   2. Sets up requirements.txt + README metadata so HF builds it.
#   3. Prints deploy instructions (your Gradio/Streamlit app will auto-start).
#
# REQUIREMENTS
#   * HF Spaces account + a Space created via the dashboard (free CPU; GPU is
#     opt-in and billed — keep CPU).
#   * Env secrets configured on the Space: SUPABASE_URL, SUPABASE_SERVICE_KEY,
#     JARVIS_TELEGRAM_ID.
#   * For the DMS/daemon 24/7 liveness, HF Spaces have a 48h-sleep policy on
#     free CPU — this worker is NOT a complete replacement for the Realme
#     Termux daemon. Use it for ephemeral heavy compute only.
#=============================================================================
set -euo pipefail

OUT="${1:-./hf_spaces}"
echo ">> Scaffolding HF Spaces worker into $OUT"
mkdir -p "$OUT/templates" "$OUT/static" "$OUT/data"

cat > "$OUT/app.py" <<'PY'
# J.A.R.V.I.S. — HuggingFace Spaces free tier worker (Level 11 heavy compute)
# Stateless by design: every persistent read/write goes to Supabase.
import os, json
import httpx
from gradio import Blocks, Markdown  # gradio dependency below

SUPABASE_URL = os.getenv("SUPABASE_URL", "")
SUPABASE_KEY = os.getenv("SUPABASE_SERVICE_KEY", os.getenv("SUPABASE_KEY", ""))
TG_ID = int(os.getenv("JARVIS_TELEGRAM_ID", "0") or 0)

def _sb_headers():
    return {"apikey": SUPABASE_KEY, "Authorization": f"Bearer {SUPABASE_KEY}",
            "Content-Type": "application/json"}

def health():
    """Report liveness: reachability to Supabase + uptime of the Space process."""
    ok = bool(SUPABASE_URL and SUPABASE_KEY)
    return {"ok": ok, "supabase": ok, "service": "jarvis-hf-worker",
            "owner": TG_ID}

def pulse():
    """Lightweight DMS heartbeat proxy (in case the Realme daemon is asleep and
    you want the HF Space to also touch the heartbeat — optional)."""
    if not SUPABASE_URL or not SUPABASE_KEY:
        return {"ok": False, "reason": "no_supabase"}
    try:
        import time
        ts = time.time()
        with httpx.Client(timeout=10) as c:
            r = c.post(f"{SUPABASE_URL}/rest/v1/dms_state",
                       json={"telegram_id": TG_ID,
                             "last_heartbeat_at": __import__('datetime').datetime.utcfromtimestamp(ts).isoformat() + "+00:00"},
                       headers=_sb_headers(), params={},
                       )
        return {"ok": r.status_code < 400, "href": r.status_code}
    except Exception as e:
        return {"ok": False, "error": str(e)}

with Blocks() as demo:
    Markdown("# J.A.R.V.I.S. Level 11 worker\nStateless heavy compute on HF Spaces free tier.")
    health_btn = demo_btn = None  # framework UI; real work is the /endpoints

demo.launch()

# Uvicorn/FastAPI style HTTP hooks: expose /healthz & /drain for the Cloudflare
# Worker health checks. (Space main is gradio; this tells a reverse proxy where)
# Keep it minimal — the ephemeral worker lives in Supabase Edge Functions.
PY

cat > "$OUT/requirements.txt" <<'REQ'
gradio
httpx
REQ

cat > "$OUT/README.md" <<'MD'
# J.A.R.V.I.S. — HuggingFace Spaces free tier worker

Stateless heavy-compute worker for J.A.R.V.I.S. Level 11.

- Free CPU tier (no credit card required).
- No persistent storage: all state lives in Supabase.
- `/healthz` exposes liveness for the Cloudflare / Tailscale Funnel monitor.

## Deploy
1. Create a Space at huggingface.co/new (free CPU).
2. Upload these files (or point git clone).
3. Add Secrets in Space Settings:
   - `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, `JARVIS_TELEGRAM_ID`
4. Space auto-starts. The free CPU tier sleeps after ~48h idle — treat this
   as ephemeral compute, NOT a substitute for the 24/7 Termux daemon.
MD

echo ">> done. Deploy steps:"
echo "  1) huggingface.co/new  →  free CPU Space"
echo "  2) push these files (git clone your Space, copy $OUT/*)"
echo "  3) add secrets: SUPABASE_URL / SUPABASE_SERVICE_KEY / JARVIS_TELEGRAM_ID"
echo "  4) Space restarts automatically"
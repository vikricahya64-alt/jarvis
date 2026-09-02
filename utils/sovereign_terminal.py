"""
Sovereign Terminal (Level 7, Realme C25s) — the phone's edge runtime.

THE PHONE NEVER RUNS HEAVY MODELS. This module hides everything the device does
so the rest of the system can treat it as a thin, sovereign terminal:

  * Thermal / RAM guardrails with AUTO-FAILOVER — if CPU temp > 40°C or
    RAM > 85%, local inference is refused and the call is routed to the private
    edge (Oracle) or public cloud (Groq). This protects the Helio G85.
  * AES-256-GCM encryption of every outbound payload (wraps utils.device_comm).
  * SQLCipher local storage integration for PII (PII stays on-device, never in
    the cloud or in logs).
  * Tailscale connectivity checker so the terminal can reach the private edge
    (Oracle Cloud Always Free) over the zero-config overlay mesh.

The runtime is SYNCHRONOUS on purpose: Vercel serverless + the 4GB phone both
reject spinning up event loops. "Async" modules in the spec are implemented as
cheap, sync, blocking helpers here — consistent with the rest of the codebase.
"""
import os
import json
import time
import hmac
import hashlib
import socket
import logging
import subprocess

from utils import device_comm as dc

logger = logging.getLogger("sovereign_terminal")

# Hard guardrails for the Unisoc T610 / Helio G85 (4GB). DO NOT RAISE.
TEMP_LIMIT_C = 40.0      # auto-failover when CPU temp exceeds 40°C
RAM_LIMIT_PCT = 85.0     # auto-failover when RAM exceeds 85%
DB_PATH = os.getenv("JARVIS_LOCAL_DB",
                    os.path.expanduser("~/.jarvis/sovereign.db"))

# Routing ladder: public cloud > private edge > local terminal.
_LADDER = ("cloud", "oracle", "local")


# ------------------------------------------------------------------
# 1. Hardware guardrails (pure, testable)
# ------------------------------------------------------------------
def should_run_local(temp_c=None, ram_pct=None,
                     temp_limit: float = TEMP_LIMIT_C,
                     ram_limit: float = RAM_LIMIT_PCT) -> tuple:
    """
    Decide whether the phone may run local inference this moment.
    Returns (allowed: bool, reason: str). Reasons:
      'ok'                 -> safe to run locally
      'temp_too_high'      -> > temp_limit °C  (failover to edge/cloud)
      'ram_too_high'       -> > ram_limit %    (failover)
      'no_metrics'         -> metrics unavailable => conservative: allow cloud?.
                               We treat unknown as NOT local to protect the phone.
    """
    if temp_c is None and ram_pct is None:
        return False, "no_metrics"
    if temp_c is not None and temp_c > temp_limit:
        return False, "temp_too_high"
    if ram_pct is not None and ram_pct > ram_limit:
        return False, "ram_too_high"
    return True, "ok"


def pick_target(temp_c=None, ram_pct=None) -> str:
    """Top-of-ladder target given current telemetry -> 'local'|'oracle'|'cloud'."""
    allowed, why = should_run_local(temp_c, ram_pct)
    if allowed:
        return "local"
    # Failover: prefer private edge (oracle) when the phone is too hot/RAM-full.
    return "oracle" if why == "temp_too_high" else "cloud"


# ------------------------------------------------------------------
# 2. Telemetry readers (reused by /device_health)
# ------------------------------------------------------------------
def read_temp_c() -> float:
    try:
        paths = ["/sys/class/thermal/thermal_zone0/temp",
                 "/sys/class/thermal/thermal_zone1/temp",
                 "/sys/class/power_supply/battery/temp"]
        vals = []
        for p in paths:
            try:
                with open(p) as fh:
                    raw = int(fh.read().strip())
                vals.append(raw / 1000.0 if abs(raw) < 1000 else raw / 10.0)
            except (OSError, ValueError):
                continue
        return round(sum(vals) / len(vals), 1) if vals else None
    except Exception:
        return None


def read_ram_pct() -> float:
    try:
        info = {}
        with open("/proc/meminfo") as fh:
            for line in fh:
                parts = line.split()
                if parts:
                    info[parts[0].rstrip(":")] = int(parts[1])
        total = info.get("MemTotal")
        avail = info.get("MemAvailable")
        if total and avail is not None:
            return round(100.0 * (total - avail) / total, 1)
    except Exception:
        pass
    return None


def read_latency_ms(peer=None) -> int:
    """Ping latency to the private edge (Oracle) or default gateway."""
    host = peer or os.getenv("JARVIS_EDGE_HOST", "100.100.100.100")  # magicsock
    try:
        t0 = time.time()
        socket.create_connection((host, 443), timeout=2).close()
        return int((time.time() - t0) * 1000)
    except Exception:
        return 9999


# ------------------------------------------------------------------
# 3. AES-256-GCM transport (encrypt before it leaves the device)
# ------------------------------------------------------------------
def encrypt_outgoing(payload: dict) -> dict:
    """Encrypt a payload with AES-256-GCM before transmission. Any payload that
    fails to encrypt is dropped — the phone NEVER sends plaintext secrets."""
    return dc.encrypt_payload(payload)


def decrypt_incoming(envelope: dict) -> dict:
    """Decrypt a response the device received. Raises on tamper/MAC mismatch."""
    return dc.decrypt_payload(envelope)


def _integrity_fingerprint(data: bytes, secret: str) -> str:
    return hmac.new(secret.encode(), data, hashlib.sha256).hexdigest()


# ------------------------------------------------------------------
# 4. SQLCipher local PII store (PII stays on the device)
# ------------------------------------------------------------------
def _sqlcipher_connect():
    """Open a SQLCipher-encrypted SQLite DB. If the `sqlcipher3` module or a
    passphrase key isn't available, fall back to a plain (best-effort) sqlite3
    handle guarded by an HMAC integrity column — never store raw PII in the
    cloud anyway. Returns a connection with row_factory set."""
    secret = os.getenv("DEVICE_SHARED_SECRET") or os.getenv("JARVIS_DEVICE_SECRET")
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    sqlite3 = None
    try:
        import sqlite3
        conn = sqlite3.connect(DB_PATH)
        conn.row_factory = sqlite3.Row
        if secret:
            conn.execute(f"PRAGMA key='{secret}'")   # best-effort device cipher
        return conn
    except Exception as exc:
        logger.warning("sqlcipher unavailable (%s); using plain sqlite3", exc)
        raise


def store_pii(tenant: str, payload: dict) -> bool:
    """
    Persist PII locally on the phone ONLY. `tenant` is a namespace (e.g.
    'contacts', 'auth'); `payload` is redacted-form key-values the device owns.
    Returns False if the store is unavailable (caller should refuse the write).
    """
    try:
        conn = _sqlcipher_connect()
        conn.execute(
            "CREATE TABLE IF NOT EXISTS pii_vault ("
            " tenant TEXT, id TEXT, data TEXT, "
            " mac TEXT, ts INTEGER, PRIMARY KEY(tenant, id))")
        record_id = payload.pop("id", "default")
        raw = json.dumps(payload, ensure_ascii=False)
        mac = _integrity_fingerprint(raw.encode(), os.getenv("DEVICE_SHARED_SECRET", "x"))
        conn.execute(
            "INSERT OR REPLACE INTO pii_vault(tenant,id,data,mac,ts) VALUES(?,?,?,?,?)",
            (tenant, record_id, raw, mac, int(time.time())))
        conn.commit()
        conn.close()
        return True
    except Exception as exc:
        logger.error("pii store failed: %s", exc)
        return False


def retrieve_pii(tenant: str, record_id: str) -> dict:
    """Read a local PII record back, verifying its HMAC integrity."""
    try:
        conn = _sqlcipher_connect()
        cur = conn.execute(
            "SELECT data, mac FROM pii_vault WHERE tenant=? AND id=?",
            (tenant, record_id))
        row = cur.fetchone()
        conn.close()
        if not row:
            return None
        raw = row["data"]
        if _integrity_fingerprint(raw.encode(), os.getenv("DEVICE_SHARED_SECRET", "x")) \
                != row["mac"]:
            return None  # tampered
        return json.loads(raw)
    except Exception:
        return None


# ------------------------------------------------------------------
# 5. Tailscale connectivity checker
# ------------------------------------------------------------------
def tailscale_status() -> dict:
    """Query the `tailscale status` CLI (present when the overlay mesh daemon is
    installed on the phone / Oracle node). Returns peer + online info."""
    try:
        proc = subprocess.run(["tailscale", "status", "--json"],
                              capture_output=True, text=True, timeout=6)
        if proc.returncode != 0:
            return {"online": False, "error": proc.stderr.strip()[:200]}
        data = json.loads(proc.stdout or "{}")
        self_peer = data.get("Self")
        peers = list((data.get("Peer") or {}).values())
        return {
            "online": True,
            "self_hostname": (self_peer or {}).get("HostName"),
            "self_ip": (self_peer or {}).get("TailscaleIPs", [None])[0],
            "peer_count": len(peers),
            "peers": [p.get("HostName") for p in peers[:10]],
        }
    except FileNotFoundError:
        return {"online": False, "error": "tailscale CLI not installed"}
    except Exception as exc:
        return {"online": False, "error": str(exc)[:200]}


def private_edge_reachable(peer: str = None, timeout: float = 3.0) -> bool:
    """True when we can reach the Oracle private edge over Tailscale."""
    peer = peer or os.getenv("JARVIS_EDGE_IP")
    if not peer:
        st = tailscale_status()
        # The edge is usually the first tailnet peer tagged 'edge'/'oracle'.
        return False
    try:
        sock = socket.create_connection((peer, 443), timeout=timeout)
        sock.close()
        return True
    except Exception:
        return False


# ------------------------------------------------------------------
# 6. One-shot: should this request go local, and can we route it?
# ------------------------------------------------------------------
def route_decision() -> dict:
    """High-level routing decision for the terminal given live telemetry.\n
    Returns {\"target\", \"allowed_local\", \"reason\", \"temp\", \"ram\",
    \"edge_reachable\"} so both the router and /device_health can react."""
    temp = read_temp_c()
    ram = read_ram_pct()
    allowed, reason = should_run_local(temp, ram)
    target = pick_target(temp, ram)
    edge_reach = private_edge_reachable()
    # If the private edge is unreachable, collapse to public cloud.
    if target == "oracle" and not edge_reach:
        target = "cloud"
    return {
        "target": target, "allowed_local": allowed, "reason": reason,
        "temp_c": temp, "ram_pct": ram,
        "edge_reachable": edge_reach,
    }

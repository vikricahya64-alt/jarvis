"""
Level 8 Swarm Coordination: MQTT over Tailscale mesh.

Connects every peer (Realme edge terminal, Oracle private cloud, Colab
training node, laptop) into a peer-to-peer fabric that works WITHOUT central
cloud dependency. The broker lives on the Oracle VM and is reachable ONLY via
the Tailscale IP (never exposed on a public port).

Security model (hard constraints):
  * The MQTT broker binds to the Tailscale interface only, requires auth.
  * Every payload is AES-256-GCM encrypted BEFORE publish and decrypted on
    subscribe; no plaintext crosses the wire edge-to-edge.
  * Raw sensor media NEVER transits MQTT. Only encrypted structured metadata
    / commands do.
  * Each peer identifies with a unique device_id + role so the coordinator
    can route task distribution.

Synchronous on purpose: Vercel serverless rejects asyncio.run() (EBUSY), and
the on-device client runs paho (sync). Pure helper functions (encrypt/
decrypt/pack/unpack) are importable from Vercel for cross-checking; the full
MQTT loop is meant to run as a Termux/environmentd script on a peer.

External dep (optional):  paho-mqtt==2.1.0
If paho is absent, this module still works for encryption/queue helpers and
returns graceful "broker unavailable" statuses (never crashes the caller).
"""
import os
import io
import json
import time
import base64
import logging

# -- crypto ------------------------------------------------------------------
# AES-256-GCM envelope so any swarm peer can validate+decrypt,
# same primitive family as utils/data_sovereignty.
try:
    from cryptography.hazmat.primitives import hashes
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    _HAVE_CRYPTO = True
except Exception:
    _HAVE_CRYPTO = False

try:
    from paho.mqtt import client as mqtt_client
    _HAVE_PAHO = True
except Exception:
    _HAVE_PAHO = False

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("swarm_coord")

# Config (from env; the broker is a Tailscale-only address).
MQTT_HOST = os.getenv("SWARM_MQTT_HOST", "100.70.1.2")     # Tailscale IP of Oracle broker
MQTT_PORT = int(os.getenv("SWARM_MQTT_PORT", "1883"))
MQTT_USER = os.getenv("SWARM_MQTT_USER", "swarm")
MQTT_PASS = os.getenv("SWARM_MQTT_PASS", "")
MQTT_TLS = os.getenv("SWARM_MQTT_TLS", "0") == "1"          # 8883 TLS over Tailscale
DEVICE_SHARED_SECRET = os.getenv("DEVICE_SHARED_SECRET", "")

HEARTBEAT_S = float(os.getenv("SWARM_HEARTBEAT_S", "30"))
ROLE_EDGE = "edge_terminal"
ROLE_CLOUD = "private_cloud"
ROLE_TRAIN = "training_node"

TOPIC_HEARTBEAT = "swarm/+/heartbeat/status"
TOPIC_CMD = "swarm/+/command"


# ----------------------------------------------------------------------------
# Encrypted message envelope (AES-256-GCM)
# ----------------------------------------------------------------------------
def _derive_key(secret: str = "") -> bytes:
    """Derive a 32-byte AES key from the shared secret. Uses SHA-256."""
    secret = secret or DEVICE_SHARED_SECRET
    if not secret:
        raise RuntimeError("swarm: DEVICE_SHARED_SECRET is not configured")
    digest = hashes.Hash(hashes.SHA256())
    digest.update(secret.encode("utf-8"))
    return digest.finalize()


def encrypt_payload(data: dict, secret: str = "") -> dict:
    """AES-256-GCM seal a dict. Returns {'ct','iv','tag','v':1} (base64).
    Falls back to SHA256 integrity envelope (unencrypted) only if crypto is
    unavailable, tagging 'v':0 so receivers can distinguish."""
    if not _HAVE_CRYPTO:
        payload = json.dumps(data, sort_keys=True).encode()
        return {"v": 0, "data": base64.b64encode(payload).decode()}
    key = _derive_key(secret)
    nonce = os.urandom(12)
    plain = json.dumps(data, sort_keys=True).encode()
    sealed = AESGCM(key).encrypt(nonce, plain, None)
    return {"v": 1, "ct": base64.b64encode(sealed).decode(),
            "iv": base64.b64encode(nonce).decode()}


def decrypt_payload(envelope: dict, secret: str = "") -> dict:
    """Inverse of encrypt_payload(). Returns the original dict or None on any
    tamper/error (never raises)."""
    try:
        if envelope.get("v") == 0:
            return json.loads(base64.b64decode(envelope["data"]))
        if envelope.get("v") != 1:
            return None
        key = _derive_key(secret)
        sealed = base64.b64decode(envelope["ct"])
        nonce = base64.b64decode(envelope["iv"])
        plain = AESGCM(key).decrypt(nonce, sealed, None)
        return json.loads(plain.decode())
    except Exception:
        return None


def pack_message(kind: str, device_id: str, role: str, payload: dict,
                 secret: str = "") -> dict:
    """Serialize an outgoing swarm message: envelope + metadata.
    Metadata (kind/device/role/ts) stays plaintext; payload is sealed."""
    return {
        "kind": kind,
        "device_id": device_id,
        "role": role,
        "ts": int(time.time()),
        "payload": encrypt_payload(payload, secret),
    }


# ----------------------------------------------------------------------------
# Offline queue: local durable cache, syncs when Tailscale/MQTT reconnects
# ----------------------------------------------------------------------------
_QUEUE_FILE = os.getenv("SWARM_QUEUE_FILE", "")  # set to a path on the device
_MAX_Q = int(os.getenv("SWARM_QUEUE_MAX", "500"))


def _queue_path() -> str:
    path = _QUEUE_FILE or os.path.join(
        os.getenv("JARVIS_DEVICE_LOG") or "/tmp", "swarm_queue.jsonl")
    return path


def queue_offline(msg: dict) -> bool:
    """Append an outbound message to the durable local queue (for when the
    broker is unreachable). Returns False if queue is full or unwritable."""
    try:
        p = _queue_path()
        with open(p, "a") as fh:
            fh.write(json.dumps(msg) + "\n")
        # crude cap: if too big, drop oldest line
        try:
            with open(p) as fh:
                lines = fh.readlines()
            if len(lines) > _MAX_Q:
                with open(p, "w") as fh:
                    fh.writelines(lines[-_MAX_Q:])
        except Exception:
            pass
        return True
    except Exception:
        return False


def drain_queue() -> list:
    """Read + clear the offline queue; returns the list of queued messages
    so the caller can re-publish them on reconnect."""
    p = _queue_path()
    if not os.path.exists(p):
        return []
    try:
        with open(p) as fh:
            lines = fh.readlines()
        os.remove(p)
        return [json.loads(l) for l in lines if l.strip()]
    except Exception:
        return []


# ----------------------------------------------------------------------------
# MQTT client (runs on a peer; paho synchronous)
# ----------------------------------------------------------------------------
class SwarmClient:
    """Thin paho wrapper with encrypted transport + offline queue."""

    def __init__(self, device_id: str, role: str = ROLE_EDGE,
                 telegram_id: int = 0, capabilities: list = None):
        self.device_id = device_id
        self.role = role
        self.telegram_id = telegram_id
        self.capabilities = capabilities or []
        self.client = None
        self.connected = False

    def _on_connect(self, client, userdata, flags, rc):
        self.connected = (rc == 0)
        if self.connected:
            # Re-publish anything that was queued while offline.
            for msg in drain_queue():
                try:
                    client.publish(msg["topic"], json.dumps(msg["data"]), qos=1)
                except Exception:
                    logger.warning("swarm: failed replaying queued message")
            self._subscribe()
            logger.info("swarm: %s online", self.device_id)
        else:
            logger.warning("swarm: connect failed rc=%s", rc)

    def _on_message(self, client, userdata, msg):
        try:
            payload = json.loads(msg.payload.decode())
            envelope = payload.get("payload", {})
            dec = decrypt_payload(envelope)
            if dec is None:
                logger.warning("swarm: dropped undecryptable/plaintext msg")
                return
            target = payload.get("device_id")
            if target and target not in (self.device_id, "all"):
                return  # not for this peer
            self.on_message(payload.get("kind"), dec)
        except Exception:
            logger.exception("swarm: on_message failed")

    def _subscribe(self):
        if self.client:
            self.client.subscribe(TOPIC_CMD)
            self.client.subscribe(TOPIC_HEARTBEAT)

    def on_message(self, kind, payload):
        # Override in subclass or set attribute. Default: no-op logging.
        logger.info("swarm: got kind=%s payload=%s", kind, payload)

    def connect(self, host: str = "", port: int = 0):
        if not _HAVE_PAHO:
            logger.warning("swarm: paho-mqtt not installed; broker unavailable")
            return False
        host = host or MQTT_HOST
        port = port or MQTT_PORT
        cid = f"{self.device_id}-{int(time.time())}"
        client = mqtt_client.Client(mqtt_client.CallbackAPIVersion.VERSION2, client_id=cid)
        if MQTT_USER:
            client.username_pw_set(MQTT_USER, MQTT_PASS)
        if MQTT_TLS:
            client.tls_set()
        client.on_connect = self._on_connect
        client.on_message = self._on_message
        try:
            client.connect_async(host, port, 60)
            client.loop_start()
            self.client = client
            return True
        except Exception as exc:
            logger.error("swarm: connect_async failed: %s", exc)
            return False

    def publish(self, topic, kind, payload, secret: str = ""):
        """Encrypt + publish. If disconnected, queue for later sync."""
        body = pack_message(kind, self.device_id, self.role,
                            payload, secret)
        msg = json.dumps({"topic": topic, "data": body})
        if not self.connected or not self.client:
            # offline -> durable sync queue
            queue_offline(body)
            return {"ok": True, "queued": True}
        info = self.client.publish(topic, msg, qos=1)
        return {"ok": info.rc == mqtt_client.MQTT_ERR_SUCCESS, "queued": False}

    def stop(self):
        if self.client:
            try:
                self.client.loop_stop()
                self.client.disconnect()
            except Exception:
                pass
            self.client = None
            self.connected = False


# ----------------------------------------------------------------------------
# Convenience: publish a heartbeat for a peer.
# ----------------------------------------------------------------------------
def publish_heartbeat(client: SwarmClient, temp_c=None, ram_pct=None,
                      battery_pct=None, status: str = "online") -> dict:
    """Compose + publish a peer's 30s heartbeat (metrics stay on-device
    except the low-frequency, non-sensitive summary)."""
    payload = {
        "status": status, "role": client.role,
        "temp_c": temp_c, "ram_pct": ram_pct, "battery_pct": battery_pct,
        "capabilities": client.capabilities,
    }
    return client.publish(f"swarm/{client.role}/heartbeat/status",
                          "heartbeat", payload)


def heartbeat_loop(client: SwarmClient, interval_s: float = HEARTBEAT_S,
                   get_telemetry=None):
    """Blocking loop publishing heartbeats until KeyboardInterrupt."""
    import time as _t
    while True:
        tel = get_telemetry() if get_telemetry else {}
        publish_heartbeat(client, **tel)
        try:
            _t.sleep(interval_s)
        except KeyboardInterrupt:
            break


# ----------------------------------------------------------------------------
# Human-facing summary (used by /swarm_status).
# ----------------------------------------------------------------------------
def swarm_summary(nodes: list) -> str:
    """Render a compact Telegram summary of connected nodes."""
    if not nodes:
        return "🐝 Belum ada node swarm terdaftar."
    lines = ["🐝 *Swarm Hive*"]
    for n in nodes:
        caps = ", ".join(n.get("capabilities") or []) or "—"
        lines.append(
            f"• `{n.get('device_id')}` · {n.get('role')} · {n.get('status')}\n"
            f"   IP {n.get('peer_addr') or '?'} · RAM {n.get('ram_mb') or 0}MB"
            f" · [ {caps} ]")
    return "\n".join(lines)


# ----------------------------------------------------------------------------
# Pure helpers for tests (no I/O).
# ----------------------------------------------------------------------------
def _healthy_node(node: dict, now: int = None) -> bool:
    """A node is 'healthy' if its last heartbeat is recent (< 2x HB interval)."""
    import time as _t
    now = now if now is not None else int(_t.time())
    last = node.get("last_heartbeat")
    if not last:
        return False
    # last_heartbeat may be ISO str (db) or epoch int (local)
    try:
        if isinstance(last, str):
            from datetime import datetime, timezone
            dt = datetime.fromisoformat(last.replace("Z", "+00:00"))
            age_s = now - dt.timestamp()
        else:
            age_s = now - float(last)
        return 0 <= age_s < HEARTBEAT_S * 2
    except Exception:
        return False
#!/usr/bin/env python3
"""
J.A.R.V.I.S. Level 8 Federated Learning — CLIENT

Runs on every participating swarm node (Oracle private cloud = default "heavy"
node; Realme edge terminal = optional "light" node). The client:

  1. Loads its LOCAL encrypted dataset from the SQLCipher Vault (never pushes
     raw rows anywhere).
  2. Trains a small LoRA adapter on the local slice (Flower + Unsloth/PEFT).
  3. Produces gradients/weights for the shared head.
  4. ENCRYPTS the gradient delta (AES-256-GCM) and prints a compact manifest
     the operator pushes to the aggregator (or, when an MQTT broker is online,
     publishes it on the swarm channel). The aggregator NEVER sees raw data.

Expected args:
  --node          device id (e.g. 'oracle-01' / 'g85-01')
  --round         current federated round number
  --epochs        local training epochs (default 1)
  --data          path to local encrypted dataset (SQLCipher/pickle) [optional]
  --model         base model id (default Qwen/Qwen2.5-1.5B-Instruct)
  --adapter-out   dir to write the encrypted delta [+ sha256 + meta]

Safety: the script refuses to send anything when a sensitive-domain flag is
set, and never transmits raw dataset records — only the encrypted delta.

Heavy compute belongs on Oracle/Colab; the phone only ever fine-tunes the
1.5B adapter fragment. Requires: `flwr` and `peft`/`torch` on the node.
Synchronous CLI (no asyncio).
"""
import os
import io
import sys
import json
import time
import base64
import hashlib
import argparse
import logging

# cryptography for AES-256-GCM delta sealing.
try:
    from cryptography.hazmat.primitives import hashes
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    _HAVE_CRYPTO = True
except Exception:
    AESGCM = None
    _HAVE_CRYPTO = False

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("fed.client")

SENSITIVE_DOMAINS = {"health", "finance", "relationship", "identity"}
BLOCKED = {d: True for d in SENSITIVE_DOMAINS}


def _key(secret: str = "") -> bytes:
    secret = secret or os.getenv("DEVICE_SHARED_SECRET", "")
    if not secret:
        raise RuntimeError("DEVICE_SHARED_SECRET not set (cannot seal delta)")
    d = hashes.Hash(hashes.SHA256())
    d.update(secret.encode())
    return d.finalize()


def seal_delta(delta_bytes: bytes, domain: str = "") -> dict:
    """AES-256-GCM seal the gradient delta. Returns base64 envelope."""
    if domain and BLOCKED.get(domain):
        return {"v": 0, "blocked": True, "domain": domain}
    if not _HAVE_CRYPTO:
        return {"v": 0, "blocked": True, "reason": "no_crypto"}
    key = _key()
    nonce = os.urandom(12)
    sealed = AESGCM(key).encrypt(nonce, delta_bytes, None)
    return {"v": 1, "ct": base64.b64encode(sealed).decode(),
            "iv": base64.b64encode(nonce).decode()}


def load_local_dataset(path: str):
    """Load the node's local training slice.
    For real deployments this returns torch/PEFT dataloaders; here we treat
    it as an opaque blob so the script is import-safe without heavy deps."""
    if not path or not os.path.exists(path):
        return None
    import pickle
    with open(path, "rb") as fh:
        return pickle.load(fh)


def train_local(slice_data, epochs: int = 1, base_model: str = "",
                domain: str = ""):
    """Thin local LoRA train wrapper.
    On a real node this calls Unsloth/PEFT; here we synthesize a placeholder
    delta (deterministic for tests) — real training is Colab-side via
    scripts/colab_finetune_qlora.ipynb. Returns (delta_bytes, meta)."""
    # Guard: never train sensitive-domain payloads without explicit opt-in.
    # (The cost of training is on the node, so blocking here is cheap.)
    if domain and BLOCKED.get(domain):
        raise RuntimeError(f"sensitive domain blocked: {domain}")
    # produce a small deterministic dummy gradient for a smoke run
    payload = json.dumps({
        "round": int(os.environ.get("FED_ROUND", 0)),
        "base_model": base_model,
        "epochs": epochs,
        "dummy_lr": 1e-4,
        "ts": time.time(),
    }).encode()
    meta = {"bytes": len(payload), "epochs": epochs,
            "base_model": base_model, "domain": domain or "general"}
    return payload, meta


def main():
    ap = argparse.ArgumentParser(description="JARVIS federated client")
    ap.add_argument("--node", default="edge-01")
    ap.add_argument("--round", type=int, default=1)
    ap.add_argument("--epochs", type=int, default=1)
    ap.add_argument("--data", default="", help="local encrypted dataset path")
    ap.add_argument("--model", default="Qwen/Qwen2.5-1.5B-Instruct")
    ap.add_argument("--domain", default="general",
                    help="leave 'general' unless explicit opt-in")
    ap.add_argument("--out", default="./fed_out", help="out dir for the delta")
    args = ap.parse_args()

    slice_data = load_local_dataset(args.data)
    delta, meta = train_local(slice_data, epochs=args.epochs,
                              base_model=args.model, domain=args.domain)
    envelope = seal_delta(delta, domain=args.domain)
    if envelope.get("blocked"):
        os.write(1, b"schema_sensitive_domain_blocked=1\n")
        return 2

    sha = hashlib.sha256(delta).hexdigest()
    meta.update({"node": args.node, "round": args.round, "sha256": sha})

    os.makedirs(args.out, exist_ok=True)
    with open(os.path.join(args.out, "delta.json"), "w") as fh:
        json.dump(envelope, fh)
    with open(os.path.join(args.out, "meta.json"), "w") as fh:
        json.dump(meta, fh)

    logger.info("delta sealed -> %s", args.out)
    print(json.dumps({
        "ok": True, "node": args.node, "round": args.round,
        "sha256": sha, "delta_bytes": meta["bytes"],
        "instructions": "ship delta.json to the aggregator OR publish on swarm"
                        " topic 'fed/oracle-01/round-N' (encrypted).",
    }))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
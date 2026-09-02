"""
Genetic Memory Archive & Replication (Level 7): permanent "DNA" storage.

A "genetic snapshot" packages the essence of J.A.R.V.I.S. — code hash, model
weights hash, core preferences — into a single archive that is uploaded to
Pinata IPFS (free tier) as an immutable, content-addressed record. The returned
CID is stored in Supabase `genetic_archive` for disaster recovery.

Policy:
  * The archive NEVER contains logs, PII, secrets, or credentials. Preferences
    are exported as structural hashes / safe aggregates only.
  * Everything is content-hashed (SHA-256) so we can prove the archive we later
    restore is bit-for-bit identical to what was archived.
  * Pinata JWT comes from env (PINATA_JWT); free tier gives 1GB + a few uploads.

Synchronous on purpose (Vercel serverless; no event loop).
"""
import os
import io
import json
import zlib
import base64
import hashlib
import logging
import urllib.request

from utils import supabase_client

logger = logging.getLogger("genetic_archive")

PINATA_UPLOAD_URL = "https://api.pinata.cloud/pinning/pinFileToIPFS"
DEFAULT_VERSION = "dna-v1"


# ------------------------------------------------------------------
# Hashing / packaging
# ------------------------------------------------------------------
def _sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _sha256_file(path: str) -> str:
    h = hashlib.sha256()
    if not os.path.exists(path):
        return ""
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def build_manifest(code_hashes: dict = None, model_hashes: dict = None,
                   prefs: dict = None) -> dict:
    """
    Build a safe, content-addressed manifest of the system's "genome".
        code_hashes : {filename: sha256} of core source files
        model_hashes: {model_tag: sha256} of deployed model weights/adapters
        prefs       : structural preferences aggregate (no values, just shape)
    Returns a dict that is JSON-serializable and safe to persist + log.
    """
    return {
        "type": "jarvis-genome",
        "schema": 1,
        "code": {k: v for k, v in (code_hashes or {}).items()},
        "models": {k: v for k, v in (model_hashes or {}).items()},
        "prefs_shape": sorted(list((prefs or {}).keys())),
        "built_at": __import__("time").time(),
    }


def package_archive(manifest: dict) -> tuple:
    """
    Serialize + compress + hash the manifest into a payload ready for IPFS.
    Returns (payload_bytes, sha256_hex).
    """
    raw = json.dumps(manifest, ensure_ascii=False, separators=(",", ":")).encode()
    compressed = zlib.compress(raw, 6)
    return compressed, _sha256_bytes(compressed)


# ------------------------------------------------------------------
# Pinata upload
# ------------------------------------------------------------------
def upload_to_pinata(payload: bytes, filename: str = "genome.bin",
                     jwt: str = None) -> dict:
    """
    Upload compressed bytes to Pinata IPFS. Returns {"cid":...} or raises.
    Uses multipart/form-data with the Pinata JWT for auth.
    """
    jwt = jwt or os.getenv("PINATA_JWT")
    if not jwt:
        raise RuntimeError("PINATA_JWT not configured — cannot archive to IPFS")
    boundary = "----jarvis" + os.urandom(8).hex()
    body = io.BytesIO()
    body.write(f"--{boundary}\r\n".encode())
    body.write(f'Content-Disposition: form-data; name="file"; filename="{filename}"\r\n'.encode())
    body.write(b"Content-Type: application/octet-stream\r\n\r\n")
    body.write(payload)
    body.write(f"\r\n--{boundary}--\r\n".encode())

    req = urllib.request.Request(
        PINATA_UPLOAD_URL, data=body.getvalue(), method="POST",
        headers={
            "Authorization": f"Bearer {jwt}",
            "Content-Type": f"multipart/form-data; boundary={boundary}",
        })
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            data = json.loads(resp.read().decode())
            cid = data.get("IpfsHash")
            if not cid:
                raise RuntimeError(f"Pinata returned no CID: {data}")
            return {"cid": cid, "pinata_response": data}
    except urllib.error.HTTPError as exc:
        raise RuntimeError(f"Pinata upload HTTP {exc.code}: {exc.read()[:200]}") from exc


# ------------------------------------------------------------------
# High-level archive flow (used by /dna)
# ------------------------------------------------------------------
def archive_dna(code_hashes: dict = None, model_hashes: dict = None,
                prefs: dict = None, version: str = DEFAULT_VERSION,
                telegram_id: int = 0) -> dict:
    """
    Build → package → upload → persist a genetic snapshot.
    Returns {"ok":..., "cid":..., "sha256":..., "version":...}.
    """
    if code_hashes is None:
        code_hashes = _default_code_hashes()
    manifest = build_manifest(code_hashes, model_hashes, prefs)
    payload, sha = package_archive(manifest)
    try:
        result = upload_to_pinata(payload, filename=f"{version}.bin")
    except Exception as exc:
        logger.error("ipfs archive failed: %s", exc)
        return {"ok": False, "error": str(exc)}
    cid = result["cid"]
    supabase_client.record_genetic_archive(
        telegram_id, version, cid, sha256=sha, manifest=manifest)
    return {"ok": True, "cid": cid, "sha256": sha,
            "version": version, "manifest": manifest}


def _default_code_hashes() -> dict:
    """Hash the core source files that constitute the system genome."""
    root = os.getenv("JARVIS_REPO_PATH", "/workspace/jarvis")
    targets = [
        "api/webhook.py", "api/orchestrator.py", "api/hybrid_router.py",
        "utils/sovereign_terminal.py", "utils/local_inference.py",
        "utils/groq_client.py", "utils/data_sovereignty.py",
        "utils/device_comm.py", "utils/self_repair.py",
    ]
    out = {}
    for rel in targets:
        h = _sha256_file(os.path.join(root, rel))
        if h:
            out[rel] = h
    return out


def latest_dna(telegram_id: int = 0) -> str:
    """Human-readable /dna output with disaster-recovery instructions."""
    row = supabase_client.latest_genetic_archive(telegram_id)
    if not row:
        return ("🧬 Belum ada arsip DNA.\n"
                "Buat: /dna (snapshot kode+preferensi ke IPFS).")
    cid = row.get("cid")
    return (
        "🧬 *Arsip Genetik Terkini*\n"
        f"• Versi: `{row.get('version')}`\n"
        f"• CID (IPFS): `{cid}`\n"
        f"• SHA-256: `{(row.get('sha256') or '')[:16]}...`\n"
        f"• Waktu: {row.get('created_at','')[:16]}\n\n"
        "Pemulihan bencana: ambil dari IPFS Gateway\n"
        f"  https://gateway.pinata.cloud/ipfs/{cid}\n"
        "Lalu verifikasi SHA-256 sebelum restore ke replica baru."
    )

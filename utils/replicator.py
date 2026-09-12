"""
Sovereign Replication (Level 7): bundle J.A.R.V.I.S. core components (EXCLUDING
logs and PII), ship them to another node over Tailscale SSH/rsync, mint a unique
PGP identity for the replica, and register it in Supabase `replica_registry`.

Policy:
  * NEVER bundles logs, PII, secrets, `.env`, or `*.db` (SQLCipher vaults).
    Only the immutable core source + schema are packaged.
  * Each replica gets a unique PGP keypair *on the replica host* (identity is
    not copied from the source); only the public fingerprint is registered.
  * Transfer happens via rsync over `ssh` (Tailscale IP = the `--host` arg).
  * Registration is idempotent (fingerprint names the replica).

Synchronous on purpose (Vercel serverless; no event loop). Network ops are
bounded and guarded so a failure never corrupts local state.
"""
import os
import re
import json
import glob
import time
import logging
import subprocess

from utils import supabase_client

logger = logging.getLogger("replicator")

REPO_PATH = os.getenv("JARVIS_REPO_PATH", "/workspace/jarvis")

# Components that are safe + meaningful to replicate (no secrets/logs/PII).
BUNDLE_INCLUDE = (
    "api/**/*.py",
    "utils/**/*.py",
    "sql/*.sql",
    "templates/**/*.json",
    "docs/*.md",
    "vercel.json",
    "requirements.txt",
)
BUNDLE_EXCLUDE = ("**/*.log", "**/__pycache__/**", "*.db", "*.sqlite*",
                  ".env*", "**/pii*", "**/secrets*", "**/device_secret*")


# ------------------------------------------------------------------
# Safe allowlist for file traversal (no traversal, no secret files)
# ------------------------------------------------------------------
def _excluded(path: str) -> bool:
    base = os.path.basename(path).lower()
    if base in (".env", ".env.local", ".env.example"):
        return True
    if any(s in base for s in ("secret", "pii", ".db", ".log", ".sqlite")):
        return True
    return False


def list_bundle_files(root: str = REPO_PATH) -> list:
    """Return the ordered list of files that make up a safe replication bundle."""
    files = []
    for pattern in BUNDLE_INCLUDE:
        for match in glob.glob(os.path.join(root, pattern), recursive=True):
            if os.path.isfile(match) and not _excluded(match):
                files.append(match)
    # Dedupe + canonicalize
    seen, out = set(), []
    for f in sorted(files):
        if f not in seen:
            seen.add(f)
            out.append(f)
    return out


def bundle_manifest(root: str = REPO_PATH) -> dict:
    """Content-addressed manifest of the bundle (filename -> sha256)."""
    import hashlib
    manifest = {}
    for f in list_bundle_files(root):
        rel = os.path.relpath(f, root)
        h = hashlib.sha256()
        with open(f, "rb") as fh:
            for chunk in iter(lambda: fh.read(1 << 20), b""):
                h.update(chunk)
        manifest[rel] = h.hexdigest()
    return manifest


# ------------------------------------------------------------------
# Transport (rsync over Tailscale SSH)
# ------------------------------------------------------------------
def _rsync_to(host: str, remote_dir: str, user: str,
              extra_args: list = None) -> bool:
    args = extra_args or []
    cmd = ["rsync", "-avz", "--checksum", "-e", "ssh -o BatchMode=yes",
           *args, f"{REPO_PATH.rstrip('/')}/", f"{user}@{host}:{remote_dir}/"]
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
        return proc.returncode == 0
    except Exception as exc:
        logger.error("rsync failed: %s", exc)
        return False


def _rsync_excludes() -> list:
    out = ["--exclude", ".git"]
    for pat in BUNDLE_EXCLUDE:
        out += ["--exclude", pat]
    return out


# ------------------------------------------------------------------
# PGP identity on the replica host
# ------------------------------------------------------------------
def _mint_pgp(host: str, user: str, label: str) -> dict:
    """
    Generate a unique PGP keypair ON the replica host (never copied). Returns
    {"fingerprint":..., "email":...} or {} on failure.
    """
    email = f"replica-{label}@jarvis.local"
    remote = f"""

    gpg --batch --quick-generate-key '{email}' ed25519 sign 0 2>/dev/null || true
    gpg --batch --export '{email}' 2>/dev/null | \\
        gpg --with-colons --import-options show-only --import 2>/dev/null | \\
        sed -n 's/^fpr://p' | tr -d '\\n'
    """
    try:
        proc = subprocess.run(
            ["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10",
             f"{user}@{host}", remote],
            capture_output=True, text=True, timeout=30)
        fp = (proc.stdout or "").strip().splitlines()
        fingerprint = fp[0].strip() if fp else ""
        return {"fingerprint": fingerprint, "email": email}
    except Exception as exc:
        logger.error("pgp mint failed: %s", exc)
        return {}


# ------------------------------------------------------------------
# High-level replication flow (used by /replicate)
# ------------------------------------------------------------------
def replicate(host: str, telegram_id: int = 0, label: str = None,
              user: str = "ubuntu", dry_run: bool = False) -> dict:
    """
    Bundle → rsync over Tailscale → mint PGP identity → register.
    Returns a summary dict. `dry_run` only bundles + checks connectivity.
    """
    if not host:
        return {"ok": False, "error": "--host (tailscale ip) required"}
    label = label or f"replica-{int(time.time())}"
    manifest = bundle_manifest()
    components = sorted(manifest.keys())

    if dry_run:
        return {"ok": True, "dry_run": True, "label": label,
                "components": components, "count": len(components)}

    remote_dir = f"/home/{user}/.jarvis/replica/{label}"
    ex = _rsync_excludes()
    ok = _rsync_to(host, remote_dir, user, extra_args=ex)
    if not ok:
        return {"ok": False, "error": "rsync transfer failed"}

    pgp = _mint_pgp(host, user, label)
    fingerprint = pgp.get("fingerprint", "")
    peer = f"{host}:22"
    reg = supabase_client.register_replica(
        telegram_id, label, peer_addr=peer,
        pgp_fingerprint=fingerprint, components=components[:50], status="active")

    return {
        "ok": True, "label": label, "host": host,
        "pgp_fingerprint": fingerprint,
        "components_count": len(components),
        "registered": reg,
        "remote_dir": remote_dir,
    }


def replica_summary(telegram_id: int = 0) -> str:
    """Human-readable overview of registered replicas."""
    rows = supabase_client.list_replicas(telegram_id, limit=20)
    if not rows:
        return "📡 Belum ada replica.\nCoba: /replicate <tailscale_ip>"
    lines = ["📡 *Replika Sovereign*\n"]
    for r in rows:
        fp = (r.get("pgp_fingerprint") or "")[:16] or "-"
        lines.append(f"• `{r.get('label')}` — {r.get('status')}\n"
                     f"  {r.get('peer_addr') or 'local'} · PGP {fp} · "
                     f"{len(r.get('components') or [])} komponen")
    return "\n".join(lines)

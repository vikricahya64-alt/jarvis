"""
Supabase Vault (pgsodium) access for encrypted credentials.

Secrets NEVER belong in code or env vars. This module stores/reads them via
SECURITY DEFINER RPCs (jv_write_secret / jv_read_secret) so the plaintext
only ever exists transiently in the Postgres backend and in this process
when a private-integration tool needs it.
"""
import os

import httpx

from utils import supabase_client


def write_secret(name: str, secret: str) -> str:
    """Encrypt and store a secret in Supabase Vault. Returns key id."""
    base, _ = supabase_client._config()
    with httpx.Client(timeout=supabase_client._TIMEOUT) as client:
        res = client.post(
            f"{base}/rest/v1/rpc/jv_write_secret",
            json={"p_name": name, "p_secret": secret},
            headers=supabase_client._auth_headers(),
        )
        supabase_client._raise_for(res, "vault.write")
        data = res.json()
        return data if isinstance(data, str) else str(data.get("key_id", ""))


def read_secret(name: str) -> str:
    """Read (decrypt) a secret from Supabase Vault by name. Raises if missing."""
    base, _ = supabase_client._config()
    with httpx.Client(timeout=supabase_client._TIMEOUT) as client:
        res = client.post(
            f"{base}/rest/v1/rpc/jv_read_secret",
            json={"p_name": name},
            headers=supabase_client._auth_headers(),
        )
        supabase_client._raise_for(res, "vault.read")
        data = res.json()
        return data if isinstance(data, str) else ""


def has_secret(name: str) -> bool:
    """True when a secret of this name exists in the vault."""
    try:
        read_secret(name)
        return True
    except Exception:
        return False


def delete_secret(name: str) -> bool:
    """Delete a vault secret by name. Returns True even if it never existed."""
    if not name:
        return False
    base, _ = supabase_client._config()
    with httpx.Client(timeout=supabase_client._TIMEOUT) as client:
        res = client.post(
            f"{base}/rest/v1/rpc/jv_delete_secret",
            json={"p_name": name},
            headers=supabase_client._auth_headers(),
        )
        return res.status_code < 500


def fetch_secret(name: str) -> str:
    """
    Runtime secret retrieval (Level 3 spec `fetch_secret`).

    Tries Supabase Vault first (encrypted credentials end-to-end);
    falls back to a Vercel/environment variable under the same name so a
    deployment can migrate from env vars to Vault without code changes.
    Never logs the value. Raises RuntimeError when neither source has it.
    """
    try:
        return read_secret(name)
    except Exception:
        pass
    value = os.getenv(name)
    if value:
        return value
    raise RuntimeError(f"secret '{name}' tidak ditemukan (Vault maupun env)")
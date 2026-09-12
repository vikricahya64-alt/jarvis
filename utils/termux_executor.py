"""
Termux/AnyClaw executor: dispatch commands + file ops to Android device via HTTP tunnel.

JARVIS calls the server directly through a cloudflared tunnel URL.
No Firebase, no extra API keys — just HTTP POST to the tunnel.
"""
import os
import logging

import httpx

logger = logging.getLogger("termux_executor")

# Tunnel URL set via env var (e.g. https://abc-123.trycloudflare.com)
TERMUX_TUNNEL_URL = os.getenv("TERMUX_TUNNEL_URL", "").rstrip("/")
TIMEOUT = 10.0

# Dangerous commands that must never be forwarded.
BLOCKED_COMMANDS = [
    "rm -rf /", "rm -rf /*", "mkfs", "dd if=", "> /dev/",
    ":(){ :|:& };:", "chmod -R 777 /", "chown -R",
    "wget", "curl", "shutdown", "reboot", "halt", "poweroff",
]


def _is_blocked(command: str) -> bool:
    c = command.lower().strip()
    for pattern in BLOCKED_COMMANDS:
        if pattern.lower() in c:
            return True
    return False


def _post(endpoint: str, payload: dict, timeout: float = TIMEOUT) -> dict:
    """Generic POST to tunnel, returns parsed JSON or error dict."""
    if not TERMUX_TUNNEL_URL:
        return {"success": False, "error": "TERMUX_TUNNEL_URL belum di-set. Jalankan server di AnyClaw/Termux dulu."}
    try:
        with httpx.Client(timeout=timeout) as client:
            resp = client.post(f"{TERMUX_TUNNEL_URL}{endpoint}", json=payload)
            resp.raise_for_status()
            return resp.json()
    except httpx.ConnectError:
        return {"success": False, "error": "Device tidak bisa dijangkau. Pastikan server + tunnel aktif."}
    except httpx.TimeoutException:
        return {"success": False, "error": f"Timeout — device tidak merespons."}
    except Exception as exc:
        return {"success": False, "error": f"Connection error: {exc}"}


def execute_command(command: str, timeout: int = 30, telegram_id: int = None) -> dict:
    """Send a shell command to the device and wait for result."""
    if _is_blocked(command):
        return {"success": False, "error": "Command ini diblokir karena berpotensi berbahaya."}

    timeout = max(5, min(timeout, 60))
    data = _post("/execute", {"command": command, "timeout": timeout})

    if data.get("success"):
        return {
            "success": True,
            "stdout": (data.get("stdout") or "")[:5000],
            "stderr": (data.get("stderr") or "")[:2000],
            "exit_code": data.get("exit_code", -1),
        }
    return {"success": False, "error": data.get("error", "Unknown error from device")}


def read_file(filepath: str) -> dict:
    """Read a file from the device."""
    data = _post("/readfile", {"filepath": filepath})
    if data.get("success"):
        return {"success": True, "content": (data.get("content") or "")[:20000]}
    return {"success": False, "error": data.get("error", "Gagal membaca file.")}


def write_file(filepath: str, content: str) -> dict:
    """Write a file to the device."""
    data = _post("/writefile", {"filepath": filepath, "content": content})
    if data.get("success"):
        return {"success": True, "bytes": data.get("bytes", 0)}
    return {"success": False, "error": data.get("error", "Gagal menulis file.")}


def list_directory(dirpath: str = ".") -> dict:
    """List contents of a directory on the device."""
    data = _post("/listdir", {"dirpath": dirpath})
    if data.get("success"):
        items = data.get("items", [])
        return {"success": True, "items": items[:100]}
    return {"success": False, "error": data.get("error", "Gagal list directory.")}


def check_device_status() -> dict:
    """Ping the device to check if it's online."""
    if not TERMUX_TUNNEL_URL:
        return {"online": False, "error": "TERMUX_TUNNEL_URL belum di-set."}
    try:
        with httpx.Client(timeout=5.0) as client:
            resp = client.get(f"{TERMUX_TUNNEL_URL}/ping")
            resp.raise_for_status()
            data = resp.json()
        return {"online": True, "hostname": data.get("hostname", "?"), "uptime": data.get("uptime", "?")}
    except Exception:
        return {"online": False, "error": "Device tidak merespons."}

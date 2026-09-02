"""
Local secrets loader for the Realme C25s Termux core.

Loads credentials from a local secrets file (default ~/.jarvis.env) that is
NEVER committed to the repo. Precedence: real environment variables > file dotenv.

Format (one KEY=VALUE per line, optional `export ` prefix, `#` comments):
    DEVICE_SHARED_SECRET=...
    DEVICE_GATEWAY=<base URL, e.g. https://jarvis-sigma-navy.vercel.app/api/device_gateway>
    DEVICE_MODEL=Qwen2.5-1.5B
    JARVIS_DEVICE_LOG=/mnt/device_data/.jarvis/device.log  (optional)
    JARVIS_TEMP_THROTTLE_C=55   (optional throttle threshold)
"""
import os
import sys

DEFAULT_SECRETS_PATH = os.path.expanduser("~/.jarvis.env")


def parse_dotenv(text: str) -> dict:
    """Parse dotenv text lines -> dict. Returns {} on malformed input."""
    out = {}
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("export "):
            line = line[len("export "):]
        if "=" not in line:
            continue
        key, _, value = line.partition("=")
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        if key:
            out[key] = value
    return out


def load_secrets(path: str = None) -> dict:
    """Return a merged dict of secrets (env vars override the dotenv file)."""
    path = path or DEFAULT_SECRETS_PATH
    merged = {}
    if os.path.exists(path):
        try:
            with open(path, "r", encoding="utf-8") as fh:
                merged.update(parse_dotenv(fh.read()))
        except OSError as exc:
            print(f"[local_secrets] warning: cannot read {path}: {exc}",
                  file=sys.stderr)
    # Environment wins over file.
    for key, value in os.environ.items():
        if key.startswith("DEVICE_") or key.startswith("JARVIS_") or key == "TELEGRAM_BOT_TOKEN":
            merged[key] = value
    return merged


def get(path: str = None, **defaults) -> dict:
    """Return secrets populated with defaults for missing keys."""
    data = load_secrets(path)
    for key, value in defaults.items():
        data.setdefault(key, value)
    return data

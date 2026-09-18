"""
Private Edge Proxy (Level 7): route sensitive/heavy inference to the Oracle
Cloud Always Free ARM node via a Tailscale/DNS endpoint, with health checks,
bounded connection pooling, latency tracking, and seamless fallback to Groq.

Failure ladder (highest priority first):
    Oracle private edge  ->  Groq public cloud  ->  503

Why HTTPS (not raw IP) from Vercel:
  * Vercel serverless runs OUTSIDE the tailnet (no TUN), so it cannot dial an
    RFC1918/100.x Overlay address directly. Instead it reaches the Oracle node's
    Nginx reverse-proxy, which terminates TLS and is itself a Tailscale subnet
    router. The PHONE reaches the edge over Tailscale; Vercel reaches it over
    the public HTTPS endpoint that the same edge exposes.
  * The endpoint therefore accepts BOTH: a `JARVIS_EDGE_URL` (public HTTPS) and
    optional `JARVIS_EDGE_TAILSCALE_URL` for environments that ARE on the mesh.

    Route  /api/private_edge    GET  -> health probe + latency
    Route  /api/private_edge    POST -> {"prompt": "...", "max_tokens": N}
        -> forwards to Oracle /v1/chat/completions (Ollama) with TLS
        -> falls back to Groq plain_completion on failure
        -> returns {"engine":"oracle"|"groq", "text":..., "latency_ms": N}

Privacy: prompts are redacted server-side via data_sovereignty before they ever
hit the network. Oracle and Groq never see unredacted PII — enforced here.

Synchronous on purpose (Vercel serverless rejects asyncio.run -> EBUSY).
Connection pooling is a tiny httpx.HTTPTransport pool recreated per request
(serverless is per-request scoped; we keep the interface but bound it).
"""
import os
import time
import logging
import httpx

from utils import data_sovereignty as ds

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("private_edge_proxy")

EDGE_TIMEOUT_S = 25.0       # Oracle must answer within budget
EDGE_MODEL = "qwen2.5-7b"   # Ollama model tag on the Oracle node (see docs)
POOL_LIMITS = httpx.Limits(max_keepalive_connections=4,
                           max_connections=8)


# ------------------------------------------------------------------
# Oracle edge transport (connection-pooled, bounded)
# ------------------------------------------------------------------
def _edge_base() -> str:
    """Resolve the Oracle edge base URL. Falls back gracefully if not set."""
    url = (os.getenv("JARVIS_EDGE_URL") or "").rstrip("/")
    if not url:
        raise RuntimeError("JARVIS_EDGE_URL not configured (Oracle edge offline)")
    return url


def _oracle_completion(prompt: str, max_tokens: int = 256) -> str:
    """
    POST to the Oracle Ollama endpoint via the Nginx TLS reverse proxy.
    The Nginx location is aliased to Ollama's /api/chat (stream:false).
    Returns the generated text; raises on any failure.
    """
    base = _edge_base()
    model = os.getenv("JARVIS_EDGE_MODEL", EDGE_MODEL)
    url = f"{base}/v1/chat/completions"     # OpenAI-compatible Ollama surface
    payload = {
        "model": model,
        "messages": [{"role": "user", "content": prompt}],
        "stream": False,
        "options": {"temperature": 0.4, "num_predict": max_tokens},
    }
    headers = {"Content-Type": "application/json"}
    token = os.getenv("JARVIS_EDGE_AUTH")
    if token:
        headers["Authorization"] = f"Bearer {token}"
    with httpx.Client(timeout=EDGE_TIMEOUT_S, limits=POOL_LIMITS) as client:
        res = client.post(url, json=payload, headers=headers)
        res.raise_for_status()
        data = res.json()
    choices = data.get("choices") or []
    if not choices:
        raise RuntimeError("Oracle edge returned no choices")
    return (choices[0].get("message", {}).get("content") or "").strip()


def _groq_completion(prompt: str, max_tokens: int) -> str:
    """Fallback to Groq public cloud."""
    from utils import groq_client
    raw = groq_client.plain_completion(
        "Jawab dalam bahasa Indonesia. Ringkas dan to the point.",
        prompt[:4000], max_tokens=max_tokens, temperature=0.4)
    return (raw or "").strip()


# ------------------------------------------------------------------
# Public entry point (also used by orchestrator/webhook for routing)
# ------------------------------------------------------------------
def infer(prompt: str, telegram_id: int = 0, max_tokens: int = 256) -> dict:
    """
    Primary inference dispatch. Returns:
      {"ok":True, "engine":"oracle"|"groq", "text":..., "latency_ms":N,
       "redacted":bool}
    or {"ok":False, "error":...}
    PII is redacted (reversibly) before any network send regardless of engine.
    """
    t0 = time.time()
    redacted = ds.scan_and_redact(prompt)
    safe_prompt = redacted["text"]

    # 1) Try Oracle private edge.
    try:
        text = _oracle_completion(safe_prompt, max_tokens)
        latency = int((time.time() - t0) * 1000)
        return {"ok": True, "engine": "oracle", "text": text,
                "latency_ms": latency, "redacted": redacted["pii_detected"]}
    except Exception as exc:
        logger.warning("Oracle edge failed (%s); falling back to Groq", exc)

    # 2) Fall back to Groq.
    try:
        text = _groq_completion(safe_prompt, max_tokens)
        latency = int((time.time() - t0) * 1000)
        return {"ok": True, "engine": "groq", "text": text,
                "latency_ms": latency, "redacted": redacted["pii_detected"]}
    except Exception as exc:
        return {"ok": False, "error": f"edge+groq unavailable: {exc}",
                "latency_ms": int((time.time() - t0) * 1000)}


def health() -> dict:
    """Probe the Oracle edge availability + latency without burning tokens."""
    t0 = time.time()
    status = {"oracle_edge": "down", "groq": "unknown",
              "latency_ms": 0, "configured": bool(os.getenv("JARVIS_EDGE_URL"))}
    try:
        base = _edge_base()
        with httpx.Client(timeout=6.0, limits=POOL_LIMITS) as client:
            res = client.get(f"{base}/health")
            res.raise_for_status()
        status["oracle_edge"] = "up"
        status["latency_ms"] = int((time.time() - t0) * 1000)
    except Exception:
        status["oracle_edge"] = "down"
    try:
        from utils import groq_client
        if groq_client.GROQ_AVAILABLE and os.getenv("GROQ_API_KEY"):
            status["groq"] = "up"
    except Exception:
        status["groq"] = "unknown"
    return status


# ------------------------------------------------------------------
# Library surface (imported by orchestrator/webhook + simulator_proxy route).
# This file is intentionally NOT a standalone serverless function to keep the
# Hobby-plan 12-function limit. The HTTP route lives in api/simulator_proxy.py
# under /api/simulate mode=private_edge.
# ------------------------------------------------------------------
if __name__ == "__main__":
    # Quick smoke test: python api/private_edge_proxy.py
    print(health())
    print(infer("Berapa ibu kota Indonesia?"))

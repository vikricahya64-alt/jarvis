"""
Sovereign Terminal local inference (Level 7, Realme C25s / Unisoc T610 / 4GB).

The phone NEVER runs heavy models. It only runs a tiny, quantized, CPU-friendly
model — Qwen2.5-1.5B-Instruct-Q4_K_M — capped at 1024 context tokens. Anything
heavier is offloaded to the private edge (Oracle Cloud Always Free ARM) or the
public cloud (Groq). See utils/sovereign_terminal.py for the guardrails that
decide *when* this local path is allowed to run at all.

Contract:
  * max_context_tokens = 1024 (hard cap; longer prompts are truncated before
    the model is invoked — never exceed the phone's 4GB budget).
  * Q4_K_M quantization so the 1.5B model fits comfortably in memory.
  * The actual engine binary is swappable (llama.cpp / MLC LLM / Ollama) via
    env var; the module exposes a stable interface: `local_generate(prompt)`.
  * If the engine is unavailable, returns a clear sentinel so the caller can
    fall back to the cloud — it must NEVER crash the pipeline.

This is the LOWEST rung of the hybrid ladder:
    public cloud (Groq) > private edge (Oracle) > local terminal (Qwen-1.5B).
"""
import os
import json
import logging
import subprocess
import sys

logger = logging.getLogger("local_inference")

# Cost / resource contract for the Helio G85 (4GB).
MAX_CONTEXT_TOKENS = 1024          # hard cap — never exceed on the phone
MODEL_NAME = "Qwen2.5-1.5B-Instruct-Q4_K_M"
MAX_GEN_LEN = 256                  # generation tokens per call
INFER_TIMEOUT_S = 60               # generous for a CPU phone, but bounded

# Engines we can auto-detect. Priority: llama.cpp > MLC > Ollama.
_ENGINES = ("LLAMA_CLI", "MLC_CLI", "OLLAMA_BIN")


def _settings() -> dict:
    """Resolve engine settings from env with sane defaults."""
    roots = {
        "LLAMA_CLI": os.getenv("LLAMA_CLI", "./.llm/llama-cli"),
        "MLC_CLI": os.getenv("MLC_CLI", "./.llm/mlc_llm_cli"),
        "OLLAMA_BIN": os.getenv("OLLAMA_BIN", "ollama"),
    }
    model = os.getenv("JARVIS_LOCAL_MODEL", MODEL_NAME)
    max_ctx = int(os.getenv("JARVIS_LOCAL_MAX_CTX", MAX_CONTEXT_TOKENS))
    max_gen = int(os.getenv("JARVIS_LOCAL_MAX_GEN", MAX_GEN_LEN))
    return {**roots, "model": model, "max_ctx": max_ctx, "max_gen": max_gen}


def _pick_engine(settings: dict):
    """Return the first available engine name or None."""
    for eng in _ENGINES:
        path = settings.get(eng)
        if not path:
            continue
        if "/" in path or os.sep in path:
            if os.path.exists(path):
                return eng
        else:
            # A bare command (e.g. 'ollama') — assume present on PATH.
            return eng
    return None


def truncate_to_context(prompt: str, max_tokens: int = MAX_CONTEXT_TOKENS) -> str:
    """Cheap token approximation: limit prompt to a fraction of the max context
    so we always leave room for the assistant's generated tokens. Uses a
    conservative 4-char-per-token heuristic (good enough for cap enforcement)."""
    if not prompt:
        return ""
    max_chars = max(16, max_tokens * 4 - 64)  # reserve ~64 chars for output
    if len(prompt) <= max_chars:
        return prompt
    return prompt[:max_chars]  # keep head only (subject first)


# ------------------------------------------------------------------
# Engine backends (each returns str; raises on engine-level failure)
# ------------------------------------------------------------------
def _run_llama_cli(settings: dict, prompt: str) -> str:
    cmd = [settings["LLAMA_CLI"], "-m", settings["model"],
           "-n", str(settings["max_gen"]),
           "-c", str(settings["max_ctx"]),
           "-p", prompt, "--temp", "0.6",
           "--no-display-prompt", "-ngl", "0",   # CPU only
           "-t", "4"]                            # 4 threads (G85 has 8, use half)
    proc = subprocess.run(cmd, capture_output=True, text=True,
                          timeout=INFER_TIMEOUT_S)
    out = (proc.stdout or "").strip()
    if not out:
        raise RuntimeError("llama.cpp produced empty output")
    return out


def _run_mlc_cli(settings: dict, prompt: str) -> str:
    cmd = [settings["MLC_CLI"], "--model", settings["model"],
           "--prompt", prompt,
           "--max-gen-len", str(settings["max_gen"]),
           "--device", "cpu",
           "--overrides", f'{"context_window_size":{settings["max_ctx"]}}']
    proc = subprocess.run(cmd, capture_output=True, text=True,
                          timeout=INFER_TIMEOUT_S)
    out = (proc.stdout or "").strip()
    if not out:
        raise RuntimeError("MLC CLI produced empty output")
    return out


def _run_ollama(settings: dict, prompt: str) -> str:
    import httpx
    tag = settings["model"]
    with httpx.Client(timeout=INFER_TIMEOUT_S) as client:
        r = client.post("http://localhost:11434/api/generate",
                        json={"model": tag, "prompt": prompt,
                              "stream": False,
                              "options": {"num_ctx": settings["max_ctx"],
                                          "num_predict": settings["max_gen"]}})
        r.raise_for_status()
        return (r.json().get("response") or "").strip()


_ENGINE_CALLS = {
    "LLAMA_CLI": _run_llama_cli,
    "MLC_CLI": _run_mlc_cli,
    "OLLAMA_BIN": _run_ollama,
}


# ------------------------------------------------------------------
# Public interface
# ------------------------------------------------------------------
def local_generate(prompt: str) -> dict:
    """
    Run inference on the phone using ONLY Qwen2.5-1.5B-Instruct-Q4_K_M.
    Returns {"ok":True,"text":...,"engine":"llama-cli","tokens":N} on success,
    or {"ok":False,"error":...} so callers can fall back to cloud.
    The prompt is ALWAYS truncated to the context budget before the model runs.
    """
    settings = _settings()
    engine = _pick_engine(settings)
    if not engine:
        return {"ok": False,
                "error": f"no LLM engine configured (set LLAMA_CLI/MLC_CLI/OLLAMA_BIN); "
                         f"model={settings['model']}"}

    capped = truncate_to_context(prompt, settings["max_ctx"])
    try:
        fn = _ENGINE_CALLS[engine]
        text = fn(settings, capped)
    except subprocess.TimeoutExpired:
        logger.warning("local inference timed out")
        return {"ok": False, "error": "timeout"}
    except Exception as exc:
        logger.warning("local inference failed: %s", exc)
        return {"ok": False, "error": str(exc)[:200]}

    return {"ok": True, "text": text.strip(), "engine": engine.lower(),
            "tokens": settings["max_gen"]}


def available() -> bool:
    """Quick check whether a local engine is present (for /device_health)."""
    return _pick_engine(_settings()) is not None


def health() -> dict:
    s = _settings()
    return {
        "model": s["model"],
        "max_context_tokens": s["max_ctx"],
        "engine": _pick_engine(s),
        "available": available(),
    }

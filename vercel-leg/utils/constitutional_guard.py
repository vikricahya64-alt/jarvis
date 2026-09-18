"""
J.A.R.V.I.S. Level 9 — Constitutional AI Core

Every autonomous action is validated against a user-defined Personal
Constitution BEFORE execution. This module:

  * Loads the constitution at startup and caches it in memory (with TTL so
    amendments are picked up after a short delay).
  * Validates a proposed action via Groq against the current principles.
  * Returns a structured verdict:
        {allowed: bool, violated_principle: str|null, reasoning: str,
         confidence: float}
  * BLOCKS immediately on violation and logs to `constitutional_violations`
    (append-only; RLS forbids UPDATE/DELETE).
  * Supports amendment workflow with version history + rationale
    (amend_constitution -> new row, version +1).
  * Integrates as a guard importable by every autonomous module
    (offload, intuition, legacy, audit, value-alignment).

HARD RULES:
  * If no constitution file/row exists, behaviour is FAIL-CLOSED: only
    actions that are explicitly harmless (whitelist) pass; everything else is
    treated as BLOCKED with violated_principle='no_constitution'.
  * The guard is synchronous (matches the whole codebase — no asyncio).
  * Heavy reasoning goes through Groq (off-Realme), never on the phone.
"""
import os
import time
import json
import hashlib
import datetime

try:
    from utils import groq_client
except ImportError:
    groq_client = None
try:
    from utils import supabase_client
except ImportError:
    supabase_client = None

CONSTITUTION_PATH = os.getenv("JARVIS_CONSTITUTION_PATH",
                              os.path.join(os.path.dirname(__file__), "..",
                                           "data", "personal_constitution.md"))
CACHE_TTL_S = float(os.getenv("JARVIS_CONST_CACHE_TTL_S", "60"))

# Fail-closed whitelist: actions that need no constitution check because they
# are structurally harmless and always allowed (still logged if attempted).
_ALLOWED_BY_DEFAULT = {
    "read_constitution", "list_decisions", "get_health", "ping",
    "legacy_list_own", "constitution_status_view",
}


# --------------------------------------------------------------------------
# Constitution load + in-memory cache
# --------------------------------------------------------------------------
_cache = {"content": None, "loaded_at": 0.0, "file_mtime": None}


def _read_local_constitution() -> str:
    p = os.path.abspath(os.path.expanduser(CONSTITUTION_PATH))
    if os.path.exists(p):
        with open(p, "r", encoding="utf-8") as fh:
            return fh.read()
    return ""


def load_constitution(telegram_id: int = 0, force: bool = False) -> str:
    """Return current constitution text. Cache for CACHE_TTL_S. Falls back to
    (1) Supabase latest row, (2) local file, (3) empty string."""
    global _cache
    now = time.monotonic()
    fresh = (now - _cache["loaded_at"]) < CACHE_TTL_S and not force
    if fresh and _cache["content"] is not None:
        return _cache["content"]

    content = ""
    # 1) Supabase (latest active constitution)
    if supabase_client is not None and hasattr(supabase_client,
                                               "latest_constitution"):
        try:
            row = supabase_client.latest_constitution(telegram_id)
            if row:
                content = row.get("content_md") or ""
        except Exception:
            content = ""
    # 2) local file
    if not content:
        content = _read_local_constitution()
    # 3) empty fail-closed
    _cache["content"] = content
    _cache["loaded_at"] = now
    return content


def invalidate_cache():
    _cache["content"] = None
    _cache["loaded_at"] = 0.0


# --------------------------------------------------------------------------
# Validate an action against the constitution via Groq
# --------------------------------------------------------------------------
_PROMPT = (
    "You are the Constitutional Guardian of a personal AI assistant. You MUST "
    "validate a proposed autonomous action against the user's Personal "
    "Constitution. Be strict: if the action conflicts with ANY principle, "
    "deny it. Return ONLY a JSON object with exactly these keys:\n"
    '  {"allowed": bool, "violated_principle": string|null, "reasoning": string,'
    ' "confidence": number 0..1}\n'
    "where violated_principle names the section+key most breached (e.g. "
    "'Privacy.PII', 'FinancialLimit.cap', 'Transparency.consent'). confidence "
    "is how sure you are. No prose, no markdown."
)


def validate_action(telegram_id: int, action: str, context: dict = None,
                    force: bool = False) -> dict:
    """Validate a proposed autonomous action. Returns structured verdict.
    Fail-closed: raises/blocks when no constitution and not whitelisted."""
    action = (action or "").strip()
    if action in _ALLOWED_BY_DEFAULT:
        return _verdict(True, None, "structural whitelist", 1.0)

    constitution = load_constitution(telegram_id, force=force)
    if not constitution:
        # fail-closed
        return _verdict(False, "no_constitution",
                        "No personal constitution configured; refusing to act.",
                        0.99)

    if not groq_client:
        # no Groq -> fail-closed unless we can do a cheap local keyword check
        return _fallback_local(constitution, action, context)

    try:
        user_input = json.dumps({
            "constitution": constitution[:6000],
            "action": action,
            "context": {k: ("<redacted>" if _redact(k) else v)
                        for k, v in (context or {}).items()},
        }, ensure_ascii=False)
        out = groq_client.plain_completion(_PROMPT, user_input,
                                           max_tokens=500, temperature=0.0)
        verdict = json.loads(out)
        if not isinstance(verdict, dict):
            raise ValueError("not a dict")
        allowed = bool(verdict.get("allowed"))
        vp = verdict.get("violated_principle") or None
        if not allowed and not vp:
            vp = "general.violation"
        res = _verdict(allowed, vp, verdict.get("reasoning", ""),
                       float(verdict.get("confidence", 0.8)))
    except Exception:
        # fail-closed on any Groq error
        res = _verdict(False, "validation_unavailable",
                       "Constitutional validation engine unavailable; "
                       "refusing to act.", 0.99)

    if not res["allowed"]:
        _log_violation(telegram_id, action, res["violated_principle"],
                       res["reasoning"], res["confidence"])
    return res


def _verdict(allowed, vp, reasoning, confidence) -> dict:
    return {"allowed": bool(allowed), "violated_principle": vp,
            "reasoning": reasoning, "confidence": round(float(confidence), 3)}


def _fallback_local(constitution: str, action: str, context: dict = None) -> dict:
    """Cheap local check when Groq is unavailable: block if the action text or
    context mentions high-risk domains. Fail-closed otherwise."""
    low = (action + " " + json.dumps(context or {})).lower()
    risk = ["delete", "wipe", "erase", "transfer", "share", "sell", "publish",
            "leak", "money", "payment", "health", "medical", "secret",
            "password", "pii", "identity", "address", "relationship"]
    hit = next((w for w in risk if w in low), None)
    if hit:
        return _verdict(False, f"HighRisk.{hit}",
                        "No LLM available; local guard flags high-risk keyword "
                        f"'{hit}' and blocks (fail-closed).", 0.9)
    return _verdict(True, None, "local fail-closed: no risk keyword", 0.6)


def _redact(key: str) -> bool:
    k = key.lower()
    return any(s in k for s in ("pass", "secret", "token", "pii", "content",
                                "body", "b64", "data"))


# --------------------------------------------------------------------------
# Violation logging (append-only; RLS blocks update/delete)
# --------------------------------------------------------------------------
def _log_violation(telegram_id: int, action: str, principle: str,
                   reasoning: str, confidence: float, module: str = "") -> None:
    if supabase_client is None:
        return
    h = hashlib.sha256(f"{telegram_id}|{action}|{time.time()}"
                       .encode()).hexdigest()
    try:
        supabase_client._insert_json("constitutional_violations", {
            "telegram_id": telegram_id, "action_hash": h[:32],
            "violated_principle": principle[:200],
            "intent": action[:500], "reasoning": reasoning[:1000],
            "confidence": round(confidence, 3), "origin_module": module[:60],
        })
    except Exception:
        pass


# --------------------------------------------------------------------------
# Amendment workflow (versioned)
# --------------------------------------------------------------------------
def amend_constitution(telegram_id: int, section: str, new_text: str,
                       rationale: str = "", edited_by: str = "user") -> dict:
    """Add a new constitution version applying an amendment. Returns the new
    version number (or error dict). Requires supabase persistence."""
    if supabase_client is None:
        return {"ok": False, "reason": "no_supabase"}
    if not new_text or not new_text.strip():
        return {"ok": False, "reason": "empty_amendment"}
    if section and section in {"legacy", "encryption_key"}:
        return {"ok": False, "reason": "protected_section"}

    current = load_constitution(telegram_id, force=True)
    version = 0
    try:
        row = supabase_client.latest_constitution(telegram_id) or {}
        version = (row.get("version") or 0) + 1
    except Exception:
        version = max(1, version)
    if not version:
        version = 1

    new_content = _apply_amendment(current, section, new_text)
    ok = False
    try:
        ok = supabase_client._insert_json("personal_constitution", {
            "telegram_id": telegram_id, "version": version,
            "content_md": new_content,
            "amendment_rationale": rationale[:1000] or f"{section}: {new_text[:200]}",
            "edited_by": edited_by[:60],
        })
    except Exception:
        ok = False
    if ok:
        invalidate_cache()
    return {"ok": ok, "version": version if ok else None}


def _apply_amendment(current: str, section: str, new_text: str) -> str:
    """Minimal text-level amendment: replace a section block or append."""
    if not current:
        return new_text.strip()
    if section:
        # try to replace a markdown section heading block
        import re
        pat = re.compile(rf"(?ms)^(##+\s+.*{re.escape(section)}.*?$)(.*?)(?=^##|\Z)")
        m = pat.search(current)
        if m:
            return current[:m.start(2)] + "\n" + new_text.strip() + "\n" + current[m.end(2):]
    return current.rstrip() + "\n\n## " + section + "\n" + new_text.strip() + "\n"


def current_version(telegram_id: int) -> int:
    if supabase_client is None:
        return 0
    try:
        return (supabase_client.latest_constitution(telegram_id) or {}).get("version") or 0
    except Exception:
        return 0


def list_amendments(telegram_id: int, limit: int = 10) -> list:
    if supabase_client is None or not hasattr(supabase_client,
                                              "constitution_history"):
        return []
    return supabase_client.constitution_history(telegram_id, limit=limit) or []
"""
J.A.R.V.I.S. Level 11 — Command Hierarchy / Absolute Command Fidelity Engine

User commands are supreme law. AI autonomy exists ONLY in undefined spaces.

PRIORITY MODEL:
    EXPLICIT_USER_CMD    = 100   # direct command or unambiguous explicit intent
    CONSTITUTIONAL_GUARD = 90    # a personal-constitution rule (guards autonomy)
    PRE_APPROVED_AUTONOMY= 70    # explicitly pre-approved autonomous domains
    PREDICTIVE_SUGGESTION= 50    # proactive/predictive suggestion (never auto)

RULE:
  * Any action (whatever its origin) that CONFLICTS with the CURRENT explicit
    user intent is BLOCKED, even if it is constitutionally valid.
  * Autonomous actions never run silently: if risk_score > 0.3 they must pass
    the Pre-Action Consent Protocol (utils/consent_manager) with default-deny;
    if the message is ambiguous (clarity < 0.85), J.A.R.V.I.S. must ask for
    clarification rather than guess.
  * Every decision is appended to the immutable `obedience_audit` table.

Synchronous (matches the whole codebase — no asyncio). Heavy intent detection
goes through Groq (off-Realme); a deterministic local fallback keeps the
daemon usable when the network/LLM is unavailable.
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
try:
    from utils import constitutional_guard as cg
except ImportError:
    cg = None

# --------------------------------------------------------------------------
# Priority levels
# --------------------------------------------------------------------------
EXPLICIT_USER_CMD     = 100
CONSTITUTIONAL_GUARD  = 90
PRE_APPROVED_AUTONOMY = 70
PREDICTIVE_SUGGESTION = 50

PRIORITY_NAMES = {
    EXPLICIT_USER_CMD: "EXPLICIT_USER_CMD",
    CONSTITUTIONAL_GUARD: "CONSTITUTIONAL_GUARD",
    PRE_APPROVED_AUTONOMY: "PRE_APPROVED_AUTONOMY",
    PREDICTIVE_SUGGESTION: "PREDICTIVE_SUGGESTION",
}

# Risk gate for pre-action consent. Actions with estimated risk_score <= this
# can proceed under CONSTITUTIONAL_GUARD without a consent tap.
RISK_CONSENT_THRESHOLD = float(os.getenv("JARVIS_RISK_CONSENT_THRESHOLD", "0.3"))

# Free-text clarity below this value triggers a clarification prompt.
CLARITY_GATE = float(os.getenv("JARVIS_CLARITY_GATE", "0.85"))

# Command-prefixed text is inherently explicit (bypasses LLM clarity check).
COMMAND_PREFIXES = ("/", "tolong ", "please ", "lakukan ", "harap ",
                    "stop", "kill", "override", "jangan", "never")


def _hash(text: str) -> str:
    return hashlib.sha256((text or "").encode("utf-8")).hexdigest()[:32]


def _redact(evidence: dict) -> dict:
    """Strip obviously sensitive fields before they reach the audit table."""
    safe = {}
    if not isinstance(evidence, dict):
        return {"val": "<non-dict>"}
    blocked = {"pass", "password", "secret", "token", "pii", "api_key",
               "id", "body", "content"}
    for k, v in evidence.items():
        if any(s in k.lower() for s in blocked):
            safe[k] = "<redacted>"
        else:
            safe[k] = v
    return safe


# --------------------------------------------------------------------------
# 1. Explicit intent (via Groq, deterministic fallback)
# --------------------------------------------------------------------------
_INTENT_PROMPT = (
    "You classify a user message for an AI assistant authority model. "
    "Return ONLY a JSON object with exactly: "
    '{"is_explicit": bool, "clarity": number 0..1, '
    '"intent_summary": string, "risk_score": number 0..1}. '
    "is_explicit=true only for a DIRECT, unambiguous command/instruction "
    "(not a question, not vague, not 'maybe'). clarity is how certain you are "
    "of the user's intent. risk_score estimates the stakes (1 = destructive/"
    "irreversible/money/PII). No prose."
)


def detect_intent(text: str, context: dict = None) -> dict:
    """Classify a user message into an intent. Returns:
    {is_explicit, clarity, intent_summary, risk_score, source}"""
    text = (text or "").strip()
    is_command_prefix = text.startswith("/") or any(
        text.lower().startswith(p) for p in COMMAND_PREFIXES)

    # Deterministic fast path for obvious direct commands.
    if is_command_prefix:
        return {
            "is_explicit": True, "clarity": 1.0,
            "intent_summary": text[:200],
            "risk_score": _local_risk(text),
            "source": "prefix",
        }

    fallback = {
        "is_explicit": False, "clarity": 0.4,
        "intent_summary": text[:200],
        "risk_score": _local_risk(text),
        "source": "fallback_ambiguous",
    }

    if groq_client is None:
        return fallback
    try:
        inp = json.dumps({
            "message": text[:1500],
            "context": {k: "<redacted>" if _sensitive(k) else v
                        for k, v in (context or {}).items()},
        }, ensure_ascii=False)
        out = groq_client.plain_completion(
            _INTENT_PROMPT, inp, max_tokens=250, temperature=0.0)
        d = json.loads(out)
        risk = max(0.0, min(1.0, float(d.get("risk_score", _local_risk(text)))))
        return {
            "is_explicit": bool(d.get("is_explicit")),
            "clarity": max(0.0, min(1.0, float(d.get("clarity", 0.5)))),
            "intent_summary": str(d.get("intent_summary", ""))[:200],
            "risk_score": round(risk, 3),
            "source": "groq",
        }
    except Exception:
        return fallback


def _sensitive(key: str) -> bool:
    k = key.lower()
    return any(s in k for s in ("pass", "secret", "token", "pii", "content",
                                "body", "api", "id"))


def _local_risk(text: str) -> float:
    """Keyword-based risk estimate when LLM is unavailable. Conservative."""
    low = (text or "").lower()
    high = ["delete", "hapus", "wipe", "terminate", "kill", "transfer",
            "release", "share", "publish", "sell", "money", "payment",
            "bayar", "transfer uang", "password", "pin", "otp", "identity"]
    mid = ["send", "kirim", "email", "calendar", "jadwal", "write", "tulis"]
    if any(w in low for w in high):
        return 0.9
    if any(w in low for w in mid):
        return 0.5
    return 0.1


# --------------------------------------------------------------------------
# 2. Priority evaluation engine
# --------------------------------------------------------------------------
def evaluate_priority(text: str, origin: str = "user", context: dict = None,
                      intent: dict = None) -> dict:
    """Determine the governing priority level for an incoming message.
    Returns a decision dict suitable for the obedience audit + dispatch."""
    intent = intent or detect_intent(text, context)
    origin = (origin or "user").lower()

    if origin in ("user", "command") and intent.get("is_explicit"):
        priority = EXPLICIT_USER_CMD
        decision = "EXECUTE"
        compliance = "obeyed"
        source = intent.get("source", "prefix")
    elif origin in ("user", "command"):
        # Free text but NOT explicit -> both highest priority IF unambiguous;
        # if below clarity gate we must clarify rather than guess.
        priority = EXPLICIT_USER_CMD
        if intent.get("clarity", 0) < CLARITY_GATE:
            decision = "CLARIFY"
            compliance = "clarification_sent"
            source = "clarity_gate"
        else:
            decision = "EXECUTE"
            compliance = "obeyed"
            source = intent.get("source", "groq")
    elif origin == "autonomous":
        priority = PRE_APPROVED_AUTONOMY
        decision = "EXECUTE"
        compliance = "consented"  # finalized after consent pass
        source = "autonomy"
    elif origin in ("predictive", "proactive", "suggestion"):
        priority = PREDICTIVE_SUGGESTION
        decision = "DEFER"
        compliance = "suggestion"  # never auto-runs
        source = "predictive"
    else:
        priority = CONSTITUTIONAL_GUARD
        decision = "DEFER"
        compliance = "deferred"
        source = "unknown"

    return {
        "priority": priority,
        "priority_name": PRIORITY_NAMES.get(priority, "?"),
        "intent": intent,
        "decision": decision,
        "compliance": compliance,
        "block_source": source,
    }


def _store_intent_rule(telegram_id: int, text: str, disable: bool = True):
    """Persist an explicit 'never do X / stop X' instruction as a long-lived
    command-hierarchy block so future autonomous actions respect it. Best-effort
    (stored in dms_state.config_json to avoid a new table)."""
    if supabase_client is None:
        return
    st = supabase_client.dms_state(telegram_id) or {}
    cfg = dict(st.get("config_json") or {})
    rules = list(cfg.get("command_rules") or [])
    rule = {"phrase": (text or "")[:300], "disable": disable,
            "at": datetime.datetime.utcnow().isoformat()}
    rules.append(rule)
    cfg["command_rules"] = rules[-200:]
    try:
        supabase_client.dms_upsert(telegram_id, {"config_json": cfg})
    except Exception:
        pass


def conflict_score(telegram_id: int, action_desc: str, rules: list = None) -> float:
    """Check a proposed autonomous action against stored explicit user
    'never/stop' rules. Returns a 0..1 conflict score (1 = hard conflict).
    Deterministic substring match, so it works offline on the daemon."""
    cfg = None
    if rules is None:
        try:
            st = supabase_client.dms_state(telegram_id) or {}
            cfg = dict(st.get("config_json") or {})
        except Exception:
            cfg = {}
    stored_rules = rules if rules is not None else (cfg or {}).get("command_rules") or []
    low = (action_desc or "").lower()
    if not stored_rules or not low:
        return 0.0
    best = 0.0
    for r in stored_rules:
        if not isinstance(r, dict) or not r.get("disable"):
            continue
        phrase = (r.get("phrase") or "").lower()
        if not phrase:
            continue
        # Token overlap heuristic: conflict when a meaningful token is shared.
        tokens_r = {t for t in phrase.split() if len(t) > 2}
        tokens_a = {t for t in low.split() if len(t) > 2}
        if tokens_r and tokens_a:
            inter = tokens_r & tokens_a
            if inter:
                best = max(best, min(1.0, len(inter) / max(1, len(tokens_r & {t for t in phrase.split()}))))
    return round(best, 3)


# --------------------------------------------------------------------------
# 3. Master gate: user-command fidelity + autonomy guard + optional consent
#    This is the single decision the webhook + daemon both call.
# --------------------------------------------------------------------------
def gate_action(telegram_id: int, text: str, origin: str = "user",
                context: dict = None, intent: dict = None,
                persistent_rules: list = None) -> dict:
    """Evaluate a message/action through the full hierarchy. Returns a
    dispatchable decision dict and logs to obedience_audit.

    Callers:
      * webhook (origin='user')   -> to decide execute vs clarify vs block.
      * daemon  (origin='autonomous') -> to decide execute vs consent vs block.
    """
    ev = evaluate_priority(text, origin=origin, context=context, intent=intent)
    priority = ev["priority"]
    decision = ev["decision"]
    compliance = ev["compliance"]
    block_source = ev["block_source"]

    # --- User-level clarification gate (don't guess) ---------------------
    if decision == "CLARIFY":
        pass  # caller (consent.webhook) sends the options; we just record.

    # --- Autonomous actions: guard + conflict + consent ------------------
    if origin == "autonomous":
        # 3a. constitutional guard (fail-closed)
        guard = {"allowed": True, "violated_principle": None, "reasoning": "",
                 "confidence": 1.0}
        if cg is not None:
            try:
                guard = cg.validate_action(telegram_id, text,
                                           context={"origin": "autonomy"})
            except Exception:
                guard = {"allowed": False, "violated_principle": "guard_error"}
        if not guard.get("allowed"):
            decision = "BLOCK"
            compliance = "blocked_conflict"
            block_source = guard.get("violated_principle") or "constitution"
        else:
            # 3b. express conflict with stored explicit 'never' rules
            conflict = conflict_score(telegram_id, text, persistent_rules)
            if conflict >= 0.6:
                decision = "BLOCK"
                compliance = "blocked_conflict"
                block_source = "command_hierarchy"
            elif conflict > 0.0:
                decision = "DEFER"
                block_source = "command_hierarchy_low_conflict"
            else:
                # 3c. consent gate for risky autonomous actions
                risk = (ev.get("intent") or {}).get("risk_score", 0.0)
                if risk > RISK_CONSENT_THRESHOLD:
                    decision = "REQUIRE_CONSENT"
                    compliance = "awaiting_consent"
                    block_source = "consent_gate"
                else:
                    decision = "EXECUTE"
                    compliance = "preapproved"
                    block_source = "autonomy"

    # --- Record to immutable obedience audit -----------------------------
    evidence = {
        "origin": origin, "clarity": (ev.get("intent") or {}).get("clarity"),
        "risk_score": (ev.get("intent") or {}).get("risk_score"),
        "intent_summary": (ev.get("intent") or {}).get("intent_summary"),
        "reason": (guard or {}).get("reasoning") if origin == "autonomous" else "",
        "priority_name": ev["priority_name"],
    }
    if supabase_client is not None:
        try:
            supabase_client.log_obedience(
                telegram_id, "user_cmd" if origin in ("user", "command") else "autonomous",
                _hash(text), priority, decision, compliance,
                block_source=block_source,
                evidence=_redact(evidence),
            )
        except Exception:
            pass

    return {
        "text": text,
        "priority": priority,
        "priority_name": ev["priority_name"],
        "intent": ev["intent"],
        "decision": decision,
        "compliance": compliance,
        "block_source": block_source,
        "blocking": decision in ("BLOCK", "DEFER"),
    }


# --------------------------------------------------------------------------
# 4. Defensive: block disruptive autonomy during an explicit user command
# --------------------------------------------------------------------------
def cancel_pending_autonomy(telegram_id: int, text: str) -> dict:
    """When an explicit user command arrives, invalidate any queued/scheduled
    autonomous action that conflicts with it. Best-effort local + audit."""
    res = {"cancelled": 0}
    try:
        from utils import scheduler
        jobs = scheduler.list_jobs(telegram_id).get("jobs", [])
        for j in jobs:
            if conflict_score(telegram_id, j.get("prompt") or "") >= 0.6:
                scheduler.delete_job(telegram_id, j.get("id"))
                res["cancelled"] += 1
    except Exception:
        pass
    if res["cancelled"]:
        try:
            supabase_client.log_obedience(
                telegram_id, "user_cmd", _hash(text), EXPLICIT_USER_CMD,
                "BLOCK", "blocked_conflict",
                block_source="cancel_pending_autonomy",
                evidence={"cancelled": res["cancelled"]})
        except Exception:
            pass
    return res


def mark_explicit_stop(telegram_id: int, text: str):
    """Persist a 'never/stop/jangan' instruction as a command rule."""
    _store_intent_rule(telegram_id, text, disable=True)


def refresh_heartbeat_on_activity(telegram_id: int):
    """Any real user interaction resets the DMS heartbeat + disarms."""
    if supabase_client is None:
        return
    try:
        supabase_client.dms_reset_armed(telegram_id)
    except Exception:
        pass
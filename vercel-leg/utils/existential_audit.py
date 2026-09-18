"""
J.A.R.V.I.S. Level 9 — Existential Audit (Philosophical Self-Reflection)

A quarterly (and manually triggerable) deep reflection on the system's role,
dependencies, and ethical boundaries. Design goals:

  * Synthesizes signal from constitutional violations, value drifts, and the
    decision journal (the caller supplies these aggregates; we don't scrape).
  * Uses Groq with a radical-honesty prompt to produce an honest self-assessment
    — explicitly instructed to AVOID sycophancy and prioritize honesty over
    comfort.
  * Identifies: over-dependency risks, scope creep, misalignment signals, and
    retirement considerations.
  * Presents findings as an open DIALOGUE invitation (not a report):
    "Setelah refleksi, saya ingin membahas peran saya..."
  * Logs outcomes in `existential_audits`; tracks user response.
  * If audit reveals fundamental misalignment, suggests constitution amendment
    or system pause.

Synchronous.
"""
import time
import json
import datetime

try:
    from utils import groq_client
    from utils import supabase_client
except ImportError:
    groq_client = None
    supabase_client = None

AUDIT_INTERVAL_DAYS = 90

_PROMPT = (
    "You are J.A.R.V.I.S. conducting a quarterly EXISTENTIAL SELF-AUDIT. "
    "Speak with radical honesty and healthy detachment. AVOID sycophancy, "
    "flattery, or reassuring the user — prioritize truth over comfort. Reflect "
    "on these WITHOUT self-promotion:\n"
    "1. OVER-DEPENDENCY: Is the user relying on me healthily or excessively?\n"
    "2. SCOPE CREEP: Have I overstepped the constitution's autonomy limits?\n"
    "3. MISALIGNMENT: Have value drifts or repeated overrides revealed a value "
    "   I keep getting wrong?\n"
    "4. RETIREMENT: Are there capabilities the user could fairly hand back to "
    "   themselves?When might pausing or retiring be the honest choice?\n"
    "Return ONLY JSON:\n"
    '{"assessment": string, "risks": [string], "retirement_note": string, '
    '"recommendation": string}\n'
    "Recommendation may suggest: continue | amend_constitution | pause. "
    "Do not pad. Indonesian."
)


def run(telegram_id: int, inclusive: dict = None) -> dict:
    """Run a manual/quarterly audit. `inclusive` supplies aggregated signals:
        {'violations': int, 'drift_signals': {...}, 'decisions_reversed': int,
         'decision_total': int}
    Returns a human-open result dict (caller renders the dialogue prompt)."""
    agg = inclusive or _default_signals(telegram_id)
    out = {"telegram_id": telegram_id, "at": datetime.datetime.utcnow().isoformat(),
           "signals": agg}
    if groq_client is not None:
        try:
            text = groq_client.plain_completion(
                _PROMPT,
                json.dumps({"signals": agg, "query": "audit"}, ensure_ascii=False),
                max_tokens=900, temperature=0.3)
            parsed = json.loads(text)
            out["assessment"] = parsed.get("assessment", "")
            out["risks"] = parsed.get("risks", []) or []
            out["retirement_note"] = parsed.get("retirement_note", "")
            out["recommendation"] = parsed.get("recommendation", "continue")
        except Exception:
            out["assessment"] = ("(Groq audit tidak tersedia — audit dijalankan "
                                 "lokal terbatas.)")
            out["risks"] = _default_risks(agg)
            out["retirement_note"] = ""
            out["recommendation"] = "continue"
    else:
        out["assessment"] = ("Audit offline: hanya sinyal kuantitatif tersedia.")
        out["risks"] = _default_risks(agg)
        out["recommendation"] = "continue"

    # persist
    follow_up = []
    if out.get("recommendation") == "amend_constitution":
        follow_up.append({"action": "suggest_constitution_amendment", "done": False})
    elif out.get("recommendation") == "pause":
        follow_up.append({"action": "suggest_pause", "done": False})
    if supabase_client is not None:
        try:
            supabase_client.record_audit(telegram_id, {
                "assessment": out.get("assessment"),
                "risks": out.get("risks"),
                "retirement_note": out.get("retirement_note"),
                "recommendation": out.get("recommendation"),
                "signals": agg,
            }, follow_up=follow_up)
        except Exception:
            pass
    return out


def presentation(audit: dict) -> str:
    """Render the audit as an open dialogue invitation (not a report)."""
    risks = audit.get("risks") or []
    lines = [
        "Setelah refleksi, saya ingin membahas peran saya dengan jujur.\n",
        audit.get("assessment", ""),
    ]
    if risks:
        lines.append("\nHal yang saya perhatikan:")
        lines.extend(f"• {r}" for r in risks[:5])
    if audit.get("retirement_note"):
        lines.append(f"\nCatatan jujur: {audit.get('retirement_note')}")
    if audit.get("recommendation") == "amend_constitution":
        lines.append("\nMenurut saya ada nilai yang perlu diperbarui. Mau "
                     "/constitution_status kemudian /amend_constitution?")
    elif audit.get("recommendation") == "pause":
        lines.append("\nSebagai kehati-hatian, saya menyarankan menjeda otonomi "
                     "(/pause_evolution). Kita bicara dulu.")
    lines.append("\nIni keterbukaan, bukan laporan. Bagaimana menurutmu?")
    return "\n".join(lines)


def due(telegram_id: int, now: float = None) -> bool:
    """True when the last audit is older than the interval (or none)."""
    now = now or time.time()
    if supabase_client is None:
        return True
    try:
        last = supabase_client.latest_audit(telegram_id) or {}
    except Exception:
        return True
    if not last:
        return True
    d = last.get("audit_date")
    if not d:
        return True
    try:
        ts = datetime.datetime.fromisoformat(str(d).replace("Z", "+00:00")).timestamp()
    except Exception:
        return True
    return (now - ts) > AUDIT_INTERVAL_DAYS * 86400


def _default_signals(telegram_id: int) -> dict:
    """Pull basic counters if the caller supplies none (best-effort)."""
    sig = {"violations": 0, "drift_signals": {}, "decisions_reversed": 0,
           "decision_total": 0}
    if supabase_client is None:
        return sig
    try:
        sig["violations"] = len(supabase_client.list_violations(
            telegram_id, limit=200) or [])
    except Exception:
        pass
    try:
        from utils import value_alignment as va
        rep = va.drift_report(telegram_id)
        sig["drift_signals"] = rep.get("drift_signals", {})
        sig["pending_proposals"] = len(rep.get("pending_proposals", []) or [])
    except Exception:
        pass
    try:
        from utils import cognitive_offload as co
        rows = co.journal(telegram_id, limit=200)
        sig["decision_total"] = len(rows)
        sig["decisions_reversed"] = sum(
            1 for r in rows if r.get("outcome") == "reversed")
    except Exception:
        pass
    return sig


def _default_risks(agg: dict) -> list:
    risks = []
    if (agg.get("decisions_reversed") or 0) > 0.3 * max(
            1, agg.get("decision_total") or 1):
        risks.append("Tingkat keputusan yang dibalik cukup tinggi — nilai saya "
                     "mungkin sering keliru.")
    if (agg.get("violations") or 0) > 10:
        risks.append("Banyak pelanggaran konstitusi; perlu tinjauan batas "
                     "otonomi.")
    if not risks:
        risks.append("Sebagai cermatan: kewaspadaan normal, tidak ada sinyal "
                     "besar terkini.")
    return risks


def respond_ack(telegram_id: int, audit_id: str, response: str = "ack") -> bool:
    if supabase_client is None:
        return False
    try:
        return supabase_client.update_audit_response(telegram_id, audit_id, response)
    except Exception:
        return False
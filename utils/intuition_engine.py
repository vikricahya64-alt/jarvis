"""
J.A.R.V.I.S. Level 8 Intuition Engine

Bayesian, guardrailed, self-correcting intuition. This is NOT a speculative
model — it makes a scarce, well-calibrated "feeling" available only when there
is strong posterior evidence, and NEVER on sensitive domains by default.

Design (free-tier safe, sync, no external API):
  * Prior: Beta(alpha, beta) derived from the per-domain feedback history via
    `supabase_client.intuition_feedback_prior` (aggregated, not per-record).
  * Evidence: a DOMAIN-SAFE local scoring of the current context, then combined
    with the prior to form a posterior. Because free tier has no embed API we
    use deterministic intent keywords + prior only (not LLM).
  * Guardrail: `evaluate()` refuses (blocked=True) for hard-blocked domains
    (health/finance/relationship/identity) unless `allow_sensitive=True`.
  * Firing rule: only return an intuition when posterior confidence > threshold
    (default 0.85) AND impact is 'high'. Everything else is suppressed.
  * Feedback: `apply_feedback` records user agree/disagree -> feeds next prior.
Synchronous library.
"""
import os

try:
    from utils import supabase_client
except ImportError:
    supabase_client = None

SENSITIVE_DOMAINS = {"health", "finance", "relationship", "identity"}
DEFAULT_THRESHOLD = float(os.getenv("INTUITION_CONFIDENCE_THRESHOLD", "0.85"))
IMPACT_ORDER = {"low": 0, "med": 1, "high": 2}


# Lightweight, domain-aware intent/urgency scoring (keyword + recency bias).
_URGENT_WORDS = {
    "health": ["sakit", "demam", "obat", "rumah sakit", "gejala", "nyeri"],
    "finance": ["tagihan", "utang", "gaji", "bonus", "harga", "transfer"],
    "work":   ["deadline", "meeting", "laporan", "presentasi", "klien"],
    "social": ["ulang tahun", "janji", "temu", "kencan"],
}


def _domain_from_context(text: str) -> str:
    """Guess a domain from guarded keywords present in the context text."""
    t = (text or "").lower()
    hits = [(d, [w for w in wl if w in t]) for d, wl in _URGENT_WORDS.items()]
    scored = [(d, len(w)) for d, w in hits if w]
    if not scored:
        return "general"
    scored.sort(key=lambda x: -x[1])
    return scored[0][0]


def beta_mean(a: float, b: float) -> float:
    """Mean of a Beta distribution: E[x] = a/(a+b)."""
    try:
        return a / (a + b) if (a + b) else 0.5
    except Exception:
        return 0.5


def posterior(prior: dict, evidence_conf: float, strength: float = 1.0) -> float:
    """Combine a Beta prior (alpha/beta) with new evidence via a simple
    pseudo-count update. Returns posterior mean confidence in [0,1]."""
    a = float((prior or {}).get("alpha", 1.0))
    b = float((prior or {}).get("beta", 1.0))
    # evidence pushes toward evidence_conf with the given strength
    a2 = a + strength * evidence_conf * 10
    b2 = b + strength * (1 - evidence_conf) * 10
    return beta_mean(a2, b2)


def evaluate(telegram_id: int, context_text: str,
             domain: str = "", impact: str = "low",
             allow_sensitive: bool = False,
             threshold: float = DEFAULT_THRESHOLD) -> dict:
    """Core intuition gate. Returns a decision dict — the ONLY output that may
    be surfaced is `fired=True` (confidence > threshold AND impact == high).
    Sensitive domains are blocked unless allow_sensitive."""
    domain = domain or _domain_from_context(context_text)
    domain = domain.lower()
    blocked = (domain in SENSITIVE_DOMAINS and not allow_sensitive)

    # Deterministic local evidence score (0..1)
    words = _URGENT_WORDS.get(domain.split("_")[0], [])
    evidence = 0.0
    t = (context_text or "").lower()
    if words:
        hits = sum(1 for w in words if w in t)
        evidence = min(1.0, hits / max(1, len(words)) * 2)
    evidence = max(evidence, 0.3)  # slight baseline signal

    # Prior from feedback history
    prior = {}
    if supabase_client:
        try:
            prior = supabase_client.intuition_feedback_prior(telegram_id, domain)
        except Exception:
            prior = {}

    conf = posterior(prior, evidence)

    if blocked:
        # Record for proof-of-guardrail (evidence of domain rejection).
        if supabase_client:
            try:
                supabase_client.record_intuition(
                    telegram_id, domain, "blocked-by-guardrail", "", conf,
                    impact=impact, blocked=True)
            except Exception:
                pass
        return {"fired": False, "blocked": True, "domain": domain,
                "confidence": round(conf, 3), "impact": impact,
                "prior": prior, "evidence": round(evidence, 3),
                "reason": "sensitive_domain_blocked"}

    fired = conf > threshold and IMPACT_ORDER.get(impact, 0) >= 2
    prediction = "▲ elevation/spike" if fired else "— no actionable signal"
    if supabase_client:
        try:
            supabase_client.record_intuition(
                telegram_id, domain, prediction[:60], "", conf,
                impact=impact, blocked=blocked)
        except Exception:
            pass
    return {"fired": fired, "blocked": False, "domain": domain,
            "confidence": round(conf, 3), "impact": impact,
            "threshold": threshold, "prior": prior,
            "evidence": round(evidence, 3),
            "reason": "confidence_above_threshold" if fired
                      else "below_threshold_or_low_impact"}


def apply_feedback(telegram_id: int, intuition_id: str,
                   feedback: str = "dismissed") -> bool:
    """Record user feedback; this updates the next round's Bayesian prior."""
    if not supabase_client:
        return False
    return supabase_client.feedback_intuition(telegram_id, intuition_id, feedback)


def recent(telegram_id: int, limit: int = 10) -> list:
    if not supabase_client:
        return []
    return supabase_client.recent_intuitions(telegram_id, limit) or []


def reset(telegram_id: int, domain: str = "") -> bool:
    """Hard reset: delete a user's intuition history so the Bayesian prior
    returns to the uninformative Beta(1,1). Safety override /reset_intuition.
    No-op without supabase."""
    if not supabase_client:
        return False
    return supabase_client.reset_intuition(telegram_id, domain)


if __name__ == "__main__":
    # ---- quick offline self-check ----
    print("sensitive block:",
          evaluate(-1, "saya demam, perlu obat", domain="health")["blocked"])
    print("general (low impact):",
          evaluate(-100, "cuaca cerah hari ini", domain="weather")["fired"])
    print("work w/ high impact (may fire if prior helps):",
          evaluate(-100, "deadline laporan besok, meeting klien",
                   domain="work", impact="high")["fired"])
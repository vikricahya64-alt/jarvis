"""
Free-tier model router (pure logic, no LLM, no network).

Decides, from a user message ALONE (heuristics: keywords + length), whether
the task should stay on the fast local JARVIS brain (Groq) or be escalated to
a stronger free model via the opencode workflow. It MUST be fail-closed:
- it never raises (callers wrap in try/except anyway)
- the default answer is "do not escalate" (returns False for anything it
  cannot confidently classify), so the live pipeline is never downgraded.

Escalation only fires for clearly-heavy task types (deep reasoning, code
repair/writing, multi-step research) while trivial chat, direct commands,
self-referential questions, media and numeric/op messages stay local.
"""

import re
import os

# ---------------------------------------------------------------------------
# Tier vocabulary
# ---------------------------------------------------------------------------

MODEL_DEFAULT = "thinkingmachines/inkling:free"
MODEL_CODE = "cohere/north-mini-code:free"
MODEL_RESEARCH = "nvidia/nemotron-3-ultra-550b-a55b:free"

# OpenRouter free models keyed by capability slot. These are the strongest
# :free options we found for each slot (queried against /models 2026-09).
_MODEL_SLOTS = {
    "reasoning": MODEL_DEFAULT,      # 1M ctx, strongest all-round free
    "code": MODEL_CODE,              # code-specialist, 256K ctx
    "research": MODEL_RESEARCH,      # 1M ctx giant, strong web reasoning
    "long_context": MODEL_DEFAULT,   # inkling keeps a full 1M ctx
}

# Reasoning-signal phrases (Indonesian + English, lowercase matching).
_REASONING = [
    "analisis", "analisa", "menganalisis", "bandingkan", "compare",
    "evaluasi", "evaluate", "kelebihan dan kekurangan", "pros and cons",
    "jelaskan secara mendalam", "deep dive", "mengapa", "kenapa", "why",
    "introspeksi", "refleksi", "strategi", "strategy", "konsekuensi",
    "trade-off", "tradeoff", "rekomendasi", "recommendation", "wawasan",
    "insight", "penalaran", "reasoning", "diagnosis", "menyelidiki",
    "investigate", "scenario", "skenario", "forensik",
]

# Code-signal phrases.
_CODE = [
    "kode", "code", "bug", "debug", "perbaiki", "fix", "refactor",
    "function", "fungsi", "script", "skrip", "error type", "typecheck",
    "compilation", "compile", "mypy", "pytest", "unit test", "pr",
    "pull request", "commit", "repo", "repository", "implement",
    "implementasi", "buatkan fungsi", "buat function", "class ",
    "semantic", "triple quote", "python", "typescript", "javascript",
    "golang", "rust", "flask", "django", "fastapi", "apinya",
]

# Research-signal phrases.
_RESEARCH = [
    "riset", "research", "cari tahu", "temukan", "find", "informasi",
    "literature", "paper", "artikel", "berita terbaru", "latest news",
    "bandingkan harga", "browsing", "web search", "cari di internet",
    "sumber", "sources", "kutipan", "liat di web", "googling",
]

# Context phrases that are unambiguously local device ops — never escalate.
# Kept phrase-level (not bare words) so common words like "login", "kode",
# "suhu" never suppress legit heavy keywords in a normal sentence.
_LOCAL_OPS = [
    "/start", "/help", "/status", "/todo", "/device_health",
    "suhu perangkat", "baterai device", "ram device", "capture scan",
    "scan dokumen", "scan meeting", "scan qr",
]

# Continuation phrases: short follow-ups that ONLY point back at the previous
# turn ("riset lebih lanjut", "lanjutkan", "lebih detail"...). Escalating these
# without conversation context makes a stronger model guess a topic and answer
# off-topic (the "Kota Malang" bug). We gate them OUT of auto-escalation; the
# local pipeline (which injects recent history) handles them.
_CONTINUATION = [
    "lebih lanjut", "lanjutkan", "teruskan", "lanjut", "terus",
    "lebih detail", "lebih dalam", "perdalam", "jelaskan lagi",
    "ulangi", "tambahkan", "lanjutin", "terusin", "perbaiki",
]

# Generic task verbs that add no topic ("lakukan riset", "buatkan", ...).
_SECONDARY_VERBS = [
    "lakukan", "buatkan", "buat", "tolong", "mohon", "bisa",
    "coba", "kamu", "please", "make", "teruskan", "lanjutkan",
]

# Long input threshold (chars) beyond which we prefer the 1M-ctx model.
_LONG_CTX_CHARS = 6000


def _has_any(text: str, needles) -> bool:
    for n in needles:
        if n.lower() in text.lower():
            return True
    return False


def classify(text: str) -> str:
    """Return a tier slug: reasoning | code | research | long_context | local."""
    if not text or not text.strip():
        return "local"
    lowered = text.lower()
    if _has_any(lowered, _LOCAL_OPS):
        return "local"
    if len(text) > _LONG_CTX_CHARS:
        # Only long-context when it is not purely a numeric/data op.
        if re.search(r"\d{4,}", text) and not _has_any(lowered, _RESEARCH):
            return "local"
        return "long_context"
    for tier, needles in (("research", _RESEARCH),
                          ("code", _CODE),
                          ("reasoning", _REASONING)):
        if _has_any(lowered, needles):
            return tier
    return "local"


def model_for_tier(tier: str) -> str:
    return _MODEL_SLOTS.get(tier, MODEL_DEFAULT)


def should_escalate(text: str) -> bool:
    """True when the message is confidently heavy AND escalation is allowed.

    Fail-closed: any classification uncertainty -> False, so the default
    pipeline is the safe path and JARVIS never gets dumber.
    """
    try:
        if not text or not text.strip():
            return False
        # Ops toggle — "0" disables auto-escalation entirely.
        if os.getenv("JARVIS_OPENDCODE_AUTO", "1") == "0":
            return False
        tier = classify(text)
        return tier in ("reasoning", "code", "research")
    except Exception:
        return False


def escalation_plan(text: str):
    """Return (mode, model) for the opencode dispatch of a heavy task."""
    tier = classify(text)
    model = model_for_tier(tier)
    if tier == "code":
        return "edit", model
    if tier == "research":
        return "analyze", model
    return "chat", model


def is_continuation(text: str) -> bool:
    """True when the message is a short follow-up with NO real topic of its
    own ("Lakukan riset lebih lanjut", "lanjutkan", "teruskan", ...).

    Such messages are only meaningful WITH the previous turn's context. We do
    not dispatch them to opencode (a strong model with the bare phrase and no
    conversation history fabricates a topic -> off-topic answer). Fail-closed:
    returns False for anything with content left after stripping known follow-up
    words, so real heavy tasks still escalate exactly as before.
    """
    if not text or not text.strip():
        return False
    lowered = text.lower().strip()
    if len(lowered) > 80:
        return False
    remaining = lowered
    for p in _CONTINUATION:
        remaining = remaining.replace(p, " ")
    for v in _SECONDARY_VERBS:
        remaining = remaining.replace(v, " ")
    remaining = re.sub(r"[^a-z0-9 ]", " ", remaining)
    tokens = [t for t in remaining.split() if len(t) >= 2]
    return len(tokens) <= 1
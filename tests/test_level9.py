"""
Level 9 test suite — Symbiotic Consciousness (constitutional guard, legacy
vault crypto/dead-man's-switch, value drift, cognitive offload, existential
audit). Pure functions; no live network, no Supabase calls.

Run:  python -m pytest tests/test_level9.py -v
  or: python tests/test_level9.py   (plain asserts)
"""
import os
import sys
import json
import time
import datetime

os.environ.setdefault("BACKUP_PASSPHRASE", "test-vault-passphrase")
os.environ.setdefault("JARVIS_DMS_GRACE_DAYS", "30")

__dir = os.path.dirname(os.path.abspath(__file__))
_project = os.path.dirname(__dir)
if _project not in sys.path:
    sys.path.insert(0, _project)

from utils import legacy_vault as lv
from utils import value_alignment as va
from utils import cognitive_offload as co
from utils import existential_audit as ea
from utils import constitutional_guard as cg


# ------------------------------------------------------------------
# 1. Legacy vault crypto (AES-256-GCM round-trip)
# ------------------------------------------------------------------
def test_vault_round_trip():
    envelope = lv.encrypt_vault(
        {"intent": {"action": "transfer"}, "body": "rahasia"}, "pw")
    assert envelope["ct"] and envelope["iv"] and envelope["pgp"] is False
    dec = lv.decrypt_vault(envelope, "pw")
    assert dec["body"] == "rahasia"


def test_vault_wrong_password_is_none():
    envelope = lv.encrypt_vault({"x": 1}, "pw")
    assert lv.decrypt_vault(envelope, "wrong") is None


# ------------------------------------------------------------------
# 2. Dead man's switch fail-safe defaults
# ------------------------------------------------------------------
def test_monitor_fail_safe_no_execute_without_flag():
    # armed-not-really since no supabase -> idle, never executes destructively
    res = lv.monitor(1, execute=True)
    assert res.get("executed") is False


def test_terminate_request_sets_window():
    res = lv.request_terminate(1)
    assert res["window_hours"] >= 72
    assert res["awaiting"] >= 2


# ------------------------------------------------------------------
# 3. Value-alignment drift detection
# ------------------------------------------------------------------
def test_alignment_recover_drift_signals():
    # 3 corrections in window -> no drift yet (threshold 5)
    res = va.record_correction(1, "privacy", "kurangi penyimpanan")
    assert res.get("drift") is False
    for _ in range(3):
        va.record_correction(1, "finance", "jangan tawarkan utang")
    rep = va.drift_report(1)
    assert rep["drift_signals"]["finance"] == 3
    assert rep["drift_signals"]["privacy"] == 1


def test_alignment_reset_clears_counters():
    va.record_correction(2, "health", "x")
    va.reset_memory(2)
    rep = va.drift_report(2)
    assert "health" not in rep["drift_signals"]


# ------------------------------------------------------------------
# 4. Cognitive offload: energy gate + journal is append-only concept
# ------------------------------------------------------------------
def test_energy_gate_low_load_defaults_true():
    # no rapid interactions -> low load -> delegations allowed
    co.note_interaction(3)
    assert co.energy_gate(3) is True


def test_offload_returns_journaled():
    res = co.decide(4, context={"chat": True}, decision={"auto": "yes"},
                    rationale="test", domain="misc")
    assert res["journaled"] is True
    assert res["deferred"] in (True, False)


# ------------------------------------------------------------------
# 5. Existential audit presentation is a dialogue, not a report
# ------------------------------------------------------------------
def test_presentation_is_dialogue_invitation():
    audit = {"assessment": "Saya cukup membantu tapi perlu meninjau batas.",
             "risks": ["Tingkat overrides sedang."],
             "retirement_note": "", "recommendation": "continue"}
    text = ea.presentation(audit)
    assert "membahas" in text
    assert "Bagaimana menurutmu" in text
    assert "not a report" not in text


# ------------------------------------------------------------------
# 6. Constitution guard: fail-closed when no constitution
# ------------------------------------------------------------------
def test_guard_fail_closed_semantics():
    # Simulate absence of constitution by injecting a loader that returns None.
    prev = cg.load_constitution
    cg.load_constitution = lambda tid, force=False: None  # type: ignore[assignment]
    try:
        res = cg.validate_action(99, "transfer_money")
    finally:
        cg.load_constitution = prev  # type: ignore[assignment]
    assert res["allowed"] is False
    assert res["violated_principle"] == "no_constitution"


# ------------------------------------------------------------------
# 7. Fly.io scaffold fragment sanity
# ------------------------------------------------------------------
def test_fly_toml_has_grace_config():
    assert "JARVIS_DMS_GRACE_DAYS" in lv.FLY_TOML
    assert "app =" in lv.FLY_TOML


if __name__ == "__main__":
    failures = 0
    for name, fn in sorted(list(globals().items())):
        if name.startswith("test_") and callable(fn):
            try:
                fn()
                print(f"PASS {name}")
            except AssertionError as exc:
                failures += 1
                print(f"FAIL {name}: {exc}")
    print(f"\n{0 if failures == 0 else failures} failure(s)")
    raise SystemExit(1 if failures else 0)
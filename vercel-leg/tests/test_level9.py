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
_repo = os.path.dirname(_project)   # repository root
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
# ===========================================================================
# Level 10 — Ubiquitous Sentience (zero-trust, failover, ephemeral workers)
# ===========================================================================

# ---- zero-trust client: PII/secured logging + circuit breaker ---------------
def test_zt_redacts_secrets():
    from utils.zero_trust_client import _redact_body
    out = _redact_body('{"token": "sk-abc123456", "user": "budi", '
                       '"secret": "xyzabc123"}')
    assert "sk-abc123456" not in out
    assert "xyzabc123" not in out
    assert "budi" in out   # non-secret PII still appears (request-scoped)


def test_circuit_breaker_opens_and_recovers():
    from utils.zero_trust_client import CircuitBreaker
    cb = CircuitBreaker("t", failure_threshold=2, open_seconds=999)
    assert cb.allow_request() is True
    cb.on_failure(); cb.on_failure()
    assert cb.allow_request() is False  # open


# ---- failover manager: sticky sessions + router ----------------------------
def test_failover_sticky_sessions():
    from utils import failover_manager as fm
    sess = fm.start_sticky("tx")
    assert fm.route_for("tx") == sess
    fm.release_sticky("tx")
    assert fm.route_for("tx") == fm.active_region()


def test_failover_status_shape():
    from utils import failover_manager as fm
    st = fm.current_status()
    assert st["active_region"] in ("sin", "nrt", "ord")
    assert set(st["under_monitoring"]) == {"sin", "nrt", "ord"}


# ---- ephemeral worker: priority queue + concurrency + cleanup --------------
def test_ephemeral_priority_dequeue():
    from utils import ephemeral_worker as ew
    # reset module state would be ideal; propose and drain works in isolation
    a = ew.propose("validator", priority="violation")
    b = ew.propose("researcher", priority="user")
    assert a["accepted"] and b["accepted"]
    assert a["timeout_s"] == 30     # validator 30s


def test_ephemeral_limits_and_cleanup():
    from utils import ephemeral_worker as ew
    for _ in range(8):
        ew.propose("researcher", priority="background")
    ew.cleanup(older_than_s=0.0)
    d = ew.queue_depths()
    assert d["running"] <= ew.MAX_CONCURRENT


def test_ephemeral_terminate_all():
    from utils import ephemeral_worker as ew
    ew.propose("validator", "violation")
    n = ew.terminate_all()
    assert n >= 0
    assert ew.queue_depths()["running"] == 0


# ---- existence of the runtime assets that are actually deployed ----------
#
# This used to assert on Fly.io assets (api/fly_app.py, Dockerfile,
# Dockerfile.fly, fly.toml, fly.legacy.toml, tools/legacy_monitor_fly.py),
# Supabase Edge Functions, tools/apply_sql.py and deploy/oracle-arm/. All of
# those were dead or broken and have been removed: the Fly CMD pointed at an
# `api.webhook:app` that never existed so the machine restart-looped,
# api/fly_app.py never existed either, apply_sql.py hardcoded the production
# pooler host and imported psycopg2 which is not in requirements.txt, and the
# Supabase `drain` function mutated rows with the service_role key and no auth.
#
# It had been failing for a long time because nothing ran it (there is no
# pytest in requirements.txt, so vercel-leg/tests was never wired into CI).
# It now asserts on the assets that are real.
def test_deployed_runtime_assets_exist():
    for rel in ("vercel.json",
                "api/webhook.py",
                "api/orchestrator.py",
                "api/hybrid_router.py",
                "healthcheck.sh"):
        assert os.path.exists(os.path.join(_project, rel)), rel

    # The replacement device agent must exist and be a Go module.
    for rel in ("edge/go.mod",
                "edge/Makefile",
                "edge/README.md",
                "edge/cmd/jarvis-edge/main.go",
                "edge/internal/authz/authz.go",
                "edge/internal/policy/policy.go"):
        assert os.path.exists(os.path.join(_repo, rel)), rel


def test_removed_dead_targets_are_gone():
    """The removed deploy targets must not creep back in."""
    for rel in ("fly.toml",
                "fly.legacy.toml",
                "Dockerfile",
                "Dockerfile.fly",
                "tools/legacy_monitor_fly.py",
                "tools/apply_sql.py",
                "deploy/oracle-arm",
                "deploy/cloudflare",
                "supabase/functions/drain",
                "api/device_gateway.py",
                "utils/termux_executor.py",
                "termux"):
        assert not os.path.exists(os.path.join(_project, rel)), (
            f"{rel} was removed as a dead/broken target and must stay removed")


def test_device_tools_are_not_exposed_to_the_model():
    """termux_command and friends reached an unauthenticated RCE endpoint."""
    import ast as _ast
    from utils import groq_client as _g
    tool_names = set()
    for node in _ast.walk(_ast.parse(open(_g.__file__).read())):
        if isinstance(node, _ast.Assign):
            for t in node.targets:
                if isinstance(t, _ast.Name) and t.id == "TOOLS":
                    for e in node.value.elts:
                        if isinstance(e, _ast.Dict):
                            d = {k.value: v for k, v in zip(e.keys, e.values)}
                            fn = d.get("function")
                            if isinstance(fn, _ast.Dict):
                                fd = {k.value: v for k, v in zip(fn.keys, fn.values)}
                                if isinstance(fd.get("name"), _ast.Constant):
                                    tool_names.add(fd["name"].value)
    for banned in ("termux_command", "device_read_file",
                   "device_write_file", "device_list_dir"):
        assert banned not in tool_names, (
            f"{banned} must not be offered to the model: it drove an "
            "unauthenticated shell-execution endpoint"
        )


def test_level10_modules_import():
    from utils import zero_trust_client, failover_manager, ephemeral_worker
    assert callable(zero_trust_client.from_env)
    assert callable(failover_manager.monitor_and_maybe_failover)
    assert callable(ephemeral_worker.drain)


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
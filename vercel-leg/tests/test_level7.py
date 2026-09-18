"""
Level 7 test suite: sovereign-terminal guardrails, local-inference caps,
replicator bundle safety, self-repair blocklist, genetic archive manifest,
meta-cognition pause/risk. All pure functions — no live network/db calls.

Run:  python -m pytest tests/test_level7.py -v
  or: python tests/test_level7.py            (plain asserts)
"""
import os
import sys
import json

os.environ.setdefault("DEVICE_SHARED_SECRET", "test-shared-secret")

__dir = os.path.dirname(os.path.abspath(__file__))
_project = os.path.dirname(__dir)
if _project not in sys.path:
    sys.path.insert(0, _project)

from utils import sovereign_terminal as st
from utils import local_inference as li
from utils import replicator as rep
from utils import self_repair as sr
from utils import genetic_archive as ga
from utils import meta_cognition as mc


# ------------------------------------------------------------------
# 1. Sovereign-terminal hardware guardrails (Realme C25s safety)
# ------------------------------------------------------------------
def test_guardrail_ok_when_cold():
    ok, why = st.should_run_local(temp_c=35.0, ram_pct=60.0)
    assert ok is True and why == "ok"


def test_guardrail_failover_temp_over_40():
    ok, why = st.should_run_local(temp_c=41.0, ram_pct=60.0)
    assert ok is False and why == "temp_too_high"


def test_guardrail_failover_ram_over_85():
    ok, why = st.should_run_local(temp_c=35.0, ram_pct=88.0)
    assert ok is False and why == "ram_too_high"


def test_guardrail_no_metrics_conservative():
    ok, why = st.should_run_local(None, None)
    assert ok is False and why == "no_metrics"   # protect phone on unknown


def test_pick_target_failover_order():
    # Too hot -> prefer private edge (oracle) over cloud.
    assert st.pick_target(temp_c=45.0, ram_pct=50.0) in ("oracle", "cloud")
    assert st.pick_target(temp_c=35.0, ram_pct=70.0) == "local"


# ------------------------------------------------------------------
# 2. Local-inference context cap (never exceed 1024 tokens)
# ------------------------------------------------------------------
def test_local_inference_context_cap():
    # Distinct prefix so we can tell head-keeping apart from tail-keeping.
    long_prompt = "HEAD" + "x" * 20000 + "TAIL"
    capped = li.truncate_to_context(long_prompt, max_tokens=1024)
    assert len(capped) <= 1024 * 4          # 4 chars/token heuristic cap
    assert capped.lstrip("x").startswith("HEAD")  # head is kept (subject first)
    assert "TAIL" not in capped              # tail dropped to respect budget


def test_local_inference_no_engine_returns_error_not_crash():
    os.environ["LLAMA_CLI"] = "/nonexistent/llama"
    os.environ["MLC_CLI"] = "/nonexistent/mlc"
    os.environ["OLLAMA_BIN"] = "/nonexistent/ollama"
    res = li.local_generate("halo")
    assert res["ok"] is False       # fail-safe, never crashes the pipeline
    assert "error" in res


def test_local_inference_model_name_q4km():
    # Default model is the tiny phone-safe Q4_K_M build.
    assert li.MODEL_NAME == "Qwen2.5-1.5B-Instruct-Q4_K_M"
    assert li.MAX_CONTEXT_TOKENS <= 1024


# ------------------------------------------------------------------
# 3. Replicator bundle safety (no secrets/logs/PII/db)
# ------------------------------------------------------------------
def test_replicator_bundle_excludes_unsafe_files():
    files = rep.list_bundle_files(_project)
    blob = "\n".join(files).lower()
    assert ".env" not in blob
    assert "secret" not in blob
    assert "pii" not in blob
    assert ".db" not in blob
    assert ".log" not in blob


def test_replicator_manifest_has_hashes():
    m = rep.bundle_manifest(_project)
    assert isinstance(m, dict) and len(m) > 0
    for k, v in m.items():
        assert len(v) == 64   # sha256 hex


# ------------------------------------------------------------------
# 4. Self-repair blocklist (never touch security/crypto/PII)
# ------------------------------------------------------------------
def test_self_repair_blocks_security_modules():
    assert sr._module_blocked("utils/data_sovereignty.py")
    assert sr._module_blocked("utils/device_comm.py")
    assert sr._module_blocked("api/hybrid_router.py")
    assert sr._module_blocked("api/webhook.py")


def test_self_repair_allows_safe_module():
    assert not sr._module_blocked("api/analytics.py")
    assert not sr._module_blocked("utils/misc_tools.py")


def test_self_repair_safe_module_extraction_blocks_traversal():
    assert sr._safe_module_from_log_entry({"module": "../../etc/passwd"}) == ""
    assert sr._safe_module_from_log_entry({"module": "utils/data_sovereignty.py"}) == ""


# ------------------------------------------------------------------
# 5. Genetic archive manifest + packaging integrity
# ------------------------------------------------------------------
def test_genetic_archive_manifest_hashes_code():
    manifest = ga.build_manifest(
        code_hashes={"api/webhook.py": "abc"}, model_hashes={},
        prefs={"language": "id"})
    assert manifest["code"]["api/webhook.py"] == "abc"
    assert manifest["prefs_shape"] == ["language"]  # structural, not values


def test_genetic_archive_package_sha_stable():
    m = ga.build_manifest(code_hashes={"a.py": "h1"}, model_hashes={}, prefs={})
    p1, s1 = ga.package_archive(m)
    p2, s2 = ga.package_archive(m)
    assert p1 == p2 and s1 == s2 and len(s1) == 64


# ------------------------------------------------------------------
# 6. Meta-cognition pause + risk policy
# ------------------------------------------------------------------
def test_meta_cognition_normalizes_risk():
    assert mc.analyze.__doc__  # callable exists
    # Force a deterministic proposal parse path without network is covered by
    # _apply_recommendation policy: HIGH is always parked.
    proposal = {"risk": "high", "recommendation": "redesign routing", "target_area": "router"}
    # Monkeypatch pause to False so policy path is observable.
    _orig = mc._pause_state
    mc._pause_state = lambda tid: False
    try:
        status = mc._apply_recommendation(proposal, 1)
        assert status == "parked_high_risk"
    finally:
        mc._pause_state = _orig


def test_meta_cognition_pause_blocks_low_risk_apply():
    proposal = {"risk": "low", "recommendation": "update copy text", "target_area": "ux"}
    _orig = mc._pause_state
    mc._pause_state = lambda tid: True
    try:
        status = mc._apply_recommendation(proposal, 1)
        assert status == "paused"
    finally:
        mc._pause_state = _orig


# ------------------------------------------------------------------
# 9. supabase_client L7 helpers (mocked httpx: no live network)
# ------------------------------------------------------------------
def test_supabase_count_self_repair_sends_count_exact():
    """Regression: count_self_repair must ask PostgREST for an exact count
    via 'Prefer: return=minimal,count=exact', else Content-Range is '*/0'."""
    import httpx
    from utils import supabase_client as sc

    captured = {}

    class FakeResp:
        status_code = 200
        headers = {"content-range": "0-0/3"}

    class FakeClient:
        def __init__(self, *a, **k):
            pass

        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

        def get(self, url, params=None, headers=None):
            captured["url"] = url
            captured["params"] = params
            captured["headers"] = headers
            return FakeResp()

    sc._config  # ensure module importable
    sc._config = lambda: ("https://x.supabase.co", "test-key")
    orig_client = httpx.Client
    httpx.Client = FakeClient
    try:
        sc._SUPABASE_URL = "https://x.supabase.co"
        sc._SUPABASE_KEY = "test-key"
        n = sc.count_self_repair()
    finally:
        httpx.Client = orig_client
    assert n == 3, f"expected 3, got {n}"
    hdr = captured.get("headers") or {}
    assert hdr.get("Prefer") == "return=minimal,count=exact", hdr


def test_supabase_latest_meta_audit_returns_single_dict():
    """Regression: latest_meta_audit must return the newest row as a dict
    (not a list), matching latest_genetic_archive's contract."""
    import httpx
    from utils import supabase_client as sc

    row = {"id": 1, "week": "2026-W35", "risk": "low", "status": "proposed"}
    captured = {}

    class FakeResp:
        status_code = 200

        def json(self):
            return [row]

    class FakeClient:
        def __init__(self, *a, **k):
            pass

        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

        def get(self, url, params=None, headers=None):
            captured["url"] = url
            return FakeResp()

    orig_client = httpx.Client
    httpx.Client = FakeClient
    try:
        sc._config = lambda: ("https://x.supabase.co", "test-key")
        sc._SUPABASE_URL = "https://x.supabase.co"
        sc._SUPABASE_KEY = "test-key"
        res = sc.latest_meta_audit(12345)
    finally:
        httpx.Client = orig_client
    assert isinstance(res, dict), f"expected dict, got {type(res)}"
    assert res["week"] == "2026-W35"


# ------------------------------------------------------------------
# Runner (plain `python tests/test_level7.py`)
# ------------------------------------------------------------------
if __name__ == "__main__":
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    passed = 0
    for t in tests:
        try:
            t()
            passed += 1
            print(f"PASS  {t.__name__}")
        except Exception as exc:
            print(f"FAIL  {t.__name__}: {exc}")
    print(f"\n{passed}/{len(tests)} passed")
    sys.exit(0 if passed == len(tests) else 1)

"""
Level 6 test suite: hybrid routing, failover, PII redaction, simulator
batching, encryption round-trip. All pure functions — no live network calls.

Run:  python -m pytest tests/test_level6.py -v
  or: python tests/test_level6.py            (plain asserts)
"""
import os
import sys
import json

os.environ.setdefault("DEVICE_SHARED_SECRET", "test-shared-secret")

# Ensure project root is on sys.path when run from tests/
__dir = os.path.dirname(os.path.abspath(__file__))
_project = os.path.dirname(__dir)
if _project not in sys.path:
    sys.path.insert(0, _project)

from utils import data_sovereignty as ds
from utils import device_comm as dc
from api import hybrid_router as hr
from api import simulator_proxy as sp


# ------------------------------------------------------------------
# 1. AES-GCM encryption round-trip + tamper detection
# ------------------------------------------------------------------
def test_encrypt_roundtrip():
    env = dc.encrypt_payload({"task": "hitung", "n": 2})
    assert dc.decrypt_payload(env) == {"task": "hitung", "n": 2}


def test_encrypt_tamper_detection():
    env = dc.encrypt_payload({"task": "aman"})
    bad = dict(env)
    bad["ct"] = "AAAA"      # tamper
    try:
        dc.decrypt_payload(bad)
        assert False, "tamper not caught"
    except ValueError:
        pass


def test_encrypt_gzip_large():
    env = dc.encrypt_payload({"body": "x" * 3000})
    assert env["gzip"] == 1
    assert dc.decrypt_payload(env)["body"] == "x" * 3000


# ------------------------------------------------------------------
# 2. Routing accuracy: sensitive vs non-sensitive
# ------------------------------------------------------------------
def test_sensitive_routing():
    assert hr.classify_sensitivity("tolong reset password saya")["sensitive"]
    assert hr.classify_sensitivity("NIK 3201234567890123")["sensitive"]
    assert not hr.classify_sensitivity("apa kabar hari ini")["sensitive"]


def test_complexity_score():
    assert hr.complexity_score("hitung 2+2") < hr.complexity_score(
        "lakukan simulasi monte carlo untuk 10000 iterasi")
    assert hr.complexity_score("jual beli saham secara simultan "
                               "menggunakan simulasi monte carlo") >= 40


def test_location_tag():
    assert "Local" in hr.location_tag("local")
    assert "Cloud" in hr.location_tag("cloud")
    assert "Fallback" in hr.location_tag("fallback")


# ------------------------------------------------------------------
# 3. Failover behavior: device offline -> cloud (fallback)
# ------------------------------------------------------------------
def test_decide_fallback_when_offline(monkeypatch=None):
    # When device has no heartbeat, decide() must not pick local.
    orig = hr.device_comm.check_device_health
    hr.device_comm.check_device_health = lambda **k: {
        "online": False, "temp_c": None, "ram_pct": None, "threads": None}
    try:
        d = hr.decide(999999, "berapa harga emas sekarang")
        assert d["decision"] in ("fallback", "cloud")
    finally:
        hr.device_comm.check_device_health = orig


def test_devide_forced_overrides():
    assert hr.location_tag("force_local") == "🛡️ Local (Forced)"


# ------------------------------------------------------------------
# 4. PII redaction effectiveness
# ------------------------------------------------------------------
def test_redact_pii_phone_email():
    r = ds.scan_and_redact(
        "HP 081234567890 email budi@mail.com kartu 4111 1111 1111 1111")
    assert "budil@mail.com" not in r["text"]
    assert r["pii_detected"]
    assert "email" in r["fields_redacted"]


def test_redact_password_word():
    r = ds.scan_and_redact("password rahasia saya: abc123")
    assert r["pii_detected"]


def test_compliance_blocks():
    c = ds.verify_local_only_compliance(None, "t1", "password abc123 password abc123")
    assert not c["compliant"]


# ------------------------------------------------------------------
# 5. Simulator proxy batching + caching
# ------------------------------------------------------------------
def test_cache_key():
    assert sp._cache_key("x+1") == sp._cache_key("x+1")
    assert sp._cache_key("x+1") != sp._cache_key("x+2")


def test_batch_accumulate():
    sp._PENDING_BATCH.pop("batch:1", None)
    assert sp.add_to_batch(1, "code1")["position"] == 1
    assert sp.add_to_batch(1, "code2")["position"] == 2
    assert len(sp._PENDING_BATCH.get("batch:1", [])) == 2


def test_is_simulation():
    assert sp._is_simulation_code("import numpy as np\nnp.random.seed(1)")
    assert not sp._is_simulation_code("print('halo')")


# ------------------------------------------------------------------
# Runner (plain `python tests/test_level6.py`)
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
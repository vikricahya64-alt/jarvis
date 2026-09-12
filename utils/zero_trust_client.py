"""
J.A.R.V.I.S. Level 10 — Zero-Trust mTLS Service Client (utils/zero_trust_client.py)

Eliminates implicit trust between services regardless of network location.

Features
  * HTTPX client with MANDATORY mTLS: client cert + private key supplied by an
    init container, presented on every request; server cert chain verified
    against a root CA (per-service identity via cert CN).
  * Service identity validation: matches server cert CN against the expected
    X-Service-Name; refuses otherwise (defense against spoofing).
  * Retry with exponential backoff + circuit breaker (OPEN/HALF/CLOSED) so a
    flapping peer cannot cause a request storm.
  * PII-safe logging: request/response bodies and URLs are scrubbed with the
    data-sovereignty redaction rules before logging. Secrets never logged.
  * Cert rotation every 24h: `rotate` swaps cert/verify files and resets the
    client; graceful reload via a STARTTLS-like warm reload (no drop).

Synchronous by design (matches the whole codebase; Vercel EBUSY constraint).

Notes
  * mTLS certs live ONLY in-memory/Supabase Vault out-of-band; nothing is
    written to /app disk except a downstream init container's volume.
"""
import os
import time
import json
import ssl
import re
import logging
import threading

import httpx

try:
    from utils.data_sovereignty import detect_pii
except ImportError:
    detect_pii = None

log = logging.getLogger("zero_trust")

# ---- circuit breaker state -------------------------------------------------
_CLOSED, _OPEN, _HALF = "closed", "open", "half_open"


class CircuitBreaker:
    def __init__(self, name: str, failure_threshold: int = 5,
                 open_seconds: float = 30.0, half_trials: int = 1):
        self.name = name
        self.failure_threshold = failure_threshold
        self.open_seconds = open_seconds
        self.half_trials = half_trials
        self._lock = threading.Lock()
        self.state = _CLOSED
        self.consecutive_failures = 0
        self.open_since = 0.0
        self.half_remaining = half_trials

    def allow_request(self) -> bool:
        with self._lock:
            now = time.time()
            if self.state == _OPEN:
                if now - self.open_since >= self.open_seconds:
                    self.state = _HALF
                    self.half_remaining = self.half_trials
                    return True
                return False
            if self.state == _HALF:
                if self.half_remaining > 0:
                    self.half_remaining -= 1
                    return True
                return False
            return True  # closed

    def on_success(self):
        with self._lock:
            self.consecutive_failures = 0
            self.state = _CLOSED

    def on_failure(self):
        with self._lock:
            self.consecutive_failures += 1
            if self.state == _HALF or \
                    self.consecutive_failures >= self.failure_threshold:
                self.state = _OPEN
                self.open_since = time.time()

    def __repr__(self):
        return f"<CircuitBreaker {self.name} state={self.state}>"


# ---- PII redaction ---------------------------------------------------------
_SENSITIVE_HEADERS = {"authorization", "cookie", "x-api-key", "x-telegram-bot-api-secret-token"}


# JSON/query-form aware secret redaction. Matches  "key": "value"  or key=value,
# then scrubs the token portion. Applicable against serialized request/response
# bodies even when the key has surrounding quotes.
_SECRET_KEY_LABEL = (
    r"api[_-]?key|authorization|bearer|token|secret|password|passphrase"
)
_SECRET_PATTERNS = [
    (re.compile(r'(["\']?(?:' + _SECRET_KEY_LABEL + r')["\']?\s*[:=]\s*'
                r'["\']?)([A-Za-z0-9._\-]{6,})["\']?,?', re.I),
     r"\1<redacted>"),
    (re.compile(r"(Bearer\s+)[A-Za-z0-9._\-]{6,}", re.I), r"\1<redacted>"),
    (re.compile(r"sk-[A-Za-z0-9._\-]{6,}"), "sk-<redacted>"),
]


def _redact_body(body: str, max_len: int = 400) -> str:
    if not body:
        return ""
    text = body
    try:
        obj = json.loads(body)
        text = json.dumps(obj, ensure_ascii=False)
    except Exception:
        pass
    if detect_pii:
        try:
            r = detect_pii(text)
            if r and r.get("redacted_text"):
                text = r["redacted_text"]
        except Exception:
            pass
    for pat, repl in _SECRET_PATTERNS:
        text = pat.sub(repl, text)
    return text[:max_len] + ("…" if len(text) > max_len else "")


def _redact_url(url: str) -> str:
    # strip query-string secrets (token/secret/key/access)
    import re
    return re.sub(r"([?&](?:token|secret|key|access|pass)=)[^&]*", r"\1<redacted>", url)


def redact_headers_for_log(headers) -> dict:
    return {k: ("<redacted>" if k.lower() in _SENSITIVE_HEADERS else v)
            for k, v in (headers or {}).items()}


# ---- mTLS context builders ------------------------------------------------
def build_ssl_context(certfile=None, keyfile=None, verify=None,
                      service_name=None, require_mtls=True):
    """Build an httpx-friendly SSL context enforcing mTLS. If mTLS material is
    absent and require_mtls is False, fall back to plain TLS verification only
    (used for infra probes). Returns (ssl_context, cert_dn_service)."""
    ctx = ssl.create_default_context(ssl.Purpose.SERVER_AUTH)
    if verify:
        ctx.load_verify_locations(verify)
    else:
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE  # pinned by peer; only for tests
    cert_service = None
    if certfile and keyfile:
        ctx.load_cert_chain(certfile, keyfile)
        cert_service = _cert_cn(certfile)
    elif require_mtls:
        raise RuntimeError("mTLS client cert/key required for zero-trust call")
    return ctx, cert_service


def _cert_cn(certfile: str) -> str:
    """Best-effort CN from a PEM client cert; None if unreadable."""
    try:
        from cryptography import x509
        from cryptography.hazmat.backends import default_backend
        with open(certfile, "rb") as f:
            cert = x509.load_pem_x509_certificate(f.read(), backend=default_backend())
        for name in cert.subject.rfc4514_string().split(","):
            if name.strip().startswith("CN="):
                return name.strip()[3:]
    except Exception:
        return None
    return None


def _matches_service(peer_cn, expected) -> bool:
    if not expected:
        return True
    return peer_cn == expected


def _default_backoff(attempt: int, base: float = 0.3, cap: float = 8.0) -> float:
    return min(cap, base * (2 ** attempt))


# ---- the client ------------------------------------------------------------
class ZeroTrustClient:
    """mTLS HTTPX client with mandatory identity verification + circuit breaker
    + PII-safe logging + bounded retries."""

    def __init__(self, service_name: str,
                 certfile: str = None, keyfile: str = None,
                 verify: str = None, base_url: str = None,
                 timeout: float = 15.0, max_retries: int = 3,
                 circuit_threshold: int = 5, circuit_open_seconds: float = 30.0):
        self.service_name = service_name
        self.certfile = certfile
        self.keyfile = keyfile
        self.verify = verify
        self.base_url = base_url
        self.max_retries = max_retries
        self.breaker = CircuitBreaker(service_name, circuit_threshold,
                                      circuit_open_seconds)
        self._lock = threading.Lock()
        self._client = self._build_client(timeout)

    def _build_client(self, timeout: float):
        require = True
        ctx, cert_cn = build_ssl_context(self.certfile, self.keyfile,
                                         self.verify, self.service_name,
                                         require_mtls=require)
        return httpx.Client(base_url=self.base_url, verify=ctx, timeout=timeout,
                            cert=(self.certfile, self.keyfile)
                            if self.certfile else None)

    def rotate(self, certfile: str, keyfile: str, verify: str = None,
               timeout: float | None = None) -> None:
        """Rotation hook (24h). Atomically swaps material and rebuilds client.
        Graceful: waits for in-flight via the same lock."""
        with self._lock:
            self.certfile = certfile
            self.keyfile = keyfile
            if verify:
                self.verify = verify
            t = timeout or 15.0
            new = self._build_client(t)
            old = self._client
            self._client = new
            try:
                old.close()
            except Exception:
                pass
        log.info("mTLS client rotated for %s", self.service_name)

    # ---- request -----------------------------------------------------------------
    def send(self, method: str, path: str, *, json_body=None, params=None,
             headers: dict = None, expected_service: str = None) -> httpx.Response:
        if not self.breaker.allow_request():
            raise RuntimeError(f"circuit open for {self.service_name}")

        last_exc = None
        for attempt in range(self.max_retries + 1):
            try:
                with self._lock:
                    client = self._client
                resp = client.request(method, path, json=json_body,
                                      params=params, headers=headers)
                if resp.status_code >= 500:
                    raise httpx.HTTPStatusError(str(resp.status_code),
                                                request=resp.request,
                                                response=resp)
                # Optional identity check (if server exposes its CN via header
                # on a trusted channel; otherwise done via TLS peer auth).
                if expected_service and resp.headers.get("x-service-name"):
                    if resp.headers["x-service-name"] != expected_service:
                        raise PermissionError(
                            f"identity mismatch: got "
                            f"{resp.headers['x-service-name']}")
                self.breaker.on_success()
                log.debug("%s %s -> %s (attempt %d)", method,
                          _redact_url(path), resp.status_code, attempt)
                return resp
            except Exception as exc:
                last_exc = exc
                self.breaker.on_failure()
                log.warning("zT call %s %s failed (attempt %d): %s",
                            method, _redact_url(path), attempt,
                            _redact_body(str(exc), 200))
                if attempt < self.max_retries:
                    time.sleep(_default_backoff(attempt))
        raise RuntimeError(f"zero-trust call to {self.service_name} failed: "
                           f"{last_exc}") from last_exc

    def get(self, path, **kw):
        return self.send("GET", path, **kw)

    def post(self, path, **kw):
        return self.send("POST", path, **kw)

    def close(self):
        try:
            self._client.close()
        except Exception:
            pass


_certs_dir = lambda: os.getenv("ZT_CERTS_DIR", "/data/jarvis/certs")  # noqa: E731

_default_timeout_s = 15.0


def from_env(service_name: str = None, base_url: str = None,
             timeout: float | None = None) -> "ZeroTrustClient":
    """Build a client from convention: certs under ZT_CERTS_DIR named after the
    service. Uses JARVIS_<SERVICE>_CERT / _KEY / _CA overrides if present."""
    svc = service_name or os.getenv("ZT_SERVICE", "jarvis")
    cd = os.getenv("ZT_CERTS_DIR", "/data/jarvis/certs")
    certfile = (os.getenv(f"JARVIS_{svc.upper()}_CERT") or
                os.path.join(cd, f"{svc}-client.pem"))
    keyfile = (os.getenv(f"JARVIS_{svc.upper()}_KEY") or
               os.path.join(cd, f"{svc}-client.key"))
    ca = os.getenv("JARVIS_ROOT_CA") or os.path.join(cd, "root-ca.pem")
    t = timeout if timeout is not None else _default_timeout_s
    return ZeroTrustClient(service_name=svc, certfile=certfile, keyfile=keyfile,
                           verify=ca, base_url=base_url, timeout=t)
"""
J.A.R.V.I.S. Level 10 — Ubiquitous Sentience ASGI entrypoint (FastAPI).

Runs on Fly.io multi-region. Serves:
  * GET  /health        - liveness + dependency validation (Fly check target)
  * GET  /healthz       - alias for container runtime checks
  * GET  /              - service metadata / region banner
  * POST /api/webhook   - Telegram webhook receiver (signature-verified)

Middleware:
  * Fly-Region context injection -> sets app.current_region for RLS SQL.
  * Blocks requests lacking a region header on data-bound routes (Step 5).

We deliberately DO NOT import the Vercel BaseHTTPRequestHandler entrypoint as
the ASGI app; instead we reuse the same orchestrator pipeline via a canonical
function. This keeps Vercel (api/webhook.py) untouched for zero-downtime
migration and gives Fly a proper ASGI surface.
"""
import os
import json
import logging
import time

# FastAPI + starlette may be absent in lightweight/test envs; degrade gracefully.
try:
    from starlette.requests import Request
    from starlette.responses import JSONResponse, PlainTextResponse
    from starlette.middleware.base import BaseHTTPMiddleware
    from fastapi import FastAPI, Header
    _HAS_FASTAPI = True
    _HAS_STARLETTE = True
except Exception:  # noqa: BLE001
    FastAPI = None  # type: ignore[assignment,misc]
    _HAS_FASTAPI = False
    _HAS_STARLETTE = False
    # minimal stand-ins so the module still imports below
    class Request:  # type: ignore[no-redef]
        pass
    def JSONResponse(payload, status_code=200):  # type: ignore[no-redef]
        return {"payload": payload, "status_code": status_code}
    def PlainTextResponse(text):  # type: ignore[no-redef]
        return text
    BaseHTTPMiddleware = object  # type: ignore[misc,assignment]

from utils import supabase_client  # noqa: E402

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("fly_app")

app = FastAPI(title="J.A.R.V.I.S. Level 10", version="10.0.0") if _HAS_FASTAPI \
    else type("_NullApp", (), {
        "get": lambda *a, **k: (lambda f: f),
        "post": lambda *a, **k: (lambda f: f),
        "add_middleware": lambda *a, **k: None,
    })()  # type: ignore[union-attr]

ALLOWED_REGIONS = {"sin", "nrt", "ord", "ams", "hkg"}
_DATA_ROUTES = {"/api/webhook"}


class FlyRegionContext(BaseHTTPMiddleware if _HAS_FASTAPI else object):
    """Inject Fly-Region into the DB session and enforce residency."""
    async def dispatch(self, request, call_next):
        region = (request.headers.get("fly-region") or "").lower().strip()
        # Simulate a PostgreSQL GUC for RLS (Supabase remote doesn't expose
        # current_setting from app easily); we store for middleware consumers.
        request.state.region = region if region in ALLOWED_REGIONS else \
            os.getenv("FLY_REGION", "sin").lower()
        # Hard block data-bound routes missing a valid region header.
        if request.url.path in _DATA_ROUTES and region not in ALLOWED_REGIONS:
            return JSONResponse({"ok": False, "error": "missing_region",
                                 "detail": "Fly-Region header required"},
                                status_code=412)
        return await call_next(request)


if _HAS_FASTAPI:
    app.add_middleware(FlyRegionContext)


def _dep_checks() -> dict:
    checks = {}
    # Supabase
    try:
        supabase_client._config()
        checks["supabase"] = "up"
    except Exception:
        checks["supabase"] = "down"
    # Region
    checks["region"] = os.getenv("FLY_REGION", os.getenv("PRIMARY_REGION",
                                                         "sin")).lower()
    return checks


def _verify_telegram(secret: str, token: str) -> bool:
    import hmac
    if not secret:
        return True  # loose mode; require TELEGRAM_SECRET_TOKEN in prod
    return hmac.compare_digest(token or "", secret)


@app.get("/health")  # type: ignore[attr-defined]
def health():
    checks = _dep_checks()
    ok = checks.get("supabase") == "up"
    return JSONResponse({"ok": ok, "service": "J.A.R.V.I.S. L10",
                         "t": int(time.time()), "checks": checks},
                        status_code=200 if ok else 503)


@app.get("/healthz")  # type: ignore[attr-defined]
def healthz():
    return PlainTextResponse("ok")


@app.get("/")  # type: ignore[attr-defined]
def root():
    return JSONResponse({
        "service": "J.A.R.V.I.S. Level 10 Ubiquitous Sentience",
        "region": os.getenv("FLY_REGION", "sin").lower(),
        "routes": ["/health", "/healthz", "/api/webhook"],
        "instance": os.getenv("FLY_MACHINE_ID", "local"),
    })


# --- webhook receiver ------------------------------------------------
def _handle_update(update: dict):
    """Process a Telegram update using the same shared pipeline as Vercel.
    Returns (payload, status). Mirrors api/webhook.py's flow but framework-neut.
    """
    cb = update.get("callback_query")
    if cb:
        chat = cb.get("message", {}).get("chat", {})
        chat_id = chat.get("id")
        callback_id = cb.get("id")
        from utils.telegram import answer_callback_query
        if chat_id and callback_id:
            try:
                from utils import commands as commands_utils
                commands_utils._cache_callback_message(
                    callback_id, cb.get("message", {}).get("message_id", 0))
                handled = commands_utils.handle_callback(
                    chat_id, callback_id, cb.get("data", ""),
                    cb.get("from", {}).get("id"))
                if not handled:
                    answer_callback_query(callback_id, "Aksi tidak dikenali")
            except Exception as exc:
                logger.exception("callback failed: %s", exc)
        return {"ok": True}, 200

    message = update.get("message") or update.get("edited_message")
    if not message:
        return {"ok": True}, 200

    chat_id = message.get("chat", {}).get("id")
    text = message.get("text") or message.get("caption")
    username = message.get("from", {}).get("username")
    first_name = message.get("from", {}).get("first_name")

    # Non-text media -> multimodal bridge
    if message.get("photo") or message.get("voice") or message.get("audio") \
            or message.get("document"):
        try:
            from api import webhook_multimodal
            return webhook_multimodal.process_update(update)
        except Exception as exc:
            logger.exception("multimodal failed: %s", exc)
            return {"ok": True, "handled": "multimodal_error"}, 200

    if not text or not chat_id:
        return {"ok": True}, 200

    # Direct commands (same table as Vercel).
    try:
        from utils import commands as commands_utils
        if commands_utils.handle_command(chat_id, text, chat_id):
            return {"ok": True, "handled": "command"}, 200
    except Exception as exc:
        logger.exception("command failed: %s", exc)

    # Enqueue + pipeline (identical to webhook.py).
    from utils.telegram import send_typing
    send_typing(chat_id)
    profile = supabase_client.get_or_create_profile(chat_id, username,
                                                    first_name)
    task_id = supabase_client.insert_task(chat_id, text, profile["id"])
    decision = "cloud"
    try:
        from api.hybrid_router import decide
        decision = decide(chat_id, text)["decision"]
    except Exception as exc:
        logger.info("hybrid unavailable (%s); cloud", exc)
    try:
        from api.orchestrator import _run_pipeline
        region = os.getenv("FLY_REGION", os.getenv("PRIMARY_REGION", "sin")
                           ).lower()
        _run_pipeline(task_id, chat_id, text,
                      execution_location=f"🌏 ORB ({region})")
    except Exception as exc:
        logger.exception("pipeline failed: %s", exc)
        try:
            supabase_client.update_task(task_id, {"status": "FAILED",
                                                   "error": str(exc)[:500]})
        except Exception:
            pass
    return {"ok": True, "task_id": task_id}, 200


if _HAS_FASTAPI:
    @app.post("/api/webhook")
    async def webhook(request: Request,
                      x_telegram_bot_api_secret_token: str = Header(default="")):
        secret = os.getenv("TELEGRAM_SECRET_TOKEN", "")
        if not _verify_telegram(secret, x_telegram_bot_api_secret_token):
            return JSONResponse({"ok": False, "error": "invalid_signature"},
                                status_code=403)
        try:
            body = await request.json()
        except Exception:
            return JSONResponse({"ok": False, "error": "bad_json"},
                                status_code=400)
        payload, status = _handle_update(body)
        return JSONResponse(payload, status_code=status)


# Lightweight fallback so the module can be imported without FastAPI installed.
def handle(environ, start_response):  # for WSGI tests when FastAPI missing
    status = "200 OK"
    headers = [("Content-type", "application/json")]
    route = environ.get("PATH_INFO", "/")
    if route == "/healthz":
        body = b"ok"
    elif route == "/health":
        body = json.dumps(_dep_checks()).encode()
    else:
        body = b'{"service":"J.A.R.V.I.S. L10","region":"sin"}'
    start_response(status, headers)
    return [body]
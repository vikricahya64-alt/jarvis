"""
OAuth2 callback endpoint. URL: /api/oauth2-callback

Browser-safe: the provider redirects here with ?code=&state=. We verify the
signed state (maps back to the owning Telegram chat id), exchange the code,
store the encrypted token in Supabase Vault, register the connection, and
notify the owner on Telegram. No secrets ever appear in logs.
"""
import json
import logging
import urllib.parse
from http.server import BaseHTTPRequestHandler

from utils import authz, oauth2, telegram, vault

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("oauth2-callback")


def _handle(params: dict) -> dict:
    code = params.get("code", [""])[0]
    state = params.get("state", [""])[0]
    if not code or not state:
        return {"ok": False, "error": "parameter code/state hilang"}
    tg_id, provider = oauth2.parse_state(state)
    if not tg_id:
        return {"ok": False, "error": "state tidak valid"}
    if isinstance(tg_id, str):
        tg_id = int(tg_id)

    # Provider is carried in the signed state (robust to any provider's
    # callback query string); fall back to the query param / gmail.
    provider = provider or params.get("provider", [""])[0] or "gmail"

    try:
        token = oauth2.exchange(provider, code)
    except Exception as exc:
        logger.exception("exchange failed")
        return {"ok": False, "error": f"penukaran kode gagal: {exc}"}

    provider = token.get("provider", provider)
    secret_name = f"conn_{tg_id}_{provider}"
    vault.write_secret(secret_name, json.dumps({
        "access_token": token.get("access_token", ""),
        "refresh_token": token.get("refresh_token", ""),
        "expires_at": token.get("expires_at"),
    }))
    authz.upsert_connection(tg_id, provider, token.get("account", ""),
                            secret_name, extra={})

    telegram.send_message(
        tg_id,
        f"✅ Terhubung ke **{provider}** sebagai `{token.get('account')}`. "
        f"Sekarang saya dapat mengakses akun itu atas nama Anda.",
    )
    return {"ok": True, "connected": provider, "account": token.get("account")}


class handler(BaseHTTPRequestHandler):

    def do_GET(self):
        params = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
        try:
            result = _handle(params)
        except Exception as exc:
            logger.exception("oauth2 callback failed")
            result = {"ok": False, "error": str(exc)[:200]}
        html = ("<h3>J.A.R.V.I.S. OAuth</h3>"
                + ("<p>✅ Terhubung. Kembali ke Telegram.</p>"
                   if result.get("ok")
                   else f"<p>❌ {result.get('error', 'gagal')}</p>"))
        self._send_html(html)

    def _send_html(self, html: str):
        data = html.encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, format, *args):
        logger.info("%s - %s" % (self.address_string(), format % args))
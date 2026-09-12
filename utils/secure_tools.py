"""
Level 3 spec facade - Secure Environment Tools.

Thin, stable contract over the Vault + private-integration modules so any
caller (orchestrator, tests, future scripts) imports from this single file:

  fetch_secret(secret_name)    -> decrypted Vault secret (env fallback)
  read_gmail(query, tg)        -> {messages: [...]} or {"error": ...}
  upload_drive(name, content, tg) -> {file_id, view_url} or {"error": ...}
  get_calendar_events(days, tg)-> {events: [...]} or {"error": ...}
  query_notion(query, tg)      -> {results: [...]} or {"error": ...}

Security is enforced by the underlying modules (utils/vault.py,
utils/authz.py, tools/private_integrations.py): the real `telegram_chat_id`
is always injected server-side, ownership is checked, quotas are enforced,
and secrets never appear in code, logs, or client responses.
"""
from utils.tools import (
    fetch_secret,
    read_gmail,
    upload_drive,
    get_calendar_events,
    query_notion,
    reflect_and_learn,
)

__all__ = [
    "fetch_secret",
    "read_gmail",
    "upload_drive",
    "get_calendar_events",
    "query_notion",
    "reflect_and_learn",
]
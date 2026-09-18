"""
Secure environment tools facade.

Thin, stable API over the raw modules so callers (orchestrator, tests,
scripts) always import from `utils.tools` instead of reaching into Vault or
provider internals:

  fetch_secret(name)          -> decrypted Supabase Vault secret (env fallback)
  read_gmail(args)            -> {messages: [...]} or {"error": ...}
  upload_drive(args)          -> {file_id, url} or {"error": ...}
  query_notion(args)          -> {results: [...]} or {"error": ...}
  get_calendar_events(args)   -> {events: [...]} or {"error": ...}
  reflect_and_learn(...)      -> learning-loop reflection

These enforce ownership + rate limits server-side (see utils/authz), and
never let secrets leak into logs/errors.
"""
from utils import vault
from utils.learning_loop import (
    reflect as reflect_and_learn,
    build_preference_block,
    store_preference,
    retrieve_preferences,
)


def fetch_secret(secret_name: str) -> str:
    """Retrieve a decrypted secret from Supabase Vault (env fallback)."""
    return vault.fetch_secret(secret_name)


def _dispatch(name: str, args: dict, telegram_id: int):
    from tools.private_integrations import dispatch_private
    return dispatch_private(name, args, telegram_id)


def read_gmail(args: dict, telegram_id: int):
    """Read the user's Gmail inbox (ownership + rate-limited)."""
    return _dispatch("read_gmail", args, telegram_id)


def upload_drive(args: dict, telegram_id: int):
    """Upload content to the user's Google Drive."""
    return _dispatch("upload_to_drive", args, telegram_id)


def query_notion(args: dict, telegram_id: int):
    """Search the user's Notion workspace."""
    return _dispatch("query_notion", args, telegram_id)


def get_calendar_events(args: dict, telegram_id: int):
    """Read the user's Google Calendar events (ownership + rate-limited)."""
    return _dispatch("get_calendar_events", args, telegram_id)


def reflect_and_learn(telegram_id: int, user_message: str,
                      task_result: str, tool_names: list = None):
    """After-task learning-reflection wrapper (see utils.learning_engine)."""
    from utils.learning_engine import reflect_and_learn as _r
    return _r(telegram_id, user_message, task_result, tool_names)
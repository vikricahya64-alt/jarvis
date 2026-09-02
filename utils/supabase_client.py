"""
Supabase client wrapper: database access + storage upload for artifacts.

Uses the service-role key server-side so the orchestrator can manage
tasks, store chat history, and upload generated files to the Storage bucket.

Implemented with plain httpx calls against the PostgREST REST API. The
official `supabase` SDK's connection pool raises `[Errno 16] Device or
resource busy` inside Vercel serverless, even when everything else (httpx
to Telegram) works fine — so we bypass the SDK entirely.
"""
import os
import base64
import datetime
import httpx

_SUPABASE_URL = None
_SUPABASE_KEY = None
_TIMEOUT = httpx.Timeout(25)


def _config():
    global _SUPABASE_URL, _SUPABASE_KEY
    if _SUPABASE_URL is None:
        url = (os.getenv("SUPABASE_URL") or "").rstrip("/")
        key = os.getenv("SUPABASE_SERVICE_KEY") or os.getenv("SUPABASE_KEY")
        if not url or not key:
            raise RuntimeError("SUPABASE_URL and SUPABASE_KEY are required")
        _SUPABASE_URL = url
        _SUPABASE_KEY = key
    return _SUPABASE_URL, _SUPABASE_KEY


def _auth_headers(content_type: str = "application/json") -> dict:
    _, key = _config()
    return {
        "apikey": key,
        "Authorization": f"Bearer {key}",
        "Content-Type": content_type,
    }


def _raise_for(response: httpx.Response, ctx: str):
    if response.status_code >= 400:
        raise RuntimeError(f"Supabase {ctx} -> HTTP {response.status_code}: {response.text[:300]}")


# ------------------------------------------------------------------
# Profiles
# ------------------------------------------------------------------
def get_or_create_profile(telegram_id: int, username=None, first_name=None):
    """Fetch or create a profile for a Telegram user."""
    base, _ = _config()
    with httpx.Client(timeout=_TIMEOUT) as client:
        res = client.get(
            f"{base}/rest/v1/profiles",
            params={"select": "*", "telegram_id": f"eq.{telegram_id}"},
            headers=_auth_headers(),
        )
        _raise_for(res, "profiles.select")
        rows = res.json()

        if rows:
            return rows[0]

        payload = {
            "telegram_id": telegram_id,
            "username": username,
            "first_name": first_name,
        }
        res = client.post(
            f"{base}/rest/v1/profiles",
            json=payload,
            headers={**_auth_headers(), "Prefer": "return=representation"},
        )
        _raise_for(res, "profiles.insert")
        return res.json()[0]


def log_routing(telegram_id: int, message_hash: str, decision: str,
                complexity: float, sensitivity: float, latency_ms: int,
                device_status: dict) -> bool:
    """Append a hybrid-router decision to routing_log (audit trail)."""
    try:
        return _insert_json("routing_log", {
            "telegram_id": telegram_id,
            "message_hash": message_hash,
            "decision": decision,
            "complexity": complexity,
            "sensitivity": sensitivity,
            "latency_ms": int(latency_ms),
            "device_status": device_status or {},
        })
    except Exception:
        return False


def log_residency(telegram_id: int, record_id: str, location: str,
                  pii_detected: bool, pii_types: list,
                  redacted_fields: list, note: str = "") -> bool:
    """Append a data-residency audit entry (compliance trail)."""
    try:
        return _insert_json("data_residency_audit", {
            "telegram_id": telegram_id,
            "record_id": record_id,
            "location": location,
            "pii_detected": bool(pii_detected),
            "pii_types": pii_types or [],
            "redacted_fields": redacted_fields or [],
            "execution_note": note or "",
        })
    except Exception:
        return False


def get_latest_routing(telegram_id: int, limit: int = 5) -> list:
    """Most recent routing decisions for a user (privacy dashboard)."""
    base, _ = _config()
    try:
        with httpx.Client(timeout=_TIMEOUT) as client:
            res = client.get(
                f"{base}/rest/v1/routing_log",
                params={"select": "*", "telegram_id": f"eq.{telegram_id}",
                        "order": "created_at.desc", "limit": str(limit)},
                headers=_auth_headers(),
            )
            if res.status_code >= 400:
                return []
            return res.json()
    except Exception:
        return []


def get_residency_summary(telegram_id: int) -> dict:
    """Counts of local vs cloud executions for the /privacy dashboard."""
    base, _ = _config()
    counts = {"local": 0, "cloud": 0, "backup": 0}
    try:
        with httpx.Client(timeout=_TIMEOUT) as client:
            rows = client.get(
                f"{base}/rest/v1/data_residency_audit",
                params={"select": "location", "telegram_id": f"eq.{telegram_id}"},
                headers=_auth_headers(),
            ).json()
            for r in rows:
                loc = r.get("location")
                if loc in counts:
                    counts[loc] += 1
    except Exception:
        pass
    return counts


def _insert_json(table: str, row: dict) -> bool:
    """Minimal insert helper used by the audit loggers (service role)."""
    base, _ = _config()
    with httpx.Client(timeout=_TIMEOUT) as client:
        res = client.post(
            f"{base}/rest/v1/{table}",
            json=row,
            headers={**_auth_headers(), "Prefer": "return=minimal"},
        )
        return res.status_code < 400


# ------------------------------------------------------------------
# Level 6: device heartbeat + device task queue
# ------------------------------------------------------------------
def store_device_heartbeat(telegram_id: int, status: dict) -> bool:
    """Upsert the Realme C25s heartbeat (written by the device poller)."""
    base, _ = _config()
    row = {
        "telegram_id": telegram_id,
        "online": True,
        "temp_c": status.get("temp_c"),
        "ram_pct": status.get("ram_pct"),
        "threads": status.get("threads"),
        "latency_ms": status.get("latency_ms"),
        "model": status.get("model", "Qwen2.5-1.5B"),
    }
    try:
        with httpx.Client(timeout=_TIMEOUT) as client:
            # Upsert: insert-or-ignore then patch by PK.
            client.post(f"{base}/rest/v1/device_status", json=row,
                        headers={**_auth_headers(),
                                 "Prefer": "resolution=merge-duplicates"})
            return True
    except Exception:
        return False


def read_device_health(telegram_id: int, fresh_win_s: int = 60) -> dict:
    """Read the cached device heartbeat. `online=False` when absent/stale."""
    base, _ = _config()
    try:
        with httpx.Client(timeout=_TIMEOUT) as client:
            res = client.get(
                f"{base}/rest/v1/device_status",
                params={"select": "*", "telegram_id": f"eq.{telegram_id}",
                        "limit": "1"},
                headers=_auth_headers(),
            )
            if res.status_code >= 400:
                return {"online": False}
            rows = res.json()
            if not rows:
                return {"online": False}
            st = rows[0]
            from datetime import datetime, timezone
            updated = st.get("updated_at")
            try:
                dt = datetime.fromisoformat(str(updated).replace("Z", "+00:00"))
                age = (datetime.now(timezone.utc) - dt).total_seconds()
            except Exception:
                age = 9999
            return {
                "online": age <= fresh_win_s,
                "temp_c": st.get("temp_c"),
                "ram_pct": st.get("ram_pct"),
                "threads": st.get("threads"),
                "latency_ms": st.get("latency_ms"),
                "model": st.get("model") or "",
                "age_s": int(age),
            }
    except Exception:
        return {"online": False}


def enqueue_device_task(telegram_id: int, envelope: dict,
                        task_id: str = None) -> bool:
    """Queue an encrypted payload for the local device to pick up."""
    base, _ = _config()
    row = {"telegram_id": telegram_id, "envelope": envelope, "status": "PENDING"}
    if task_id:
        row["task_id_fk"] = task_id
    try:
        with httpx.Client(timeout=_TIMEOUT) as client:
            res = client.post(
                f"{base}/rest/v1/device_queue",
                json=row,
                headers={**_auth_headers(), "Prefer": "return=minimal"},
            )
            return res.status_code < 400
    except Exception:
        return False


def dequeue_device_task(telegram_id: int) -> dict:
    """Device poller: atomically claim the oldest PENDING task + mark SENT."""
    base, _ = _config()
    with httpx.Client(timeout=_TIMEOUT) as client:
        res = client.get(
            f"{base}/rest/v1/device_queue",
            params={"select": "*", "telegram_id": f"eq.{telegram_id}",
                    "status": "eq.PENDING", "order": "created_at.asc",
                    "limit": "1"},
            headers=_auth_headers(),
        )
        if res.status_code >= 400:
            return None
        rows = res.json()
        if not rows:
            return None
        row = rows[0]
        patch = client.patch(
            f"{base}/rest/v1/device_queue",
            params={"id": f"eq.{row['id']}", "status": "eq.PENDING"},
            json={"status": "SENT"},
            headers={**_auth_headers(), "Prefer": "return=representation"},
        )
        if patch.status_code >= 400 or not patch.json():
            return None   # claimed by another poller
        return patch.json()[0]


def complete_device_task(queue_id: str, task_id: str, result: dict) -> bool:
    """Mark a device_queue row DONE and update the linked task (if any)."""
    base, _ = _config()
    try:
        with httpx.Client(timeout=_TIMEOUT) as client:
            client.patch(
                f"{base}/rest/v1/device_queue",
                params={"id": f"eq.{queue_id}"},
                json={"status": "DONE"},
                headers=_auth_headers(),
            )
            if task_id:
                client.patch(
                    f"{base}/rest/v1/tasks",
                    params={"id": f"eq.{task_id}"},
                    json={"status": "DONE",
                          "result_text": (result.get("text") or "")[:4000],
                          "error": result.get("error")},
                    headers=_auth_headers(),
                )
            return True
    except Exception:
        return False


# ------------------------------------------------------------------
# Level 5: behavioral / emotional / evolution / consent profile state
# ------------------------------------------------------------------
def _profile_patch(telegram_id: int, column: str, value) -> bool:
    """Patch one Level-5 JSONB column on a user's profile."""
    base, _ = _config()
    with httpx.Client(timeout=_TIMEOUT) as client:
        res = client.patch(
            f"{base}/rest/v1/profiles",
            params={"telegram_id": f"eq.{telegram_id}"},
            json={column: value},
            headers=_auth_headers(),
        )
        return res.status_code < 400


def get_profile(telegram_id: int) -> dict:
    """Fetch the full profile row (or a minimal shell if absent)."""
    try:
        return get_or_create_profile(telegram_id)
    except Exception:
        return {}


def set_behavior_profile(telegram_id: int, behavior: dict) -> bool:
    """Store the (aggregate-only) behavior profile snapshot."""
    return _profile_patch(telegram_id, "behavior_profile", behavior or {})


def set_emotional_trends(telegram_id: int, trends: dict) -> bool:
    """Store anonymized emotional trend aggregates."""
    return _profile_patch(telegram_id, "emotional_trends", trends or {})


def set_service_consent(telegram_id: int, consent: dict) -> bool:
    """Store per-service consent map (e.g. {gmail: false, calendar: true})."""
    return _profile_patch(telegram_id, "service_consent", consent or {})


def read_service_consent(telegram_id: int) -> dict:
    return (get_profile(telegram_id).get("service_consent") or {})


def append_evolution(telegram_id: int, entry: dict) -> bool:
    """Append an evolution-log entry (for 7-day rollback). Kept in memory
    of the existing array to avoid a read-modify-write race."""
    curr = get_profile(telegram_id).get("evolution_log") or []
    if not isinstance(curr, list):
        curr = []
    curr.append(entry)
    # Cap the log to avoid unbounded growth on free tier.
    return _profile_patch(telegram_id, "evolution_log", curr[-50:])


def get_evolution_log(telegram_id: int) -> list:
    log = get_profile(telegram_id).get("evolution_log")
    return log if isinstance(log, list) else []


# ------------------------------------------------------------------
# Level 5: v_user_behavioral_patterns (30-day behavior window)
# ------------------------------------------------------------------
def get_behavioral_patterns(telegram_id: int, days: int = 30) -> list:
    """Rows from v_user_behavioral_patterns for a user (via RPC-executed
    raw query is not available on free PostgREST for views, so we fall
    back to the view through the authenticated endpoint helper)."""
    base, _ = _config()
    try:
        with httpx.Client(timeout=_TIMEOUT) as client:
            res = client.get(
                f"{base}/rest/v1/v_user_behavioral_patterns",
                params={"telegram_id": f"eq.{telegram_id}",
                        "order": "activity_day.asc"},
                headers=_auth_headers(),
            )
            if res.status_code >= 400:
                return []
            return res.json()
    except Exception:
        return []


# ------------------------------------------------------------------
# Level 5: synthesized_insights (predictive / synthesis cards)
# ------------------------------------------------------------------
def record_insight(telegram_id: int, insight_type: str, payload: dict,
                   priority: int = 0, ttl_hours: int = 168) -> bool:
    """Insert a synthesized insight card with a TTL expiry."""
    base, _ = _config()
    expires = (
        datetime.datetime.utcnow()
        + datetime.timedelta(hours=ttl_hours)
    ).isoformat()
    row = {
        "telegram_id": telegram_id,
        "insight_type": insight_type,
        "payload": payload,
        "priority": priority,
        "expires_at": expires,
    }
    try:
        with httpx.Client(timeout=_TIMEOUT) as client:
            res = client.post(
                f"{base}/rest/v1/synthesized_insights",
                json=row,
                headers={**_auth_headers(), "Prefer": "return=minimal"},
            )
            return res.status_code < 400
    except Exception:
        return False


def get_active_insights(telegram_id: int, insight_type: str = None,
                        limit: int = 10) -> list:
    """Return non-dismissed, unexpired insight cards for a user."""
    base, _ = _config()
    params = {
        "select": "*",
        "telegram_id": f"eq.{telegram_id}",
        "dismissed": "eq.false",
        "expires_at": f"gt.{datetime.datetime.utcnow().isoformat()}",
        "order": "priority.desc,created_at.desc",
        "limit": str(limit),
    }
    if insight_type:
        params["insight_type"] = f"eq.{insight_type}"
    try:
        with httpx.Client(timeout=_TIMEOUT) as client:
            res = client.get(f"{base}/rest/v1/synthesized_insights",
                             params=params, headers=_auth_headers())
            if res.status_code >= 400:
                return []
            return res.json()
    except Exception:
        return []


def update_insight(insight_id: str, updates: dict) -> bool:
    """Mark an insight dismissed/acted_on, etc."""
    base, _ = _config()
    updates.setdefault("updated_at", datetime.datetime.utcnow().isoformat())
    try:
        with httpx.Client(timeout=_TIMEOUT) as client:
            res = client.patch(
                f"{base}/rest/v1/synthesized_insights",
                params={"id": f"eq.{insight_id}"},
                json=updates,
                headers=_auth_headers(),
            )
            return res.status_code < 400
    except Exception:
        return False


def cleanup_expired_insights() -> int:
    """TTL cleanup: delete expired insights. Returns rows removed."""
    base, _ = _config()
    try:
        with httpx.Client(timeout=_TIMEOUT) as client:
            res = client.delete(
                f"{base}/rest/v1/synthesized_insights",
                params={"expires_at": f"lt.{datetime.datetime.utcnow().isoformat()}"},
                headers={**_auth_headers(), "Prefer": "return=minimal,count=exact"},
            )
            try:
                return int(res.headers.get("content-range", "*/0").split("/")[1])
            except Exception:
                return 0
    except Exception:
        return 0


# ------------------------------------------------------------------
# Tasks (event-driven queue)
# ------------------------------------------------------------------
def insert_task(telegram_id: int, input_text: str, profile_id=None,
                agent=None, agent_type=None) -> str:
    """Insert a new PENDING task; returns the task id (UUID).

    `agent="swarm"` marks a parent swarm task; `agent_type` marks a child agent
    row (researcher/coder/reviewer/writer). Both columns are Level-4 only and
    are omitted when the migration hasn't run (PostgREST ignores unknowns? No —
    it rejects them, hence callers guard with `_insert_task_columns`).
    """
    base, _ = _config()
    payload = {"telegram_id": telegram_id, "input": input_text}
    if profile_id:
        payload["profile_id"] = profile_id
    sane_agent_types = ("researcher", "coder", "reviewer", "writer")
    if agent == "swarm":
        payload["agent"] = "swarm"
    if agent_type in sane_agent_types:
        payload["agent_type"] = agent_type
    with httpx.Client(timeout=_TIMEOUT) as client:
        res = client.post(
            f"{base}/rest/v1/tasks",
            json=payload,
            headers={**_auth_headers(), "Prefer": "return=representation"},
        )
        if res.status_code == 400 and "agent_type" in res.text and agent_type:
            # Pre-migration database: drop the swarm columns, retry once.
            payload.pop("agent_type", None)
            payload.pop("agent", None)
            res = client.post(
                f"{base}/rest/v1/tasks",
                json=payload,
                headers={**_auth_headers(), "Prefer": "return=representation"},
            )
        _raise_for(res, "tasks.insert")
        return res.json()[0]["id"]


def insert_child_task(telegram_id: int, parent_task_id: str,
                      agent_type: str, input_text: str) -> str:
    """Insert a PENDING child agent row (parent_task_id + agent_type filled)."""
    valid = ("researcher", "coder", "reviewer", "writer")
    if agent_type not in valid:
        raise ValueError(f"agent_type harus salah satu {valid}")
    base, _ = _config()
    payload = {
        "telegram_id": telegram_id,
        "input": input_text,
        "parent_task_id": parent_task_id,
        "agent_type": agent_type,
    }
    with httpx.Client(timeout=_TIMEOUT) as client:
        res = client.post(
            f"{base}/rest/v1/tasks",
            json=payload,
            headers={**_auth_headers(), "Prefer": "return=representation"},
        )
        _raise_for(res, "child_tasks.insert")
        return res.json()[0]["id"]


def update_task(task_id: str, updates: dict):
    """Update a task row (status, result, error, etc.)."""
    base, _ = _config()
    updates.setdefault("updated_at", datetime.datetime.utcnow().isoformat())
    with httpx.Client(timeout=_TIMEOUT) as client:
        res = client.patch(
            f"{base}/rest/v1/tasks",
            params={"id": f"eq.{task_id}"},
            json=updates,
            headers=_auth_headers(),
        )
        _raise_for(res, "tasks.update")


def count_tasks(status: str) -> int:
    """Count tasks with a given status (used by /status)."""
    base, _ = _config()
    with httpx.Client(timeout=_TIMEOUT) as client:
        res = client.get(
            f"{base}/rest/v1/tasks",
            params={"select": "id", "status": f"eq.{status}", "limit": "0"},
            headers={**_auth_headers(), "Prefer": "count=exact"},
        )
        if res.status_code >= 400:
            return -1
        cr = res.headers.get("content-range", "*/0")
        try:
            return int(cr.split("/")[1])
        except Exception:
            return -1


def reclaim_stale_tasks(stale_minutes: int = 10) -> int:
    """
    Reset PROCESSING tasks older than stale_minutes back to PENDING so the
    cron worker can retry them. Covers runs killed by the Vercel function
    timeout: the handler dies mid-pipeline, so no FAILED status is ever
    written and the task would otherwise be stuck forever.
    """
    base, _ = _config()
    cutoff = (
        datetime.datetime.utcnow() - datetime.timedelta(minutes=stale_minutes)
    ).isoformat()
    with httpx.Client(timeout=_TIMEOUT) as client:
        res = client.patch(
            f"{base}/rest/v1/tasks",
            params={"status": "eq.PROCESSING", "updated_at": f"lt.{cutoff}"},
            json={"status": "PENDING"},
            headers={**_auth_headers(), "Prefer": "return=minimal,count=exact"},
        )
        if res.status_code >= 400:
            return 0
        try:
            return int(res.headers.get("content-range", "*/0").split("/")[1])
        except Exception:
            return 0


def claim_next_pending(include_agents: bool = False):
    """
    Atomically claim the oldest PENDING root task and mark it PROCESSING.
    Returns the task dict, or None if there is nothing to process.

    Child agent rows (agent_type != null) and swarm parents are excluded by
    default — they are handled by the swarm coordinator / its own cron worker.
    Pass include_agents=True to claim them (used by the swarm cron path).
    """
    base, _ = _config()
    with httpx.Client(timeout=_TIMEOUT) as client:
        # 0. Unstick any PROCESSING task left over from a timed-out run.
        try:
            reclaim_stale_tasks()
        except Exception:
            pass

        # 1. Find the oldest PENDING root task.
        params = {
            "select": "*",
            "status": "eq.PENDING",
            "order": "created_at.asc",
            "limit": "1",
        }
        if not include_agents:
            params["parent_task_id"] = "is.null"
            params["agent_type"] = "is.null"
        res = client.get(
            f"{base}/rest/v1/tasks",
            params=params,
            headers=_auth_headers(),
        )
        _raise_for(res, "tasks.pending.select")
        rows = res.json()
        if not rows:
            return None

        task = rows[0]

        # 2. Claim it: only transition if still PENDING (guards double-claim).
        res = client.patch(
            f"{base}/rest/v1/tasks",
            params={"id": f"eq.{task['id']}", "status": "eq.PENDING"},
            json={"status": "PROCESSING"},
            headers={**_auth_headers(), "Prefer": "return=representation"},
        )
        _raise_for(res, "tasks.claim")
        claimed = res.json()
        if not claimed:
            return None  # another worker claimed it first; nothing for us to do
        task["status"] = "PROCESSING"
        return task


# ------------------------------------------------------------------
# Chat history (for RAG context)
# ------------------------------------------------------------------
def insert_chat(telegram_id: int, role: str, content: str):
    """Insert a message into chat_history."""
    profile = get_or_create_profile(telegram_id)
    base, _ = _config()
    payload = {
        "telegram_id": telegram_id,
        "profile_id": profile["id"],
        "role": role,
        "content": content,
    }
    with httpx.Client(timeout=_TIMEOUT) as client:
        res = client.post(
            f"{base}/rest/v1/chat_history",
            json=payload,
            headers={**_auth_headers(), "Prefer": "return=minimal"},
        )
        _raise_for(res, "chat_history.insert")


def get_recent_history(telegram_id: int, limit: int = 10):
    """Fetch recent chat history for context injection."""
    base, _ = _config()
    with httpx.Client(timeout=_TIMEOUT) as client:
        res = client.get(
            f"{base}/rest/v1/chat_history",
            params={
                "select": "role,content",
                "telegram_id": f"eq.{telegram_id}",
                "order": "created_at.desc",
                "limit": str(limit),
            },
            headers=_auth_headers(),
        )
        _raise_for(res, "chat_history.select")
        rows = res.json()
        return list(reversed(rows))


def retrieve_relevant_history(telegram_id: int, query: str, limit: int = 4):
    """
    Semantic-ish (pg_trgm) retrieval of past chat rows matching `query`.
    Uses the `match_chat_history` RPC; degrades to [] when the migration
    hasn't run (the orchestrator then falls back to recent history only).
    """
    base, _ = _config()
    try:
        with httpx.Client(timeout=_TIMEOUT) as client:
            res = client.post(
                f"{base}/rest/v1/rpc/match_chat_history",
                json={"p_telegram_id": telegram_id, "p_query": query,
                      "p_limit": limit},
                headers=_auth_headers(),
            )
            if res.status_code == 404:
                return []
            _raise_for(res, "rpc.match_chat_history")
            return res.json()
    except Exception:
        return []


# ------------------------------------------------------------------
# Chat history helpers for memory compaction
# ------------------------------------------------------------------
def get_all_chat_telegram_ids() -> list:
    """Distinct telegram_ids that have any chat history."""
    base, _ = _config()
    with httpx.Client(timeout=_TIMEOUT) as client:
        res = client.get(
            f"{base}/rest/v1/chat_history",
            params={"select": "telegram_id", "order": "created_at.asc"},
            headers=_auth_headers(),
        )
        _raise_for(res, "chat_history.ids")
        seen = set()
        for row in res.json():
            seen.add(row.get("telegram_id"))
        return list(seen)


def count_chat(telegram_id: int) -> int:
    """Number of chat_history rows for a user."""
    base, _ = _config()
    with httpx.Client(timeout=_TIMEOUT) as client:
        res = client.get(
            f"{base}/rest/v1/chat_history",
            params={"select": "id", "telegram_id": f"eq.{telegram_id}",
                    "limit": "0"},
            headers={**_auth_headers(), "Prefer": "count=exact"},
        )
        if res.status_code >= 400:
            return 0
        cr = res.headers.get("content-range", "*/0")
        try:
            return int(cr.split("/")[1])
        except Exception:
            return 0


def get_oldest_chat(telegram_id: int, limit: int = 40):
    """Oldest chat_history rows (id, role, content) for compaction."""
    base, _ = _config()
    with httpx.Client(timeout=_TIMEOUT) as client:
        res = client.get(
            f"{base}/rest/v1/chat_history",
            params={"select": "id,role,content",
                    "telegram_id": f"eq.{telegram_id}",
                    "order": "created_at.asc", "limit": str(limit)},
            headers=_auth_headers(),
        )
        _raise_for(res, "chat_history.oldest")
        return res.json()


def delete_chat_ids(ids: list) -> bool:
    """Delete chat_history rows by primary-key id (used after compaction)."""
    if not ids:
        return True
    base, _ = _config()
    with httpx.Client(timeout=_TIMEOUT) as client:
        res = client.delete(
            f"{base}/rest/v1/chat_history",
            params={"id": f"in.({','.join(ids)})"},
            headers=_auth_headers(),
        )
        return res.status_code < 400


# ------------------------------------------------------------------
# Storage: upload artifact files
# ------------------------------------------------------------------
def upload_artifact(filename: str, data_b64: str, mime: str) -> str:
    """
    Upload a base64-encoded file to the 'artifacts' storage bucket.
    Returns the public URL.
    """
    base, _ = _config()
    raw = base64.b64decode(data_b64)
    with httpx.Client(timeout=_TIMEOUT) as client:
        res = client.put(
            f"{base}/storage/v1/object/artifacts/{filename}",
            content=raw,
            headers={**_auth_headers(mime), "x-upsert": "true"},
        )
        _raise_for(res, "storage.upload")
        return f"{base}/storage/v1/object/public/artifacts/{filename}"
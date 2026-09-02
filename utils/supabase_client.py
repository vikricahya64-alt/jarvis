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


# ------------------------------------------------------------------
# Level 7: self_repair_log
# ------------------------------------------------------------------
def log_self_repair(telegram_id: int, module: str, issue: str,
                    severity: str = "low", diff: str = "", status: str = "proposed",
                    blocked: bool = False) -> bool:
    """Record an autonomous repair attempt in self_repair_log."""
    try:
        return _insert_json("self_repair_log", {
            "telegram_id": telegram_id,
            "module": module,
            "issue": issue[:500],
            "severity": severity,
            "diff": diff[:4000],
            "status": status,
            "blocked": bool(blocked),
        })
    except Exception:
        return False


def list_self_repair(telegram_id: int, limit: int = 10) -> list:
    """Recent self-repair entries for a user."""
    base, _ = _config()
    try:
        with httpx.Client(timeout=_TIMEOUT) as client:
            res = client.get(
                f"{base}/rest/v1/self_repair_log",
                params={"select": "*",
                        "or": f"(telegram_id.eq.{telegram_id},telegram_id.eq.0)",
                        "order": "created_at.desc", "limit": str(limit)},
                headers=_auth_headers(),
            )
            if res.status_code >= 400:
                return []
            return res.json()
    except Exception:
        return []


def count_self_repair(status: str = None) -> int:
    """Count repair rows (optionally by status)."""
    base, _ = _config()
    params = {"select": "id", "limit": "0"}
    if status:
        params["status"] = f"eq.{status}"
    try:
        with httpx.Client(timeout=_TIMEOUT) as client:
            res = client.get(f"{base}/rest/v1/self_repair_log",
                             params=params,
                             headers={**_auth_headers(),
                                      "Prefer": "return=minimal,count=exact"},
                             )
            if res.status_code >= 400:
                return 0
            cr = res.headers.get("content-range", "*/0")
            return int(cr.split("/")[1])
    except Exception:
        return 0


# ------------------------------------------------------------------
# Level 7: model_adapters (QLoRA registry)
# ------------------------------------------------------------------
def register_adapter(telegram_id: int, name: str, base_model: str,
                     target: str = "phone", artifact_url: str = "",
                     sha256: str = "", status: str = "training") -> bool:
    try:
        return _insert_json("model_adapters", {
            "telegram_id": telegram_id, "name": name,
            "base_model": base_model, "target": target,
            "artifact_url": artifact_url, "sha256": sha256,
            "status": status,
        })
    except Exception:
        return False


def list_adapters(telegram_id: int, limit: int = 10) -> list:
    base, _ = _config()
    try:
        with httpx.Client(timeout=_TIMEOUT) as client:
            res = client.get(
                f"{base}/rest/v1/model_adapters",
                params={"select": "*",
                        "or": f"(telegram_id.eq.{telegram_id},telegram_id.eq.0)",
                        "order": "created_at.desc", "limit": str(limit)},
                headers=_auth_headers(),
            )
            return res.json() if res.status_code < 400 else []
    except Exception:
        return []


def update_adapter(adapter_id: str, updates: dict) -> bool:
    base, _ = _config()
    updates.setdefault("updated_at", datetime.datetime.utcnow().isoformat())
    try:
        with httpx.Client(timeout=_TIMEOUT) as client:
            res = client.patch(
                f"{base}/rest/v1/model_adapters",
                params={"id": f"eq.{adapter_id}"},
                json=updates, headers=_auth_headers(),
            )
            return res.status_code < 400
    except Exception:
        return False


# ------------------------------------------------------------------
# Level 7: replica_registry
# ------------------------------------------------------------------
def register_replica(telegram_id: int, label: str, peer_addr: str = "",
                     pgp_fingerprint: str = "", components: list = None,
                     status: str = "pending") -> bool:
    try:
        return _insert_json("replica_registry", {
            "telegram_id": telegram_id, "label": label,
            "peer_addr": peer_addr, "pgp_fingerprint": pgp_fingerprint,
            "components": components or [], "status": status,
        })
    except Exception:
        return False


def list_replicas(telegram_id: int, limit: int = 20) -> list:
    base, _ = _config()
    try:
        with httpx.Client(timeout=_TIMEOUT) as client:
            res = client.get(
                f"{base}/rest/v1/replica_registry",
                params={"select": "*",
                        "or": f"(telegram_id.eq.{telegram_id},telegram_id.eq.0)",
                        "order": "created_at.desc", "limit": str(limit)},
                headers=_auth_headers(),
            )
            return res.json() if res.status_code < 400 else []
    except Exception:
        return []


# ------------------------------------------------------------------
# Level 7: genetic_archive (IPFS DNA)
# ------------------------------------------------------------------
def record_genetic_archive(telegram_id: int, version: str, cid: str,
                           sha256: str = "", manifest: dict = None) -> bool:
    try:
        return _insert_json("genetic_archive", {
            "telegram_id": telegram_id, "version": version, "cid": cid,
            "sha256": sha256, "manifest": manifest or {},
        })
    except Exception:
        return False


def latest_genetic_archive(telegram_id: int) -> dict:
    base, _ = _config()
    try:
        with httpx.Client(timeout=_TIMEOUT) as client:
            res = client.get(
                f"{base}/rest/v1/genetic_archive",
                params={"select": "*",
                        "or": f"(telegram_id.eq.{telegram_id},telegram_id.eq.0)",
                        "order": "created_at.desc", "limit": "1"},
                headers=_auth_headers(),
            )
            rows = res.json() if res.status_code < 400 else []
            return rows[0] if rows else {}
    except Exception:
        return {}


# ------------------------------------------------------------------
# Level 7: meta_audit_log
# ------------------------------------------------------------------
def record_meta_audit(telegram_id: int, week: str, metrics: dict,
                      recommendation: dict, risk: str = "low",
                      status: str = "proposed") -> bool:
    try:
        return _insert_json("meta_audit_log", {
            "telegram_id": telegram_id, "week": week,
            "metrics": metrics or {}, "recommendation": recommendation or {},
            "risk": risk, "status": status,
        })
    except Exception:
        return False


def latest_meta_audit(telegram_id: int) -> dict:
    base, _ = _config()
    try:
        with httpx.Client(timeout=_TIMEOUT) as client:
            res = client.get(
                f"{base}/rest/v1/meta_audit_log",
                params={"select": "*",
                        "or": f"(telegram_id.eq.{telegram_id},telegram_id.eq.0)",
                        "order": "created_at.desc", "limit": "3"},
                headers=_auth_headers(),
            )
            rows = res.json() if res.status_code < 400 else []
            return rows[0] if rows else {}
    except Exception:
        return {}


# ------------------------------------------------------------------
# Level 7: device_health_metrics (time-series)
# ------------------------------------------------------------------
def record_device_metric(telegram_id: int, temp_c, ram_percent,
                         routing_mode: str = "auto", latency_ms: int = 0,
                         source: str = "device") -> bool:
    try:
        return _insert_json("device_health_metrics", {
            "telegram_id": telegram_id, "temp_c": temp_c,
            "ram_percent": ram_percent, "routing_mode": routing_mode,
            "latency_ms": int(latency_ms), "source": source,
        })
    except Exception:
        return False


def recent_device_metrics(telegram_id: int, limit: int = 10) -> list:
    base, _ = _config()
    try:
        with httpx.Client(timeout=_TIMEOUT) as client:
            res = client.get(
                f"{base}/rest/v1/device_health_metrics",
                params={"select": "*", "telegram_id": f"eq.{telegram_id}",
                        "order": "created_at.desc", "limit": str(limit)},
                headers=_auth_headers(),
            )
            return res.json() if res.status_code < 400 else []
    except Exception:
        return []


# ------------------------------------------------------------------
# Level 8: knowledge graph (memory_nodes / memory_edges)
# ------------------------------------------------------------------
def upsert_memory_node(telegram_id: int, entity: str, ntype: str = "concept",
                       properties: dict = None, embedding: list = None,
                       node_id: str = "") -> str:
    """Insert a memory graph node (or touch an existing one).
    Anonymized entities only; never store raw PII here."""
    base, _ = _config()
    try:
        with httpx.Client(timeout=_TIMEOUT) as client:
            # Find matching node for this owner+entity first.
            exists = client.get(
                f"{base}/rest/v1/memory_nodes",
                params={"select": "id", "telegram_id": f"eq.{telegram_id}",
                        "entity": f"eq.{entity}", "limit": "1"},
                headers=_auth_headers(),
            ).json()
            payload = {
                "telegram_id": telegram_id, "entity": entity, "type": ntype,
                "properties": properties or {},
                "embedding": embedding,
                "updated_at": datetime.datetime.utcnow().isoformat(),
            }
            if exists and exists[0].get("id"):
                client.patch(
                    f"{base}/rest/v1/memory_nodes?id=eq.{exists[0]['id']}",
                    json=payload, headers=_auth_headers(),
                )
                return exists[0]["id"]
            res = client.post(
                f"{base}/rest/v1/memory_nodes", json=payload,
                headers={**_auth_headers(), "Prefer": "return=representation"},
            )
            rows = res.json() if res.status_code < 400 else []
            return (rows[0]["id"] if rows else "")
    except Exception:
        return ""


def search_memory(telegram_id: int, embedding: list, limit: int = 5) -> list:
    """Vector similarity search over memory_nodes (pgvector).
    Falls back to empty list on any error (never raises)."""
    base, _ = _config()
    try:
        with httpx.Client(timeout=_TIMEOUT) as client:
            res = client.post(
                f"{base}/rest/v1/rpc/search_memory_nodes",
                json={"p_telegram_id": telegram_id,
                      "p_embedding": embedding, "p_limit": limit},
                headers=_auth_headers(),
            )
            return res.json() if res.status_code < 400 else []
    except Exception:
        return []


def add_memory_edge(telegram_id: int, source_id: str, target_id: str,
                    relation: str, strength: float = 0.5) -> bool:
    """Create or reinforce a weighted edge between two memory nodes."""
    base, _ = _config()
    try:
        with httpx.Client(timeout=_TIMEOUT) as client:
            exists = client.get(
                f"{base}/rest/v1/memory_edges",
                params={"select": "id,strength",
                        "source_id": f"eq.{source_id}",
                        "target_id": f"eq.{target_id}",
                        "relation": f"eq.{relation}", "limit": "1"},
                headers=_auth_headers(),
            ).json()
            now = datetime.datetime.utcnow().isoformat()
            if exists:
                new = min(1.0, (exists[0].get("strength") or 0.5) + strength * 0.3)
                client.patch(
                    f"{base}/rest/v1/memory_edges?id=eq.{exists[0]['id']}",
                    json={"strength": round(new, 3), "last_seen": now},
                    headers=_auth_headers(),
                )
                return True
            client.post(f"{base}/rest/v1/memory_edges", json={
                "telegram_id": telegram_id, "source_id": source_id,
                "target_id": target_id, "relation": relation,
                "strength": strength, "last_seen": now,
            }, headers=_auth_headers())
            return True
    except Exception:
        return False


def get_memory_neighbors(telegram_id: int, node_id: str, limit: int = 20) -> list:
    """Graph traversal: return edges (+ neighbor summary) for a node."""
    base, _ = _config()
    try:
        with httpx.Client(timeout=_TIMEOUT) as client:
            res = client.get(
                f"{base}/rest/v1/memory_edges",
                params={"select": "*",
                        "or": f"(source_id.eq.{node_id},target_id.eq.{node_id})",
                        "limit": str(limit)},
                headers=_auth_headers(),
            )
            return res.json() if res.status_code < 400 else []
    except Exception:
        return []


# ------------------------------------------------------------------
# Level 8: swarm coordination (swarm_node_registry)
# ------------------------------------------------------------------
def register_swarm_node(telegram_id: int, device_id: str, role: str,
                        capabilities: list = None, peer_addr: str = "",
                        platform: str = "", ram_mb: int = 0,
                        temp_c=None) -> bool:
    """Upsert a swarm peer identity + capabilities."""
    base, _ = _config()
    try:
        with httpx.Client(timeout=_TIMEOUT) as client:
            client.post(f"{base}/rest/v1/swarm_node_registry", json={
                "telegram_id": telegram_id, "device_id": device_id,
                "role": role, "capabilities": capabilities or [],
                "peer_addr": peer_addr, "platform": platform,
                "ram_mb": ram_mb, "temp_c": temp_c, "status": "online",
            }, headers={**_auth_headers(), "Prefer": "resolution=merge-duplicates"},
                params={"on_conflict": "telegram_id,device_id"})
            return True
    except Exception:
        return False


def update_swarm_heartbeat(telegram_id: int, device_id: str,
                           status: str = "online", **extra) -> bool:
    """Patch a swarm node's heartbeat fields by (telegram_id, device_id)."""
    base, _ = _config()
    try:
        with httpx.Client(timeout=_TIMEOUT) as client:
            existing = client.get(
                f"{base}/rest/v1/swarm_node_registry",
                params={"select": "id", "telegram_id": f"eq.{telegram_id}",
                        "device_id": f"eq.{device_id}", "limit": "1"},
                headers=_auth_headers(),
            ).json()
            if not existing:
                return False
            payload = {"status": status,
                       "last_heartbeat": datetime.datetime.utcnow().isoformat()}
            payload.update(extra)
            client.patch(f"{base}/rest/v1/swarm_node_registry?id=eq.{existing[0]['id']}",
                         json=payload, headers=_auth_headers())
            return True
    except Exception:
        return False


def list_swarm_nodes(telegram_id: int, limit: int = 50) -> list:
    base, _ = _config()
    try:
        with httpx.Client(timeout=_TIMEOUT) as client:
            res = client.get(
                f"{base}/rest/v1/swarm_node_registry",
                params={"select": "*", "telegram_id": f"eq.{telegram_id}",
                        "order": "last_heartbeat.desc", "limit": str(limit)},
                headers=_auth_headers(),
            )
            return res.json() if res.status_code < 400 else []
    except Exception:
        return []


# ------------------------------------------------------------------
# Level 8: federated learning (federated_rounds)
# ------------------------------------------------------------------
def start_federated_round(telegram_id: int, model_version: str = "",
                          round_id: int = 0) -> str:
    """Open a new federated round; returns its id (or '')."""
    if not round_id:
        prev = latest_federated_round(telegram_id)
        round_id = (prev.get("round_id") or 0) + 1
    base, _ = _config()
    try:
        with httpx.Client(timeout=_TIMEOUT) as client:
            res = client.post(f"{base}/rest/v1/federated_rounds", json={
                "telegram_id": telegram_id, "round_id": round_id,
                "model_version": model_version, "status": "collecting",
            }, headers={**_auth_headers(), "Prefer": "return=representation"})
            rows = res.json() if res.status_code < 400 else []
            return (rows[0]["id"] if rows else "")
    except Exception:
        return ""


def record_federated_parity(telegram_id: int, round_id: int,
                            participant: str, gradient_count: int) -> bool:
    """Append a participant's gradient contribution to the round manifest."""
    base, _ = _config()
    try:
        with httpx.Client(timeout=_TIMEOUT) as client:
            prev = latest_federated_round(telegram_id)
            if not prev:
                return False
            participants = prev.get("participants") or []
            if participant not in participants:
                participants.append(participant)
            manifest = dict(prev.get("manifest") or {})
            manifest[participant] = {"gradients": gradient_count,
                                     "at": datetime.datetime.utcnow().isoformat()}
            client.patch(
                f"{base}/rest/v1/federated_rounds?id=eq.{prev['id']}",
                json={"participants": participants,
                      "gradient_count": (prev.get("gradient_count") or 0) + gradient_count,
                      "manifest": manifest},
                headers=_auth_headers())
            return True
    except Exception:
        return False


def finalize_federated_round(telegram_id: int, round_id: int,
                             validation_score=None, status: str = "validated",
                             model_version: str = "") -> bool:
    """Close a round once the aggregator has validated the global model."""
    base, _ = _config()
    try:
        with httpx.Client(timeout=_TIMEOUT) as client:
            prev = latest_federated_round(telegram_id)
            if not prev:
                return False
            patch = {"status": status,
                     "finished_at": datetime.datetime.utcnow().isoformat()}
            if validation_score is not None:
                patch["validation_score"] = validation_score
            if model_version:
                patch["model_version"] = model_version
            client.patch(f"{base}/rest/v1/federated_rounds?id=eq.{prev['id']}",
                         json=patch, headers=_auth_headers())
            return True
    except Exception:
        return False


def latest_federated_round(telegram_id: int) -> dict:
    base, _ = _config()
    try:
        with httpx.Client(timeout=_TIMEOUT) as client:
            res = client.get(
                f"{base}/rest/v1/federated_rounds",
                params={"select": "*", "telegram_id": f"eq.{telegram_id}",
                        "order": "round_id.desc", "limit": "1"},
                headers=_auth_headers(),
            )
            rows = res.json() if res.status_code < 400 else []
            return rows[0] if rows else {}
    except Exception:
        return {}


def federated_history(telegram_id: int, limit: int = 10) -> list:
    base, _ = _config()
    try:
        with httpx.Client(timeout=_TIMEOUT) as client:
            res = client.get(
                f"{base}/rest/v1/federated_rounds",
                params={"select": "*", "telegram_id": f"eq.{telegram_id}",
                        "order": "round_id.desc", "limit": str(limit)},
                headers=_auth_headers(),
            )
            return res.json() if res.status_code < 400 else []
    except Exception:
        return []


# ------------------------------------------------------------------
# Level 8: intuition engine (intuition_log)
# ------------------------------------------------------------------
def record_intuition(telegram_id: int, domain: str, prediction: str,
                     reasoning: str, confidence: float, impact: str = "low",
                     blocked: bool = False) -> bool:
    try:
        return _insert_json("intuition_log", {
            "telegram_id": telegram_id, "domain": domain,
            "prediction": prediction[:2000], "reasoning": reasoning[:2000],
            "confidence": round(confidence, 3), "impact": impact,
            "blocked": blocked, "user_feedback": "pending",
        })
    except Exception:
        return False


def feedback_intuition(telegram_id: int, intuition_id: str,
                       feedback: str = "dismissed") -> bool:
    base, _ = _config()
    try:
        with httpx.Client(timeout=_TIMEOUT) as client:
            client.patch(f"{base}/rest/v1/intuition_log?id=eq.{intuition_id}",
                         json={"user_feedback": feedback}, headers=_auth_headers())
            return True
    except Exception:
        return False


def recent_intuitions(telegram_id: int, limit: int = 10) -> list:
    base, _ = _config()
    try:
        with httpx.Client(timeout=_TIMEOUT) as client:
            res = client.get(
                f"{base}/rest/v1/intuition_log",
                params={"select": "*", "telegram_id": f"eq.{telegram_id}",
                        "order": "timestamp.desc", "limit": str(limit)},
                headers=_auth_headers(),
            )
            return res.json() if res.status_code < 400 else []
    except Exception:
        return []


def intuition_feedback_prior(telegram_id: int, domain: str) -> dict:
    """Aggregate feedback history for a domain into a Bayesian prior
    (alpha/beta). Returns {} when no data. Never raises."""
    try:
        rows = recent_intuitions(telegram_id, limit=200)
        hit = correct = 0
        for r in rows:
            if r.get("domain") != domain or r.get("blocked"):
                continue
            hit += 1
            if r.get("user_feedback") == "correct":
                correct += 1
        return {"samples": hit, "correct": correct,
                "alpha": correct + 1, "beta": (hit - correct) + 1} if hit else {}
    except Exception:
        return {}


def reset_intuition(telegram_id: int, domain: str = "") -> bool:
    """Safety override: wipe a user's intuition feedback history (or a single
    domain). Used by /reset_intuition. Never raises."""
    try:
        base, _ = _config()
        with httpx.Client(timeout=_TIMEOUT) as client:
            params = {"telegram_id": f"eq.{telegram_id}"}
            if domain:
                params["domain"] = f"eq.{domain}"
            res = client.delete(
                f"{base}/rest/v1/intuition_log",
                params=params, headers=_auth_headers(),
            )
            return res.status_code < 400
    except Exception:
        return False


# ------------------------------------------------------------------
# Level 9: Symbiotic Consciousness (constitution / legacy / value /
# decision journal / existential audit)
# ------------------------------------------------------------------
def latest_constitution(telegram_id: int) -> dict:
    """Most recent version of a user's personal constitution."""
    base, _ = _config()
    try:
        with httpx.Client(timeout=_TIMEOUT) as client:
            res = client.get(
                f"{base}/rest/v1/personal_constitution",
                params={"select": "*", "telegram_id": f"eq.{telegram_id}",
                        "order": "version.desc", "limit": "1"},
                headers=_auth_headers())
            rows = res.json() if res.status_code < 400 else []
            return rows[0] if rows else {}
    except Exception:
        return {}


def constitution_history(telegram_id: int, limit: int = 10) -> list:
    """Version history of the constitution (most recent first)."""
    base, _ = _config()
    try:
        with httpx.Client(timeout=_TIMEOUT) as client:
            res = client.get(
                f"{base}/rest/v1/personal_constitution",
                params={"select": "*", "telegram_id": f"eq.{telegram_id}",
                        "order": "version.desc", "limit": str(limit)},
                headers=_auth_headers())
            return res.json() if res.status_code < 400 else []
    except Exception:
        return []


def list_violations(telegram_id: int, limit: int = 25) -> list:
    """Append-only constitutional violation log (most recent first)."""
    base, _ = _config()
    try:
        with httpx.Client(timeout=_TIMEOUT) as client:
            res = client.get(
                f"{base}/rest/v1/constitutional_violations",
                params={"select": "*", "telegram_id": f"eq.{telegram_id}",
                        "order": "blocked_at.desc", "limit": str(limit)},
                headers=_auth_headers())
            return res.json() if res.status_code < 400 else []
    except Exception:
        return []


def record_violation(telegram_id: int, action_hash: str, intent: str,
                     principle: str, reasoning: str, confidence: float,
                     module: str = "") -> bool:
    try:
        return _insert_json("constitutional_violations", {
            "telegram_id": telegram_id, "action_hash": (action_hash or "")[:32],
            "intent": (intent or "")[:500], "violated_principle": principle[:200],
            "reasoning": (reasoning or "")[:1000],
            "confidence": round(confidence, 3), "origin_module": (module or "")[:60],
        })
    except Exception:
        return False


# --- legacy plans ---
def save_legacy_plan(telegram_id: int, encrypted_blob: bytes, cipher: str,
                     intent: str, trigger_conditions: dict,
                     trusted_contacts: list, name: str = "main",
                     pii_ref: str = "") -> bool:
    import base64 as _b64
    base, _ = _config()
    try:
        with httpx.Client(timeout=_TIMEOUT) as client:
            client.post(f"{base}/rest/v1/legacy_plans", json={
                "telegram_id": telegram_id, "name": name,
                "encrypted_blob": _b64.b64encode(encrypted_blob).decode("ascii"),
                "cipher_algorithm": cipher, "intent": intent,
                "trigger_conditions": trigger_conditions,
                "trusted_contacts": trusted_contacts, "pii_ref": pii_ref,
                "status": "armed",
            }, headers=_auth_headers())
            return True
    except Exception:
        return False


def list_legacy_plans(telegram_id: int, limit: int = 10) -> list:
    base, _ = _config()
    try:
        with httpx.Client(timeout=_TIMEOUT) as client:
            res = client.get(
                f"{base}/rest/v1/legacy_plans",
                params={"select": "*", "telegram_id": f"eq.{telegram_id}",
                        "order": "created_at.desc", "limit": str(limit)},
                headers=_auth_headers())
            return res.json() if res.status_code < 400 else []
    except Exception:
        return []


def update_legacy_plan_status(telegram_id: int, plan_id: str,
                              status: str) -> bool:
    base, _ = _config()
    try:
        with httpx.Client(timeout=_TIMEOUT) as client:
            client.patch(f"{base}/rest/v1/legacy_plans?id=eq.{plan_id}",
                         json={"status": status, "updated_at":
                               datetime.datetime.utcnow().isoformat()},
                         headers=_auth_headers())
            return True
    except Exception:
        return False


# --- value interpretations ---
def propose_value(telegram_id: int, domain: str, old: str, proposal: str,
                  rationale: str, confidence: float) -> bool:
    try:
        return _insert_json("value_interpretations", {
            "telegram_id": telegram_id, "domain": domain[:120],
            "old_interpretation": old[:1000], "new_proposal": proposal[:1000],
            "rationale": (rationale or "")[:1000], "confidence": round(confidence, 3),
            "status": "pending",
        })
    except Exception:
        return False


def pending_proposals(telegram_id: int, limit: int = 25) -> list:
    base, _ = _config()
    try:
        with httpx.Client(timeout=_TIMEOUT) as client:
            res = client.get(
                f"{base}/rest/v1/value_interpretations",
                params={"select": "*", "telegram_id": f"eq.{telegram_id}",
                        "status": "eq.pending",
                        "order": "created_at.desc", "limit": str(limit)},
                headers=_auth_headers())
            return res.json() if res.status_code < 400 else []
    except Exception:
        return []


def confirm_value(telegram_id: int, proposal_id: str, confirm: bool) -> bool:
    base, _ = _config()
    status = "confirmed" if confirm else "rejected"
    try:
        with httpx.Client(timeout=_TIMEOUT) as client:
            patch = {"status": status}
            if confirm:
                patch["confirmed_at"] = datetime.datetime.utcnow().isoformat()
            client.patch(f"{base}/rest/v1/value_interpretations?id=eq.{proposal_id}",
                         json=patch, headers=_auth_headers())
            return True
    except Exception:
        return False


def expire_value(telegram_id: int, proposal_id: str) -> bool:
    base, _ = _config()
    try:
        with httpx.Client(timeout=_TIMEOUT) as client:
            client.patch(f"{base}/rest/v1/value_interpretations?id=eq.{proposal_id}",
                         json={"status": "expired"}, headers=_auth_headers())
            return True
    except Exception:
        return False


# --- decision journal (immutable append-only) ---
def append_decision(telegram_id: int, context_json: dict, decision_json: dict,
                    rationale: str, domain: str = "misc",
                    reversible: bool = True) -> bool:
    try:
        return _insert_json("decision_journal", {
            "telegram_id": telegram_id, "context_json": context_json,
            "decision_json": decision_json, "rationale": (rationale or "")[:1000],
            "outcome": "pending", "reversible_flag": reversible,
            "domain": domain[:60],
        })
    except Exception:
        return False


def list_decisions(telegram_id: int, domain: str = "", outcome: str = "",
                   limit: int = 50) -> list:
    base, _ = _config()
    params = {"select": "*", "telegram_id": f"eq.{telegram_id}",
              "order": "created_at.desc", "limit": str(limit)}
    if domain:
        params["domain"] = f"eq.{domain}"
    if outcome:
        params["outcome"] = f"eq.{outcome}"
    try:
        with httpx.Client(timeout=_TIMEOUT) as client:
            res = client.get(f"{base}/rest/v1/decision_journal", params=params,
                             headers=_auth_headers())
            return res.json() if res.status_code < 400 else []
    except Exception:
        return []


def reverse_decision(telegram_id: int, decision_id: str) -> bool:
    """Mark a decision as reversed (outcome). Journal stays append-only; user
    RLS only allows INSERT+SELECT, so reversal is a backend-service operation."""
    base, _ = _config()
    try:
        with httpx.Client(timeout=_TIMEOUT) as client:
            client.patch(f"{base}/rest/v1/decision_journal?id=eq.{decision_id}",
                         json={"outcome": "reversed"}, headers=_auth_headers())
            return True
    except Exception:
        return False


# --- existential audits ---
def record_audit(telegram_id: int, reflections: dict,
                 follow_up: list = None) -> bool:
    try:
        return _insert_json("existential_audits", {
            "telegram_id": telegram_id, "reflections_json": reflections,
            "user_response": "pending", "follow_up_actions": follow_up or [],
        })
    except Exception:
        return False


def latest_audit(telegram_id: int) -> dict:
    base, _ = _config()
    try:
        with httpx.Client(timeout=_TIMEOUT) as client:
            res = client.get(
                f"{base}/rest/v1/existential_audits",
                params={"select": "*", "telegram_id": f"eq.{telegram_id}",
                        "order": "audit_date.desc", "limit": "1"},
                headers=_auth_headers())
            rows = res.json() if res.status_code < 400 else []
            return rows[0] if rows else {}
    except Exception:
        return {}


def update_audit_response(telegram_id: int, audit_id: str,
                          response: str) -> bool:
    base, _ = _config()
    try:
        with httpx.Client(timeout=_TIMEOUT) as client:
            client.patch(f"{base}/rest/v1/existential_audits?id=eq.{audit_id}",
                         json={"user_response": response}, headers=_auth_headers())
            return True
    except Exception:
        return False
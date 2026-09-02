"""
Persistent per-user todo list, stored in Supabase (PostgREST).

Requires the `todos` table (see sql/todos_schema.sql, run it once in the
SQL Editor). All functions are synchronous and return plain dicts — they
never raise, so the orchestrator loop can keep going. If the table is
missing, functions return a graceful error hint instead of crashing.
"""
import httpx
from utils.supabase_client import _config, _auth_headers

_TIMEOUT = httpx.Timeout(20)


def _todos_url() -> str:
    base, _ = _config()
    return f"{base}/rest/v1/todos"


def _fmt(items, show: str):
    if not items:
        return "Belum ada item."
    lines = []
    for it in items:
        mark = "x" if it.get("status") == "done" else " "
        lines.append(f"[{mark}] {it.get('text', '')}")
    return "\n".join(lines)


def add_todo(telegram_id: int, text: str) -> dict:
    """Insert a new pending todo for a user (skips exact duplicates)."""
    text = (text or "").strip()
    if not text:
        return {"success": False, "error": "Isi todo kosong."}
    try:
        with httpx.Client(timeout=_TIMEOUT) as client:
            # Dedupe: skip if an identical pending todo already exists.
            norm = " ".join(text.casefold().split())
            r = client.get(
                _todos_url(),
                params={"select": "id,text,status",
                        "telegram_id": f"eq.{telegram_id}",
                        "status": "eq.pending"},
                headers=_auth_headers(),
            )
            if r.status_code == 404:
                return {"success": False,
                        "error": "Tabel todos belum dibuat (jalankan sql/todos_schema.sql)."}
            r.raise_for_status()
            for row in r.json():
                existing = " ".join((row.get("text") or "").casefold().split())
                if existing == norm:
                    return {"success": True,
                            "id": row["id"], "text": row["text"],
                            "note": "Sudah ada di daftar (tidak dibuat duplikat)."}

            r = client.post(
                _todos_url(),
                json={"telegram_id": telegram_id, "text": text},
                headers={**_auth_headers(), "Prefer": "return=representation"},
            )
            r.raise_for_status()
            row = r.json()[0]
        return {"success": True, "id": row["id"], "text": text}
    except httpx.HTTPError as exc:
        return {"success": False, "error": f"Todo gagal disimpan: {exc}"}


def list_todos(telegram_id: int, show: str = "pending") -> dict:
    """List todos; show: 'pending' (default), 'all', or 'done'."""
    try:
        status_filter = None
        if show == "pending":
            status_filter = "pending"
            show = "pending"
        elif show == "done":
            status_filter = "done"
            show = "done"
        else:
            show = "all"
        params = {
            "select": "id,text,status,created_at",
            "telegram_id": f"eq.{telegram_id}",
            "order": "created_at.asc",
        }
        if status_filter:
            params["status"] = f"eq.{status_filter}"
        with httpx.Client(timeout=_TIMEOUT) as client:
            r = client.get(_todos_url(), params=params, headers=_auth_headers())
            if r.status_code == 404:
                return {"success": False,
                        "error": "Tabel todos belum dibuat (jalankan sql/todos_schema.sql)."}
            r.raise_for_status()
            rows = r.json()
        return {"success": True, "show": show, "count": len(rows),
                "items": [{"text": x["text"], "status": x["status"]} for x in rows]}
    except httpx.HTTPError as exc:
        return {"success": False, "error": f"Todo gagal dimuat: {exc}"}


def _match_todo(rows, match: str) -> dict:
    """Pick a todo row by text match (> threshold), index (1-based), or id."""
    m = (match or "").strip()
    if not rows:
        return None
    if m.isdigit():
        i = int(m)
        if 1 <= i <= len(rows):
            return rows[i - 1]
    lower = m.lower()
    best, score = None, 0.0
    for row in rows:
        t = (row.get("text") or "").lower()
        if m in t or t in lower:
            s = len(m) / max(len(t), 1)
            if s > 0.3 and s > score:
                best, score = row, s
    if best is not None:
        return best
    for row in rows:
        if row.get("id") == m:
            return row
    return None


def done_todo(telegram_id: int, match: str) -> dict:
    """Mark a pending todo as done (match = text, 1-based index, or id)."""
    try:
        with httpx.Client(timeout=_TIMEOUT) as client:
            r = client.get(
                _todos_url(),
                params={"select": "id,text,status",
                        "telegram_id": f"eq.{telegram_id}",
                        "status": "eq.pending", "order": "created_at.asc"},
                headers=_auth_headers(),
            )
            if r.status_code == 404:
                return {"success": False,
                        "error": "Tabel todos belum dibuat (jalankan sql/todos_schema.sql)."}
            r.raise_for_status()
            row = _match_todo(r.json(), match)
            if row is None:
                return {"success": False,
                        "error": f"Todo '{match}' tidak ditemukan."}
            import datetime
            p = client.patch(
                _todos_url(),
                params={"id": f"eq.{row['id']}", "status": "eq.pending"},
                json={"status": "done",
                      "done_at": datetime.datetime.utcnow().isoformat()},
                headers={**_auth_headers(), "Prefer": "return=representation"},
            )
            if p.status_code >= 400:
                return {"success": False, "error": f"Update gagal: HTTP {p.status_code}"}
        return {"success": True, "done": row["text"]}
    except httpx.HTTPError as exc:
        return {"success": False, "error": f"Todo gagal di-update: {exc}"}


def remove_todo(telegram_id: int, match: str) -> dict:
    """Delete a todo (match = text, index, or id)."""
    try:
        with httpx.Client(timeout=_TIMEOUT) as client:
            r = client.get(
                _todos_url(),
                params={"select": "id,text,status",
                        "telegram_id": f"eq.{telegram_id}",
                        "order": "created_at.asc"},
                headers=_auth_headers(),
            )
            if r.status_code == 404:
                return {"success": False,
                        "error": "Tabel todos belum dibuat (jalankan sql/todos_schema.sql)."}
            r.raise_for_status()
            row = _match_todo(r.json(), match)
            if row is None:
                return {"success": False,
                        "error": f"Todo '{match}' tidak ditemukan."}
            d = client.delete(
                _todos_url(),
                params={"id": f"eq.{row['id']}"},
                headers=_auth_headers(),
            )
            if d.status_code >= 400:
                return {"success": False, "error": f"Hapus gagal: HTTP {d.status_code}"}
        return {"success": True, "removed": row["text"]}
    except httpx.HTTPError as exc:
        return {"success": False, "error": f"Todo gagal dihapus: {exc}"}
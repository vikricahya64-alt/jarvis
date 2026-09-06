-- =====================================================================
-- J.A.R.V.I.S. Level 10/11 — D1 schema migration (0011_todos.sql)
-- Personal todo list for the owner. Read/write ONLY under explicit
-- owner commands (/todo, "tambah todo", "hapus todo"); never triggered
-- by autonomous actions. Fail-closed: owner-only at the application
-- layer, errors surface a graceful message instead of a silent drop.
-- =====================================================================

CREATE TABLE IF NOT EXISTS todos (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    owner_id    INTEGER NOT NULL,
    text        TEXT    NOT NULL,
    done        INTEGER NOT NULL DEFAULT 0,     -- 0=open, 1=done
    created_at  INTEGER NOT NULL,               -- unix ms
    completed_at INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_todos_owner ON todos(owner_id, done);

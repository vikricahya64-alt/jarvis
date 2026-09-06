-- =====================================================================
-- J.A.R.V.I.S. L25 — D1 schema migration (0014_reminders.sql)
-- One-off owner reminders: "ingatkan saya X dalam N menit".
-- Fire-and-forget notifications; the per-minute cron marks rows notified
-- BEFORE sending so a crash mid-send can never double-fire.
-- =====================================================================

CREATE TABLE IF NOT EXISTS reminders (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    owner_id    INTEGER NOT NULL,
    text        TEXT    NOT NULL,
    due_at      INTEGER NOT NULL,               -- unix ms
    notified    INTEGER NOT NULL DEFAULT 0,     -- 1 = notification sent
    created_at  INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_reminders_due ON reminders(owner_id, due_at, notified);
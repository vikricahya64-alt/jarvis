-- =====================================================================
-- J.A.R.V.I.S. L25 — D1 schema migration (0015_recurring_reminders.sql)
-- Recurring reminders: "ingatkan <teks> setiap hari jam 8".
-- repeat '' = once; 'hourly' | 'daily' | 'weekly' = roll to next slot after
-- firing (the per-minute cron advances due_at so it can never double-fire).
-- =====================================================================

ALTER TABLE reminders ADD COLUMN repeat TEXT NOT NULL DEFAULT '';
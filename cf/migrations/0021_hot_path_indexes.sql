-- =====================================================================
-- 0021_hot_path_indexes.sql
--
-- Index untuk hot path yang dijalankan CRON berulang. Semua pernyataan di
-- file ini murni ADDITIVE (CREATE INDEX IF NOT EXISTS) — tidak ada DROP
-- TABLE, tidak ada ALTER, tidak ada data yang tersentuh.
--
-- Mengapa perlu: audit menemukan 5 query yang jalannya full table scan
-- setiap tick, dan `reminders` saja sudah melampaui budget read harian
-- free-tier (100k/hari) pada 100 baris.
--
-- 1) reminders — `idx_reminders_due` (0014) lead dengan `owner_id`, sedangkan
--    query cron `checkDueReminders` TIDAK memfilter owner_id:
--      SELECT ... FROM reminders WHERE notified=0 AND due_at<=? LIMIT 100
--    SQLite tak bisa memakai kolom apa pun dari index itu sebagai seek key
--    → full scan 1440×/hari, dan `notified=1` tidak pernah dihapus.
--    → 0022 menormalkan timestamp-nya; index inilah yang membuat query ini
--      benar-benar cheap.
CREATE INDEX IF NOT EXISTS idx_reminders_fire
  ON reminders(notified, due_at);

-- 2) agent_tasks — dua query per menit tanpa index di `executor`:
--      WHERE executor = ?          AND status IN ('running','pending')
--      WHERE executor LIKE 'borrowed:%' AND status IN ('running','pending')
--    Index yang ada (status / owner_id+status) tidak bisa melayani prefix
--    `executor`, ditambah sort ORDER BY id di atasnya.
CREATE INDEX IF NOT EXISTS idx_agent_tasks_exec
  ON agent_tasks(executor, status, id);

-- 3) obedience_audit — append-only, tanpa retention. `idx_obedience_time`
--    lead dengan `owner_id`; query `calculateUsagePercent` (degradation.ts)
--    tidak punya owner_id → 2 full scan per 6 jam.
CREATE INDEX IF NOT EXISTS idx_obedience_type_ts
  ON obedience_audit(action_type, ts);

-- 4) memories.decayMemories (db.ts) — full scan, TIDAK ada index pada
--    importance / created_at / last_retrieved.
CREATE INDEX IF NOT EXISTS idx_memories_decay
  ON memories(importance, created_at, last_retrieved);

-- 5) memories — dream cycle Deep phase (evolution.ts):
--      UPDATE memories SET expires_at=? WHERE access_count=0
--        AND importance<=1 AND created_at<?
CREATE INDEX IF NOT EXISTS idx_memories_archive
  ON memories(access_count, importance, created_at);

-- 6) memories — dream cycle Light phase:
--      SELECT ... WHERE created_at>=? ORDER BY importance DESC, created_at DESC
CREATE INDEX IF NOT EXISTS idx_memories_fresh
  ON memories(created_at DESC, importance DESC);

-- 7) reflection_log.behaviorAffinity — `reflected` tidak ter-index, jadi
--    SQLite memindai seluruh jendela 30 hari lalu membuang yang bukan koreksi.
CREATE INDEX IF NOT EXISTS idx_refl_reflected
  ON reflection_log(reflected, created_at DESC);

-- 8) identity_epochs — nol index sama sekali, tumbuh 4 baris/hari selamanya,
--    dan `ORDER BY timestamp DESC LIMIT 1` dijalankan tiap 6 jam.
CREATE INDEX IF NOT EXISTS idx_epoch_ts
  ON identity_epochs(timestamp DESC);

-- 9) system_errors — `pruneOldErrors` memfilter `created_at`, tapi index yang
--    ada (0010) dibuat pada `timestamp`. Dua kolom, satu dipakai, satu di-index.
CREATE INDEX IF NOT EXISTS idx_se_created
  ON system_errors(created_at);

-- 10) plans — `advancePlans` per menit: WHERE owner_id=? AND status='active'
CREATE INDEX IF NOT EXISTS idx_plans_owner_status
  ON plans(owner_id, status);

-- 11) agent_task_rules — `getDueAgentRules` lead dengan `active`, query
--     memfilter `owner_id` → scan + sort tiap tick.
CREATE INDEX IF NOT EXISTS idx_agent_task_rules_owner
  ON agent_task_rules(owner_id, next_fire_at);

-- 12) agent_tasks — list per owner ORDER BY id DESC (riwayat tugas).
CREATE INDEX IF NOT EXISTS idx_agent_tasks_owner_id
  ON agent_tasks(owner_id, id DESC);

-- 13) orders — laporan penjualan: owner_id + rentang created_at.
CREATE INDEX IF NOT EXISTS idx_orders_owner_created
  ON orders(owner_id, created_at);

-- 14) owner_preferences — `getAnswerBehaviorContext` ada di HOT PATH tiap turn
--     (`disabled=0 ORDER BY confidence DESC, updated_at DESC`), tabel ini nol index.
CREATE INDEX IF NOT EXISTS idx_prefs_active
  ON owner_preferences(confidence DESC, updated_at DESC)
  WHERE disabled = 0;

-- 15) request_log — `evolution.ts` menghitung `status='fail' AND ts>=?`;
--     `idx_reqlog_prov` lead dengan `provider` sehingga tidak melayani.
CREATE INDEX IF NOT EXISTS idx_reqlog_status_ts
  ON request_log(status, ts);

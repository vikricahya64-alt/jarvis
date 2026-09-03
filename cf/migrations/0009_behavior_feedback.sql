--==============================================================================
-- 0009_behavior_feedback.sql — Level 17 "Behavioral Steward": answer behavior
-- alignment feedback loop (memori+refleksi -> feedback -> perilaku jawaban).
--
-- The bounded reflection loop (reflection_log, L13) already records when the
-- critic flags a defect and JARVIS *changes its answer* (score + reflected).
-- This migration attributes each reflection to a behavioral category so that
-- feedback can be aggregated per category and used to *suppress* recurring
-- answer-behavior patterns the reflection loop keeps correcting (fail-closed:
-- it can only dampen influence, never amplify it).
--
-- Backfill-safe: every existing reflection row is attributed to the default
-- 'behavior' category; the agent only INSERTs into reflection_log (append-only).
--==============================================================================

ALTER TABLE reflection_log ADD COLUMN category TEXT NOT NULL DEFAULT 'behavior';

CREATE INDEX IF NOT EXISTS idx_reflection_category ON reflection_log(category) WHERE category != '';

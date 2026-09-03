--==============================================================================
-- 0008_predictive.sql — Level 16 (Predictive Steward): proactive suggestions
--
-- J.A.R.V.I.S. doesn't silently act on its own — instead it OFFERS the owner
-- concrete, read-only suggestions surfaced from signals it already has:
--   * preferences without a matching scheduled task   ("kamu suka X, mau
--     kujadwalkan rutin?")
--   * high-value insights / unvalidated lessons       ("pelajari pola ini?")
--   * recurring cadences the owner has delegated       (schedule maintenance)
--   * unresolved items (approvals, pending consent)
--
-- Sovereignty: suggestions are ONLY text offers; acting on one is an explicit
-- owner decision. The origin gate (predictive => DEFER) guarantees JARVIS never
-- executes an unprompted suggestion. Everything is append-only + owner-overridable
-- (dismiss), consistent with the L13/L15 guardrail philosophy.
--
-- All 100% free-tier D1.
--==============================================================================

-- One offered suggestion per row. The agent only ever INSERTs; status transitions
-- happen via owner action (accept/dismiss) — never deleted.
CREATE TABLE IF NOT EXISTS suggestions (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    owner_id   INTEGER NOT NULL,
    category   TEXT NOT NULL DEFAULT 'useful', -- preference|insight|task|approval
    text       TEXT NOT NULL,
    source_key TEXT NOT NULL DEFAULT '',        -- dedup key (e.g. pref:key, task:id)
    status     TEXT NOT NULL DEFAULT 'offered', -- offered|accepted|dismissed
    urgency    REAL NOT NULL DEFAULT 0,         -- 0..1 pre-offer score (research: score before interrupt)
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_suggestions_owner_status
  ON suggestions(owner_id, status, created_at);
-- A given source can be offered at most once per (owner, source_key) while it
-- is still 'offered' — prevents nagging the owner with the same suggestion.
-- Once dismissed, the source is excluded via offeredSourceKeys (status !=
-- 'dismissed'), which is the *learned dismiss*: JARVIS won't re-suggest it.
CREATE UNIQUE INDEX IF NOT EXISTS idx_suggestions_dedup
  ON suggestions(owner_id, source_key) WHERE status = 'offered';

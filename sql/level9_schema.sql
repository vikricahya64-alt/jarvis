-- ============================================================
-- J.A.R.V.I.S. LEVEL 9: SYMBIOTIC CONSCIOUSNESS SCHEMA
-- Personal constitution, constitutional violations, digital legacy
-- vault, value alignment, decision journal, and existential audits.
--
-- Run this in the Supabase SQL Editor. Idempotent (safe to re-run).
--
-- ENCRYPTION / SECURITY NOTES (read carefully):
--   * personal_constitution      — plaintext markdown (README-level content,
--     no secrets). Versioned; every amendment stores rationale + editor.
--   * constitutional_violations  — append-only log of BLOCKED actions with
--     action_hash + violated_principle. Immutable by policy (RLS denies UPDATE).
--   * legacy_plans               — NEVER stores plaintext content. Only
--     encrypted_blob (PGP / AES sealed BYTES) + cipher intent. Content is
--     decrypted ONLY in-memory after multisig verification. Trusted contact
--     PII stays in jsonb, but keep only low-sensitivity handles (chat_id or
--     redacted email). The real secret payload lives in the phone local
--     SQLCipher vault; this table holds the trigger + routing + references.
--   * value_interpretations      — proposals authored by the alignment monitor.
--     NEVER auto-confirmed: confirmed_by_user must be set by explicit consent.
--   * decision_journal           — IMMUTABLE append-only by policy. Rows are
--     never UPDATE/DELETE-able by RLS (only INSERT + SELECT). Erasure only via
--     cryptographic overwrite out-of-band (see docs), never via user RLS.
--   * existential_audits         — quarterly + manual reflections. Stores
--     reflection JSON + user response + follow-up actions.
--
-- All RLS respects get_telegram_id() exactly like Level 6-8 tables. Every
-- table is isolated per-user (telegram_id) unless it is a global/system row
-- (telegram_id = 0 allowed read for the owner-only policies where noted).
-- ============================================================

-- ------------------------------------------------------------------
-- 1. PERSONAL CONSTITUTION (versioned principles)
-- ------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.personal_constitution (
    id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    telegram_id     bigint      NOT NULL DEFAULT 0,
    version         integer     NOT NULL DEFAULT 1,
    content_md      text        NOT NULL DEFAULT '',   -- full markdown constitution
    amended_at      timestamptz NOT NULL DEFAULT now(),
    amendment_rationale text    NOT NULL DEFAULT '',
    edited_by       text        NOT NULL DEFAULT 'system',
    created_at      timestamptz NOT NULL DEFAULT now(),
    UNIQUE (telegram_id, version)
);

COMMENT ON TABLE  public.personal_constitution IS
  'Versioned personal constitution. content_md is principles text (no secrets).'
;
CREATE INDEX IF NOT EXISTS pc_owner_version_idx
    ON public.personal_constitution (telegram_id, version DESC);

-- ------------------------------------------------------------------
-- 2. CONSTITUTIONAL VIOLATIONS (append-only block log)
-- ------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.constitutional_violations (
    id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    telegram_id     bigint      NOT NULL DEFAULT 0,
    action_hash     text        NOT NULL DEFAULT '',   -- sha256 of proposed action
    violated_principle text     NOT NULL,              -- e.g. 'Privacy.PII'
    intent          text        NOT NULL DEFAULT '',   -- what was blocked (redacted)
    reasoning       text        NOT NULL DEFAULT '',
    confidence      numeric     NOT NULL DEFAULT 0.0,
    blocked_at      timestamptz NOT NULL DEFAULT now(),
    origin_module   text        NOT NULL DEFAULT '',   -- which module tried the action
    UNIQUE (telegram_id, action_hash)
);

COMMENT ON TABLE  public.constitutional_violations IS
  'Append-only log of constitution BLOCKS. RLS forbids UPDATE/DELETE.'
;
CREATE INDEX IF NOT EXISTS cv_owner_time_idx
    ON public.constitutional_violations (telegram_id, blocked_at DESC);

-- ------------------------------------------------------------------
-- 3. DIGITAL LEGACY VAULT
-- ------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.legacy_plans (
    id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    telegram_id      bigint      NOT NULL DEFAULT 0,
    name             text        NOT NULL DEFAULT 'main',
    encrypted_blob   bytea       NOT NULL DEFAULT '',  -- sealed legacy content
    cipher_algorithm text        NOT NULL DEFAULT 'pgp', -- pgp|aes-gcm
    intent           text        NOT NULL DEFAULT '',  -- transfer|delete|release|archive|none (="no legacy")
    trigger_conditions jsonb    NOT NULL DEFAULT '{"inactivity_days":30,"multisig_required":2}'::jsonb,
    trusted_contacts jsonb      NOT NULL DEFAULT '[]'::jsonb, -- [{kind:'telegram'|'email', handle:'...'}]
    pii_ref          text        NOT NULL DEFAULT '',   -- pointer to phone SQLCipher vault (never the key)
    status           text        NOT NULL DEFAULT 'armed', -- armed|verifying|confirmed|executed|revoked|cancelled
    created_at       timestamptz NOT NULL DEFAULT now(),
    updated_at       timestamptz NOT NULL DEFAULT now(),
    executed_at      timestamptz
);

COMMENT ON TABLE  public.legacy_plans IS
  'Encrypted legacy plan. content encrypted at rest; decrypted only in-memory
   after multisig verification. Contact PII kept low-sensitivity.'
;
CREATE INDEX IF NOT EXISTS lp_owner_status_idx
    ON public.legacy_plans (telegram_id, status);

-- ------------------------------------------------------------------
-- 4. VALUE INTERPRETATIONS (proposals, never auto-applied)
-- ------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.value_interpretations (
    id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    telegram_id      bigint      NOT NULL DEFAULT 0,
    domain           text        NOT NULL,            -- e.g. 'finance.budget'
    old_interpretation text      NOT NULL DEFAULT '',
    new_proposal     text        NOT NULL DEFAULT '',
    rationale        text        NOT NULL DEFAULT '',
    confidence       numeric     NOT NULL DEFAULT 0.0,
    status           text        NOT NULL DEFAULT 'pending', -- pending|confirmed|expired|rejected
    created_at       timestamptz NOT NULL DEFAULT now(),
    expires_at       timestamptz NOT NULL DEFAULT now() + interval '7 days',
    confirmed_at     timestamptz
);

COMMENT ON TABLE  public.value_interpretations IS
  'Value updates proposed by the alignment monitor. NEVER auto-applied;
   requires explicit user confirmation (confirmed_at).'
;
CREATE INDEX IF NOT EXISTS vi_owner_status_idx
    ON public.value_interpretations (telegram_id, status, created_at DESC);

-- ------------------------------------------------------------------
-- 5. DECISION JOURNAL (immutable append-only)
-- ------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.decision_journal (
    id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    telegram_id      bigint      NOT NULL DEFAULT 0,
    context_json     jsonb       NOT NULL DEFAULT '{}'::jsonb,
    decision_json    jsonb       NOT NULL DEFAULT '{}'::jsonb,
    rationale        text        NOT NULL DEFAULT '',
    outcome          text        NOT NULL DEFAULT 'pending', -- pending|accepted|reversed
    reversible_flag  boolean     NOT NULL DEFAULT true,
    domain           text        NOT NULL DEFAULT 'misc',
    created_at       timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE  public.decision_journal IS
  'IMMUTABLE append-only log of autonomous micro-decisions. RLS allows INSERT
   + SELECT only (no UPDATE/DELETE). Cryptographic erasure handled out-of-band.'
;
CREATE INDEX IF NOT EXISTS dj_owner_time_idx
    ON public.decision_journal (telegram_id, created_at DESC);

-- ------------------------------------------------------------------
-- 6. EXISTENTIAL AUDITS (quarterly / manual self-reflection)
-- ------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.existential_audits (
    id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    telegram_id      bigint      NOT NULL DEFAULT 0,
    audit_date       timestamptz NOT NULL DEFAULT now(),
    reflections_json jsonb       NOT NULL DEFAULT '{}'::jsonb,
    user_response    text        NOT NULL DEFAULT 'pending', -- pending|ack|reply|amendment_requested|pause_requested
    follow_up_actions jsonb      NOT NULL DEFAULT '[]'::jsonb,
    created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ea_owner_date_idx
    ON public.existential_audits (telegram_id, audit_date DESC);

-- ------------------------------------------------------------------
-- RLS ENFORCEMENT (per-owner isolation)
-- ------------------------------------------------------------------
ALTER TABLE public.personal_constitution   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.constitutional_violations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.legacy_plans            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.value_interpretations   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.decision_journal        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.existential_audits      ENABLE ROW LEVEL SECURITY;

-- personal_constitution: owner read/write (and system-owned default read)
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='personal_constitution' AND policyname='pc_owner_all') THEN
    CREATE POLICY pc_owner_all ON public.personal_constitution
      FOR ALL USING (telegram_id = get_telegram_id() OR telegram_id = 0)
      WITH CHECK (telegram_id = get_telegram_id() OR telegram_id = 0);
  END IF;
END $$;

-- constitutional_violations: owner SELECT+INSERT only (immutable-> no UPDATE/DELETE)
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='constitutional_violations' AND policyname='cv_owner_ro') THEN
    CREATE POLICY cv_owner_ro ON public.constitutional_violations
      FOR SELECT USING (telegram_id = get_telegram_id() OR telegram_id = 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='constitutional_violations' AND policyname='cv_owner_ins') THEN
    CREATE POLICY cv_owner_ins ON public.constitutional_violations
      FOR INSERT WITH CHECK (telegram_id = get_telegram_id() OR telegram_id = 0);
  END IF;
END $$;

-- legacy_plans: owner full control (read/write/update/delete of own plans)
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='legacy_plans' AND policyname='lp_owner_all') THEN
    CREATE POLICY lp_owner_all ON public.legacy_plans
      FOR ALL USING (telegram_id = get_telegram_id() OR telegram_id = 0)
      WITH CHECK (telegram_id = get_telegram_id() OR telegram_id = 0);
  END IF;
END $$;

-- value_interpretations: owner read/write of own proposals
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='value_interpretations' AND policyname='vi_owner_all') THEN
    CREATE POLICY vi_owner_all ON public.value_interpretations
      FOR ALL USING (telegram_id = get_telegram_id() OR telegram_id = 0)
      WITH CHECK (telegram_id = get_telegram_id() OR telegram_id = 0);
  END IF;
END $$;

-- decision_journal: owner INSERT+SELECT only (immutable append-only)
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='decision_journal' AND policyname='dj_owner_sel') THEN
    CREATE POLICY dj_owner_sel ON public.decision_journal
      FOR SELECT USING (telegram_id = get_telegram_id() OR telegram_id = 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='decision_journal' AND policyname='dj_owner_ins') THEN
    CREATE POLICY dj_owner_ins ON public.decision_journal
      FOR INSERT WITH CHECK (telegram_id = get_telegram_id() OR telegram_id = 0);
  END IF;
END $$;

-- existential_audits: owner read/write
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='existential_audits' AND policyname='ea_owner_all') THEN
    CREATE POLICY ea_owner_all ON public.existential_audits
      FOR ALL USING (telegram_id = get_telegram_id() OR telegram_id = 0)
      WITH CHECK (telegram_id = get_telegram_id() OR telegram_id = 0);
  END IF;
END $$;

-- ------------------------------------------------------------------
-- GRANTS (backend service_role full; owner RLS handles per-user scoping)
-- ------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE, DELETE ON public.personal_constitution   TO service_role;
GRANT SELECT, INSERT                    ON public.constitutional_violations TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.legacy_plans            TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.value_interpretations   TO service_role;
GRANT SELECT, INSERT                    ON public.decision_journal        TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.existential_audits      TO service_role;

-- Provide table counts for quick verification.
SELECT 'personal_constitution' AS tbl FROM pg_tables WHERE tablename='personal_constitution'
UNION ALL SELECT 'constitutional_violations' FROM pg_tables WHERE tablename='constitutional_violations'
UNION ALL SELECT 'legacy_plans' FROM pg_tables WHERE tablename='legacy_plans'
UNION ALL SELECT 'value_interpretations' FROM pg_tables WHERE tablename='value_interpretations'
UNION ALL SELECT 'decision_journal' FROM pg_tables WHERE tablename='decision_journal'
UNION ALL SELECT 'existential_audits' FROM pg_tables WHERE tablename='existential_audits';
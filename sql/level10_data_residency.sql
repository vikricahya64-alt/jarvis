-- ===========================================================================
-- J.A.R.V.I.S. Level 10 — Sovereign Data Residency Enforcement
-- Adds: pinned_region column + CHECK constraint + regional RLS policy to each
-- stateful table. Default pin: 'sin' (Singapore). Backfill existing rows.
--
-- RLS uses a Postgres GUC (app.current_region) set by the FastAPI middleware
-- (utils/fly_app FlyRegionContext) before queries. Requests without a region
-- header are rejected by middleware BEFORE reaching SQL, so `null` region can
-- never return rows accidentally.
--
-- Run (idempotent):
--   PGPASSWORD=... python3 tools/apply_sql.py --commit sql/level10_data_residency.sql
-- (apply_sql owns the transaction; no explicit BEGIN/COMMIT here.)
-- =============================================================================

-- ---- helper: add column + check + backfill if missing (idempotent) -------
DO $$
DECLARE
  t TEXT;
  _sql TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'legacy_plans',
    'personal_constitution',
    'decision_journal',
    'value_interpretations'
  ] LOOP
    -- column
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns c
      WHERE c.table_schema='public' AND c.table_name=t
        AND c.column_name='pinned_region'
    ) THEN
      EXECUTE format('ALTER TABLE public.%I ADD COLUMN pinned_region text '
                     'NOT NULL DEFAULT ''sin''', t);
    END IF;
    -- reap existing check bound to this column (avoid pk conflict)
    BEGIN
      EXECUTE format(
        'ALTER TABLE public.%I DROP CONSTRAINT IF EXISTS %I',
        t, (t || '_pinned_region_chk'));
    EXCEPTION WHEN OTHERS THEN NULL;
    END;
    -- add / refresh constraint
    EXECUTE format(
      'ALTER TABLE public.%I ADD CONSTRAINT %I CHECK '
      '(pinned_region IN (''sin'',''nrt'',''ord''))',
      t, (t || '_pinned_region_chk'));
  END LOOP;
END $$;

-- ---- regional RLS policies (drop+recreate to be idempotent) --------------
DO $$
DECLARE
  t TEXT;
  _pol TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'legacy_plans',
    'personal_constitution',
    'decision_journal',
    'value_interpretations'
  ] LOOP
    _pol := t || '_region_residency';
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', _pol, t);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I '
      'FOR ALL '
      'USING (current_setting(''app.current_region'', true) = pinned_region '
      '       OR coalesce(current_setting(''app.current_region'', true),'''')='''') '
      'WITH CHECK (current_setting(''app.current_region'', true) = pinned_region '
      '            OR coalesce(current_setting(''app.current_region'', true),'''')='''')',
      _pol, t);
  END LOOP;
END $$;

-- applied via tools/apply_sql.py --commit (own transaction)
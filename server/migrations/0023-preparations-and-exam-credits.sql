
    -- EXAM-S1 — learner preparations, exam-keyed credits and atomic registration provisioning.
    --
    -- ## What a preparation is
    --
    -- One learner preparing for one exam package: (owner, exam). It carries the ACTIVE exam date, a state
    -- (active | archived) and a revision that guards edits. It pins the stable exam identity only — no
    -- blueprint version — so a later blueprint does not orphan a learner's history. At most one ACTIVE
    -- preparation per (owner, exam); archived ones stay readable as history.
    --
    -- ## Credits are keyed (owner, exam), never by preparation
    --
    -- `entitlements` was keyed by owner alone. Its primary key becomes (owner_id, exam_id), and EVERY
    -- existing row is preserved byte-for-byte as the telc row: allowance, used and reserved are untouched,
    -- because before this migration telc Deutsch B1 was the only exam package that existed (0009), so the
    -- single balance was the telc balance by construction. A new preparation never creates or refills a
    -- balance; an absent (owner, exam) balance reads as zero.
    --
    -- `jobs.exam_id` records which balance a job's reservation lives in, so reservation, retry, success
    -- debit, failure release and timeout refund all settle against the ORIGINAL exam. For every job that
    -- predates this migration that is telc — again by construction, not by guessing content — including jobs
    -- whose attempt has no provable exam. The count is reported below.
    --
    -- ## Backfill: provable only
    --
    -- Every existing user gets an active telc preparation. An attempt is bound to it only when its OWN
    -- historical task AND rubric records both resolve to that exam; an attempt without that proof keeps NULL
    -- preparation/exam, stays readable, and is counted. Objective evidence is bound when its own recorded
    -- exam matches the exact (set, version) it answered. Nothing is derived from a global preference alone.
    -- Submitted text, submission snapshots and their immutability trigger are not touched: a submission's
    -- context is derived through its immutable attempt.
    --
    -- Legacy `learner_settings.exam_date` was only regex-validated. The raw value stays where it is (for
    -- audit and export); a preparation receives it only when it is a REAL calendar date, and the disposition
    -- is recorded per preparation (`legacy_exam_date_disposition`). An invalid value never fails the
    -- migration.
    --
    -- ## RLS during the backfill
    --
    -- The migration role owns these tables and FORCE RLS applies to it too, so without help it would see
    -- zero learner rows. Narrow `migration_0023_backfill` policies for the executing role are created and
    -- DROPPED inside this one transaction. Learner isolation is never disabled.
    --
    -- ## Registration
    --
    -- `provision_learner` is a SECURITY DEFINER function with a pinned search_path, no PUBLIC execute and
    -- EXECUTE for the auth role only. It refuses any account not created by the calling transaction, so it
    -- can only run inside registration and cannot be used to grant or refill credits later. It is insert-only:
    -- an existing preparation or balance is left exactly as it is.
    --
    -- FORWARD ONLY. No applied migration is edited.

    -- 1. The preparation ---------------------------------------------------------------------------

    CREATE TABLE IF NOT EXISTS "__SCHEMA__".learner_preparation (
      id                            uuid PRIMARY KEY,
      owner_id                      text NOT NULL REFERENCES "__SCHEMA__"."user"(id),
      exam_id                       text NOT NULL REFERENCES "__SCHEMA__".exam_package(exam_id),
      exam_date                     date,
      state                         text NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'archived')),
      revision                      integer NOT NULL DEFAULT 1 CHECK (revision > 0),
      legacy_exam_date_disposition  text CHECK (legacy_exam_date_disposition IN ('none', 'valid_backfilled', 'invalid_preserved')),
      created_at                    timestamptz NOT NULL DEFAULT now(),
      updated_at                    timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT learner_preparation_identity UNIQUE (id, owner_id, exam_id)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS learner_preparation_one_active
      ON "__SCHEMA__".learner_preparation (owner_id, exam_id) WHERE state = 'active';
    CREATE INDEX IF NOT EXISTS learner_preparation_owner_idx
      ON "__SCHEMA__".learner_preparation (owner_id, created_at);

    -- Exam identity is immutable: a preparation for another exam is another preparation.
    CREATE OR REPLACE FUNCTION "__SCHEMA__".preparation_identity_immutable() RETURNS trigger LANGUAGE plpgsql AS $fn$
    BEGIN
      IF NEW.id <> OLD.id OR NEW.owner_id <> OLD.owner_id OR NEW.exam_id <> OLD.exam_id OR NEW.created_at <> OLD.created_at THEN
        RAISE EXCEPTION 'preparation identity is immutable' USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      RETURN NEW;
    END $fn$;
    DROP TRIGGER IF EXISTS learner_preparation_identity_immutable ON "__SCHEMA__".learner_preparation;
    CREATE TRIGGER learner_preparation_identity_immutable BEFORE UPDATE ON "__SCHEMA__".learner_preparation
      FOR EACH ROW EXECUTE FUNCTION "__SCHEMA__".preparation_identity_immutable();

    ALTER TABLE "__SCHEMA__".learner_preparation ENABLE ROW LEVEL SECURITY;
    ALTER TABLE "__SCHEMA__".learner_preparation FORCE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS owned_learner_preparation ON "__SCHEMA__".learner_preparation;
    CREATE POLICY owned_learner_preparation ON "__SCHEMA__".learner_preparation TO "__LEARNER__"
      USING (owner_id = nullif(current_setting('hatoove.owner_id', true), ''))
      WITH CHECK (owner_id = nullif(current_setting('hatoove.owner_id', true), ''));
    DROP POLICY IF EXISTS deletion_learner_preparation ON "__SCHEMA__".learner_preparation;
    CREATE POLICY deletion_learner_preparation ON "__SCHEMA__".learner_preparation TO "__DELETION__"
      USING (owner_id = nullif(current_setting('hatoove.owner_id', true), ''));

    REVOKE ALL ON "__SCHEMA__".learner_preparation FROM PUBLIC;
    -- The learner may create and edit date/state/revision. Identity columns are not updatable, and there
    -- is no DELETE: archiving is the learner's removal, hard deletion is the deletion role's.
    GRANT SELECT, INSERT ON "__SCHEMA__".learner_preparation TO "__LEARNER__";
    GRANT UPDATE (exam_date, state, revision, updated_at) ON "__SCHEMA__".learner_preparation TO "__LEARNER__";
    GRANT SELECT, DELETE ON "__SCHEMA__".learner_preparation TO "__DELETION__";

    -- 2. Content identity that composite keys can reference ----------------------------------------

    -- Unique constraints are DDL and fire no content_immutable trigger; the content rows are unchanged.
    DO $do$ BEGIN
      ALTER TABLE "__SCHEMA__".task_version ADD CONSTRAINT task_version_exam_identity UNIQUE (task_id, version, exam_id);
    EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL; END $do$;
    DO $do$ BEGIN
      ALTER TABLE "__SCHEMA__".rubric_version ADD CONSTRAINT rubric_version_exam_identity UNIQUE (rubric_id, version, exam_id);
    EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL; END $do$;
    DO $do$ BEGIN
      ALTER TABLE "__SCHEMA__".objective_set ADD CONSTRAINT objective_set_exam_identity UNIQUE (set_id, version, exam_id);
    EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL; END $do$;

    -- 3. Context columns ----------------------------------------------------------------------------

    ALTER TABLE "__SCHEMA__".attempts ADD COLUMN IF NOT EXISTS preparation_id uuid;
    ALTER TABLE "__SCHEMA__".attempts ADD COLUMN IF NOT EXISTS exam_id text;
    ALTER TABLE "__SCHEMA__".item_evidence ADD COLUMN IF NOT EXISTS preparation_id uuid;
    ALTER TABLE "__SCHEMA__".jobs ADD COLUMN IF NOT EXISTS exam_id text;

    -- 4. Exam-keyed balances --------------------------------------------------------------------------

    -- ADD COLUMN with a DEFAULT populates every existing row as DDL; the default is then dropped so a new
    -- balance must name its exam. allowance/used/reserved are not written.
    ALTER TABLE "__SCHEMA__".entitlements ADD COLUMN IF NOT EXISTS exam_id text NOT NULL DEFAULT 'telc-deutsch-b1';
    ALTER TABLE "__SCHEMA__".entitlements ALTER COLUMN exam_id DROP DEFAULT;
    ALTER TABLE "__SCHEMA__".entitlements DROP CONSTRAINT IF EXISTS entitlements_pkey;
    ALTER TABLE "__SCHEMA__".entitlements ADD CONSTRAINT entitlements_pkey PRIMARY KEY (owner_id, exam_id);
    DO $do$ BEGIN
      ALTER TABLE "__SCHEMA__".entitlements ADD CONSTRAINT entitlements_exam_fk
        FOREIGN KEY (exam_id) REFERENCES "__SCHEMA__".exam_package(exam_id);
    EXCEPTION WHEN duplicate_object THEN NULL; END $do$;

    -- 5. Backfill, under transaction-scoped policies for the executing role only ---------------------

    CREATE POLICY migration_0023_backfill ON "__SCHEMA__".learner_preparation TO CURRENT_USER USING (true) WITH CHECK (true);
    CREATE POLICY migration_0023_backfill ON "__SCHEMA__".attempts TO CURRENT_USER USING (true) WITH CHECK (true);
    CREATE POLICY migration_0023_backfill ON "__SCHEMA__".item_evidence TO CURRENT_USER USING (true) WITH CHECK (true);
    CREATE POLICY migration_0023_backfill ON "__SCHEMA__".jobs TO CURRENT_USER USING (true) WITH CHECK (true);
    CREATE POLICY migration_0023_backfill ON "__SCHEMA__".entitlements FOR SELECT TO CURRENT_USER USING (true);
    CREATE POLICY migration_0023_backfill ON "__SCHEMA__".learner_settings FOR SELECT TO CURRENT_USER USING (true);

    -- Every existing account prepares for telc: the only package that has ever existed here.
    INSERT INTO "__SCHEMA__".learner_preparation (id, owner_id, exam_id, state, revision, legacy_exam_date_disposition)
    SELECT gen_random_uuid(), u.id, 'telc-deutsch-b1', 'active', 1, 'none'
      FROM "__SCHEMA__"."user" u
     WHERE NOT EXISTS (SELECT 1 FROM "__SCHEMA__".learner_preparation p
                        WHERE p.owner_id = u.id AND p.exam_id = 'telc-deutsch-b1' AND p.state = 'active');

    -- Legacy dates: a real calendar date is copied; anything else stays only in learner_settings.
    DO $do$
    DECLARE
      r record;
      parsed date;
    BEGIN
      FOR r IN SELECT user_id, exam_date FROM "__SCHEMA__".learner_settings WHERE exam_date <> '' LOOP
        parsed := NULL;
        IF r.exam_date ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN
          BEGIN
            parsed := r.exam_date::date;
            IF to_char(parsed, 'YYYY-MM-DD') <> r.exam_date THEN parsed := NULL; END IF;
          EXCEPTION WHEN others THEN
            parsed := NULL;
          END;
        END IF;
        UPDATE "__SCHEMA__".learner_preparation
           SET exam_date = parsed,
               legacy_exam_date_disposition = CASE WHEN parsed IS NULL THEN 'invalid_preserved' ELSE 'valid_backfilled' END
         WHERE owner_id = r.user_id AND exam_id = 'telc-deutsch-b1' AND state = 'active';
      END LOOP;
    END $do$;

    -- Attempts: bound only when the attempt's own task AND rubric records agree on one exam.
    UPDATE "__SCHEMA__".attempts a
       SET exam_id = t.exam_id, preparation_id = p.id
      FROM "__SCHEMA__".task_version t, "__SCHEMA__".rubric_version r, "__SCHEMA__".learner_preparation p
     WHERE a.preparation_id IS NULL
       AND a.task_id IS NOT NULL AND t.task_id = a.task_id AND t.version = a.task_version
       AND a.rubric_id IS NOT NULL AND r.rubric_id = a.rubric_id AND r.version = a.rubric_version
       AND r.exam_id = t.exam_id
       AND p.owner_id = a.owner_id AND p.exam_id = t.exam_id AND p.state = 'active';

    -- Evidence: its own recorded exam must match the exact set version it answered.
    UPDATE "__SCHEMA__".item_evidence e
       SET preparation_id = p.id
      FROM "__SCHEMA__".objective_set s, "__SCHEMA__".learner_preparation p
     WHERE e.preparation_id IS NULL
       AND s.set_id = e.set_id AND s.version = e.version AND s.exam_id = e.exam_id
       AND p.owner_id = e.owner_id AND p.exam_id = e.exam_id AND p.state = 'active';

    -- Every pre-0023 reservation lives in the single balance that is now the telc row.
    UPDATE "__SCHEMA__".jobs SET exam_id = 'telc-deutsch-b1' WHERE exam_id IS NULL;

    DO $do$
    DECLARE
      n_users bigint; n_preps bigint; n_dates bigint; n_bad_dates bigint;
      n_bound bigint; n_unresolved bigint; n_ev_bound bigint; n_ev_unresolved bigint;
      n_jobs bigint; n_jobs_unresolved bigint; n_balances bigint;
    BEGIN
      SELECT count(*) INTO n_users FROM "__SCHEMA__"."user";
      SELECT count(*) INTO n_preps FROM "__SCHEMA__".learner_preparation;
      SELECT count(*) FILTER (WHERE legacy_exam_date_disposition = 'valid_backfilled'),
             count(*) FILTER (WHERE legacy_exam_date_disposition = 'invalid_preserved')
        INTO n_dates, n_bad_dates FROM "__SCHEMA__".learner_preparation;
      SELECT count(*) FILTER (WHERE preparation_id IS NOT NULL), count(*) FILTER (WHERE preparation_id IS NULL)
        INTO n_bound, n_unresolved FROM "__SCHEMA__".attempts;
      SELECT count(*) FILTER (WHERE preparation_id IS NOT NULL), count(*) FILTER (WHERE preparation_id IS NULL)
        INTO n_ev_bound, n_ev_unresolved FROM "__SCHEMA__".item_evidence;
      SELECT count(*) INTO n_jobs FROM "__SCHEMA__".jobs;
      SELECT count(*) INTO n_jobs_unresolved FROM "__SCHEMA__".jobs j
        JOIN "__SCHEMA__".submissions s ON s.id = j.submission_id
        JOIN "__SCHEMA__".attempts a ON a.id = s.attempt_id
       WHERE a.exam_id IS NULL;
      SELECT count(*) INTO n_balances FROM "__SCHEMA__".entitlements;
      RAISE NOTICE '0023 report: users=% preparations=% exam_dates_backfilled=% exam_dates_invalid_preserved=% attempts_bound=% attempts_unresolved=% evidence_bound=% evidence_unresolved=% jobs_telc_balance=% jobs_on_unresolved_attempts=% balances_preserved_as_telc=%',
        n_users, n_preps, n_dates, n_bad_dates, n_bound, n_unresolved, n_ev_bound, n_ev_unresolved, n_jobs, n_jobs_unresolved, n_balances;
    END $do$;

    DROP POLICY migration_0023_backfill ON "__SCHEMA__".learner_preparation;
    DROP POLICY migration_0023_backfill ON "__SCHEMA__".attempts;
    DROP POLICY migration_0023_backfill ON "__SCHEMA__".item_evidence;
    DROP POLICY migration_0023_backfill ON "__SCHEMA__".jobs;
    DROP POLICY migration_0023_backfill ON "__SCHEMA__".entitlements;
    DROP POLICY migration_0023_backfill ON "__SCHEMA__".learner_settings;

    -- 6. Consistency, enforced by SQL rather than by the API alone ------------------------------------

    ALTER TABLE "__SCHEMA__".jobs ALTER COLUMN exam_id SET NOT NULL;
    DO $do$ BEGIN
      ALTER TABLE "__SCHEMA__".jobs ADD CONSTRAINT jobs_exam_fk FOREIGN KEY (exam_id) REFERENCES "__SCHEMA__".exam_package(exam_id);
    EXCEPTION WHEN duplicate_object THEN NULL; END $do$;

    -- Owner AND exam must match the preparation; the task and rubric must belong to the same exam. MATCH
    -- SIMPLE, so an unresolved legacy row (NULL context) is unaffected; new rows are forced to carry it below.
    DO $do$ BEGIN
      ALTER TABLE "__SCHEMA__".attempts ADD CONSTRAINT attempts_context_pair CHECK ((preparation_id IS NULL) = (exam_id IS NULL));
    EXCEPTION WHEN duplicate_object THEN NULL; END $do$;
    DO $do$ BEGIN
      ALTER TABLE "__SCHEMA__".attempts ADD CONSTRAINT attempts_preparation_fk
        FOREIGN KEY (preparation_id, owner_id, exam_id) REFERENCES "__SCHEMA__".learner_preparation(id, owner_id, exam_id);
    EXCEPTION WHEN duplicate_object THEN NULL; END $do$;
    DO $do$ BEGIN
      ALTER TABLE "__SCHEMA__".attempts ADD CONSTRAINT attempts_task_exam_fk
        FOREIGN KEY (task_id, task_version, exam_id) REFERENCES "__SCHEMA__".task_version(task_id, version, exam_id);
    EXCEPTION WHEN duplicate_object THEN NULL; END $do$;
    DO $do$ BEGIN
      ALTER TABLE "__SCHEMA__".attempts ADD CONSTRAINT attempts_rubric_exam_fk
        FOREIGN KEY (rubric_id, rubric_version, exam_id) REFERENCES "__SCHEMA__".rubric_version(rubric_id, version, exam_id);
    EXCEPTION WHEN duplicate_object THEN NULL; END $do$;
    CREATE INDEX IF NOT EXISTS attempts_owner_preparation_idx ON "__SCHEMA__".attempts (owner_id, preparation_id, created_at DESC);

    DO $do$ BEGIN
      ALTER TABLE "__SCHEMA__".item_evidence ADD CONSTRAINT item_evidence_preparation_fk
        FOREIGN KEY (preparation_id, owner_id, exam_id) REFERENCES "__SCHEMA__".learner_preparation(id, owner_id, exam_id);
    EXCEPTION WHEN duplicate_object THEN NULL; END $do$;
    -- NOT VALID: enforced for every new row; existing evidence is append-only history and is not re-judged.
    DO $do$ BEGIN
      ALTER TABLE "__SCHEMA__".item_evidence ADD CONSTRAINT item_evidence_set_exam_fk
        FOREIGN KEY (set_id, version, exam_id) REFERENCES "__SCHEMA__".objective_set(set_id, version, exam_id) NOT VALID;
    EXCEPTION WHEN duplicate_object THEN NULL; END $do$;
    CREATE INDEX IF NOT EXISTS item_evidence_owner_preparation_idx
      ON "__SCHEMA__".item_evidence (owner_id, preparation_id, section);

    -- New practice needs an ACTIVE preparation. Legacy rows are untouched (INSERT only).
    CREATE OR REPLACE FUNCTION "__SCHEMA__".require_active_preparation() RETURNS trigger LANGUAGE plpgsql AS $fn$
    BEGIN
      IF NEW.preparation_id IS NULL THEN
        RAISE EXCEPTION 'preparation_required' USING ERRCODE = 'check_violation';
      END IF;
      IF NOT EXISTS (SELECT 1 FROM learner_preparation p
                      WHERE p.id = NEW.preparation_id AND p.owner_id = NEW.owner_id AND p.state = 'active') THEN
        RAISE EXCEPTION 'preparation_inactive' USING ERRCODE = 'check_violation';
      END IF;
      RETURN NEW;
    END $fn$;
    ALTER FUNCTION "__SCHEMA__".require_active_preparation() SET search_path = "__SCHEMA__", pg_temp;
    DROP TRIGGER IF EXISTS attempts_require_active_preparation ON "__SCHEMA__".attempts;
    CREATE TRIGGER attempts_require_active_preparation BEFORE INSERT ON "__SCHEMA__".attempts
      FOR EACH ROW EXECUTE FUNCTION "__SCHEMA__".require_active_preparation();
    DROP TRIGGER IF EXISTS item_evidence_require_active_preparation ON "__SCHEMA__".item_evidence;
    CREATE TRIGGER item_evidence_require_active_preparation BEFORE INSERT ON "__SCHEMA__".item_evidence
      FOR EACH ROW EXECUTE FUNCTION "__SCHEMA__".require_active_preparation();

    -- A new job reserves against its attempt's exam, and only that.
    CREATE OR REPLACE FUNCTION "__SCHEMA__".job_exam_matches_attempt() RETURNS trigger LANGUAGE plpgsql AS $fn$
    DECLARE
      attempt_exam text;
    BEGIN
      SELECT a.exam_id INTO attempt_exam
        FROM submissions s JOIN attempts a ON a.id = s.attempt_id
       WHERE s.id = NEW.submission_id;
      IF attempt_exam IS NULL OR NEW.exam_id IS DISTINCT FROM attempt_exam THEN
        RAISE EXCEPTION 'job_exam_mismatch' USING ERRCODE = 'check_violation';
      END IF;
      RETURN NEW;
    END $fn$;
    ALTER FUNCTION "__SCHEMA__".job_exam_matches_attempt() SET search_path = "__SCHEMA__", pg_temp;
    DROP TRIGGER IF EXISTS jobs_exam_matches_attempt ON "__SCHEMA__".jobs;
    CREATE TRIGGER jobs_exam_matches_attempt BEFORE INSERT ON "__SCHEMA__".jobs
      FOR EACH ROW EXECUTE FUNCTION "__SCHEMA__".job_exam_matches_attempt();

    REVOKE ALL ON FUNCTION "__SCHEMA__".preparation_identity_immutable() FROM PUBLIC;
    REVOKE ALL ON FUNCTION "__SCHEMA__".require_active_preparation() FROM PUBLIC;
    REVOKE ALL ON FUNCTION "__SCHEMA__".job_exam_matches_attempt() FROM PUBLIC;

    -- 7. Registration provisioning ---------------------------------------------------------------------

    -- Effective only inside provision_learner, which sets both settings transaction-locally.
    DROP POLICY IF EXISTS provision_learner_preparation ON "__SCHEMA__".learner_preparation;
    CREATE POLICY provision_learner_preparation ON "__SCHEMA__".learner_preparation TO CURRENT_USER
      USING (owner_id = nullif(current_setting('hatoove.owner_id', true), '') AND current_setting('hatoove.provisioning', true) = 'on')
      WITH CHECK (owner_id = nullif(current_setting('hatoove.owner_id', true), '') AND current_setting('hatoove.provisioning', true) = 'on');
    DROP POLICY IF EXISTS provision_entitlements ON "__SCHEMA__".entitlements;
    CREATE POLICY provision_entitlements ON "__SCHEMA__".entitlements TO CURRENT_USER
      USING (owner_id = nullif(current_setting('hatoove.owner_id', true), '') AND current_setting('hatoove.provisioning', true) = 'on')
      WITH CHECK (owner_id = nullif(current_setting('hatoove.owner_id', true), '') AND current_setting('hatoove.provisioning', true) = 'on');

    CREATE OR REPLACE FUNCTION "__SCHEMA__".provision_learner(p_owner text, p_exam_id text, p_allowance integer)
    RETURNS uuid
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = "__SCHEMA__", pg_temp
    AS $fn$
    DECLARE
      prep uuid;
    BEGIN
      IF p_allowance IS NOT NULL AND (p_allowance < 0 OR p_allowance > 10000) THEN
        RAISE EXCEPTION 'invalid_allowance' USING ERRCODE = 'check_violation';
      END IF;
      -- Registration only: the account row must have been written by THIS transaction.
      IF NOT EXISTS (SELECT 1 FROM "user" u
                      WHERE u.id = p_owner AND u.xmin::text = (txid_current() % 4294967296)::text) THEN
        RAISE EXCEPTION 'provisioning_requires_new_account' USING ERRCODE = 'insufficient_privilege';
      END IF;
      PERFORM set_config('hatoove.owner_id', p_owner, true);
      PERFORM set_config('hatoove.provisioning', 'on', true);
      INSERT INTO learner_preparation (id, owner_id, exam_id, state, revision)
      VALUES (gen_random_uuid(), p_owner, p_exam_id, 'active', 1)
      ON CONFLICT DO NOTHING;
      -- Insert-only: an existing balance is never refilled.
      IF p_allowance IS NOT NULL THEN
        INSERT INTO entitlements (owner_id, exam_id, allowance) VALUES (p_owner, p_exam_id, p_allowance)
        ON CONFLICT (owner_id, exam_id) DO NOTHING;
      END IF;
      SELECT p.id INTO prep FROM learner_preparation p
       WHERE p.owner_id = p_owner AND p.exam_id = p_exam_id AND p.state = 'active';
      PERFORM set_config('hatoove.provisioning', '', true);
      RETURN prep;
    END $fn$;

    REVOKE ALL ON FUNCTION "__SCHEMA__".provision_learner(text, text, integer) FROM PUBLIC;
    GRANT EXECUTE ON FUNCTION "__SCHEMA__".provision_learner(text, text, integer) TO "__AUTH__";

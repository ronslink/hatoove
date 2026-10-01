
    -- PILOT-04 — exam-scoped content identity.
    --
    -- WHY. `content_version`, `rubric_version` and `task_version` had no exam column at all, and
    -- their primary keys are global. Adding a second exam would therefore have meant either a
    -- migration of learner data or two exams colliding on a slug like `writing.formative@v1`. This
    -- migration is the seam that makes the second exam ADDITIVE, before any of it is built.
    --
    -- THE BACKFILL IS DELIBERATELY NOT AN UPDATE. `content_version` carries a BEFORE UPDATE
    -- immutability trigger (`content_immutable`), so `UPDATE ... SET exam_id = ...` is REFUSED --
    -- the table is append-only by design and this migration must not fight that. The column instead
    -- arrives NOT NULL with a DEFAULT, which populates existing rows as DDL, fires no row trigger,
    -- and is then dropped so a future insert must name its exam explicitly rather than inheriting
    -- one by accident. Verified by applying this file on a disposable database.
    --
    -- WHAT IS NOT HERE. `level` and `exam_language` are properties of the PACKAGE, not of every
    -- task, rubric and content row, so they live on `exam_package` and are joined. Denormalising
    -- them onto three content tables would create three copies of one fact that can disagree --
    -- and "do not store unnecessary data" is a standing instruction, not a preference.
    --
    -- FORWARD ONLY. No DROP, no rewrite of applied history, no change to any existing column.

    CREATE TABLE IF NOT EXISTS "__SCHEMA__".exam_package (
      exam_id           text PRIMARY KEY,
      exam              text NOT NULL,
      level             text NOT NULL,
      exam_language     text NOT NULL,
      blueprint_version text NOT NULL,
      created_at        timestamptz NOT NULL DEFAULT now()
    );

    -- The first package. `blueprint_version` names the dated record of task types, item counts,
    -- timing, keys, weights and thresholds that the practice is built from; it is not a claim that
    -- a human has approved the content (E-01 stays open).
    INSERT INTO "__SCHEMA__".exam_package (exam_id, exam, level, exam_language, blueprint_version)
    VALUES ('telc-deutsch-b1', 'telc Deutsch B1', 'B1', 'de', 'telc-b1-written-draft@2026-10-01')
    ON CONFLICT (exam_id) DO NOTHING;

    ALTER TABLE "__SCHEMA__".content_version ADD COLUMN IF NOT EXISTS exam_id text NOT NULL DEFAULT 'telc-deutsch-b1';
    ALTER TABLE "__SCHEMA__".rubric_version  ADD COLUMN IF NOT EXISTS exam_id text NOT NULL DEFAULT 'telc-deutsch-b1';
    ALTER TABLE "__SCHEMA__".task_version    ADD COLUMN IF NOT EXISTS exam_id text NOT NULL DEFAULT 'telc-deutsch-b1';

    ALTER TABLE "__SCHEMA__".content_version ALTER COLUMN exam_id DROP DEFAULT;
    ALTER TABLE "__SCHEMA__".rubric_version  ALTER COLUMN exam_id DROP DEFAULT;
    ALTER TABLE "__SCHEMA__".task_version    ALTER COLUMN exam_id DROP DEFAULT;

    DO $do$
    BEGIN
      ALTER TABLE "__SCHEMA__".content_version ADD CONSTRAINT content_version_exam_fk
        FOREIGN KEY (exam_id) REFERENCES "__SCHEMA__".exam_package(exam_id);
    EXCEPTION WHEN duplicate_object THEN NULL;
    END $do$;
    DO $do$
    BEGIN
      ALTER TABLE "__SCHEMA__".rubric_version ADD CONSTRAINT rubric_version_exam_fk
        FOREIGN KEY (exam_id) REFERENCES "__SCHEMA__".exam_package(exam_id);
    EXCEPTION WHEN duplicate_object THEN NULL;
    END $do$;
    DO $do$
    BEGIN
      ALTER TABLE "__SCHEMA__".task_version ADD CONSTRAINT task_version_exam_fk
        FOREIGN KEY (exam_id) REFERENCES "__SCHEMA__".exam_package(exam_id);
    EXCEPTION WHEN duplicate_object THEN NULL;
    END $do$;

    -- An index per table: every learner-facing task query filters by exam first.
    CREATE INDEX IF NOT EXISTS content_version_exam_idx ON "__SCHEMA__".content_version (exam_id);
    CREATE INDEX IF NOT EXISTS rubric_version_exam_idx  ON "__SCHEMA__".rubric_version (exam_id);
    CREATE INDEX IF NOT EXISTS task_version_exam_idx    ON "__SCHEMA__".task_version (exam_id);

    -- Shared content is readable by the learner and worker roles; the package is reference data and
    -- is readable by both. Nothing here is writable at runtime, exactly as for 0006.
    REVOKE ALL ON "__SCHEMA__".exam_package FROM PUBLIC;
    GRANT SELECT ON "__SCHEMA__".exam_package TO __LEARNER__, __WORKER__;

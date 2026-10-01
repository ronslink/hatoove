/**
 * The DDL shared by the two things that can be a world (OWNAPI-02 / OWNAPI-03).
 *
 * `bootstrap.mjs` builds a **disposable fixture** (random schema, random roles, dropped on
 * cleanup) and `provision.mjs` builds a **durable installation** (fixed schema and roles,
 * recorded migrations, never dropped). They must not drift: a checker that runs against the
 * fixture has to be running against the same schema and the same least-privilege grants an
 * installation has, or the check proves nothing about the installation.
 *
 * These two builders are the parts that used to exist only in `provision.mjs` (as inline
 * migration SQL) and only in `tools/deletion-check.mjs` (hand-written grants). One source,
 * two callers.
 */

import {
  WRITING_FAMILY, WRITING_RUBRIC, WRITING_TASKS, contentVersionRows,
} from './content-seed.mjs';

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;

const ident = (name) => {
  if (!IDENTIFIER.test(name)) throw new Error(`Unsafe identifier: ${String(name)}`);
  return `"${name}"`;
};

/** Single-quoted SQL literal for seeded text. These values are trusted constants, but escape
 *  anyway so a future edit to a prompt cannot break (or inject into) the migration. */
const lit = (value) => `'${String(value).replaceAll("'", "''")}'`;
const jsonLit = (value) => `${lit(JSON.stringify(value))}::jsonb`;

/** The verified owner of the current transaction, or '' when none was pinned. */
const OWNER = "nullif(current_setting('hatoove.owner_id', true), '')";

/**
 * Migration `0004-account-settings`: the account-settings table, its FORCE RLS and its
 * owner policy, plus the learner role's rights to it. Idempotent on its own, because an
 * installation created before the table existed must be able to adopt just this one.
 */
export function accountSettingsSql({ schema, roles }) {
  const s = ident(schema);
  return `
    CREATE TABLE IF NOT EXISTS ${s}.learner_settings (
      user_id     text PRIMARY KEY REFERENCES ${s}."user"(id) ON DELETE CASCADE,
      exam_date   text NOT NULL DEFAULT '',
      daily_goal  integer NOT NULL DEFAULT 20,
      model       text NOT NULL DEFAULT 'deepseek-chat',
      theme       text NOT NULL DEFAULT 'system',
      language    text NOT NULL DEFAULT '',
      revision    integer NOT NULL DEFAULT 0,
      updated_at  timestamptz NOT NULL DEFAULT now()
    );
    ALTER TABLE ${s}.learner_settings ENABLE ROW LEVEL SECURITY;
    ALTER TABLE ${s}.learner_settings FORCE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS learner_settings_owner ON ${s}.learner_settings;
    CREATE POLICY learner_settings_owner ON ${s}.learner_settings
      USING (user_id = ${OWNER})
      WITH CHECK (user_id = ${OWNER});
    REVOKE ALL ON ${s}.learner_settings FROM PUBLIC;
    GRANT SELECT, INSERT, UPDATE ON ${s}.learner_settings TO ${ident(roles.learner)};
  `;
}

/**
 * Migration `0005-account-deletion`: the least privilege the hard-deletion port needs, and
 * the owner-scoped policies that keep it to one account's rows.
 *
 * The role itself is created by the provisioner (`NOSUPERUSER … NOBYPASSRLS`), never here:
 * a migration runs as the schema owner, which cannot `CREATE ROLE`. This only grants.
 *
 * Why this belongs in the repository and not in a checker: before this migration the only
 * role with these rights was one `tools/deletion-check.mjs` invented for itself, so
 * `HARD-DELETE-01.md:70` criterion 1 was not demonstrated for any installation that exists.
 *
 * The `drafts` table carries no owner column: it is owned through `attempts`. Its policy
 * therefore admits two ways to see a row — the attempt still exists and is the owner's, or
 * the attempt id was pinned for this transaction (the deletion captures the account's attempt
 * ids before it deletes them, so its own pre-COMMIT read-back can still see a draft it left).
 */
/**
 * Migration `0006-content-and-catalogue`: the writing task family as versioned shared content
 * records, plus the columns that let an attempt bind an exact task and rubric version.
 *
 * Three record types, exactly as the dispatch asks for:
 *   - `task_version`   the task/prompt record: stable `task_id` + a `version`, the prompt
 *                      (`situation`), the `leitpunkte`, the addressee and the register;
 *   - `rubric_version` its rubric (`criteria`, `max_total`);
 *   - `content_version` the **content-version record carrying rights/review status**, one row
 *                      per versioned artefact, with a sha256 of the payload and its source
 *                      path. Every task/rubric row points at one.
 *
 * All three are IMMUTABLE: a `BEFORE UPDATE OR DELETE` trigger refuses any change, so a version
 * is a durable claim. A correction is a NEW version (a new row), never an edit.
 *
 * EXISTING ROWS: this migration does NOT touch one row of `attempts` or `submissions`. It only
 * ADDS two nullable columns (`task_id`, `rubric_id`) and two composite foreign keys. PostgreSQL
 * foreign keys default to `MATCH SIMPLE`, so a row whose `task_id` is NULL is not checked at
 * all — which is exactly what an already-stored attempt needs. An old attempt therefore keeps
 * its literal `task_version = 'synthetic-writing-v1'` / `rubric_version = 'formative-fixture-v1'`
 * and stays readable; the migration never rewrites it into a claim about content that was never
 * reviewed. New attempts written by the datastore bind real versions (`content-seed.mjs`), and
 * those ARE checked by the foreign keys.
 *
 * No RLS: these are shared reference rows, not learner rows — they carry no owner and are the
 * same for every account. The learner and worker roles get SELECT.
 */
export function contentCatalogueSql({ schema, roles }) {
  const s = ident(schema);
  const contentRows = contentVersionRows()
    .map((row) => `    (${lit(row.contentVersionId)}, ${lit(row.kind)}, ${lit(row.family)}, `
      + `${lit(row.sourcePath)}, ${lit(row.reviewStatus)}, ${lit(row.rightsStatus)}, ${lit(row.sha256)})`)
    .join(',\n');
  const rubricRows = [
    `    (${lit(WRITING_RUBRIC.rubricId)}, ${lit(WRITING_RUBRIC.version)}, ${lit(WRITING_FAMILY)}, `
    + `${jsonLit(WRITING_RUBRIC.criteria)}, `
    + `${WRITING_RUBRIC.criteria.reduce((sum, c) => sum + c.max, 0)}, `
    + `${lit(`${WRITING_RUBRIC.rubricId}@${WRITING_RUBRIC.version}`)})`,
  ].join(',\n');
  const taskRows = WRITING_TASKS
    .map((task) => `    (${lit(task.taskId)}, ${lit(task.version)}, ${lit(WRITING_FAMILY)}, ${lit(task.register)}, `
      + `${lit(task.topic)}, ${lit(task.situation)}, ${lit(task.adressat)}, ${jsonLit(task.leitpunkte)}, `
      + `${lit(WRITING_RUBRIC.rubricId)}, ${lit(WRITING_RUBRIC.version)}, ${lit(`${task.taskId}@${task.version}`)})`)
    .join(',\n');
  return `
    CREATE TABLE IF NOT EXISTS ${s}.content_version (
      content_version_id text PRIMARY KEY,
      kind             text NOT NULL,
      family           text NOT NULL,
      source_path      text NOT NULL,
      review_status    text NOT NULL,
      rights_status    text NOT NULL,
      content_sha256   text NOT NULL,
      created_at       timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS ${s}.rubric_version (
      rubric_id          text NOT NULL,
      version            text NOT NULL,
      family             text NOT NULL,
      criteria           jsonb NOT NULL,
      max_total          integer NOT NULL,
      content_version_id text NOT NULL REFERENCES ${s}.content_version(content_version_id),
      created_at         timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (rubric_id, version)
    );
    CREATE TABLE IF NOT EXISTS ${s}.task_version (
      task_id            text NOT NULL,
      version            text NOT NULL,
      family             text NOT NULL,
      register           text NOT NULL,
      topic              text NOT NULL,
      situation          text NOT NULL,
      adressat           text NOT NULL,
      leitpunkte         jsonb NOT NULL,
      rubric_id          text NOT NULL,
      rubric_version     text NOT NULL,
      content_version_id text NOT NULL REFERENCES ${s}.content_version(content_version_id),
      created_at         timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (task_id, version),
      FOREIGN KEY (rubric_id, rubric_version) REFERENCES ${s}.rubric_version(rubric_id, version)
    );

    -- Forward-only binding on the EXISTING tables. Nullable, MATCH SIMPLE, so stored rows keep
    -- their literal synthetic versions and are never rewritten.
    ALTER TABLE ${s}.attempts ADD COLUMN IF NOT EXISTS task_id text;
    ALTER TABLE ${s}.attempts ADD COLUMN IF NOT EXISTS rubric_id text;
    DO $do$
    BEGIN
      ALTER TABLE ${s}.attempts ADD CONSTRAINT attempts_task_version_fk
        FOREIGN KEY (task_id, task_version) REFERENCES ${s}.task_version(task_id, version);
    EXCEPTION WHEN duplicate_object THEN NULL;
    END $do$;
    DO $do$
    BEGIN
      ALTER TABLE ${s}.attempts ADD CONSTRAINT attempts_rubric_version_fk
        FOREIGN KEY (rubric_id, rubric_version) REFERENCES ${s}.rubric_version(rubric_id, version);
    EXCEPTION WHEN duplicate_object THEN NULL;
    END $do$;

    -- Seed the six writing prompts and the one rubric. Idempotent: re-running changes nothing.
    INSERT INTO ${s}.content_version
      (content_version_id, kind, family, source_path, review_status, rights_status, content_sha256)
    VALUES
${contentRows}
    ON CONFLICT (content_version_id) DO NOTHING;
    INSERT INTO ${s}.rubric_version
      (rubric_id, version, family, criteria, max_total, content_version_id)
    VALUES
${rubricRows}
    ON CONFLICT (rubric_id, version) DO NOTHING;
    INSERT INTO ${s}.task_version
      (task_id, version, family, register, topic, situation, adressat, leitpunkte,
       rubric_id, rubric_version, content_version_id)
    VALUES
${taskRows}
    ON CONFLICT (task_id, version) DO NOTHING;

    -- Immutability. A versioned shared record is append-only: a correction is a new version.
    CREATE OR REPLACE FUNCTION ${s}.content_immutable() RETURNS trigger LANGUAGE plpgsql AS $fn$
    BEGIN
      RAISE EXCEPTION 'content records are immutable (%.%); create a new version instead',
        TG_TABLE_SCHEMA, TG_TABLE_NAME USING ERRCODE = 'integrity_constraint_violation';
    END $fn$;
    DROP TRIGGER IF EXISTS content_version_immutable ON ${s}.content_version;
    CREATE TRIGGER content_version_immutable BEFORE UPDATE OR DELETE ON ${s}.content_version
      FOR EACH ROW EXECUTE FUNCTION ${s}.content_immutable();
    DROP TRIGGER IF EXISTS rubric_version_immutable ON ${s}.rubric_version;
    CREATE TRIGGER rubric_version_immutable BEFORE UPDATE OR DELETE ON ${s}.rubric_version
      FOR EACH ROW EXECUTE FUNCTION ${s}.content_immutable();
    DROP TRIGGER IF EXISTS task_version_immutable ON ${s}.task_version;
    CREATE TRIGGER task_version_immutable BEFORE UPDATE OR DELETE ON ${s}.task_version
      FOR EACH ROW EXECUTE FUNCTION ${s}.content_immutable();

    REVOKE ALL ON ${s}.content_version, ${s}.rubric_version, ${s}.task_version FROM PUBLIC;
    GRANT SELECT ON ${s}.content_version, ${s}.rubric_version, ${s}.task_version
      TO ${ident(roles.learner)}, ${ident(roles.worker)};
  `;
}

export function deletionRoleSql({ schema, roles }) {
  const s = ident(schema);
  const role = ident(roles.deletion);
  return `
    GRANT USAGE ON SCHEMA ${s} TO ${role};
    GRANT SELECT, DELETE ON
      ${s}."user", ${s}.session, ${s}.account,
      ${s}.attempts, ${s}.drafts, ${s}.submissions, ${s}.jobs,
      ${s}.assessments, ${s}.usage_ledger, ${s}.entitlements, ${s}.learner_settings
      TO ${role};
    GRANT UPDATE(parent_submission_id) ON ${s}.attempts TO ${role};
    -- FOR UPDATE on entitlements (the lock the deletion and the writer paths both take first)
    -- needs UPDATE on at least one column; the deletion never changes the row.
    GRANT UPDATE(reserved) ON ${s}.entitlements TO ${role};
    -- FOR UPDATE on "user" (the transaction's first statement) needs UPDATE on at least one
    -- column; the deletion never changes a "user" column.
    GRANT UPDATE("updatedAt") ON ${s}."user" TO ${role};

    -- Owner-scoped policies for the FORCE-RLS owned tables. "user", session and account carry
    -- no RLS, so the grants above are the whole boundary there and no policy is possible.
    CREATE POLICY deletion_attempts ON ${s}.attempts TO ${role}
      USING (owner_id = ${OWNER});
    CREATE POLICY deletion_submissions ON ${s}.submissions TO ${role}
      USING (owner_id = ${OWNER});
    CREATE POLICY deletion_jobs ON ${s}.jobs TO ${role}
      USING (owner_id = ${OWNER});
    CREATE POLICY deletion_assessments ON ${s}.assessments TO ${role}
      USING (owner_id = ${OWNER});
    CREATE POLICY deletion_usage ON ${s}.usage_ledger TO ${role}
      USING (owner_id = ${OWNER});
    CREATE POLICY deletion_entitlements ON ${s}.entitlements TO ${role}
      USING (owner_id = ${OWNER});
    CREATE POLICY deletion_learner_settings ON ${s}.learner_settings TO ${role}
      USING (user_id = ${OWNER});
    CREATE POLICY deletion_drafts ON ${s}.drafts TO ${role} USING (
      EXISTS (SELECT 1 FROM ${s}.attempts a WHERE a.id = attempt_id AND a.owner_id = ${OWNER})
      OR attempt_id = ANY(
        string_to_array(nullif(current_setting('hatoove.deleting_attempts', true), ''), ',')::uuid[])
    );
  `;
}

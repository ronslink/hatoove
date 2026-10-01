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

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;

const ident = (name) => {
  if (!IDENTIFIER.test(name)) throw new Error(`Unsafe identifier: ${String(name)}`);
  return `"${name}"`;
};

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

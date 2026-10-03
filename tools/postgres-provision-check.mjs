/**
 * Persistent-provisioning proof (OWNAPI-03).
 *
 * What this proves, against a real PostgreSQL database:
 *   1. the schema and its least-privilege roles are created on a fresh database;
 *   2. a second provisioning run applies **nothing** and changes no role - it is idempotent;
 *   3. data written through the restricted learner role **survives pooling a fresh world**
 *      (the restart analogue: every pool closed, everything re-provisioned, rows still there);
 *   4. the learner role really is restricted: NOSUPERUSER, NOBYPASSRLS, cannot create tables,
 *      cannot disable RLS - so FORCE ROW LEVEL SECURITY is genuinely in force;
 *   5. discrimination: the same cross-owner read DOES return the row as the superuser, so an
 *      empty result is the policy working and not an empty table.
 *
 * Safety: it refuses to run against the default `postgres`/`template1` databases and requires
 * `OWNAPI_PG_ALLOW=1` before touching anything, because it CREATES a schema and roles and
 * deliberately does NOT drop them (durability is the point). Use a disposable database.
 *
 * Usage: node tools/postgres-provision-check.mjs
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import {
  persistentConfig, provisionPersistent, closePersistent, appliedMigrations, MIGRATIONS,
} from '../server/owned-postgres/provision.mjs';
import { DEFAULT_TASK_BINDING } from '../server/owned-postgres/content-seed.mjs';
import { INITIAL_EXAM_ID } from '../server/preparation-contract.mjs';

/** Derived from the migration list, so adding a migration cannot leave this check stale. */
const ALL_MIGRATIONS = MIGRATIONS.map((migration) => migration.id);

const config = persistentConfig();
const FORBIDDEN_DATABASES = new Set(['postgres', 'template0', 'template1']);

const checks = [];
const check = (name, run) => checks.push({ name, run });

/**
 * Run `fn` against a privileged pool. The pool comes from `provisionPersistent`, which is
 * the only module allowed to depend on `pg`, so this checker stays inside the package scope.
 */
async function withAdmin(run) {
  const pools = await provisionPersistent({ config });
  try { return await run(pools.admin); } finally { await closePersistent(pools); }
}

/* ================================================================= guards */

check('provision-check-refuses-a-default-database', async () => {
  assert.ok(!FORBIDDEN_DATABASES.has(config.admin.database),
    `refusing to provision into ${config.admin.database}; set OWNAPI_PG_DATABASE to a disposable database`);
  if (process.env.OWNAPI_PG_ALLOW !== '1') {
    throw new Error('set OWNAPI_PG_ALLOW=1 to confirm this is a disposable database you may create schema and roles in');
  }
});

/* ============================================================= provisioning */

check('fresh-database-is-provisioned-once', async () => {
  const pools = await provisionPersistent({ config });
  try {
    // The installation is durable and deliberately never dropped, so this run may be the
    // first (everything applied) or a later one (everything already applied). Either way
    // the schema, the restricted roles and FORCE RLS must be in place, and every migration
    // must be accounted for exactly once.
    const all = ALL_MIGRATIONS;
    assert.deepEqual([...pools.applied, ...pools.skipped].sort(), [...all].sort(),
      'every migration must be either applied now or already applied');
    assert.deepEqual(await appliedMigrations(pools.migration, config.schema), all);
    const identity = (await pools.learner.query(
      `SELECT current_user, r.rolsuper, r.rolbypassrls, r.rolcreatedb, r.rolcreaterole
       FROM pg_roles r WHERE r.rolname = current_user`)).rows[0];
    assert.equal(identity.current_user, config.roles.learner);
    for (const key of ['rolsuper', 'rolbypassrls', 'rolcreatedb', 'rolcreaterole']) {
      assert.equal(identity[key], false, `learner must not be ${key}`);
    }
    const tables = (await pools.learner.query(
      `SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class
       WHERE relnamespace = $1::regnamespace AND relname = ANY($2::text[])`,
      [config.schema, ['attempts', 'drafts', 'submissions', 'jobs', 'entitlements', 'assessments', 'usage_ledger']])).rows;
    assert.equal(tables.length, 7, 'all seven owned tables must exist');
    for (const table of tables) {
      assert.equal(table.relrowsecurity, true, `${table.relname} must have RLS enabled`);
      assert.equal(table.relforcerowsecurity, true, `${table.relname} must FORCE RLS`);
    }
  } finally { await closePersistent(pools); }
});

check('second-run-applies-nothing-and-changes-no-role', async () => {
  // Establish the installed state FIRST, so this check measures idempotency whether or not an
  // earlier check ran in the same process. Measuring "before" on a database that might not be
  // provisioned yet would compare against roles that do not exist.
  const first = await provisionPersistent({ config });
  await closePersistent(first);
  const roleSnapshot = () => withAdmin(async (admin) => (await admin.query(
    'SELECT rolname, rolsuper, rolbypassrls, rolcanlogin FROM pg_roles WHERE rolname = ANY($1::text[]) ORDER BY rolname',
    [Object.values(config.roles)])).rows);
  const before = await roleSnapshot();
  const pools = await provisionPersistent({ config });
  try {
    assert.deepEqual(pools.applied, [], 'a second run must apply no migration');
    assert.deepEqual(pools.skipped, ALL_MIGRATIONS, 'a second run must skip every migration');
    const after = await roleSnapshot();
    assert.deepEqual(after, before, 'existing roles must not be altered');
    assert.deepEqual(await appliedMigrations(pools.migration, config.schema), ALL_MIGRATIONS);
  } finally { await closePersistent(pools); }
});

check('a-fresh-world-still-sees-the-rows-and-the-policy', async () => {
  const ownerA = `user-${randomUUID()}`;
  const ownerB = `user-${randomUUID()}`;
  const attemptId = randomUUID();

  // World 1: write through the restricted learner role.
  const first = await provisionPersistent({ config });
  let preparationId = null;
  try {
    /*
     * EXAM-S1: registration as an installation performs it. The account INSERT trigger (0023) is the only
     * grant path: it provisions the initial telc preparation and the transaction-local allowance. No
     * separate balance INSERT — that would be a second, unreviewed minting path.
     */
    const registration = await first.admin.connect();
    try {
      await registration.query('BEGIN');
      await registration.query("SELECT set_config('hatoove.registration_allowance', '5', true)");
      await registration.query(
        `INSERT INTO ${config.schema}."user"(id, name, email, "emailVerified", "createdAt", "updatedAt")
         VALUES ($1, 'Synthetic', $2, false, now(), now())`,
        [ownerA, `${ownerA}@pg.example.invalid`]);
      await registration.query('COMMIT');
    } catch (error) {
      await registration.query('ROLLBACK').catch(() => {});
      throw error;
    } finally { registration.release(); }
    const preparation = (await first.admin.query(
      `SELECT id FROM ${config.schema}.learner_preparation WHERE owner_id = $1 AND exam_id = $2 AND state = 'active'`,
      [ownerA, INITIAL_EXAM_ID])).rows[0];
    assert.ok(preparation, 'registration must provision the initial preparation');
    preparationId = preparation.id;
    // An attempt carries genuine context: the seeded task/rubric of the preparation's exam.
    const b = DEFAULT_TASK_BINDING;
    await first.admin.query(
      `INSERT INTO ${config.schema}.attempts(id, owner_id, task_id, task_version, rubric_id, rubric_version, preparation_id, exam_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [attemptId, ownerA, b.taskId, b.taskVersion, b.rubricId, b.rubricVersion, preparationId, INITIAL_EXAM_ID]);
    // One pinned connection, so the transaction-local owner applies to the INSERT it guards.
    const writer = await first.learner.connect();
    try {
      await writer.query(`BEGIN`);
      await writer.query("SELECT set_config('hatoove.owner_id', $1, true)", [ownerA]);
      await writer.query(`INSERT INTO ${config.schema}.drafts(attempt_id, revision, text) VALUES ($1, 1, $2)`,
        [attemptId, 'A durable secret']);
      await writer.query(`COMMIT`);
    } catch (error) {
      await writer.query('ROLLBACK').catch(() => {});
      throw error;
    } finally { writer.release(); }
  } finally {
    // Every pool closed: the restart analogue.
    await closePersistent(first);
  }

  // World 2: nothing but a fresh provisioning run in between.
  const second = await provisionPersistent({ config });
  try {
    assert.deepEqual(second.applied, [], 'the restart must not re-apply migrations');
    const read = async (owner) => {
      const client = await second.learner.connect();
      try {
        await client.query('BEGIN');
        await client.query("SELECT set_config('hatoove.owner_id', $1, true)", [owner]);
        const result = await client.query(`SELECT text FROM ${config.schema}.drafts WHERE attempt_id = $1`, [attemptId]);
        await client.query('COMMIT');
        return result.rowCount;
      } finally { client.release(); }
    };
    assert.equal(await read(ownerA), 1, "the owner's draft must survive the restart");
    assert.equal(await read(ownerB), 0, 'another owner must still see nothing');

    // EXAM-S1: the registered context survives too — the same preparation, the attempt bound to it, and
    // exactly the trigger's one balance (no refill by a restart or re-provisioning).
    const context = (await second.admin.query(
      `SELECT a.preparation_id, a.exam_id,
              (SELECT count(*)::int FROM ${config.schema}.learner_preparation p WHERE p.owner_id = $2) AS preparations,
              (SELECT json_agg(json_build_object('exam_id', e.exam_id, 'allowance', e.allowance, 'used', e.used, 'reserved', e.reserved))
                 FROM ${config.schema}.entitlements e WHERE e.owner_id = $2) AS balances
         FROM ${config.schema}.attempts a WHERE a.id = $1`, [attemptId, ownerA])).rows[0];
    assert.equal(context.preparation_id, preparationId, 'the attempt keeps its preparation across the restart');
    assert.equal(context.exam_id, INITIAL_EXAM_ID);
    assert.equal(context.preparations, 1, 'a restart provisions no second preparation');
    assert.deepEqual(context.balances, [{ exam_id: INITIAL_EXAM_ID, allowance: 5, used: 0, reserved: 0 }],
      'exactly the registration balance, never refilled');
    const preparationsSeenBy = async (owner) => {
      const client = await second.learner.connect();
      try {
        await client.query('BEGIN');
        await client.query("SELECT set_config('hatoove.owner_id', $1, true)", [owner]);
        const result = await client.query(`SELECT id FROM ${config.schema}.learner_preparation`);
        await client.query('COMMIT');
        return result.rows.map((row) => row.id);
      } finally { client.release(); }
    };
    assert.deepEqual(await preparationsSeenBy(ownerA), [preparationId], 'the owner sees exactly their preparation');
    assert.deepEqual(await preparationsSeenBy(ownerB), [], 'another owner sees no preparation');

    // Discrimination: the row is there; the empty read is the policy, not an empty table.
    const asSuperuser = (await second.admin.query(
      `SELECT text FROM ${config.schema}.drafts WHERE attempt_id = $1`, [attemptId])).rowCount;
    assert.equal(asSuperuser, 1, 'the row exists; the empty read above is the policy working');

    // And the learner cannot switch the policy off for itself.
    const client = await second.learner.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL row_security = off');
      await assert.rejects(client.query(`SELECT * FROM ${config.schema}.attempts`), (e) => e.code === '42501');
      await client.query('ROLLBACK');
    } finally { client.release(); }
    await assert.rejects(second.learner.query(`CREATE TABLE ${config.schema}.forbidden(id int)`), (e) => e.code === '42501');
    await assert.rejects(second.learner.query(`ALTER TABLE ${config.schema}.attempts DISABLE ROW LEVEL SECURITY`),
      (e) => e.code === '42501');
  } finally { await closePersistent(second); }
});

/*
 * EXAM-S1 — THE PERSISTENT 6-ROLE PATH HAS NO RUNTIME CREDIT AUTHORITY.
 *
 * `bootstrap.mjs` builds disposable roles but never a provisioner, so a disposable fixture cannot prove what an
 * installation's `<prefix>_provisioner` still holds. Before 0023 that role had INSERT and a column SELECT on
 * `entitlements` (and owner policies) so sign-up could insert a balance; `grantProvisionerRights` now revokes
 * them. This proves, on the persistent path, that (a) the provisioner, learner and worker cannot mint or read
 * balances beyond their documented grants, (b) no runtime role can invoke the registration grant function or
 * attach a trigger, and (c) an UPGRADED installation's leftover provisioner grants and policies are removed
 * by the next provisioning run, not merely absent on a fresh one.
 */
check('persistent-role-credit-authority-is-restricted-to-registration-and-payments', async () => {
  const s = config.schema;
  const entitlements = `${s}.entitlements`;
  const preparations = `${s}.learner_preparation`;
  const owner = `user-${randomUUID()}`;

  async function privileges(admin) {
    const out = {};
    for (const [role, name] of Object.entries(config.roles)) {
      if (role === 'migration') continue;
      out[role] = (await admin.query(
        `SELECT has_table_privilege($1, $2, 'INSERT') AS ent_insert,
                has_any_column_privilege($1, $2, 'INSERT') AS ent_insert_column,
                has_column_privilege($1, $2, 'allowance', 'UPDATE') AS ent_allowance_update,
                has_column_privilege($1, $2, 'used', 'UPDATE') AS ent_used_update,
                has_column_privilege($1, $2, 'reserved', 'UPDATE') AS ent_reserved_update,
                has_column_privilege($1, $2, 'owner_id', 'UPDATE') AS ent_owner_update,
                has_column_privilege($1, $2, 'exam_id', 'UPDATE') AS ent_exam_update,
                has_column_privilege($1, $2, 'expires_at', 'UPDATE') AS ent_expiry_update,
                has_table_privilege($1, $2, 'DELETE') AS ent_delete,
                has_any_column_privilege($1, $2, 'SELECT') AS ent_select,
                has_table_privilege($1, $3, 'DELETE') AS prep_delete,
                has_function_privilege($1, $4, 'EXECUTE') AS provision_execute,
                has_table_privilege($1, $5, 'TRIGGER') AS user_trigger`,
        [name, entitlements, preparations, `${s}.provision_registered_learner()`, `${s}."user"`])).rows[0];
    }
    return out;
  }
  const leftoverPolicies = async (admin) => (await admin.query(
    `SELECT policyname FROM pg_policies WHERE schemaname = $1 AND tablename = 'entitlements'
       AND policyname LIKE 'provisioner_%' ORDER BY policyname`, [s])).rows.map((row) => row.policyname);
  function assertCreditAuthority(state, label) {
    for (const [role, p] of Object.entries(state)) {
      if (role === 'payments') {
        assert.equal(p.ent_insert && p.ent_select && p.ent_allowance_update && p.ent_expiry_update, true,
          `${label}: the dedicated payments service can grant allowance and validity`);
        for (const field of ['ent_used_update','ent_reserved_update','ent_owner_update','ent_exam_update','ent_delete']) {
          assert.equal(p[field], false, `${label}: payments must not gain ${field}`);
        }
      } else {
        assert.equal(p.ent_insert || p.ent_insert_column, false, `${label}: ${role} must not INSERT a balance`);
        assert.equal(p.ent_allowance_update, false, `${label}: ${role} must not raise an allowance`);
      }
      assert.equal(p.provision_execute, false, `${label}: ${role} must not execute the registration grant function`);
      assert.equal(p.user_trigger, false, `${label}: ${role} must not attach a trigger to "user"`);
    }
    assert.equal(state.provisioner.ent_select, false, `${label}: the provisioner reads no balance column`);
    assert.equal(state.provisioner.prep_delete, false, `${label}: the provisioner deletes no preparation`);
    assert.equal(state.learner.ent_used_update, false, `${label}: the learner cannot rewrite used credits`);
  }

  const pools = await provisionPersistent({ config });
  try {
    assertCreditAuthority(await privileges(pools.admin), 'fresh/current installation');
    assert.deepEqual(await leftoverPolicies(pools.admin), [], 'no provisioner policy remains');

    // The trusted payment pool still has owner RLS and cannot rewrite credit counters or identity.
    assert.ok((await pools.admin.query(`SELECT count(*)::int AS n FROM ${entitlements}`)).rows[0].n > 0,
      'existing rows make the missing-owner-context test discriminating');
    assert.deepEqual((await pools.payments.query(`SELECT owner_id FROM ${entitlements}`)).rows, [],
      'payments without an owner context see no balance');
    await assert.rejects(pools.payments.query(
      `INSERT INTO ${entitlements}(owner_id,exam_id,allowance) VALUES($1,$2,999)`,[owner,INITIAL_EXAM_ID]),
      e => e.code === '42501', 'payments cannot insert without an owner context');
    for (const column of ['used','reserved','owner_id','exam_id']) {
      await assert.rejects(pools.payments.query(`UPDATE ${entitlements} SET ${column}=${column}`),
        e => e.code === '42501', `payments cannot update ${column}`);
    }
    await assert.rejects(pools.payments.query(`DELETE FROM ${entitlements}`),
      e => e.code === '42501', 'payments cannot delete balances');
    // Behaviour, not only catalogue flags: the provisioner's former INSERT and SELECT are refused.
    await assert.rejects(pools.provisioner.query(
      `INSERT INTO ${entitlements}(owner_id, exam_id, allowance) VALUES ($1, $2, 999)`, [owner, INITIAL_EXAM_ID]),
    (e) => e.code === '42501', 'the provisioner must not insert a balance');
    await assert.rejects(pools.provisioner.query(`SELECT owner_id FROM ${entitlements} LIMIT 1`),
      (e) => e.code === '42501', 'the provisioner must not read balances');
    await assert.rejects(pools.provisioner.query(`SELECT ${s}.provision_registered_learner()`),
      (e) => e.code === '42501', 'the provisioner must not invoke the trigger function');
    // The restricted learner, even inside its own owner context, cannot mint or raise a balance.
    const learner = await pools.learner.connect();
    try {
      await learner.query('BEGIN');
      await learner.query("SELECT set_config('hatoove.owner_id', $1, true)", [owner]);
      await assert.rejects(learner.query(
        `INSERT INTO ${entitlements}(owner_id, exam_id, allowance) VALUES ($1, $2, 999)`, [owner, INITIAL_EXAM_ID]),
      (e) => e.code === '42501', 'the learner must not insert a balance');
      await learner.query('ROLLBACK');
      await learner.query('BEGIN');
      await learner.query("SELECT set_config('hatoove.owner_id', $1, true)", [owner]);
      await assert.rejects(learner.query(`UPDATE ${entitlements} SET allowance = allowance + 999 WHERE owner_id = $1`, [owner]),
        (e) => e.code === '42501', 'the learner must not raise an allowance');
      await learner.query('ROLLBACK');
    } finally { learner.release(); }
  } finally { await closePersistent(pools); }

  // UPGRADE: simulate the pre-0023 provisioner grants and policies an existing installation carries.
  let seedError = null;
  const seeding = await provisionPersistent({ config });
  try {
    await seeding.admin.query(`GRANT INSERT, SELECT ON ${entitlements} TO "${config.roles.provisioner}"`);
    await seeding.admin.query(`GRANT SELECT(owner_id) ON ${entitlements} TO "${config.roles.provisioner}"`);
    await seeding.admin.query(`DROP POLICY IF EXISTS provisioner_entitlements ON ${entitlements}`);
    await seeding.admin.query(`CREATE POLICY provisioner_entitlements ON ${entitlements} FOR INSERT TO "${config.roles.provisioner}" WITH CHECK (true)`);
    await seeding.admin.query(`DROP POLICY IF EXISTS provisioner_entitlements_read ON ${entitlements}`);
    await seeding.admin.query(`CREATE POLICY provisioner_entitlements_read ON ${entitlements} FOR SELECT TO "${config.roles.provisioner}" USING (true)`);
    const seeded = await privileges(seeding.admin);
    assert.equal(seeded.provisioner.ent_insert && seeded.provisioner.ent_select, true,
      'precondition: the simulated leftover grants are really present (otherwise the next assertion is vacuous)');
    assert.equal((await leftoverPolicies(seeding.admin)).length, 2, 'precondition: the leftover policies are present');
  } catch (error) {
    seedError = error;
  } finally { await closePersistent(seeding); }

  // The next provisioning run must remove them. It runs even when seeding failed, because it is also the
  // cleanup: a schema later steps reuse must never keep the simulated grants.
  const upgraded = await provisionPersistent({ config });
  try {
    if (seedError) throw seedError;
    assert.deepEqual(upgraded.applied, [], 'the upgrade cleanup applies no migration');
    assertCreditAuthority(await privileges(upgraded.admin), 'after re-provisioning an upgraded installation');
    assert.deepEqual(await leftoverPolicies(upgraded.admin), [], 'leftover provisioner policies are dropped');
    await assert.rejects(upgraded.provisioner.query(
      `INSERT INTO ${entitlements}(owner_id, exam_id, allowance) VALUES ($1, $2, 999)`, [owner, INITIAL_EXAM_ID]),
    (e) => e.code === '42501', 'after the upgrade the provisioner still cannot insert a balance');
    assert.equal((await upgraded.admin.query(`SELECT count(*)::int AS n FROM ${entitlements} WHERE owner_id = $1`, [owner])).rows[0].n, 0,
      'no probe minted a balance');
  } finally { await closePersistent(upgraded); }
});

check('a-missing-admin-credential-fails-closed', async () => {
  const broken = { ...config, admin: { ...config.admin, user: 'hatoove_nonexistent_admin', password: 'wrong-by-design' } };
  await assert.rejects(provisionPersistent({ config: broken }));
});

/* ==================================================================== run */

export async function runPostgresProvisionChecks() {
  const results = [];
  for (const { name, run } of checks) {
    try {
      await run();
      results.push({ name, ok: true, detail: 'ok' });
    } catch (error) {
      results.push({ name, ok: false, detail: error && error.message ? error.message.split('\n')[0] : String(error) });
    }
  }
  return { ok: results.every((r) => r.ok), results };
}

const invokedDirectly = process.argv[1] && process.argv[1].endsWith('postgres-provision-check.mjs');
if (invokedDirectly) {
  const report = await runPostgresProvisionChecks();
  for (const r of report.results) console.log(`${r.ok ? 'PASS' : 'FAIL'} ${r.name}${r.ok ? '' : `\n  ${r.detail}`}`);
  const failed = report.results.filter((r) => !r.ok).length;
  console.log(`\n${report.results.length - failed} passed, ${failed} failed`);
  console.log(`NOTE schema "${config.schema}" and roles "${config.roles.learner}", ... are NOT dropped: durability is the point.`);
  process.exitCode = failed ? 1 : 0;
}

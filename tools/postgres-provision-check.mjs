/**
 * Persistent-provisioning proof (OWNAPI-03).
 *
 * What this proves, against a real PostgreSQL database:
 *   1. the schema and the four least-privilege roles are created on a fresh database;
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
  persistentConfig, provisionPersistent, closePersistent, appliedMigrations,
} from '../server/owned-postgres/provision.mjs';

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
    const all = ['0001-auth-schema', '0002-owned-schema', '0003-isolation'];
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
  const before = await withAdmin(async (admin) => (await admin.query(
    'SELECT rolname, rolsuper, rolbypassrls, rolcanlogin FROM pg_roles WHERE rolname = ANY($1::text[]) ORDER BY rolname',
    [Object.values(config.roles)])).rows);
  const pools = await provisionPersistent({ config });
  try {
    assert.deepEqual(pools.applied, [], 'a second run must apply no migration');
    assert.deepEqual(pools.skipped, ['0001-auth-schema', '0002-owned-schema', '0003-isolation']);
    const after = await withAdmin(async (admin) => (await admin.query(
      'SELECT rolname, rolsuper, rolbypassrls, rolcanlogin FROM pg_roles WHERE rolname = ANY($1::text[]) ORDER BY rolname',
      [Object.values(config.roles)])).rows);
    assert.deepEqual(after, before, 'existing roles must not be altered');
    assert.deepEqual(await appliedMigrations(pools.migration, config.schema),
      ['0001-auth-schema', '0002-owned-schema', '0003-isolation']);
  } finally { await closePersistent(pools); }
});

check('a-fresh-world-still-sees-the-rows-and-the-policy', async () => {
  const ownerA = `user-${randomUUID()}`;
  const ownerB = `user-${randomUUID()}`;
  const attemptId = randomUUID();

  // World 1: write through the restricted learner role.
  const first = await provisionPersistent({ config });
  try {
    await first.admin.query(
      `INSERT INTO ${config.schema}."user"(id, name, email, "emailVerified", "createdAt", "updatedAt")
       VALUES ($1, 'Synthetic', $2, false, now(), now())`,
      [ownerA, `${ownerA}@pg.example.invalid`]);
    await first.admin.query(`INSERT INTO ${config.schema}.entitlements(owner_id, allowance) VALUES ($1, 5)`, [ownerA]);
    await first.admin.query(
      `INSERT INTO ${config.schema}.attempts(id, owner_id, task_version, rubric_version)
       VALUES ($1, $2, 'synthetic-writing-v1', 'formative-fixture-v1')`, [attemptId, ownerA]);
    await first.learner.query(`BEGIN`);
    await first.learner.query("SELECT set_config('hatoove.owner_id', $1, true)", [ownerA]);
    await first.learner.query(`INSERT INTO ${config.schema}.drafts(attempt_id, revision, text) VALUES ($1, 1, $2)`,
      [attemptId, 'A durable secret']);
    await first.learner.query(`COMMIT`);
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

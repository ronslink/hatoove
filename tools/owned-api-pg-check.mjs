/**
 * PostgreSQL ownership + row-level-security proof for the shipped owned API
 * (OWNAPI-02).
 *
 * This is the API-layer evidence the in-memory suite cannot carry. It drives the
 * REAL public/js/owned-client.js through server/owned-api.mjs over the REAL
 * PostgreSQL adapter (server/owned-postgres) as the restricted learner role:
 *
 *   1. two accounts are seeded through the API (sign-up endpoint);
 *   2. every owned route is attempted cross-owner and must answer the same 404
 *      as a record that does not exist, leaking nothing and changing no row;
 *   3. the learner connection really is a restricted, non-superuser,
 *      non-BYPASSRLS role, FORCE RLS is on the owned tables, and a direct
 *      cross-owner SELECT under that role returns no rows;
 *   4. discrimination: the same cross-owner query DOES return the row as the
 *      superuser and with RLS disabled, then the policy is restored — so the
 *      empty result is the policy working, not an empty table;
 *   5. a datastore failure answers 500, never a 2xx.
 *
 * Requires the package `server/owned-postgres` installed (pg 8.23.1) and a
 * disposable database. See server/owned-postgres/README.md for OWNAPI_PG_* and a
 * one-line container. Synthetic records only.
 *
 * Usage: node tools/owned-api-pg-check.mjs   (exit 0 when every check passes)
 */

import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

import { createOwnedApi } from '../server/owned-api.mjs';
import { createOwnedClient, OwnedClientError } from '../public/js/owned-client.js';
import { createFixture } from '../server/owned-postgres/bootstrap.mjs';
import { createPostgresDatastore } from '../server/owned-postgres/adapter.mjs';
import { createPostgresSessions } from '../server/owned-postgres/sessions.mjs';
import { DEFAULT_TASK_BINDING } from '../server/owned-postgres/content-seed.mjs';

const ATTEMPT_ABSENT = '0f0f0f0f-0000-4000-8000-000000000000';
const SUBMISSION_ABSENT = '0e0e0e0e-0000-4000-8000-000000000000';

/* ------------------------------------------------------------ tiny browser */

function applySetCookie(jar, header) {
  if (!header) return;
  for (const line of Array.isArray(header) ? header : [header]) {
    const [pair, ...attrs] = line.split(';');
    const eq = pair.indexOf('=');
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    if (attrs.some((a) => /^\s*max-age=0\s*$/i.test(a)) || value === '') jar.delete(name);
    else jar.set(name, value);
  }
}

function browser(api) {
  const jar = new Map();
  const exchange = async ({ method, path: url, headers = {}, body }) => {
    const sent = { ...headers };
    if (jar.size) sent.cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
    const response = await api.handle({ method, path: url, headers: sent, body, originChecked: true });
    applySetCookie(jar, response.headers['set-cookie']);
    return response;
  };
  const fetchImpl = async (url, init = {}) => {
    const response = await exchange({ method: init.method || 'GET', path: url, headers: init.headers, body: init.body });
    return { status: response.status, text: async () => response.body };
  };
  const raw = async (method, url, body) => {
    const response = await exchange({
      method, path: url,
      body: typeof body === 'string' || body === undefined ? body : JSON.stringify(body),
      headers: { accept: 'application/json', ...(method === 'GET' ? {} : { 'content-type': 'application/json' }) },
    });
    return { status: response.status, json: JSON.parse(response.body), text: response.body };
  };
  return { jar, client: createOwnedClient({ fetchImpl }), raw };
}

async function expectClientError(promise, code, status) {
  let error;
  try { await promise; } catch (e) { error = e; }
  assert.ok(error instanceof OwnedClientError, `expected OwnedClientError ${code}, got ${error ? error.stack || error : 'success'}`);
  assert.equal(error.code, code, `expected ${code}, got ${error.code}`);
  if (status !== undefined) assert.equal(error.status, status);
  return error;
}

// Resolve the preparation genuinely created by registration; never infer or provision one in the test client.
async function registeredPreparation(who) {
  const response = await who.raw('GET', '/api/v1/preparations');
  assert.equal(response.status, 200, response.text);
  const active = response.json.preparations.filter((p) => p.exam_id === 'telc-deutsch-b1' && p.state === 'active');
  assert.equal(active.length, 1, 'registration supplies exactly one active telc preparation');
  assert.match(active[0].id, /^[0-9a-f-]{36}$/);
  return active[0];
}

async function registeredAttempt(who) {
  const preparation = await registeredPreparation(who);
  return who.client.createAttempt({ preparationId: preparation.id, ...DEFAULT_TASK_BINDING });
}

/* -------------------------------------------------------------- context */

async function buildContext() {
  const fixture = await createFixture();
  const port = createPostgresDatastore({ pool: fixture.learner });
  const sessions = createPostgresSessions({ pool: fixture.auth, adminPool: fixture.admin, allowance: 5 });
  const api = createOwnedApi({ datastore: port, sessions });
  return { fixture, port, sessions, api };
}

const checks = [];
const check = (name, run) => checks.push({ name, run });

/* ================================================================= checks */

check('pg-two-accounts-are-seeded-through-the-api', async () => {
  const ctx = await buildContext();
  try {
    const a = browser(ctx.api);
    const b = browser(ctx.api);
    const accountA = await a.client.signUp({ name: 'A', email: 'a@pg.example.invalid', password: 'pw-a-synthetic' });
    const accountB = await b.client.signUp({ name: 'B', email: 'b@pg.example.invalid', password: 'pw-b-synthetic' });
    assert.match(accountA.id, /^user-[0-9a-f-]{36}$/, 'the API returns a real account id');
    assert.notEqual(accountA.id, accountB.id);
    // The accounts exist as real rows in the pinned-library auth table.
    const rows = await ctx.fixture.admin.query('SELECT id, email FROM "user" WHERE id = ANY($1::text[]) ORDER BY email', [[accountA.id, accountB.id]]);
    assert.equal(rows.rowCount, 2);
    assert.deepEqual(rows.rows.map((r) => r.email), ['a@pg.example.invalid', 'b@pg.example.invalid']);
    // ...and both are genuinely usable.
    const attempt = await registeredAttempt(a);
    assert.equal((await a.client.readAttempt(attempt.id)).owner_id, accountA.id);
  } finally { await ctx.fixture.cleanup(); }
});

check('pg-cross-owner-404-on-every-owned-route-leaks-nothing', async () => {
  const ctx = await buildContext();
  try {
    const a = browser(ctx.api);
    const b = browser(ctx.api);
    await a.client.signUp({ name: 'A', email: 'a@pg.example.invalid', password: 'pw-a-synthetic' });
    await b.client.signUp({ name: 'B', email: 'b@pg.example.invalid', password: 'pw-b-synthetic' });
    const attempt = await registeredAttempt(a);
    const draft = await a.client.saveDraft(attempt.id, { expectedRevision: 1, text: 'A private draft' });
    const receipt = await a.client.submit(attempt.id, { expectedRevision: draft.revision, eventId: randomUUID() });
    const openB = await registeredAttempt(b);
    await b.client.saveDraft(openB.id, { expectedRevision: 1, text: 'B private draft' });
    const schema = ctx.fixture.schema;
    const counts = async () => {
      const q = async (t) => (await ctx.fixture.admin.query(`SELECT count(*)::int AS n FROM ${t}`)).rows[0].n;
      return { attempts: await q('attempts'), drafts: await q('drafts'), submissions: await q('submissions'), jobs: await q('jobs') };
    };
    const before = await counts();

    const routes = [
      ['read', () => b.client.readAttempt(attempt.id), () => b.client.readAttempt(ATTEMPT_ABSENT)],
      ['save', () => b.client.saveDraft(attempt.id, { expectedRevision: 2, text: 'B overwrite' }),
        () => b.client.saveDraft(ATTEMPT_ABSENT, { expectedRevision: 2, text: 'x' })],
      ['submit', () => b.client.submit(attempt.id, { expectedRevision: 2, eventId: randomUUID() }),
        () => b.client.submit(ATTEMPT_ABSENT, { expectedRevision: 2, eventId: randomUUID() })],
      ['result', () => b.client.readResult(receipt.submissionId), () => b.client.readResult(SUBMISSION_ABSENT)],
      ['retry', () => b.client.retry(receipt.submissionId), () => b.client.retry(SUBMISSION_ABSENT)],
      ['delete', () => b.client.deleteAttempt(attempt.id), () => b.client.deleteAttempt(ATTEMPT_ABSENT)],
      ['parent', () => b.client.createAttempt({ parentSubmissionId: receipt.submissionId }),
        () => b.client.createAttempt({ parentSubmissionId: SUBMISSION_ABSENT })],
    ];
    for (const [label, foreign, absent] of routes) {
      const e1 = await expectClientError(foreign(), 'not_found', 404);
      const e2 = await expectClientError(absent(), 'not_found', 404);
      assert.equal(e1.detail, e2.detail, `${label}: another owner's record must look exactly like an absent one`);
      assert.equal(e1.detail, 'not_found');
    }
    // The raw envelope carries only the sanitized token, never a row or SQL.
    const raw = await b.raw('GET', `/api/v1/attempts/${attempt.id}`);
    assert.deepEqual(raw.json, { error: 'not_found' });
    // Nothing changed, and A still owns everything.
    assert.deepEqual(await counts(), before, 'B changed no row that belongs to A');
    assert.equal((await a.client.readAttempt(attempt.id)).text, 'A private draft');
    assert.equal((await a.client.readResult(receipt.submissionId)).submission.id, receipt.submissionId);
    // The learner role can see nothing outside its own scope, even with SQL.
    const client = await ctx.fixture.learner.connect();
    try {
      await client.query('BEGIN');
      const me = await ctx.fixture.auth.query('SELECT id FROM "user" WHERE email = $1', ['b@pg.example.invalid']);
      await client.query("SELECT set_config('hatoove.owner_id', $1, true)", [me.rows[0].id]);
      for (const [table, column, value] of [
        ['attempts', 'id', attempt.id], ['drafts', 'attempt_id', attempt.id], ['submissions', 'id', receipt.submissionId],
      ]) {
        const seen = await client.query(`SELECT * FROM ${table} WHERE ${column} = $1`, [value]);
        assert.equal(seen.rowCount, 0, `${schema}.${table} leaked a cross-owner row`);
      }
    } finally { await client.query('ROLLBACK'); client.release(); }
  } finally { await ctx.fixture.cleanup(); }
});

check('pg-learner-runs-as-a-restricted-role-with-forced-rls', async () => {
  const ctx = await buildContext();
  const { fixture } = ctx;
  try {
    const identity = (await fixture.learner.query(
      `SELECT current_user, session_user, r.rolsuper, r.rolbypassrls, r.rolcreatedb, r.rolcreaterole
       FROM pg_roles r WHERE r.rolname = current_user`)).rows[0];
    assert.equal(identity.current_user, fixture.roles.learner);
    assert.equal(identity.session_user, fixture.roles.learner);
    for (const key of ['rolsuper', 'rolbypassrls', 'rolcreatedb', 'rolcreaterole']) {
      assert.equal(identity[key], false, `learner must not be ${key}`);
    }
    const denied = (promise) => assert.rejects(promise, (e) => e.code === '42501');
    await denied(fixture.learner.query('CREATE TABLE forbidden(id int)'));
    await denied(fixture.learner.query('ALTER TABLE attempts DISABLE ROW LEVEL SECURITY'));
    await denied(fixture.learner.query(`SET ROLE ${fixture.roles.migration}`));
    const tables = (await fixture.admin.query(
      `SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class
       WHERE relnamespace = $1::regnamespace AND relname = ANY($2::text[])`,
      [fixture.schema, ['attempts', 'drafts', 'submissions', 'jobs', 'entitlements', 'assessments', 'usage_ledger']])).rows;
    assert.equal(tables.length, 7);
    for (const table of tables) {
      assert.equal(table.relrowsecurity, true, `${table.relname} must have RLS enabled`);
      assert.equal(table.relforcerowsecurity, true, `${table.relname} must FORCE RLS`);
    }
  } finally { await fixture.cleanup(); }
});

check('pg-rls-discrimination-superuser-and-disabled-policy', async () => {
  const scratch = await createFixture();
  try {
    const { learner, admin } = scratch;
    const port = createPostgresDatastore({ pool: learner });
    const sessions = createPostgresSessions({ pool: scratch.auth, adminPool: admin, allowance: 5 });
    const api = createOwnedApi({ datastore: port, sessions });
    const a = browser(api);
    const b = browser(api);
    const ownerA = (await a.client.signUp({ name: 'A', email: 'rls-a@pg.example.invalid', password: 'pw-rls-synthetic' })).id;
    const ownerB = (await b.client.signUp({ name: 'B', email: 'rls-b@pg.example.invalid', password: 'pw-rls-synthetic' })).id;
    const attemptId = (await registeredAttempt(a)).id;
    await a.client.saveDraft(attemptId, { expectedRevision: 1, text: 'A secret' });
    assert.equal((await a.client.readAttempt(attemptId)).owner_id, ownerA);

    const crossOwner = async (client, owner) => {
      await client.query('BEGIN');
      await client.query("SELECT set_config('hatoove.owner_id', $1, true)", [owner]);
      const seen = (await client.query('SELECT * FROM attempts WHERE id = $1', [attemptId])).rowCount;
      await client.query('ROLLBACK');
      return seen;
    };

    // Baseline: the policy hides A's row from B.
    assert.equal(await crossOwner(learner, ownerB), 0, 'learner as B must not see A: RLS would be void otherwise');
    // Discrimination 1: the same row, same query, as the superuser.
    const asSuperuser = (await admin.query('SELECT * FROM attempts WHERE id = $1', [attemptId])).rowCount;
    assert.equal(asSuperuser, 1, 'the row exists; the empty read is the policy, not an empty table');
    // Discrimination 2: disable the policy on a scratch copy -> the SAME restricted
    // role now sees it. That is what makes the passing test meaningful.
    await admin.query('ALTER TABLE attempts DISABLE ROW LEVEL SECURITY');
    try {
      assert.equal(await crossOwner(learner, ownerB), 1, 'with RLS disabled a test like this would pass while proving nothing');
    } finally {
      // Restore even if the deliberate mutant fails, then prove the restore below.
      await admin.query('ALTER TABLE attempts ENABLE ROW LEVEL SECURITY');
      await admin.query('ALTER TABLE attempts FORCE ROW LEVEL SECURITY');
    }
    assert.equal(await crossOwner(learner, ownerB), 0, 'policy restored: cross-owner read is empty again');
    assert.equal((await admin.query('SELECT * FROM attempts WHERE id = $1', [attemptId])).rowCount, 1, 'the owner row is intact');
    // A learner cannot switch the policy off for itself: the session setting is
    // accepted, but the next read fails closed.
    const client = await learner.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL row_security = off');
      await assert.rejects(client.query('SELECT * FROM attempts'), (e) => e.code === '42501');
      await client.query('ROLLBACK');
    } finally { client.release(); }
  } finally { await scratch.cleanup(); }
});

check('pg-datastore-failure-is-500-never-success', async () => {
  const ctx = await buildContext();
  try {
    const a = browser(ctx.api);
    await a.client.signUp({ name: 'A', email: 'a@pg.example.invalid', password: 'pw-a-synthetic' });
    const attempt = await registeredAttempt(a);
    // Break the learner pool only; the session still verifies.
    await ctx.fixture.learner.end();
    const res = await a.raw('GET', `/api/v1/attempts/${attempt.id}`);
    assert.equal(res.status, 500, 'a database failure must not be reported as success');
    assert.deepEqual(res.json, { error: 'internal_error' });
    await expectClientError(a.client.readAttempt(attempt.id), 'server_error', 500);
  } finally { await ctx.fixture.cleanup(); }
});

/* ===================================== content records (SAAS-MODEL-01 Step 1) */

/**
 * A versioned shared content record is immutable. The passing test is only evidence if the
 * same UPDATE succeeds when the trigger is off - otherwise the assertion could pass against a
 * table nobody can write for some unrelated reason (a missing privilege, a typo). The
 * discrimination runs inside a transaction that is rolled back, so the fixture is untouched.
 */
check('pg-content-records-are-immutable-with-discrimination', async () => {
  const ctx = await buildContext();
  const { admin, schema } = ctx.fixture;
  try {
    /*
     * THE EXACT IDENTITY IS (task_id, version), the table's primary key. Re-binding an immutable catalogue
     * means NEW rows (0017 added v2 beside v1), so `WHERE task_id = $1` alone now matches two rows: the
     * positive control saw rowCount 2 and failed, and `rows[0]` read whichever row came back first. Every
     * statement below names one version, and the precondition proves the task really has several, so a
     * reversion to task_id-only matching fails here rather than passing by luck.
     */
    const taskId = 'writing.du.besuch-einer-freundin';
    const version = 'v1';
    const where = 'task_id = $1 AND version = $2';
    const key = [taskId, version];
    const versions = (await admin.query(`SELECT version FROM ${schema}.task_version WHERE task_id = $1 ORDER BY version`, [taskId])).rows.map((r) => r.version);
    assert.ok(versions.length >= 2 && versions.includes(version), `precondition: ${taskId} has several versions including ${version}, got ${JSON.stringify(versions)}`);
    const snapshot = async (q = admin) => (await q.query(`SELECT version, situation FROM ${schema}.task_version WHERE task_id = $1 ORDER BY version`, [taskId])).rows;
    const before = await snapshot();

    // 1. The real assertion: an update attempt must fail.
    await assert.rejects(
      admin.query(`UPDATE ${schema}.task_version SET situation = 'tampered' WHERE ${where}`, key),
      (e) => e.code === '23000' || /immutable/.test(e.message),
      'updating an immutable task version must fail',
    );
    await assert.rejects(
      admin.query(`DELETE FROM ${schema}.task_version WHERE ${where}`, key),
      (e) => e.code === '23000' || /immutable/.test(e.message),
      'deleting an immutable task version must fail',
    );
    assert.deepEqual(await snapshot(), before, 'the refused update changed nothing, in any version');

    // 2. Discrimination: with the trigger off, the SAME statement succeeds on EXACTLY the one row it
    //    names, and no sibling version moves. One client, so BEGIN/ALTER/UPDATE/ROLLBACK run on one
    //    connection.
    const client = await admin.connect();
    try {
      await client.query('BEGIN');
      await client.query(`ALTER TABLE ${schema}.task_version DISABLE TRIGGER task_version_immutable`);
      const changed = await client.query(`UPDATE ${schema}.task_version SET situation = 'tampered' WHERE ${where}`, key);
      assert.equal(changed.rowCount, 1, 'with the trigger disabled the update must succeed on exactly one row, or this check is vacuous');
      const during = await snapshot(client);
      assert.deepEqual(during.filter((r) => r.situation === 'tampered').map((r) => r.version), [version], 'only the named version was written');
      assert.deepEqual(during.filter((r) => r.version !== version), before.filter((r) => r.version !== version), 'sibling versions are untouched');
      await client.query('ROLLBACK');
    } finally { client.release(); }

    // 3. Rolled back: the trigger and the rows are exactly as they were.
    await assert.rejects(
      admin.query(`UPDATE ${schema}.task_version SET situation = 'tampered' WHERE ${where}`, key),
      /immutable/, 'the trigger must be back after the rollback',
    );
    assert.deepEqual(await snapshot(), before);
  } finally { await ctx.fixture.cleanup(); }
});

/**
 * Rights/review status must round-trip truthfully. C-01 measured the corpus as unreviewed with
 * unknown rights, so the seeded rows say exactly that - and the immutability trigger means a
 * later UI CANNOT silently flip them to "reviewed".
 */
check('pg-rights-and-review-status-round-trip-truthfully', async () => {
  const ctx = await buildContext();
  const { admin, schema } = ctx.fixture;
  try {
    const id = 'writing.du.besuch-einer-freundin@v1';
    const read = async () => (await admin.query(`SELECT review_status, rights_status FROM ${schema}.content_version WHERE content_version_id = $1`, [id])).rows[0];
    assert.deepEqual(await read(), { review_status: 'unreviewed', rights_status: 'unknown' });
    // The upgrade a UI would need is refused, and the value is still truthful afterwards.
    await assert.rejects(
      admin.query(`UPDATE ${schema}.content_version SET review_status = 'reviewed' WHERE content_version_id = $1`, [id]),
      /immutable/,
    );
    assert.equal((await read()).review_status, 'unreviewed', 'review status must not be silently upgraded');
  } finally { await ctx.fixture.cleanup(); }
});

/**
 * An attempt's binding is a real, CHECKED reference: an unknown task version cannot be stored.
 * Together with the shared binding check this makes the version column a claim about content
 * that exists, not a free-text string.
 */
check('pg-an-attempt-cannot-bind-content-that-does-not-exist', async () => {
  const ctx = await buildContext();
  const { admin, schema } = ctx.fixture;
  try {
    const a = browser(ctx.api);
    const owner = (await a.client.signUp({ name: 'FK', email: 'fk@pg.example.invalid', password: 'pw-fk-synthetic' })).id;
    const preparation = await registeredPreparation(a);
    // Keep the preparation, owner, exam and rubric valid so ONLY the task-version FK can fail.
    const insert = `INSERT INTO ${schema}.attempts(id, owner_id, preparation_id, exam_id, task_id, task_version, rubric_id, rubric_version)
                    VALUES($1, $2, $3, $4, $5, $6, $7, $8)`;
    const values = (taskId, taskVersion) => [randomUUID(), owner, preparation.id, preparation.exam_id,
      taskId, taskVersion, DEFAULT_TASK_BINDING.rubricId, DEFAULT_TASK_BINDING.rubricVersion];
    await assert.rejects(
      admin.query(insert, values('writing.no.such.task', 'v9')),
      (e) => e.code === '23503' && e.constraint === 'attempts_task_version_fk',
      'a missing task version must fail its specific FK, not an unrelated context constraint',
    );
    // Positive control: the same fully scoped INSERT with the real task identity succeeds.
    const ok = await admin.query(insert, values(DEFAULT_TASK_BINDING.taskId, DEFAULT_TASK_BINDING.taskVersion));
    assert.equal(ok.rowCount, 1);
  } finally { await ctx.fixture.cleanup(); }
});

/**
 * No per-account DDL: adding learners creates ROWS, never a schema, table or role. This is the
 * cheap, strong check for the property the plan states. It is measured on the real schema the
 * learner paths run against.
 */
check('pg-creating-learners-adds-no-table-and-no-role', async () => {
  const ctx = await buildContext();
  const { admin, schema } = ctx.fixture;
  try {
    const counts = async () => ({
      tables: (await admin.query(
        `SELECT count(*)::int AS n FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace
         WHERE ns.nspname = $1 AND c.relkind = 'r'`, [schema])).rows[0].n,
      roles: (await admin.query('SELECT count(*)::int AS n FROM pg_roles WHERE rolname LIKE $1', [`${schema}_%`])).rows[0].n,
    });
    const before = await counts();
    assert.ok(before.tables > 0 && before.roles > 0, 'precondition: the fixture has tables and roles');
    for (const tag of ['ddl-a', 'ddl-b']) {
      const b = browser(ctx.api);
      await b.client.signUp({ name: tag, email: `${tag}@pg.example.invalid`, password: 'pw-ddl-synthetic' });
      const attempt = await registeredAttempt(b);
      assert.ok(attempt.id, 'the learner can create an attempt');
    }
    assert.deepEqual(await counts(), before, 'two learners must add no table and no role');
  } finally { await ctx.fixture.cleanup(); }
});

/* ================================================================== run */

export const REQUIRED_CHECKS = checks.map((c) => c.name);

export async function runOwnedApiPgChecks() {
  const results = [];
  // EXAM-S0: the seeded content is `unreviewed`, so this suite opts into `internal-preview` explicitly for
  // its own run and restores the previous value. The deployment default is `public`.
  const previousMode = process.env.B1PREP_CONTENT_MODE;
  process.env.B1PREP_CONTENT_MODE = 'internal-preview';
  try {
    for (const { name, run } of checks) {
      try {
        await run();
        results.push({ name, ok: true, detail: 'ok' });
      } catch (error) {
        results.push({ name, ok: false, detail: error && error.message ? error.message.split('\n')[0] : String(error), error });
      }
    }
  } finally {
    if (previousMode === undefined) delete process.env.B1PREP_CONTENT_MODE;
    else process.env.B1PREP_CONTENT_MODE = previousMode;
  }
  return { ok: results.every((r) => r.ok), results };
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  const report = await runOwnedApiPgChecks();
  for (const r of report.results) {
    console.log(`${r.ok ? 'PASS' : 'FAIL'} ${r.name}${r.ok ? '' : `\n  ${r.detail}`}`);
    if (!r.ok && r.error && r.error.stack) console.log(r.error.stack.split('\n').slice(1, 5).join('\n'));
  }
  const failed = report.results.filter((r) => !r.ok).length;
  console.log(`\n${report.results.length - failed} passed, ${failed} failed`);
  process.exitCode = failed ? 1 : 0;
}

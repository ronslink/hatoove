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
    const attempt = await a.client.createAttempt();
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
    const attempt = await a.client.createAttempt();
    const draft = await a.client.saveDraft(attempt.id, { expectedRevision: 1, text: 'A private draft' });
    const receipt = await a.client.submit(attempt.id, { expectedRevision: draft.revision, eventId: randomUUID() });
    const openB = await b.client.createAttempt();
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
    const ownerA = `user-${randomUUID()}`;
    const ownerB = `user-${randomUUID()}`;
    for (const owner of [ownerA, ownerB]) {
      await admin.query('INSERT INTO "user"(id, name, email, "emailVerified", "createdAt", "updatedAt") VALUES($1, $2, $3, false, now(), now())',
        [owner, 'Synthetic', `${owner}@pg.example.invalid`]);
      await admin.query('INSERT INTO entitlements(owner_id, allowance) VALUES($1, 5)', [owner]);
    }
    const attemptId = randomUUID();
    await admin.query(`INSERT INTO attempts(id, owner_id, task_version, rubric_version) VALUES($1, $2, 'synthetic-writing-v1', 'formative-fixture-v1')`, [attemptId, ownerA]);
    await admin.query('INSERT INTO drafts(attempt_id, revision, text) VALUES($1, 1, $2)', [attemptId, 'A secret']);

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
    assert.equal(await crossOwner(learner, ownerB), 1, 'with RLS disabled a test like this would pass while proving nothing');
    // Restore, then prove the restore.
    await admin.query('ALTER TABLE attempts ENABLE ROW LEVEL SECURITY');
    await admin.query('ALTER TABLE attempts FORCE ROW LEVEL SECURITY');
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
    const attempt = await a.client.createAttempt();
    // Break the learner pool only; the session still verifies.
    await ctx.fixture.learner.end();
    const res = await a.raw('GET', `/api/v1/attempts/${attempt.id}`);
    assert.equal(res.status, 500, 'a database failure must not be reported as success');
    assert.deepEqual(res.json, { error: 'internal_error' });
    await expectClientError(a.client.readAttempt(attempt.id), 'server_error', 500);
  } finally { await ctx.fixture.cleanup(); }
});

/* ================================================================== run */

export const REQUIRED_CHECKS = checks.map((c) => c.name);

export async function runOwnedApiPgChecks() {
  const results = [];
  for (const { name, run } of checks) {
    try {
      await run();
      results.push({ name, ok: true, detail: 'ok' });
    } catch (error) {
      results.push({ name, ok: false, detail: error && error.message ? error.message.split('\n')[0] : String(error), error });
    }
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

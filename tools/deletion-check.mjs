/**
 * Hard account deletion proof (HARD-DELETE-02, specification HARD-DELETE-01).
 *
 * Drives DELETE /api/v1/account through server/owned-api.mjs over REAL PostgreSQL, with
 * accounts seeded through the API itself so every owned table genuinely holds rows -
 * including the attempts <-> submissions cycle (a revision attempt whose
 * parent_submission_id points at a submission) and a soft-deleted attempt.
 *
 * Every read-back runs on the fixture's SUPERUSER pool, which bypasses row-level security:
 * a read-back under a restricted role would see "no rows" because of a policy, not because
 * the rows are gone. Each "zero rows" result is paired with a precondition that the same
 * query found rows before.
 *
 * The deletion runs as a dedicated, NON-superuser, NOBYPASSRLS role this checker creates
 * in the disposable schema with exactly the grants and owner-scoped policies the deletion
 * needs. That role does NOT exist in a provisioned installation yet (see
 * work/implementation/HARD-DELETE-01.md §6); it is created here so the proof is made under
 * row-level security rather than as a superuser.
 *
 * Discrimination: on e621618 (no deletion route, no deletion port) this checker fails.
 *
 * Requires the package `server/owned-postgres` installed (pg 8.23.1) and a DISPOSABLE
 * database (OWNAPI_PG_*, default 127.0.0.1:55435/hatoove_spike). These checks delete rows.
 * Synthetic accounts only.
 *
 * Usage: node tools/deletion-check.mjs   (exit 0 when every check passes)
 */

import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';

import * as ownedApi from '../server/owned-api.mjs';
import * as adapter from '../server/owned-postgres/adapter.mjs';
import { createFixture, rolePool } from '../server/owned-postgres/bootstrap.mjs';
import { createPostgresWorld } from '../server/owned-postgres/fixture.mjs';
import { MIGRATIONS } from '../server/owned-postgres/provision.mjs';

const { createOwnedApi } = ownedApi;
const createDeletion = typeof adapter.createPostgresAccountDeletion === 'function'
  ? adapter.createPostgresAccountDeletion : null;

/** Every table that holds an account's rows, as HARD-DELETE-01 §1 lists it, plus `account`. */
const TABLES = [
  'attempts', 'drafts', 'submissions', 'jobs', 'assessments', 'usage_ledger',
  'entitlements', 'learner_settings', 'session', 'account', 'user',
];

/* --------------------------------------------------------------- results */

const results = [];
async function check(name, fn) {
  try {
    const detail = await fn();
    results.push({ name, ok: true });
    console.log(`PASS ${name}${detail ? `\n     ${detail}` : ''}`);
  } catch (error) {
    results.push({ name, ok: false });
    console.log(`FAIL ${name}\n     ${String(error && error.message || error).split('\n').join('\n     ')}`);
  }
}

/* ------------------------------------------------------------- the world */

const db = await createFixture();
let deletionRole = null;
let deletionPool = null;
let world = null;

async function provisionDeletionRole() {
  // Account settings are migration 0004 of a persistent installation; the disposable fixture
  // does not apply it, so it is applied here or step 9 of the deletion has no table to act on.
  const settingsMigration = MIGRATIONS.find((m) => m.id === '0004-account-settings');
  await db.migration.query(settingsMigration.sql({ schema: db.schema, roles: db.roles }));

  deletionRole = `${db.schema}_deletion`;
  const role = `"${deletionRole}"`;
  const owner = "nullif(current_setting('hatoove.owner_id', true), '')";
  await db.admin.query(
    `CREATE ROLE ${role} LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 5`);
  await db.admin.query(`GRANT USAGE ON SCHEMA "${db.schema}" TO ${role}`);
  await db.admin.query(`GRANT SELECT, DELETE ON attempts, drafts, submissions, jobs, assessments, usage_ledger,
    entitlements, learner_settings, session, account, "user" TO ${role}`);
  await db.admin.query(`GRANT UPDATE(parent_submission_id) ON attempts TO ${role}`);
  // FOR UPDATE on "user" needs UPDATE on at least one column; nothing in the deletion updates it.
  await db.admin.query(`GRANT UPDATE("updatedAt") ON "user" TO ${role}`);
  for (const table of ['attempts', 'submissions', 'jobs', 'assessments', 'usage_ledger', 'entitlements']) {
    await db.admin.query(`CREATE POLICY deletion_${table} ON ${table} TO ${role} USING (owner_id = ${owner})`);
  }
  await db.admin.query(`CREATE POLICY deletion_learner_settings ON learner_settings TO ${role} USING (user_id = ${owner})`);
  await db.admin.query(`CREATE POLICY deletion_drafts ON drafts TO ${role}
    USING (EXISTS (SELECT 1 FROM attempts a WHERE a.id = attempt_id AND a.owner_id = ${owner}))`);
  deletionPool = rolePool(db.config, db.schema, deletionRole, 2);
}

async function teardown() {
  if (deletionPool) await deletionPool.end().catch(() => {});
  if (world) await world.teardown().catch(() => {});
  else await db.cleanup().catch(() => {});
  if (deletionRole) {
    // The fixture's admin pool is closed by cleanup(); the schema (and with it every grant and
    // policy naming the role) is gone, so the role can now be dropped.
    const admin = rolePool(db.config, db.schema, db.config.user, 1);
    await admin.query(`DROP ROLE IF EXISTS "${deletionRole}"`).catch(() => {});
    await admin.end().catch(() => {});
  }
}

/* --------------------------------------------------------------- helpers */

function cookieOf(response) {
  const header = response.headers['set-cookie'];
  if (!header) return null;
  const pair = String(Array.isArray(header) ? header[0] : header).split(';')[0];
  return pair.endsWith('=') ? null : pair;
}

function caller(api, { originChecked = true } = {}) {
  return async (method, path, { cookie, body, contentType = 'application/json' } = {}) => {
    const headers = { accept: 'application/json' };
    if (cookie) headers.cookie = cookie;
    if (method !== 'GET') headers['content-type'] = contentType;
    const response = await api.handle({
      method, path, headers, originChecked,
      body: method === 'GET' ? undefined : (typeof body === 'string' ? body : JSON.stringify(body ?? {})),
    });
    let json = null;
    try { json = JSON.parse(response.body); } catch { /* not JSON */ }
    return { status: response.status, json, headers: response.headers };
  };
}

async function rows(sql, params) {
  return (await db.admin.query(sql, params)).rows;
}

/** Every row the account owns, per table, read as the superuser (RLS bypassed). */
async function snapshot(userId, attemptIds = []) {
  const ids = [...new Set([...attemptIds,
    ...(await rows('SELECT id FROM attempts WHERE owner_id = $1', [userId])).map((r) => r.id)])];
  const state = {
    attempts: await rows('SELECT * FROM attempts WHERE owner_id = $1 ORDER BY id', [userId]),
    drafts: await rows('SELECT * FROM drafts WHERE attempt_id = ANY($1::uuid[]) ORDER BY attempt_id', [ids]),
    submissions: await rows('SELECT * FROM submissions WHERE owner_id = $1 ORDER BY id', [userId]),
    jobs: await rows('SELECT * FROM jobs WHERE owner_id = $1 ORDER BY id', [userId]),
    assessments: await rows('SELECT * FROM assessments WHERE owner_id = $1 ORDER BY submission_id', [userId]),
    usage_ledger: await rows('SELECT * FROM usage_ledger WHERE owner_id = $1 ORDER BY submission_id', [userId]),
    entitlements: await rows('SELECT * FROM entitlements WHERE owner_id = $1', [userId]),
    learner_settings: await rows('SELECT * FROM learner_settings WHERE user_id = $1', [userId]),
    session: await rows('SELECT * FROM session WHERE "userId" = $1 ORDER BY id', [userId]),
    account: await rows('SELECT * FROM account WHERE "userId" = $1 ORDER BY id', [userId]),
    user: await rows('SELECT * FROM "user" WHERE id = $1', [userId]),
  };
  return { ids, state, counts: Object.fromEntries(TABLES.map((t) => [t, state[t].length])) };
}

const asJson = (value) => JSON.stringify(value, (key, v) => (v instanceof Date ? v.toISOString() : v));
const countLine = (counts) => TABLES.map((t) => `${t}=${counts[t]}`).join(' ');

/**
 * One account seeded through the API: a completed submission (assessment + usage ledger),
 * a revision attempt pointing back at it (the cycle), a failed-then-removed attempt
 * (soft-deleted, with its submission and job), saved settings and two live sessions.
 */
async function seed(call, label) {
  const email = `${label}-${randomUUID().slice(0, 8)}@deletion-check.invalid`;
  const password = `pw-${randomUUID()}`;
  const signUp = await call('POST', '/api/auth/sign-up/email', { body: { name: `Synthetic ${label}`, email, password } });
  assert.equal(signUp.status, 200, `sign-up ${label}: ${signUp.status}`);
  const cookie = cookieOf(signUp);
  const who = await call('GET', '/api/v1/account', { cookie });
  const userId = who.json.id;

  async function submitted(text) {
    const created = await call('POST', '/api/v1/attempts', { cookie, body: {} });
    assert.equal(created.status, 201);
    const saved = await call('PUT', `/api/v1/attempts/${created.json.id}`, { cookie, body: { expectedRevision: 1, text } });
    assert.equal(saved.status, 200);
    const sent = await call('POST', `/api/v1/attempts/${created.json.id}/submissions`,
      { cookie, body: { expectedRevision: 2, eventId: randomUUID() } });
    assert.equal(sent.status, 202);
    return { attemptId: created.json.id, submissionId: sent.json.submissionId };
  }

  const first = await submitted(`Liebe Frau Weber, ich schreibe Ihnen wegen ${label}.`);
  assert.ok(await world.store.worker.claim(first.submissionId));
  assert.ok(await world.store.worker.complete(first.submissionId, 'synthetic'));
  const revision = await call('POST', '/api/v1/attempts', { cookie, body: { parentSubmissionId: first.submissionId } });
  assert.equal(revision.status, 201, `revision attempt ${label}: ${revision.status}`);
  await call('PUT', `/api/v1/attempts/${revision.json.id}`, { cookie, body: { expectedRevision: 1, text: 'Überarbeitung' } });

  const second = await submitted(`Zweiter Versuch ${label}.`);
  assert.ok(await world.store.worker.claim(second.submissionId));
  assert.ok(await world.store.worker.fail(second.submissionId, 'synthetic_failure'));
  assert.equal((await call('DELETE', `/api/v1/attempts/${second.attemptId}`, { cookie, body: {} })).status, 200);

  const settings = await call('PUT', '/api/v1/settings', { cookie, body: { expectedRevision: 0, theme: 'dark', dailyGoal: 30 } });
  assert.equal(settings.status, 200, `settings ${label}: ${settings.status}`);
  const signIn = await call('POST', '/api/auth/sign-in/email', { body: { email, password } });
  assert.equal(signIn.status, 200);
  return { label, userId, cookie, cookie2: cookieOf(signIn), revisionAttemptId: revision.json.id, firstSubmissionId: first.submissionId };
}

/** The precondition that keeps a later "zero rows" honest: rows exist in every table. */
function assertPopulated(snap, label) {
  for (const table of TABLES) assert.ok(snap.counts[table] > 0, `${label}: no ${table} row before the deletion (vacuous)`);
  assert.ok(snap.counts.session >= 2, `${label}: expected two live sessions`);
  assert.ok(snap.state.attempts.some((a) => a.parent_submission_id), `${label}: no attempt carries parent_submission_id (no cycle)`);
  assert.ok(snap.state.attempts.some((a) => a.deleted_at), `${label}: no soft-deleted attempt`);
}

/* ---------------------------------------------------------------- checks */

try {
  await provisionDeletionRole();
  world = await createPostgresWorld({ fixture: db });
  const deletion = createDeletion ? createDeletion({ pool: deletionPool }) : null;
  const ports = { datastore: world.store.port, sessions: world.sessions, settings: world.settings };
  const api = createOwnedApi({ ...ports, accountDeletion: deletion });
  const call = caller(api);

  const superuser = (await rows('SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user'))[0];
  assert.ok(superuser.rolsuper || superuser.rolbypassrls, 'read-back pool must bypass RLS, or "no rows" proves nothing');

  const A = await seed(call, 'a');
  const B = await seed(call, 'b');
  const C = await seed(call, 'c');
  const beforeA = await snapshot(A.userId);
  const beforeB = await snapshot(B.userId);
  const beforeC = await snapshot(C.userId);

  await check('precondition: A, B and C each have rows in all 11 account tables, the cycle and a soft-deleted attempt', async () => {
    assertPopulated(beforeA, 'A'); assertPopulated(beforeB, 'B'); assertPopulated(beforeC, 'C');
    return `A before: ${countLine(beforeA.counts)}\n     B before: ${countLine(beforeB.counts)}`;
  });

  await check('the deletion role is a restricted role: NOSUPERUSER, NOBYPASSRLS, FORCE RLS on the owned tables', async () => {
    const r = (await rows('SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = $1', [deletionRole]))[0];
    assert.equal(r.rolsuper, false); assert.equal(r.rolbypassrls, false);
    const forced = await rows(`SELECT relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1 AND relforcerowsecurity ORDER BY relname`, [db.schema]);
    const names = forced.map((x) => x.relname);
    for (const t of ['attempts', 'drafts', 'submissions', 'jobs', 'assessments', 'usage_ledger', 'entitlements', 'learner_settings']) {
      assert.ok(names.includes(t), `FORCE RLS missing on ${t}`);
    }
  });

  await check('the restricted LEARNER role cannot run the deletion (permission denied) and A is untouched', async () => {
    assert.ok(createDeletion, 'no createPostgresAccountDeletion in server/owned-postgres/adapter.mjs');
    const asLearner = createDeletion({ pool: db.learner });
    await assert.rejects(asLearner.deleteAccount(A.userId), (e) => e && e.code === '42501');
    assert.equal(asJson((await snapshot(A.userId)).state), asJson(beforeA.state));
    return 'error 42501 insufficient_privilege - the reason the deletion is a separate port';
  });

  await check('FORCED FAILURE after step 5: reply 500, steps 1-5 had really run, then EVERY table of A is intact', async () => {
    assert.ok(createDeletion, 'no createPostgresAccountDeletion in server/owned-postgres/adapter.mjs');
    const reached = [];
    let inFlight = null;
    const failing = createDeletion({
      pool: deletionPool,
      afterStep: async (index, name, client) => {
        reached.push(`${index}:${name}`);
        if (index === 5) {
          // Inside the transaction, as the deletion role: the cycle is broken and the
          // dependants are gone - so a rollback has something real to undo.
          inFlight = {
            linked: (await client.query('SELECT count(*)::int AS n FROM attempts WHERE owner_id = $1 AND parent_submission_id IS NOT NULL', [A.userId])).rows[0].n,
            usage: (await client.query('SELECT count(*)::int AS n FROM usage_ledger WHERE owner_id = $1', [A.userId])).rows[0].n,
            drafts: (await client.query('SELECT count(*)::int AS n FROM drafts WHERE attempt_id = ANY($1::uuid[])', [beforeA.ids])).rows[0].n,
          };
          throw new Error('injected failure after step 5');
        }
      },
    });
    const failingApi = createOwnedApi({ ...ports, accountDeletion: failing });
    const reply = await caller(failingApi)('DELETE', '/api/v1/account', { cookie: A.cookie, body: {} });
    assert.equal(reply.status, 500, `expected 500, got ${reply.status} ${JSON.stringify(reply.json)}`);
    assert.deepEqual(reply.json, { error: 'internal_error' });
    assert.deepEqual(reached, ['1:attempts_unlinked', '2:usage_ledger', '3:assessments', '4:jobs', '5:drafts']);
    assert.deepEqual(inFlight, { linked: 0, usage: 0, drafts: 0 }, `in-flight state ${JSON.stringify(inFlight)}`);
    const after = await snapshot(A.userId, beforeA.ids);
    for (const table of TABLES) assert.equal(asJson(after.state[table]), asJson(beforeA.state[table]), `${table} changed`);
    assert.ok(after.state.attempts.some((a) => a.parent_submission_id), 'step 1 (cycle break) was not rolled back');
    assert.equal((await call('GET', '/api/v1/account', { cookie: A.cookie })).status, 200, 'A was signed out by a failed deletion');
    return `A after rollback: ${countLine(after.counts)} (identical, row by row)`;
  });

  await check('a body naming an account is refused (422 unknown_field) and deletes nobody', async () => {
    const reply = await call('DELETE', '/api/v1/account', { cookie: C.cookie, body: { ownerId: B.userId } });
    assert.equal(reply.status, 422, `got ${reply.status}`);
    assert.equal(reply.json.error, 'unknown_field');
    assert.equal(asJson((await snapshot(C.userId)).state), asJson(beforeC.state));
    assert.equal(asJson((await snapshot(B.userId)).state), asJson(beforeB.state));
  });

  await check('a mutation without the origin gate is refused (403) and deletes nothing', async () => {
    const reply = await caller(api, { originChecked: false })('DELETE', '/api/v1/account', { cookie: C.cookie, body: {} });
    assert.equal(reply.status, 403);
    assert.equal(asJson((await snapshot(C.userId)).state), asJson(beforeC.state));
  });

  await check('an installation without the deletion port answers 503 deletion_unavailable and deletes nothing', async () => {
    const unwired = createOwnedApi(ports);
    const reply = await caller(unwired)('DELETE', '/api/v1/account', { cookie: C.cookie, body: {} });
    assert.equal(reply.status, 503, `got ${reply.status}`);
    assert.equal(reply.json.error, 'deletion_unavailable');
    assert.equal(asJson((await snapshot(C.userId)).state), asJson(beforeC.state));
  });

  await check('a query string naming another account is ignored: C\'s DELETE ?owner=B removes C, not B', async () => {
    const reply = await call('DELETE', `/api/v1/account?owner=${encodeURIComponent(B.userId)}&ownerId=${encodeURIComponent(B.userId)}`,
      { cookie: C.cookie, body: {} });
    assert.equal(reply.status, 200, `got ${reply.status}`);
    assert.equal((await snapshot(C.userId, beforeC.ids)).counts.user, 0);
    assert.equal(asJson((await snapshot(B.userId)).state), asJson(beforeB.state));
  });

  let replyA = null;
  await check('DELETE /api/v1/account as A: 200, honest reply - completeErasure false, backups named, no invented retention period', async () => {
    replyA = await call('DELETE', '/api/v1/account', { cookie: A.cookie, body: {} });
    assert.equal(replyA.status, 200, `got ${replyA.status} ${JSON.stringify(replyA.json)}`);
    const body = replyA.json;
    assert.equal(body.deleted, true);
    assert.equal(body.accountExisted, true);
    assert.equal(body.completeErasure, false);
    assert.ok(Array.isArray(body.notRemoved));
    const backups = body.notRemoved.find((item) => item.what === 'operator_backups');
    assert.ok(backups, 'the reply does not name the operator backups');
    assert.match(backups.detail, /No retention period/);
    const text = JSON.stringify(body);
    assert.doesNotMatch(text, /\b\d+\s*(?:day|days|week|weeks|month|months|year|years)\b/i, 'a retention period was stated');
    assert.doesNotMatch(text, /permanently|all (?:of )?your data|completely|irrecoverabl/i, 'a total-erasure claim');
    assert.equal(body.removed.user, 1);
    assert.equal(body.removed.attempts_unlinked, 1);
    assert.equal(body.removed.session, beforeA.counts.session);
    assert.match(String(replyA.headers['set-cookie'] || ''), /Max-Age=0/, 'the cookie is not cleared');
    return `removed (the delete's own counts, NOT the proof): ${JSON.stringify(body.removed)}`;
  });

  await check('READ-BACK (superuser, RLS bypassed): zero rows for A in every table', async () => {
    assert.ok(replyA && replyA.status === 200, 'the deletion did not run');
    const after = await snapshot(A.userId, beforeA.ids);
    const left = TABLES.filter((t) => after.counts[t] !== 0);
    assert.deepEqual(left, [], `rows left in: ${left.map((t) => `${t}=${after.counts[t]}`).join(', ')}`);
    const byEmail = await rows('SELECT count(*)::int AS n FROM "user" WHERE email = $1', [beforeA.state.user[0].email]);
    assert.equal(byEmail[0].n, 0);
    return `A before: ${countLine(beforeA.counts)}\n     A after:  ${countLine(after.counts)}`;
  });

  await check('B is untouched: counted and compared row by row, before and after both deletions', async () => {
    const after = await snapshot(B.userId);
    for (const table of TABLES) assert.equal(asJson(after.state[table]), asJson(beforeB.state[table]), `B ${table} changed`);
    return `B before: ${countLine(beforeB.counts)}\n     B after:  ${countLine(after.counts)}`;
  });

  await check('no live session survives: BOTH of A\'s cookies are refused on the next request', async () => {
    for (const cookie of [A.cookie, A.cookie2]) {
      assert.equal((await call('GET', '/api/v1/account', { cookie })).status, 401);
      assert.equal((await call('GET', `/api/v1/attempts/${A.revisionAttemptId}`, { cookie })).status, 401);
      const session = await call('GET', '/api/auth/get-session', { cookie });
      assert.equal(session.json, null);
    }
  });

  await check('repeating the DELETE with the dead cookie is 401 and changes nothing', async () => {
    const reply = await call('DELETE', '/api/v1/account', { cookie: A.cookie, body: {} });
    assert.equal(reply.status, 401);
    assert.equal(asJson((await snapshot(B.userId)).state), asJson(beforeB.state));
  });

  await check('idempotent at the port: an already-deleted or never-existing account reports existed=false and removes 0', async () => {
    assert.ok(createDeletion, 'no createPostgresAccountDeletion');
    for (const id of [A.userId, `user-${randomUUID()}`]) {
      const outcome = await deletion.deleteAccount(id);
      assert.equal(outcome.existed, false);
      assert.deepEqual(Object.values(outcome.removed).filter((n) => n !== 0), []);
    }
    assert.equal(asJson((await snapshot(B.userId)).state), asJson(beforeB.state));
  });

  await check('B still works after the deletions: reads and saves its revision attempt', async () => {
    const read = await call('GET', `/api/v1/attempts/${B.revisionAttemptId}`, { cookie: B.cookie });
    assert.equal(read.status, 200);
    const saved = await call('PUT', `/api/v1/attempts/${B.revisionAttemptId}`,
      { cookie: B.cookie, body: { expectedRevision: read.json.revision, text: 'B arbeitet weiter.' } });
    assert.equal(saved.status, 200);
  });

  await check('the A email can sign up again as a NEW account with nothing of the old one', async () => {
    const email = beforeA.state.user[0].email;
    const again = await call('POST', '/api/auth/sign-up/email', { body: { name: 'Synthetic a2', email, password: `pw-${randomUUID()}` } });
    assert.equal(again.status, 200, `got ${again.status}`);
    const who = await call('GET', '/api/v1/account', { cookie: cookieOf(again) });
    assert.notEqual(who.json.id, A.userId);
    assert.equal((await call('GET', `/api/v1/attempts/${A.revisionAttemptId}`, { cookie: cookieOf(again) })).status, 404);
  });
} catch (error) {
  results.push({ name: 'setup', ok: false });
  console.log(`FAIL setup\n     ${error && error.stack || error}`);
} finally {
  await teardown();
}

const passed = results.filter((r) => r.ok).length;
const failed = results.length - passed;
console.log(`\n${passed} passed, ${failed} failed`);
console.log('NOTE disposable PostgreSQL, synthetic accounts; deletion as a checker-provisioned restricted role (no such role is provisioned in an installation yet).');
process.exit(failed ? 1 : 0);

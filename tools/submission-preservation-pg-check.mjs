/**
 * Real PostgreSQL proof of submitted-work preservation, including controlled lock races.
 * Run with explicit OWNAPI_PG_HOST/PORT/DATABASE/USER and OWNAPI_PG_ALLOW=1 against a disposable DB.
 * Uses the real handler, restricted learner/worker roles and a random fixture schema. No provider.
 * Race gates pause AFTER the real attempt lock; a second connection must visibly wait on a DB lock.
 * Only legacy-tombstone setup/read-back uses the fixture admin. Production SQL is not changed.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createOwnedApi } from '../server/owned-api.mjs';
import { createPostgresDatastore } from '../server/owned-postgres/adapter.mjs';
import { createPostgresWorld } from '../server/owned-postgres/fixture.mjs';
import { rolePool, pgConfig } from '../server/owned-postgres/bootstrap.mjs';

assert.equal(process.env.OWNAPI_PG_ALLOW, '1', 'confirm a disposable DB with OWNAPI_PG_ALLOW=1');
for (const key of ['OWNAPI_PG_HOST', 'OWNAPI_PG_PORT', 'OWNAPI_PG_DATABASE', 'OWNAPI_PG_USER']) assert.ok(process.env[key], `${key} is required`);
assert.ok(!['55440', '55469', '4300'].includes(process.env.OWNAPI_PG_PORT), 'refuse existing learner/preview ports');
assert.ok(!['postgres', 'template0', 'template1'].includes(process.env.OWNAPI_PG_DATABASE));

const world = await createPostgresWorld({ allowance: 100 });
const db = world.fixture;
const results = [];
async function check(name, run) {
  try { await run(); results.push(true); console.log(`PASS ${name}`); }
  catch (error) { results.push(false); console.log(`FAIL ${name}\n${error.stack || error}`); }
}
async function call(method, path, who = null, body = {}, api = world.api) {
  const response = await api.handle({ method, path, originChecked: true,
    headers: { 'content-type': 'application/json', ...(who ? { cookie: who.cookie } : {}) },
    ...(method === 'GET' ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, data: JSON.parse(response.body), cookie: String(response.headers['set-cookie'] || '').split(';')[0] };
}
function expect(response, status = 200, error = null) {
  assert.equal(response.status, status, JSON.stringify(response.data));
  if (error) assert.equal(response.data.error, error);
  return response.data;
}
async function learner(name) {
  const signup = await call('POST', '/api/auth/sign-up/email', null, { name, email: `preserve-${randomUUID()}@example.invalid`, password: 'Synthetic-preservation-password' });
  expect(signup);
  const who = { cookie: signup.cookie };
  who.id = expect(await call('GET', '/api/v1/account', who)).id;
  assert.ok(who.id); return who;
}
async function draft(who, text) {
  const attempt = expect(await call('POST', '/api/v1/attempts', who), 201);
  const saved = expect(await call('PUT', `/api/v1/attempts/${attempt.id}`, who, { expectedRevision: 1, text }));
  return { ...attempt, revision: saved.revision, text };
}
const submit = (who, attempt, api = world.api) => call('POST', `/api/v1/attempts/${attempt.id}/submissions`, who,
  { expectedRevision: attempt.revision, eventId: randomUUID() }, api);
const remove = (who, attempt, api = world.api) => call('DELETE', `/api/v1/attempts/${attempt.id}`, who, {}, api);
async function submitted(who, text) {
  const attempt = await draft(who, text);
  return { ...attempt, submissionId: expect(await submit(who, attempt), 202).submissionId };
}
async function balanced(owner) {
  const row = (await db.admin.query(`SELECT e.reserved, e.used,
      (SELECT count(*)::int FROM jobs j WHERE j.owner_id=e.owner_id AND j.status IN ('queued','running')) AS pending,
      (SELECT count(*)::int FROM usage_ledger u WHERE u.owner_id=e.owner_id) AS debits
    FROM entitlements e WHERE e.owner_id=$1`, [owner])).rows[0];
  assert.equal(row.reserved, row.pending, 'every reservation must have a live job, and every live job a reservation');
  assert.equal(row.used, row.debits, 'completed work must have exactly its recorded debit');
}
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
async function bounded(promise, label) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(label)), 5000); })]); }
  finally { clearTimeout(timer); }
}
async function waitBlocked(pid) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const row = (await db.admin.query('SELECT wait_event_type, query, usename FROM pg_stat_activity WHERE pid=$1', [pid])).rows[0];
    if (row?.wait_event_type === 'Lock' && /entitlements.*FOR UPDATE/.test(row.query)) {
      assert.equal(row.usename, db.roles.learner, 'the blocked connection must really be the restricted learner');
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 15));
  }
  throw new Error('loser never visibly waited on the entitlement row lock (race proof would be vacuous)');
}
async function race(who, winner) {
  const attempt = await draft(who, `SYNTHETIC controlled ${winner} race.`);
  const before = await world.store.inspect.entitlement(who.id);
  const reached = deferred(), release = deferred(), loserConnected = deferred();
  const firstPool = rolePool(pgConfig(), db.schema, db.roles.learner, 1);
  const secondPool = rolePool(pgConfig(), db.schema, db.roles.learner, 1);
  const paused = { async connect() {
    const client = await firstPool.connect();
    await client.query("SET statement_timeout='12s'");
    return { release: () => client.release(), async query(sql, params) {
      const result = await client.query(sql, params);
      if (/SELECT \* FROM attempts .* FOR UPDATE$/.test(sql)) { reached.resolve(); await release.promise; }
      return result;
    } };
  } };
  const observed = { async connect() {
    const client = await secondPool.connect();
    await client.query("SET statement_timeout='12s'");
    loserConnected.resolve((await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
    return client;
  } };
  const apiFor = pool => createOwnedApi({ datastore: createPostgresDatastore({ pool }), sessions: world.sessions, settings: world.settings });
  const firstApi = apiFor(paused), secondApi = apiFor(observed);
  let first, second;
  try {
    first = winner === 'submit' ? submit(who, attempt, firstApi) : remove(who, attempt, firstApi);
    await bounded(reached.promise, 'winner never acquired its real attempt lock');
    second = winner === 'submit' ? remove(who, attempt, secondApi) : submit(who, attempt, secondApi);
    await waitBlocked(await bounded(loserConnected.promise, 'second real learner connection was not opened'));
    release.resolve();
    const [won, lost] = await Promise.all([first, second]);
    const row = await world.store.inspect.attempt(attempt.id);
    const submissions = (await db.admin.query('SELECT * FROM submissions WHERE attempt_id=$1', [attempt.id])).rows;
    const ent = await world.store.inspect.entitlement(who.id);
    if (winner === 'submit') {
      expect(won, 202); expect(lost, 409, 'submitted_attempt');
      assert.equal(submissions.length, 1); assert.equal(submissions[0].text, attempt.text);
      assert.equal(row.deleted_at, null); assert.equal(ent.reserved, before.reserved + 1);
      assert.equal((await world.store.inspect.job(won.data.submissionId)).status, 'queued');
    } else {
      expect(won); expect(lost, 404, 'not_found');
      assert.equal(submissions.length, 0); assert.ok(row.deleted_at); assert.equal(row.draft, null);
      assert.equal(ent.reserved, before.reserved);
    }
    assert.equal(ent.used, before.used); await balanced(who.id);
  } finally {
    release.resolve(); await Promise.allSettled([first, second].filter(Boolean));
    await Promise.all([firstPool.end(), secondPool.end()]);
  }
}

try {
  const a = await learner('Owner A'), b = await learner('Owner B');
  await check('preconditions: handler uses a non-superuser, non-bypass learner role with FORCE RLS', async () => {
    const actual = (await db.learner.query('SELECT current_user AS name, rolsuper, rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows[0];
    assert.equal(actual.name, db.roles.learner); assert.equal(actual.rolsuper, false); assert.equal(actual.rolbypassrls, false);
    const tables = (await db.admin.query("SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class WHERE relnamespace=$1::regnamespace AND relname=ANY($2)", [db.schema, ['attempts','submissions','jobs','assessments','entitlements']])).rows;
    assert.equal(tables.length, 5); assert.ok(tables.every(row => row.relrowsecurity && row.relforcerowsecurity));
  });
  for (const state of ['queued', 'running', 'succeeded', 'failed']) await check(`submitted DELETE is 409 in ${state}, with every stored row and reservation unchanged`, async () => {
    const saved = await submitted(a, `SYNTHETIC saved writing in ${state}. Liebe Anna, wir treffen uns am Samstag im Park.`);
    if (state !== 'queued') assert.equal(await world.store.worker.claim(saved.submissionId), true);
    if (state === 'running') await db.worker.query("UPDATE jobs SET lease_token=$2, lease_until=now()+interval '1 minute' WHERE submission_id=$1", [saved.submissionId, randomUUID()]);
    if (state === 'succeeded') assert.equal(await world.store.worker.complete(saved.submissionId, 'Synthetic saved feedback'), true);
    if (state === 'failed') assert.equal(await world.store.worker.fail(saved.submissionId, 'grader_unavailable'), true);
    assert.equal((await world.store.inspect.job(saved.submissionId)).status, state);
    const before = await world.store.inspect.fingerprint();
    expect(await remove(a, saved), 409, 'submitted_attempt');
    assert.equal(await world.store.inspect.fingerprint(), before);
    const result = expect(await call('GET', `/api/v1/submissions/${saved.submissionId}`, a));
    assert.equal(result.submission.text, saved.text); assert.equal(result.job.status, state);
    if (state === 'succeeded') assert.ok(result.assessment?.feedback);
    const foreign = await remove(b, saved), absent = await remove(b, { id: randomUUID() });
    expect(foreign, 404, 'not_found'); assert.deepEqual(foreign.data, expect(absent, 404, 'not_found'));
    if (state === 'failed') expect(await call('POST', `/api/v1/submissions/${saved.submissionId}/retry`, a), 202);
    await balanced(a.id);
  });
  await check('real overlapping transactions: submit holds the lock, delete waits and then refuses', () => race(a, 'submit'));
  await check('real overlapping transactions: delete holds the lock, submit waits and then refuses without a reservation', () => race(a, 'delete'));
  await check('unsubmitted removal remains valid and creates no submission, job or charge', async () => {
    const open = await draft(a, 'SYNTHETIC disposable draft'); const before = await world.store.inspect.entitlement(a.id);
    expect(await remove(a, open)); const row = await world.store.inspect.attempt(open.id);
    assert.ok(row.deleted_at); assert.equal(row.draft, null);
    expect(await call('GET', `/api/v1/attempts/${open.id}`, a), 404, 'not_found');
    expect(await submit(a, open), 404, 'not_found');
    assert.deepEqual(await world.store.inspect.entitlement(a.id), before); await balanced(a.id);
  });
  await check('real legacy tombstones export own frozen text/results with a flag, never another owner or secrets', async () => {
    const oldA = await submitted(a, 'SYNTHETIC A LEGACY PRIVATE TEXT: Bitte komm am Samstag.'), oldB = await submitted(b, 'SYNTHETIC B LEGACY PRIVATE TEXT: Dieser Text gehört nur B.');
    for (const saved of [oldA, oldB]) {
      assert.equal(await world.store.worker.claim(saved.submissionId), true);
      assert.equal(await world.store.worker.complete(saved.submissionId, 'Synthetic legacy feedback'), true);
      // Simulate the retired discard of an already-assessed attempt; no application bypass is shipped.
      await db.admin.query('UPDATE attempts SET deleted_at=$2 WHERE id=$1', [saved.id, '2026-01-02T03:04:05Z']);
      await db.admin.query('DELETE FROM drafts WHERE attempt_id=$1', [saved.id]);
    }
    const snapshot = await world.store.inspect.fingerprint();
    for (const [who, mine, foreign] of [[a, oldA, oldB], [b, oldB, oldA]]) {
      const exported = expect(await call('GET', '/api/v1/export', who));
      const retained = (await db.admin.query(`SELECT s.id, s.text, a.deleted_at FROM submissions s
        JOIN attempts a ON a.id=s.attempt_id WHERE s.owner_id=$1 ORDER BY s.id`, [who.id])).rows;
      const expectedIds = retained.map(row => row.id);
      assert.deepEqual(exported.submissions.map(row => row.id).sort(), expectedIds, 'export contains exactly every retained own submission');
      assert.deepEqual(exported.results.map(row => row.submission_id).sort(), expectedIds, 'result identities are exactly the same owned set');
      for (const held of retained) {
        const entry = exported.submissions.find(row => row.id === held.id);
        assert.equal(entry.text, held.text);
        assert.equal(entry.attempt_deleted_at, held.deleted_at?.toISOString() ?? null, 'live rows and legacy tombstones are distinguished');
      }
      const submittedRow = exported.submissions.find(row => row.id === mine.submissionId);
      const resultRow = exported.results.find(row => row.submission_id === mine.submissionId);
      assert.equal(submittedRow.text, mine.text); assert.equal(submittedRow.attempt_deleted_at, '2026-01-02T03:04:05.000Z');
      assert.equal(resultRow.status, 'succeeded'); assert.equal(resultRow.attempt_deleted_at, submittedRow.attempt_deleted_at);
      const stored = (await db.admin.query('SELECT feedback FROM assessments WHERE submission_id=$1', [mine.submissionId])).rows[0];
      assert.deepEqual(resultRow.feedback, stored.feedback);
      assert.equal(exported.attempts.some(row => row.id === mine.id), false, 'a legacy tombstone is not offered as a live draft');
      const encoded = JSON.stringify(exported); assert.equal(encoded.includes(foreign.text), false); assert.equal(encoded.includes(foreign.submissionId), false);
      const forbidden = /^(password|password_hash|token|session|sessions|secret|lease_token|lease_until|event_id|owner_id|account|objective_key)$/i;
      const walk = value => { if (value && typeof value === 'object') for (const [key, child] of Object.entries(value)) { assert.equal(forbidden.test(key), false, `forbidden export column ${key}`); walk(child); } };
      walk(exported); await balanced(who.id);
    }
    expect(await call('GET', '/api/v1/export'), 401);
    assert.equal(await world.store.inspect.fingerprint(), snapshot, 'export must not alter retained history');
  });
} finally { await world.teardown(); }
const passed = results.filter(Boolean).length;
console.log(`\n${passed} passed, ${results.length - passed} failed (real PostgreSQL, synthetic accounts, no provider).`);
process.exitCode = passed === results.length ? 0 : 1;

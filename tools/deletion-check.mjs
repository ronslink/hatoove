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
 * The deletion runs as the NON-superuser, NOBYPASSRLS role `bootstrap.mjs` creates from the
 * SAME builders (`provisioning-sql.mjs`) that `provision.mjs` records as migrations 0004 and
 * 0005 — so the grants and owner-scoped policies proved here are the ones a real installation
 * gets. (Before this, the only role with those rights was one this checker invented for
 * itself, which proved nothing about any installation that exists.)
 *
 * Discrimination: the world this file drives is built by `createPostgresWorld()` — the same
 * call `server/accounts.mjs` makes — so a tree that does not wire the deletion port into the
 * world fails the "RUNNING-SERVER wiring" check below. The file's old claim, that this checker
 * fails on e621618, was wrong: e621618 predates this file, so the failure there is
 * `Cannot find module`, not the discrimination criterion 7 asks for. A tree in which the
 * deletion is unreachable now scores worse than this one, not the same.
 *
 * Requires the package `server/owned-postgres` installed (pg 8.23.1) and a DISPOSABLE
 * database (OWNAPI_PG_*, default 127.0.0.1:55435/hatoove_spike). These checks delete rows.
 * Synthetic accounts only.
 *
 * Usage: node tools/deletion-check.mjs   (exit 0 when every check passes)
 */

import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';

import * as adapter from '../server/owned-postgres/adapter.mjs';
import { createOwnedApi } from '../server/owned-api.mjs';
import { createFixture } from '../server/owned-postgres/bootstrap.mjs';
import { createPostgresWorld } from '../server/owned-postgres/fixture.mjs';

const createDeletion = typeof adapter.createPostgresAccountDeletion === 'function'
  ? adapter.createPostgresAccountDeletion : null;

/** Every table that holds an account's rows, as HARD-DELETE-01 §1 lists it, plus `account`. */
const TABLES = [
  'attempts', 'drafts', 'submissions', 'jobs', 'assessments', 'usage_ledger',
  'entitlements', 'learner_settings', 'item_evidence', 'session', 'account', 'user',
];

/**
 * One objective item an account answers through the API, so `item_evidence` holds REAL rows
 * (PILOT-22). Resolved from the fixture once the world exists. The key is read on the superuser
 * pool only to learn an item id that exists; the answers sent are fixed, and the check never
 * depends on whether they are right.
 */
let evidenceItem = null;

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

// `createFixture()` builds the same schema, roles and least-privilege grants an installation
// has: the deletion role, its owner-scoped policies and the account-settings table all come
// from `provisioning-sql.mjs`, the builders migrations 0004/0005 also use.
const db = await createFixture();
const deletionRole = db.roles.deletion;
const deletionPool = db.deletion;
let world = null;

async function teardown() {
  // The fixture's `cleanup()` drops the schema (and with it every grant and policy) and then
  // every role it created, including the deletion role. No checker-owned role to clean up.
  if (world) await world.teardown().catch(() => {});
  else await db.cleanup().catch(() => {});
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
    item_evidence: await rows('SELECT * FROM item_evidence WHERE owner_id = $1 ORDER BY evidence_id', [userId]),
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
  assert.equal((await call('DELETE', `/api/v1/attempts/${second.attemptId}`, { cookie, body: {} })).status, 409);
  // A draft discard can no longer delete submitted history. Keep that failed submission for
  // hard-account-deletion coverage, and add a genuinely unsubmitted tombstone separately.
  const discarded = await call('POST', '/api/v1/attempts', { cookie, body: {} });
  assert.equal(discarded.status, 201);
  assert.equal((await call('DELETE', `/api/v1/attempts/${discarded.json.id}`, { cookie, body: {} })).status, 200);

  const settings = await call('PUT', '/api/v1/settings', { cookie, body: { expectedRevision: 0, theme: 'dark', dailyGoal: 30 } });
  assert.equal(settings.status, 200, `settings ${label}: ${settings.status}`);

  // Two evidence rows (append-only, so answering twice records twice), marked server-side by
  // `mark_objective_item`. Without them `item_evidence` is empty and its read-back is vacuous.
  for (const answer of [true, 'synthetic-wrong']) {
    const answered = await call('POST', `/api/v1/objective-sets/${encodeURIComponent(evidenceItem.setId)}/answers`,
      { cookie, body: { itemId: evidenceItem.itemId, version: evidenceItem.version, answer } });
    assert.equal(answered.status, 201, `objective answer ${label}: ${answered.status} ${JSON.stringify(answered.json)}`);
  }
  const signIn = await call('POST', '/api/auth/sign-in/email', { body: { email, password } });
  assert.equal(signIn.status, 200);
  return { label, userId, cookie, cookie2: cookieOf(signIn), revisionAttemptId: revision.json.id, firstSubmissionId: first.submissionId };
}

/** The precondition that keeps a later "zero rows" honest: rows exist in every table. */
function assertPopulated(snap, label) {
  for (const table of TABLES) assert.ok(snap.counts[table] > 0, `${label}: no ${table} row before the deletion (vacuous)`);
  assert.ok(snap.counts.session >= 2, `${label}: expected two live sessions`);
  assert.equal(snap.counts.item_evidence, 2, `${label}: expected the two answered objective items as evidence`);
  assert.ok(snap.state.attempts.some((a) => a.parent_submission_id), `${label}: no attempt carries parent_submission_id (no cycle)`);
  assert.ok(snap.state.attempts.some((a) => a.deleted_at), `${label}: no soft-deleted attempt`);
}

/* ---------------------------------------------------------------- checks */

try {
  world = await createPostgresWorld({ fixture: db });
  // The whole suite drives the world's own api — the one `server/accounts.mjs` hands to
  // `server.js` — rather than an api this checker assembles. The `deletion` port likewise
  // comes from the world, so no second wiring exists.
  const deletion = world.deletion;
  const ports = { datastore: world.store.port, sessions: world.sessions, settings: world.settings };
  const api = world.api;
  const call = caller(api);

  const superuser = (await rows('SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user'))[0];
  assert.ok(superuser.rolsuper || superuser.rolbypassrls, 'read-back pool must bypass RLS, or "no rows" proves nothing');

  evidenceItem = (await rows(`
    SELECT k.set_id AS "setId", k.version, (SELECT min(x) FROM jsonb_object_keys(k.answers) x) AS "itemId"
      FROM objective_key k
      JOIN objective_set s USING (set_id, version)
      JOIN content_version c ON c.content_version_id = s.content_version_id
      LEFT JOIN content_rights cr ON cr.content_version_id = c.content_version_id
     WHERE c.review_status IN ('approved', 'unreviewed') AND s.media_required = false
       AND COALESCE(cr.basis, c.rights_status) = 'generated'
     ORDER BY k.set_id, k.version LIMIT 1`))[0];
  assert.ok(evidenceItem && evidenceItem.itemId, 'the fixture serves no objective item to answer (vacuous evidence)');

  const A = await seed(call, 'a');
  const B = await seed(call, 'b');
  const C = await seed(call, 'c');
  const beforeA = await snapshot(A.userId);
  const beforeB = await snapshot(B.userId);
  const beforeC = await snapshot(C.userId);

  await check('precondition: A, B and C each have rows in all 12 account tables, the cycle and a soft-deleted attempt', async () => {
    assertPopulated(beforeA, 'A'); assertPopulated(beforeB, 'B'); assertPopulated(beforeC, 'C');
    return `A before: ${countLine(beforeA.counts)}\n     B before: ${countLine(beforeB.counts)}`;
  });

  await check('the RUNNING-SERVER wiring performs the deletion: DELETE through createPostgresWorld\'s own api is 200', async () => {
    // The running server does not build an api of its own: `server/accounts.mjs` gets it from
    // `createPostgresWorld()`. This drives THAT api, so a world that never received the
    // deletion port fails here even though every other check in this file would still pass.
    const worldCall = caller(world.api);
    const email = `wired-${randomUUID().slice(0, 8)}@deletion-check.invalid`;
    const password = `pw-${randomUUID()}`;
    const created = await worldCall('POST', '/api/auth/sign-up/email', { body: { name: 'Synthetic Wired', email, password } });
    assert.equal(created.status, 200, `sign-up: ${created.status}`);
    const cookie = cookieOf(created);
    const reply = await worldCall('DELETE', '/api/v1/account', { cookie, body: {} });
    assert.equal(reply.status, 200,
      `the world's own api must perform the deletion; got ${reply.status} ${JSON.stringify(reply.json)}`);
    assert.equal(reply.json.deleted, true);
    assert.equal((await worldCall('GET', '/api/v1/account', { cookie })).status, 401, 'the cookie survived the deletion');
    return 'createPostgresWorld wired the deletion port; DELETE returned 200 and the cookie died';
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

  await check('the deletion role SEES exactly the scoped owner\'s item_evidence (its read-back is not vacuous under FORCE RLS)', async () => {
    // Under FORCE RLS a role with no policy reads ZERO rows, so the port's pre-COMMIT read-back of
    // `item_evidence` would pass whether or not the rows were gone. Asserted as the deletion role.
    const client = await deletionPool.connect();
    try {
      await client.query('BEGIN');
      const seen = async (owner) => {
        await client.query("SELECT set_config('hatoove.owner_id', $1, true)", [owner]);
        return (await client.query('SELECT owner_id FROM item_evidence')).rows.map((r) => r.owner_id);
      };
      const asB = await seen(B.userId);
      assert.equal(asB.length, beforeB.counts.item_evidence, `scoped to B, the deletion role must see B's ${beforeB.counts.item_evidence} row(s), saw ${asB.length}`);
      assert.ok(asB.every((id) => id === B.userId), 'scoped to B, the deletion role saw another owner\'s evidence');
      assert.deepEqual(await seen(''), [], 'with no owner scoped, the deletion role must see no evidence');
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
    return `scoped to B: ${beforeB.counts.item_evidence} row(s), all B's; unscoped: 0`;
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
    // F8: a provider that processed the account's text is as far out of reach as a backup, and
    // is named for the same reason. No period for it either.
    const provider = body.notRemoved.find((item) => item.what === 'model_provider');
    assert.ok(provider, 'the reply does not name the model provider');
    assert.match(provider.detail, /no retention period for them is known/i);
    // F7: absence is proved by the port's read-back, not by the delete's own counts.
    assert.equal(body.verifiedAbsent, true, 'the reply does not report the read-back as the proof');
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
    // The stronger form (the brief's F11): every named step must report exactly 0, which also
    // pins the step list against the port. The old assertion filtered `removed: {}` to [] and
    // passed vacuously, so a port that stopped reporting a step would not have been caught.
    const zeroes = Object.fromEntries(adapter.ACCOUNT_DELETION_STEPS.map(([name]) => [name, 0]));
    for (const id of [A.userId, `user-${randomUUID()}`]) {
      const outcome = await deletion.deleteAccount(id);
      assert.equal(outcome.existed, false);
      assert.deepEqual(outcome.removed, zeroes, `removed must name every step with 0, got ${JSON.stringify(outcome.removed)}`);
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
  /*
   * The forced-failure check: without it the "one transaction" claim rests on reading the code;
   * with it the claim is demonstrated. The port takes an `afterStep` hook so a test can fail it
   * part-way; the hook THROWS mid-transaction, which is the ordinary case a real error produces,
   * and the check asserts the account is intact afterwards.
   *
   * The mode that used to live here (a hook that "made one later step a no-op" so the port's own
   * pre-COMMIT read-back would find a leftover) has been DELETED, because it could not pass for
   * the reason it claimed. Its INSERT ... SELECT $1, NULL hit a NOT NULL column (or, as this role
   * is actually granted, failed with 42501 first) - a throw, which the old assertion accepted,
   * making it indistinguishable from the `throw` mode. And the read-back it claimed to exercise
   * is unreachable from a hook in this schema, which the programme verified by construction:
   *   - `learner_settings` and `session` cascade from `"user"`, so a row re-inserted late is
   *     removed by step 11 and the read-back legitimately finds 0 (no exception);
   *   - every other owned table has an `NO ACTION` key into `"user"` or into a table already
   *     deleted, so a re-inserted row makes a LATER STEP fail with 23503 (a throw) before the
   *     read-back ever runs.
   * So the read-back stays as defensive code, and the guarantee that a partial delete cannot
   * commit comes from the FK backstop and the step ordering - which is what the comment in
   * adapter.mjs now says. Keeping a mode that passed for an unrelated reason would have been
   * worse than having no mode at all.
   */
  await check('a failure part-way through the deletion leaves the account INTACT, not half-deleted', async () => {
    const victim = await seed(call, 'FORCED'); // its own account, seeded through the API
    const snapshotBefore = await snapshot(victim.userId, [victim.revisionAttemptId]);
    assertPopulated(snapshotBefore, 'forced-failure victim');

    let threw = null;
    const hooked = createDeletion({
      pool: deletionPool,
      afterStep: async (index, name) => {
        if (index === 5) throw new Error(`forced failure after step 5 (${name})`);
      },
    });
    try {
      await hooked.deleteAccount(victim.userId);
    } catch (error) {
      threw = error;
    }
    assert.notEqual(threw, null, 'the deletion must FAIL rather than report success');

    const after = await snapshot(victim.userId, [victim.revisionAttemptId]);
    assert.deepEqual(after.counts, snapshotBefore.counts, 'every table must still hold exactly what it held before the failed deletion');

    return 'the forced failure rolled back: row counts identical to before, per table';
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
console.log('NOTE disposable PostgreSQL, synthetic accounts; the deletion role and its policies come from the same builders an installation provisions (migrations 0004/0005).');
process.exit(failed ? 1 : 0);

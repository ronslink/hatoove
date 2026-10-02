/**
 * WORKER-RUNNER-01 checker: proves the job runner over REAL PostgreSQL, through the REAL
 * adapter and the REAL owned API — with a DETERMINISTIC STUB GRADER and NO provider call.
 *
 * The runner's own step function is what this file calls (`runOnce()`, `reclaimExpired()`),
 * never a sleeping daemon: a stalled daemon would look like progress. One leg starts the
 * real CLI process (`server/worker.mjs --once`) and bounds it with a timeout.
 *
 * Legs (the dispatch's list):
 *   1. full pipeline: queued job + reserved=1 -> runOnce -> succeeded, assessment, reserved=0, used=1, result()
 *   2. idempotency: same event_id replays; no second job, no second debit
 *   3. retry path: a throwing grader -> failed with a stable code, reservation released, retry() re-queues, tries preserved
 *   4. retry limit: retry() refuses at tries>=3 — showing the near side (tries=2 retries) and the far side
 *   5. lease fence: A claims, lease lapses, B claims+completes, A's commit is refused; exactly one assessment, B's
 *   6. reclaimExpired(): lapsed job -> queued; lapsed job past maxTries -> failed retry_exhausted with reserved released
 *   7. concurrency: two runOnce() against one queued job -> exactly one claims (assert the job AND assessment counts)
 *   8. control: with nothing queued, runOnce() returns {claimed:false} and writes nothing
 *
 * Extra legs: the CLI is a real process; the CLI refuses without database configuration.
 *
 * Usage:
 *   node tools/worker-runner-check.mjs            (needs a disposable DB; OWNAPI_PG_*)
 *   node tools/worker-runner-check.mjs --list
 *   node tools/worker-runner-check.mjs --only=lease
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { createFixture } from '../server/owned-postgres/bootstrap.mjs';
import { createPostgresWorld } from '../server/owned-postgres/fixture.mjs';
import { createWorker, stubGrade } from '../server/owned-postgres/worker.mjs';

/* =============================================================== the world */

const db = await createFixture();
let world = null;

async function teardown() {
  if (world) await world.teardown().catch(() => {});
  else await db.cleanup().catch(() => {});
}

/** Superuser read path (RLS bypassed) — the read-back that makes "no rows" mean gone. */
const rows = async (sql, params) => (await db.admin.query(sql, params)).rows;
const one = async (sql, params) => (await rows(sql, params))[0];

const jobRow = (submissionId) => one('SELECT * FROM jobs WHERE submission_id = $1', [submissionId]);
const assessmentCount = async (submissionId) =>
  (await one('SELECT count(*)::int AS n FROM assessments WHERE submission_id = $1', [submissionId])).n;
const assessmentOf = (submissionId) => one('SELECT * FROM assessments WHERE submission_id = $1', [submissionId]);
const ledgerOf = (submissionId) => one('SELECT * FROM usage_ledger WHERE submission_id = $1', [submissionId]);
const entitlement = (owner) => one('SELECT * FROM entitlements WHERE owner_id = $1', [owner]);
const jobCountFor = async (owner) => (await one('SELECT count(*)::int AS n FROM jobs WHERE owner_id = $1', [owner])).n;
const queuedCount = async () =>
  (await one("SELECT count(*)::int AS n FROM jobs WHERE status = 'queued'")).n;

/* ------------------------------------------------------------- HTTP caller */

function cookieOf(response) {
  const header = response.headers['set-cookie'];
  if (!header) return null;
  const pair = String(Array.isArray(header) ? header[0] : header).split(';')[0];
  return pair.endsWith('=') ? null : pair;
}

function caller(api) {
  return async (method, pathName, { cookie, body } = {}) => {
    const headers = { accept: 'application/json' };
    if (cookie) headers.cookie = cookie;
    if (method !== 'GET') headers['content-type'] = 'application/json';
    const response = await api.handle({
      method, path: pathName, headers, originChecked: true,
      body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
    });
    let json = null;
    try { json = JSON.parse(response.body); } catch { /* not JSON */ }
    return { status: response.status, json, headers: response.headers };
  };
}

async function signUp(call, tag) {
  const email = `${tag}-${randomUUID().slice(0, 8)}@worker-check.invalid`;
  const password = `pw-${randomUUID()}`;
  const res = await call('POST', '/api/auth/sign-up/email', { body: { name: `Synthetic ${tag}`, email, password } });
  assert.equal(res.status, 200, `sign-up ${tag}: ${res.status}`);
  const cookie = cookieOf(res);
  const who = await call('GET', '/api/v1/account', { cookie });
  return { cookie, userId: who.json.id, email };
}

/** One submitted attempt through the real API; returns the ids an assertion needs. */
async function submit(call, cookie, text, eventId = randomUUID()) {
  const created = await call('POST', '/api/v1/attempts', { cookie, body: {} });
  assert.equal(created.status, 201, `create: ${created.status}`);
  const saved = await call('PUT', `/api/v1/attempts/${created.json.id}`, { cookie, body: { expectedRevision: 1, text } });
  assert.equal(saved.status, 200, `save: ${saved.status}`);
  const sent = await call('POST', `/api/v1/attempts/${created.json.id}/submissions`,
    { cookie, body: { expectedRevision: 2, eventId } });
  assert.equal(sent.status, 202, `submit: ${sent.status}`);
  return { attemptId: created.json.id, submissionId: sent.json.submissionId, eventId, receipt: sent.json };
}

/* ----------------------------------------------------------------- clocks */

/** A mutable clock so a lease can be advanced without sleeping. */
function makeClock(start = Date.now()) {
  let current = start;
  return { now: () => new Date(current), advance: (ms) => { current += ms; } };
}

/** A grade that never settles — the worker holds a lease and (correctly) never commits. */
const hangingGrade = () => new Promise(() => {});

/* ---------------------------------------------------------------- harness */

const checks = [];
const check = (name, run) => checks.push({ name, run });

/** Bounded wait for a condition (never sleep unboundedly). */
async function until(fn, { timeoutMs = 5000, stepMs = 10 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await fn()) return true;
    if (Date.now() > deadline) throw new Error('condition not met within the bounded wait');
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

/**
 * Start a runOnce() whose grade is meant to hang, and swallow nothing: a rejection here is a
 * defect, so it is recorded and asserted on rather than left as an unhandled rejection.
 */
const floated = [];
function float(promise) {
  promise.catch((error) => floated.push(error));
  return promise;
}
function assertNoFloatedErrors() {
  assert.deepEqual(floated, [], `a background runOnce rejected: ${floated.map((e) => e && e.message).join('; ')}`);
}

/**
 * Drain any queued job left by an earlier leg with the default (stub) grader, so a leg that
 * asserts on ITS OWN submission is not fooled by an older one — the worker claims the oldest
 * queued job globally. Bounded, so it cannot hang.
 */
async function drain(max = 25) {
  const worker = createWorker({ pool: db.worker });
  for (let i = 0; i < max; i += 1) {
    const outcome = await worker.runOnce();
    if (!outcome.claimed) return;
  }
  throw new Error('queue did not drain within the bounded count');
}

/* ================================================================== legs */

check('1. full pipeline: submit debits once, runOnce grades, result() returns the assessment', async () => {
  const call = caller(world.api);
  const a = await signUp(call, 'p1');
  const s = await submit(call, a.cookie, 'Liebe Frau Weber, ich schreibe Ihnen wegen eines Termins.');

  const before = await jobRow(s.submissionId);
  assert.equal(before.status, 'queued', 'a fresh submission is queued');
  assert.equal(before.tries, 0);
  const entBefore = await entitlement(a.userId);
  assert.equal(entBefore.reserved, 1, 'submit reserves exactly one allowance');
  assert.equal(entBefore.used, 0);
  assert.equal(await assessmentCount(s.submissionId), 0, 'nothing is graded until the runner runs');

  const worker = createWorker({ pool: db.worker });
  const outcome = await worker.runOnce();
  assert.deepEqual(outcome, { claimed: true, submissionId: s.submissionId, outcome: 'succeeded' });

  const after = await jobRow(s.submissionId);
  assert.equal(after.status, 'succeeded');
  assert.equal(after.tries, 1, 'claiming increments tries');
  assert.equal(after.lease_token, null, 'the lease is released on commit');
  assert.equal(after.lease_until, null);
  assert.equal(await assessmentCount(s.submissionId), 1, 'exactly one assessment');
  assert.equal((await ledgerOf(s.submissionId)).units, 1, 'exactly one usage_ledger unit');
  const entAfter = await entitlement(a.userId);
  assert.equal(entAfter.reserved, 0, 'the reservation becomes a debit, not both');
  assert.equal(entAfter.used, 1);

  const result = await call('GET', `/api/v1/submissions/${s.submissionId}`, { cookie: a.cookie });
  assert.equal(result.status, 200);
  assert.equal(result.json.job.status, 'succeeded');
  assert.deepEqual(result.json.assessment.feedback, stubGrade().feedback, 'the injected stub grader is the source');
  return `queued->succeeded; reserved=1->0, used=0->1; assessment rows=1; result() served the stub assessment`;
});

check('2. idempotency: a replayed event_id creates no second job and no second debit', async () => {
  const call = caller(world.api);
  const a = await signUp(call, 'p2');
  const s = await submit(call, a.cookie, 'Text für den Idempotenz-Test.');
  const jobsBefore = await jobCountFor(a.userId);
  const entBefore = await entitlement(a.userId);

  const again = await call('POST', `/api/v1/attempts/${s.attemptId}/submissions`,
    { cookie: a.cookie, body: { expectedRevision: 2, eventId: s.eventId } });
  assert.equal(again.status, 202);
  assert.deepEqual(again.json, { submissionId: s.submissionId, replay: true });

  assert.equal(await jobCountFor(a.userId), jobsBefore, 'no second job row');
  assert.equal(await assessmentCount(s.submissionId), 0, 'a replay does not grade');
  const entAfter = await entitlement(a.userId);
  assert.deepEqual([entAfter.reserved, entAfter.used], [entBefore.reserved, entBefore.used], 'no second debit');

  await createWorker({ pool: db.worker }).runOnce(); // make it terminal for the control leg
  return `replay:true; jobs for owner stayed ${jobsBefore}; reserved stayed ${entBefore.reserved}`;
});

check('3. retry path: a throwing grader fails with a stable code, releases the reservation, and retry() re-queues', async () => {
  const call = caller(world.api);
  await drain();
  const a = await signUp(call, 'p3');
  const s = await submit(call, a.cookie, 'Text für den Wiederholungs-Test.');

  const throwing = () => { const error = new Error('stub grader unavailable'); error.code = 'grader_unavailable'; throw error; };
  const worker = createWorker({ pool: db.worker, grade: throwing });
  const outcome = await worker.runOnce();
  assert.deepEqual(outcome, { claimed: true, submissionId: s.submissionId, outcome: 'failed', code: 'grader_unavailable' });

  const failed = await jobRow(s.submissionId);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.failure_code, 'grader_unavailable', 'a stable failure_code, from the grader');
  assert.equal(failed.tries, 1);
  assert.equal((await entitlement(a.userId)).reserved, 0, 'a failure refunds the reservation');
  assert.equal(await assessmentCount(s.submissionId), 0);

  const retried = await call('POST', `/api/v1/submissions/${s.submissionId}/retry`, { cookie: a.cookie, body: {} });
  assert.equal(retried.status, 202);
  assert.deepEqual(retried.json, { queued: true });
  const requeued = await jobRow(s.submissionId);
  assert.equal(requeued.status, 'queued');
  assert.equal(requeued.failure_code, null);
  assert.equal(requeued.tries, 1, 'retry preserves the try count');
  assert.equal((await entitlement(a.userId)).reserved, 1, 'retry reserves again');
  return `failed(${failed.failure_code}) then re-queued with tries=${requeued.tries}, reserved refunded then re-reserved`;
});

/*
 * 3b. AN ASSESSMENT CARRYING A SCORE, A TOTAL OR A PASS BAND IS REFUSED — NOT STORED.
 *
 * The rubric contract is OPEN (MASTER-PLAN D4 / R11): a separately versioned three-criterion contract or
 * honestly labelled provisional four-criterion internal feedback, and the decision notes say the two must
 * never be renormalised into each other. PILOT-06's result schema is blocked on it.
 *
 * While it is open, the risk is not that someone picks the WRONG one — it is that the shape arrives
 * through the data layer, where no screen check can see it. `completeSuccess` stored `assessment.feedback`
 * verbatim, so a grader (or a provider adapter) returning `{total: 35}`, `{bestanden: true}` or
 * `criteria: [{score: 12}]` would have been written to `assessments`, served by `result()`, and rendered
 * by any UI as if the contract had been decided. That is a fabricated assessment: the "no /45, no
 * pass line" rule is a RED-LINE product rule, and a negative check at the point of storage is the only
 * place it can be enforced for every future client.
 *
 * The control case is in the same leg on purpose: the shipped stub must PASS this validator, so the leg
 * cannot be satisfied by a validator that refuses everything.
 */
check('3b. an assessment carrying a score, a total or a pass band fails the job and is never stored', async () => {
  const call = caller(world.api);
  await drain();
  const refused = [
    ['a total', { feedback: { kind: 'formative', comment: 'ok', total: 35 } }],
    ['a /45 fraction', { feedback: { kind: 'formative', comment: 'ok', score: '35/45' } }],
    ['per-criterion scores', { feedback: { kind: 'formative', criteria: [{ key: 'aufgabe', score: 12 }] } }],
    ['a pass verdict', { feedback: { kind: 'formative', comment: 'ok', bestanden: true } }],
    ['a bare number as the whole feedback', { feedback: 35 }],
    ['a top-level score beside the feedback', { feedback: { kind: 'formative', comment: 'ok' }, total: 35 }],
  ];
  const seen = [];
  for (const [what, assessment] of refused) {
    const a = await signUp(call, 'p3b');
    const s = await submit(call, a.cookie, 'Text für die Assessment-Form.');
    const outcome = await createWorker({ pool: db.worker, grade: () => assessment }).runOnce();
    assert.equal(outcome.outcome, 'failed', `${what} must FAIL the job, got ${outcome.outcome}`);
    assert.equal(outcome.code, 'invalid_assessment', `${what} must fail with invalid_assessment, got ${outcome.code}`);
    assert.equal(await assessmentCount(s.submissionId), 0, `${what} must not be stored`);
    const job = await jobRow(s.submissionId);
    assert.equal(job.status, 'failed');
    assert.equal(job.failure_code, 'invalid_assessment');
    assert.equal((await entitlement(a.userId)).reserved, 0, `${what}: a refusal refunds the reservation`);
    seen.push(`${what}->${outcome.code}`);
  }

  // THE CONTROL: the shipped stub is accepted, so this validator is not refusing everything.
  const control = await signUp(call, 'p3c');
  const controlSubmission = await submit(call, control.cookie, 'Kontrolltext für den Stub.');
  const ok = await createWorker({ pool: db.worker }).runOnce();
  assert.equal(ok.outcome, 'succeeded', `the shipped stub must still grade, got ${ok.outcome}`);
  assert.equal(await assessmentCount(controlSubmission.submissionId), 1, 'the stub assessment is stored');
  return `refused ${refused.length} fabricated shapes (${seen.join(', ')}) with a refund and nothing stored; the shipped stub still succeeds`;
});

check('4. retry limit: retry() works at tries=2 and is refused at tries=3 (the boundary, not just the far side)', async () => {
  const call = caller(world.api);
  await drain();
  const a = await signUp(call, 'p4');
  const s = await submit(call, a.cookie, 'Text für das Wiederholungslimit.');
  const throwing = () => { const error = new Error('stub grader unavailable'); error.code = 'grader_unavailable'; throw error; };
  const worker = createWorker({ pool: db.worker, grade: throwing });

  // tries 1
  await worker.runOnce();
  assert.equal((await jobRow(s.submissionId)).tries, 1);
  assert.equal((await call('POST', `/api/v1/submissions/${s.submissionId}/retry`, { cookie: a.cookie, body: {} })).status, 202);

  // tries 2 — the NEAR side of the boundary: still retryable
  await worker.runOnce();
  assert.equal((await jobRow(s.submissionId)).tries, 2);
  const near = await call('POST', `/api/v1/submissions/${s.submissionId}/retry`, { cookie: a.cookie, body: {} });
  assert.equal(near.status, 202, 'tries=2 must still be retryable');

  // tries 3 — the FAR side: refused
  await worker.runOnce();
  assert.equal((await jobRow(s.submissionId)).tries, 3);
  const far = await call('POST', `/api/v1/submissions/${s.submissionId}/retry`, { cookie: a.cookie, body: {} });
  assert.equal(far.status, 409, 'tries>=3 must be refused');
  assert.deepEqual(far.json, { error: 'retry_unavailable' });
  return `retry at tries=1 -> 202, tries=2 -> 202 (near side), tries=3 -> 409 retry_unavailable (far side)`;
});

check('5. lease fence: a worker whose lease lapsed cannot commit; the assessment is B\'s and there is exactly one', async () => {
  const call = caller(world.api);
  await drain();
  const a = await signUp(call, 'p5');
  const s = await submit(call, a.cookie, 'Text für die Lease-Fence.');
  const clock = makeClock();

  let releaseA = null;
  const gatedA = () => new Promise((resolve) => { releaseA = resolve; });
  const workerA = createWorker({ pool: db.worker, grade: gatedA, now: clock.now, leaseMs: 60000 });

  // A claims and starts grading; its grade is held open, so it has not committed yet.
  const pendingA = workerA.runOnce();
  await until(async () => (await jobRow(s.submissionId)).status === 'running');
  assert.equal((await jobRow(s.submissionId)).status, 'running', 'A holds the job');

  // A's lease lapses and B reclaims, claims and completes the job with a distinguishable assessment.
  clock.advance(120000);
  const workerB = createWorker({ pool: db.worker, now: clock.now, leaseMs: 60000, grade: () => ({ feedback: { kind: 'synthetic-formative', comment: 'B committed this.' }, modelVersion: 'stub-B', promptVersion: 'stub-B' }) });
  const reclaimed = await workerB.reclaimExpired();
  assert.equal(reclaimed.requeued, 1, 'the lapsed lease returns the job to queued');
  const bOutcome = await workerB.runOnce();
  assert.deepEqual(bOutcome, { claimed: true, submissionId: s.submissionId, outcome: 'succeeded' });

  // Now A's grade resolves. Its token is stale, so the fence must refuse the commit.
  releaseA({ feedback: { kind: 'synthetic-formative', comment: 'A is stale and must not win.' }, modelVersion: 'stub-A', promptVersion: 'stub-A' });
  const aOutcome = await pendingA;
  assert.deepEqual(aOutcome, { claimed: true, submissionId: s.submissionId, outcome: 'stale' }, 'A must not commit');

  assert.equal(await assessmentCount(s.submissionId), 1, 'exactly one assessment');
  const assessment = await assessmentOf(s.submissionId);
  assert.equal(assessment.feedback.comment, 'B committed this.', "the surviving assessment is B's, not A's");
  assert.equal(assessment.model_version, 'stub-B');
  // And the debit is B's single one, not two.
  const ent = await entitlement(a.userId);
  assert.deepEqual([ent.reserved, ent.used], [0, 1]);
  assert.equal((await jobRow(s.submissionId)).status, 'succeeded');
  return `A stale (refused); B succeeded; assessments=1 (B's); reserved=0 used=1`;
});

check('6. reclaimExpired(): lapsed -> queued, and lapsed past maxTries -> failed retry_exhausted with reserved released', async () => {
  const call = caller(world.api);
  await drain();

  // (a) an abandoned job returns to queued and keeps its reservation for the retry
  const a = await signUp(call, 'p6a');
  const s1 = await submit(call, a.cookie, 'Abandoned then requeued.');
  const clock1 = makeClock();
  const hanging1 = createWorker({ pool: db.worker, grade: hangingGrade, now: clock1.now, leaseMs: 60000 });
  float(hanging1.runOnce()); // claimed; never commits (the grade hangs)
  await until(async () => (await jobRow(s1.submissionId)).status === 'running');
  assert.equal((await jobRow(s1.submissionId)).status, 'running');
  clock1.advance(120000);
  const first = await hanging1.reclaimExpired();
  assert.deepEqual(first, { requeued: 1, abandoned: 0 });
  assertNoFloatedErrors();
  const requeued = await jobRow(s1.submissionId);
  assert.equal(requeued.status, 'queued');
  assert.equal(requeued.lease_token, null);
  assert.equal(requeued.lease_until, null);
  assert.equal((await entitlement(a.userId)).reserved, 1, 'a requeued job keeps its reservation (still owed)');
  await createWorker({ pool: db.worker }).runOnce(); // finish it so the control leg starts clean

  // (b) an abandoned job at maxTries is failed and its reservation released
  const b = await signUp(call, 'p6b');
  const s2 = await submit(call, b.cookie, 'Abandoned until exhausted.');
  const clock2 = makeClock();
  const hanging2 = createWorker({ pool: db.worker, grade: hangingGrade, now: clock2.now, leaseMs: 60000 });
  // Three claims, each abandoned while the lease lapses, driving tries to maxTries.
  for (let i = 0; i < 3; i += 1) {
    const before = (await jobRow(s2.submissionId)).tries;
    float(hanging2.runOnce());
    await until(async () => (await jobRow(s2.submissionId)).tries === before + 1);
    clock2.advance(120000);
    await hanging2.reclaimExpired();
  }
  const exhausted = await jobRow(s2.submissionId);
  assert.equal(exhausted.status, 'failed', 'past maxTries the job is failed, not requeued');
  assert.equal(exhausted.failure_code, 'retry_exhausted');
  assert.equal(exhausted.tries, 3);
  assert.equal(exhausted.lease_token, null);
  assert.equal((await entitlement(b.userId)).reserved, 0, 'abandonment releases the reservation');
  assert.equal((await entitlement(b.userId)).used, 0, 'and does not debit it');
  assertNoFloatedErrors();
  return `(a) lapsed -> queued, reserved kept=1; (b) tries=3 -> failed retry_exhausted, reserved released=0`;
});

check('7. concurrency: two runOnce() against one queued job — exactly one claims, exactly one assessment', async () => {
  const call = caller(world.api);
  await drain();
  const a = await signUp(call, 'p7');
  const s = await submit(call, a.cookie, 'Text für die Nebenläufigkeit.');
  const jobsBefore = await jobCountFor(a.userId);

  const clock = makeClock();
  const workerA = createWorker({ pool: db.worker, now: clock.now });
  const workerB = createWorker({ pool: db.worker, now: clock.now });
  const [outcomeA, outcomeB] = await Promise.all([workerA.runOnce(), workerB.runOnce()]);

  const claimed = [outcomeA, outcomeB].filter((o) => o.claimed);
  const idle = [outcomeA, outcomeB].filter((o) => !o.claimed);
  assert.equal(claimed.length, 1, `exactly one runOnce must claim; got ${JSON.stringify([outcomeA, outcomeB])}`);
  assert.equal(idle.length, 1);
  assert.equal(await assessmentCount(s.submissionId), 1, 'exactly one assessment (not one per caller)');
  assert.equal(await jobCountFor(a.userId), jobsBefore, 'no extra job row');
  assert.equal((await entitlement(a.userId)).used, 1, 'exactly one debit');
  return `claims=1 (${claimed[0].outcome}), idle=1; assessments=1; jobs unchanged`;
});

check('8. control: with nothing queued, runOnce() returns {claimed:false} and writes nothing', async () => {
  assert.equal(await queuedCount(), 0, 'precondition: no queued job exists at this point');
  const fingerprint = JSON.stringify(await rows(
    `SELECT (SELECT count(*) FROM jobs) AS jobs, (SELECT count(*) FROM assessments) AS assessments,
            (SELECT count(*) FROM usage_ledger) AS ledger, (SELECT coalesce(sum(used),0) FROM entitlements) AS used,
            (SELECT coalesce(sum(reserved),0) FROM entitlements) AS reserved`));
  const outcome = await createWorker({ pool: db.worker }).runOnce();
  assert.deepEqual(outcome, { claimed: false });
  const after = JSON.stringify(await rows(
    `SELECT (SELECT count(*) FROM jobs) AS jobs, (SELECT count(*) FROM assessments) AS assessments,
            (SELECT count(*) FROM usage_ledger) AS ledger, (SELECT coalesce(sum(used),0) FROM entitlements) AS used,
            (SELECT coalesce(sum(reserved),0) FROM entitlements) AS reserved`));
  assert.equal(after, fingerprint, 'an idle runOnce changes nothing');
  return 'claimed:false; jobs/assessments/ledger/used/reserved unchanged';
});

/* ------------------------------------------------------- extra: the CLI */

check('X1. server/worker.mjs --once is a real process that drains one queued job as the worker role', async () => {
  const call = caller(world.api);
  await drain();
  const a = await signUp(call, 'pcli');
  const s = await submit(call, a.cookie, 'Text für die echte Prozess-Ausführung.');
  assert.equal((await jobRow(s.submissionId)).status, 'queued');

  const cliPath = path.resolve(fileURLToPath(new URL('../server/worker.mjs', import.meta.url)));
  const env = {
    ...process.env,
    OWNAPI_PG_HOST: db.config.host,
    OWNAPI_PG_PORT: String(db.config.port),
    OWNAPI_PG_DATABASE: db.config.database,
    OWNAPI_PG_USER: db.config.user,
    OWNAPI_PG_SCHEMA: db.schema,
    OWNAPI_PG_ROLE_PREFIX: db.schema, // fixture roles are `${schema}_worker`
  };
  const { code, stdout, stderr } = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, '--once'], { env, cwd: path.dirname(cliPath) + '/..' });
    let out = ''; let err = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('worker CLI did not exit within 20s')); }, 20000);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', reject);
    child.on('close', (exit) => { clearTimeout(timer); resolve({ code: exit, stdout: out, stderr: err }); });
  });
  assert.equal(code, 0, `CLI exit ${code}; stderr: ${stderr}`);
  assert.match(stdout, /worker: succeeded/, `CLI stdout: ${stdout}`);
  assert.doesNotMatch(stdout + stderr, /password|PGPASSWORD|secret/i, 'the CLI must print no credential');
  assert.equal((await jobRow(s.submissionId)).status, 'succeeded', 'the real process graded the job');
  assert.equal(await assessmentCount(s.submissionId), 1);
  return `child exit 0; stdout: ${stdout.trim().split('\n').pop()}`;
});

check('X2. the CLI refuses to start without database configuration and prints no credential', async () => {
  const cliPath = path.resolve(fileURLToPath(new URL('../server/worker.mjs', import.meta.url)));
  const env = { ...process.env };
  delete env.OWNAPI_PG_DATABASE;
  delete env.OWNAPI_PG_USER;
  const { code, stdout, stderr } = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath], { env, cwd: path.dirname(cliPath) + '/..' });
    let out = ''; let err = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('worker CLI did not exit within 20s')); }, 20000);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', reject);
    child.on('close', (exit) => { clearTimeout(timer); resolve({ code: exit, stdout: out, stderr: err }); });
  });
  assert.notEqual(code, 0, 'the CLI must not start without configuration');
  assert.match(stderr, /refusing to start without database configuration/);
  assert.match(stderr, /OWNAPI_PG_DATABASE/);
  return `child exit ${code}; refused naming the missing variables, no credential printed`;
});

/* =================================================================== run */

export const REQUIRED_CHECKS = checks.map((c) => c.name);

export async function runWorkerRunnerChecks({ only = null } = {}) {
  const selected = only ? checks.filter((c) => c.name.includes(only)) : checks;
  const report = [];
  try {
    world = await createPostgresWorld({ fixture: db });
    for (const { name, run } of selected) {
      try {
        const detail = await run();
        report.push({ name, ok: true, detail });
      } catch (error) {
        report.push({ name, ok: false, detail: error && error.message ? error.message.split('\n')[0] : String(error), error });
      }
    }
  } finally {
    await teardown();
  }
  return { ok: report.every((r) => r.ok), results: report };
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  if (process.argv.includes('--list')) {
    for (const { name } of checks) console.log(name);
    process.exitCode = 0;
  } else {
    const onlyArg = process.argv.find((a) => a.startsWith('--only='));
    const only = onlyArg ? onlyArg.slice('--only='.length) : null;
    const report = await runWorkerRunnerChecks({ only });
    for (const r of report.results) {
      console.log(`${r.ok ? 'PASS' : 'FAIL'} ${r.name}${r.ok ? `\n     ${r.detail}` : `\n     ${r.detail}`}`);
      if (!r.ok && r.error && r.error.stack) console.log(r.error.stack.split('\n').slice(1, 4).join('\n'));
    }
    const failed = report.results.filter((r) => !r.ok).length;
    console.log(`\n${report.results.length - failed} passed, ${failed} failed`);
    console.log('NOTE disposable PostgreSQL, real adapter and API; the grader is a deterministic stub (no provider call).');
    process.exitCode = failed ? 1 : 0;
  }
}

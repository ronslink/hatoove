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
import { TELC_B1_WRITING_RUBRIC } from '../server/owned-postgres/content-seed.mjs';
import { INITIAL_EXAM_ID } from '../server/preparation-contract.mjs';

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
/** The (owner, exam) balance. EXAM-S1: every account here registered for telc only. */
const entitlement = (owner, examId = INITIAL_EXAM_ID) =>
  one('SELECT * FROM entitlements WHERE owner_id = $1 AND exam_id = $2', [owner, examId]);
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
  // EXAM-S1: the registered preparation travels with the cookie, so every attempt below names it.
  const preps = (await call('GET', '/api/v1/preparations', { cookie })).json.preparations.filter((p) => p.state === 'active');
  assert.equal(preps.length, 1, `sign-up ${tag}: one active preparation`);
  return { cookie, userId: who.json.id, preparationId: preps[0].id, email };
}

/** One submitted attempt through the real API, in the account's own preparation; returns the ids an assertion needs. */
async function submit(call, account, text, eventId = randomUUID()) {
  const { cookie, preparationId } = account;
  const created = await call('POST', '/api/v1/attempts', { cookie, body: { preparationId } });
  assert.equal(created.status, 201, `create: ${created.status} ${JSON.stringify(created.json)}`);
  assert.equal(created.json.preparation_id, preparationId);
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
  const s = await submit(call, a, 'Liebe Frau Weber, ich schreibe Ihnen wegen eines Termins.');

  const before = await jobRow(s.submissionId);
  assert.equal(before.status, 'queued', 'a fresh submission is queued');
  assert.equal(before.tries, 0);
  assert.equal(before.exam_id, INITIAL_EXAM_ID, "the job records the attempt's exam as the balance it reserved from");
  const entBefore = await entitlement(a.userId);
  assert.equal(entBefore.reserved, 1, 'submit reserves exactly one allowance');
  assert.equal(entBefore.used, 0);
  assert.equal(await assessmentCount(s.submissionId), 0, 'nothing is graded until the runner runs');

  /*
   * THE STUB NEEDS ITS INPUT. `stubGrade()` with no arguments produces EMPTY evidence, and the band
   * validator refuses evidence that is not a quote from the learner's text — correctly, since that is the
   * rule that makes the evidence worth reading. So a grader in a test must be handed the input the worker
   * passes, exactly as the shipped default is.
   */
  const worker = createWorker({ pool: db.worker, grade: (input) => stubGrade(input) });
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
  assert.deepEqual([result.json.preparation_id, result.json.exam_id], [a.preparationId, INITIAL_EXAM_ID], 'the result carries its context');
  // The assertion below compares against the SAME shape the injected grader produced, from the same input.
  assert.deepEqual(result.json.assessment.feedback,
    stubGrade({ text: 'Liebe Frau Weber, ich schreibe Ihnen wegen eines Termins.' }).feedback,
    'the injected stub grader is the source');
  return `queued->succeeded; reserved=1->0, used=0->1; assessment rows=1; result() served the stub assessment`;
});

check('2. idempotency: a replayed event_id creates no second job and no second debit', async () => {
  const call = caller(world.api);
  const a = await signUp(call, 'p2');
  const s = await submit(call, a, 'Text für den Idempotenz-Test.');
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
  const s = await submit(call, a, 'Text für den Wiederholungs-Test.');

  const throwing = () => { const error = new Error('stub grader unavailable'); error.code = 'grader_unavailable'; throw error; };
  const worker = createWorker({ pool: db.worker, grade: throwing });
  const outcome = await worker.runOnce();
  assert.deepEqual(outcome, { claimed: true, submissionId: s.submissionId, outcome: 'failed', code: 'grader_error' });

  const failed = await jobRow(s.submissionId);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.failure_code, 'grader_error', 'a fixed failure code without copying the grader-supplied value');
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
    const s = await submit(call, a, 'Text für die Assessment-Form.');
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
  const controlSubmission = await submit(call, control, 'Kontrolltext für den Stub.');
  const ok = await createWorker({ pool: db.worker }).runOnce();
  assert.equal(ok.outcome, 'succeeded', `the shipped stub must still grade, got ${ok.outcome}`);
  assert.equal(await assessmentCount(controlSubmission.submissionId), 1, 'the stub assessment is stored');
  return `refused ${refused.length} fabricated shapes (${seen.join(', ')}) with a refund and nothing stored; the shipped stub still succeeds`;
});

/*
 * 3c. THE telc B1 RUBRIC, ON THE WIRE: ONE BAND PER CRITERION, EVIDENCE QUOTED, NO NUMBERS.
 *
 * Ron's D4/R11 answer made the writing feedback follow the exam's own marking structure. The stored
 * assessment is therefore not a comment any more: it is one BAND per criterion, with the evidence QUOTED
 * from the learner's own text, a comment in the language the letter was written under, and a list of
 * corrections.
 *
 * TWO ASSERTIONS HERE ARE THE WHOLE CONTRACT:
 *   * `evidence` must be a SUBSTRING of the submitted text. A grader that invents evidence is inventing the
 *     reason for the band, and the learner can see the quote next to their own sentence.
 *   * NOTHING NUMERIC may be stored. R15 — whether to show bands only or also a total out of 45 — is still
 *     open, and storing a number would decide it by accident. The scan walks the whole feedback object.
 */
check('3c. the telc rubric: one band per criterion, evidence quoted from the text, and no numbers', async () => {
  const call = caller(world.api);
  await drain();
  const a = await signUp(call, 'p3c');
  const text = 'Liebe Anna, ich freue mich über deinen Besuch. Am Samstag habe ich Zeit. Wir können ins Museum gehen.';
  const s = await submit(call, a,text);

  const outcome = await createWorker({ pool: db.worker }).runOnce();
  assert.equal(outcome.outcome, 'succeeded',
    `the SHIPPED stub must produce the band shape (got ${outcome.outcome}${outcome.code ? ' ' + outcome.code : ''})`);

  const row = await assessmentOf(s.submissionId);
  const feedback = row.feedback;
  assert.equal(feedback.kind, 'telc-b1-bands', 'the assessment names the contract it satisfies');
  assert.deepEqual(row.rubric_version, 'v1');

  const expected = TELC_B1_WRITING_RUBRIC.criteria.map((c) => c.key).sort();
  const seen = feedback.criteria.map((c) => c.key).sort();
  assert.deepEqual(seen, expected, `exactly the rubric's criteria, once each (got ${seen.join(', ')})`);
  assert.equal(feedback.criteria.length, expected.length, 'no duplicate criterion');

  for (const criterion of feedback.criteria) {
    assert.ok(['A', 'B', 'C', 'D'].includes(criterion.band), `${criterion.key}: band must be A-D, got ${criterion.band}`);
    assert.ok(typeof criterion.comment === 'string' && criterion.comment.trim().length > 0, `${criterion.key}: a comment`);
    assert.ok(typeof criterion.evidence === 'string' && criterion.evidence.trim().length > 0, `${criterion.key}: evidence`);
    assert.ok(text.includes(criterion.evidence),
      `${criterion.key}: evidence must be QUOTED from the learner's text, got ${JSON.stringify(criterion.evidence)}`);
  }
  assert.ok(Array.isArray(feedback.corrections), 'a corrections list');
  assert.ok(feedback.corrections.every((c) => typeof c === 'string' && c.trim().length > 0), 'corrections are non-empty strings');

  const numbers = [];
  const scan = (value, at) => {
    if (typeof value === 'number') numbers.push(at);
    else if (value && typeof value === 'object') for (const [key, inner] of Object.entries(value)) scan(inner, `${at}.${key}`);
  };
  scan(feedback, 'feedback');
  assert.deepEqual(numbers, [], `nothing numeric may be stored while R15 is open; found ${numbers.join(', ')}`);

  // AND THE LEARNER CAN READ IT: the same shape comes back from the API.
  const result = await call('GET', `/api/v1/submissions/${s.submissionId}`, { cookie: a.cookie });
  assert.equal(result.status, 200, result.text);
  assert.equal(result.json.assessment.feedback.kind, 'telc-b1-bands');
  assert.equal(result.json.assessment.feedback.criteria.length, expected.length);
  return `bands ${feedback.criteria.map((c) => `${c.key}=${c.band}`).join(' ')}; evidence quoted from the text; ${feedback.corrections.length} correction(s); no numeric field`;
});

/*
 * 3d. ANYTHING BUT ONE BAND PER CRITERION IS A CLASSIFIED FAILURE, NEVER A PARTIAL GRADE.
 *
 * The decision is explicit: "Missing, duplicate or unknown criteria, or a band outside A–D, makes the result
 * a classified failure ('Unbewertet', text preserved), never a partial grade." The same must hold for
 * evidence that is not a quote — an invented justification is as bad as an invented band — and for anything
 * numeric, which would pre-empt R15.
 */
check('3d. a band assessment that breaks the contract fails the job and stores nothing', async () => {
  const call = caller(world.api);
  await drain();
  const keys = TELC_B1_WRITING_RUBRIC.criteria.map((c) => c.key);
  const quote = 'Am Samstag habe ich Zeit.';
  const criterion = (key, band = 'B') => ({ key, band, evidence: quote, comment: 'Nachvollziehbar.' });
  const full = () => keys.map((key) => criterion(key));
  const cases = [
    ['a missing criterion', () => ({ criteria: full().slice(0, 2), corrections: [] })],
    ['a duplicated criterion', () => ({ criteria: [...full(), criterion(keys[0])], corrections: [] })],
    ['an unknown criterion', () => ({ criteria: [...full().slice(0, 2), criterion('ausdruck')], corrections: [] })],
    ['a band outside A-D', () => ({ criteria: [criterion(keys[0], 'E'), ...full().slice(1)], corrections: [] })],
    ['a lowercase band', () => ({ criteria: [criterion(keys[0], 'b'), ...full().slice(1)], corrections: [] })],
    ['a numeric band', () => ({ criteria: [{ ...criterion(keys[0]), band: 5 }, ...full().slice(1)], corrections: [] })],
    ['evidence that is NOT in the text', () => ({ criteria: [{ ...criterion(keys[0]), evidence: 'Dieser Satz steht nicht im Text.' }, ...full().slice(1)], corrections: [] })],
    ['a numeric total beside the bands', () => ({ ...{ criteria: full(), corrections: [] }, total: 35 })],
    ['corrections that are not strings', () => ({ criteria: full(), corrections: [7] })],
    ['a missing kind', () => ({ criteria: full(), corrections: [] })],
  ];
  const seen = [];
  for (const [what, build] of cases) {
    const a = await signUp(call, 'p3d');
    const s = await submit(call, a, `Text für ${what}. Am Samstag habe ich Zeit.`);
    const grade = () => ({ feedback: build(), modelVersion: 'test', promptVersion: 'test' });
    const outcome = await createWorker({ pool: db.worker, grade }).runOnce();
    assert.equal(outcome.outcome, 'failed', `${what}: must fail the job, got ${outcome.outcome}`);
    assert.equal(outcome.code, 'invalid_assessment', `${what}: stable code, got ${outcome.code}`);
    assert.equal(await assessmentCount(s.submissionId), 0, `${what}: nothing may be stored`);
    assert.equal((await entitlement(a.userId)).reserved, 0, `${what}: the reservation is refunded`);
    seen.push(what);
  }
  // THE CONTROL: the shipped stub passes the same gate, so this leg cannot be satisfied by refusing all.
  const control = await signUp(call, 'p3d-control');
  const controlSubmission = await submit(call, control, 'Kontrolltext. Am Samstag habe ich Zeit.');
  const ok = await createWorker({ pool: db.worker }).runOnce();
  assert.equal(ok.outcome, 'succeeded', `the shipped stub must still grade, got ${ok.outcome} ${ok.code || ''}`);
  assert.equal(await assessmentCount(controlSubmission.submissionId), 1);
  return `${cases.length} malformed assessments refused (${seen.length} distinct shapes) with nothing stored; the shipped stub still succeeds`;
});

/*
 * 3e. THE EXPLANATION LANGUAGE IS SNAPSHOTTED AT SUBMIT TIME.
 *
 * The decision says the per-criterion comment is written "in the job's snapshotted explanation language".
 * Snapshotted is the operative word: a learner who writes in Ukrainian and switches the setting to German
 * tomorrow must still have their letter marked with the language it was written under — otherwise the
 * feedback a learner reads depends on when they read it.
 */
check('3e. the explanation language is snapshotted at submit time and never rewritten', async () => {
  const call = caller(world.api);
  await drain();
  const a = await signUp(call, 'p3e');
  const settings = await call('GET', '/api/v1/settings', { cookie: a.cookie });
  const set = await call('PUT', '/api/v1/settings', {
    cookie: a.cookie, body: { expectedRevision: settings.json.revision, settings: { language: 'uk' } },
  });
  assert.equal(set.status, 200, `setting the explanation language: ${set.status} ${JSON.stringify(set.json)}`);

  const s = await submit(call, a, 'Текст для перевірки. Am Samstag habe ich Zeit.');
  let seen = null;
  const grade = (input) => { seen = input; return stubGrade(input); };
  const outcome = await createWorker({ pool: db.worker, grade }).runOnce();
  assert.equal(outcome.outcome, 'succeeded', `${outcome.outcome} ${outcome.code || ''}`);
  assert.equal(seen.explanationLanguage, 'uk', `the grader must receive the snapshotted language, got ${JSON.stringify(seen.explanationLanguage)}`);
  assert.equal(seen.rubricId, TELC_B1_WRITING_RUBRIC.rubricId, 'and which rubric it is marking against');

  // Switching the setting afterwards must not rewrite what the letter was written under.
  const changed = await call('PUT', '/api/v1/settings', {
    cookie: a.cookie, body: { expectedRevision: set.json.revision, settings: { language: 'de' } },
  });
  assert.equal(changed.status, 200, changed.text);
  const stored = await one('SELECT explanation_language FROM submissions WHERE id = $1', [s.submissionId]);
  assert.equal(stored.explanation_language, 'uk', 'the submission keeps the language it was submitted under');
  return 'grader received uk; the stored snapshot stayed uk after the learner switched to de';
});

check('4. retry limit: retry() works at tries=2 and is refused at tries=3 (the boundary, not just the far side)', async () => {
  const call = caller(world.api);
  await drain();
  const a = await signUp(call, 'p4');
  const s = await submit(call, a, 'Text für das Wiederholungslimit.');
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
  const s = await submit(call, a, 'Text für die Lease-Fence.');
  const clock = makeClock();

  let releaseA = null;
  const gatedA = () => new Promise((resolve) => { releaseA = resolve; });
  const workerA = createWorker({ pool: db.worker, grade: gatedA, now: clock.now, leaseMs: 60000 });

  // A claims and starts grading; its grade is held open, so it has not committed yet.
  const pendingA = workerA.runOnce();
  await until(async () => (await jobRow(s.submissionId)).status === 'running');
  assert.equal((await jobRow(s.submissionId)).status, 'running', 'A holds the job');
  // Claim visibility precedes asynchronous pre-grader transactions. Grade entry proves those locks are released.
  await until(() => typeof releaseA === 'function');

  // A's lease lapses and B reclaims, claims and completes the job with a distinguishable assessment.
  clock.advance(120000);
  const workerB = createWorker({ pool: db.worker, now: clock.now, leaseMs: 60000, grade: (input) => ({ ...stubGrade(input), modelVersion: 'stub-B', promptVersion: 'stub-B' }) });
  const reclaimed = await workerB.reclaimExpired();
  assert.equal(reclaimed.requeued, 1, 'the lapsed lease returns the job to queued');
  const bOutcome = await workerB.runOnce();
  assert.deepEqual(bOutcome, { claimed: true, submissionId: s.submissionId, outcome: 'succeeded' });

  // Now A's grade resolves. Its token is stale, so the fence must refuse the commit.
  /*
   * A's assessment must still be a VALID one: the shape gate runs BEFORE the fence check, so an invalid
   * shape would fail the job ('failed') instead of being refused as stale — and the leg would then be
   * asserting the wrong refusal. Built from the same stub and the same text, so it is valid by construction.
   */
  releaseA({ ...stubGrade({ text: 'Text für die Lease-Fence.' }), modelVersion: 'stub-A', promptVersion: 'stub-A' });
  const aOutcome = await pendingA;
  assert.deepEqual(aOutcome, { claimed: true, submissionId: s.submissionId, outcome: 'stale' }, 'A must not commit');

  assert.equal(await assessmentCount(s.submissionId), 1, 'exactly one assessment');
  const assessment = await assessmentOf(s.submissionId);
  assert.equal(assessment.model_version, 'stub-B', "the surviving assessment is B's, not A's");
  assert.equal(assessment.feedback.kind, 'telc-b1-bands', 'and it is a complete band assessment');
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
  const s1 = await submit(call, a, 'Abandoned then requeued.');
  const clock1 = makeClock();
  let gradeCalls1 = 0;
  const hanging1 = createWorker({ pool: db.worker, grade: (input) => {
    assert.equal(input.submissionId, s1.submissionId);
    gradeCalls1 += 1;
    return hangingGrade();
  }, now: clock1.now, leaseMs: 60000 });
  float(hanging1.runOnce()); // claimed; never commits (the grade hangs)
  await until(async () => (await jobRow(s1.submissionId)).status === 'running');
  assert.equal((await jobRow(s1.submissionId)).status, 'running');
  await until(() => gradeCalls1 === 1);
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
  const s2 = await submit(call, b, 'Abandoned until exhausted.');
  const clock2 = makeClock();
  let gradeCalls2 = 0;
  const hanging2 = createWorker({ pool: db.worker, grade: (input) => {
    assert.equal(input.submissionId, s2.submissionId);
    gradeCalls2 += 1;
    return hangingGrade();
  }, now: clock2.now, leaseMs: 60000 });
  // Three claims, each abandoned while the lease lapses, driving tries to maxTries.
  for (let i = 0; i < 3; i += 1) {
    const before = (await jobRow(s2.submissionId)).tries;
    float(hanging2.runOnce());
    await until(async () => (await jobRow(s2.submissionId)).tries === before + 1);
    // Do not reclaim while this runOnce still holds the pre-grader job lock: the next claim uses SKIP LOCKED.
    await until(() => gradeCalls2 === i + 1);
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
  const s = await submit(call, a, 'Text für die Nebenläufigkeit.');
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
  const s = await submit(call, a, 'Text für die echte Prozess-Ausführung.');
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
  const records = stdout.trim().split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
  assert.ok(records.some(record => record.event === 'worker_outcome' && record.outcome === 'succeeded'), 'the CLI reports the actual successful outcome');
  assert.ok(!(stdout + stderr).includes(s.submissionId), 'worker output excludes the submission identity');
  assert.ok(!(stdout + stderr).includes(a.userId), 'worker output excludes the owner identity');
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
  assert.equal(code, 2, 'the CLI must refuse invalid configuration with its documented usage exit');
  assert.deepEqual(JSON.parse(stderr.trim()), { event: 'worker_error', code: 'worker_configuration_invalid' });
  return `child exit ${code}; fixed configuration error with no raw input or credential`;
});

/* =================================================================== run */

export const REQUIRED_CHECKS = checks.map((c) => c.name);

export async function runWorkerRunnerChecks({ only = null } = {}) {
  const selected = only ? checks.filter((c) => c.name.includes(only)) : checks;
  const report = [];
  // EXAM-S0: the seeded writing content is `unreviewed`, so submitting it needs the `internal-preview`
  // policy. Opted into explicitly for this run and restored after; the deployment default is `public`.
  const previousMode = process.env.B1PREP_CONTENT_MODE;
  process.env.B1PREP_CONTENT_MODE = 'internal-preview';
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
    if (previousMode === undefined) delete process.env.B1PREP_CONTENT_MODE;
    else process.env.B1PREP_CONTENT_MODE = previousMode;
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

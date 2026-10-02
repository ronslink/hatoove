#!/usr/bin/env node
/**
 * EXAM-S0 server contract hardening — REAL PostgreSQL discrimination (disposable database only).
 *
 * Synthetic content is inserted into a random disposable schema (`createFixture`): an objective set with v1 and
 * v2 that share item ids but have DIFFERENT keys, and writing tasks whose content is approved while one of
 * their rubrics is not. Every learner is synthetic, every grader is a stub, and no provider is called.
 *
 * Legs (each fails against base 88fa268):
 *   1. exact versions: v1/v2 read their own payload; omission 422; unknown pair 404; same item id, different key;
 *   2. recommendation `seen` is per (set, version), while the section aggregate stays factual;
 *   3. mistakes are latest per (set, version, item): a correct v2 answer does not clear a wrong v1 one; the
 *      order is deterministic and another owner sees none of it;
 *   4. public cannot be widened by the legacy flag, and an unknown mode serves nothing;
 *   5. an approved task with an unreviewed rubric is refused for new use in public mode while saved history
 *      (attempt, result, draft, export) stays readable;
 *   6. the worker fails an unsupported rubric before the grader is invoked (stub grader spy).
 *
 * Usage: node tools/exam-s0-server-pg-check.mjs [--list] [--only=<text>]   (OWNAPI_PG_*; never a live database)
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import { createFixture } from '../server/owned-postgres/bootstrap.mjs';
import { createPostgresWorld } from '../server/owned-postgres/fixture.mjs';
import { createWorker, stubGrade } from '../server/owned-postgres/worker.mjs';
import { TELC_B1_WRITING_RUBRIC } from '../server/owned-postgres/content-seed.mjs';

const MODE_KEYS = ['B1PREP_CONTENT_MODE', 'B1PREP_SERVE_REVIEW', 'B1PREP_SERVE_RIGHTS'];
const PREVIOUS = Object.fromEntries(MODE_KEYS.map((key) => [key, process.env[key]]));
/** Set exactly these policy variables for the following requests; absent keys are unset. */
function mode(vars) {
  for (const key of MODE_KEYS) {
    if (vars[key] === undefined) delete process.env[key];
    else process.env[key] = vars[key];
  }
}
const PREVIEW = { B1PREP_CONTENT_MODE: 'internal-preview' };
const PUBLIC = {};

const SET = 'exam-s0.lv1.synthetic';
const KEYS = { v1: { 1: 'a', 2: 'b' }, v2: { 1: 'c', 2: 'b' } };
const TASK_GATED = 'exam-s0.writing.unreviewed-rubric';
const TASK_OPEN = 'exam-s0.writing.approved-rubric';
const RUBRIC_UNREVIEWED = 'exam-s0.rubric.unreviewed';
const RUBRIC_APPROVED = 'exam-s0.rubric.approved';
const BIND_GATED = { taskId: TASK_GATED, taskVersion: 'v1', rubricId: RUBRIC_UNREVIEWED, rubricVersion: 'v1' };
const BIND_OPEN = { taskId: TASK_OPEN, taskVersion: 'v1', rubricId: RUBRIC_APPROVED, rubricVersion: 'v1' };

mode(PREVIEW);
const db = await createFixture();
const world = await createPostgresWorld({ fixture: db });
const sql = (text, params) => db.admin.query(text, params);

async function contentRow(id, kind, family, review) {
  await sql(`INSERT INTO content_version(content_version_id, kind, family, source_path, review_status, rights_status, content_sha256, exam_id)
             VALUES($1, $2, $3, 'synthetic:exam-s0-server-pg-check', $4, 'unknown', 'synthetic', 'telc-deutsch-b1')`,
  [id, kind, family, review]);
  await sql(`INSERT INTO content_rights(content_version_id, basis, decided_by, note)
             VALUES($1, 'generated', 'exam-s0-check', 'synthetic EXAM-S0 discrimination row in a disposable schema')`, [id]);
}

async function seedSynthetic() {
  for (const version of ['v1', 'v2']) {
    const id = `${SET}@${version}`;
    await contentRow(id, 'task', 'lv', 'approved');
    await sql(`INSERT INTO objective_set(set_id, version, exam_id, family, section, part, title, payload, item_count, media_required, content_version_id)
               VALUES($1, $2, 'telc-deutsch-b1', 'LV1', 'LV', 1, $3, $4::jsonb, 2, false, $5)`,
    [SET, version, `EXAM-S0 synthetic ${version}`, JSON.stringify({ title: `synthetic ${version}`, items: [] }), id]);
    await sql(`INSERT INTO objective_key(set_id, version, answers, explanations) VALUES($1, $2, $3::jsonb, '{}'::jsonb)`,
      [SET, version, JSON.stringify(KEYS[version])]);
  }
  for (const [rubricId, review] of [[RUBRIC_UNREVIEWED, 'unreviewed'], [RUBRIC_APPROVED, 'approved']]) {
    await contentRow(`${rubricId}@v1`, 'rubric', 'writing', review);
    await sql(`INSERT INTO rubric_version(rubric_id, version, family, criteria, max_total, content_version_id, exam_id)
               VALUES($1, 'v1', 'writing', $2::jsonb, 45, $3, 'telc-deutsch-b1')`,
    [rubricId, JSON.stringify(TELC_B1_WRITING_RUBRIC.criteria), `${rubricId}@v1`]);
  }
  for (const [taskId, rubricId] of [[TASK_GATED, RUBRIC_UNREVIEWED], [TASK_OPEN, RUBRIC_APPROVED]]) {
    await contentRow(`${taskId}@v1`, 'task', 'writing', 'approved');
    await sql(`INSERT INTO task_version(task_id, version, family, register, topic, situation, adressat, leitpunkte,
                                        rubric_id, rubric_version, content_version_id, exam_id)
               VALUES($1, 'v1', 'writing', 'du', 'EXAM-S0 synthetisch', 'Synthetische Situation.', 'Synthetisch (du)',
                      '["Punkt eins.","Punkt zwei."]'::jsonb, $2, 'v1', $3, 'telc-deutsch-b1')`,
    [taskId, rubricId, `${taskId}@v1`]);
  }
}

async function call(method, path, { cookie = null, body } = {}) {
  const headers = { accept: 'application/json', ...(cookie ? { cookie } : {}) };
  if (method !== 'GET') headers['content-type'] = 'application/json';
  const response = await world.api.handle({ method, path, headers, originChecked: true,
    body: method === 'GET' ? undefined : JSON.stringify(body ?? {}) });
  let json = null;
  try { json = JSON.parse(response.body); } catch { /* not JSON */ }
  return { status: response.status, json, cookie: String(response.headers['set-cookie'] || '').split(';')[0] };
}

async function learner(tag) {
  await sql("DELETE FROM auth_throttle WHERE bucket = 'signup:global'");
  const res = await call('POST', '/api/auth/sign-up/email',
    { body: { name: `EXAM-S0 ${tag}`, email: `exam-s0-${tag}-${randomUUID().slice(0, 8)}@example.invalid`, password: 'pw-exam-s0-synthetic' } });
  assert.equal(res.status, 200, `sign-up ${tag}: ${JSON.stringify(res.json)}`);
  const account = await call('GET', '/api/v1/account', { cookie: res.cookie });
  return { cookie: res.cookie, id: account.json.id };
}

const answer = (who, version, itemId, value) => call('POST', `/api/v1/objective-sets/${SET}/answers`,
  { cookie: who.cookie, body: { version, itemId, answer: value } });
const evidenceCount = async (owner) => (await sql('SELECT count(*)::int AS n FROM item_evidence WHERE owner_id = $1', [owner])).rows[0].n;
const mine = (items) => items.filter((item) => item.set_id === SET).map((item) => `${item.version}:${item.item_id}`);

const legs = [];
const check = (name, fn) => legs.push({ name, fn });

check('1. exact objective versions: own payloads, omission 422, unknown pair 404, same item id marked by its own key', async () => {
  mode(PREVIEW);
  const a = await learner('versions');
  for (const version of ['v1', 'v2']) {
    const res = await call('GET', `/api/v1/objective-sets/${SET}?version=${version}`, { cookie: a.cookie });
    assert.equal(res.status, 200, `${version}: ${JSON.stringify(res.json)}`);
    assert.equal(res.json.version, version);
    assert.equal(res.json.payload.title, `synthetic ${version}`);
    assert.ok(!JSON.stringify(res.json).includes('"answers"'), 'no key leaves the server');
  }
  assert.equal((await call('GET', `/api/v1/objective-sets/${SET}`, { cookie: a.cookie })).status, 422, 'omitted version');
  assert.equal((await call('GET', `/api/v1/objective-sets/${SET}?version=v3`, { cookie: a.cookie })).status, 404, 'unknown pair');

  const omitted = await call('POST', `/api/v1/objective-sets/${SET}/answers`, { cookie: a.cookie, body: { itemId: '1', answer: 'a' } });
  assert.equal(omitted.status, 422, `an answer without a version must be refused, got ${omitted.status}`);
  assert.equal(await evidenceCount(a.id), 0, 'a refused answer records no evidence');
  // The same item id and the same answer, marked against each version's own key.
  assert.equal((await answer(a, 'v1', '1', 'c')).json.correct, false, 'v1 key for item 1 is "a"');
  assert.equal((await answer(a, 'v2', '1', 'c')).json.correct, true, 'v2 key for item 1 is "c"');
  assert.equal((await answer(a, 'v1', '1', 'a')).json.correct, true, 'explicit v1 still marks against v1');
  assert.equal((await answer(a, 'v3', '1', 'a')).status, 404, 'an unknown pair is not marked');
  const rows = (await sql('SELECT version FROM item_evidence WHERE owner_id = $1 ORDER BY answered_at', [a.id])).rows;
  assert.deepEqual(rows.map((r) => r.version), ['v1', 'v2', 'v1'], 'evidence records the exact version');
  return 'v1/v2 payloads exact; omission 422 with no evidence; "c" wrong under v1 and right under v2';
});

check('2. recommendation "seen" is per (set, version); the section aggregate stays factual', async () => {
  mode(PUBLIC); // only the synthetic APPROVED sets are servable, so the choice is deterministic
  const a = await learner('seen');
  const first = await call('GET', '/api/v1/practice/next', { cookie: a.cookie });
  assert.equal(first.status, 200, JSON.stringify(first.json));
  assert.equal(first.json.set.set_id, SET, `public mode offers only approved content, got ${JSON.stringify(first.json.set)}`);
  assert.deepEqual([first.json.set.version, first.json.set.seen_items, first.json.reason], ['v1', 0, 'section_not_started']);
  await answer(a, 'v1', '1', 'a');
  const second = await call('GET', '/api/v1/practice/next', { cookie: a.cookie });
  assert.equal(second.json.set.version, 'v2', 'v1 evidence must not make the unseen v2 look seen');
  assert.equal(second.json.set.seen_items, 0, `v2 has no evidence of its own, got ${second.json.set.seen_items}`);
  assert.equal(second.json.evidence.attempts, 1, 'the section aggregate counts the factual activity');
  await answer(a, 'v2', '1', 'x');
  const third = await call('GET', '/api/v1/practice/next', { cookie: a.cookie });
  assert.deepEqual([third.json.evidence.attempts, third.json.evidence.correct], [2, 1], 'aggregate across versions, factual');
  return 'next: v1 seen=0 -> after a v1 answer v2 seen=0; section attempts 1 then 2';
});

check('3. mistakes are latest per (set, version, item), ordered deterministically and owner-scoped', async () => {
  mode(PREVIEW);
  const b = await learner('mistakes');
  const c = await learner('stranger');
  await answer(b, 'v1', '1', 'c'); // wrong under v1
  await answer(b, 'v2', '1', 'c'); // right under v2 — must NOT clear the v1 mistake
  let list = (await call('GET', '/api/v1/practice/mistakes', { cookie: b.cookie })).json;
  assert.deepEqual(mine(list.items), ['v1:1'], `a correct v2 answer must not clear the wrong v1 one, got ${JSON.stringify(mine(list.items))}`);
  await answer(b, 'v2', '2', 'x'); // wrong under v2
  await answer(b, 'v1', '2', 'x'); // wrong under v1, newest
  list = (await call('GET', '/api/v1/practice/mistakes', { cookie: b.cookie })).json;
  assert.deepEqual(mine(list.items), ['v1:2', 'v2:2', 'v1:1'], 'newest first, one row per exact version and item');
  const again = (await call('GET', '/api/v1/practice/mistakes', { cookie: b.cookie })).json;
  assert.deepEqual(again.items, list.items, 'the same evidence yields the same list');
  await answer(b, 'v1', '1', 'a'); // now right under v1
  list = (await call('GET', '/api/v1/practice/mistakes', { cookie: b.cookie })).json;
  assert.deepEqual(mine(list.items), ['v1:2', 'v2:2'], 'the latest v1 answer clears only the v1 mistake');
  assert.ok(list.items.every((item) => !('correct_answer' in item) && !('answers' in item)), 'no key is returned');
  const stranger = (await call('GET', '/api/v1/practice/mistakes', { cookie: c.cookie })).json;
  assert.deepEqual(mine(stranger.items), [], 'another owner sees none of these mistakes');
  assert.deepEqual((await call('GET', '/api/v1/practice/progress', { cookie: c.cookie })).json.totals.attempts, 0,
    'and none of the activity');
  return 'v1 mistake survives a correct v2; order v1:2, v2:2, v1:1 stable; v1 correct clears only v1; stranger empty';
});

check('4. public cannot be widened by the legacy flag; an unknown mode serves nothing', async () => {
  mode({ B1PREP_CONTENT_MODE: 'public', B1PREP_SERVE_REVIEW: 'approved+unreviewed' });
  const d = await learner('public');
  for (const path of ['/api/v1/tasks', '/api/v1/objective-sets', '/api/v1/vocab', '/api/v1/nouns', '/api/v1/guides']) {
    const res = await call('GET', path, { cookie: d.cookie });
    assert.equal(res.status, 200, path);
    assert.deepEqual(res.json.filter((row) => row.review_status !== 'approved').map((row) => row.review_status), [],
      `${path}: public serves approved content only`);
  }
  const sets = (await call('GET', '/api/v1/objective-sets', { cookie: d.cookie })).json.map((s) => `${s.set_id}@${s.version}`);
  assert.deepEqual(sets, [`${SET}@v1`, `${SET}@v2`], 'the approved synthetic sets remain the positive control');
  const tasks = (await call('GET', '/api/v1/tasks', { cookie: d.cookie })).json.map((t) => t.task_id);
  assert.deepEqual(tasks, [TASK_OPEN], 'a task whose rubric is unreviewed is not offered');
  const seeded = 'telc-deutsch-b1.lv1.01';
  assert.equal((await call('GET', `/api/v1/objective-sets/${seeded}?version=v1`, { cookie: d.cookie })).status, 404);
  assert.equal((await call('POST', `/api/v1/objective-sets/${seeded}/answers`,
    { cookie: d.cookie, body: { version: 'v1', itemId: '1', answer: 'a' } })).status, 404);
  const created = await call('POST', '/api/v1/attempts', { cookie: d.cookie, body: {} });
  assert.deepEqual([created.status, created.json.error], [422, 'task_not_servable'], 'the unreviewed default task is not usable');

  mode({ B1PREP_CONTENT_MODE: 'publik' });
  assert.deepEqual((await call('GET', '/api/v1/objective-sets', { cookie: d.cookie })).json, [], 'unknown mode: no sets');
  assert.equal((await call('GET', `/api/v1/objective-sets/${SET}?version=v1`, { cookie: d.cookie })).status, 404);
  assert.equal((await call('GET', '/api/v1/practice/next', { cookie: d.cookie })).json.reason, 'nothing_available');
  assert.equal((await call('POST', '/api/v1/attempts', { cookie: d.cookie, body: BIND_OPEN })).status, 422);

  mode(PREVIEW);
  assert.equal((await call('GET', `/api/v1/objective-sets/${seeded}?version=v1`, { cookie: d.cookie })).status, 200,
    'preview control: the unreviewed seed is servable when explicitly opted into');
  return 'public+legacy flag: approved rows only, seeded set/answer 404, default task 422; unknown mode empty; preview control 200';
});

check('5. approved task with an unreviewed rubric: refused for new use in public, history retained', async () => {
  mode(PREVIEW);
  const e = await learner('history');
  const text = 'SYNTHETIC EXAM-S0: Liebe Anna, ich komme am Samstag. Viele Grüße.';
  const make = async () => {
    const attempt = await call('POST', '/api/v1/attempts', { cookie: e.cookie, body: BIND_GATED });
    assert.equal(attempt.status, 201, `preview may use it: ${JSON.stringify(attempt.json)}`);
    await call('PUT', `/api/v1/attempts/${attempt.json.id}`, { cookie: e.cookie, body: { expectedRevision: 1, text } });
    return attempt.json.id;
  };
  const submittedId = await make();
  const receipt = await call('POST', `/api/v1/attempts/${submittedId}/submissions`,
    { cookie: e.cookie, body: { expectedRevision: 2, eventId: randomUUID() } });
  assert.equal(receipt.status, 202);
  const failedAttempt = await make();
  const failedReceipt = await call('POST', `/api/v1/attempts/${failedAttempt}/submissions`,
    { cookie: e.cookie, body: { expectedRevision: 2, eventId: randomUUID() } });
  assert.equal(await world.store.worker.claim(failedReceipt.json.submissionId), true);
  assert.equal(await world.store.worker.fail(failedReceipt.json.submissionId, 'provider_unavailable'), true);
  const draftId = await make();

  mode(PUBLIC);
  const before = await world.store.inspect.fingerprint();
  for (const [what, res] of [
    ['create', await call('POST', '/api/v1/attempts', { cookie: e.cookie, body: BIND_GATED })],
    ['revision', await call('POST', '/api/v1/attempts', { cookie: e.cookie, body: { parentSubmissionId: receipt.json.submissionId } })],
    ['submit', await call('POST', `/api/v1/attempts/${draftId}/submissions`, { cookie: e.cookie, body: { expectedRevision: 2, eventId: randomUUID() } })],
    ['retry', await call('POST', `/api/v1/submissions/${failedReceipt.json.submissionId}/retry`, { cookie: e.cookie })],
  ]) {
    assert.deepEqual([res.status, res.json.error], [422, 'task_not_servable'], `${what} must be refused in public`);
  }
  assert.equal(await world.store.inspect.fingerprint(), before, 'refused new uses write nothing');
  const read = await call('GET', `/api/v1/attempts/${draftId}`, { cookie: e.cookie });
  assert.deepEqual([read.status, read.json.text, read.json.rubric.rubric_id], [200, text, RUBRIC_UNREVIEWED], 'the draft and its rubric stay readable');
  const result = await call('GET', `/api/v1/submissions/${receipt.json.submissionId}`, { cookie: e.cookie });
  assert.deepEqual([result.status, result.json.submission.text, result.json.rubric.provisional], [200, text, true]);
  const failed = await call('GET', `/api/v1/submissions/${failedReceipt.json.submissionId}`, { cookie: e.cookie });
  assert.deepEqual([failed.json.job.status, failed.json.job.failure_code], ['failed', 'provider_unavailable'], 'the unassessed failure is kept');
  const history = (await call('GET', '/api/v1/attempts', { cookie: e.cookie })).json.attempts.map((a) => a.id).sort();
  assert.deepEqual(history, [submittedId, failedAttempt, draftId].sort());
  assert.ok((await call('GET', '/api/v1/export', { cookie: e.cookie })).json.submissions.some((s) => s.text === text));
  const open = await call('POST', '/api/v1/attempts', { cookie: e.cookie, body: BIND_OPEN });
  assert.equal(open.status, 201, `control: an approved task with an approved rubric is usable in public, got ${JSON.stringify(open.json)}`);
  return 'public: create/revision/submit/retry 422 for the unreviewed rubric, nothing written; draft/result/failure/history/export kept; approved pair 201';
});

check('6. the worker fails an unsupported rubric before invoking the grader', async () => {
  mode(PREVIEW);
  const f = await learner('worker');
  const attempt = await call('POST', '/api/v1/attempts', { cookie: f.cookie, body: BIND_OPEN });
  await call('PUT', `/api/v1/attempts/${attempt.json.id}`, { cookie: f.cookie, body: { expectedRevision: 1, text: 'Hallo. Synthetisch.' } });
  const receipt = await call('POST', `/api/v1/attempts/${attempt.json.id}/submissions`,
    { cookie: f.cookie, body: { expectedRevision: 2, eventId: randomUUID() } });
  assert.equal(receipt.status, 202);
  const graded = [];
  const worker = createWorker({ pool: db.worker, grade: (input) => { graded.push(input.submissionId); return stubGrade(input); } });
  for (let i = 0; i < 25; i += 1) if (!(await worker.runOnce()).claimed) break;
  const job = (await sql('SELECT status, failure_code FROM jobs WHERE submission_id = $1', [receipt.json.submissionId])).rows[0];
  assert.deepEqual([job.status, job.failure_code], ['failed', 'unsupported_rubric']);
  assert.ok(!graded.includes(receipt.json.submissionId), 'the grader was never called for the unsupported rubric');
  assert.equal((await sql('SELECT count(*)::int AS n FROM assessments WHERE submission_id = $1', [receipt.json.submissionId])).rows[0].n, 0);
  assert.equal((await sql('SELECT reserved FROM entitlements WHERE owner_id = $1', [f.id])).rows[0].reserved, 0, 'reservation refunded');
  const result = await call('GET', `/api/v1/submissions/${receipt.json.submissionId}`, { cookie: f.cookie });
  assert.equal(result.json.submission.text, 'Hallo. Synthetisch.', 'the text is preserved');
  return `failed unsupported_rubric; grader saw ${graded.length} other job(s) and not this one; refund; text kept`;
});

async function run() {
  if (process.argv.includes('--list')) { for (const leg of legs) console.log(leg.name); return 0; }
  const only = process.argv.find((a) => a.startsWith('--only='));
  await seedSynthetic();
  let passed = 0;
  const failures = [];
  for (const leg of legs) {
    if (only && !leg.name.toLowerCase().includes(only.split('=')[1].toLowerCase())) continue;
    try {
      const detail = await leg.fn();
      passed += 1;
      console.log(`PASS ${leg.name}${detail ? `  [${detail}]` : ''}`);
    } catch (error) {
      failures.push(leg.name);
      console.log(`FAIL ${leg.name}\n     ${String(error && error.message).split('\n')[0]}`);
    }
  }
  console.log(`\n${passed} passed, ${failures.length} failed (disposable PostgreSQL, restricted roles/RLS, synthetic content, stub grader)`);
  return failures.length ? 1 : 0;
}

let code = 1;
try {
  code = await run();
} finally {
  await world.teardown().catch(() => {});
  for (const key of MODE_KEYS) {
    if (PREVIOUS[key] === undefined) delete process.env[key];
    else process.env[key] = PREVIOUS[key];
  }
}
process.exitCode = code;

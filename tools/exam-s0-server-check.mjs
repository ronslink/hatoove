#!/usr/bin/env node
/**
 * EXAM-S0 server contract hardening — OFFLINE discriminating check (no database, no provider, no `.env`).
 *
 * Every leg drives real server code (`owned-api.mjs`, the PostgreSQL adapter over a scripted fake pool, the
 * worker's `runOnce` over a scripted fake pool, `validateAssessment`, `content-policy.mjs`) and each one
 * FAILS against base 88fa268:
 *   1. objective read/answer require an explicit version (base defaulted to v1 and answered 200/201);
 *   2. the adapter has no v1 default (base queried v1 when no version was given);
 *   3. content policy: public by default, legacy flags cannot widen public, unknown mode serves nothing;
 *   4. adapter options cannot widen the deployment policy (base honoured `serveReview`);
 *   5. the API filters public catalogue rows to approved even when a port returns more;
 *   6. new writing use is refused in public/unknown mode while saved history stays readable;
 *   7. each feedback criterion is validated against its OWN bands, in any order (base used criteria[0]);
 *   8. an unsupported rubric fails BEFORE the grader is invoked (base called the grader first).
 *
 * The real PostgreSQL legs (v1/v2 keys, version-scoped seen/mistakes, approved task + unreviewed rubric) are
 * in tools/exam-s0-server-pg-check.mjs.
 *
 * Usage: node tools/exam-s0-server-check.mjs [--list] [--only=<text>]
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import { createOwnedApi, Fault } from '../server/owned-api.mjs';
import { contentPolicy, contentIsServable } from '../server/content-policy.mjs';
import { createPostgresDatastore } from '../server/owned-postgres/adapter.mjs';
import { createWorker, validateAssessment, stubGrade } from '../server/owned-postgres/worker.mjs';
import { createMemoryDatastore, createMemorySessions } from './owned-api-check.mjs';

const MODE_KEYS = ['B1PREP_CONTENT_MODE', 'B1PREP_SERVE_REVIEW', 'B1PREP_SERVE_RIGHTS'];

/** Run `fn` with exactly these policy variables (absent keys are unset), then restore the previous values. */
async function withEnv(vars, fn) {
  const previous = Object.fromEntries(MODE_KEYS.map((key) => [key, process.env[key]]));
  for (const key of MODE_KEYS) {
    if (vars[key] === undefined) delete process.env[key];
    else process.env[key] = vars[key];
  }
  try { return await fn(); } finally {
    for (const key of MODE_KEYS) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
}
const PREVIEW = { B1PREP_CONTENT_MODE: 'internal-preview' };

function caller(api) {
  return async (method, path, { cookie = null, body } = {}) => {
    const headers = { accept: 'application/json', ...(cookie ? { cookie } : {}) };
    if (method !== 'GET') headers['content-type'] = 'application/json';
    const response = await api.handle({ method, path, headers, originChecked: true,
      body: method === 'GET' ? undefined : JSON.stringify(body ?? {}) });
    return { status: response.status, json: JSON.parse(response.body),
      cookie: String(response.headers['set-cookie'] || '').split(';')[0] };
  };
}

async function signUp(call) {
  const res = await call('POST', '/api/auth/sign-up/email',
    { body: { name: 'EXAM-S0 synthetic', email: `exam-s0-${randomUUID()}@example.invalid`, password: 'pw-exam-s0-synthetic' } });
  assert.equal(res.status, 200, JSON.stringify(res.json));
  return res.cookie;
}

/** A scripted pg Pool stand-in: records every statement; `respond(sql, params)` may return `{rows}`. */
function fakePool(respond = () => null) {
  const log = [];
  const query = async (sql, params = []) => {
    log.push({ sql: String(sql), params });
    return respond(String(sql), params) || { rows: [] };
  };
  return { log, pool: { query, connect: async () => ({ query, release() {} }) } };
}

const INITIAL_EXAM = 'telc-deutsch-b1';
// EXAM-S1: catalogue rows belong to an exam; the scoped routes filter on it, so the stub carries one.
const row = (id, review, extra = {}) => ({ exam_id: INITIAL_EXAM, review_status: review, rights_status: 'generated', ...id, ...extra });

/** Catalogue + practice ports that IGNORE `serveReview` and return everything, so the route's own filter is tested. */
function widePorts(record) {
  const sets = [
    row({ set_id: 'synthetic.set', version: 'v1' }, 'approved', { payload: { title: 'v1' } }),
    row({ set_id: 'synthetic.set', version: 'v2' }, 'approved', { payload: { title: 'v2' } }),
    row({ set_id: 'synthetic.unreviewed', version: 'v1' }, 'unreviewed', { payload: { title: 'u' } }),
  ];
  return {
    async listTasks() {
      return [row({ task_id: 'synthetic.task.approved', version: 'v1' }, 'approved'),
        row({ task_id: 'synthetic.task.unreviewed', version: 'v1' }, 'unreviewed')];
    },
    async listObjectiveSets() { return sets.map(({ payload, ...rest }) => rest); },
    async readObjectiveSet(owner, args) {
      record.push(['readObjectiveSet', args]);
      return sets.find((set) => set.set_id === args.setId && set.version === args.version) ?? null;
    },
    async readRubric(owner, { rubricId }) { return row({ rubric_id: rubricId, version: 'v1', criteria: [] }, 'unreviewed'); },
    async listVocab() { return [row({ entry_id: 'a' }, 'approved'), row({ entry_id: 'u' }, 'unreviewed')]; },
    async listNouns() { return [row({ entry_id: 'a' }, 'approved'), row({ entry_id: 'u' }, 'unreviewed')]; },
    async listGuides() { return [row({ guide_id: 'approved-guide' }, 'approved'), row({ guide_id: 'unreviewed-guide' }, 'unreviewed')]; },
    async readGuide(owner, { guideId }) { return row({ guide_id: guideId, sections: [] }, guideId.startsWith('approved') ? 'approved' : 'unreviewed'); },
    async answerObjectiveItem(owner, args) {
      record.push(['answerObjectiveItem', args]);
      return { evidence_id: randomUUID(), item_id: args.itemId, correct: args.version === 'v2' };
    },
    async nextPractice() { return null; },
    async practiceProgress() { return { totals: {}, sections: [] }; },
    async listMistakes() { return { count: 0, items: [] }; },
  };
}

function wideApi() {
  const record = [];
  const store = createMemoryDatastore();
  // EXAM-S1: registration provisions the initial preparation + balance, as PostgreSQL does.
  const sessions = createMemorySessions({ provision: store.provision });
  const api = createOwnedApi({ datastore: { ...store.port, ...widePorts(record) }, sessions, settings: store.settings });
  return { api, record, store, sessions };
}

/** EXAM-S1: the scoped routes need the id of an owned, ACTIVE preparation; resolved, never assumed. */
async function preparationId(call, cookie) {
  const res = await call('GET', '/api/v1/preparations', { cookie });
  assert.equal(res.status, 200, JSON.stringify(res.json));
  const active = res.json.preparations.find((p) => p.state === 'active');
  assert.ok(active, `sign-up must provision exactly one active preparation, got ${JSON.stringify(res.json)}`);
  return active.id;
}
/** Append the required preparation context to a path, with or without an existing query string. */
const scoped = (path, prepId) => `${path}${path.includes('?') ? '&' : '?'}preparationId=${prepId}`;

const legs = [];
const check = (name, fn) => legs.push({ name, fn });

/* ------------------------------------------------------------------ 1 */
check('1. objective read and answer require an explicit version; v1 is honoured only when supplied', async () => {
  await withEnv({}, async () => {
    const { api, record } = wideApi();
    const call = caller(api);
    const cookie = await signUp(call);
    const prepId = await preparationId(call, cookie);
    for (const query of ['', '?version=', '?version=latest', '?version=1', '?ver=v1']) {
      const res = await call('GET', scoped(`/api/v1/objective-sets/synthetic.set${query}`, prepId), { cookie });
      assert.equal(res.status, 422, `GET ${query || '(no version)'} must be 422, got ${res.status} ${JSON.stringify(res.json)}`);
      assert.deepEqual(res.json, { error: 'invalid_version' });
    }
    assert.deepEqual(record.filter(([name]) => name === 'readObjectiveSet'), [], 'a refused read never reaches the port');
    for (const version of ['v1', 'v2']) {
      const res = await call('GET', scoped(`/api/v1/objective-sets/synthetic.set?version=${version}`, prepId), { cookie });
      assert.equal(res.status, 200, `explicit ${version}`);
      assert.equal(res.json.version, version);
      assert.equal(res.json.payload.title, version, 'the payload is that exact version');
    }
    assert.equal((await call('GET', scoped('/api/v1/objective-sets/synthetic.set?version=v9', prepId), { cookie })).status, 404,
      'an unknown exact pair is 404');

    const before = record.length;
    for (const body of [{ itemId: '1', answer: 'a' }, { itemId: '1', answer: 'a', version: 1 },
      { itemId: '1', answer: 'a', version: 'latest' }, { itemId: '1', answer: 'a', version: null }]) {
      const res = await call('POST', '/api/v1/objective-sets/synthetic.set/answers', { cookie, body: { ...body, preparationId: prepId } });
      assert.equal(res.status, 422, `answer ${JSON.stringify(body)} must be 422, got ${res.status}`);
      assert.deepEqual(res.json, { error: 'invalid_version' });
    }
    assert.equal(record.length, before, 'a refused answer never reaches the marking port');
    const v2 = await call('POST', '/api/v1/objective-sets/synthetic.set/answers',
      { cookie, body: { itemId: '1', answer: 'a', version: 'v2', preparationId: prepId } });
    assert.equal(v2.status, 201);
    assert.equal(record.at(-1)[1].version, 'v2', 'the supplied version reaches the port unchanged');
    const v1 = await call('POST', '/api/v1/objective-sets/synthetic.set/answers',
      { cookie, body: { itemId: '1', answer: 'a', version: 'v1', preparationId: prepId } });
    assert.equal(v1.status, 201);
    assert.equal(record.at(-1)[1].version, 'v1', 'an explicit v1 is preserved');
  });
  return 'missing/invalid version 422 on read and answer with no port call; v1/v2 exact; unknown pair 404';
});

/* ------------------------------------------------------------------ 2 */
check('2. the PostgreSQL adapter has no v1 default for objective reads or marking', async () => {
  await withEnv(PREVIEW, async () => {
    const { log, pool } = fakePool();
    const port = createPostgresDatastore({ pool });
    for (const [name, args] of [['readObjectiveSet', { setId: 'synthetic.set' }],
      ['answerObjectiveItem', { setId: 'synthetic.set', itemId: '1', answer: 'a' }]]) {
      let error = null;
      try { await port[name]('owner-synthetic', args); } catch (e) { error = e; }
      assert.ok(error instanceof Fault, `${name} without a version must be refused, got ${error ? error.message : 'success'}`);
      assert.equal(error.status, 422);
      assert.equal(error.code, 'invalid_version');
    }
    assert.ok(!log.some((entry) => /objective_set|mark_objective_item/.test(entry.sql)),
      'no objective statement may run without an explicit version');
  });
  return 'readObjectiveSet/answerObjectiveItem without a version: 422 before any SQL';
});

/* ------------------------------------------------------------------ 3 */
check('3. one content policy: public by default, legacy flags cannot widen it, unknown mode fails closed', async () => {
  const unreviewed = { review_status: 'unreviewed', rights_status: 'generated' };
  const approved = { review_status: 'approved', rights_status: 'generated' };
  const cases = [
    [{}, 'public', ['approved']],
    [{ B1PREP_SERVE_REVIEW: 'approved+unreviewed' }, 'public', ['approved']],
    [{ B1PREP_CONTENT_MODE: 'public', B1PREP_SERVE_REVIEW: 'approved+unreviewed' }, 'public', ['approved']],
    [{ B1PREP_CONTENT_MODE: 'internal-preview' }, 'internal-preview', ['approved', 'unreviewed']],
    [{ B1PREP_CONTENT_MODE: 'internal-preview', B1PREP_SERVE_REVIEW: 'approved' }, 'internal-preview', ['approved']],
  ];
  for (const [env, mode, review] of cases) {
    const policy = contentPolicy(env);
    assert.equal(policy.mode, mode, `mode for ${JSON.stringify(env)}`);
    assert.deepEqual(policy.review, review, `review for ${JSON.stringify(env)}`);
  }
  assert.equal(contentIsServable(unreviewed, contentPolicy({})), false, 'public refuses unreviewed content');
  assert.equal(contentIsServable(approved, contentPolicy({})), true, 'public serves approved content');
  for (const value of ['preview', 'PUBLIC', 'internal_preview', 'public,internal-preview']) {
    const policy = contentPolicy({ B1PREP_CONTENT_MODE: value, B1PREP_SERVE_REVIEW: 'approved+unreviewed' });
    assert.equal(policy.mode, 'invalid', `${value} is not a mode`);
    assert.deepEqual(policy.review, [], `${value} serves no review status`);
    assert.equal(contentIsServable(approved, policy), false, `${value} fails closed even for approved content`);
  }
  assert.deepEqual(contentPolicy({ B1PREP_CONTENT_MODE: 'internal-preview', B1PREP_SERVE_RIGHTS: 'unknown,generated' }).rights,
    ['generated'], 'unknown provenance can never be opted in');
  return 'default public=[approved]; legacy widen ignored; preview keeps unreviewed; 4 unknown modes serve nothing';
});

/* ------------------------------------------------------------------ 4 */
check('4. adapter options cannot widen the deployment policy', async () => {
  const PREP = '11111111-2222-4333-8444-555555555555';
  const statusesFor = async (env) => withEnv(env, async () => {
    // EXAM-S1 added an owned, ACTIVE preparation lookup and an exam-consistency check before marking, so
    // the marking path only reaches its set query with scripted responses for those reads.
    const { log, pool } = fakePool((sql) => {
      if (/current_release_eligibility/.test(sql)) return { rows: [{ eligible: true, exam_id: INITIAL_EXAM, state: 'available', reason: 'eligible' }] };
      if (/FROM learner_preparation p/.test(sql)) return { rows: [{ id: PREP, exam_id: INITIAL_EXAM, state: 'active' }] };
      if (/FROM objective_set s/.test(sql)) return { rows: [{ exam_id: INITIAL_EXAM, family: 'LV', section: 'LV1', version: 'v1' }] };
      if (/mark_objective_item/.test(sql)) return { rows: [{ correct: true }] };
      return null;
    });
    const port = createPostgresDatastore({ pool });
    const wide = { serveReview: 'approved+unreviewed' };
    await port.listTasks('owner', wide);
    await port.listObjectiveSets('owner', wide);
    await port.readObjectiveSet('owner', { setId: 'synthetic.set', version: 'v1', ...wide });
    await port.readRubric('owner', { rubricId: 'r', version: 'v1', ...wide });
    await port.listGuides('owner', wide);
    await port.answerObjectiveItem('owner', { preparationId: PREP, setId: 'synthetic.set', version: 'v1', itemId: '1', answer: 'a' }).catch(() => {});
    if (env.B1PREP_CONTENT_MODE === 'nonsense') {
      assert.equal(log.some(entry => /mark_objective_item/.test(entry.sql)), false, 'unknown mode must refuse before marking SQL');
    }
    const pick = (pattern) => { const row = log.find((entry) => pattern.test(entry.sql)); assert.ok(row || env.B1PREP_CONTENT_MODE === 'nonsense', `Expected policy query ${pattern} in ${env.B1PREP_CONTENT_MODE || 'public'}`); return row || { params: [] }; };
    return {
      tasks: pick(/FROM task_version t/).params[2],
      sets: pick(/FROM objective_set s[\s\S]*ORDER BY s\.family/).params[2],
      set: pick(/s\.payload/).params[2],
      rubric: pick(/FROM rubric_version r/).params[2],
      guides: pick(/FROM guide g/).params[1],
      marking: log.find(entry => /SELECT s\.exam_id, s\.family, s\.section, s\.version/.test(entry.sql))?.params[2] ?? null,
    };
  });
  const publicStatuses = await statusesFor({ B1PREP_SERVE_REVIEW: 'approved+unreviewed' });
  for (const [what, statuses] of Object.entries(publicStatuses)) {
    assert.deepEqual(statuses, ['approved'], `${what}: an option must not widen public content`);
  }
  const preview = await statusesFor(PREVIEW);
  for (const [what, statuses] of Object.entries(preview)) {
    assert.deepEqual(statuses, ['approved', 'unreviewed'], `${what}: the preview control keeps unreviewed content`);
  }
  const closed = await statusesFor({ B1PREP_CONTENT_MODE: 'nonsense' });
  for (const [what, statuses] of Object.entries(closed)) assert.deepEqual(statuses ?? [], [], `${what}: unknown mode has no query or an empty status allowlist`);
  assert.equal(closed.marking, null, 'unknown mode refuses before the marking content query');
  return 'six adapter paths: public=[approved] despite serveReview, preview=[approved,unreviewed], unknown closes before marking or uses an empty catalogue allowlist';
});

/* ------------------------------------------------------------------ 5 */
check('5. public catalogue routes serve approved rows only, even when a port returns more; unknown mode serves nothing', async () => {
  const lists = ['/api/v1/tasks', '/api/v1/objective-sets', '/api/v1/vocab', '/api/v1/nouns', '/api/v1/guides'];
  const run = async (env) => withEnv(env, async () => {
    const { api } = wideApi();
    const call = caller(api);
    const cookie = await signUp(call);
    const prepId = await preparationId(call, cookie);
    const out = {};
    for (const path of lists) {
      const res = await call('GET', scoped(`${path}?serveReview=approved%2Bunreviewed&review=unreviewed`, prepId), { cookie });
      assert.equal(res.status, 200, `${path}: ${JSON.stringify(res.json)}`);
      out[path] = res.json.map((r) => r.review_status);
    }
    out.unreviewedSet = (await call('GET', scoped('/api/v1/objective-sets/synthetic.unreviewed?version=v1', prepId), { cookie })).status;
    out.approvedSet = (await call('GET', scoped('/api/v1/objective-sets/synthetic.set?version=v1', prepId), { cookie })).status;
    out.rubric = (await call('GET', '/api/v1/rubrics/synthetic.rubric?version=v1', { cookie })).status;
    out.guide = (await call('GET', '/api/v1/guides/unreviewed-guide', { cookie })).status;
    return out;
  });
  const pub = await run({ B1PREP_SERVE_REVIEW: 'approved+unreviewed' });
  for (const path of lists) {
    assert.ok(pub[path].length > 0 && pub[path].every((status) => status === 'approved'),
      `${path}: public serves approved rows only, got ${JSON.stringify(pub[path])}`);
  }
  assert.deepEqual([pub.unreviewedSet, pub.approvedSet, pub.rubric, pub.guide], [404, 200, 404, 404]);
  const preview = await run(PREVIEW);
  for (const path of lists) assert.ok(preview[path].includes('unreviewed'), `${path}: the preview control serves unreviewed rows`);
  assert.deepEqual([preview.unreviewedSet, preview.approvedSet, preview.rubric, preview.guide], [200, 200, 200, 200]);
  const closed = await run({ B1PREP_CONTENT_MODE: 'publik' });
  for (const path of lists) assert.deepEqual(closed[path], [], `${path}: unknown mode serves nothing`);
  assert.deepEqual([closed.unreviewedSet, closed.approvedSet], [404, 404]);
  return 'public lists approved only with widening query ignored; direct unreviewed reads 404; preview control; unknown mode empty';
});

/* ------------------------------------------------------------------ 6 */
check('6. public and unknown modes refuse new writing use; saved history stays readable', async () => {
  const store = createMemoryDatastore();
  // EXAM-S1: registration provisions the initial preparation + balance, as PostgreSQL does.
  const api = createOwnedApi({ datastore: store.port, sessions: createMemorySessions({ provision: store.provision }), settings: store.settings });
  const call = caller(api);
  const text = 'SYNTHETIC EXAM-S0: Liebe Anna, ich komme am Samstag. Viele Grüße.';
  const state = await withEnv(PREVIEW, async () => {
    const cookie = await signUp(call);
    const prepId = await preparationId(call, cookie);
    const submitted = await call('POST', '/api/v1/attempts', { cookie, body: { preparationId: prepId } });
    assert.equal(submitted.status, 201, 'preview control: the unreviewed seed is usable');
    await call('PUT', `/api/v1/attempts/${submitted.json.id}`, { cookie, body: { expectedRevision: 1, text } });
    const receipt = await call('POST', `/api/v1/attempts/${submitted.json.id}/submissions`,
      { cookie, body: { expectedRevision: 2, eventId: randomUUID() } });
    assert.equal(receipt.status, 202);
    const failed = await call('POST', '/api/v1/attempts', { cookie, body: { preparationId: prepId } });
    await call('PUT', `/api/v1/attempts/${failed.json.id}`, { cookie, body: { expectedRevision: 1, text } });
    const failedReceipt = await call('POST', `/api/v1/attempts/${failed.json.id}/submissions`,
      { cookie, body: { expectedRevision: 2, eventId: randomUUID() } });
    store.worker.claim(failedReceipt.json.submissionId);
    store.worker.fail(failedReceipt.json.submissionId, 'provider_unavailable');
    const draft = await call('POST', '/api/v1/attempts', { cookie, body: { preparationId: prepId } });
    await call('PUT', `/api/v1/attempts/${draft.json.id}`, { cookie, body: { expectedRevision: 1, text } });
    return { cookie, prepId, attemptId: submitted.json.id, submissionId: receipt.json.submissionId,
      failedId: failedReceipt.json.submissionId, draftId: draft.json.id };
  });
  for (const env of [{}, { B1PREP_CONTENT_MODE: 'public', B1PREP_SERVE_REVIEW: 'approved+unreviewed' }, { B1PREP_CONTENT_MODE: 'live' }]) {
    await withEnv(env, async () => {
      const label = JSON.stringify(env);
      const before = store.inspect.fingerprint();
      const { cookie, prepId } = state;
      for (const [what, res] of [
        ['create', await call('POST', '/api/v1/attempts', { cookie, body: { preparationId: prepId } })],
        ['revision', await call('POST', '/api/v1/attempts', { cookie, body: { parentSubmissionId: state.submissionId } })],
        ['submit', await call('POST', `/api/v1/attempts/${state.draftId}/submissions`, { cookie, body: { expectedRevision: 2, eventId: randomUUID() } })],
        ['retry', await call('POST', `/api/v1/submissions/${state.failedId}/retry`, { cookie })],
      ]) {
        assert.equal(res.status, 422, `${label} ${what} must be refused, got ${res.status} ${JSON.stringify(res.json)}`);
        assert.deepEqual(res.json, { error: 'task_not_servable' }, `${label} ${what}`);
      }
      assert.equal(store.inspect.fingerprint(), before, `${label}: a refused new use writes nothing`);
      const read = await call('GET', `/api/v1/attempts/${state.attemptId}`, { cookie });
      assert.equal(read.status, 200, `${label}: the saved attempt stays readable`);
      const result = await call('GET', `/api/v1/submissions/${state.submissionId}`, { cookie });
      assert.equal(result.status, 200);
      assert.equal(result.json.submission.text, text, `${label}: the submitted text is preserved`);
      assert.equal((await call('GET', `/api/v1/submissions/${state.failedId}`, { cookie })).json.job.status, 'failed',
        `${label}: the unassessed failure stays visible`);
      assert.equal((await call('GET', `/api/v1/attempts?preparationId=${prepId}`, { cookie })).json.attempts.length, 3);
      assert.equal((await call('GET', `/api/v1/attempts/${state.draftId}`, { cookie })).json.text, text, 'the draft is kept');
    });
  }
  return 'create/revision/submit/retry 422 task_not_servable with nothing written in default, legacy-widened public and unknown modes; attempt/result/draft/history readable';
});

/* ------------------------------------------------------------------ 7 */
check('7. each feedback criterion is validated against its own bands, independent of order', async () => {
  // Two criteria with DISJOINT scales: a validator that reads one scale for all cannot pass both directions.
  const rubric = { criteria: [
    { key: 'inhalt', bands: { A: 5, B: 3 } },
    { key: 'form', bands: { X: 2, Y: 1, Z: 0 } },
  ] };
  const text = 'Hallo Anna. Ich komme am Samstag.';
  const crit = (key, band) => ({ key, band, evidence: 'Hallo Anna.', comment: 'Synthetisch.' });
  const grade = (criteria, extra = {}) => ({ feedback: { kind: 'telc-b1-bands', criteria, corrections: [], ...extra },
    modelVersion: 'stub', promptVersion: 'stub' });
  const refused = (assessment, why) => assert.throws(() => validateAssessment(assessment, { rubric, text }),
    (error) => error.code === 'invalid_assessment', why);

  validateAssessment(grade([crit('form', 'Y'), crit('inhalt', 'A')]), { rubric, text });
  validateAssessment(grade([crit('inhalt', 'B'), crit('form', 'Z')]), { rubric, text });
  refused(grade([crit('form', 'A'), crit('inhalt', 'B')]), 'form does not have band A');
  refused(grade([crit('inhalt', 'X'), crit('form', 'X')]), 'inhalt does not have band X');
  refused(grade([crit('form', 'B'), crit('inhalt', 'A')]), 'reordered: form still does not have band B');
  // The existing refusals still hold.
  refused(grade([crit('inhalt', 'A')]), 'missing criterion');
  refused(grade([crit('inhalt', 'A'), crit('form', 'X'), crit('form', 'Y')]), 'duplicate criterion');
  refused(grade([crit('inhalt', 'A'), crit('ausdruck', 'X')]), 'unknown criterion');
  refused(grade([crit('inhalt', 'A'), crit('form', 'X')], { total: 7 }), 'a total');
  refused(grade([crit('inhalt', 'A'), { ...crit('form', 'X'), score: 2 }]), 'a per-criterion score');
  return 'reordered distinct scales accepted; cross-scale bands refused both ways; missing/duplicate/unknown/total/score refused';
});

/* ------------------------------------------------------------------ 8 */
check('8. an unsupported rubric fails before the grader is invoked; a supported one still grades', async () => {
  const run = async (rubricId) => {
    let token = null;
    const writes = [];
    let savedAssessment = null;
    const binding = { task_id: 'synthetic.task', version: 'v2', exam_id: INITIAL_EXAM, rubric_id: rubricId, rubric_version: 'v1', source_path: 'synthetic:fixture',
      review_status: 'approved', rubric_review_status: 'approved', rights_status: 'generated', rubric_rights_status: 'generated',
      review_basis: 'legacy_unattributed', rubric_review_basis: 'legacy_unattributed', review_blocked: false, rubric_review_blocked: false };
    const pool = {
      async query(sql, params) {
        if (/UPDATE jobs SET status = 'running'/.test(sql)) {
          token = params[0];
          return { rows: [{ id: 'job-1', submission_id: 'sub-1', owner_id: 'owner-1', tries: 1 }] };
        }
        if (/FROM submissions s JOIN attempts a/.test(sql)) {
          return { rows: [{ id: 'sub-1', owner_id: 'owner-1', text: 'Liebe Anna, ich komme gern. Bis bald.',
            task_id: binding.task_id, exam_id: INITIAL_EXAM, attempt_id: 'attempt-1', task_version: 'v2', rubric_version: 'v1', explanation_language: 'de', rubric_id: rubricId, deleted_at: null }] };
        }
        if (/FROM task_version t/.test(sql)) return { rows: [binding] };
        return { rows: [] };
      },
      async connect() {
        return {
          async query(sql, params = []) {
            writes.push(String(sql));
            if (/INSERT INTO assessments\(/.test(sql)) {
              savedAssessment = { submission_id: params[0], owner_id: params[1], feedback: JSON.parse(params[2]),
                model_version: params[3], prompt_version: params[4], rubric_version: params[5] };
              return { rows: [] };
            }
            if (/FROM assessments f JOIN submissions s/.test(sql)) {
              assert.ok(savedAssessment, 'the explanation source must be persisted first');
              assert.deepEqual(params, [savedAssessment.submission_id, savedAssessment.owner_id]);
              return { rows: [{ ...savedAssessment, attempt_id: 'attempt-1', exam_id: INITIAL_EXAM,
                task_id: binding.task_id, rubric_id: rubricId, task_version: 'v2', explanation_language: 'de' }] };
            }
            if (/FROM jobs WHERE submission_id = \$1 FOR UPDATE/.test(sql)) {
              return { rows: [{ id: 'job-1', owner_id: 'owner-1', exam_id: INITIAL_EXAM, status: 'running', lease_token: token }] };
            }
            if (/SELECT owner_id,exam_id FROM jobs WHERE submission_id=\$1/.test(sql)) return { rows: [{ owner_id: 'owner-1', exam_id: INITIAL_EXAM }] };
            if (/FROM task_version t/.test(sql)) return { rows: [binding] };
            if (/SELECT a\.deleted_at/.test(sql)) return { rows: [{ deleted_at: null }] };
            return { rows: [] };
          },
          release() {},
        };
      },
    };
    let calls = 0;
    const outcome = await createWorker({ pool, grade: (input) => { calls += 1; return stubGrade(input); } }).runOnce();
    return { outcome, calls, writes };
  };
  const unsupported = await run('synthetic.unsupported-rubric');
  assert.equal(unsupported.calls, 0, 'the grader must not be invoked for a rubric the worker cannot grade');
  assert.deepEqual(unsupported.outcome, { claimed: true, submissionId: 'sub-1', outcome: 'failed', code: 'unsupported_rubric' });
  assert.ok(unsupported.writes.some((sql) => /SET status = 'failed'/.test(sql)), 'the job is a classified failure');
  assert.ok(unsupported.writes.some((sql) => /reserved = reserved - 1/.test(sql)), 'the reservation is refunded');
  assert.ok(!unsupported.writes.some((sql) => /INSERT INTO assessments/.test(sql)), 'nothing is stored');
  const supported = await run('writing.telc-b1');
  assert.equal(supported.calls, 1, 'control: a supported rubric is graded');
  assert.equal(supported.outcome.outcome, 'succeeded');
  return 'unsupported rubric: failed unsupported_rubric, grader calls=0, refund, no assessment; telc control graded once';
});

async function run() {
  if (process.argv.includes('--list')) { for (const leg of legs) console.log(leg.name); return 0; }
  const only = process.argv.find((a) => a.startsWith('--only='));
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
  console.log(`\n${passed} passed, ${failures.length} failed (offline: memory datastore, scripted fake pools, stub grader)`);
  return failures.length ? 1 : 0;
}

process.exitCode = await run();

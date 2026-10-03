#!/usr/bin/env node
/** Synthetic history/export/revision and new-content policy checks. PostgreSQL requires a disposable DB. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { createOwnedApi } from '../server/owned-api.mjs';
import { contentPolicy } from '../server/content-policy.mjs';
import { createMemoryDatastore, createMemorySessions } from './owned-api-check.mjs';
import { WRITING_TASKS, TELC_B1_WRITING_RUBRIC, TELC_B1_TASK_VERSION } from '../server/owned-postgres/content-seed.mjs';

const postgres = process.argv.includes('--backend=postgres');
const previousRights = process.env.B1PREP_SERVE_RIGHTS;
const previousReview = process.env.B1PREP_SERVE_REVIEW;
const previousMode = process.env.B1PREP_CONTENT_MODE;
let world, fixture, observer, fixtureBaseline;
function fixtureAllowed(env) {
  const local = env.OWNAPI_PG_PORT === '62563' && env.OWNAPI_PG_DATABASE === 'hatoove_spike';
  const ci = env.CI === 'true' && env.GITHUB_ACTIONS === 'true'
    && env.OWNAPI_PG_PORT === '5432' && env.OWNAPI_PG_DATABASE === 'hatoove_ci';
  return env.OWNAPI_PG_ALLOW === '1' && env.OWNAPI_PG_HOST === '127.0.0.1'
    && env.OWNAPI_PG_USER === 'postgres' && (local || ci);
}
function restoreEnv(key, value) {
  if (value === undefined) delete process.env[key]; else process.env[key] = value;
}
// The observer exists before bootstrap so partial setup failures also have a cleanup oracle.
async function fixtureObjects() {
  return (await observer.query(`
    SELECT 'schema:' || nspname AS identity FROM pg_namespace WHERE nspname ~ '^ownapi_[0-9a-f]{16}$'
    UNION SELECT 'role:' || rolname FROM pg_roles WHERE rolname ~ '^ownapi_[0-9a-f]{16}_'
    UNION SELECT 'connection:' || application_name || ':' || usename FROM pg_stat_activity
      WHERE application_name ~ '^ownapi_[0-9a-f]{16}$' OR usename ~ '^ownapi_[0-9a-f]{16}_'
    ORDER BY identity`)).rows.map((row) => row.identity);
}
async function cleanupFixture() {
  const errors = [];
  try { if (fixture) await fixture.cleanup(); else if (world?.teardown) await world.teardown(); }
  catch (error) { errors.push(error); }
  try {
    if (observer && fixtureBaseline) {
      const remaining = await fixtureObjects();
      assert.deepEqual(remaining.filter((name) => !fixtureBaseline.has(name)), [], 'fixture setup/cleanup left new objects or connections');
      if (fixture) {
        assert.equal((await observer.query('SELECT count(*)::int AS n FROM pg_namespace WHERE nspname=$1', [fixture.schema])).rows[0].n, 0);
        assert.equal((await observer.query('SELECT count(*)::int AS n FROM pg_roles WHERE rolname=ANY($1::text[])', [Object.values(fixture.roles)])).rows[0].n, 0);
        assert.equal((await observer.query('SELECT count(*)::int AS n FROM pg_stat_activity WHERE application_name=$1 OR usename=ANY($2::text[])',
          [fixture.schema, Object.values(fixture.roles)])).rows[0].n, 0);
        console.log(`clean ${fixture.schema}: schema, roles and connections verified absent`);
      }
    }
  } catch (error) { errors.push(error); }
  finally { if (observer) await observer.end(); }
  if (errors.length) throw new AggregateError(errors, 'history fixture cleanup failed');
}

const call = async (method, path, cookie = null, body = {}) => {
  const headers = { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) };
  const response = await world.api.handle({ method, path, headers, originChecked: true,
    ...(method === 'GET' ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, data: JSON.parse(response.body),
    cookie: String(response.headers['set-cookie'] || '').split(';')[0] };
};
const expect = (response, status = 200) => {
  assert.equal(response.status, status, JSON.stringify(response.data));
  return response.data;
};
/*
 * EXAM-S1: every scoped read/answer/new attempt names an owned, ACTIVE preparation. It is resolved from
 * the route (never assumed), so a sign-up that provisioned nothing — or two — fails here.
 */
const preparationsByCookie = new Map();
async function preparationId(sourceCookie) {
  if (!preparationsByCookie.has(sourceCookie)) {
    const list = expect(await call('GET', '/api/v1/preparations', sourceCookie)).preparations;
    const active = list.find((p) => p.state === 'active');
    assert.ok(active, `sign-up must provision exactly one active preparation, got ${JSON.stringify(list)}`);
    preparationsByCookie.set(sourceCookie, active.id);
  }
  return preparationsByCookie.get(sourceCookie);
}
const binding = { taskId: WRITING_TASKS[1].taskId, taskVersion: TELC_B1_TASK_VERSION,
  rubricId: TELC_B1_WRITING_RUBRIC.rubricId, rubricVersion: TELC_B1_WRITING_RUBRIC.version };
const text = 'SYNTHETIC OWNED LETTER: Liebe Freundin, ich freue mich auf deinen Besuch. Viele Grüße.';
const privateText = 'SYNTHETIC OTHER OWNER: This must never occur in the first learner export.';
const password = 'synthetic-history-check-password';
const email = `history-${randomUUID()}@example.invalid`;
let cookie, otherCookie, created, submitted, revised, pending, failed, removed;
let passed = 0;
const failures = [];
async function check(name, fn) {
  try { await fn(); passed += 1; console.log(`PASS ${name}`); }
  catch (error) { failures.push(name); console.log(`FAIL ${name}\n  ${error.stack || error}`); }
}
async function saveAndSubmit(sourceCookie, letter, customBinding = binding) {
  // A NEW attempt names its preparation; a revision would derive it from the parent instead.
  const attempt = expect(await call('POST', '/api/v1/attempts', sourceCookie,
    { ...customBinding, preparationId: await preparationId(sourceCookie) }), 201);
  const draft = expect(await call('PUT', `/api/v1/attempts/${attempt.id}`, sourceCookie, { expectedRevision: 1, text: letter }));
  const submission = expect(await call('POST', `/api/v1/attempts/${attempt.id}/submissions`, sourceCookie,
    { expectedRevision: draft.revision, eventId: randomUUID() }), 202);
  return { ...attempt, submissionId: submission.submissionId };
}

try {
  if (postgres && !fixtureAllowed(process.env)) throw new Error('history_fixture_refused: explicit disposable PostgreSQL target required');
  delete process.env.B1PREP_SERVE_RIGHTS;
  delete process.env.B1PREP_SERVE_REVIEW;
  // Seeded content stays unreviewed: this is internal preview, never a content approval.
  process.env.B1PREP_CONTENT_MODE = 'internal-preview';
  if (postgres) {
    const { createFixture, pgConfig } = await import('../server/owned-postgres/bootstrap.mjs');
    const { createPostgresWorld } = await import('../server/owned-postgres/fixture.mjs');
    const pg = createRequire(new URL('../server/owned-postgres/bootstrap.mjs', import.meta.url))('pg');
    observer = new pg.Pool({ ...pgConfig(), max: 1, connectionTimeoutMillis: 5000, query_timeout: 10000,
      application_name: 'history-check-cleanup' });
    fixtureBaseline = new Set(await fixtureObjects());
    fixture = await createFixture();
    console.log(`fixture ${fixture.schema}`);
    world = await createPostgresWorld({ fixture });
  } else {
    const store = createMemoryDatastore();
    const sessions = createMemorySessions({ provision: store.provision });
    world = { store, sessions, settings: store.settings,
      api: createOwnedApi({ datastore: store.port, sessions, settings: store.settings }) };
  }
  await check('history/export require a verified session and new accounts have empty history', async () => {
    expect(await call('GET', '/api/v1/attempts'), 401);
    expect(await call('GET', '/api/v1/export'), 401);
    const signup = await call('POST', '/api/auth/sign-up/email', null, { name: 'Synthetic learner', email, password });
    expect(signup); cookie = signup.cookie;
    const other = await call('POST', '/api/auth/sign-up/email', null,
      { name: 'Other learner', email: `other-${randomUUID()}@example.invalid`, password });
    expect(other); otherCookie = other.cookie;
    assert.deepEqual(expect(await call('GET', `/api/v1/attempts?preparationId=${await preparationId(cookie)}`, cookie)).attempts, []);
    expect(await call('GET', '/api/v1/attempts?open=anything', cookie), 422);
    expect(await call('GET', '/api/v1/attempts?owner_id=other', cookie), 422);
  });

  await check('all supported explanation languages round-trip; unsupported values fail without writes', async () => {
    let revision = expect(await call('GET', '/api/v1/settings', cookie)).revision;
    for (const language of ['de', 'en', 'uk', 'ar', 'tr']) {
      const settings = expect(await call('PUT', '/api/v1/settings', cookie,
        { expectedRevision: revision, settings: { language } }));
      assert.equal(settings.settings.language, language); revision = settings.revision;
    }
    for (const language of ['', 'fr', 'AR', 'en-US']) {
      expect(await call('PUT', '/api/v1/settings', cookie, { expectedRevision: revision, settings: { language } }), 422);
    }
    assert.equal(expect(await call('GET', '/api/v1/settings', cookie)).revision, revision);
    created = await saveAndSubmit(cookie, text); submitted = created.submissionId;
    assert.equal(expect(await call('GET', `/api/v1/submissions/${submitted}`, cookie)).submission.explanation_language, 'tr');
  });

  await check('fresh sign-in discovers the exact pending submission and immutable binding', async () => {
    expect(await call('POST', '/api/auth/sign-out', cookie));
    const login = await call('POST', '/api/auth/sign-in/email', null, { email, password });
    expect(login); cookie = login.cookie;
    const history = expect(await call('GET', `/api/v1/attempts?preparationId=${await preparationId(cookie)}`, cookie)).attempts;
    assert.equal(history.length, 1);
    const row = history[0];
    assert.equal(row.id, created.id); assert.equal(row.submission_id, submitted);
    assert.equal(row.status, 'pending'); assert.equal(row.task_id, binding.taskId);
    assert.equal(row.task_version, binding.taskVersion); assert.equal(row.rubric_id, binding.rubricId);
    assert.equal('text' in row, false);
    assert.deepEqual(expect(await call('GET', `/api/v1/attempts?open=1&preparationId=${await preparationId(cookie)}`, cookie)).attempts, []);
  });

  await check('assessed feedback is discoverable and carries the historical task and rubric', async () => {
    assert.equal(await world.store.worker.claim(submitted), true);
    assert.equal(await world.store.worker.complete(submitted, 'Synthetic feedback'), true);
    assert.equal(expect(await call('GET', `/api/v1/attempts?preparationId=${await preparationId(cookie)}`, cookie)).attempts[0].status, 'assessed');
    const result = expect(await call('GET', `/api/v1/submissions/${submitted}`, cookie));
    assert.equal(result.submission.text, text);
    assert.equal(result.task.task_id, binding.taskId); assert.equal(result.task.version, binding.taskVersion);
    assert.equal(result.rubric.rubric_id, binding.rubricId); assert.ok(result.task.leitpunkte.length);
    assert.ok(result.assessment.feedback); assert.equal(result.parent_submission_id, null);
  });

  await check('revision inherits exact parent binding and text; conflicting or foreign parents write nothing', async () => {
    const before = expect(await call('GET', `/api/v1/attempts?preparationId=${await preparationId(cookie)}`, cookie)).attempts.length;
    expect(await call('POST', '/api/v1/attempts', cookie, { parentSubmissionId: submitted,
      ...binding, taskId: WRITING_TASKS[2].taskId }), 422);
    expect(await call('POST', '/api/v1/attempts', otherCookie, { parentSubmissionId: submitted }), 404);
    assert.equal(expect(await call('GET', `/api/v1/attempts?preparationId=${await preparationId(cookie)}`, cookie)).attempts.length, before);
    revised = expect(await call('POST', '/api/v1/attempts', cookie, { parentSubmissionId: submitted }), 201);
    assert.equal(revised.text, text); assert.equal(revised.revision, 1);
    assert.equal(revised.task_id, binding.taskId); assert.equal(revised.task_version, binding.taskVersion);
    assert.equal(revised.rubric_id, binding.rubricId); assert.equal(revised.parent_submission_id, submitted);
    const read = expect(await call('GET', `/api/v1/attempts/${revised.id}`, cookie));
    assert.equal(read.task.task_id, binding.taskId);
    expect(await call('PUT', `/api/v1/attempts/${revised.id}`, cookie,
      { expectedRevision: 1, text: text + ' Revision.' }));
    assert.equal(expect(await call('GET', `/api/v1/submissions/${submitted}`, cookie)).submission.text, text);
  });

  await check('history distinguishes draft, pending and unassessed; deleted work disappears', async () => {
    pending = await saveAndSubmit(cookie, 'SYNTHETIC pending letter');
    failed = await saveAndSubmit(cookie, 'SYNTHETIC failed letter');
    await world.store.worker.claim(failed.submissionId);
    await world.store.worker.fail(failed.submissionId, 'provider_timeout');
    removed = expect(await call('POST', '/api/v1/attempts', cookie,
      { ...binding, preparationId: await preparationId(cookie) }), 201);
    expect(await call('DELETE', `/api/v1/attempts/${removed.id}`, cookie));
    const history = expect(await call('GET', `/api/v1/attempts?preparationId=${await preparationId(cookie)}`, cookie)).attempts;
    assert.equal(history.find((r) => r.id === revised.id).status, 'draft');
    assert.equal(history.find((r) => r.id === pending.id).status, 'pending');
    assert.equal(history.find((r) => r.id === failed.id).status, 'unassessed');
    assert.equal(history.some((r) => r.id === removed.id), false);
    assert.deepEqual(expect(await call('GET', `/api/v1/attempts?open=1&preparationId=${await preparationId(cookie)}`, cookie)).attempts.map((r) => r.id), [revised.id]);
  });

  await check('export contains owned snapshots/results and no other learner or secret columns', async () => {
    const other = await saveAndSubmit(otherCookie, privateText);
    expect(await call('GET', `/api/v1/attempts/${created.id}`, otherCookie), 404);
    expect(await call('GET', `/api/v1/submissions/${submitted}`, otherCookie), 404);
    const mine = expect(await call('GET', '/api/v1/export', cookie));
    assert.equal(mine.format, 'hatoove-learner-export-v1'); assert.ok(Date.parse(mine.exported_at));
    assert.equal(mine.settings.settings.language, 'tr');
    assert.ok(mine.attempts.some((a) => a.id === revised.id && a.text.endsWith(' Revision.')));
    assert.ok(mine.submissions.some((s) => s.id === submitted && s.text === text));
    assert.ok(mine.results.some((r) => r.submission_id === submitted && r.feedback));
    assert.ok(mine.results.some((r) => r.submission_id === failed.submissionId && r.failure_code === 'provider_timeout'));
    assert.ok(Array.isArray(mine.objective_evidence));
    assert.equal(mine.attempts.some((a) => a.id === removed.id), false);
    assert.equal(JSON.stringify(mine).includes(privateText), false);
    assert.equal(JSON.stringify(mine).includes(other.id), false);
    const forbidden = /^(password|password_hash|token|session|sessions|secret|lease_token|lease_until|event_id|owner_id|account|objective_key)$/i;
    const walk = (value) => { if (value && typeof value === 'object') for (const [key, entry] of Object.entries(value)) {
      assert.equal(forbidden.test(key), false, `export contains forbidden column ${key}`); walk(entry);
    } };
    walk(mine);
    const theirs = expect(await call('GET', '/api/v1/export', otherCookie));
    assert.equal(theirs.submissions.length, 1); assert.equal(theirs.submissions[0].text, privateText);
    assert.equal(JSON.stringify(theirs).includes(submitted), false);
  });

  if (postgres) await check('objective evidence export is owner-scoped and has no answer key', async () => {
    const key = (await world.fixture.admin.query(
      `SELECT k.set_id, k.version, jsonb_object_keys(k.answers) AS item_id FROM objective_key k
       JOIN objective_set s ON s.set_id=k.set_id AND s.version=k.version WHERE s.media_required=false LIMIT 1`)).rows[0];
    assert.ok(key);
    expect(await call('POST', `/api/v1/objective-sets/${key.set_id}/answers`, cookie,
      { version: key.version, itemId: key.item_id, answer: 'synthetic-answer', preparationId: await preparationId(cookie) }), 201);
    const own = expect(await call('GET', '/api/v1/export', cookie)).objective_evidence;
    assert.equal(own.length, 1); assert.equal(own[0].answer, 'synthetic-answer');
    assert.deepEqual(expect(await call('GET', '/api/v1/export', otherCookie)).objective_evidence, []);
  });

  await check('rights policy cannot allow unknown and withdrawal blocks new uses while preserving history', async () => {
    assert.deepEqual(contentPolicy({ B1PREP_SERVE_RIGHTS: 'generated,licensed+commissioned unknown nonsense' }).rights,
      ['generated', 'licensed', 'commissioned']);
    const prep = await preparationId(cookie);
    const historyPath = `/api/v1/attempts?preparationId=${prep}`;
    const beforeResult = expect(await call('GET', `/api/v1/submissions/${submitted}`, cookie));
    const beforeDraft = expect(await call('GET', `/api/v1/attempts/${revised.id}`, cookie));
    const beforeHistory = expect(await call('GET', historyPath, cookie));
    const beforeExport = expect(await call('GET', '/api/v1/export', cookie));
    // This reads actual stored rows on PostgreSQL, including jobs, assessments, balances and receipts.
    const beforeRows = await world.store.inspect.fingerprint();
    const previous = process.env.B1PREP_SERVE_RIGHTS;
    try {
      process.env.B1PREP_SERVE_RIGHTS = 'unknown';
      assert.equal(expect(await call('POST', '/api/v1/attempts', cookie, { preparationId: prep }), 422).error, 'task_not_servable');
      assert.equal(expect(await call('POST', '/api/v1/attempts', cookie, { ...binding, preparationId: prep }), 422).error, 'task_not_servable');
      // C-03 gives retained PostgreSQL work an explicit refusal. The older memory stand-in keeps its own contract.
      const status = postgres ? 409 : 422;
      const code = postgres ? 'rights_blocked' : 'task_not_servable';
      assert.equal(expect(await call('POST', '/api/v1/attempts', cookie, { parentSubmissionId: submitted }), status).error, code);
      assert.equal(expect(await call('POST', `/api/v1/attempts/${revised.id}/submissions`, cookie,
        { expectedRevision: 2, eventId: randomUUID() }), status).error, code);
      assert.equal(expect(await call('POST', `/api/v1/submissions/${failed.submissionId}/retry`, cookie), status).error, code);
      if (postgres) {
        assert.equal(expect(await call('PUT', `/api/v1/attempts/${revised.id}`, cookie,
          { expectedRevision: 2, text: 'SYNTHETIC refused replacement' }), 409).error, 'rights_blocked');
        assert.equal(expect(await call('DELETE', `/api/v1/attempts/${revised.id}`, cookie), 409).error, 'rights_blocked');
      }
      for (const [method, path, body] of [
        ['GET', `/api/v1/submissions/${submitted}`], ['GET', `/api/v1/attempts/${revised.id}`],
        ['POST', '/api/v1/attempts', { parentSubmissionId: submitted }],
        ['POST', `/api/v1/attempts/${revised.id}/submissions`, { expectedRevision: 2, eventId: randomUUID() }],
        ['POST', `/api/v1/submissions/${failed.submissionId}/retry`],
      ]) assert.equal(expect(await call(method, path, otherCookie, body), 404).error, 'not_found');
      const result = expect(await call('GET', `/api/v1/submissions/${submitted}`, cookie));
      const draft = expect(await call('GET', `/api/v1/attempts/${revised.id}`, cookie));
      assert.deepEqual(result.submission, beforeResult.submission);
      assert.deepEqual(result.job, beforeResult.job);
      for (const key of ['id', 'task_id', 'task_version', 'rubric_id', 'rubric_version', 'parent_submission_id', 'revision', 'text']) {
        assert.deepEqual(draft[key], beforeDraft[key], `retained draft ${key}`);
      }
      assert.deepEqual(expect(await call('GET', historyPath, cookie)), beforeHistory);
      const exported = expect(await call('GET', '/api/v1/export', cookie));
      for (const key of ['attempts', 'submissions', 'objective_evidence']) assert.deepEqual(exported[key], beforeExport[key], `retained export ${key}`);
      assert.equal(JSON.stringify(exported).includes(privateText), false);
      if (postgres) {
        for (const view of [result, draft]) {
          assert.equal(view.blocked_reason, 'rights_blocked');
          assert.equal(view.task, null); assert.equal(view.rubric, null);
        }
        assert.equal(result.assessment, null);
        assert.deepEqual(exported.results, beforeExport.results.map((row) => ({ ...row, feedback: null })));
      } else {
        assert.deepEqual(result.task, beforeResult.task); assert.deepEqual(result.rubric, beforeResult.rubric);
        assert.deepEqual(result.assessment, beforeResult.assessment); assert.deepEqual(draft.task, beforeDraft.task);
        assert.deepEqual(exported.results, beforeExport.results);
      }
    } finally {
      restoreEnv('B1PREP_SERVE_RIGHTS', previous);
      assert.equal(await world.store.inspect.fingerprint(), beforeRows, 'rights refusals and redacted reads changed stored learner facts');
    }
    assert.deepEqual(expect(await call('GET', `/api/v1/submissions/${submitted}`, cookie)), beforeResult,
      'restored policy reveals the original stored content and assessment unchanged');
  });

  if (postgres) await check('all catalogue and practice routes apply the same closed rights policy', async () => {
    const prep = await preparationId(cookie);
    const routes = ['/api/v1/tasks', '/api/v1/objective-sets', '/api/v1/vocab', '/api/v1/nouns', '/api/v1/guides'];
    const scoped = (route) => `${route}${route.includes('?') ? '&' : '?'}preparationId=${prep}`;
    const controls = new Map();
    for (const route of routes) {
      const rows = expect(await call('GET', scoped(route), cookie)); assert.ok(rows.length > 0, `positive control ${route}`);
      controls.set(route, rows[0]);
    }
    const set = controls.get('/api/v1/objective-sets');
    const guide = controls.get('/api/v1/guides');
    const previous = process.env.B1PREP_SERVE_RIGHTS;
    try {
      process.env.B1PREP_SERVE_RIGHTS = 'licensed';
      for (const route of routes) assert.deepEqual(expect(await call('GET', scoped(route + '?rights=generated'), cookie)), []);
      expect(await call('GET', scoped(`/api/v1/objective-sets/${set.set_id}?version=${set.version}`), cookie), 404);
      expect(await call('GET', `/api/v1/guides/${guide.guide_id}`, cookie), 404);
      expect(await call('GET', `/api/v1/rubrics/${binding.rubricId}?version=${binding.rubricVersion}`, cookie), 404);
      assert.equal(expect(await call('GET', scoped('/api/v1/practice/next'), cookie)).reason, 'nothing_available');
      expect(await call('POST', `/api/v1/objective-sets/${set.set_id}/answers`, cookie,
        { version: set.version, itemId: '1', answer: 'a', preparationId: prep }), 404);
    } finally { restoreEnv('B1PREP_SERVE_RIGHTS', previous); }
    assert.ok(expect(await call('GET', scoped('/api/v1/practice/next'), cookie)).set);
  });
} finally {
  restoreEnv('B1PREP_SERVE_RIGHTS', previousRights);
  restoreEnv('B1PREP_SERVE_REVIEW', previousReview);
  restoreEnv('B1PREP_CONTENT_MODE', previousMode);
  await cleanupFixture();
}
console.log(`\n${passed} passed, ${failures.length} failed (${postgres ? 'PostgreSQL with restricted roles/RLS' : 'memory contract only'})`);
process.exitCode = failures.length ? 1 : 0;

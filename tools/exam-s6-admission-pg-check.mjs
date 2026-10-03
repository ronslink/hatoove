#!/usr/bin/env node
/** New admission versus pinned continuations, in one disposable schema with synthetic review only. */
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createFixture, rolePool } from '../server/owned-postgres/bootstrap.mjs';
import { createPostgresWorld } from '../server/owned-postgres/fixture.mjs';
import { createPostgresDatastore } from '../server/owned-postgres/adapter.mjs';
import { importDefaultPackage, importPackage } from '../server/owned-postgres/package-importer.mjs';
import { createExamCatalogue } from '../server/preparation-contract.mjs';
import { publishCompleteDtzFixture, syntheticContentReview } from './exam-s6-fixture.mjs';

if (process.env.OWNAPI_PG_ALLOW !== '1' || !process.env.OWNAPI_PG_PORT || [4300, 55440].includes(Number(process.env.OWNAPI_PG_PORT)))
  throw Error('Explicit disposable OWNAPI_PG_ALLOW/PORT required; learner ports forbidden');
const envKeys = ['B1PREP_CONTENT_MODE', 'B1PREP_SERVE_REVIEW', 'B1PREP_SERVE_RIGHTS'];
const previousEnv = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
const TELC = 'telc-deutsch-b1', DTZ = 'dtz-a2-b1', catalogue = createExamCatalogue({ enabled: [TELC, DTZ] });
let db, world, port, mediaRoot, fixture, failed;
let passed = 0;
const check = async (name, fn) => { await fn(); passed++; console.log('PASS ' + name); };
const rejects = (promise, code) => assert.rejects(promise, error => error.code === code);
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const bounded = (promise, label) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(Error('Timed out: ' + label)), 7000);
  promise.then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
});
async function owner(tag) {
  const signup = await world.sessions.signUp({ name: 'Synthetic S6 ' + tag, email: `s6-${tag}-${randomUUID()}@example.invalid`, password: 'synthetic-s6-password' });
  const cookie = String(signup.setCookie).split(';')[0];
  const id = (await world.sessions.getSession({ cookie })).userId;
  return { id, cookie, telc: (await port.listPreparations(id))[0] };
}
async function request(owner, method, url, body = {}) {
  const result = await world.api.handle({ method, path: url, headers: { cookie: owner.cookie, 'content-type': 'application/json' }, body: method === 'GET' ? undefined : JSON.stringify(body), originChecked: true });
  return { status: result.status, data: JSON.parse(result.body) };
}
const startBody = (owner, form, releaseVersion = 'v9603', eventId = randomUUID()) => ({ preparationId: owner.dtz.id, formId: form.id, formVersion: form.version, releaseVersion, eventId });
const binding = task => ({ taskId: task.taskId, taskVersion: task.version, rubricId: task.rubricId, rubricVersion: task.rubricVersion });
async function pointHead(version, client = db.migration) {
  await client.query('UPDATE exam_release_head SET release_version=$2 WHERE exam_id=$1', [DTZ, version]);
}
async function publishHead(version, forms, { state = 'available', blocked = [] } = {}) {
  // Privileged malformed-publication seam: importer already rejects a public partial DTZ release.
  // This proves runtime admission independently. Only our random ownapi schema can reach this path.
  assert.match(db.schema, /^ownapi_[a-z0-9_]+$/);
  const manifest = { ...structuredClone(fixture.published), forms, release: { version, state, resumeBlockedReleases: blocked } };
  const client = await db.migration.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,7351))', [DTZ]);
    await client.query('INSERT INTO exam_release(exam_id,version,blueprint_version,state,manifest,sha256,publisher) VALUES($1,$2,$3,$4,$5::jsonb,$6,$7)',
      [DTZ, version, manifest.blueprint.version, state, JSON.stringify(manifest), createHash('sha256').update(JSON.stringify(manifest)).digest('hex'), 'synthetic-s6-admission-test']);
    for (const form of forms) await client.query('INSERT INTO exam_release_form(exam_id,release_version,form_id,form_version) VALUES($1,$2,$3,$4)', [DTZ, version, form.id, form.version]);
    await pointHead(version, client); await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
}
async function advisoryWait(waiter, blocker) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const row = (await db.admin.query(`SELECT $2::integer=ANY(pg_blocking_pids($1)) AS blocked,
      EXISTS(SELECT 1 FROM pg_locks WHERE pid=$1 AND locktype='advisory' AND NOT granted) AS advisory`, [waiter, blocker])).rows[0];
    if (row.blocked && row.advisory) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.fail('Expected a real separate-connection advisory wait');
}
function observedPort({ afterEligibility = null, basePool = db.learner } = {}) {
  const connected = deferred(); let pid;
  const pool = { async connect() {
    const client = await basePool.connect(); pid = client.processID; connected.resolve();
    return { release: () => client.release(), async query(sql, args) {
      const result = await client.query(sql, args);
      if (sql === 'BEGIN') await client.query("SET LOCAL lock_timeout='6s'; SET LOCAL statement_timeout='8s'");
      if (afterEligibility && String(sql).includes('current_release_eligibility')) await afterEligibility();
      return result;
    } };
  } };
  return { port: createPostgresDatastore({ pool, examCatalogue: catalogue, mediaRoot }), connected: connected.promise, get pid() { return pid; } };
}
try {
  process.env.B1PREP_CONTENT_MODE = 'internal-preview'; delete process.env.B1PREP_SERVE_REVIEW; delete process.env.B1PREP_SERVE_RIGHTS;
  mediaRoot = await mkdtemp(path.join(tmpdir(), 'hatoove-s6-admission-'));
  db = await createFixture(); world = await createPostgresWorld({ fixture: db, examCatalogue: catalogue });
  port = createPostgresDatastore({ pool: db.learner, examCatalogue: catalogue, mediaRoot });
  await importDefaultPackage(db.migration);
  const partial = JSON.parse(await readFile(new URL('../content/exams/dtz-a2-b1/manifest.json', import.meta.url), 'utf8'));
  await importPackage(db.migration, partial);
  const a = await owner('a'), b = await owner('b'), newcomer = await owner('new');
  a.dtz = (await port.createPreparation(a.id, DTZ)).preparation;
  await check('default remains telc-only while explicit internal partial DTZ remains usable', async () => {
    const defaultPort = createPostgresDatastore({ pool: db.learner });
    assert.deepEqual((await defaultPort.listExams(a.id)).map(row => row.exam_id), [TELC]);
    await rejects(defaultPort.createPreparation(newcomer.id, DTZ), 'exam_unavailable');
    assert.equal((await port.listObjectiveSets(a.id, { examId: DTZ })).length, 5);
    assert.equal((await port.listMockForms(a.id, { preparationId: a.dtz.id })).length, 1);
  });
  fixture = await publishCompleteDtzFixture(db, { mediaRoot });
  const full = fixture.internal.forms[0];
  const reading = { id: 's6.synthetic.reading', version: full.version, title: 'Synthetic reading', scope: 'section', sections: ['LV'], mode: 'untimed', timeLimitSeconds: null, feedback: 'finalise', members: full.members.filter(row => row.interaction !== 'fixed_audio') };
  const writing = { id: 's6.synthetic.writing', version: full.version, title: 'Synthetic writing', scope: 'section', sections: ['SA'], mode: 'untimed', timeLimitSeconds: null, feedback: 'finalise', members: [], writingChoices: structuredClone(full.writingChoices) };
  await importPackage(db.migration, { ...fixture.published, forms: [full, reading, writing], release: { version: 'v9602', state: 'internal', resumeBlockedReleases: [] } }, { mediaRoot });
  const reviewClient = await db.migration.connect();
  try {
    await reviewClient.query('BEGIN');
    for (const form of [reading, writing]) {
      const row = (await reviewClient.query('SELECT sha256 FROM exam_form WHERE exam_id=$1 AND form_id=$2 AND version=$3', [DTZ, form.id, form.version])).rows[0];
      await syntheticContentReview(db, reviewClient, { kind: 'form', examId: DTZ, subjectId: form.id, version: form.version, sha256: row.sha256 });
    }
    await reviewClient.query('COMMIT');
  } catch (error) { await reviewClient.query('ROLLBACK'); throw error; } finally { reviewClient.release(); }
  await publishHead('v9603', [full, reading, writing]);
  process.env.B1PREP_CONTENT_MODE = 'public';
  const set = fixture.internal.sets.find(row => row.section === 'LV'), task = fixture.internal.writingTasks[0];
  const objective = { preparationId: a.dtz.id, setId: set.setId, version: set.version, itemId: String(set.payload.questions[0].n), answer: Object.keys(set.payload.questions[0].options)[0] };
  let readingRun, writingRun, startReceipt, standalone, submission;
  await check('complete public DTZ admits discovery, preparation, direct objective and exact writing binding', async () => {
    assert.deepEqual((await port.listExams(a.id)).map(row => row.exam_id), [DTZ, TELC]);
    b.dtz = (await port.createPreparation(b.id, DTZ)).preparation;
    assert.equal((await port.listObjectiveSets(a.id, { examId: DTZ })).length, 5);
    assert.equal(await port.hasObjectiveFamily(a.id, { examId: DTZ, family: 'LV5' }), true);
    assert.equal((await port.readObjectiveSet(a.id, objective)).set_id, set.setId);
    assert.equal((await port.nextPractice(a.id, { preparationId: a.dtz.id })).exam_id, DTZ);
    assert.equal((await port.listTasks(a.id, { examId: DTZ })).length, 2);
    assert.equal((await port.readRubric(a.id, { rubricId: task.rubricId, version: task.rubricVersion })).exam_id, DTZ);
    await port.answerObjectiveItem(a.id, objective);
    standalone = await port.create(a.id, null, binding(task), a.dtz.id);
    const saved = await port.save(a.id, standalone.id, 1, 'Exact synthetic submitted text.');
    await db.admin.query('INSERT INTO entitlements(owner_id,exam_id,allowance,used,reserved) VALUES($1,$2,10,0,0)', [a.id, DTZ]);
    submission = await port.submit(a.id, standalone.id, saved.revision, randomUUID());
    startReceipt = startBody(a, reading); readingRun = (await port.startMockRun(a.id, startReceipt)).run;
    writingRun = (await port.startMockRun(a.id, startBody(a, writing))).run;
    const complete = (await port.startMockRun(a.id, startBody(a, full))).run;
    assert.equal((await port.finaliseMockRun(a.id, complete.id, { expectedRevision: complete.revision, eventId: randomUUID() })).result.total, 45);
  });
  await publishHead('v9604', [reading, writing]);
  async function deniedAdmissions() {
    const before = await world.store.inspect.fingerprint();
    assert.deepEqual((await port.listExams(a.id)).map(row => row.exam_id), [TELC]);
    await rejects(port.createPreparation(newcomer.id, DTZ), 'exam_unavailable');
    assert.deepEqual(await port.listMockForms(a.id, { preparationId: a.dtz.id }), []);
    await rejects(port.startMockRun(a.id, startBody(a, reading, 'v9604')), 'not_found');
    assert.equal(await port.hasObjectiveFamily(a.id, { examId: DTZ, family: 'LV5' }), false);
    assert.deepEqual(await port.listObjectiveSets(a.id, { examId: DTZ }), []);
    assert.equal(await port.readObjectiveSet(a.id, objective), null);
    assert.equal(await port.nextPractice(a.id, { preparationId: a.dtz.id }), null);
    await rejects(port.answerObjectiveItem(a.id, objective), 'not_found');
    assert.deepEqual(await port.listTasks(a.id, { examId: DTZ }), []);
    assert.equal(await port.readRubric(a.id, { rubricId: task.rubricId, version: task.rubricVersion }), null);
    await rejects(port.create(a.id, null, binding(task), a.dtz.id), 'task_not_servable');
    assert.equal(await world.store.inspect.fingerprint(), before, 'Refused admissions leave learner data and credits unchanged');
  }
  await check('available partial release closes every new admission and direct content ID', deniedAdmissions);
  await check('HTTP direct IDs refuse hidden objective, rubric, writing and new mock admissions', async () => {
    const query = '?preparationId=' + a.dtz.id;
    assert.equal((await request(a, 'GET', `/api/v1/objective-sets/${set.setId}${query}&version=${set.version}`)).status, 404);
    const { setId, ...answerBody } = objective;
    assert.equal((await request(a, 'POST', `/api/v1/objective-sets/${setId}/answers`, answerBody)).status, 404);
    assert.equal((await request(a, 'GET', `/api/v1/rubrics/${task.rubricId}?version=${task.rubricVersion}`)).status, 404);
    const newAttempt = await request(a, 'POST', '/api/v1/attempts', { preparationId: a.dtz.id, ...binding(task) });
    assert.equal(newAttempt.status, 422); assert.equal(newAttempt.data.error, 'task_not_servable');
    assert.equal((await request(a, 'POST', '/api/v1/mock-runs', startBody(a, reading, 'v9604'))).status, 404);
    assert.equal((await request(newcomer, 'POST', '/api/v1/preparations', { examId: DTZ })).data.error, 'exam_unavailable');
    assert.equal((await request(a, 'GET', '/api/v1/objective-sets' + query)).data.length, 0);
    assert.equal((await request(a, 'GET', '/api/v1/tasks' + query)).data.length, 0);
    assert.equal((await request(a, 'GET', '/api/v1/practice/next' + query)).data.reason, 'nothing_available');
  });
  await check('existing preparation, exact start receipt, pinned writing choice, revision and history survive', async () => {
    assert.deepEqual(await port.createPreparation(a.id, DTZ), { created: false, preparation: a.dtz });
    assert.equal((await port.startMockRun(a.id, startReceipt)).run.id, readingRun.id);
    const defaultPort = createPostgresDatastore({ pool: db.learner });
    assert.deepEqual(await defaultPort.createPreparation(a.id, DTZ), { created: false, preparation: a.dtz });
    assert.equal((await defaultPort.startMockRun(a.id, startReceipt)).run.id, readingRun.id);
    assert.equal((await port.readMockRun(a.id, readingRun.id)).blocked_reason, null);
    const selected = await port.selectMockWriting(a.id, writingRun.id, { expectedRevision: writingRun.revision, eventId: randomUUID(), choiceGroupId: writing.writingChoices[0].id, optionId: 'A' });
    assert.equal(selected.writing.selected_option_id, 'A');
    const text = await port.save(a.id, selected.writing.attempt_id, 1, 'Exact pinned continuation text.');
    const finalised = await port.finaliseMockRun(a.id, writingRun.id, { expectedRevision: selected.revision, eventId: randomUUID(), expectedWritingRevision: text.revision, explanationLanguage: 'de' });
    assert.equal(finalised.state, 'finalised');
    const revision = await port.create(a.id, submission.submissionId);
    assert.equal(revision.parent_submission_id, submission.submissionId); assert.equal(revision.text, 'Exact synthetic submitted text.');
    assert.ok((await port.listAttempts(a.id, { preparationId: a.dtz.id })).length >= 3);
    assert.ok((await port.listMockRuns(a.id, { preparationId: a.dtz.id })).length >= 3);
    assert.equal((await port.readCredits(a.id, a.dtz.id)).allowance, 10);
    assert.equal((await port.result(a.id, submission.submissionId)).submission.text, 'Exact synthetic submitted text.');
  });
  await check('withdrawn and self-blocked heads hide new admissions without changing default telc', async () => {
    await publishHead('v9605', [full, reading, writing], { state: 'withdrawn' }); await deniedAdmissions();
    await publishHead('v9606', [full, reading, writing], { blocked: ['v9606'] }); await deniedAdmissions();
    await pointHead('v9603');
  });
  await check('configured rights narrowing closes new DTZ even when exact rows are approved', async () => {
    process.env.B1PREP_SERVE_RIGHTS = 'licensed'; await deniedAdmissions(); delete process.env.B1PREP_SERVE_RIGHTS;
    assert.equal((await port.listTasks(a.id, { examId: DTZ })).length, 2);
  });
  await check('next practice eligibility and candidate use one repeatable-read snapshot', async () => {
    await publishHead('v9607', [], { state: 'withdrawn' }); await pointHead('v9603');
    let begins = [], connections = 0, advanced = false;
    const wrapped = { async connect() { connections++; const client = await db.learner.connect(); return { release: () => client.release(), async query(sql, args) {
      if (sql.startsWith('BEGIN')) begins.push(sql);
      const result = await client.query(sql, args);
      if (!advanced && sql.includes('current_release_eligibility')) { advanced = true; await pointHead('v9607'); }
      return result;
    } }; } };
    const scoped = createPostgresDatastore({ pool: wrapped, examCatalogue: catalogue });
    assert.ok(await scoped.nextPractice(a.id, { preparationId: a.dtz.id }));
    assert.equal(advanced, true); assert.equal(await port.nextPractice(a.id, { preparationId: a.dtz.id }), null);
    assert.equal(connections, 1); assert.deepEqual(begins, ['BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY']);
    await pointHead('v9603');
  });
  await check('same-owner objective and writing admissions serialize without an inverted-lock deadlock', async () => {
    const objectivePool=rolePool(db.config,db.schema,db.roles.learner,1),writingPool=rolePool(db.config,db.schema,db.roles.learner,1);
    const reached=deferred(),resume=deferred();let held=false,answer,writing;
    const objectivePort=observedPort({basePool:objectivePool,afterEligibility:async()=>{if(!held){held=true;reached.resolve();await bounded(resume.promise,'release objective barrier');}}});
    const writingPort=observedPort({basePool:writingPool});
    try {
      answer=objectivePort.port.answerObjectiveItem(a.id,objective);answer.catch(()=>{});await bounded(reached.promise,'objective eligibility');
      writing=writingPort.port.create(a.id,null,binding(task),a.dtz.id);writing.catch(()=>{});await bounded(writingPort.connected,'separate writing connection');
      assert.notEqual(objectivePort.pid,writingPort.pid);await advisoryWait(writingPort.pid,objectivePort.pid);
      resume.resolve();assert.ok((await bounded(answer,'objective commit')).evidence_id);assert.ok((await bounded(writing,'writing commit')).id);
    }finally{resume.resolve();await Promise.allSettled([answer,writing]);await Promise.allSettled([objectivePool.end(),writingPool.end()]);}
  });
  await check('new preparation waits for its owner before acquiring the exam fence', async () => {
    const newcomer=await owner('preparation-order'),pool=rolePool(db.config,db.schema,db.roles.learner,1),observed=observedPort({basePool:pool});
    const blocker=await db.learner.connect();let operation;
    try {
      await blocker.query('BEGIN');await blocker.query("SET LOCAL lock_timeout='6s'; SET LOCAL statement_timeout='8s'");
      await blocker.query("SELECT set_config('hatoove.owner_id',$1,true)",[newcomer.id]);await blocker.query('SELECT pg_advisory_xact_lock(hashtextextended($1,7352))',[newcomer.id]);
      operation=observed.port.createPreparation(newcomer.id,DTZ);operation.catch(()=>{});await bounded(observed.connected,'preparation connection');
      assert.notEqual(observed.pid,blocker.processID);await advisoryWait(observed.pid,blocker.processID);
      await blocker.query('SELECT pg_advisory_xact_lock(hashtextextended($1,7351))',[DTZ]);await blocker.query('COMMIT');
      assert.equal((await bounded(operation,'preparation commit')).created,true);
    }finally{await blocker.query('ROLLBACK');blocker.release();if(operation)await operation.catch(()=>{});await pool.end();}
  });
  await check('publication-first withdrawal waits at the real exam lock then refuses new objective evidence', async () => {
    const publisher = await db.migration.connect(), observed = observedPort(); let operation;
    try {
      await publisher.query('BEGIN'); await publisher.query('SELECT pg_advisory_xact_lock(hashtextextended($1,7351))', [DTZ]);
      await pointHead('v9604', publisher);
      operation = observed.port.answerObjectiveItem(a.id, objective); operation.catch(() => {});
      await observed.connected; await advisoryWait(observed.pid, publisher.processID);
      await publisher.query('COMMIT'); await rejects(operation, 'not_found');
    } finally { await publisher.query('ROLLBACK'); publisher.release(); if (operation) await operation.catch(() => {}); }
    await pointHead('v9603');
  });
  await check('admission-first objective commit holds the exam fence until a later rights decision can commit', async () => {
    const reached = deferred(), resume = deferred(); let held = false;
    const observed = observedPort({ afterEligibility: async () => { if (!held) { held = true; reached.resolve(); await bounded(resume.promise, 'release admission barrier'); } } });
    const rights = await db.migration.connect(); let admission, decision;
    try {
      admission = observed.port.answerObjectiveItem(a.id, objective); admission.catch(() => {});
      await bounded(reached.promise, 'admission eligibility');
      await rights.query('BEGIN'); await rights.query("SET LOCAL lock_timeout='6s'");
      const media = fixture.internal.media[0];
      decision = rights.query("INSERT INTO content_rights(content_version_id,basis,decided_by,note) VALUES($1,'unknown','synthetic s6 race','Test-only rights decision after admission')", [media.mediaId + '@' + media.version]); decision.catch(() => {});
      await advisoryWait(rights.processID, observed.pid);
      resume.resolve(); assert.ok((await bounded(admission, 'admission commit')).evidence_id);
      await bounded(decision, 'rights insert'); await rights.query('COMMIT');
      await deniedAdmissions();
    } finally { resume.resolve(); await rights.query('ROLLBACK'); rights.release(); if (admission) await admission.catch(() => {}); if (decision) await decision.catch(() => {}); }
  });
  console.log(`EXAM-S6 admission: ${passed} checks passed; disposable synthetic PostgreSQL evidence only.`);
} catch (error) { failed = error; }
finally {
  for (const key of envKeys) if (previousEnv[key] === undefined) delete process.env[key]; else process.env[key] = previousEnv[key];
  const removeMedia = async () => {
    if (!mediaRoot) return;
    const target = path.resolve(mediaRoot);
    assert.equal(path.dirname(target), path.resolve(tmpdir()));
    assert.ok(path.basename(target).startsWith('hatoove-s6-admission-'));
    await rm(target, { recursive: true, force: true });
  };
  const cleanup = await Promise.allSettled([db?.cleanup(), removeMedia()]);
  for (const result of cleanup) if (result.status === 'rejected') failed ||= result.reason;
}
if (failed) throw failed;

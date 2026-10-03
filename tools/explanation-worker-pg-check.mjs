/** PILOT07 worker proofs: restricted worker, synthetic graders, one unique disposable schema. */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createFixture} from '../server/owned-postgres/bootstrap.mjs';
import {createPostgresWorld} from '../server/owned-postgres/fixture.mjs';
import {createWorker, stubGrade} from '../server/owned-postgres/worker.mjs';
import {DEFAULT_TASK, FORMATIVE_WRITING_RUBRIC} from '../server/owned-postgres/content-seed.mjs';
import {createExamCatalogue} from '../server/preparation-contract.mjs';
import {extractWritingExplanationSource, projectExplanationView} from '../server/explanation-contract.mjs';
import {readExplanationRepresentations} from '../server/owned-postgres/explanations.mjs';
import {SIMULATION_LANGUAGES} from '../server/explanation-simulation.mjs';
import {publishCompleteDtzFixture, syntheticContentReview} from './exam-s6-fixture.mjs';

const localFixture = process.env.OWNAPI_PG_PORT === '62563' && process.env.OWNAPI_PG_DATABASE === 'hatoove_spike';
const actionsFixture = process.env.CI === 'true' && process.env.GITHUB_ACTIONS === 'true'
  && process.env.OWNAPI_PG_PORT === '5432' && process.env.OWNAPI_PG_DATABASE === 'hatoove_ci';
if (process.env.OWNAPI_PG_ALLOW !== '1' || process.env.OWNAPI_PG_HOST !== '127.0.0.1' || (!localFixture && !actionsFixture))
  throw Error('Explicit assigned local or GitHub Actions disposable PostgreSQL required');
const policyKeys = ['B1PREP_CONTENT_MODE','B1PREP_SERVE_REVIEW','B1PREP_SERVE_RIGHTS'];
const savedEnv = Object.fromEntries(policyKeys.map(key => [key, process.env[key]]));
const catalogue = createExamCatalogue({enabled:['telc-deutsch-b1','dtz-a2-b1']});
const text = 'Sehr geehrte Frau Weber, vielen Dank für Ihre Nachricht. Ich komme am Freitag und bringe die Unterlagen mit. Mit freundlichen Grüßen';
let db, world, port, mediaRoot, passed = 0;
const check = async (name, fn) => {await fn(); passed++; console.log('PASS '+name);};
const gate = () => {let open; const ready = new Promise(resolve => {open = resolve;}); return {ready, open};};
async function bounded(promise, label) {
  let timer;
  try {return await Promise.race([promise, new Promise((_, reject) => {timer = setTimeout(() => reject(Error('Timed out: '+label)), 7000);})]);}
  finally {clearTimeout(timer);}
}
async function tx(pool, work, owner = null) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (owner) await client.query("SELECT set_config('hatoove.owner_id',$1,true)",[owner]);
    const result = await work(client); await client.query('COMMIT'); return result;
  } catch (error) {await client.query('ROLLBACK').catch(() => {}); throw error;}
  finally {client.release();}
}
const one = async (sql, args = []) => (await db.admin.query(sql, args)).rows[0];
async function queued(language = 'de', binding = null, examId = 'telc-deutsch-b1') {
  const signup = await world.sessions.signUp({name:'Synthetic explanation worker', email:'explanation-'+randomUUID()+'@example.invalid', password:'synthetic-explanation-password'});
  const owner = (await world.sessions.getSession({cookie:String(signup.setCookie).split(';')[0]})).userId;
  let prep = (await port.listPreparations(owner))[0];
  if (examId !== 'telc-deutsch-b1') {
    prep = (await port.createPreparation(owner,examId)).preparation;
    await db.admin.query('INSERT INTO entitlements(owner_id,exam_id,allowance,used,reserved) VALUES($1,$2,10,0,0)',[owner,examId]);
  }
  const attempt = await port.create(owner,null,binding,prep.id);
  const draft = await port.save(owner,attempt.id,1,text);
  const event = randomUUID(), receipt = await port.submit(owner,attempt.id,draft.revision,event,language);
  return {owner, attempt, draft, event, submissionId:receipt.submissionId, language};
}
async function counts(q) {
  return one(`SELECT (SELECT count(*)::int FROM assessments WHERE submission_id=$1) AS assessment,
    (SELECT count(*)::int FROM writing_explanation_representation WHERE submission_id=$1) AS representation,
    (SELECT count(*)::int FROM writing_explanation_head WHERE submission_id=$1) AS head,
    (SELECT count(*)::int FROM usage_ledger WHERE submission_id=$1) AS debit`,[q.submissionId]);
}
async function facts(q) {
  const output = {};
  for (const table of ['submissions','assessments','jobs','usage_ledger','writing_explanation_representation','writing_explanation_head']) {
    const column = table === 'submissions' ? 'id' : 'submission_id';
    output[table] = (await db.admin.query(`SELECT to_jsonb(t) AS row FROM ${table} t WHERE ${column}=$1 ORDER BY to_jsonb(t)::text`,[q.submissionId])).rows;
  }
  output.balance = await one('SELECT allowance,used,reserved FROM entitlements WHERE owner_id=$1 AND exam_id=$2',[q.owner,q.attempt.exam_id]);
  return output;
}
async function originalSource(q) {
  return extractWritingExplanationSource({ownerId:q.owner,
    attempt:await one('SELECT * FROM attempts WHERE id=$1',[q.attempt.id]),
    submission:await one('SELECT * FROM submissions WHERE id=$1',[q.submissionId]),
    assessment:await one('SELECT * FROM assessments WHERE submission_id=$1',[q.submissionId])});
}
function wrappedPool(intercept) {
  return {query:(...args) => db.worker.query(...args), async connect() {
    const client = await db.worker.connect();
    return {release:() => client.release(), query:async (sql, args) => {
      await intercept(sql,args,client);
      return client.query(sql,args);
    }};
  }};
}
function pausedSuccess() {
  const reached = gate(), release = gate(); let once = false;
  return {reached:reached.ready, release:release.open, pool:wrappedPool(async sql => {
    if (!once && String(sql).includes('hashtextextended($1,7352)')) {once = true; reached.open(); await bounded(release.ready,'resume worker success');}
  })};
}
async function review(q, decision) {
  const row = await one('SELECT c.content_version_id,c.content_sha256,c.exam_id FROM task_version t JOIN content_version c USING(content_version_id) WHERE t.task_id=$1 AND t.version=$2',[q.attempt.task_id,q.attempt.task_version]);
  return tx(db.migration,client => syntheticContentReview(db,client,{kind:'content',examId:row.exam_id,subjectId:row.content_version_id,version:'',sha256:row.content_sha256},{decision,mediaRoot}));
}
try {
  process.env.B1PREP_CONTENT_MODE = 'internal-preview';
  delete process.env.B1PREP_SERVE_REVIEW; delete process.env.B1PREP_SERVE_RIGHTS;
  mediaRoot = await mkdtemp(path.join(tmpdir(),'hatoove-explanation-worker-'));
  db = await createFixture();
  assert.match(db.schema,/^ownapi_[a-f0-9]+$/);
  world = await createPostgresWorld({fixture:db,examCatalogue:catalogue}); port = world.store.port;
  await check('default built-in stores five exact heads for each recorded source language without changing grade or debit',async () => {
    for (const language of SIMULATION_LANGUAGES) {
      const q = await queued(language);
      assert.equal((await createWorker({pool:db.worker}).runOnce()).outcome,'succeeded');
      assert.deepEqual(await counts(q),{assessment:1,representation:5,head:5,debit:1});
      const original = await originalSource(q);
      assert.deepEqual(original.sourceObject.original_value,stubGrade({text,explanationLanguage:language}).feedback);
      const rows = (await db.admin.query('SELECT * FROM writing_explanation_representation WHERE submission_id=$1',[q.submissionId])).rows;
      assert.deepEqual(rows.map(r => r.language).sort(),[...SIMULATION_LANGUAGES].sort());
      for (const row of rows) {
        assert.equal(row.source_sha256,original.sourceSha256);
        assert.equal(row.provenance.kind,row.language === language ? 'original-assessment' : 'builtin-simulation-dictionary');
        assert.ok(row.payload.blocks.every(b => b.text === stubGrade({text,explanationLanguage:row.language}).feedback.criteria[0].comment));
      }
      const before = await facts(q);
      for (const requestedLanguage of SIMULATION_LANGUAGES) await tx(db.learner,async client => {
        const stored = await readExplanationRepresentations(client,{source:original});
        const view = projectExplanationView({source:original,requestedLanguage,...stored});
        assert.equal(view.displayed_language,requestedLanguage);
        assert.equal(view.state,requestedLanguage === language ? 'original' : 'translated');
        assert.equal(view.review.native_language.review_status,'unreviewed');
      },q.owner);
      assert.equal((await port.submit(q.owner,q.attempt.id,q.draft.revision,q.event,language)).replay,true);
      assert.deepEqual(await facts(q),before);
      assert.equal((await createWorker({pool:db.worker}).runOnce()).claimed,false);
    }
  });
  await check('injected byte-identical stub and injected stub function itself each store only the original',async () => {
    for (const direct of [false,true]) {
      const q = await queued('en'); let calls = 0;
      const grade = direct ? stubGrade : data => {calls++; return stubGrade(data);};
      assert.equal((await createWorker({pool:db.worker,grade}).runOnce()).outcome,'succeeded');
      assert.equal(calls,direct ? 0 : 1);
      assert.deepEqual(await counts(q),{assessment:1,representation:1,head:1,debit:1});
    }
  });
  await check('custom substantive comments and unknown corrections remain exact original prose',async () => {
    for (const corrections of [false,true]) {
      const q = await queued();
      const grade = data => {const a = stubGrade(data); if (corrections) a.feedback.corrections = ['Eine unbekannte Korrektur.']; else a.feedback.criteria[0].comment = 'Diese individuelle Rückmeldung darf nicht ersetzt werden.'; return a;};
      assert.equal((await createWorker({pool:db.worker,grade}).runOnce()).outcome,'succeeded');
      assert.deepEqual(await counts(q),{assessment:1,representation:1,head:1,debit:1});
      const source = await originalSource(q), row = await one('SELECT payload FROM writing_explanation_representation WHERE submission_id=$1',[q.submissionId]);
      assert.deepEqual(row.payload,source.originalPayload);
    }
  });
  await check('custom assessment without optional model or prompt metadata preserves its unknown original provenance',async () => {
    const q = await queued();
    assert.equal((await createWorker({pool:db.worker,grade:data => ({feedback:stubGrade(data).feedback})}).runOnce()).outcome,'succeeded');
    assert.deepEqual(await counts(q),{assessment:1,representation:1,head:1,debit:1});
    const source = await originalSource(q);
    assert.equal(source.identity.model_version,'unknown'); assert.equal(source.identity.prompt_version,'unknown');
  });
  await check('unknown recorded source language keeps the assessment and debit but persists no guessed original or variants',async () => {
    // Server-internal historical input; HTTP enum validation is not relaxed by this fixture.
    const q = await queued('fr');
    assert.equal((await createWorker({pool:db.worker}).runOnce()).outcome,'succeeded');
    assert.deepEqual(await counts(q),{assessment:1,representation:0,head:0,debit:1});
    const source = await originalSource(q);
    assert.equal(source.originalLanguage,null);
    const view = projectExplanationView({source,requestedLanguage:'ar'});
    assert.equal(view.displayed_language,null); assert.equal(view.representation.persisted,false);
    assert.deepEqual(source.sourceObject.original_value,stubGrade({text,explanationLanguage:'fr'}).feedback);
  });
  await check('retired custom comment and valid feedback with no prose never fail or receive simulation variants',async () => {
    const binding = {taskId:DEFAULT_TASK.taskId,taskVersion:DEFAULT_TASK.version,
      rubricId:FORMATIVE_WRITING_RUBRIC.rubricId,rubricVersion:FORMATIVE_WRITING_RUBRIC.version};
    for (const withComment of [true,false]) {
      const q = await queued('uk',binding), feedback = {kind:withComment ? undefined : 'synthetic-formative',...(withComment ? {comment:'Точний збережений коментар без перекладу.'} : {})};
      assert.equal((await createWorker({pool:db.worker,grade:() => ({feedback})}).runOnce()).outcome,'succeeded');
      assert.deepEqual(await counts(q),{assessment:1,representation:withComment ? 1 : 0,head:withComment ? 1 : 0,debit:1});
      assert.deepEqual((await originalSource(q)).sourceObject.original_value,JSON.parse(JSON.stringify(feedback)));
    }
  });
  await check('storage fault after the first representation rolls back assessment, heads and debit atomically; reclaim succeeds once',async () => {
    const q = await queued(); let inserts = 0;
    const pool = wrappedPool(async sql => {
      if (/INSERT INTO writing_explanation_representation/i.test(String(sql)) && ++inserts === 2) throw Error('synthetic_explanation_storage_fault');
    });
    await assert.rejects(createWorker({pool}).runOnce(),/synthetic_explanation_storage_fault/);
    assert.equal(inserts,2);
    assert.deepEqual(await counts(q),{assessment:0,representation:0,head:0,debit:0});
    assert.deepEqual(await one('SELECT used,reserved FROM entitlements WHERE owner_id=$1 AND exam_id=$2',[q.owner,q.attempt.exam_id]),{used:0,reserved:1});
    const worker = createWorker({pool:db.worker,now:() => new Date(Date.now()+120000)});
    assert.deepEqual(await worker.reclaimExpired(),{requeued:1,abandoned:0});
    assert.equal((await worker.runOnce()).outcome,'succeeded');
    assert.deepEqual(await counts(q),{assessment:1,representation:5,head:5,debit:1});
  });
  await check('two default workers create one assessment, one representation batch and one debit',async () => {
    const q = await queued();
    const results = await Promise.all([createWorker({pool:db.worker}).runOnce(),createWorker({pool:db.worker}).runOnce()]);
    assert.equal(results.filter(r => r.claimed).length,1);
    assert.deepEqual(await counts(q),{assessment:1,representation:5,head:5,debit:1});
  });
  await check('reclaimed default completion cannot add rows after a newer lease succeeds',async () => {
    const q = await queued(), pause = pausedSuccess(); let running;
    try {
      running = createWorker({pool:pause.pool}).runOnce(); running.catch(() => {});
      await bounded(pause.reached,'first worker success boundary');
      const worker = createWorker({pool:db.worker,now:() => new Date(Date.now()+120000)});
      assert.deepEqual(await worker.reclaimExpired(),{requeued:1,abandoned:0});
      assert.equal((await worker.runOnce()).outcome,'succeeded');
      const before = await facts(q); pause.release();
      assert.equal((await bounded(running,'stale completion')).outcome,'stale');
      assert.deepEqual(await facts(q),before);
    } finally {pause.release(); if (running) await running.catch(() => {});}
  });
  await check('account deletion before late default completion leaves no assessment, representation or debit',async () => {
    const q = await queued(), pause = pausedSuccess(); let running;
    try {
      running = createWorker({pool:pause.pool}).runOnce(); running.catch(() => {});
      await bounded(pause.reached,'late deletion boundary');
      assert.equal((await world.deletion.deleteAccount(q.owner)).verifiedAbsent,true);
      pause.release(); assert.equal((await bounded(running,'deleted worker')).outcome,'stale');
      assert.deepEqual(await counts(q),{assessment:0,representation:0,head:0,debit:0});
    } finally {pause.release(); if (running) await running.catch(() => {});}
  });
  await check('named review withdrawal before late default completion refunds without saving prose',async () => {
    const q = await queued(), pause = pausedSuccess(); let running;
    try {
      running = createWorker({pool:pause.pool}).runOnce(); running.catch(() => {});
      await bounded(pause.reached,'late review boundary');
      await review(q,'withdraw'); pause.release();
      const result = await bounded(running,'review refused worker');
      assert.equal(result.outcome,'failed'); assert.equal(result.code,'content_unavailable');
      assert.deepEqual(await counts(q),{assessment:0,representation:0,head:0,debit:0});
      assert.equal((await one('SELECT text FROM submissions WHERE id=$1',[q.submissionId])).text,text);
      assert.deepEqual(await one('SELECT used,reserved FROM entitlements WHERE owner_id=$1 AND exam_id=$2',[q.owner,q.attempt.exam_id]),{used:0,reserved:0});
    } finally {pause.release(); if (running) await running.catch(() => {}); await review(q,'approve');}
  });
  await check('DTZ default dictionary preserves its four criterion facts and all five exact language heads',async () => {
    const pkg = await publishCompleteDtzFixture(db,{mediaRoot,version:'v9700',availableVersion:'v9701'}), task = pkg.internal.writingTasks[0];
    const q = await queued('ar',{taskId:task.taskId,taskVersion:task.version,rubricId:task.rubricId,rubricVersion:task.rubricVersion},'dtz-a2-b1');
    assert.equal((await createWorker({pool:db.worker,examCatalogue:catalogue}).runOnce()).outcome,'succeeded');
    assert.deepEqual(await counts(q),{assessment:1,representation:5,head:5,debit:1});
    const source = await originalSource(q);
    assert.equal(source.originalFormat,'dtz-writing-bands'); assert.equal(source.originalPayload.blocks.length,4);
    assert.ok(source.sourceObject.original_value.criteria.every(c => c.band === 'A2' && text.includes(c.evidence)));
    const before = await facts(q);
    for (const requestedLanguage of SIMULATION_LANGUAGES) await tx(db.learner,async client => {
      const view = projectExplanationView({source,requestedLanguage,...await readExplanationRepresentations(client,{source})});
      assert.equal(view.displayed_language,requestedLanguage); assert.equal(view.representation.payload.blocks.length,4);
    },q.owner);
    assert.deepEqual(await facts(q),before);
  });
} finally {
  const failures = [];
  try {if (world) await world.teardown(); else if (db) await db.cleanup();} catch (error) {failures.push(error);}
  if (db) {
    const verifier = new db.admin.constructor({...db.config,max:1});
    try {
      const row = (await verifier.query(`SELECT EXISTS(SELECT 1 FROM pg_namespace WHERE nspname=$1) AS schema_exists,
        EXISTS(SELECT 1 FROM pg_roles WHERE rolname=ANY($2::text[])) AS roles_exist`,[db.schema,Object.values(db.roles)])).rows[0];
      assert.deepEqual(row,{schema_exists:false,roles_exist:false});
    } catch (error) {failures.push(error);}
    finally {try {await verifier.end();} catch (error) {failures.push(error);}}
  }
  try {
    if (mediaRoot) {
      const resolved = path.resolve(mediaRoot), parent = path.resolve(tmpdir());
      if (path.dirname(resolved) !== parent || !path.basename(resolved).startsWith('hatoove-explanation-worker-')) throw Error('Unsafe media cleanup path');
      await rm(resolved,{recursive:true,force:true});
    }
  } catch (error) {failures.push(error);}
  finally {for (const key of policyKeys) {if (savedEnv[key] === undefined) delete process.env[key]; else process.env[key] = savedEnv[key];}}
  if (failures.length) throw new AggregateError(failures,'Explanation worker cleanup failed');
}
console.log(`${passed} explanation worker PostgreSQL checks passed; unique schema and media removed`);

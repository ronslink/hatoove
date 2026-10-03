/** Known-rubric package writing must retain prompt/release checks before and after grading. */
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {createFixture} from '../server/owned-postgres/bootstrap.mjs';
import {createPostgresWorld} from '../server/owned-postgres/fixture.mjs';
import {importDefaultPackage,importPackage} from '../server/owned-postgres/package-importer.mjs';
import {createWorker,stubGrade} from '../server/owned-postgres/worker.mjs';
import {createCompleteFixture} from './exam-s5b-fixture.mjs';
if(process.env.OWNAPI_PG_ALLOW!=='1'||!process.env.OWNAPI_PG_PORT||[4300,55440].includes(Number(process.env.OWNAPI_PG_PORT)))throw Error('Explicit disposable PostgreSQL port required');
const savedEnv=Object.fromEntries(['B1PREP_CONTENT_MODE','B1PREP_SERVE_REVIEW','B1PREP_SERVE_RIGHTS'].map(key=>[key,process.env[key]]));
process.env.B1PREP_CONTENT_MODE='internal-preview';delete process.env.B1PREP_SERVE_REVIEW;delete process.env.B1PREP_SERVE_RIGHTS;
let mediaRoot,db;
let passed=0;const check=async(name,work)=>{await work();passed++;console.log('PASS '+name);};
const gate=()=>{let open;const ready=new Promise(resolve=>{open=resolve;});return {ready,open};};
async function bounded(work,label,milliseconds=8000) {
  let timer;
  try {return await Promise.race([work,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Timed out: '+label)),milliseconds);})]);}
  finally {clearTimeout(timer);}
}
function pausedWorker(matches) {
  const reached=gate(),resume=gate();let pid=null,paused=false;
  return {reached:reached.ready,resume:resume.open,get pid(){return pid;},pool:{
    query:(...args)=>db.worker.query(...args),
    async connect() {
      const client=await db.worker.connect();pid=client.processID;
      return {release:()=>client.release(),async query(sql,params) {
        if(!paused&&matches(sql)){paused=true;reached.open();await bounded(resume.ready,'release synthetic worker barrier');}
        const result=await client.query(sql,params);
        if(sql==='BEGIN')await client.query("SET LOCAL lock_timeout='6s'; SET LOCAL statement_timeout='8s'");
        return result;
      }};
    },
  }};
}
async function assertAdvisoryWait(waiter,blocker) {
  const until=Date.now()+3000;
  while(Date.now()<until) {
    const row=(await db.admin.query(`SELECT $2::integer=ANY(pg_blocking_pids($1)) AS blocked,
      EXISTS(SELECT 1 FROM pg_locks WHERE pid=$1 AND locktype='advisory' AND NOT granted) AS advisory`,[waiter,blocker])).rows[0];
    if(row.blocked&&row.advisory)return;
    await new Promise(resolve=>setTimeout(resolve,20));
  }
  assert.fail('Expected a real separate-connection advisory wait');
}
try {
  mediaRoot=await mkdtemp(path.join(os.tmpdir(),'hatoove-s5b-worker-'));
  db=await createFixture({stopBefore:'0033-'});
  const originalRights=(await db.admin.query('SELECT * FROM content_rights ORDER BY content_version_id')).rows;
  const originalGrants=(await db.admin.query("SELECT relacl FROM pg_class WHERE oid='content_rights'::regclass")).rows;
  await db.applyRemaining();
  await check('forward rights fence preserves every existing decision and table grant',async()=>{
    assert.deepEqual((await db.admin.query('SELECT * FROM content_rights ORDER BY content_version_id')).rows,originalRights);
    assert.deepEqual((await db.admin.query("SELECT relacl FROM pg_class WHERE oid='content_rights'::regclass")).rows,originalGrants);
  });
  const world=await createPostgresWorld({fixture:db}),port=world.store.port;
  await importDefaultPackage(db.migration);
  const original=await createCompleteFixture({mediaRoot,version:'v9300',releaseVersion:'v9300',blueprintVersion:'v9300'});
  const form={...original.forms[0],id:'s5b.telc.assigned-worker',scope:'section',sections:['writing'],mode:'untimed',timeLimitSeconds:null,members:[]};
  delete form.timingPolicy;delete form.attemptMode;original.forms=[form];
  const publish=async(release,blocked=[])=>{const p=structuredClone(original);p.release={version:release,state:blocked.length?'withdrawn':'internal',resumeBlockedReleases:blocked};return importPackage(db.migration,p,{publisher:'synthetic-s5b-worker',mediaRoot});};
  async function queued(release,complete=null) {
    if(complete)await importPackage(db.migration,complete,{publisher:'synthetic-s5b-worker-full',mediaRoot});else await publish(release);
    const selected=complete?complete.forms[0]:form;
    const signed=await world.sessions.signUp({name:'Synthetic assigned writing',email:'s5b-worker-'+randomUUID()+'@example.invalid',password:'synthetic-s5b-password'});
    const id=(await world.sessions.getSession({cookie:String(signed.setCookie).split(';')[0]})).userId;
    const prep=(await port.listPreparations(id)).find(p=>p.exam_id==='telc-deutsch-b1');
    const run=(await port.startMockRun(id,{preparationId:prep.id,formId:selected.id,formVersion:selected.version,releaseVersion:release,eventId:randomUUID()})).run;
    assert.equal(run.writing.binding_kind,'assigned');assert.equal(run.writing.selected_option_id,null);
    if(complete) {
      const client=await db.admin.connect();
      try {await client.query('BEGIN');await client.query('SET LOCAL session_replication_role=replica');
        await client.query("UPDATE mock_run SET created_at=created_at-interval '7201 seconds',deadline_at=deadline_at-interval '7201 seconds' WHERE id=$1",[run.id]);
        await client.query("UPDATE mock_run_time_group SET starts_at=starts_at-interval '7201 seconds',deadline_at=deadline_at-interval '7201 seconds' WHERE run_id=$1",[run.id]);
        await client.query('COMMIT');
      }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
    }
    const text='Sehr geehrte Frau Weber, vielen Dank für Ihre Nachricht. Ich kann am Freitag kommen. Mit freundlichen Grüßen';
    const saved=await port.save(id,run.writing.attempt_id,run.writing.draft_revision,text);
    const finished=await port.finaliseMockRun(id,run.id,{expectedRevision:run.revision,eventId:randomUUID(),expectedWritingRevision:saved.revision,explanationLanguage:'uk'});
    assert.equal(finished.writing.assessment_state,'pending');return {id,run,finished,text,submissionId:finished.writing.submission_id};
  }
  async function assertRefunded(value) {
    const balance=(await db.admin.query('SELECT used,reserved FROM entitlements WHERE owner_id=$1 AND exam_id=$2',[value.id,'telc-deutsch-b1'])).rows[0];
    assert.equal(balance.used,0);assert.equal(balance.reserved,0);
    assert.equal((await db.admin.query('SELECT text FROM submissions WHERE id=$1',[value.submissionId])).rows[0].text,value.text);
    assert.equal((await db.admin.query('SELECT count(*)::int AS n FROM assessments WHERE submission_id=$1',[value.submissionId])).rows[0].n,0);
    assert.equal((await db.admin.query('SELECT count(*)::int AS n FROM usage_ledger WHERE submission_id=$1',[value.submissionId])).rows[0].n,0);
  }
  await check('known telc rubric receives exact assigned full prompt, binding and explanation language',async()=>{
    const value=await queued('v9300');let input;
    const result=await createWorker({pool:db.worker,grade:async data=>{input=data;return stubGrade(data);}}).runOnce();
    assert.equal(result.outcome,'succeeded');assert.equal(input.task.task_id,form.writingTask.taskId);assert.equal(input.task.version,form.writingTask.taskVersion);
    assert.equal(input.task.rubric_id,'writing.telc-b1');assert.equal(input.task.leitpunkte.length,4);assert.equal(input.selectedOption.binding_kind,'assigned');
    assert.equal(input.selectedOption.selected_option_id,null);assert.equal(input.explanationLanguage,'uk');assert.equal(input.text,value.text);
  });
  await check('pinned release withdrawal before grading prevents the call and refunds the reservation',async()=>{
    const value=await queued('v9301');await publish('v9302',['v9301']);let calls=0;
    const result=await createWorker({pool:db.worker,grade:async data=>{calls++;return stubGrade(data);}}).runOnce();
    assert.equal(result.outcome,'failed');assert.equal(result.code,'content_unavailable');assert.equal(calls,0);await assertRefunded(value);
  });
  await check('withdrawal during known-rubric grading refuses late assessment and debit without losing text',async()=>{
    const value=await queued('v9303');
    const result=await createWorker({pool:db.worker,grade:async data=>{await publish('v9304',['v9303']);return stubGrade(data);}}).runOnce();
    assert.equal(result.outcome,'failed');assert.equal(result.code,'content_unavailable');await assertRefunded(value);
  });
  await check('public policy cannot grade internal assigned telc merely because its rubric is known',async()=>{
    const value=await queued('v9305');let calls=0;process.env.B1PREP_CONTENT_MODE='public';
    try {const result=await createWorker({pool:db.worker,grade:async data=>{calls++;return stubGrade(data);}}).runOnce();assert.equal(result.code,'content_unavailable');assert.equal(calls,0);await assertRefunded(value);}
    finally {process.env.B1PREP_CONTENT_MODE='internal-preview';}
  });
  await check('a grading exception preserves the submitted assigned text and avoids a successful-review debit',async()=>{
    const value=await queued('v9306');const result=await createWorker({pool:db.worker,grade:async()=>{throw Object.assign(Error('Synthetic outage'),{code:'grader_unavailable'});}}).runOnce();
    assert.equal(result.code,'grader_error');await assertRefunded(value);
  });
  for(const during of [false,true])await check('complete-form media rights withdrawal '+(during?'during':'before')+' known-rubric grading prevents assessment and debit',async()=>{
    const version=during?'v9500':'v9400';const complete=await createCompleteFixture({mediaRoot,version,releaseVersion:version,blueprintVersion:version});
    const value=await queued(version,complete),media=complete.media[0];let calls=0;
    const withdraw=()=>db.migration.query("INSERT INTO content_rights(content_version_id,basis,decided_by,note) VALUES($1,'unknown','synthetic worker check','No rights approval')",[media.mediaId+'@'+media.version]);
    if(!during)await withdraw();
    const result=await createWorker({pool:db.worker,grade:async data=>{calls++;if(during)await withdraw();return stubGrade(data);}}).runOnce();
    assert.equal(calls,during?1:0);assert.equal(result.code,'content_unavailable');await assertRefunded(value);
  });
  await check('worker-first late-window rights INSERT waits until assessment and debit commit',async()=>{
    const version='v9600',complete=await createCompleteFixture({mediaRoot,version,releaseVersion:version,blueprintVersion:version});
    const value=await queued(version,complete),contentId=complete.media[0].mediaId+'@'+version;
    // Pause the real restricted worker after its final rights reads, immediately before the assessment write.
    const worker=pausedWorker(sql=>sql.includes('INSERT INTO assessments'));
    const work=createWorker({pool:worker.pool,grade:stubGrade}).runOnce();work.catch(()=>{});
    const rights=await db.migration.connect();let insertion;
    try {
      await bounded(worker.reached,'worker reached the late assessment window');
      assert.notEqual(worker.pid,rights.processID);
      await rights.query("BEGIN; SET LOCAL lock_timeout='6s'; SET LOCAL statement_timeout='8s'");
      insertion=rights.query("INSERT INTO content_rights(content_version_id,basis,decided_by,note) VALUES($1,'unknown','synthetic rights race','Withdrawal after final worker rights read')",[contentId]);insertion.catch(()=>{});
      await assertAdvisoryWait(rights.processID,worker.pid);
      assert.equal((await db.admin.query('SELECT count(*)::int AS n FROM content_rights WHERE content_version_id=$1',[contentId])).rows[0].n,0);
      worker.resume();const result=await bounded(work,'worker commits before withdrawal');assert.equal(result.outcome,'succeeded');
      await bounded(insertion,'rights insertion resumes after worker commit');await rights.query('COMMIT');
      const balance=(await db.admin.query('SELECT used,reserved FROM entitlements WHERE owner_id=$1 AND exam_id=$2',[value.id,'telc-deutsch-b1'])).rows[0];
      assert.deepEqual(balance,{used:1,reserved:0});
      assert.equal((await db.admin.query('SELECT count(*)::int AS n FROM assessments WHERE submission_id=$1',[value.submissionId])).rows[0].n,1);
      assert.equal((await db.admin.query('SELECT count(*)::int AS n FROM usage_ledger WHERE submission_id=$1',[value.submissionId])).rows[0].n,1);
      assert.equal((await db.admin.query('SELECT basis FROM content_rights WHERE content_version_id=$1',[contentId])).rows[0].basis,'unknown');
    } finally {
      worker.resume();await Promise.allSettled([work,...(insertion?[insertion]:[])]);
      await rights.query('ROLLBACK').catch(()=>{});rights.release();
    }
  });
  await check('withdrawal-first INSERT blocks the final worker lock, then refuses assessment and refunds',async()=>{
    const version='v9700',complete=await createCompleteFixture({mediaRoot,version,releaseVersion:version,blueprintVersion:version});
    const value=await queued(version,complete),contentId=complete.media[0].mediaId+'@'+version;
    const worker=pausedWorker(sql=>sql.includes('pg_advisory_xact_lock')&&sql.includes('7351'));
    const work=createWorker({pool:worker.pool,grade:stubGrade}).runOnce();work.catch(()=>{});
    const rights=await db.migration.connect();
    try {
      await bounded(worker.reached,'worker reached exam lock');assert.notEqual(worker.pid,rights.processID);
      await rights.query("BEGIN; SET LOCAL lock_timeout='6s'; SET LOCAL statement_timeout='8s'");
      await rights.query("INSERT INTO content_rights(content_version_id,basis,decided_by,note) VALUES($1,'unknown','synthetic rights race','Withdrawal wins before final worker rights read')",[contentId]);
      worker.resume();await assertAdvisoryWait(worker.pid,rights.processID);
      assert.equal((await db.admin.query('SELECT count(*)::int AS n FROM assessments WHERE submission_id=$1',[value.submissionId])).rows[0].n,0);
      await rights.query('COMMIT');const result=await bounded(work,'worker observes committed withdrawal');
      assert.equal(result.outcome,'failed');assert.equal(result.code,'content_unavailable');await assertRefunded(value);
    } finally {
      worker.resume();await rights.query('ROLLBACK').catch(()=>{});await Promise.allSettled([work]);rights.release();
    }
  });
  await check('rights decisions remain immutable and missing content cannot bypass the exam fence',async()=>{
    const contentId=originalRights[0].content_version_id;
    await assert.rejects(db.migration.query("UPDATE content_rights SET note='Synthetic forbidden rewrite' WHERE content_version_id=$1",[contentId]),error=>/immutable/i.test(error.message));
    await assert.rejects(db.migration.query('DELETE FROM content_rights WHERE content_version_id=$1',[contentId]),error=>/immutable/i.test(error.message));
    await assert.rejects(db.migration.query("INSERT INTO content_rights(content_version_id,basis,decided_by,note) VALUES('missing.synthetic@v1','unknown','synthetic rights check','No content identity exists')"),error=>error.code==='23503'&&error.message==='rights_content_not_found');
    assert.deepEqual((await db.admin.query('SELECT * FROM content_rights WHERE content_version_id=$1',[contentId])).rows[0],originalRights[0]);
  });
  await check('fence uses the content exam, rejects unknown exams and releases its lock on rollback',async()=>{
    const examId='synthetic-rights-'+db.schema;
    const contentSql="INSERT INTO content_version(content_version_id,kind,family,source_path,review_status,rights_status,content_sha256,exam_id) VALUES($1,'synthetic','synthetic','synthetic:rights-fence','unreviewed','generated',$2,$3)";
    await assert.rejects(db.migration.query(contentSql,['missing-exam.synthetic@v1','0'.repeat(64),'missing-exam']),error=>error.code==='23503');
    await db.migration.query("INSERT INTO exam_package(exam_id,exam,level,exam_language,blueprint_version) VALUES($1,'Synthetic rights exam','synthetic','de','synthetic-v1')",[examId]);
    await db.migration.query(contentSql,['other-exam.synthetic@v1','0'.repeat(64),examId]);
    const rights=await db.migration.connect();let probe;
    try {
      probe=await db.migration.connect();
      assert.notEqual(rights.processID,probe.processID);
      await rights.query("BEGIN; SET LOCAL lock_timeout='6s'; SET LOCAL statement_timeout='8s'");
      await rights.query("INSERT INTO content_rights(content_version_id,basis,decided_by,note) VALUES('other-exam.synthetic@v1','unknown','synthetic rights check','Synthetic transaction will roll back')");
      await probe.query('BEGIN');
      assert.equal((await probe.query('SELECT pg_try_advisory_xact_lock(hashtextextended($1,7351)) AS locked',[examId])).rows[0].locked,false);
      assert.equal((await probe.query('SELECT pg_try_advisory_xact_lock(hashtextextended($1,7351)) AS locked',[examId+'-other'])).rows[0].locked,true);
      await rights.query('ROLLBACK');
      assert.equal((await probe.query('SELECT pg_try_advisory_xact_lock(hashtextextended($1,7351)) AS locked',[examId])).rows[0].locked,true);
      assert.equal((await probe.query("SELECT count(*)::int AS n FROM content_rights WHERE content_version_id='other-exam.synthetic@v1'")).rows[0].n,0);
    } finally {await rights.query('ROLLBACK').catch(()=>{});if(probe)await probe.query('ROLLBACK').catch(()=>{});rights.release();probe?.release();}
  });
  await check('rights fence adds no runtime write, definer or function execution privileges',async()=>{
    const functionName=db.schema+'.fence_content_rights_insert()';
    assert.equal((await db.admin.query('SELECT prosecdef FROM pg_proc WHERE oid=$1::regprocedure',[functionName])).rows[0].prosecdef,false);
    for(const key of ['auth','learner','worker','deletion','payments']) {
      const grants=(await db.admin.query("SELECT has_function_privilege($1,$2,'EXECUTE') AS execute,has_table_privilege($1,'content_rights','INSERT') AS insert",[db.roles[key],functionName])).rows[0];
      assert.deepEqual(grants,{execute:false,insert:false});
      await assert.rejects(db[key].query("INSERT INTO content_rights(content_version_id,basis,decided_by,note) VALUES('missing.synthetic@v1','unknown','synthetic rights check','Runtime mutation must be denied')"),error=>error.code==='42501');
    }
  });
  console.log('S5B worker: '+passed+' passed (restricted PostgreSQL; injected synthetic grader only)');
} finally {
  try {await db?.cleanup();} finally {
    try {
      if(mediaRoot&&path.dirname(mediaRoot)===os.tmpdir()&&path.basename(mediaRoot).startsWith('hatoove-s5b-worker-'))await rm(mediaRoot,{recursive:true,force:true});
    } finally {
      for(const [key,value]of Object.entries(savedEnv))if(value===undefined)delete process.env[key];else process.env[key]=value;
    }
  }
}

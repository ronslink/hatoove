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
const mediaRoot=await mkdtemp(path.join(os.tmpdir(),'hatoove-s5b-worker-'));
let db;
let passed=0;const check=async(name,work)=>{await work();passed++;console.log('PASS '+name);};
try {
  db=await createFixture();const world=await createPostgresWorld({fixture:db}),port=world.store.port;
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
    assert.equal(result.code,'grader_unavailable');await assertRefunded(value);
  });
  for(const during of [false,true])await check('complete-form media rights withdrawal '+(during?'during':'before')+' known-rubric grading prevents assessment and debit',async()=>{
    const version=during?'v9500':'v9400';const complete=await createCompleteFixture({mediaRoot,version,releaseVersion:version,blueprintVersion:version});
    const value=await queued(version,complete),media=complete.media[0];let calls=0;
    const withdraw=()=>db.migration.query("INSERT INTO content_rights(content_version_id,basis,decided_by,note) VALUES($1,'unknown','synthetic worker check','No rights approval')",[media.mediaId+'@'+media.version]);
    if(!during)await withdraw();
    const result=await createWorker({pool:db.worker,grade:async data=>{calls++;if(during)await withdraw();return stubGrade(data);}}).runOnce();
    assert.equal(calls,during?1:0);assert.equal(result.code,'content_unavailable');await assertRefunded(value);
  });
  console.log('S5B worker: '+passed+' passed (restricted PostgreSQL; injected synthetic grader only)');
} finally {
  try {await db?.cleanup();} finally {
    if(path.dirname(mediaRoot)===os.tmpdir()&&path.basename(mediaRoot).startsWith('hatoove-s5b-worker-'))await rm(mediaRoot,{recursive:true,force:true});
    for(const [key,value]of Object.entries(savedEnv))if(value===undefined)delete process.env[key];else process.env[key]=value;
  }
}

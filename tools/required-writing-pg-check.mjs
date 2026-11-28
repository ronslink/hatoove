/** Real package and restricted PostgreSQL lifecycle; no provider calls. */
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {createFixture} from '../server/owned-postgres/bootstrap.mjs';
import {createPostgresWorld} from '../server/owned-postgres/fixture.mjs';
import {importPackage} from '../server/owned-postgres/package-importer.mjs';
import {createExamCatalogue} from '../server/preparation-contract.mjs';
import {guardProviderFixture} from './provider-attempt-pg-check.mjs';
guardProviderFixture();process.env.B1PREP_CONTENT_MODE='internal-preview';
const pkg=JSON.parse(readFileSync(new URL('../content/exams/'+(process.argv.includes('--ielts')?'ielts-academic':'goethe-zertifikat-b2')+'/manifest.json',import.meta.url)));
const writingForm=pkg.forms.find(f=>f.sections.length===1&&f.sections[0]==='SA');
let db,world;
try {
 db=await createFixture();await importPackage(db.migration,pkg);
 world=await createPostgresWorld({fixture:db,examCatalogue:createExamCatalogue({enabled:['telc-deutsch-b1',pkg.exam.id]})});
 const port=world.store.port;
 const signed=await world.sessions.signUp({name:'Required writing validation',email:`required-${randomUUID()}@example.invalid`,password:'required-writing-validation'});
 const owner=(await world.sessions.getSession({cookie:String(signed.setCookie).split(';')[0]})).userId;
 const prep=(await port.createPreparation(owner,pkg.exam.id)).preparation;
 await db.admin.query('INSERT INTO entitlements(owner_id,exam_id,allowance,used,reserved) VALUES($1,$2,1,0,0) ON CONFLICT(owner_id,exam_id) DO UPDATE SET allowance=1',[owner,pkg.exam.id]);
 const start=async()=> (await port.startMockRun(owner,{preparationId:prep.id,formId:writingForm.id,formVersion:writingForm.version,releaseVersion:pkg.release.version,eventId:randomUUID()})).run;
 const run=await start();assert.equal(run.writing,null);assert.equal(run.writing_tasks.length,2);assert.equal(run.writing_attachments.length,2);
 const asOwner=async(fn)=>{const c=await db.learner.connect();try{await c.query('BEGIN');await c.query("SELECT set_config('hatoove.owner_id',$1,true)",[owner]);return await fn(c);}finally{await c.query('ROLLBACK');c.release();}};
 for(const binding of ['unknown','task2']) await assert.rejects(asOwner(async c=>{
  const aid=randomUUID(),source=run.writing_attachments[0].attempt_id;
  await c.query('INSERT INTO attempts(id,owner_id,task_id,task_version,rubric_id,rubric_version,preparation_id,exam_id) SELECT $1,owner_id,task_id,task_version,rubric_id,rubric_version,preparation_id,exam_id FROM attempts WHERE id=$2',[aid,source]);
  await c.query("INSERT INTO drafts(attempt_id,revision,text) VALUES($1,1,'')",[aid]);
  await c.query("INSERT INTO mock_writing(run_id,owner_id,attempt_id,binding_kind,binding_id) VALUES($1,$2,$3,'required',$4)",[run.id,owner,aid,binding]);
 }),/invalid_mock_writing/);
 await assert.rejects(asOwner(c=>c.query("UPDATE mock_writing SET binding_id='renamed' WHERE run_id=$1",[run.id])),e=>e.code==='42501');
 await assert.rejects(asOwner(c=>c.query('DELETE FROM mock_writing WHERE run_id=$1',[run.id])),e=>e.code==='42501');
 assert.equal((await asOwner(c=>c.query('SELECT * FROM mock_writing WHERE owner_id<>$1',[owner]))).rowCount,0);
 const detached=await start();
 // Administrator-only corruption in a rollback proves the finalisation guard independently from INSERT guards.
 const admin=await db.admin.connect();
 try {await admin.query('BEGIN');await admin.query("SELECT set_config('hatoove.owner_id',$1,true)",[owner]);await admin.query("DELETE FROM mock_writing WHERE run_id=$1 AND binding_id='task2'",[detached.id]);
  await assert.rejects(admin.query('SELECT finalise_mock_run($1,$2)',[detached.id,detached.revision]),/invalid_mock_writing/);
 } finally {await admin.query('ROLLBACK');admin.release();}
 console.log('PASS restricted SQL rejects wrong task/binding, rename and deletion; missing task prevents finalisation');
 const revisions={};
 for(const a of run.writing_attachments){const d=await port.save(owner,a.attempt_id,1,'Dies ist ein gespeicherter Text für die unabhängige Schreibaufgabe.');revisions[a.binding_id]=d.revision;}
 const body={expectedRevision:run.revision,eventId:randomUUID(),expectedWritingRevisions:revisions,explanationLanguage:'en'};
 await assert.rejects(port.finaliseMockRun(owner,run.id,{...body,expectedWritingRevisions:{...revisions,task2:1}}),e=>e.code==='draft_conflict');
 assert.equal((await port.readMockRun(owner,run.id)).state,'active');
 assert.equal((await db.admin.query('SELECT count(*)::int AS n FROM submissions WHERE owner_id=$1',[owner])).rows[0].n,0);
 console.log('PASS both required drafts exist and a stale second revision rolls back the entire finalisation');
 const done=await port.finaliseMockRun(owner,run.id,body);assert.equal(done.state,'finalised');
 assert.equal(done.writing_attachments.length,2);assert(done.writing_attachments.every(a=>a.submission_id));
 assert.equal(done.writing_attachments.filter(a=>a.assessment_state==='pending').length,1);
 assert.equal(done.writing_attachments.filter(a=>a.failure_code==='allowance_exhausted').length,1);
 assert.equal(new Set(done.writing_attachments.map(a=>a.submission_id)).size,2);
 const events=(await db.admin.query('SELECT event_id FROM submissions WHERE owner_id=$1',[owner])).rows;
 assert.equal(new Set(events.map(e=>e.event_id)).size,2);
 assert.deepEqual((await port.finaliseMockRun(owner,run.id,body)).writing_attachments,done.writing_attachments);
 assert.equal((await db.admin.query('SELECT count(*)::int AS n FROM jobs WHERE owner_id=$1',[owner])).rows[0].n,1);
 console.log('PASS two durable submissions, one-credit boundary, distinct events and idempotent replay');
 const empty=await start();const blank=await port.finaliseMockRun(owner,empty.id,{expectedRevision:empty.revision,eventId:randomUUID(),expectedWritingRevisions:{task1:1,task2:1},explanationLanguage:'de'});
 assert(blank.writing_attachments.every(a=>a.failure_code==='empty_submission'&&a.submission_id));
 console.log('PASS both blank responses remain saved and unassessed without trapping finalisation');
}finally{await world?.teardown?.();await db?.cleanup?.();}

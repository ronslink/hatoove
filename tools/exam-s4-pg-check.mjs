#!/usr/bin/env node
/** Restricted-role S4 database proof. Source-only synthetic fixture, no app/provider. */
import assert from 'node:assert/strict';
import {readFile,access} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {createFixture} from '../server/owned-postgres/bootstrap.mjs';
import {importHistoricalDefaultPackage,assertHistoricalProjectionAbsent} from './historical-content-fixture.mjs';
import {createPostgresWorld} from '../server/owned-postgres/fixture.mjs';
import {createPostgresDatastore,createPostgresAccountDeletion} from '../server/owned-postgres/adapter.mjs';
import {createWorker,stubGrade} from '../server/owned-postgres/worker.mjs';
import {readReleasedForm} from '../server/owned-postgres/packages.mjs';
import {importPackage,importDefaultPackage} from '../server/owned-postgres/package-importer.mjs';
import {createExamCatalogue} from '../server/preparation-contract.mjs';
import {syntheticS4Package} from './exam-s4-check.mjs';
import {syntheticContentReview} from './exam-s6-fixture.mjs';
if(process.env.OWNAPI_PG_ALLOW!=='1'||!process.env.OWNAPI_PG_PORT||[4300,55440].includes(Number(process.env.OWNAPI_PG_PORT))) throw Error('Explicit isolated OWNAPI_PG_ALLOW/PORT required');
process.env.B1PREP_CONTENT_MODE='internal-preview';delete process.env.B1PREP_SERVE_REVIEW;delete process.env.B1PREP_SERVE_RIGHTS;
const DTZ='dtz-a2-b1',TELC='telc-deutsch-b1';
const db=await createFixture({stopBefore:'0027-'});const catalogue=createExamCatalogue({enabled:[TELC,DTZ]});
const world=await createPostgresWorld({fixture:db,examCatalogue:catalogue}),port=world.store.port;
const defaultPort=createPostgresDatastore({pool:db.learner});
let passed=0;const check=async(name,fn)=>{await fn();passed++;console.log('PASS '+name);};
const reject=(promise,code)=>assert.rejects(promise,e=>e.code===code);
async function owner(tag){const r=await world.sessions.signUp({name:'Synthetic S4 '+tag,email:`s4-${tag}-${randomUUID()}@example.invalid`,password:'synthetic-password-s4'});const cookie=String(r.setCookie).split(';')[0];return {id:(await world.sessions.getSession({cookie})).userId,cookie};}
const start=async(o,form='s4-writing',release='v8100',version='v1')=>(await port.startMockRun(o.id,{preparationId:o.prep.id,formId:form,formVersion:version,releaseVersion:release,eventId:randomUUID()})).run;
const choose=(o,r,optionId='A',eventId=randomUUID())=>port.selectMockWriting(o.id,r.id,{expectedRevision:r.revision,eventId,choiceGroupId:'SA1',optionId});
const finalise=(o,r,revision=r.writing?.draft_revision,eventId=randomUUID())=>port.finaliseMockRun(o.id,r.id,{expectedRevision:r.revision,eventId,...(revision?{expectedWritingRevision:revision,explanationLanguage:'uk'}:{})});
async function saved(o,form='s4-writing',text='Synthetic learner text.',option='A') {let r=await choose(o,await start(o,form),option);const d=await port.save(o.id,r.writing.attempt_id,1,text);return {...r,writing:{...r.writing,draft_revision:d.revision}};}
async function allowance(o,n){await db.admin.query('INSERT INTO entitlements(owner_id,exam_id,allowance,used,reserved) VALUES($1,$2,$3,0,0) ON CONFLICT(owner_id,exam_id) DO UPDATE SET allowance=excluded.allowance',[o.id,DTZ,n]);}
async function sqlAs(owner,fn){const c=await db.learner.connect();try{await c.query('BEGIN');await c.query("SELECT set_config('hatoove.owner_id',$1,true)",[owner]);const r=await fn(c);await c.query('COMMIT');return r;}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}}
try {
 await importHistoricalDefaultPackage(db);
 await check('forward migration preserves existing telc writing records and unchanged package import hash',async()=>{
   const legacy=await owner('pre-s4');const aid=randomUUID();
   await db.admin.query(`INSERT INTO attempts(id,owner_id,task_id,task_version,rubric_id,rubric_version,preparation_id,exam_id)
    SELECT $1,$2,t.task_id,t.version,t.rubric_id,t.rubric_version,p.id,p.exam_id FROM task_version t JOIN learner_preparation p ON p.exam_id=t.exam_id
    WHERE p.owner_id=$2 AND p.exam_id='telc-deutsch-b1' ORDER BY t.task_id,t.version DESC LIMIT 1`,[aid,legacy.id]);
   await db.admin.query('INSERT INTO drafts(attempt_id,revision,text) VALUES($1,1,$2)',[aid,'Synthetic pre-S4 preserved draft.']);
   const before=(await db.admin.query('SELECT a.*,d.text,d.revision FROM attempts a JOIN drafts d ON d.attempt_id=a.id WHERE a.id=$1',[aid])).rows[0];
   const hash=(await db.admin.query("SELECT sha256 FROM exam_release WHERE exam_id='telc-deutsch-b1' ORDER BY version")).rows;
   await assertHistoricalProjectionAbsent(db);
   assert.deepEqual(await db.applyRemaining(),['0027-dtz-writing.sql','0028-payments.sql','0029-fixed-media.sql','0030-listening-playback.sql','0031-assigned-mock-writing.sql','0032-ordered-mock-time-groups.sql','0033-content-rights-fence.sql','0034-complete-dtz-admission.sql','0035-content-review.sql','0036-content-review-consumers.sql','0037-saved-explanations.sql','0038-provider-attempts.sql','0039-registration-language.sql','0040-explanation-review.sql']);
   assert.deepEqual((await db.admin.query('SELECT a.*,d.text,d.revision FROM attempts a JOIN drafts d ON d.attempt_id=a.id WHERE a.id=$1',[aid])).rows[0],before);
   assert.equal((await importDefaultPackage(db.migration)).unchanged,true);
   assert.deepEqual((await db.admin.query("SELECT sha256 FROM exam_release WHERE exam_id='telc-deutsch-b1' ORDER BY version")).rows,hash);
 });
 await importPackage(db.migration,syntheticS4Package(),{publisher:'synthetic-s4-check'});
 const a=await owner('a'),b=await owner('b');a.prep=(await port.createPreparation(a.id,DTZ)).preparation;b.prep=(await port.createPreparation(b.id,DTZ)).preparation;
 await check('import replay exactness, changed versions and cross-exam references fail atomically',async()=>{
   assert.equal((await importPackage(db.migration,syntheticS4Package())).unchanged,true);
   for(const mutate of [p=>p.writingTasks[0].situation='Changed',p=>p.rubrics[0].criteria[0].descriptors.B1='Changed',p=>p.forms[0].writingChoices[0].options[0].taskVersion='v99',p=>p.writingTasks[0].rubricId='writing.telc-b1']){
     const p=syntheticS4Package();mutate(p);await assert.rejects(importPackage(db.migration,p),e=>e.code==='package_conflict');
   }
 });
 await check('default/public catalogue and direct writing/rubric IDs remain closed',async()=>{
   assert.equal((await port.listTasks(a.id,{examId:DTZ})).length,2);assert.equal((await defaultPort.listTasks(a.id,{examId:DTZ})).length,0);
   assert.equal(await defaultPort.readRubric(a.id,{rubricId:'s4.synthetic.rubric',version:'v1'}),null);
   const t=syntheticS4Package().writingTasks[0];await reject(defaultPort.create(a.id,null,{taskId:t.taskId,taskVersion:'v1',rubricId:t.rubricId,rubricVersion:'v1'},a.prep.id),'task_not_servable');
   process.env.B1PREP_CONTENT_MODE='public';assert.equal((await port.listTasks(a.id,{examId:DTZ})).length,0);assert.equal((await port.listMockForms(a.id,{preparationId:a.prep.id})).length,0);process.env.B1PREP_CONTENT_MODE='internal-preview';
 });
 await check('form review label includes every writing task and rubric, including writing-only forms',async()=>{
   const p=syntheticS4Package();
   async function bundle(form,taskReview,rubricReview) {
     const client=await db.migration.connect();
     try {
       await client.query('BEGIN');
       // Real named decisions replace raw review labels; rollback keeps later negative fixtures unreviewed.
       const ids=[...p.sets.map(x=>x.setId+'@'+x.version),
         ...(taskReview==='approved'?p.writingTasks.map(x=>x.taskId+'@'+x.version):[]),
         ...(rubricReview==='approved'?p.rubrics.map(x=>x.rubricId+'@'+x.version):[])];
       for(const id of ids) {
         const row=(await client.query('SELECT content_sha256 FROM content_version WHERE content_version_id=$1',[id])).rows[0];
         await syntheticContentReview(db,client,{kind:'content',examId:DTZ,subjectId:id,version:'',sha256:row.content_sha256});
       }
       const bp=(await client.query('SELECT sha256 FROM exam_blueprint WHERE exam_id=$1 AND version=$2',[DTZ,p.blueprint.version])).rows[0];
       await syntheticContentReview(db,client,{kind:'blueprint',examId:DTZ,subjectId:DTZ,version:p.blueprint.version,sha256:bp.sha256});
       const row=(await client.query('SELECT sha256 FROM exam_form WHERE exam_id=$1 AND form_id=$2 AND version=$3',[DTZ,form.id,form.version])).rows[0];
       await syntheticContentReview(db,client,{kind:'form',examId:DTZ,subjectId:form.id,version:form.version,sha256:row.sha256});
       return await readReleasedForm(client,{examId:DTZ,formId:form.id,formVersion:form.version,releaseVersion:p.release.version,newStart:true});
     } finally {await client.query('ROLLBACK');client.release();}
   }
   assert.equal((await bundle(p.forms[0],'approved','unreviewed')).reviewStatus,'unreviewed');
   assert.equal((await bundle(p.forms[0],'unreviewed','approved')).reviewStatus,'unreviewed');
   assert.equal((await bundle(p.forms[1],'approved','approved')).reviewStatus,'approved');
 });
 let immutable;
 await check('A/B choice is immutable, owner-fenced and idempotent with one attempt',async()=>{
   const r=await start(a),eventId=randomUUID();assert.equal(r.writing,null);assert.equal(r.writing_choices[0].options.length,2);
   immutable=await choose(a,r,'B',eventId);assert.equal(immutable.revision,2);assert.equal(immutable.writing.selected_option_id,'B');
   assert.equal((await choose(a,r,'B',eventId)).writing.attempt_id,immutable.writing.attempt_id);
   await reject(choose(a,immutable,'A'),'writing_choice_immutable');await reject(choose(b,r),'not_found');
   const attempt=await port.read(a.id,immutable.writing.attempt_id);assert.equal(attempt.task_id,'s4.synthetic.b');assert.equal(attempt.mock_run_id,r.id);
   await reject(port.submit(a.id,attempt.id,1,randomUUID()),'attached_mock_attempt');await reject(port.remove(a.id,attempt.id),'attached_mock_attempt');
   await assert.rejects(sqlAs(a.id,c=>c.query('UPDATE attempts SET deleted_at=now() WHERE id=$1',[attempt.id])),/attached_mock_attempt/);
   await assert.rejects(sqlAs(a.id,c=>c.query(`INSERT INTO submissions(id,attempt_id,owner_id,event_id,draft_revision,text,task_version,rubric_version,explanation_language) VALUES($1,$2,$3,$4,1,'Bypass','v1','v1','de')`,[randomUUID(),attempt.id,a.id,randomUUID()])),/attached_mock_attempt/);
   await assert.rejects(sqlAs(a.id,c=>c.query("UPDATE mock_writing SET selected_option_id='A' WHERE run_id=$1",[r.id])),e=>e.code==='42501');
 });
 await check('writing-only unselected and selected empty finalise preserve explicit unassessed state',async()=>{
   const unselected=await finalise(a,await start(a));assert.equal(unselected.result,null);assert.equal(unselected.writing,null);
   const done=await finalise(a,immutable);assert.equal(done.result,null);assert.equal(done.writing.assessment_state,'unassessed');assert.equal(done.writing.failure_code,'empty_submission');
   const result=await port.result(a.id,done.writing.submission_id);assert.equal(result.submission.text,'');assert.equal(result.job.status,'unassessed');assert.equal(result.assessment,null);
 });
 await check('exhausted DTZ preserves combined objective work and never spends telc credit',async()=>{
   const before=(await db.admin.query('SELECT used,reserved FROM entitlements WHERE owner_id=$1 AND exam_id=$2',[a.id,TELC])).rows[0];
   let r=await saved(a,'s4-combined');r=await port.saveMockRun(a.id,r.id,{expectedRevision:r.revision,eventId:randomUUID(),responses:[{setId:'s3.synthetic.grouped',version:'v1',itemId:'31',answer:'richtig'}],position:{member:0,item:0}});
   const done=await finalise(a,r);assert.equal(done.result.correct,1);assert.equal(done.result.total,8);assert.equal(done.writing.failure_code,'allowance_exhausted');
   assert.equal((await port.result(a.id,done.writing.submission_id)).submission.text,'Synthetic learner text.');
   assert.deepEqual((await db.admin.query('SELECT used,reserved FROM entitlements WHERE owner_id=$1 AND exam_id=$2',[a.id,TELC])).rows[0],before);
   assert.equal((await db.admin.query('SELECT 1 FROM jobs WHERE submission_id=$1',[done.writing.submission_id])).rowCount,0);
 });
 let assessed;
 await check('exact draft revision freezes once and worker receives full selected prompt/rubric/policy',async()=>{
   await allowance(a,20);const r=await saved(a,'s4-combined','A short synthetic letter.','B');
   await reject(finalise(a,r,1),'draft_conflict');assert.equal((await port.readMockRun(a.id,r.id)).state,'active');
   const eventId=randomUUID();assessed=await finalise(a,r,2,eventId);assert.equal(assessed.writing.assessment_state,'pending');assert.equal((await finalise(a,r,2,eventId)).writing.submission_id,assessed.writing.submission_id);
   let input;const worker=createWorker({pool:db.worker,examCatalogue:catalogue,grade:async x=>{input=x;return stubGrade(x);}});assert.equal((await worker.runOnce()).outcome,'succeeded');
   assert.equal(input.task.situation,'Synthetic B prompt v1.');assert.equal(input.task.register,'du');assert.equal(input.rubric.criteria.length,4);assert.equal(input.policy,'dtz-writing-practice-v1');assert.equal(input.selectedOption.selected_option_id,'B');assert.equal(input.explanationLanguage,'uk');
   const result=await port.result(a.id,assessed.writing.submission_id);assert.equal(result.assessment.feedback.kind,'dtz-writing-bands');assert.equal(result.assessment.model_version,'dtz-simulation-v1');
   assert.equal((await port.readMockRun(a.id,r.id)).writing.assessment_state,'assessed');
   assert.equal((await db.admin.query('SELECT used,reserved FROM entitlements WHERE owner_id=$1 AND exam_id=$2',[a.id,DTZ])).rows[0].used,1);
   const revision=await port.create(a.id,result.submission.id);assert.equal(revision.task_id,'s4.synthetic.b');assert.equal((await port.read(a.id,revision.id)).mock_run_id,null);
 });
 await check('default worker refuses internal DTZ before any grader call and refunds its reservation',async()=>{
   const done=await finalise(a,await saved(a));let called=false;
   const result=await createWorker({pool:db.worker,grade:async x=>{called=true;return stubGrade(x);}}).runOnce();
   assert.equal(result.outcome,'failed');assert.equal(result.code,'unsupported_rubric');assert.equal(called,false);
   assert.equal((await port.result(a.id,done.writing.submission_id)).submission.text,'Synthetic learner text.');
   assert.equal((await db.admin.query('SELECT reserved FROM entitlements WHERE owner_id=$1 AND exam_id=$2',[a.id,DTZ])).rows[0].reserved,0);
 });
 await check('malformed and thrown grading failures preserve text/objective feedback and refund exact reservation',async()=>{
   for(const grade of [async()=>{throw Object.assign(Error('synthetic'),{code:'synthetic_failure'});},async x=>({...stubGrade(x),feedback:{...stubGrade(x).feedback,total:20}})]) {
     const r=await finalise(a,await saved(a,'s4-combined'));const worker=createWorker({pool:db.worker,examCatalogue:catalogue,grade});assert.equal((await worker.runOnce()).outcome,'failed');
     const done=await port.readMockRun(a.id,r.id);assert.equal(done.writing.assessment_state,'failed');assert.equal(done.result.total,8);assert.equal((await port.result(a.id,done.writing.submission_id)).submission.text,'Synthetic learner text.');
     assert.equal((await db.admin.query('SELECT reserved FROM entitlements WHERE owner_id=$1 AND exam_id=$2',[a.id,DTZ])).rows[0].reserved,0);
     const before=(await db.admin.query('SELECT used FROM entitlements WHERE owner_id=$1 AND exam_id=$2',[a.id,DTZ])).rows[0].used;
     await port.retry(a.id,done.writing.submission_id);
     assert.equal((await createWorker({pool:db.worker,examCatalogue:catalogue}).runOnce()).outcome,'succeeded');
     assert.equal((await db.admin.query('SELECT used FROM entitlements WHERE owner_id=$1 AND exam_id=$2',[a.id,DTZ])).rows[0].used,before+1);
   }
 });
 await check('save/finalise race either freezes acknowledged draft or returns conflict without text loss',async()=>{
   const r=await saved(a);const [save,done]=await Promise.allSettled([port.save(a.id,r.writing.attempt_id,2,'Newest synthetic text.'),finalise(a,r)]);
   if(save.status==='fulfilled'){assert.equal(done.status,'rejected');assert.equal(done.reason.code,'draft_conflict');assert.equal((await port.read(a.id,r.writing.attempt_id)).text,'Newest synthetic text.');}
   else {assert.equal(done.status,'fulfilled');assert.ok(['mock_finalised','revision_required'].includes(save.reason.code));}
 });
 await check('ordinary withdrawal allows existing resume while explicit rights block hides prompts and stops grading',async()=>{
   const pending=await finalise(a,await saved(a));const draft=await saved(a);
   const withdrawn=syntheticS4Package({release:'v8101',state:'withdrawn'});await importPackage(db.migration,withdrawn);
   assert.equal((await port.listMockForms(a.id,{preparationId:a.prep.id})).length,0);
   await port.save(a.id,draft.writing.attempt_id,2,'After withdrawal.');
   const blocked=syntheticS4Package({release:'v8102',state:'withdrawn',blocked:['v8100']});await importPackage(db.migration,blocked);
   const read=await port.read(a.id,draft.writing.attempt_id);assert.equal(read.text,'After withdrawal.');assert.equal(read.blocked_reason,'rights_blocked');assert.equal(read.task,null);assert.equal(read.rubric,null);
   await reject(port.save(a.id,draft.writing.attempt_id,3,'Forbidden'),'rights_blocked');
   let called=false;const worker=createWorker({pool:db.worker,examCatalogue:catalogue,grade:async x=>{called=true;return stubGrade(x);}});await worker.runOnce();assert.equal(called,false);
   const oldResult=await port.result(a.id,assessed.writing.submission_id);assert.equal(oldResult.assessment,null);assert.ok(oldResult.submission.text);
   const exported=await port.exportData(a.id);assert.ok(exported.mock_writing.length);assert.ok(exported.submissions.some(s=>s.id===pending.writing.submission_id));assert.ok(exported.results.every(r=>!r.feedback));
 });
 await check('later prompt/rubric versions do not change saved run grading and pinned rights still hide reused content',async()=>{
   await importPackage(db.migration,syntheticS4Package({release:'v8200',version:'v2'}));await allowance(b,10);
   let r=await choose(b,await start(b,'s4-writing','v8200','v2'),'B');const d=await port.save(b.id,r.writing.attempt_id,1,'Version two learner text.');
   await importPackage(db.migration,syntheticS4Package({release:'v8201',version:'v3'}));r=await finalise(b,r,d.revision);
   let input;const worker=createWorker({pool:db.worker,examCatalogue:catalogue,grade:async x=>{input=x;return stubGrade(x);}});
   // Earlier rights-blocked jobs may still be queued; drain boundedly to this exact submission.
   for(let n=0;n<10;n++){const outcome=await worker.runOnce();if(outcome.submissionId===r.writing.submission_id){assert.equal(outcome.outcome,'succeeded');break;}}
   assert.equal(input.task.situation,'Synthetic B prompt v2.');assert.match(input.rubric.criteria[0].descriptors.B1,/v2/);
   const child=await port.create(b.id,r.writing.submission_id);assert.equal((await port.read(b.id,child.id)).mock_run_id,null);
   const cs=await port.submit(b.id,child.id,1,randomUUID());
   assert.equal((await createWorker({pool:db.worker,examCatalogue:catalogue}).runOnce()).outcome,'succeeded');
   const grandchild=await port.create(b.id,cs.submissionId);
   const grandchildSubmitted=await port.create(b.id,cs.submissionId);
   const gs=await port.submit(b.id,grandchildSubmitted.id,1,randomUUID());
   await importPackage(db.migration,syntheticS4Package({release:'v8202',version:'v2',blocked:['v8200']}));
   await reject(port.create(b.id,r.writing.submission_id),'rights_blocked');await reject(port.create(b.id,cs.submissionId),'rights_blocked');
   await reject(port.save(b.id,grandchild.id,1,'Blocked edit'),'rights_blocked');await reject(port.submit(b.id,grandchild.id,1,randomUUID()),'rights_blocked');
   const hidden=await port.read(b.id,grandchild.id);assert.equal(hidden.mock_run_id,null);assert.equal(hidden.task,null);assert.equal(hidden.rubric,null);assert.ok(hidden.text);
   let invoked=false;const blockedWorker=createWorker({pool:db.worker,examCatalogue:catalogue,grade:async x=>{invoked=true;return stubGrade(x);}});
   assert.equal((await blockedWorker.runOnce()).outcome,'failed');assert.equal(invoked,false);await reject(port.retry(b.id,gs.submissionId),'rights_blocked');
   assert.equal((await port.result(b.id,cs.submissionId)).assessment,null);
   assert.equal((await port.exportData(b.id)).results.find(x=>x.submission_id===cs.submissionId).feedback,null);
   await assert.rejects(sqlAs(b.id,c=>c.query('UPDATE drafts SET text=$2,revision=revision+1 WHERE attempt_id=$1',[grandchild.id,'SQL bypass'])),/mock_rights_blocked/);

   assert.equal((await port.result(b.id,r.writing.submission_id)).assessment,null);
   assert.equal((await port.exportData(b.id)).results.find(x=>x.submission_id===r.writing.submission_id).feedback,null);
 });
 await check('rights withdrawal during grading refuses the late assessment and refunds only its reservation',async()=>{
   let r=await choose(b,await start(b,'s4-writing','v8202','v2'));const d=await port.save(b.id,r.writing.attempt_id,1,'Late grading text.');r=await finalise(b,r,d.revision);
   const before=(await db.admin.query('SELECT used FROM entitlements WHERE owner_id=$1 AND exam_id=$2',[b.id,DTZ])).rows[0].used;
   const worker=createWorker({pool:db.worker,examCatalogue:catalogue,grade:async x=>{
     await importPackage(db.migration,syntheticS4Package({release:'v8203',version:'v2',state:'withdrawn',blocked:['v8200','v8202']}));return stubGrade(x);
   }});
   const outcome=await worker.runOnce();assert.equal(outcome.outcome,'failed');assert.equal(outcome.code,'content_unavailable');
   const result=await port.result(b.id,r.writing.submission_id);assert.equal(result.assessment,null);assert.equal(result.submission.text,'Late grading text.');
   assert.deepEqual((await db.admin.query('SELECT used,reserved FROM entitlements WHERE owner_id=$1 AND exam_id=$2',[b.id,DTZ])).rows[0],{used:before,reserved:0});
 });
 await check('account deletion removes attachment, drafts, jobs, results and late writes without resurrection',async()=>{
   const deletion=createPostgresAccountDeletion({pool:db.deletion});assert.equal((await deletion.deleteAccount(a.id)).verifiedAbsent,true);
   assert.equal((await db.admin.query('SELECT 1 FROM mock_writing WHERE owner_id=$1',[a.id])).rowCount,0);
   await reject(port.readMockRun(a.id,assessed.id),'not_found');assert.equal((await db.admin.query('SELECT 1 FROM attempts WHERE owner_id=$1',[a.id])).rowCount,0);
 });
 await check('deleting an account while its grader runs prevents late assessment resurrection',async()=>{
   await importPackage(db.migration,syntheticS4Package({release:'v8204',version:'v2'}));
   const c=await owner('late-delete');c.prep=(await port.createPreparation(c.id,DTZ)).preparation;await allowance(c,1);
   let r=await choose(c,await start(c,'s4-writing','v8204','v2'));const d=await port.save(c.id,r.writing.attempt_id,1,'Deleted during grading.');r=await finalise(c,r,d.revision);
   const worker=createWorker({pool:db.worker,examCatalogue:catalogue,grade:async x=>{assert.equal((await createPostgresAccountDeletion({pool:db.deletion}).deleteAccount(c.id)).verifiedAbsent,true);return stubGrade(x);}});
   assert.equal((await worker.runOnce()).outcome,'stale');
   assert.equal((await db.admin.query('SELECT 1 FROM assessments WHERE submission_id=$1',[r.writing.submission_id])).rowCount,0);
   assert.equal((await db.admin.query('SELECT 1 FROM mock_writing WHERE owner_id=$1',[c.id])).rowCount,0);
 });
 const sourceManifest=process.env.EXAM_S4_MANIFEST||new URL('../content/exams/dtz-a2-b1/writing-manifest.json',import.meta.url);
 if(await access(sourceManifest).then(()=>true,()=>false)) await check('original S3 then S4 manifests import with two internal writing choices and exact rubric',async()=>{
   await importPackage(db.migration,JSON.parse(await readFile(new URL('../content/exams/dtz-a2-b1/manifest.json',import.meta.url),'utf8')));
   const p=JSON.parse(await readFile(sourceManifest,'utf8'));await importPackage(db.migration,p);
   const forms=await port.listMockForms(b.id,{preparationId:b.prep.id});assert.equal(forms.length,2);assert.ok(forms.every(f=>f.writing_choice_count===1&&f.release_state==='internal'&&f.review_status==='unreviewed'));
   assert.equal((await port.listTasks(b.id,{examId:DTZ})).length,2);assert.equal((await defaultPort.listTasks(b.id,{examId:DTZ})).length,0);
 });
 console.log(`\n${passed} passed, 0 failed (restricted PostgreSQL S4)`);
}finally{await world.teardown();}

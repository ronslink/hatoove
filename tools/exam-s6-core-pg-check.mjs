/** S6 restricted SQL, unique disposable schema and synthetic approval simulation only. */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createFixture} from '../server/owned-postgres/bootstrap.mjs';
import {createPostgresWorld} from '../server/owned-postgres/fixture.mjs';
import {importPackage} from '../server/owned-postgres/package-importer.mjs';
import {readCurrentReleaseEligibility} from '../server/owned-postgres/release-eligibility.mjs';
import {createExamCatalogue} from '../server/preparation-contract.mjs';
import {publishCompleteDtzFixture,publishLegacyCompleteDtzFixture,syntheticContentReview} from './exam-s6-fixture.mjs';
if(process.env.OWNAPI_PG_ALLOW!=='1'||!process.env.OWNAPI_PG_PORT||[4300,55440].includes(Number(process.env.OWNAPI_PG_PORT)))throw Error('Explicit disposable PostgreSQL port required');
const DTZ='dtz-a2-b1',catalogue=createExamCatalogue({enabled:['telc-deutsch-b1',DTZ]});
const envKeys=['B1PREP_CONTENT_MODE','B1PREP_SERVE_REVIEW','B1PREP_SERVE_RIGHTS'],saved=Object.fromEntries(envKeys.map(key=>[key,process.env[key]]));
let db,mediaRoot,world,pkg,owner,prep,parent,passed=0;
const check=async(name,fn)=>{await fn();passed++;console.log('PASS '+name);};
async function asOwner(fn){const c=await db.learner.connect();try{await c.query('BEGIN');await c.query("SELECT set_config('hatoove.owner_id',$1,true)",[owner]);const r=await fn(c);await c.query('COMMIT');return r;}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}}
const eligibility=(pool=db.learner,rights=['generated'])=>pool.query('SELECT * FROM current_release_eligibility($1,$2::text[])',[DTZ,rights]).then(r=>r.rows[0]);
async function altered(sql,args,fn){const c=await db.admin.connect();try{await c.query('BEGIN');await c.query('SET LOCAL session_replication_role=replica');await c.query(sql,args);await fn(c);await c.query('ROLLBACK');}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}}
const insertAttempt=(c,{task=pkg.internal.writingTasks[0],parentId=null,id=randomUUID()}={})=>c.query(`INSERT INTO attempts(id,owner_id,task_id,task_version,rubric_id,rubric_version,parent_submission_id,preparation_id,exam_id)
 VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,[id,owner,task.taskId,task.version,task.rubricId,task.rubricVersion,parentId,prep.id,DTZ]);
async function assertWait(waiter,blocker){const until=Date.now()+3000;while(Date.now()<until){const r=(await db.admin.query("SELECT $2::integer=ANY(pg_blocking_pids($1)) AS blocked,EXISTS(SELECT 1 FROM pg_locks WHERE pid=$1 AND locktype='advisory' AND NOT granted) AS advisory",[waiter,blocker])).rows[0];if(r.blocked&&r.advisory)return;await new Promise(resolve=>setTimeout(resolve,20));}assert.fail('Expected a real separate-connection exam lock wait');}
try {
 process.env.B1PREP_CONTENT_MODE='internal-preview';delete process.env.B1PREP_SERVE_REVIEW;delete process.env.B1PREP_SERVE_RIGHTS;
 mediaRoot=await mkdtemp(path.join(tmpdir(),'hatoove-s6-core-'));db=await createFixture({stopBefore:'0034-'});
 world=await createPostgresWorld({fixture:db,examCatalogue:catalogue});
 pkg=await publishLegacyCompleteDtzFixture(db,{mediaRoot,version:'v9800',availableVersion:'v9801'});
 const signup=await world.sessions.signUp({name:'Synthetic S6 core',email:'s6-core-'+randomUUID()+'@example.invalid',password:'synthetic-s6-core-password'});
 owner=(await world.sessions.getSession({cookie:String(signup.setCookie).split(';')[0]})).userId;
 // Seed the historical row through its pre-upgrade restricted SQL grant; current adapters require0034.
 prep=await asOwner(async c=>(await c.query("INSERT INTO learner_preparation(id,owner_id,exam_id,state,revision) VALUES($1,$2,$3,'active',1) RETURNING id",[randomUUID(),owner,DTZ])).rows[0]);
 parent=await asOwner(async c=>{const attempt=(await insertAttempt(c)).rows[0];const id=randomUUID();await c.query(`INSERT INTO submissions(id,attempt_id,owner_id,event_id,draft_revision,text,task_version,rubric_version,explanation_language)
  VALUES($1,$2,$3,$4,1,'Synthetic saved parent text',$5,$6,'de')`,[id,attempt.id,owner,randomUUID(),pkg.internal.writingTasks[0].version,pkg.internal.writingTasks[0].rubricVersion]);return {attemptId:attempt.id,submissionId:id};});
 const before=(await db.admin.query('SELECT * FROM attempts ORDER BY id')).rows;
 await db.applyRemaining();
 await check('forward migration preserves existing attempts and preparation rows',async()=>{assert.deepEqual((await db.admin.query('SELECT * FROM attempts ORDER BY id')).rows,before);assert.equal((await world.store.port.readPreparation(owner,prep.id)).id,prep.id);});
 await check('complete approved synthetic DTZ passes the single SQL predicate with minimal metadata',async()=>{const e=await eligibility();assert.equal(e.eligible,true,JSON.stringify(e));assert.equal(e.complete_form_id,pkg.formId);assert.equal(e.complete_form_version,pkg.formVersion);assert.deepEqual(Object.keys(e),['eligible','exam_id','release_version','state','reason','complete_form_id','complete_form_version']);process.env.B1PREP_CONTENT_MODE='public';assert.equal((await readCurrentReleaseEligibility(db.learner,DTZ,{catalogue})).eligible,true);});
 await check('payment executes only minimal eligibility and has no new content reads or marking authority',async()=>{assert.equal((await eligibility(db.payments)).eligible,true);for(const table of ['objective_key','content_version','exam_form','exam_media','task_version'])await assert.rejects(db.payments.query('SELECT * FROM '+table),e=>e.code==='42501');await assert.rejects(db.payments.query("SELECT complete_dtz_form_eligible('x','v1','v1',ARRAY['generated'])"),e=>e.code==='42501');await assert.rejects(db.worker.query("SELECT * FROM current_release_eligibility('dtz-a2-b1',ARRAY['generated'])"),e=>e.code==='42501');});
 await check('recognized rights are intersected, while unknown and narrowed-out rights close eligibility',async()=>{assert.equal((await eligibility(db.learner,['unknown'])).eligible,false);assert.equal((await eligibility(db.learner,['licensed'])).eligible,false);assert.equal((await eligibility(db.learner,['unknown','generated'])).eligible,true);});
 await check('withdrawal of either writing prompt, reading, media or rubric approval closes the whole package',async()=>{const ids=[pkg.internal.writingTasks[0].taskId+'@v9800',pkg.internal.writingTasks[1].taskId+'@v9800',pkg.internal.sets.find(s=>s.section==='LV').setId+'@v9800',pkg.internal.media[0].mediaId+'@v9800',pkg.internal.rubrics[0].rubricId+'@v9800'];for(const id of ids){const c=await db.migration.connect();try{await c.query('BEGIN');const row=(await c.query('SELECT content_sha256 FROM content_version WHERE content_version_id=$1',[id])).rows[0];await syntheticContentReview(db,c,{kind:'content',examId:DTZ,subjectId:id,version:'',sha256:row.content_sha256},{decision:'withdraw',mediaRoot});assert.equal((await eligibility(c)).eligible,false,id);}finally{await c.query('ROLLBACK');c.release();}}});
 await check('malformed shape, timing, playback, member identity and writing policy fail closed',async()=>{
  const mutations=[
   ["UPDATE exam_form SET payload=jsonb_set(payload,'{scope}','\"section\"') WHERE exam_id=$1 AND version=$2",[DTZ,'v9800']],
   ["UPDATE exam_blueprint SET payload=jsonb_set(payload,'{timeGroups,0,seconds}','1499') WHERE exam_id=$1 AND version=$2",[DTZ,'v9800']],
   ["UPDATE exam_blueprint SET payload=jsonb_set(payload,'{sections,0,parts,0,playback,mock}','2') WHERE exam_id=$1 AND version=$2",[DTZ,'v9800']],
   ["UPDATE exam_form SET payload=jsonb_set(payload,'{members,0,setId}','\"missing\"') WHERE exam_id=$1 AND version=$2",[DTZ,'v9800']],
   ["UPDATE exam_form SET payload=jsonb_set(payload,'{writingChoices}','{}') WHERE exam_id=$1 AND version=$2",[DTZ,'v9800']],
   ["UPDATE rubric_version SET policy='unsupported' WHERE exam_id=$1 AND version=$2",[DTZ,'v9800']],
   ["UPDATE exam_blueprint SET payload=payload#-'{sections,2,parts}' WHERE exam_id=$1 AND version=$2",[DTZ,'v9800']],
   ["UPDATE objective_set SET payload=payload-'ads' WHERE exam_id=$1 AND version=$2 AND family='LV2'",[DTZ,'v9800']],
  ];
  for(const [sql,args]of mutations)await altered(sql,args,async c=>assert.equal((await eligibility(c)).eligible,false,sql));
 });
 await check('withdrawn, self-blocked and missing current heads refuse new eligibility',async()=>{
  for(const [sql,args]of [["UPDATE exam_release SET state='withdrawn' WHERE exam_id=$1 AND version=$2",[DTZ,'v9801']],
   ["UPDATE exam_release SET manifest=jsonb_set(manifest,'{release,resumeBlockedReleases}','[\"v9801\"]') WHERE exam_id=$1 AND version=$2",[DTZ,'v9801']],
   ['DELETE FROM exam_release_head WHERE exam_id=$1',[DTZ]]])await altered(sql,args,async c=>assert.equal((await eligibility(c)).eligible,false));
 });
 const pinned=(await world.store.port.startMockRun(owner,{preparationId:prep.id,formId:pkg.formId,formVersion:pkg.formVersion,releaseVersion:pkg.releaseVersion,eventId:randomUUID()})).run;
 await check('eligible new standalone attempts commit through the deferred SQL guard',async()=>{const result=await asOwner(c=>insertAttempt(c));assert.equal(result.rowCount,1);});
 await check('an unrelated invalid optional form does not hide a valid complete form',async()=>{
  await db.migration.query(`INSERT INTO exam_form(exam_id,form_id,version,blueprint_version,payload,sha256)
   SELECT exam_id,'synthetic.invalid.optional',version,blueprint_version,jsonb_set(payload,'{id}','"synthetic.invalid.optional"')-'writingChoices',sha256 FROM exam_form WHERE exam_id=$1 AND form_id=$2 AND version=$3`,[DTZ,pkg.formId,pkg.formVersion]);
  await db.migration.query("INSERT INTO exam_release_form(exam_id,release_version,form_id,form_version) VALUES($1,$2,'synthetic.invalid.optional',$3)",[DTZ,pkg.releaseVersion,pkg.formVersion]);
  assert.equal((await eligibility()).eligible,true);
 });
 // Synthetic malformed publication: privileged SQL can publish, but cannot turn a partial form into a complete predicate.
 await db.migration.query(`INSERT INTO exam_release(exam_id,version,blueprint_version,state,manifest,sha256,publisher)
  SELECT exam_id,'v9802',blueprint_version,state,jsonb_set(manifest,'{release,version}','"v9802"'),sha256,'synthetic negative publication' FROM exam_release WHERE exam_id=$1 AND version=$2`,[DTZ,pkg.releaseVersion]);
 await db.migration.query("INSERT INTO exam_release_form(exam_id,release_version,form_id,form_version) VALUES($1,'v9802','synthetic.invalid.optional',$2)",[DTZ,pkg.formVersion]);
 await db.migration.query("UPDATE exam_release_head SET release_version='v9802' WHERE exam_id=$1",[DTZ]);
 await check('incomplete available head rejects direct SQL preparation and standalone attempt admission',async()=>{
  assert.equal((await eligibility()).eligible,false);
  await assert.rejects(asOwner(c=>c.query("INSERT INTO learner_preparation(id,owner_id,exam_id,state) VALUES($1,$2,$3,'archived')",[randomUUID(),owner,DTZ])),/exam_unavailable/);
  await assert.rejects(asOwner(c=>insertAttempt(c)),/task_not_servable/);
  await assert.rejects(asOwner(c=>c.query(`INSERT INTO mock_run(id,owner_id,preparation_id,exam_id,release_version,blueprint_version,form_id,form_version,start_event_id,title,scope,mode)
   SELECT $1,$2,$3,exam_id,'v9802',blueprint_version,form_id,version,$4,payload->>'title',payload->>'scope',payload->>'mode' FROM exam_form
   WHERE exam_id=$5 AND form_id='synthetic.invalid.optional' AND version=$6`,[randomUUID(),owner,prep.id,randomUUID(),DTZ,pkg.formVersion])),/exam_unavailable/);
 });
 await check('SQL marking and standalone evidence cannot bypass complete-package admission with GUCs',async()=>{
  const set=pkg.internal.sets.find(s=>s.section==='LV');
  await assert.rejects(asOwner(async c=>{await c.query("SELECT set_config('hatoove.content_mode','internal-preview',true),set_config('hatoove.exam_eligible','true',true)");return c.query('SELECT mark_objective_item($1,$2,$3,$4::jsonb)',[set.setId,set.version,Object.keys(set.answers)[0],JSON.stringify(Object.values(set.answers)[0])]);}),/exam_unavailable/);
  await assert.rejects(asOwner(c=>c.query(`INSERT INTO item_evidence(evidence_id,owner_id,exam_id,preparation_id,set_id,version,item_id,family,section,answer,correct)
   VALUES($1,$2,$3,$4,$5,$6,'1',$7,$8,'"a"',false)`,[randomUUID(),owner,DTZ,prep.id,set.setId,set.version,set.family,set.section])),/exam_unavailable/);
 });
 await check('exact saved parent revision survives current loss, but a non-null forged parent does not',async()=>{
  assert.equal((await asOwner(c=>insertAttempt(c,{parentId:parent.submissionId}))).rowCount,1);
  await assert.rejects(asOwner(c=>insertAttempt(c,{parentId:parent.submissionId,task:pkg.internal.writingTasks[1]})),/invalid_attempt_continuation/);
  assert.equal((await db.admin.query('SELECT text FROM submissions WHERE id=$1',[parent.submissionId])).rows[0].text,'Synthetic saved parent text');
 });
 await check('deferred SQL validates a genuine pinned A/B attachment created after its attempt',async()=>{
  const admin=await db.admin.connect();try{await admin.query('BEGIN');await admin.query('SET LOCAL session_replication_role=replica');
   await admin.query("UPDATE mock_run SET created_at=created_at-interval '4201 seconds',deadline_at=deadline_at-interval '4201 seconds' WHERE id=$1",[pinned.id]);
   await admin.query("UPDATE mock_run_time_group SET starts_at=starts_at-interval '4201 seconds',deadline_at=deadline_at-interval '4201 seconds' WHERE run_id=$1",[pinned.id]);await admin.query('COMMIT');
  }catch(e){await admin.query('ROLLBACK');throw e;}finally{admin.release();}
  const selected=await world.store.port.selectMockWriting(owner,pinned.id,{expectedRevision:pinned.revision,eventId:randomUUID(),choiceGroupId:pkg.internal.forms[0].writingChoices[0].id,optionId:'A'});
  assert.equal(selected.writing.selected_option_id,'A');
  const finished=await world.store.port.finaliseMockRun(owner,pinned.id,{expectedRevision:selected.revision,eventId:randomUUID(),expectedWritingRevision:selected.writing.draft_revision,explanationLanguage:'de'});
  assert.equal(finished.result.total,45);assert.equal(finished.state,'finalised');
 });
 await check('internal partial DTZ remains explicit preview, while public and default catalogue reject it',async()=>{
  const partial=structuredClone(pkg.published);partial.release={version:'v9803',state:'internal',resumeBlockedReleases:[]};
  const form={...partial.forms[0],id:'synthetic.internal.partial',scope:'section',sections:['SA'],mode:'untimed',timeLimitSeconds:null,members:[]};delete form.timingPolicy;delete form.attemptMode;partial.forms=[form];
  await importPackage(db.migration,partial,{mediaRoot});
  assert.equal((await eligibility()).eligible,true);assert.equal((await readCurrentReleaseEligibility(db.learner,DTZ,{catalogue})).eligible,false);
  process.env.B1PREP_CONTENT_MODE='internal-preview';assert.equal((await readCurrentReleaseEligibility(db.learner,DTZ,{catalogue})).eligible,true);assert.equal((await readCurrentReleaseEligibility(db.learner,DTZ)).eligible,false);
  assert.equal((await asOwner(c=>c.query("INSERT INTO learner_preparation(id,owner_id,exam_id,state) VALUES($1,$2,$3,'archived') RETURNING id",[randomUUID(),owner,DTZ]))).rowCount,1);
 });
 for(const admissionFirst of [true,false])await check('direct SQL admission and rights withdrawal serialize: '+(admissionFirst?'admission commits first':'withdrawal commits first'),async()=>{
  const full=await publishCompleteDtzFixture(db,{mediaRoot,version:admissionFirst?'v9840':'v9850',availableVersion:admissionFirst?'v9841':'v9851'});
  const media=full.internal.media[0],id=randomUUID();let admission,rights,pending;
  try {
   admission=await db.learner.connect();rights=await db.migration.connect();assert.notEqual(admission.processID,rights.processID);
   for(const c of [admission,rights])await c.query("BEGIN;SET LOCAL statement_timeout='8s';SET LOCAL lock_timeout='6s'");
   await admission.query("SELECT set_config('hatoove.owner_id',$1,true)",[owner]);
   const admit=()=>admission.query("INSERT INTO learner_preparation(id,owner_id,exam_id,state) VALUES($1,$2,$3,'archived')",[id,owner,DTZ]);
   const withdraw=()=>rights.query("INSERT INTO content_rights(content_version_id,basis,decided_by,note) VALUES($1,'unknown','synthetic S6 race','Synthetic transaction ordering test')",[media.mediaId+'@'+media.version]);
   if(admissionFirst){await admit();pending=withdraw();pending.catch(()=>{});await assertWait(rights.processID,admission.processID);await admission.query('COMMIT');await pending;await rights.query('COMMIT');}
   else {await withdraw();pending=admit();pending.catch(()=>{});await assertWait(admission.processID,rights.processID);await rights.query('COMMIT');await assert.rejects(pending,/exam_unavailable/);await admission.query('ROLLBACK');}
   assert.equal((await db.admin.query('SELECT count(*)::int AS n FROM learner_preparation WHERE id=$1',[id])).rows[0].n,admissionFirst?1:0);
   assert.equal((await eligibility(db.admin)).eligible,false);
  } finally {
   await Promise.allSettled([admission?.query('ROLLBACK'),rights?.query('ROLLBACK')]);if(pending)await Promise.allSettled([pending]);admission?.release();rights?.release();
  }
 });
 console.log('S6 core PostgreSQL: '+passed+' passed (synthetic fixture only)');
} finally {
 try{await db?.cleanup();}finally{try{if(mediaRoot&&path.dirname(mediaRoot)===tmpdir()&&path.basename(mediaRoot).startsWith('hatoove-s6-core-'))await rm(mediaRoot,{recursive:true,force:true});}finally{for(const[key,value]of Object.entries(saved))if(value===undefined)delete process.env[key];else process.env[key]=value;}}
}

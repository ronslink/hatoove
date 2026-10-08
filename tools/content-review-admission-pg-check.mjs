/** C-03 consumers: synthetic review facts only, unique disposable schemas and real role fences. */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createFixture,rolePool} from '../server/owned-postgres/bootstrap.mjs';
import {createPostgresWorld} from '../server/owned-postgres/fixture.mjs';
import {createPostgresDatastore} from '../server/owned-postgres/adapter.mjs';
import {createWorker,stubGrade} from '../server/owned-postgres/worker.mjs';
import {importDefaultPackage,importPackage} from '../server/owned-postgres/package-importer.mjs';
import {recordReviewerAuthority,recordContentReview} from '../server/owned-postgres/content-review.mjs';
import {createExamCatalogue} from '../server/preparation-contract.mjs';
import {createCompleteFixture} from './exam-s5b-fixture.mjs';
if(process.env.OWNAPI_PG_ALLOW!=='1'||process.env.OWNAPI_PG_HOST!=='127.0.0.1'||!process.env.OWNAPI_PG_PORT||[4300,55440].includes(Number(process.env.OWNAPI_PG_PORT)))throw Error('Explicit isolated PostgreSQL target required');
const EXAM='dtz-a2-b1',catalogue=createExamCatalogue({enabled:['telc-deutsch-b1',EXAM]}),sha='c'.repeat(64);
const keys=['B1PREP_CONTENT_MODE','B1PREP_SERVE_REVIEW','B1PREP_SERVE_RIGHTS'],saved=Object.fromEntries(keys.map(k=>[k,process.env[k]]));
let db,world,port,mediaRoot,pkg,published,passed=0,extraPool;
const authorities=new Map(),heads=new Map();
const check=async(name,fn)=>{await fn();passed++;console.log('PASS '+name);};
const reject=(p,code)=>assert.rejects(p,e=>e.code===code||e.message===code);
const gate=()=>{let open;const ready=new Promise(resolve=>{open=resolve;});return{ready,open};};
async function bounded(p,label){let timer;try{return await Promise.race([p,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Timed out: '+label)),7000);})]);}finally{clearTimeout(timer);}}
async function tx(pool,fn,owner=null){const c=await pool.connect();try{await c.query('BEGIN');if(owner)await c.query("SELECT set_config('hatoove.owner_id',$1,true)",[owner]);const r=await fn(c);await c.query('COMMIT');return r;}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}}
async function subject(kind,id,version=''){
 const q=kind==='content'?'SELECT exam_id,content_sha256 AS sha256 FROM content_version WHERE content_version_id=$1':kind==='blueprint'?'SELECT exam_id,sha256 FROM exam_blueprint WHERE exam_id=$1 AND version=$2':'SELECT exam_id,sha256 FROM exam_form WHERE form_id=$1 AND version=$2';
 const r=(await db.migration.query(q,kind==='content'?[id]:[id,version])).rows[0];assert.ok(r);return{kind,examId:r.exam_id,subjectId:id,version,sha256:r.sha256};
}
const reviewKey=s=>[s.kind,s.examId,s.subjectId,s.version].join('|');
async function reviewInput(s,decision='approve'){
 const category=s.kind==='content'?(await db.migration.query('SELECT kind FROM content_version WHERE content_version_id=$1',[s.subjectId])).rows[0].kind==='media'?'audio':'educational':'exam_format';
 return{eventId:randomUUID(),subject:s,category,language:category==='audio'?'de':'',authorityId:authorities.get(s.examId+'|'+category),expectedDecisionId:heads.get(reviewKey(s))??null,decision,evidenceRef:'fixture://synthetic-decision',evidenceSha256:sha,rationale:'Synthetic disposable consumer test; no real human approval',packetSha256:null};
}
async function decide(s,value='approve',client=null){const input=await reviewInput(s,value);const r=client?await recordContentReview(client,input,{mediaRoot}):await tx(db.migration,c=>recordContentReview(c,input,{mediaRoot}));heads.set(reviewKey(s),r.decisionId);return r;}
async function makeOwner(tag){const signup=await world.sessions.signUp({name:'Synthetic '+tag,email:'c03-'+tag+'-'+randomUUID()+'@example.invalid',password:'synthetic-consumer-password'});return(await world.sessions.getSession({cookie:String(signup.setCookie).split(';')[0]})).userId;}
async function prepare(owner){const p=(await port.createPreparation(owner,EXAM)).preparation;await db.admin.query('INSERT INTO entitlements(owner_id,exam_id,allowance,used,reserved) VALUES($1,$2,20,0,0) ON CONFLICT(owner_id,exam_id) DO UPDATE SET allowance=20',[owner,EXAM]);return p;}
const start=(prep,eventId=randomUUID())=>({preparationId:prep.id,formId:pkg.forms[0].id,formVersion:pkg.forms[0].version,releaseVersion:published.release.version,eventId});
const binding=()=>({taskId:pkg.writingTasks[0].taskId,taskVersion:pkg.writingTasks[0].version,rubricId:pkg.writingTasks[0].rubricId,rubricVersion:pkg.writingTasks[0].rubricVersion});
async function queue(owner,prep){const a=await port.create(owner,null,binding(),prep.id);const d=await port.save(owner,a.id,1,'Guten Tag, vielen Dank für Ihre Nachricht. Ich komme am Freitag. Mit freundlichen Grüßen');const event=randomUUID(),s=await port.submit(owner,a.id,d.revision,event,'de');return{a,d,event,s};}
async function waits(waiter,blocker){const until=Date.now()+3500;while(Date.now()<until){const r=(await db.admin.query('SELECT $2::int=ANY(pg_blocking_pids($1)) AS blocked,EXISTS(SELECT 1 FROM pg_locks WHERE pid=$1 AND locktype=\'advisory\' AND NOT granted) AS advisory',[waiter,blocker])).rows[0];if(r.blocked&&r.advisory){console.log(`WAIT ${waiter} -> ${blocker}`);return;}await new Promise(resolve=>setTimeout(resolve,20));}assert.fail('Separate backend advisory wait was not observed');}
function observed(pool,pattern,{before=false}={}){
 const hit=gate(),resume=gate(),connected=gate();let pid,once=false;
 return{get pid(){return pid;},hit:hit.ready,resume:resume.open,connected:connected.ready,pool:{query:(...a)=>pool.query(...a),async connect(){const c=await pool.connect();pid=c.processID;connected.open();return{release:()=>c.release(),async query(sql,args){if(before&&!once&&pattern?.(sql)){once=true;hit.open();await bounded(resume.ready,'test barrier');}const r=await c.query(sql,args);if(sql==='BEGIN')await c.query("SET LOCAL lock_timeout='6s'; SET LOCAL statement_timeout='8s'");if(!before&&!once&&pattern?.(sql)){once=true;hit.open();await bounded(resume.ready,'test barrier');}return r;}};}}};
}
try{
 process.env.B1PREP_CONTENT_MODE='internal-preview';delete process.env.B1PREP_SERVE_REVIEW;delete process.env.B1PREP_SERVE_RIGHTS;
 mediaRoot=await mkdtemp(path.join(tmpdir(),'hatoove-c03-consumers-'));
 db=await createFixture({stopBefore:'0035-'});assert.match(db.schema,/^ownapi_[a-f0-9]+$/);
 for(const pool of[db.admin,db.migration])assert.equal((await pool.query('SELECT current_schema() AS schema')).rows[0].schema,db.schema);
 assert.equal((await db.migration.query('SELECT current_user AS role')).rows[0].role,db.roles.migration);
 await check('current importer refuses a pre-review schema instead of trusting raw historical flags',async()=>{await reject(importDefaultPackage(db.migration),'42P01');});
 const rawBefore=(await db.migration.query('SELECT content_version_id,review_status,content_sha256 FROM content_version ORDER BY content_version_id')).rows;
 await db.applyRemaining({stopBefore:'0037-'});
 await check('forward projection preserves exact legacy flags and identifies unattributed baseline',async()=>{const after=new Map((await db.migration.query('SELECT * FROM reviewed_content_version')).rows.map(r=>[r.content_version_id,r]));for(const r of rawBefore){assert.equal(after.get(r.content_version_id).raw_review_status,r.review_status);assert.equal(after.get(r.content_version_id).content_sha256,r.content_sha256);assert.equal(after.get(r.content_version_id).review_basis,'legacy_unattributed');}assert.deepEqual(await db.applyRemaining({stopBefore:'0037-'}),[]);});
 await db.applyRemaining();world=await createPostgresWorld({fixture:db,examCatalogue:catalogue});port=createPostgresDatastore({pool:db.learner,examCatalogue:catalogue,mediaRoot});extraPool=rolePool(db.config,db.schema,db.roles.learner,2);
 pkg=await createCompleteFixture({examId:EXAM,mediaRoot,version:'v9800',releaseVersion:'v9800',blueprintVersion:'v9800'});await importPackage(db.migration,pkg,{mediaRoot});
 published={...structuredClone(pkg),sets:[],media:[],writingTasks:[],rubrics:[],release:{version:'v9801',state:'available',resumeBlockedReleases:[]}};
 const a=await makeOwner('a'),prep=await prepare(a),newcomer=await makeOwner('new');
 await check('fresh raw-approved task and rubric cannot bypass effective public direct-ID policy',async()=>{
  for(const [kind,id] of [['rubric','synthetic.c03.raw-rubric'],['task','synthetic.c03.raw-task']]) {
   await db.migration.query(`INSERT INTO content_version SELECT (jsonb_populate_record(NULL::content_version,to_jsonb(c)||jsonb_build_object('content_version_id',$1::text,'source_path','fixture://raw-approved','review_status','approved','rights_status','generated','created_at','2000-01-01T00:00:00Z'))).* FROM content_version c WHERE c.kind=$2 AND exam_id='telc-deutsch-b1' LIMIT 1`,[id+'@v9998',kind]);
  }
  await db.migration.query(`INSERT INTO rubric_version SELECT (jsonb_populate_record(NULL::rubric_version,to_jsonb(r)||jsonb_build_object('rubric_id','synthetic.c03.raw-rubric','version','v9998','content_version_id','synthetic.c03.raw-rubric@v9998'))).* FROM rubric_version r WHERE exam_id='telc-deutsch-b1' LIMIT 1`);
  await db.migration.query(`INSERT INTO task_version SELECT (jsonb_populate_record(NULL::task_version,to_jsonb(t)||jsonb_build_object('task_id','synthetic.c03.raw-task','version','v9998','rubric_id','synthetic.c03.raw-rubric','rubric_version','v9998','content_version_id','synthetic.c03.raw-task@v9998'))).* FROM task_version t WHERE exam_id='telc-deutsch-b1' LIMIT 1`);
  process.env.B1PREP_CONTENT_MODE='public';
  const telc=(await port.listPreparations(a)).find(p=>p.exam_id==='telc-deutsch-b1');
  assert.equal((await port.listTasks(a)).some(t=>t.task_id==='synthetic.c03.raw-task'),false);
  assert.equal(await port.readRubric(a,{rubricId:'synthetic.c03.raw-rubric',version:'v9998'}),null);
  await reject(port.create(a,null,{taskId:'synthetic.c03.raw-task',taskVersion:'v9998',rubricId:'synthetic.c03.raw-rubric',rubricVersion:'v9998'},telc.id),'task_not_servable');
  process.env.B1PREP_CONTENT_MODE='internal-preview';
 });
 const set=pkg.sets.find(s=>s.section==='LV'),setSubject=await subject('content',set.setId+'@'+set.version),taskSubject=await subject('content',pkg.writingTasks[0].taskId+'@'+pkg.writingTasks[0].version),mediaSubject=await subject('content',pkg.media[0].mediaId+'@'+pkg.media[0].version),formSubject=await subject('form',pkg.forms[0].id,pkg.forms[0].version);
 const itemId=String(set.payload.questions[0].n),answer=Object.keys(set.payload.questions[0].options)[0];
 const objective={preparationId:prep.id,setId:set.setId,version:set.version,itemId,answer};
 await check('fresh undecided form works only in preview; public publication refuses without exact review',async()=>{assert.equal((await port.listMockForms(a,{preparationId:prep.id})).length,1);process.env.B1PREP_CONTENT_MODE='public';assert.equal((await port.listMockForms(a,{preparationId:prep.id})).length,0);await assert.rejects(importPackage(db.migration,published,{mediaRoot}),/review/i);process.env.B1PREP_CONTENT_MODE='internal-preview';});
 for(const category of['educational','audio','exam_format']){const r=await tx(db.migration,c=>recordReviewerAuthority(c,{eventId:randomUUID(),reviewerId:'synthetic.consumers.'+category,reviewerName:'Synthetic fixture reviewer; no real approval',examId:EXAM,category,language:category==='audio'?'de':'',action:'grant',expectedAuthorityId:null,evidenceRef:'fixture://synthetic-appointment',evidenceSha256:sha,rationale:'Disposable fixture only'}));authorities.set(EXAM+'|'+category,r.authorityId);}
 const targets=(await db.migration.query('SELECT content_version_id FROM content_version WHERE exam_id=$1',[EXAM])).rows;
 for(const t of targets)await decide(await subject('content',t.content_version_id));
 await decide(await subject('blueprint',EXAM,pkg.blueprint.version));await decide(formSubject);
 await check('named approvals enable publication without changing immutable source hashes and supply private proof',async()=>{const receipt=await importPackage(db.migration,published,{mediaRoot});assert.ok(receipt.reviewProof[0].subjects.length>20);assert.ok(receipt.reviewProof[0].subjects.every(s=>s.review_status==='approved'&&s.review_basis==='named_decision'&&s.decision_ids.length===1));assert.equal((await db.migration.query('SELECT review_status FROM content_version WHERE content_version_id=$1',[setSubject.subjectId])).rows[0].review_status,'unreviewed');process.env.B1PREP_CONTENT_MODE='public';assert.equal((await port.listExams(a)).some(e=>e.exam_id===EXAM),true);assert.equal((await port.listMockForms(a,{preparationId:prep.id})).length,1);await port.answerObjectiveItem(a,objective);});
 const completed=(await port.startMockRun(a,start(prep))).run,active=(await port.startMockRun(a,start(prep))).run;
 const finishBody={expectedRevision:completed.revision,eventId:randomUUID()};await port.finaliseMockRun(a,completed.id,finishBody);
 const saveBody={expectedRevision:active.revision,eventId:randomUUID(),responses:[],position:{member:0,item:0}};await port.saveMockRun(a,active.id,saveBody);
 const rec=active.members.flatMap(m=>m.recordings??[])[0],beginBody={eventId:randomUUID(),mediaId:rec.media_id,mediaVersion:rec.media_version,expectedRevision:0,action:'begin'};
 const begun=await port.mutateMockPlayback(a,active.id,beginBody);
 const graded=await queue(a,prep);assert.equal((await createWorker({pool:db.worker,examCatalogue:catalogue}).runOnce()).outcome,'succeeded');
 await check('explicit set withdrawal blocks discovery, raw marking and active finalisation while completed results remain labelled',async()=>{await decide(setSubject,'withdraw');assert.equal((await port.listMockForms(a,{preparationId:prep.id})).length,0);await reject(port.createPreparation(newcomer,EXAM),'exam_unavailable');await assert.rejects(port.answerObjectiveItem(a,objective));await reject(tx(db.learner,c=>c.query('SELECT mark_objective_item($1,$2,$3,$4::jsonb)',[set.setId,set.version,itemId,JSON.stringify(answer)]),a),'review_blocked');await reject(tx(db.learner,c=>c.query('SELECT finalise_mock_run($1,$2)',[active.id,2]),a),'mock_content_unavailable');const historic=await port.readMockRun(a,completed.id);assert.ok(historic.result);assert.equal(historic.review_withdrawn,true);assert.equal(historic.blocked_reason,null);assert.equal((await port.readMockRun(a,active.id)).blocked_reason,'review_blocked');assert.equal((await port.finaliseMockRun(a,completed.id,finishBody)).state,'finalised');assert.equal((await port.saveMockRun(a,active.id,saveBody)).blocked_reason,'review_blocked');await decide(setSubject);});
 await check('completed writing facts survive review withdrawal but new revisions and fresh submissions are refused',async()=>{await decide(taskSubject,'withdraw');const result=await port.result(a,graded.s.submissionId);assert.ok(result.assessment);assert.equal(result.review_withdrawn,true);assert.equal((await port.submit(a,graded.a.id,graded.d.revision,graded.event)).replay,true);await reject(port.create(a,graded.s.submissionId),'review_blocked');await reject(tx(db.learner,c=>c.query(`INSERT INTO attempts(id,owner_id,task_id,task_version,rubric_id,rubric_version,parent_submission_id,preparation_id,exam_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,[randomUUID(),a,...Object.values(binding()),graded.s.submissionId,prep.id,EXAM]),a),'review_blocked');const exported=await port.exportData(a);assert.ok(exported.results.find(r=>r.submission_id===graded.s.submissionId).feedback);assert.equal(exported.results.find(r=>r.submission_id===graded.s.submissionId).review_withdrawn,true);await decide(taskSubject);});
 await check('raw draft and submission mutations cannot bypass an explicit task negative; prior text is preserved',async()=>{
  const draft=await port.create(a,null,binding(),prep.id);await port.save(a,draft.id,1,'Saved before withdrawal');await decide(taskSubject,'reject');
  await reject(port.save(a,draft.id,2,'Must not replace the saved text'),'review_blocked');
  await reject(tx(db.learner,c=>c.query('UPDATE drafts SET revision=revision+1,text=$2 WHERE attempt_id=$1',[draft.id,'Must not replace the saved text']),a),'review_blocked');
  await reject(tx(db.learner,c=>c.query('INSERT INTO submissions(id,attempt_id,owner_id,event_id,draft_revision,text,task_version,rubric_version,explanation_language) VALUES($1,$2,$3,$4,2,$5,$6,$7,$8)',[randomUUID(),draft.id,a,randomUUID(),'Must not create a submission',draft.task_version,draft.rubric_version,'de']),a),'review_blocked');
  assert.deepEqual((await db.admin.query('SELECT revision,text FROM drafts WHERE attempt_id=$1',[draft.id])).rows[0],{revision:2,text:'Saved before withdrawal'});
  // O01's schema-owning migration role needs parent reads for its private definer functions.
  // Runtime learner/deletion roles still reveal no identities without their bound owner.
  const authority=(await db.migration.query("SELECT current_user AS caller,pg_get_userbyid(proowner) AS function_owner FROM pg_proc WHERE oid='begin_provider_attempt(uuid,uuid,jsonb)'::regprocedure")).rows[0];
  assert.deepEqual(authority,{caller:db.roles.migration,function_owner:db.roles.migration});
  const parentCount=(await db.admin.query('SELECT count(*)::int n FROM attempts')).rows[0].n;
  assert.ok(parentCount>0,'the denial control has real parent rows');
  assert.equal((await db.migration.query('SELECT count(*)::int n FROM attempts')).rows[0].n,parentCount,'the reviewed function owner can read its parents');
  for(const role of ['learner','deletion'])assert.equal((await db[role].query('SELECT count(*)::int n FROM attempts')).rows[0].n,0,role+' cannot read identities without a bound owner');
  await decide(taskSubject);
 });
 await check('media withdrawal stops active bytes and raw playback updates; exact receipt does not debit again',async()=>{await decide(mediaSubject,'withdraw');await reject(port.readMockMedia(a,active.id,rec.media_id,rec.media_version),'mock_content_unavailable');await reject(tx(db.learner,c=>c.query("UPDATE listening_playback SET revision=revision+1,state='paused',position_ms=0 WHERE run_id=$1",[active.id]),a),'mock_content_unavailable');const receipt=await port.mutateMockPlayback(a,active.id,beginBody);assert.equal(receipt.plays_used,1);assert.equal(receipt.playback_id,begun.playback_id);assert.equal((await db.admin.query('SELECT count(*)::int n FROM listening_playback_event WHERE run_id=$1',[active.id])).rows[0].n,1);await decide(mediaSubject);});
 await check('format withdrawal closes active pinned use even with every content member approved',async()=>{await decide(formSubject,'withdraw');await reject(tx(db.learner,c=>c.query('UPDATE mock_run SET revision=revision+1,updated_at=clock_timestamp() WHERE id=$1',[active.id]),a),'mock_content_unavailable');assert.equal((await port.readMockRun(a,completed.id)).review_withdrawn,true);assert.ok((await port.readMockRun(a,completed.id)).result);await decide(formSubject);});
 await check('worker sees withdrawal during grading, preserves text, releases reservation and never writes an assessment',async()=>{const q=await queue(a,prep);const result=await createWorker({pool:db.worker,examCatalogue:catalogue,grade:async input=>{await decide(taskSubject,'withdraw');return stubGrade(input);}}).runOnce();assert.equal(result.code,'content_unavailable');assert.equal((await db.admin.query('SELECT count(*)::int n FROM assessments WHERE submission_id=$1',[q.s.submissionId])).rows[0].n,0);assert.equal((await db.admin.query('SELECT reserved FROM entitlements WHERE owner_id=$1 AND exam_id=$2',[a,EXAM])).rows[0].reserved,0);assert.equal((await db.admin.query('SELECT text FROM submissions WHERE id=$1',[q.s.submissionId])).rows[0].text,q.d.text);await decide(taskSubject);});

 await check('review-refusal refund takes owner and exam before job tuples, without a learner-balance cycle',async()=>{
  const q=await queue(a,prep);await decide(taskSubject,'withdraw');const raw=await extraPool.connect(),op=observed(db.worker,null);let work;
  try{await raw.query('BEGIN');await raw.query("SELECT set_config('hatoove.owner_id',$1,true)",[a]);await raw.query('SELECT pg_advisory_xact_lock(hashtextextended($1,7352))',[a]);await raw.query('SELECT pg_advisory_xact_lock(hashtextextended($1,7351))',[EXAM]);await raw.query('SELECT * FROM entitlements WHERE owner_id=$1 AND exam_id=$2 FOR UPDATE',[a,EXAM]);work=createWorker({pool:op.pool,examCatalogue:catalogue}).runOnce();work.catch(()=>{});await op.connected;await waits(op.pid,raw.processID);assert.equal((await raw.query('SELECT * FROM jobs WHERE submission_id=$1 FOR UPDATE NOWAIT',[q.s.submissionId])).rowCount,1);await raw.query('COMMIT');assert.equal((await bounded(work,'review refusal refund')).code,'content_unavailable');}
  finally{await raw.query('ROLLBACK');await Promise.allSettled([work].filter(Boolean));raw.release();}await decide(taskSubject);
 });
 // Real connection orders. The blocker is the actual review writer, not an emulated status.
 for(const first of['review','admission'])await check(first+' first serializes new admission against withdrawal',async()=>{
  const op=observed(extraPool,sql=>String(sql).includes('INSERT INTO mock_run'),{before:true}),api=createPostgresDatastore({pool:op.pool,examCatalogue:catalogue,mediaRoot}),reviewer=await db.migration.connect();let work,withdrawal;
  try{await reviewer.query('BEGIN');if(first==='review'){await decide(formSubject,'withdraw',reviewer);work=api.startMockRun(a,start(prep));work.catch(()=>{});await op.connected;await waits(op.pid,reviewer.processID);await reviewer.query('COMMIT');await assert.rejects(work);}
   else{work=api.startMockRun(a,start(prep));work.catch(()=>{});await bounded(op.hit,'admission after review read');withdrawal=decide(formSubject,'withdraw',reviewer);withdrawal.catch(()=>{});await waits(reviewer.processID,op.pid);op.resume();assert.equal((await bounded(work,'admission commit')).created,true);await withdrawal;await reviewer.query('COMMIT');}
  }finally{op.resume();await Promise.allSettled([work,withdrawal].filter(Boolean));await reviewer.query('ROLLBACK');reviewer.release();}await decide(formSubject);
 });
 for(const first of['review','publication'])await check(first+' first serializes public publication against withdrawal',async()=>{
  const op=observed(db.migration,sql=>String(sql).includes('SELECT form_review_allowed')),reviewer=await db.migration.connect();let work,withdrawal;
  try{await reviewer.query('BEGIN');if(first==='review'){await decide(formSubject,'withdraw',reviewer);work=importPackage(op.pool,published,{mediaRoot});work.catch(()=>{});await op.connected;await waits(op.pid,reviewer.processID);await reviewer.query('COMMIT');op.resume();await assert.rejects(work,/review/);}
   else{work=importPackage(op.pool,published,{mediaRoot});work.catch(()=>{});await bounded(op.hit,'publication after review read');withdrawal=decide(formSubject,'withdraw',reviewer);withdrawal.catch(()=>{});await waits(reviewer.processID,op.pid);op.resume();assert.ok((await bounded(work,'publication commit')).reviewProof.length);await withdrawal;await reviewer.query('COMMIT');}
  }finally{op.resume();await Promise.allSettled([work,withdrawal].filter(Boolean));await reviewer.query('ROLLBACK');reviewer.release();}await decide(formSubject);
 });
 for(const first of['review','worker'])await check(first+' first serializes successful assessment commit against withdrawal',async()=>{
  const q=await queue(a,prep),op=observed(db.worker,sql=>String(sql).includes(first==='review'?'SELECT pg_advisory_xact_lock(hashtextextended($1,7351))':'INSERT INTO assessments'),{before:true}),reviewer=await db.migration.connect();let work,withdrawal;
  try{await reviewer.query('BEGIN');work=createWorker({pool:op.pool,examCatalogue:catalogue}).runOnce();work.catch(()=>{});await bounded(op.hit,'worker commit boundary');
   if(first==='review'){await decide(taskSubject,'withdraw',reviewer);op.resume();await waits(op.pid,reviewer.processID);await reviewer.query('COMMIT');assert.equal((await bounded(work,'worker refuses')).code,'content_unavailable');}
   else{withdrawal=decide(taskSubject,'withdraw',reviewer);withdrawal.catch(()=>{});await waits(reviewer.processID,op.pid);op.resume();assert.equal((await bounded(work,'worker commits')).outcome,'succeeded');await withdrawal;await reviewer.query('COMMIT');assert.ok((await port.result(a,q.s.submissionId)).assessment);assert.equal((await port.result(a,q.s.submissionId)).review_withdrawn,true);}
  }finally{op.resume();await Promise.allSettled([work,withdrawal].filter(Boolean));await reviewer.query('ROLLBACK');reviewer.release();}await decide(taskSubject);
 });
 await check('raw same-owner multi-row updates serialize before tuples against the function path',async()=>{
  const raw=await extraPool.connect(),op=observed(db.learner,sql=>String(sql).includes('SELECT finalise_mock_run'));
  let pending;try{await raw.query('BEGIN');await raw.query("SELECT set_config('hatoove.owner_id',$1,true)",[a]);await raw.query('UPDATE mock_run SET revision=revision+1,updated_at=clock_timestamp() WHERE owner_id=$1 AND state=\'active\'',[a]);const api=createPostgresDatastore({pool:op.pool,examCatalogue:catalogue,mediaRoot});pending=api.finaliseMockRun(a,active.id,{expectedRevision:999,eventId:randomUUID()});pending.catch(()=>{});await op.connected;await waits(op.pid,raw.processID);await raw.query('COMMIT');op.resume();await reject(pending,'mock_conflict');}finally{op.resume();await Promise.allSettled([pending].filter(Boolean));await raw.query('ROLLBACK');raw.release();}
 });
 await check('function-first finalisation makes raw same-owner multi-row UPDATE wait before tuples',async()=>{
  const run=(await port.startMockRun(a,start(prep))).run,op=observed(db.learner,sql=>String(sql).includes('SELECT finalise_mock_run'),{before:true}),api=createPostgresDatastore({pool:op.pool,examCatalogue:catalogue,mediaRoot}),raw=await extraPool.connect();let work,update;
  try{work=api.finaliseMockRun(a,run.id,{expectedRevision:run.revision,eventId:randomUUID()});work.catch(()=>{});await bounded(op.hit,'function holds owner and exam');await raw.query('BEGIN');await raw.query("SELECT set_config('hatoove.owner_id',$1,true)",[a]);update=raw.query("UPDATE mock_run SET revision=revision+1,updated_at=clock_timestamp() WHERE owner_id=$1 AND state='active'",[a]);update.catch(()=>{});await waits(raw.processID,op.pid);op.resume();assert.equal((await bounded(work,'function finalises')).state,'finalised');assert.ok((await bounded(update,'raw UPDATE continues')).rowCount>0);await raw.query('COMMIT');assert.equal((await port.readMockRun(a,run.id)).state,'finalised');}
  finally{op.resume();await Promise.allSettled([work,update].filter(Boolean));await raw.query('ROLLBACK');raw.release();}
 });
 for(const first of['review','raw'])await check(first+' first serializes raw multi-row UPDATE against review withdrawal without a cycle',async()=>{
  const raw=await extraPool.connect(),reviewer=await db.migration.connect();let update,withdrawal;
  try{await raw.query('BEGIN');await raw.query("SET LOCAL lock_timeout='6s'; SET LOCAL statement_timeout='8s'");await raw.query("SELECT set_config('hatoove.owner_id',$1,true)",[a]);await reviewer.query('BEGIN');
   if(first==='review'){await decide(formSubject,'withdraw',reviewer);update=raw.query("UPDATE mock_run SET revision=revision+1,updated_at=clock_timestamp() WHERE owner_id=$1 AND state='active'",[a]);update.catch(()=>{});await waits(raw.processID,reviewer.processID);await reviewer.query('COMMIT');await reject(update,'mock_content_unavailable');await raw.query('ROLLBACK');}
   else{assert.ok((await raw.query("UPDATE mock_run SET revision=revision+1,updated_at=clock_timestamp() WHERE owner_id=$1 AND state='active'",[a])).rowCount>1);withdrawal=decide(formSubject,'withdraw',reviewer);withdrawal.catch(()=>{});await waits(reviewer.processID,raw.processID);await raw.query('COMMIT');await bounded(withdrawal,'review resumes after raw commit');await reviewer.query('COMMIT');}
  }finally{await Promise.allSettled([update,withdrawal].filter(Boolean));await raw.query('ROLLBACK');await reviewer.query('ROLLBACK');raw.release();reviewer.release();}await decide(formSubject);
 });
 await check('independent rights loss still withholds completed facts; saved responses and export remain available',async()=>{await db.migration.query("INSERT INTO content_rights(content_version_id,basis,decided_by,note) VALUES($1,'unknown','Synthetic rights fixture','No real rights change')",[setSubject.subjectId]);const r=await port.readMockRun(a,completed.id);assert.equal(r.blocked_reason,'rights_blocked');assert.equal(r.result,null);const out=await port.exportData(a);assert.equal(out.mock_runs.find(r=>r.id===completed.id).result,null);assert.ok(out.results.find(r=>r.submission_id===graded.s.submissionId).feedback);assert.equal(JSON.stringify(out).includes('fixture://synthetic'),false);assert.equal(JSON.stringify(await port.result(a,graded.s.submissionId)).includes('decision_ids'),false);});
 await check('runtime projections disclose no private evidence and payments gain no content/view access',async()=>{for(const role of['learner','worker','payments'])for(const table of['content_review_authority','content_review_decision','content_review_baseline'])await reject(db[role].query('SELECT * FROM '+table),'42501');await reject(db.payments.query('SELECT * FROM reviewed_content_version'),'42501');for(const role of['learner','worker'])await reject(db[role].query('SELECT form_review_allowed($1,$2,$3,true)',[EXAM,pkg.forms[0].id,pkg.forms[0].version]),'42501');assert.equal((await db.learner.query("SELECT has_table_privilege(current_user,'reviewed_content_version','UPDATE') AS allowed")).rows[0].allowed,false);});
 await check('account deletion remains available after review and rights withdrawal',async()=>{const result=await world.deletion.deleteAccount(a);assert.equal(result.verifiedAbsent,true);assert.equal((await db.admin.query('SELECT count(*)::int n FROM mock_run WHERE owner_id=$1',[a])).rows[0].n,0);});
}finally{
 const failures=[];
 for(const cleanup of [()=>extraPool?.end(),()=>db?.cleanup(),async()=>{
  if(!mediaRoot)return;
  if(path.dirname(path.resolve(mediaRoot))!==path.resolve(tmpdir())||!path.basename(mediaRoot).startsWith('hatoove-c03-consumers-'))throw Error('Unsafe synthetic media cleanup path');
  await rm(mediaRoot,{recursive:true,force:true});
 }]){try{await cleanup();}catch(error){failures.push(error);}}
 for(const k of keys){if(saved[k]===undefined)delete process.env[k];else process.env[k]=saved[k];}
 if(failures.length)throw new AggregateError(failures,'Content review fixture cleanup failed');
}
console.log(`Content review consumers PostgreSQL: ${passed} checks passed; unique schema cleaned.`);

#!/usr/bin/env node
/** Real restricted SQL, synthetic records, unique disposable schema; no service/provider calls. */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createFixture,rolePool} from '../server/owned-postgres/bootstrap.mjs';
import {importHistoricalDefaultPackage,assertHistoricalProjectionAbsent} from './historical-content-fixture.mjs';
import {createPostgresWorld} from '../server/owned-postgres/fixture.mjs';
import {createPostgresDatastore} from '../server/owned-postgres/adapter.mjs';
import {importPackage} from '../server/owned-postgres/package-importer.mjs';
import {createExamCatalogue} from '../server/preparation-contract.mjs';
import {createCompleteFixture} from './exam-s5b-fixture.mjs';
import {mockMemberItems} from '../server/mock-contract.mjs';
import {readReleasedForm} from '../server/owned-postgres/packages.mjs';
if(process.env.OWNAPI_PG_ALLOW!=='1'||!process.env.OWNAPI_PG_PORT||[4300,55440].includes(Number(process.env.OWNAPI_PG_PORT)))throw Error('Explicit disposable OWNAPI_PG_ALLOW/PORT required');
const savedEnv=Object.fromEntries(['B1PREP_CONTENT_MODE','B1PREP_SERVE_REVIEW','B1PREP_SERVE_RIGHTS'].map(key=>[key,process.env[key]]));
const TELC='telc-deutsch-b1',DTZ='dtz-a2-b1',catalogue=createExamCatalogue({enabled:[TELC,DTZ]});
let mediaRoot,db,world,port,peerPool,peer,failure;
let passed=0;const check=async(name,fn)=>{await fn();passed++;console.log('PASS '+name);};
const reject=(promise,code)=>assert.rejects(promise,e=>e.code===code);
async function sqlAs(owner,fn){const c=await db.learner.connect();try{await c.query('BEGIN');await c.query("SELECT set_config('hatoove.owner_id',$1,true)",[owner]);const r=await fn(c);await c.query('COMMIT');return r;}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}}
async function owner(tag){const outcome=await world.sessions.signUp({name:'Synthetic S5B '+tag,email:`s5b-${tag}-${randomUUID()}@example.invalid`,password:'synthetic-s5b-password'});const cookie=String(outcome.setCookie).split(';')[0],id=(await world.sessions.getSession({cookie})).userId;return {id,telc:(await port.listPreparations(id))[0]};}
const body=(o,exam=TELC,eventId=randomUUID())=>({preparationId:exam===TELC?o.telc.id:o.dtz.id,formId:`s5b.${exam}.complete`,formVersion:'v9100',releaseVersion:'v9100',eventId});
const start=async(o,exam=TELC)=>(await port.startMockRun(o.id,body(o,exam))).run;
const save=(o,r,responses,position={member:0,item:0})=>port.saveMockRun(o.id,r.id,{expectedRevision:r.revision,eventId:randomUUID(),responses,position});
const finish=(o,r)=>port.finaliseMockRun(o.id,r.id,{expectedRevision:r.revision,eventId:randomUUID(),...(r.writing?{expectedWritingRevision:r.writing.draft_revision,explanationLanguage:'de'}:{})});
const response=m=>({setId:m.set_id,version:m.version,itemId:mockMemberItems(m)[0].id,answer:mockMemberItems(m)[0].options[0]});
const rec=r=>r.members.flatMap(m=>m.recordings??[])[0];
const begin=(o,r)=>port.mutateMockPlayback(o.id,r.id,{eventId:randomUUID(),mediaId:rec(r).media_id,mediaVersion:rec(r).media_version,expectedRevision:0,action:'begin'});
// Only this explicit disposable admin seam simulates elapsed time. Target durations remain exact.
async function shiftTo(o,r,ordinal,elapsedMs=1000){const c=await db.admin.connect();try{await c.query('BEGIN');
 const g=(await c.query('SELECT starts_at FROM mock_run_time_group WHERE run_id=$1 AND ordinal=$2',[r.id,ordinal])).rows[0];
 const delta=Date.now()-elapsedMs-new Date(g.starts_at).getTime();
 await c.query('ALTER TABLE mock_run DISABLE TRIGGER USER');await c.query('ALTER TABLE mock_run_time_group DISABLE TRIGGER USER');
 await c.query("UPDATE mock_run SET created_at=created_at+$2*interval '1 millisecond',deadline_at=deadline_at+$2*interval '1 millisecond' WHERE id=$1",[r.id,delta]);
 await c.query("UPDATE mock_run_time_group SET starts_at=starts_at+$2*interval '1 millisecond',deadline_at=deadline_at+$2*interval '1 millisecond' WHERE run_id=$1",[r.id,delta]);
 await c.query('ALTER TABLE mock_run ENABLE TRIGGER USER');await c.query('ALTER TABLE mock_run_time_group ENABLE TRIGGER USER');await c.query('COMMIT');
 }catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}return port.readMockRun(o.id,r.id);}
async function rawRun(o,exam=TELC){return sqlAs(o.id,async c=>(await c.query(`INSERT INTO mock_run
 (id,owner_id,preparation_id,exam_id,release_version,blueprint_version,form_id,form_version,start_event_id,title,scope,mode)
 SELECT $1,$2,$3,f.exam_id,'v9100',f.blueprint_version,f.form_id,f.version,$4,f.payload->>'title',f.payload->>'scope',f.payload->>'mode'
 FROM exam_form f WHERE f.exam_id=$5 AND f.form_id=$6 AND f.version='v9100' RETURNING *`,
 [randomUUID(),o.id,exam===TELC?o.telc.id:o.dtz.id,randomUUID(),exam,`s5b.${exam}.complete`])).rows[0]);}
try{
 process.env.B1PREP_CONTENT_MODE='internal-preview';delete process.env.B1PREP_SERVE_REVIEW;delete process.env.B1PREP_SERVE_RIGHTS;
 mediaRoot=await mkdtemp(path.join(tmpdir(),'hatoove-s5b-backend-'));
 db=await createFixture({stopBefore:'0031-'});
 world=await createPostgresWorld({fixture:db,examCatalogue:catalogue});
 port=createPostgresDatastore({pool:db.learner,examCatalogue:catalogue,mediaRoot});
 peerPool=rolePool(db.config,db.schema,db.roles.learner,1);
 peer=createPostgresDatastore({pool:peerPool,examCatalogue:catalogue,mediaRoot});
 await importHistoricalDefaultPackage(db);const a=await owner('a'),b=await owner('b');
 await check('forward migration preserves legacy run, objective answers, task and content bytes',async()=>{
  const old=await sqlAs(a.id,async c=>(await c.query(`INSERT INTO mock_run
   (id,owner_id,preparation_id,exam_id,release_version,blueprint_version,form_id,form_version,start_event_id,title,scope,mode)
   SELECT $1,$2,$3,f.exam_id,h.release_version,f.blueprint_version,f.form_id,f.version,$4,f.payload->>'title',f.payload->>'scope',f.payload->>'mode'
   FROM exam_form f JOIN exam_release_head h ON h.exam_id=f.exam_id WHERE f.exam_id=$5 ORDER BY f.form_id LIMIT 1 RETURNING *`,[randomUUID(),a.id,a.telc.id,randomUUID(),TELC])).rows[0]);
  await sqlAs(a.id,c=>c.query(`UPDATE mock_run SET responses='[{"setId":"telc-deutsch-b1.lv1.01","version":"v1","itemId":"1","answer":null}]',revision=revision+1 WHERE id=$1`,[old.id]));
  const before=(await db.admin.query('SELECT * FROM mock_run WHERE id=$1',[old.id])).rows[0],content=(await db.admin.query('SELECT * FROM exam_release ORDER BY exam_id,version')).rows;
  await assertHistoricalProjectionAbsent(db);
  assert.deepEqual(await db.applyRemaining(),['0031-assigned-mock-writing.sql','0032-ordered-mock-time-groups.sql','0033-content-rights-fence.sql','0034-complete-dtz-admission.sql','0035-content-review.sql','0036-content-review-consumers.sql','0037-saved-explanations.sql','0038-provider-attempts.sql']);
  assert.deepEqual((await db.admin.query('SELECT * FROM mock_run WHERE id=$1',[old.id])).rows[0],before);
  assert.deepEqual((await db.admin.query('SELECT * FROM exam_release ORDER BY exam_id,version')).rows,content);
  const read=await port.readMockRun(a.id,old.id);assert.equal(read.timing,null);assert.equal(read.writing_task,null);
  assert.equal((await finish(a,read)).result.total,20);
 });
 const telc=await createCompleteFixture({examId:TELC,mediaRoot}),dtz=await createCompleteFixture({examId:DTZ,mediaRoot});
 await importPackage(db.migration,telc,{mediaRoot});await importPackage(db.migration,dtz,{mediaRoot});
 a.dtz=(await port.createPreparation(a.id,DTZ)).preparation;b.dtz=(await port.createPreparation(b.id,DTZ)).preparation;
 await check('worker can validate pinned complete content with no answer-key or new content mutation privileges',async()=>{
  const bundle=await readReleasedForm(db.worker,{examId:TELC,formId:telc.forms[0].id,formVersion:'v9100',releaseVersion:'v9100'});
  assert.equal(bundle.blockedReason,null);assert.equal(bundle.members.length,8);assert.ok(bundle.media.length);
  await assert.rejects(db.worker.query('SELECT * FROM objective_key LIMIT 1'),e=>e.code==='42501');
  for(const table of ['exam_blueprint','exam_form_member','objective_set','exam_media'])
   assert.equal((await db.admin.query('SELECT has_table_privilege($1,$2,\'INSERT,UPDATE,DELETE\') AS allowed',[db.roles.worker,table])).rows[0].allowed,false);
 });
 let run;
 await check('concurrent identical start receipts produce exactly one assigned attempt and empty draft',async()=>{
  const connections=await Promise.all([db.learner.query('SELECT pg_backend_pid() AS pid'),peerPool.query('SELECT pg_backend_pid() AS pid')]);
  assert.notEqual(connections[0].rows[0].pid,connections[1].rows[0].pid);
  const request=body(a),results=await Promise.all([port.startMockRun(a.id,request),peer.startMockRun(a.id,request)]);
  assert.equal(results.filter(r=>r.created).length,1);assert.equal(results[0].run.id,results[1].run.id);run=results[0].run;
  assert.equal(run.writing.binding_kind,'assigned');assert.equal(run.writing.choice_group_id,null);assert.equal(run.writing.selected_option_id,null);
  assert.equal(run.writing_task.task.task_id,telc.writingTasks[0].taskId);assert.deepEqual(run.writing_choices,[]);
  assert.equal((await port.startMockRun(a.id,request)).run.writing.attempt_id,run.writing.attempt_id);
  assert.equal((await db.admin.query('SELECT count(*)::int n FROM mock_writing WHERE run_id=$1',[run.id])).rows[0].n,1);
  const draft=await port.read(a.id,run.writing.attempt_id);assert.equal(draft.text,'');assert.equal(draft.revision,1);
  await reject(port.selectMockWriting(a.id,run.id,{expectedRevision:1,eventId:randomUUID(),choiceGroupId:'fake',optionId:'A'}),'writing_choice_immutable');
 });
 await check('attachment failure rolls back run draft and receipt so a clean start retry succeeds',async()=>{
  const request=body(b),before=(await db.admin.query('SELECT (SELECT count(*) FROM mock_run WHERE owner_id=$1) runs,(SELECT count(*) FROM attempts WHERE owner_id=$1) attempts',[b.id])).rows[0];
  const broken=createPostgresDatastore({examCatalogue:catalogue,mediaRoot,pool:{connect:async()=>{const c=await db.learner.connect();return {
   query:(sql,args)=>sql.includes('INSERT INTO mock_writing')?Promise.reject(Error('synthetic_attachment_failure')):c.query(sql,args),release:()=>c.release()};}}});
  await assert.rejects(broken.startMockRun(b.id,request),/synthetic_attachment_failure/);
  assert.deepEqual((await db.admin.query('SELECT (SELECT count(*) FROM mock_run WHERE owner_id=$1) runs,(SELECT count(*) FROM attempts WHERE owner_id=$1) attempts',[b.id])).rows[0],before);
  assert.equal((await db.admin.query('SELECT 1 FROM mock_run_event WHERE owner_id=$1 AND event_id=$2',[b.id,request.eventId])).rowCount,0);
  assert.equal((await port.startMockRun(b.id,request)).created,true);
 });
 await check('schedule is exact cumulative pinned time and stable across repeated reads and devices',async()=>{
  assert.deepEqual(run.timing.groups.map(g=>g.sections),[['LV','SB'],['HV'],['writing']]);
  assert.deepEqual(run.timing.groups.map(g=>(new Date(g.deadline_at)-new Date(g.starts_at))/1000),[5400,1800,1800]);
  assert.equal(run.timing.groups[0].starts_at,run.created_at);assert.equal(run.timing.groups.at(-1).deadline_at,run.deadline_at);
  assert.deepEqual((await port.readMockRun(a.id,run.id)).timing,run.timing);assert.equal(run.timing.active_group_id,'lv-sb-90');
  assert.equal(run.members.reduce((n,m)=>n+m.item_count,0),60);assert.ok(run.members.every(m=>m.section));
 });
 await check('future objective answers, draft edits, bytes, playback and SQL bypasses are refused',async()=>{
  const hv=run.members.find(m=>m.section==='HV');await reject(save(a,run,[response(hv)]),'mock_group_inactive');
  await reject(port.save(a.id,run.writing.attempt_id,1,'Too early'),'mock_group_inactive');
  await reject(port.readMockMedia(a.id,run.id,rec(run).media_id,rec(run).media_version),'mock_group_inactive');await reject(begin(a,run),'mock_group_inactive');
  await assert.rejects(sqlAs(a.id,c=>c.query('UPDATE mock_run SET responses=$2::jsonb,revision=revision+1 WHERE id=$1',[run.id,JSON.stringify([response(hv)])])),/mock_group_inactive/);
  await assert.rejects(sqlAs(a.id,c=>c.query("UPDATE drafts SET text='Bypass',revision=revision+1 WHERE attempt_id=$1",[run.writing.attempt_id])),/mock_group_inactive/);
  await assert.rejects(sqlAs(a.id,c=>c.query(`INSERT INTO listening_playback(owner_id,run_id,exam_id,media_id,media_version,max_plays,duration_ms,state,plays_used,position_ms,playback_id)
   VALUES($1,$2,$3,$4,$5,$6,$7,'playing',1,0,$8)`,[a.id,run.id,TELC,rec(run).media_id,rec(run).media_version,rec(run).max_plays,rec(run).duration_ms,randomUUID()])),/mock_group_inactive/);
  assert.equal((await db.admin.query('SELECT 1 FROM listening_playback WHERE run_id=$1',[run.id])).rowCount,0);
 });
 await check('restricted role cannot alter create or delete schedule rows; other owners cannot read',async()=>{
  assert.equal((await sqlAs(b.id,c=>c.query('SELECT * FROM mock_run_time_group WHERE run_id=$1',[run.id]))).rowCount,0);
  for(const sql of ['UPDATE mock_run_time_group SET deadline_at=deadline_at+interval \'1 day\' WHERE run_id=$1','DELETE FROM mock_run_time_group WHERE run_id=$1','INSERT INTO mock_run_time_group SELECT * FROM mock_run_time_group WHERE run_id=$1'])
   await assert.rejects(sqlAs(a.id,c=>c.query(sql,[run.id])),e=>e.code==='42501');
  await assert.rejects(db.admin.query("UPDATE mock_run_time_group SET deadline_at=deadline_at+interval '1 second' WHERE run_id=$1",[run.id]),/mock_timing_immutable/);
 });
 await check('schedule SQL independently rejects timestamps that differ from the pinned blueprint',async()=>{
  const c=await db.admin.connect();try{await c.query('BEGIN');await c.query("SELECT set_config('hatoove.owner_id',$1,true)",[a.id]);
   await assert.rejects(c.query(`INSERT INTO mock_run_time_group(owner_id,run_id,ordinal,group_id,sections,starts_at,deadline_at)
    SELECT owner_id,run_id,ordinal,group_id,sections,starts_at,deadline_at+interval '1 second' FROM mock_run_time_group WHERE run_id=$1 AND ordinal=0`,[run.id]),/invalid_mock_timing/);
  }finally{await c.query('ROLLBACK');c.release();}
 });
 await check('closed responses cannot change or disappear; cursor and current group remain writable',async()=>{
  run=await save(a,run,[response(run.members[0])]);run=await shiftTo(a,run,1);const prior=run.responses;
  await reject(save(a,run,[]),'mock_group_inactive');await reject(save(a,run,[{...prior[0],answer:null}]),'mock_group_inactive');
  await assert.rejects(sqlAs(a.id,c=>c.query("UPDATE mock_run SET responses='[]',revision=revision+1 WHERE id=$1",[run.id])),/mock_group_inactive/);
  run=await save(a,run,[...prior,response(run.members.find(m=>m.section==='HV'))],{member:1,item:0});
  assert.equal(run.responses.length,2);assert.equal(run.timing.active_group_id,'hv-30');
 });
 await check('listening close refuses recovery and new bytes without restoring allowance',async()=>{
  const state=await begin(a,run);assert.equal(state.plays_used,1);await port.readMockMedia(a.id,run.id,rec(run).media_id,rec(run).media_version);
  run=await shiftTo(a,run,2);
  await reject(port.mutateMockPlayback(a.id,run.id,{eventId:randomUUID(),mediaId:rec(run).media_id,mediaVersion:rec(run).media_version,expectedRevision:state.revision,playbackId:state.playback_id,action:'recover'}),'mock_group_inactive');
  await reject(port.readMockMedia(a.id,run.id,rec(run).media_id,rec(run).media_version),'mock_group_inactive');
  assert.equal((await port.readMockPlayback(a.id,run.id))[0].plays_used,1);
 });
 await check('writing window saves exact text and finalises 60 objectives independently of exhausted feedback',async()=>{
  const text='Synthetic assigned letter.\nKeep exact whitespace.  ';
  const draft=await port.save(a.id,run.writing.attempt_id,1,text);assert.equal(draft.revision,2);
  await db.admin.query('UPDATE entitlements SET allowance=used+reserved WHERE owner_id=$1 AND exam_id=$2',[a.id,TELC]);
  run=await port.readMockRun(a.id,run.id);run=await finish(a,run);assert.equal(run.result.total,60);assert.equal(run.result.items.length,60);
  assert.equal(run.writing.failure_code,'allowance_exhausted');assert.equal((await port.result(a.id,run.writing.submission_id)).submission.text,text);
  await reject(port.save(a.id,run.writing.attempt_id,2,'Late'),'mock_finalised');
 });
 await check('explicit early finish preserves an empty assigned submission and full objective count',async()=>{
  const done=await finish(b,await start(b));assert.equal(done.result.total,60);assert.equal(done.writing.failure_code,'empty_submission');
  assert.equal((await port.result(b.id,done.writing.submission_id)).submission.text,'');
 });
 await check('stale writing revision rolls back objective finalisation and whole expiry permits finalise only',async()=>{
  let r=await start(b);await reject(port.finaliseMockRun(b.id,r.id,{expectedRevision:1,expectedWritingRevision:2,explanationLanguage:'de',eventId:randomUUID()}),'draft_conflict');
  assert.equal((await port.readMockRun(b.id,r.id)).state,'active');r=await shiftTo(b,r,2,1801000);assert.equal(r.expired,true);
  await reject(port.save(b.id,r.writing.attempt_id,1,'Late'),'mock_expired');await reject(begin(b,r),'mock_expired');
  const done=await finish(b,r);assert.equal(done.result.total,60);assert.equal(done.writing.failure_code,'empty_submission');
 });
 await check('DTZ choice remains unselected until SA group and full finalisation contains45 items',async()=>{
  let r=await start(a,DTZ);assert.equal(r.writing,null);assert.equal(r.writing_task,null);assert.equal(r.timing.active_group_id,'dtz-hv-25');
  const choice=()=>port.selectMockWriting(a.id,r.id,{expectedRevision:r.revision,eventId:randomUUID(),choiceGroupId:r.writing_choices[0].id,optionId:'B'});
  await reject(choice(),'mock_group_inactive');
  await assert.rejects(sqlAs(a.id,async c=>{const id=randomUUID(),t=r.writing_choices[0].options[0].task;
   await c.query('INSERT INTO attempts(id,owner_id,task_id,task_version,rubric_id,rubric_version,preparation_id,exam_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[id,a.id,t.task_id,t.version,t.rubric_id,t.rubric_version,a.dtz.id,DTZ]);
   await c.query("INSERT INTO drafts(attempt_id,revision,text) VALUES($1,1,'')",[id]);
   await c.query('INSERT INTO mock_writing(run_id,owner_id,attempt_id,choice_group_id,selected_option_id) VALUES($1,$2,$3,$4,$5)',[r.id,a.id,id,r.writing_choices[0].id,r.writing_choices[0].options[0].id]);
  }),/mock_group_inactive/);
  r=await shiftTo(a,r,2);r=await choice();assert.equal(r.writing.binding_kind,'choice');
  const d=await port.save(a.id,r.writing.attempt_id,1,'Synthetic DTZ text');assert.equal(d.revision,2);
  r=await port.readMockRun(a.id,r.id);r=await finish(a,r);assert.equal(r.result.total,45);assert.equal(r.result.items.length,45);
 });
 await check('SQL rejects wrong task version exam rubric and prefilled assigned attachment',async()=>{
  for(const kind of ['task','version','exam','rubric','prefilled']){
   const r=await rawRun(b);await assert.rejects(sqlAs(b.id,async c=>{
    const id=randomUUID();await c.query(`INSERT INTO attempts(id,owner_id,task_id,task_version,rubric_id,rubric_version,preparation_id,exam_id)
      SELECT $1,$2,t.task_id,CASE WHEN $3='version' THEN 'v9999' ELSE t.version END,
       CASE WHEN $3='rubric' THEN 'wrong.rubric' ELSE t.rubric_id END,t.rubric_version,$4,CASE WHEN $3='exam' THEN 'dtz-a2-b1' ELSE t.exam_id END
      FROM task_version t WHERE t.task_id=$5 AND t.version=$6`,[id,b.id,kind,b.telc.id,kind==='task'?'writing.du.besuch-einer-freundin':telc.writingTasks[0].taskId,kind==='task'?'v1':'v9100']);
    await c.query('INSERT INTO drafts(attempt_id,revision,text) VALUES($1,1,$2)',[id,kind==='prefilled'?'Outside writing window':'']);
    await c.query("INSERT INTO mock_writing(run_id,owner_id,attempt_id,binding_kind) VALUES($1,$2,$3,'assigned')",[r.id,b.id,id]);
   }),e=>['23503','23514'].includes(e.code));
  }
 });
 await check('export includes immutable schedules and binding kinds; deletion removes every owned row',async()=>{
  const exported=await port.exportData(a.id);assert.ok(exported.mock_run_time_groups.length>=6);assert.ok(exported.mock_writing.some(w=>w.binding_kind==='assigned'));
  assert.ok(exported.mock_writing.some(w=>w.binding_kind==='choice'));assert.ok(exported.listening_playback.some(p=>p.plays_used===1));
  assert.equal((await world.deletion.deleteAccount(a.id)).verifiedAbsent,true);
  for(const table of ['mock_run_time_group','mock_writing','mock_run','listening_playback'])assert.equal((await db.admin.query(`SELECT 1 FROM ${table} WHERE owner_id=$1`,[a.id])).rowCount,0);
  await reject(port.readMockRun(a.id,run.id),'not_found');
 });
 console.log(`EXAM-S5B backend PostgreSQL: ${passed} checks passed.`);
}catch(error){failure=error;throw error;}finally{
 const cleanupErrors=[];
 // Each resource is independent: a failed close must not skip the remaining cleanup.
 for(const cleanup of [()=>peerPool?.end(),()=>world?world.teardown():db?.cleanup(),async()=>{
  if(mediaRoot&&path.dirname(mediaRoot)===tmpdir()&&path.basename(mediaRoot).startsWith('hatoove-s5b-backend-'))
   await rm(mediaRoot,{recursive:true,force:true});
 }])try{await cleanup();}catch(error){cleanupErrors.push(error);}
 for(const [key,value]of Object.entries(savedEnv))if(value===undefined)delete process.env[key];else process.env[key]=value;
 if(cleanupErrors.length){
  if(failure)console.error(`Backend fixture cleanup reported ${cleanupErrors.length} additional failure(s).`);
  else throw new AggregateError(cleanupErrors,'Backend fixture cleanup failed');
 }
}

#!/usr/bin/env node
/** EXAM-S2 real restricted-role PostgreSQL checks. Dedicated disposable DB only; never app ports. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createFixture, rolePool } from '../server/owned-postgres/bootstrap.mjs';
import { createPostgresWorld } from '../server/owned-postgres/fixture.mjs';
import { createPostgresDatastore, createPostgresAccountDeletion, ACCOUNT_TABLES } from '../server/owned-postgres/adapter.mjs';
import { importPackage } from '../server/owned-postgres/package-importer.mjs';

if (process.env.OWNAPI_PG_ALLOW !== '1' || [4300,55440].includes(Number(process.env.OWNAPI_PG_PORT))) {
  throw new Error('Set OWNAPI_PG_ALLOW=1 and explicit disposable OWNAPI_PG_* parameters; live ports prohibited.');
}
process.env.B1PREP_CONTENT_MODE = 'internal-preview';
delete process.env.B1PREP_SERVE_REVIEW;
delete process.env.B1PREP_SERVE_RIGHTS;
const TELC = 'telc-deutsch-b1';
const SET = 's2.synthetic.reading';
function source({ version = 'v1', setVersion = 'v1', formVersion = 'v1', state = 'internal', blocked = [], includeTimed = true } = {}) {
  const members = [{ setId: SET, version: setVersion, interaction: 'single_choice', itemCount: 2 }];
  const form = { id:'s2-reading',version:formVersion,title:'Synthetic reading section',scope:'section',sections:['LV'],
    mode:'untimed',timeLimitSeconds:null,feedback:'finalise',members };
  return {schemaVersion:1,exam:{id:TELC,title:'telc Deutsch B1',language:'de',levelModel:{type:'CEFR',levels:['B1']}},
    blueprint:{version:'v1',sections:[{id:'LV',title:'Lesen',parts:[{family:'S2R',itemCount:2,interaction:'single_choice',mediaRequired:false}]}],
      assessment:{policy:'objective-count-v1',correct:1,incorrect:0}},
    release:{version,state,resumeBlockedReleases:blocked},
    forms:[form,...(includeTimed?[{...form,id:'s2-timed',mode:'timed',timeLimitSeconds:1}]:[])],
    sets:[{setId:SET,version:setVersion,examId:TELC,family:'S2R',section:'LV',part:1,title:'Synthetic exact version '+setVersion,
      payload:{text:'Synthetic test content.',questions:[{n:1,question:'One?',options:{a:'A',b:'B'}},{n:2,question:'Two?',options:{a:'A',b:'B'}}]},
      itemCount:2,interaction:'single_choice',answers:{1:setVersion==='v1'?'a':'b',2:'b'},explanations:{1:'Synthetic explanation '+setVersion,2:'Synthetic second explanation'},
      reviewStatus:'unreviewed',rightsStatus:'generated',source:'synthetic:exam-s2-runs-pg-check'}]};
}
const db = await createFixture();
const world = await createPostgresWorld({ fixture:db });
const parallelPool = rolePool(db.config,db.schema,db.roles.learner,5);
const port = createPostgresDatastore({ pool:parallelPool });
const deletion = createPostgresAccountDeletion({ pool:db.deletion });
let passed=0;
const check=async(name,work)=>{await work();passed++;console.log('PASS '+name);};
const rejects=async(promise,code,status=409)=>assert.rejects(promise,e=>e.code===code&&e.status===status);
async function owner(tag) {
  const email=`s2-${tag}-${randomUUID()}@example.invalid`;
  const outcome=await world.sessions.signUp({name:'Synthetic '+tag,email,password:'synthetic-s2-test-password'});
  const session=await world.sessions.getSession({cookie:String(outcome.setCookie).split(';')[0]});
  assert.ok(session?.userId,'synthetic signup session');
  const id=session.userId;
  const prep=(await port.listPreparations(id))[0];
  return {id,prep};
}
const start=(o,patch={})=>port.startMockRun(o.id,{preparationId:o.prep.id,formId:'s2-reading',formVersion:'v1',releaseVersion:'v1',eventId:randomUUID(),...patch});
const snapshot=(revision,answer='a',patch={})=>({expectedRevision:revision,eventId:randomUUID(),responses:[{setId:SET,version:'v1',itemId:'1',answer}],position:{member:0,item:0},...patch});
const finalise=(o,run,patch={})=>port.finaliseMockRun(o.id,run.id,{expectedRevision:run.revision,eventId:randomUUID(),...patch});
const count=async(table,who)=>Number((await db.admin.query(`SELECT count(*)::int AS n FROM ${table} WHERE owner_id=$1`,[who])).rows[0].n);
async function asLearner(who,work) {
  const client=await parallelPool.connect();
  try {await client.query('BEGIN');await client.query("SELECT set_config('hatoove.owner_id',$1,true)",[who]);const result=await work(client);await client.query('COMMIT');return result;}
  catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
}
async function blockPreparation(o,work) {
  const client=await parallelPool.connect();
  try {
    await client.query('BEGIN');await client.query("SELECT set_config('hatoove.owner_id',$1,true)",[o.id]);
    await client.query('SELECT id FROM learner_preparation WHERE id=$1 FOR UPDATE',[o.prep.id]);
    return await work(client);
  } finally {await client.query('ROLLBACK').catch(()=>{});client.release();}
}
async function waitForBlocked() {
  // Observe a real lock waiter; a sleep alone would be an unreliable concurrency assertion.
  for(let i=0;i<100;i++) {
    const row=(await db.admin.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE application_name=$1 AND wait_event_type='Lock'",[db.schema])).rows[0];
    if(row.n>0)return;
    await new Promise(r=>setTimeout(r,20));
  }
  throw new Error('expected PostgreSQL lock waiter');
}
try {
  await importPackage(db.migration,source(),{publisher:'synthetic-s2-runs-check'});
  const a=await owner('a');const b=await owner('b');
  await check('forms, owned start, exact pin and no early evidence/feedback',async()=>{
    const forms=await port.listMockForms(a.id,{preparationId:a.prep.id});assert.equal(forms.length,2);
    const {run}=await start(a);assert.equal(run.revision,1);assert.equal(run.result,null);assert.equal(run.members[0].version,'v1');
    assert.equal(run.release_version,'v1');assert.equal(run.blueprint_version,'v1');assert.equal(run.responses.length,0);
    assert.ok(!JSON.stringify(run.members).includes('Synthetic explanation'));
    assert.equal(await count('item_evidence',a.id),0);
    assert.ok(!(Object.keys(run).includes('owner_id')));
    for(const operation of [port.readMockRun(b.id,run.id),port.saveMockRun(b.id,run.id,snapshot(1)),finalise(b,run)])await rejects(operation,'not_found',404);
    await rejects(port.listMockRuns(b.id,{preparationId:a.prep.id}),'not_found',404);
    await rejects(start(b,{preparationId:a.prep.id}),'not_found',404);
    await asLearner(b.id,async c=>assert.equal((await c.query('SELECT * FROM mock_run WHERE id=$1',[run.id])).rowCount,0));
    for(const role of [db.learner,db.worker])await assert.rejects(role.query('SELECT answers FROM objective_key LIMIT 1'),e=>e.code==='42501');
  });
  await check('concurrent start retries converge and event identity cannot be reused',async()=>{
    const body={preparationId:a.prep.id,formId:'s2-reading',formVersion:'v1',releaseVersion:'v1',eventId:randomUUID()};
    const results=await Promise.all([port.startMockRun(a.id,body),port.startMockRun(a.id,body)]);
    assert.equal(results[0].run.id,results[1].run.id);assert.equal(results.filter(x=>x.created).length,1);
    await rejects(port.startMockRun(a.id,{...body,formId:'s2-timed'}),'mock_event_conflict');
    await rejects(port.saveMockRun(a.id,results[0].run.id,snapshot(1,'a',{eventId:body.eventId})),'mock_event_conflict');
  });
  await check('save retries, conflicting tabs, exact membership and durable new-connection resume',async()=>{
    const {run}=await start(a);const body=snapshot(1);
    const result=await Promise.all([port.saveMockRun(a.id,run.id,body),port.saveMockRun(a.id,run.id,body)]);
    assert.equal(result[0].revision,2);assert.equal(result[1].revision,2);
    await rejects(port.saveMockRun(a.id,run.id,{...body,responses:[{...body.responses[0],answer:'b'}]}),'mock_event_conflict');
    const concurrent=await Promise.allSettled([port.saveMockRun(a.id,run.id,snapshot(2,'a')),port.saveMockRun(a.id,run.id,snapshot(2,'b'))]);
    assert.equal(concurrent.filter(x=>x.status==='fulfilled').length,1);
    assert.equal(concurrent.find(x=>x.status==='rejected').reason.code,'mock_conflict');
    const current=await world.store.port.readMockRun(a.id,run.id);assert.equal(current.revision,3);
    assert.deepEqual((await port.saveMockRun(a.id,run.id,body)).responses,current.responses,'old acknowledged retry returns current-safe answers');
    await rejects(port.saveMockRun(a.id,run.id,snapshot(3,'a',{responses:[{setId:SET,version:'v2',itemId:'1',answer:'a'}]})),'unknown_mock_item',422);
    await rejects(port.saveMockRun(a.id,run.id,snapshot(3,'z')),'invalid_mock_answer',422);
    await rejects(port.saveMockRun(a.id,run.id,snapshot(3,'a',{position:{member:0,item:2}})),'invalid_mock_position',422);
    assert.equal((await port.readMockRun(a.id,run.id)).revision,3);
  });
  await check('atomic finalise has unanswered items, exact explanations, unique evidence and frozen SQL snapshot',async()=>{
    const {run}=await start(a);const saveBody=snapshot(1);const saved=await port.saveMockRun(a.id,run.id,saveBody);
    const finalBody={expectedRevision:saved.revision,eventId:randomUUID()};const before=await count('item_evidence',a.id);
    const finals=await Promise.all([port.finaliseMockRun(a.id,run.id,finalBody),port.finaliseMockRun(a.id,run.id,finalBody),finalise(a,saved)]);
    assert.ok(finals.every(x=>x.state==='finalised'&&x.revision===3));assert.deepEqual(finals[0].result,finals[2].result);
    assert.deepEqual({answered:finals[0].result.answered,unanswered:finals[0].result.unanswered,correct:finals[0].result.correct,total:finals[0].result.total},
      {answered:1,unanswered:1,correct:1,total:2});
    assert.equal(finals[0].result.items[0].correct_answer,'a');assert.equal(finals[0].result.items[0].explanation,'Synthetic explanation v1');
    assert.equal(finals[0].result.items[1].unanswered,true);assert.equal(await count('item_evidence',a.id),before+1);
    await rejects(port.saveMockRun(a.id,run.id,saveBody),'mock_finalised');
    await assert.rejects(asLearner(a.id,c=>c.query("UPDATE mock_run SET responses='[]',revision=revision+1 WHERE id=$1",[run.id])),/mock_finalised/);
    await assert.rejects(asLearner(a.id,c=>c.query("UPDATE mock_run SET state='active' WHERE id=$1",[run.id])),e=>e.code==='42501');
    await assert.rejects(asLearner(a.id,c=>c.query("UPDATE mock_run SET form_version='v2' WHERE id=$1",[run.id])),e=>e.code==='42501');
    await assert.rejects(asLearner(b.id,c=>c.query('SELECT finalise_mock_run($1,1)',[run.id])),/not_found/);
    assert.deepEqual((await port.readMockRun(a.id,run.id)).result,finals[0].result);
  });
  await check('save/finalise race serialises without grading unsaved answers or duplicate evidence',async()=>{
    const {run}=await start(a);
    const race=await Promise.allSettled([port.saveMockRun(a.id,run.id,snapshot(1)),finalise(a,run)]);
    assert.equal(race.filter(x=>x.status==='fulfilled').length,1);
    let current=await port.readMockRun(a.id,run.id);
    if(current.state==='active'){assert.equal(race.find(x=>x.status==='rejected').reason.code,'mock_conflict');current=await finalise(a,current);}
    else assert.equal(race.find(x=>x.status==='rejected').reason.code,'mock_finalised');
    const evidence=(await db.admin.query('SELECT * FROM item_evidence WHERE mock_run_id=$1',[run.id])).rows;
    assert.equal(evidence.length,current.responses.filter(x=>x.answer!==null).length);
  });
  await check('archive wins an actual lock race and retains read/export history',async()=>{
    const c=await owner('archive');const {run}=await start(c);let pending;
    await blockPreparation(c,async locker=>{
      await locker.query("UPDATE learner_preparation SET state='archived',revision=revision+1 WHERE id=$1",[c.prep.id]);
      pending=port.saveMockRun(c.id,run.id,snapshot(1));pending.catch(()=>{});await waitForBlocked();await locker.query('COMMIT');
    });
    await rejects(pending,'preparation_archived');
    await rejects(finalise(c,run),'preparation_archived');await rejects(start(c),'preparation_archived');
    assert.equal((await port.readMockRun(c.id,run.id)).state,'active');
    assert.equal((await port.listMockRuns(c.id,{preparationId:c.prep.id})).length,1);
    assert.equal((await port.exportData(c.id)).mock_runs[0].id,run.id);
  });
  await check('deadline pins server time; expired save refused, finalise only acknowledged data',async()=>{
    const {run}=await start(a,{formId:'s2-timed'});assert.ok(run.deadline_at);assert.equal(run.expired,false);
    const saved=await port.saveMockRun(a.id,run.id,snapshot(1));
    await new Promise(r=>setTimeout(r,1150));
    const resumed=await port.readMockRun(a.id,run.id);assert.equal(resumed.deadline_at,run.deadline_at);assert.equal(resumed.expired,true);
    await rejects(port.saveMockRun(a.id,run.id,snapshot(saved.revision,'b')),'mock_expired');
    const result=await finalise(a,resumed);assert.equal(result.expired,true);assert.equal(result.result.correct,1);assert.deepEqual(result.responses,saved.responses);
  });
  await check('same-exam SQL foreign keys and identity triggers fail closed',async()=>{
    const {run}=await start(a);
    await assert.rejects(db.admin.query('UPDATE mock_run SET preparation_id=$2 WHERE id=$1',[run.id,b.prep.id]),/mock_identity_immutable/);
    await assert.rejects(asLearner(a.id,c=>c.query(`INSERT INTO mock_run(id,owner_id,preparation_id,exam_id,release_version,blueprint_version,form_id,form_version,start_event_id,title,scope,mode)
      VALUES($1,$2,$3,$4,'v1','v1','s2-reading','v1',$5,'x','section','untimed')`,[randomUUID(),a.id,b.prep.id,TELC,randomUUID()])),/preparation_archived/);
    await assert.rejects(asLearner(a.id,c=>c.query("UPDATE mock_run SET responses=$2::jsonb,revision=revision+1 WHERE id=$1",[run.id,JSON.stringify([{setId:SET,version:'v9',itemId:'1',answer:'a'}])])),/unknown_mock_item/);
    assert.equal((await port.readMockRun(a.id,run.id)).revision,1);
  });
  await check('deletion waits for mock writer, removes receipts/runs/evidence, leaves other owner intact',async()=>{
    const c=await owner('delete');const {run}=await start(c);await port.saveMockRun(c.id,run.id,snapshot(1));
    const other=await count('mock_run',a.id);
    let pending;let finished=false;
    await asLearner(c.id,async locker=>{
      await locker.query('SELECT pg_advisory_xact_lock(hashtextextended($1,7352))',[c.id]);
      pending=deletion.deleteAccount(c.id).then(x=>{finished=true;return x;});pending.catch(()=>{});
      await waitForBlocked();assert.equal(finished,false);
    });
    const deleted=await pending;assert.equal(deleted.verifiedAbsent,true);
    for(const table of ['mock_run','mock_run_event','item_evidence','learner_preparation'])assert.equal(await count(table,c.id),0);
    assert.equal(await count('mock_run',a.id),other);await rejects(port.saveMockRun(c.id,run.id,snapshot(2)),'not_found',404);
    assert.ok(ACCOUNT_TABLES.some(x=>x[0]==='mock_run_event'));
  });
  await check('version publication does not substitute saved content or standalone historical evidence',async()=>{
    await port.answerObjectiveItem(a.id,{preparationId:a.prep.id,setId:SET,version:'v1',itemId:'1',answer:'a'});
    const before=(await db.admin.query('SELECT * FROM item_evidence WHERE owner_id=$1 AND mock_run_id IS NULL ORDER BY evidence_id',[a.id])).rows;
    const {run}=await start(a);const saved=await port.saveMockRun(a.id,run.id,snapshot(1));
    await importPackage(db.migration,source({version:'v2',setVersion:'v2',formVersion:'v2'}),{publisher:'synthetic-s2-runs-check'});
    const resumed=await port.readMockRun(a.id,run.id);assert.equal(resumed.members[0].version,'v1');
    assert.equal((await finalise(a,saved)).result.items[0].correct_answer,'a');
    const newer=await start(a,{formVersion:'v2',releaseVersion:'v2'});
    const newerSaved=await port.saveMockRun(a.id,newer.run.id,snapshot(1,'a',{responses:[{setId:SET,version:'v2',itemId:'1',answer:'a'}]}));
    const newerResult=await finalise(a,newerSaved);assert.equal(newerResult.result.correct,0);assert.equal(newerResult.result.items[0].correct_answer,'b');
    await rejects(start(a),'not_found',404);
    assert.equal(await port.readObjectiveSet(a.id,{setId:SET,version:'v1'}),null,'retired imported exact version direct access refused');
    assert.deepEqual((await db.admin.query('SELECT * FROM item_evidence WHERE owner_id=$1 AND mock_run_id IS NULL ORDER BY evidence_id',[a.id])).rows,before);
  });
  await check('ordinary withdrawal resumes pinned content; rights block retains answers but withholds protected result',async()=>{
    const {run}=await start(a,{formVersion:'v2',releaseVersion:'v2'});
    const saved=await port.saveMockRun(a.id,run.id,snapshot(1,'b',{responses:[{setId:SET,version:'v2',itemId:'1',answer:'b'}]}));
    await importPackage(db.migration,source({version:'v3',setVersion:'v2',formVersion:'v2',state:'withdrawn'}),{publisher:'synthetic-s2-runs-check'});
    assert.equal((await port.listMockForms(a.id,{preparationId:a.prep.id})).length,0);
    assert.equal((await port.readMockRun(a.id,run.id)).members.length,1);
    const final=await finalise(a,saved);assert.equal(final.result.correct,1);
    await importPackage(db.migration,source({version:'v4',setVersion:'v2',formVersion:'v2',state:'withdrawn',blocked:['v1','v2']}),{publisher:'synthetic-s2-runs-check'});
    const blocked=await port.readMockRun(a.id,run.id);assert.equal(blocked.blocked_reason,'rights_blocked');assert.deepEqual(blocked.members,[]);
    assert.equal(blocked.result,null);assert.deepEqual(blocked.responses,saved.responses);
    await rejects(finalise(a,blocked),'mock_rights_blocked');
    await assert.rejects(asLearner(a.id,c=>c.query('SELECT finalise_mock_run($1,$2)',[run.id,blocked.revision])),/mock_rights_blocked/);
    const exported=(await port.exportData(a.id)).mock_runs.find(x=>x.id===run.id);assert.deepEqual(exported.responses,saved.responses);assert.equal(exported.result,null);
  });
  console.log(`\n${passed} passed, 0 failed (real PostgreSQL; disposable schema ${db.schema})`);
} finally {await parallelPool.end();await world.teardown();}

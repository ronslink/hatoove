#!/usr/bin/env node
/** EXAM-S3: real restricted roles in a disposable synthetic database. No running app/provider. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { createFixture } from '../server/owned-postgres/bootstrap.mjs';
import {importHistoricalDefaultPackage,assertHistoricalProjectionAbsent} from './historical-content-fixture.mjs';
import { createPostgresWorld } from '../server/owned-postgres/fixture.mjs';
import { createPostgresDatastore } from '../server/owned-postgres/adapter.mjs';
import { importPackage } from '../server/owned-postgres/package-importer.mjs';
import { createExamCatalogue } from '../server/preparation-contract.mjs';
import { createOwnedApi } from '../server/owned-api.mjs';
import { syntheticPackage, originalPackage, S3_EXAM, S3_GROUPED_SET } from './exam-s3-check.mjs';
import {syntheticContentReview} from './exam-s6-fixture.mjs';

if (process.env.OWNAPI_PG_ALLOW!=='1' || !process.env.OWNAPI_PG_PORT || [4300,55440].includes(Number(process.env.OWNAPI_PG_PORT)))
  throw new Error('Explicit disposable OWNAPI_PG_ALLOW=1 and OWNAPI_PG_PORT required; learner ports forbidden.');
process.env.B1PREP_CONTENT_MODE='internal-preview';
delete process.env.B1PREP_SERVE_REVIEW;delete process.env.B1PREP_SERVE_RIGHTS;
const TELC='telc-deutsch-b1';
const catalogue=createExamCatalogue({enabled:[TELC,S3_EXAM]});
const db=await createFixture({stopBefore:'0026-'});
const world=await createPostgresWorld({fixture:db,examCatalogue:catalogue});
const port=world.store.port;
const defaultPort=createPostgresDatastore({pool:db.learner});
const defaultApi=createOwnedApi({datastore:defaultPort,sessions:world.sessions});
let passed=0;
const check=async(name,fn)=>{await fn();passed++;console.log('PASS '+name);};
const reject=(promise,code,status)=>assert.rejects(promise,e=>e.code===code&&(!status||e.status===status));
async function owner(tag) {
  const result=await world.sessions.signUp({name:'Synthetic S3 '+tag,email:`s3-${tag}-${randomUUID()}@example.invalid`,password:'synthetic-password-s3'});
  const cookie=String(result.setCookie).split(';')[0];const session=await world.sessions.getSession({cookie});
  return {id:session.userId,cookie,telc:(await port.listPreparations(session.userId))[0]};
}
async function get(o,path,api=world.api) {
  const r=await api.handle({method:'GET',path,headers:{cookie:o.cookie},originChecked:true});
  return {status:r.status,json:JSON.parse(r.body)};
}
async function sqlAs(owner,fn) {
  const c=await db.learner.connect();
  try{await c.query('BEGIN');await c.query("SELECT set_config('hatoove.owner_id',$1,true)",[owner]);const r=await fn(c);await c.query('COMMIT');return r;}
  catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
}
const start=(o,patch={})=>port.startMockRun(o.id,{preparationId:o.dtz.id,formId:'s3-reading',formVersion:'v1',releaseVersion:'v8001',eventId:randomUUID(),...patch});
const answer=(id,value,version='v1')=>({setId:S3_GROUPED_SET,version,itemId:id,answer:value});
const save=(o,run,responses,position={member:0,item:3})=>port.saveMockRun(o.id,run.id,{expectedRevision:run.revision,eventId:randomUUID(),responses,position});
const finalise=(o,run)=>port.finaliseMockRun(o.id,run.id,{expectedRevision:run.revision,eventId:randomUUID()});
try {
  await importHistoricalDefaultPackage(db);
  const a=await owner('a');const b=await owner('b');
  await check('forward migration preserves existing telc run and protected function/grant boundaries',async()=>{
    // Inspect the pre-upgrade release relation through its historical SQL contract.
    const form = await sqlAs(a.id, async c => (await c.query('SELECT f.form_id,f.form_version AS version,f.release_version FROM exam_release_form f JOIN exam_release_head h USING(exam_id,release_version) WHERE f.exam_id=$1 ORDER BY f.form_id LIMIT 1',[TELC])).rows[0]);
    // Exercise the historical schema through its own SQL grant, not a latest-schema adapter.
    const old=await sqlAs(a.id,async c=>(await c.query(`INSERT INTO mock_run
      (id,owner_id,preparation_id,exam_id,release_version,blueprint_version,form_id,form_version,start_event_id,title,scope,mode)
      SELECT $1,$2,$3,f.exam_id,$4,f.blueprint_version,f.form_id,f.version,$5,f.payload->>'title',f.payload->>'scope',f.payload->>'mode'
      FROM exam_form f WHERE f.exam_id=$6 AND f.form_id=$7 AND f.version=$8 RETURNING *`,
      [randomUUID(),a.id,a.telc.id,form.release_version,randomUUID(),TELC,form.form_id,form.version])).rows[0]);
    const before=(await db.admin.query('SELECT * FROM mock_run WHERE id=$1',[old.id])).rows[0];
    await assertHistoricalProjectionAbsent(db);
    assert.deepEqual(await db.applyRemaining(),['0026-grouped-objective-runs.sql','0027-dtz-writing.sql','0028-payments.sql','0029-fixed-media.sql','0030-listening-playback.sql','0031-assigned-mock-writing.sql','0032-ordered-mock-time-groups.sql','0033-content-rights-fence.sql','0034-complete-dtz-admission.sql','0035-content-review.sql','0036-content-review-consumers.sql','0037-saved-explanations.sql','0038-provider-attempts.sql','0039-registration-language.sql','0040-explanation-review.sql','0041-pilot-access.sql']);
    assert.deepEqual((await db.admin.query('SELECT * FROM mock_run WHERE id=$1',[old.id])).rows[0],before);
    assert.equal((await finalise(a,old)).result.total,20);
    const functions=(await db.admin.query("SELECT proname,prosecdef,proconfig FROM pg_proc WHERE pronamespace=current_schema()::regnamespace AND proname IN ('protect_mock_run','finalise_mock_run')")).rows;
    assert.equal(functions.length,2);assert.ok(functions.every(f=>f.prosecdef&&f.proconfig.some(v=>v.startsWith('search_path='))));
    for(const role of [db.learner,db.worker]) await assert.rejects(role.query('SELECT answers FROM objective_key LIMIT 1'),e=>e.code==='42501');
    assert.equal((await db.admin.query("SELECT has_function_privilege('public','finalise_mock_run(uuid,integer)','EXECUTE') AS allowed")).rows[0].allowed,false);
  });
  await importPackage(db.migration,syntheticPackage(),{publisher:'synthetic-s3-check'});
  a.dtz=(await port.createPreparation(a.id,S3_EXAM)).preparation;
  b.dtz=(await port.createPreparation(b.id,S3_EXAM)).preparation;
  await check('exact standalone metadata, LV4/LV5 filters and default catalogue/direct-ID refusal',async()=>{
    const sets=await port.listObjectiveSets(a.id,{examId:S3_EXAM});assert.equal(sets.length,3);
    assert.deepEqual(sets.map(s=>s.interaction),['grouped_choice','single_choice','gap_choice']);
    assert.ok(sets.every(s=>s.section==='LV'&&!Object.hasOwn(s,'payload')));
    const set=await port.readObjectiveSet(a.id,{setId:S3_GROUPED_SET,version:'v1'});assert.equal(set.interaction,'grouped_choice');assert.equal(set.payload.groups[1].text,'Synthetic second passage.');
    assert.ok(!JSON.stringify(set).includes('explanation'));
    for(const family of ['LV4','LV5']) {
      const dtz=await get(a,`/api/v1/objective-sets?preparationId=${a.dtz.id}&family=${family}`);assert.equal(dtz.status,200);assert.equal(dtz.json.length,1);assert.equal(dtz.json[0].family,family);
      assert.equal((await get(a,`/api/v1/objective-sets?preparationId=${a.telc.id}&family=${family}`)).status,422);
    }
    for(const family of ['LV6','lv4','LV04','LV4%20','SB3'])assert.equal((await get(a,`/api/v1/objective-sets?preparationId=${a.dtz.id}&family=${family}`)).status,422);
    assert.equal((await get(b,`/api/v1/objective-sets?preparationId=${a.dtz.id}&family=LV4`)).status,404);
    assert.deepEqual(await defaultPort.listObjectiveSets(a.id,{examId:S3_EXAM}),[]);
    assert.equal(await defaultPort.nextPractice(a.id,{preparationId:a.dtz.id}),null);
    assert.equal(await defaultPort.readObjectiveSet(a.id,{setId:S3_GROUPED_SET,version:'v1'}),null);
    assert.equal((await get(a,`/api/v1/objective-sets/${S3_GROUPED_SET}?preparationId=${a.dtz.id}&version=v1`,defaultApi)).status,404);
    // Existing active preparation is an idempotent resume under the S6 contract.
    const resumedPreparation=await defaultPort.createPreparation(a.id,S3_EXAM);assert.equal(resumedPreparation.created,false);assert.equal(resumedPreparation.preparation.id,a.dtz.id);
    const fresh=await owner('disabled-new');await reject(defaultPort.createPreparation(fresh.id,S3_EXAM),'exam_unavailable',422);
    await reject(defaultPort.answerObjectiveItem(a.id,{preparationId:a.dtz.id,setId:S3_GROUPED_SET,version:'v1',itemId:'31',answer:'richtig'}),'not_found',404);
    assert.equal((await port.readCredits(a.id,a.dtz.id)).allowance,0);
  });
  await check('grouped saved run round trip and finalisation cover both passages and mixed option keys',async()=>{
    const forms=await port.listMockForms(a.id,{preparationId:a.dtz.id});assert.equal(forms[0].release_state,'internal');assert.equal(forms[0].review_status,'unreviewed');
    const {run}=await start(a);assert.equal(run.result,null);assert.equal(run.release_state,'internal');assert.equal(run.review_status,'unreviewed');
    assert.equal(run.members[0].review_status,'unreviewed');assert.equal(run.members[0].release_state,'internal');
    const saved=await save(a,run,[answer('31','richtig'),answer('32','a'),answer('33','falsch'),answer('34','b')]);
    const resumed=await port.readMockRun(a.id,run.id);assert.deepEqual(resumed.responses,saved.responses);assert.deepEqual(resumed.position,{member:0,item:3});
    assert.equal(resumed.members[0].payload.groups[1].text,'Synthetic second passage.');
    const done=await finalise(a,saved);assert.deepEqual(done.result.items.slice(0,4).map(x=>x.item_id),['31','32','33','34']);
    assert.deepEqual({correct:done.result.correct,answered:done.result.answered,total:done.result.total},{correct:4,answered:4,total:8});
    assert.deepEqual(done.result.items.slice(0,4).map(x=>x.correct_answer),['richtig','a','falsch','b']);
    const rows=(await db.admin.query('SELECT item_id,version,preparation_id FROM item_evidence WHERE mock_run_id=$1 ORDER BY item_id',[run.id])).rows;
    assert.equal(rows.length,4);assert.ok(rows.every(r=>r.version==='v1'&&r.preparation_id===a.dtz.id));
    await reject(port.readMockRun(b.id,run.id),'not_found',404);
    await assert.rejects(sqlAs(b.id,c=>c.query('SELECT finalise_mock_run($1,1)',[run.id])),/not_found/);
  });
  await check('direct SQL rejects malformed, duplicate, wrong-version and wrong-question responses atomically',async()=>{
    const {run}=await start(a);
    for(const responses of [
      [answer('31','a')],[answer('32','richtig')],[answer('34','b','v2')],[answer('first','a')],
      [answer('31',true)],[{...answer('31','richtig'),itemId:31}],
      [{...answer('31','richtig'),extra:'x'}],[answer('31','richtig'),answer('31','falsch')],
      [null],[[answer('31','richtig')]],
    ]) {
      await assert.rejects(sqlAs(a.id,c=>c.query('UPDATE mock_run SET responses=$2::jsonb,revision=revision+1 WHERE id=$1',[run.id,JSON.stringify(responses)])),e=>e.code==='23514');
      const unchanged=await port.readMockRun(a.id,run.id);assert.equal(unchanged.revision,1);assert.deepEqual(unchanged.responses,[]);
    }
    await sqlAs(a.id,c=>c.query('UPDATE mock_run SET responses=$2::jsonb,revision=revision+1 WHERE id=$1',[run.id,JSON.stringify([answer('34','b')])]));
    const done=await finalise(a,await port.readMockRun(a.id,run.id));assert.equal(done.result.correct,1);
    await assert.rejects(sqlAs(a.id,c=>c.query("UPDATE mock_run SET responses='[]',revision=revision+1 WHERE id=$1",[run.id])),/mock_finalised/);
  });
  let oldRun;
  await check('new release keeps old grouped key versions exact while standalone membership moves',async()=>{
    oldRun=await save(a,(await start(a)).run,[answer('31','richtig'),answer('32','a'),answer('33','falsch'),answer('34','b')]);
    await importPackage(db.migration,syntheticPackage({release:'v8002',version:'v2'}),{publisher:'synthetic-s3-check'});
    assert.equal(await port.readObjectiveSet(a.id,{setId:S3_GROUPED_SET,version:'v1'}),null);
    const v2=await port.readObjectiveSet(a.id,{setId:S3_GROUPED_SET,version:'v2'});assert.equal(v2.interaction,'grouped_choice');
    const done=await finalise(a,oldRun);assert.equal(done.result.correct,4);assert.equal(done.result.items[0].correct_answer,'richtig');assert.match(done.result.items[0].explanation,/v1/);
    const next=await save(a,(await start(a,{formVersion:'v2',releaseVersion:'v8002'})).run,[answer('31','richtig','v2'),answer('32','a','v2'),answer('33','falsch','v2'),answer('34','b','v2')]);
    const newDone=await finalise(a,next);assert.equal(newDone.result.correct,2);assert.equal(newDone.result.items[0].correct_answer,'falsch');assert.equal(newDone.result.items[1].correct_answer,'c');assert.match(newDone.result.items[0].explanation,/v2/);
    const marked=await port.answerObjectiveItem(a.id,{preparationId:a.dtz.id,setId:S3_GROUPED_SET,version:'v2',itemId:'31',answer:'falsch'});assert.equal(marked.correct,true);
  });
  await check('internal saved-run content and feedback stay private across public/default policy changes',async()=>{
    const active=await save(a,(await start(a,{formVersion:'v2',releaseVersion:'v8002'})).run,[answer('34','b','v2')]);
    const completed=await finalise(a,await save(a,(await start(a,{formVersion:'v2',releaseVersion:'v8002'})).run,[answer('33','falsch','v2')]));
    const evidenceBefore=(await db.admin.query('SELECT * FROM item_evidence WHERE mock_run_id=$1',[completed.id])).rows;
    const checkRead=async(target,reason)=>{
      for(const run of [active,completed]) {
        const dto=await target.readMockRun(a.id,run.id);assert.equal(dto.blocked_reason,reason);assert.deepEqual(dto.members,[]);assert.equal(dto.result,null);assert.deepEqual(dto.responses,run.responses);
        assert.equal((await target.listMockRuns(a.id,{preparationId:a.dtz.id})).find(r=>r.id===run.id).blocked_reason,reason);
        const exported=(await target.exportData(a.id)).mock_runs.find(r=>r.id===run.id);assert.deepEqual(exported.responses,run.responses);assert.equal(exported.result,null);
      }
    };
    await checkRead(defaultPort,'exam_unavailable');
    const direct=await get(a,`/api/v1/mock-runs/${completed.id}`,defaultApi);assert.equal(direct.status,200);assert.equal(direct.json.blocked_reason,'exam_unavailable');assert.deepEqual(direct.json.members,[]);assert.equal(direct.json.result,null);
    await reject(defaultPort.finaliseMockRun(a.id,active.id,{expectedRevision:active.revision,eventId:randomUUID()}),'exam_unavailable',422);
    await reject(defaultPort.saveMockRun(a.id,active.id,{expectedRevision:active.revision,eventId:randomUUID(),responses:active.responses,position:active.position}),'exam_unavailable',422);
    process.env.B1PREP_CONTENT_MODE='public';
    try {
      await checkRead(port,'content_policy_blocked');
      await reject(finalise(a,active),'mock_content_unavailable',409);
      await reject(save(a,active,active.responses),'mock_content_unavailable',409);
    } finally {process.env.B1PREP_CONTENT_MODE='internal-preview';}
    assert.equal((await port.readMockRun(a.id,active.id)).blocked_reason,null);
    const projected=(await port.readMockRun(a.id,completed.id)).result;
    assert.ok(projected.items.every(item=>item.explanation_view?.schema==='explanation-view-v1'));
    assert.deepEqual({...projected,items:projected.items.map(({explanation_view,...original})=>original)},completed.result);
    assert.deepEqual((await db.admin.query('SELECT result FROM mock_run WHERE id=$1',[completed.id])).rows[0].result,completed.result);
    assert.deepEqual((await db.admin.query('SELECT * FROM item_evidence WHERE mock_run_id=$1',[completed.id])).rows,evidenceBefore);
    assert.ok((await port.exportData(a.id)).objective_evidence.some(e=>e.item_id==='33'&&e.version==='v2'));
  });
  await check('public mode, hidden publication and blocked releases cannot expose the internal reading package',async()=>{
    process.env.B1PREP_CONTENT_MODE='public';
    try {
      assert.deepEqual(await port.listObjectiveSets(a.id,{examId:S3_EXAM}),[]);assert.equal(await port.readObjectiveSet(a.id,{setId:S3_GROUPED_SET,version:'v2'}),null);
      assert.deepEqual(await port.listMockForms(a.id,{preparationId:a.dtz.id}),[]);
      await reject(start(a,{formVersion:'v2',releaseVersion:'v8002'}),'not_found',404);
    } finally {process.env.B1PREP_CONTENT_MODE='internal-preview';}
    await importPackage(db.migration,syntheticPackage({release:'v8003',version:'v2',state:'hidden',blocked:['v8001']}),{publisher:'synthetic-s3-check'});
    assert.equal(await port.readObjectiveSet(a.id,{setId:S3_GROUPED_SET,version:'v2'}),null);
    const blocked=await port.readMockRun(a.id,oldRun.id);assert.equal(blocked.blocked_reason,'rights_blocked');assert.deepEqual(blocked.members,[]);assert.equal(blocked.result,null);assert.equal(blocked.responses.length,4);
    assert.equal((await get(a,`/api/v1/objective-sets?preparationId=${a.dtz.id}&family=LV5`)).status,422);
  });
  await check('inconsistent current membership cannot choose an interaction arbitrarily or use legacy fallback',async()=>{
    await importPackage(db.migration,syntheticPackage({release:'v8004',version:'v2'}),{publisher:'synthetic-s3-check'});
    // Simulate corrupt privileged publication metadata without mutating immutable content or old forms.
    await db.migration.query(`INSERT INTO exam_form(exam_id,form_id,version,blueprint_version,payload,sha256)
      VALUES($1,'s3-corrupt','v1','v8000','{}','synthetic')`,[S3_EXAM]);
    await db.migration.query(`INSERT INTO exam_form_member(exam_id,form_id,form_version,position,set_id,set_version,interaction,item_count)
      VALUES($1,'s3-corrupt','v1',0,$2,'v2','single_choice',4)`,[S3_EXAM,S3_GROUPED_SET]);
    await db.migration.query(`INSERT INTO exam_release_form(exam_id,release_version,form_id,form_version) VALUES($1,'v8004','s3-corrupt','v1')`,[S3_EXAM]);
    assert.equal(await port.readObjectiveSet(a.id,{setId:S3_GROUPED_SET,version:'v2'}),null);
    assert.ok((await port.listObjectiveSets(a.id,{examId:S3_EXAM})).every(s=>s.set_id!==S3_GROUPED_SET));
    const legacy=await port.listObjectiveSets(a.id,{examId:TELC});assert.ok(legacy.some(s=>s.interaction==='matching_ads'));
    assert.ok(legacy.every(s=>['matching_headlines','single_choice','matching_ads','gap_choice','gap_bank'].includes(s.interaction)),'every served legacy set has renderer metadata, including non-form SB sets');
    const existing=(await db.admin.query(`SELECT s.set_id,s.version,m.interaction,m.item_count,r.blueprint_version,r.version AS release
      FROM exam_release_head h JOIN exam_release r ON r.exam_id=h.exam_id AND r.version=h.release_version
      JOIN exam_release_form rf ON rf.exam_id=r.exam_id AND rf.release_version=r.version
      JOIN exam_form_member m ON m.exam_id=rf.exam_id AND m.form_id=rf.form_id AND m.form_version=rf.form_version
      JOIN objective_set s ON s.set_id=m.set_id AND s.version=m.set_version
      JOIN content_version c ON c.content_version_id=s.content_version_id
      WHERE h.exam_id=$1 AND c.source_path NOT LIKE 'content/exams/%' LIMIT 1`,[TELC])).rows[0];
    assert.ok(existing);
    await db.migration.query(`INSERT INTO exam_form(exam_id,form_id,version,blueprint_version,payload,sha256)
      VALUES($1,'s3-corrupt-legacy','v1',$2,'{}','synthetic')`,[TELC,existing.blueprint_version]);
    await db.migration.query(`INSERT INTO exam_form_member(exam_id,form_id,form_version,position,set_id,set_version,interaction,item_count)
      VALUES($1,'s3-corrupt-legacy','v1',0,$2,$3,$4,$5)`,[TELC,existing.set_id,existing.version,existing.interaction==='single_choice'?'gap_choice':'single_choice',existing.item_count]);
    await db.migration.query(`INSERT INTO exam_release_form(exam_id,release_version,form_id,form_version)
      VALUES($1,$2,'s3-corrupt-legacy','v1')`,[TELC,existing.release]);
    assert.equal(await port.readObjectiveSet(a.id,{setId:existing.set_id,version:existing.version}),null,'legacy fallback cannot mask conflicting current declarations');
  });
  await check('actual original 25-item source imports beside S2 v1, stays internal and finalises all five reading shapes',async()=>{
    const s2=JSON.parse(await readFile(new URL('../content/fixtures/exams/dtz-internal.json',import.meta.url),'utf8'));
    await importPackage(db.migration,s2,{publisher:'synthetic-s3-old-fixture'});
    const p=originalPackage();await importPackage(db.migration,p,{publisher:'synthetic-s3-original-input'});
    assert.equal((await importPackage(db.migration,p,{publisher:'synthetic-s3-original-input'})).unchanged,true);
    const list=await port.listObjectiveSets(a.id,{examId:S3_EXAM});assert.equal(list.length,5);assert.ok(list.every(s=>s.section==='LV'));
    assert.deepEqual(list.map(s=>s.interaction),['single_choice','matching_ads','grouped_choice','single_choice','gap_choice']);
    assert.equal((await port.nextPractice(a.id,{preparationId:a.dtz.id})).set.interaction,'single_choice');
    assert.deepEqual(await port.listObjectiveSets(a.id,{examId:S3_EXAM,group:'SB'}),[]);
    for(const s of p.sets) {
      const dto=await port.readObjectiveSet(a.id,{setId:s.setId,version:s.version});assert.equal(dto.interaction,s.interaction);
      assert.equal(Object.hasOwn(dto,'answers'),false);assert.equal(Object.hasOwn(dto,'explanations'),false);
      assert.equal(await defaultPort.readObjectiveSet(a.id,{setId:s.setId,version:s.version}),null);
    }
    const form=p.forms[0];const started=(await port.startMockRun(a.id,{preparationId:a.dtz.id,formId:form.id,formVersion:form.version,releaseVersion:p.release.version,eventId:randomUUID()})).run;
    assert.equal(started.members.length,5);assert.equal(started.deadline_at,null);assert.equal(started.release_state,'internal');assert.equal(started.review_status,'unreviewed');
    const responses=p.sets.flatMap(s=>Object.entries(s.answers).map(([itemId,answer])=>({setId:s.setId,version:s.version,itemId,answer})));
    const saved=await save(a,started,responses,{member:4,item:5});const done=await finalise(a,saved);
    assert.deepEqual({total:done.result.total,correct:done.result.correct,answered:done.result.answered},{total:25,correct:25,answered:25});
    assert.deepEqual(done.result.items.map(i=>Number(i.item_id)),Array.from({length:25},(_,i)=>21+i));
    process.env.B1PREP_CONTENT_MODE='public';
    try {
      assert.deepEqual(await port.listObjectiveSets(a.id,{examId:S3_EXAM}),[]);assert.deepEqual(await port.listMockForms(a.id,{preparationId:a.dtz.id}),[]);
      for(const s of p.sets)assert.equal(await port.readObjectiveSet(a.id,{setId:s.setId,version:s.version}),null);
    } finally {process.env.B1PREP_CONTENT_MODE='internal-preview';}
    assert.deepEqual((await db.admin.query('SELECT version FROM exam_blueprint WHERE exam_id=$1 ORDER BY version',[S3_EXAM])).rows.map(r=>r.version),['v1','v2','v8000']);
  });
  await check('available-origin ordinary withdrawal retains permitted public saved-run resume',async()=>{
    // Exact named decisions cover only these synthetic rows; no human approval is claimed.
    const p=syntheticPackage({release:'v8101'});p.exam.id=TELC;p.exam.title='Synthetic publication boundary';p.blueprint.version='v8100';
    p.forms[0].id='s3-public-boundary';
    for(const set of p.sets){set.examId=TELC;set.setId='s3-public.'+set.family;}
    p.forms[0].members=p.sets.map(s=>({setId:s.setId,version:s.version,interaction:s.interaction,itemCount:s.itemCount}));
    await importPackage(db.migration,p,{publisher:'synthetic-s3-policy-control'});
    const client=await db.migration.connect();
    try {
      await client.query('BEGIN');
      for(const set of p.sets) {
        const id=set.setId+'@'+set.version;
        const row=(await client.query('SELECT content_sha256 FROM content_version WHERE content_version_id=$1',[id])).rows[0];
        await syntheticContentReview(db,client,{kind:'content',examId:TELC,subjectId:id,version:'',sha256:row.content_sha256});
      }
      const bp=(await client.query('SELECT sha256 FROM exam_blueprint WHERE exam_id=$1 AND version=$2',[TELC,p.blueprint.version])).rows[0];
      await syntheticContentReview(db,client,{kind:'blueprint',examId:TELC,subjectId:TELC,version:p.blueprint.version,sha256:bp.sha256});
      for(const form of p.forms) {
        const row=(await client.query('SELECT sha256 FROM exam_form WHERE exam_id=$1 AND form_id=$2 AND version=$3',[TELC,form.id,form.version])).rows[0];
        await syntheticContentReview(db,client,{kind:'form',examId:TELC,subjectId:form.id,version:form.version,sha256:row.sha256});
      }
      await client.query('COMMIT');
    } catch(error) {await client.query('ROLLBACK');throw error;} finally {client.release();}
    const published={...p,release:{version:'v8102',state:'available',resumeBlockedReleases:[]},sets:[]};
    await importPackage(db.migration,published,{publisher:'synthetic-s3-policy-control'});
    process.env.B1PREP_CONTENT_MODE='public';
    try {
      const run=(await port.startMockRun(a.id,{preparationId:a.telc.id,formId:p.forms[0].id,formVersion:'v1',releaseVersion:'v8102',eventId:randomUUID()})).run;
      const withdrawn={...published,release:{version:'v8103',state:'withdrawn',resumeBlockedReleases:[]},forms:[]};
      await importPackage(db.migration,withdrawn,{publisher:'synthetic-s3-policy-control'});
      const current=await defaultPort.readMockRun(a.id,run.id);assert.equal(current.blocked_reason,null);assert.equal(current.release_state,'available');assert.equal(current.review_status,'approved');assert.equal(current.members.length,3);
      const saved=await save(a,current,[{setId:p.sets[0].setId,version:'v1',itemId:'34',answer:'b'}]);
      const done=await finalise(a,saved);assert.equal(done.result.correct,1);assert.equal(done.result.total,8);
      assert.deepEqual((await defaultPort.exportData(a.id)).mock_runs.find(r=>r.id===run.id).result,done.result);
    } finally {process.env.B1PREP_CONTENT_MODE='internal-preview';}
  });
  console.log(`\n${passed} passed, 0 failed (real PostgreSQL, synthetic S3 fixtures; no content validity claim)`);
} finally {await world.teardown();}

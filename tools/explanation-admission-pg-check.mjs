#!/usr/bin/env node
/** Real API/consumer/export/deletion checks; synthetic local PostgreSQL and stub grading only. */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createFixture} from '../server/owned-postgres/bootstrap.mjs';
import {createPostgresWorld} from '../server/owned-postgres/fixture.mjs';
import {createPostgresDatastore} from '../server/owned-postgres/adapter.mjs';
import {createOwnedApi} from '../server/owned-api.mjs';
import {createWorker} from '../server/owned-postgres/worker.mjs';
import {importPackage} from '../server/owned-postgres/package-importer.mjs';
import {createExamCatalogue} from '../server/preparation-contract.mjs';
import {packageHash,objectiveItems} from '../server/package-contract.mjs';
import {extractObjectiveExplanationSource,explanationPayloadHash} from '../server/explanation-contract.mjs';
import {importObjectiveExplanations} from '../server/owned-postgres/explanation-importer.mjs';
import {publishCompleteDtzFixture,syntheticContentReview} from './exam-s6-fixture.mjs';

if(process.env.OWNAPI_PG_ALLOW!=='1'||process.env.OWNAPI_PG_HOST!=='127.0.0.1'
  ||!process.env.OWNAPI_PG_PORT||[4300,55440].includes(Number(process.env.OWNAPI_PG_PORT)))
  throw Error('Explicit local disposable PostgreSQL required');
const envKeys=['B1PREP_CONTENT_MODE','B1PREP_SERVE_REVIEW','B1PREP_SERVE_RIGHTS'];
const previous=Object.fromEntries(envKeys.map(key=>[key,process.env[key]]));
const DTZ='dtz-a2-b1',catalogue=createExamCatalogue({enabled:['telc-deutsch-b1',DTZ]});
const languages=['de','en','uk','ar','tr'];
let db,world,port,api,mediaRoot,passed=0,failed;
const check=async(name,fn)=>{await fn();passed++;console.log('PASS '+name);};
const reject=(promise,code)=>assert.rejects(promise,error=>error.code===code);
async function fingerprint(){
  const facts=await world.store.inspect.fingerprint(),explanations=[];
  for(const table of ['writing_explanation_representation','writing_explanation_head','objective_explanation_representation','objective_explanation_head']){
    const rows=(await db.admin.query(`SELECT to_jsonb(r) AS value FROM ${table} r ORDER BY to_jsonb(r)::text`)).rows;
    explanations.push([table,rows]);
  }
  return JSON.stringify({facts,explanations});
}
async function account(tag){
  const signup=await world.sessions.signUp({name:'Synthetic explanation '+tag,email:`explanation-${tag}-${randomUUID()}@example.invalid`,password:'synthetic-explanation-password'});
  const cookie=String(signup.setCookie).split(';')[0],id=(await world.sessions.getSession({cookie})).userId;
  return {id,cookie,prep:(await port.createPreparation(id,DTZ)).preparation};
}
async function get(owner,url){
  const response=await api.handle({method:'GET',path:url,headers:{cookie:owner.cookie},originChecked:true});
  return {status:response.status,data:JSON.parse(response.body)};
}
async function migration(fn){
  const client=await db.migration.connect();
  try{await client.query('BEGIN');const result=await fn(client);await client.query('COMMIT');return result;}
  catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
}
async function reviewContent(contentId,decision){
  const row=(await db.migration.query('SELECT exam_id,content_sha256 FROM content_version WHERE content_version_id=$1',[contentId])).rows[0];
  return migration(client=>syntheticContentReview(db,client,{kind:'content',examId:row.exam_id,subjectId:contentId,version:'',sha256:row.content_sha256},{decision,mediaRoot}));
}
try{
  process.env.B1PREP_CONTENT_MODE='internal-preview';delete process.env.B1PREP_SERVE_REVIEW;delete process.env.B1PREP_SERVE_RIGHTS;
  mediaRoot=await mkdtemp(path.join(tmpdir(),'hatoove-explanation-consumers-'));
  db=await createFixture();world=await createPostgresWorld({fixture:db,examCatalogue:catalogue});
  const fixture=await publishCompleteDtzFixture(db,{mediaRoot});
  const registry=fixture.internal.sets.flatMap(set=>objectiveItems(set.payload,set.interaction).map(item=>{
    const original=set.explanations?.[item.id]??set.explanations?._set_why?.[item.id]??null;
    return {exam_id:DTZ,set_id:set.setId,set_version:set.version,item_id:item.id,original_value_sha256:packageHash(original),language:'de'};
  }));
  port=createPostgresDatastore({pool:db.learner,examCatalogue:catalogue,mediaRoot,explanationLanguageRegistry:registry});
  api=createOwnedApi({datastore:port,sessions:world.sessions,settings:world.settings,accountDeletion:world.deletion});
  const a=await account('a'),b=await account('b');
  await db.admin.query('INSERT INTO entitlements(owner_id,exam_id,allowance,used,reserved) VALUES($1,$2,10,0,0)',[a.id,DTZ]);
  const task=fixture.internal.writingTasks[0];
  const attempt=await port.create(a.id,null,{taskId:task.taskId,taskVersion:task.version,rubricId:task.rubricId,rubricVersion:task.rubricVersion},a.prep.id);
  const saved=await port.save(a.id,attempt.id,1,'Guten Tag, dies ist ein synthetischer Text für einen lokalen Test. Vielen Dank und freundliche Grüße.');
  const receipt=await port.submit(a.id,attempt.id,saved.revision,randomUUID(),'de');
  const submissionId=receipt.submissionId;
  await check('pending GET is not_assessed and cannot grade, create a representation or debit',async()=>{
    const before=await fingerprint();
    const response=await get(a,`/api/v1/submissions/${submissionId}?explanationLanguage=ar`);
    assert.equal(response.status,200);assert.equal(response.data.explanation_view.state,'not_assessed');
    assert.equal(response.data.explanation_view.reason,'assessment_pending');
    assert.equal(await fingerprint(),before);
  });
  assert.equal((await createWorker({pool:db.worker,examCatalogue:catalogue}).runOnce()).outcome,'succeeded');
  const original=await port.result(a.id,submissionId);
  await check('all five API language reads preserve exact assessment, jobs, balances and every saved row',async()=>{
    const before=await fingerprint();
    for(const language of languages){
      const response=await get(a,`/api/v1/submissions/${submissionId}?explanationLanguage=${language}`);
      assert.equal(response.status,200);assert.deepEqual(response.data.assessment,original.assessment);
      assert.equal(response.data.explanation_view.displayed_language,language);
      assert.equal(response.data.explanation_view.representation.persisted,true);
      assert.equal(response.data.explanation_view.operation,null);
    }
    assert.equal(await fingerprint(),before);
    assert.equal((await get(b,`/api/v1/submissions/${submissionId}?explanationLanguage=en`)).status,404);
  });
  const set=fixture.internal.sets.find(row=>row.section==='LV');
  const item=objectiveItems(set.payload,set.interaction)[0];
  const options=item.options??Object.keys(set.payload.questions[0].options);
  const wrong=options.find(option=>option!==set.answers[item.id]);assert.ok(wrong,'synthetic item has a valid wrong answer');
  const evidence=await port.answerObjectiveItem(a.id,{preparationId:a.prep.id,setId:set.setId,version:set.version,itemId:item.id,answer:wrong});
  const originalValue=set.explanations?.[item.id]??set.explanations?._set_why?.[item.id];
  const source=extractObjectiveExplanationSource({examId:DTZ,setId:set.setId,setVersion:set.version,itemId:item.id,originalValue,originalLanguage:'de'});
  const make=(version,text)=>{
    const payload={schema:'explanation-text-v1',blocks:[{slot:'objective/comment',text}]};
    return {language:'en',version,source_sha256:source.sourceSha256,payload,payload_sha256:explanationPayloadHash(payload),
      provenance:{kind:'publisher-authored',source_sha256:source.sourceSha256,producer_version:'synthetic-consumer-v1'}};
  };
  const current=make('synthetic-v1','Exact selected synthetic explanation.'),unselected=make('synthetic-v2','UNSELECTED_EXPLANATION_MUST_NOT_LEAK');
  await migration(client=>importObjectiveExplanations(client,{items:[{examId:DTZ,setId:set.setId,setVersion:set.version,itemId:item.id,
    sourceSha256:source.sourceSha256,representations:[current,unselected],heads:[{language:'en',version:current.version,expectedVersion:null}]}]},{languageRegistry:registry}));
  await check('a valid wrong standalone answer authorizes its exact saved explanation; foreign evidence does not',async()=>{
    const before=await fingerprint();
    const response=await get(a,`/api/v1/objective-evidence/${evidence.evidence_id}/explanation?language=en`);
    assert.equal(response.status,200);assert.equal(response.data.state,'translated');
    assert.deepEqual(response.data.representation.payload,current.payload);
    assert.equal((await get(b,`/api/v1/objective-evidence/${evidence.evidence_id}/explanation?language=en`)).status,404);
    assert.equal(await fingerprint(),before);
  });
  const form=(await port.listMockForms(a.id,{preparationId:a.prep.id})).find(row=>row.scope==='full')??(await port.listMockForms(a.id,{preparationId:a.prep.id}))[0];
  assert.ok(form);
  const run=(await port.startMockRun(a.id,{preparationId:a.prep.id,formId:form.form_id,formVersion:form.version,releaseVersion:form.release_version,eventId:randomUUID()})).run;
  const finalised=await port.finaliseMockRun(a.id,run.id,{expectedRevision:run.revision,eventId:randomUUID()});
  assert.ok(finalised.result.items.length);
  const storedRun=(await db.admin.query('SELECT result FROM mock_run WHERE id=$1',[run.id])).rows[0].result;
  await check('finalised unanswered mock language GET is readonly and keeps every grading fact',async()=>{
    assert.equal((await db.admin.query('SELECT 1 FROM item_evidence WHERE mock_run_id=$1',[run.id])).rowCount,0);
    const before=await fingerprint();
    for(const language of languages){
      const response=await get(a,`/api/v1/mock-runs/${run.id}?explanationLanguage=${language}`);
      assert.equal(response.status,200);
      const projected=structuredClone(response.data.result);for(const row of projected.items)delete row.explanation_view;
      assert.deepEqual(projected,storedRun);
      assert.ok(response.data.result.items.every(row=>row.explanation_view.operation===null));
    }
    assert.equal(await fingerprint(),before);
    assert.deepEqual((await db.admin.query('SELECT result FROM mock_run WHERE id=$1',[run.id])).rows[0].result,storedRun);
  });
  await check('export includes every owned representation/head and only authorized selected shared variants',async()=>{
    const before=await fingerprint(),exported=await port.exportData(a.id);
    assert.equal(exported.writing_explanation_representations.length,5);assert.equal(exported.writing_explanation_heads.length,5);
    assert.ok(exported.shared_explanation_representations.some(row=>row.context.evidence_id===evidence.evidence_id&&row.language==='en'));
    assert.ok(exported.shared_explanation_representations.some(row=>row.context.run_id===run.id));
    assert.ok(!JSON.stringify(exported).includes('UNSELECTED_EXPLANATION_MUST_NOT_LEAK'));
    assert.equal((await port.exportData(b.id)).writing_explanation_representations.length,0);
    assert.equal((await port.exportData(b.id)).shared_explanation_representations.length,0);
    assert.equal(await fingerprint(),before);
  });
  await check('internal-only historical evidence is withheld in public mode while older public history survives an incomplete new head',async()=>{
    const internalSet={...structuredClone(set),setId:'explanation.internal.only',version:'v9700'};
    const internalForm={id:'explanation.internal.reading',version:'v9700',title:'Synthetic internal only',scope:'section',sections:['LV'],mode:'untimed',timeLimitSeconds:null,feedback:'finalise',
      members:fixture.internal.forms[0].members.filter(member=>fixture.internal.sets.some(candidate=>candidate.setId===member.setId&&candidate.section==='LV'))
        .map(member=>member.setId===set.setId?{...structuredClone(member),setId:internalSet.setId,version:internalSet.version}:structuredClone(member))};
    await importPackage(db.migration,{...structuredClone(fixture.internal),sets:[internalSet],media:[],writingTasks:[],rubrics:[],forms:[internalForm],
      release:{version:'v9700',state:'internal',resumeBlockedReleases:[]}},{mediaRoot});
    await reviewContent(internalSet.setId+'@'+internalSet.version,'approve');
    const internalEvidence=await port.answerObjectiveItem(a.id,{preparationId:a.prep.id,setId:internalSet.setId,version:internalSet.version,itemId:item.id,answer:wrong});
    assert.ok((await port.readObjectiveEvidenceExplanation(a.id,internalEvidence.evidence_id)).representation);
    try{
      process.env.B1PREP_CONTENT_MODE='public';
      const response=await get(a,`/api/v1/objective-evidence/${internalEvidence.evidence_id}/explanation?language=en`);
      assert.equal(response.status,200);assert.equal(response.data.state,'blocked');assert.equal(response.data.representation,null);
      assert.equal((await port.readObjectiveEvidenceExplanation(a.id,evidence.evidence_id,{language:'en'})).state,'translated');
      assert.equal((await port.readMockRun(a.id,run.id)).result.total,storedRun.total);
      const exported=await port.exportData(a.id);
      assert.ok(exported.shared_explanation_representations.some(row=>row.context.evidence_id===internalEvidence.evidence_id&&row.representation===null));
      assert.ok(exported.shared_explanation_representations.some(row=>row.context.evidence_id===evidence.evidence_id&&row.language==='en'));
    }finally{
      process.env.B1PREP_CONTENT_MODE='internal-preview';
      await migration(async client=>{await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,7351))',[DTZ]);
        await client.query('UPDATE exam_release_head SET release_version=$2 WHERE exam_id=$1',[DTZ,fixture.releaseVersion]);});
    }
  });
  await port.updatePreparation(a.id,a.prep.id,a.prep.revision,{state:'archived'});
  await reviewContent(set.setId+'@'+set.version,'withdraw');
  await reviewContent(task.taskId+'@'+task.version,'withdraw');
  await check('archival and later review withdrawal preserve completed original facts and explanation reads',async()=>{
    const result=await port.result(a.id,submissionId,{explanationLanguage:'uk'});
    assert.deepEqual(result.assessment,original.assessment);assert.equal(result.review_withdrawn,true);
    assert.equal(result.explanation_view.displayed_language,'uk');
    assert.equal((await port.readObjectiveEvidenceExplanation(a.id,evidence.evidence_id,{language:'en'})).state,'translated');
    const read=await port.readMockRun(a.id,run.id,{explanationLanguage:'en'});assert.equal(read.review_withdrawn,true);
    assert.equal(read.result.total,storedRun.total);
  });
  await check('historical tombstoned attempts retain their owned saved prose in account export',async()=>{
    // Current API forbids deleting a submitted attempt. Model only an older saved tombstone in this disposable fixture.
    await reviewContent(task.taskId+'@'+task.version,'approve');
    await reject(port.remove(a.id,attempt.id),'submitted_attempt');
    await db.admin.query('UPDATE attempts SET deleted_at=now() WHERE id=$1 AND owner_id=$2',[attempt.id,a.id]);
    await reject(port.result(a.id,submissionId),'not_found');
    const exported=await port.exportData(a.id);
    assert.equal(exported.writing_explanation_representations.length,5);
    assert.ok(exported.submissions.find(row=>row.id===submissionId).attempt_deleted_at);
  });
  await migration(client=>client.query("INSERT INTO content_rights(content_version_id,basis,decided_by,note) VALUES($1,'unknown','synthetic test','Disposable explanation rights refusal')",[set.setId+'@'+set.version]));
  await check('rights refusal blocks prose and its SQL exception cannot poison the rest of an export',async()=>{
    const response=await get(a,`/api/v1/objective-evidence/${evidence.evidence_id}/explanation?language=en`);
    assert.equal(response.status,200);assert.equal(response.data.state,'blocked');assert.equal(response.data.representation,null);
    const before=await fingerprint(),exported=await port.exportData(a.id);
    assert.ok(exported.shared_explanation_representations.some(row=>row.context.evidence_id===evidence.evidence_id&&row.representation===null));
    const refused=exported.mock_runs.find(row=>row.id===run.id);
    assert.equal(refused.result,null);assert.equal(refused.blocked_reason,'rights_blocked');
    assert.equal(exported.shared_explanation_representations.filter(row=>row.context.run_id===run.id&&row.representation===null).length,storedRun.items.length);
    assert.equal(exported.writing_explanation_representations.length,5);
    assert.ok(Array.isArray(exported.payment_orders),'queries after refused SQL complete');
    assert.equal(await fingerprint(),before);
  });
  await check('account deletion removes personal prose/heads and preserves the shared publisher records',async()=>{
    const shared=(await db.admin.query('SELECT * FROM objective_explanation_representation ORDER BY representation_version')).rows;
    const outcome=await world.deletion.deleteAccount(a.id);assert.equal(outcome.verifiedAbsent,true);
    assert.equal(outcome.removed.writing_explanation_representation,5);assert.equal(outcome.removed.writing_explanation_head,5);
    for(const table of ['writing_explanation_representation','writing_explanation_head'])
      assert.equal((await db.admin.query(`SELECT 1 FROM ${table} WHERE owner_id=$1`,[a.id])).rowCount,0);
    assert.deepEqual((await db.admin.query('SELECT * FROM objective_explanation_representation ORDER BY representation_version')).rows,shared);
  });
}catch(error){failed=error;}
finally{
  for(const key of envKeys)if(previous[key]===undefined)delete process.env[key];else process.env[key]=previous[key];
  try{if(db)await db.cleanup();}catch(error){failed??=error;}
  if(db){
    const verifier=new db.admin.constructor({...db.config,max:1});
    try{
      const row=(await verifier.query(`SELECT EXISTS(SELECT 1 FROM pg_namespace WHERE nspname=$1) AS schema_exists,
        EXISTS(SELECT 1 FROM pg_roles WHERE rolname=ANY($2::text[])) AS roles_exist`,[db.schema,Object.values(db.roles)])).rows[0];
      assert.deepEqual(row,{schema_exists:false,roles_exist:false});
    }catch(error){failed??=error;}finally{try{await verifier.end();}catch(error){failed??=error;}}
  }
  try{if(mediaRoot){const resolved=path.resolve(mediaRoot);assert.equal(path.dirname(resolved),path.resolve(tmpdir()));
    assert.ok(path.basename(resolved).startsWith('hatoove-explanation-consumers-'));await rm(resolved,{recursive:true,force:true});}}
  catch(error){failed??=error;}
}
if(failed)throw failed;
console.log(`Saved explanation consumers: ${passed} checks passed; disposable schema and roles removed`);

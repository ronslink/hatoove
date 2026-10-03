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
import {registerExplanationReviewTarget,readExplanationReviewPacket} from '../server/owned-postgres/explanation-review.mjs';
import {recordReviewerAuthority,recordContentReview} from '../server/owned-postgres/content-review.mjs';
import {publishCompleteDtzFixture,syntheticContentReview} from './exam-s6-fixture.mjs';

const localTarget=process.env.OWNAPI_PG_PORT==='62563'&&process.env.OWNAPI_PG_DATABASE==='hatoove_spike';
const ciTarget=process.env.CI==='true'&&process.env.GITHUB_ACTIONS==='true'&&process.env.OWNAPI_PG_PORT==='5432'&&process.env.OWNAPI_PG_DATABASE==='hatoove_ci';
if(process.env.OWNAPI_PG_ALLOW!=='1'||process.env.OWNAPI_PG_HOST!=='127.0.0.1'||!(localTarget||ciTarget))
  throw Error('Explicit local disposable PostgreSQL required');
const envKeys=['B1PREP_CONTENT_MODE','B1PREP_SERVE_REVIEW','B1PREP_SERVE_RIGHTS'];
const previous=Object.fromEntries(envKeys.map(key=>[key,process.env[key]]));
const DTZ='dtz-a2-b1',catalogue=createExamCatalogue({enabled:['telc-deutsch-b1',DTZ]});
const languages=['de','en','uk','ar','tr'];
const writingRepresentationFields=Object.freeze(['submission_id','source_sha256','language','representation_version',
  'attempt_id','exam_id','task_id','task_version','rubric_id','rubric_version','model_version','prompt_version',
  'original_language','original_format','payload','payload_sha256','provenance','created_at']);
const writingHeadFields=Object.freeze(['submission_id','source_sha256','language','representation_version']);
function assertWritingExportFields(exported,{blocked=false}={}){
  assert.ok(exported.writing_explanation_representations.length>0,'representation field checks require actual owned rows');
  assert.ok(exported.writing_explanation_heads.length>0,'head field checks require actual owned rows');
  const expected=blocked?[...writingRepresentationFields,'blocked_reason']:writingRepresentationFields;
  for(const row of exported.writing_explanation_representations)
    assert.deepEqual(Object.keys(row).sort(),[...expected].sort(),'exact representation export fields exclude private owner identity');
  for(const row of exported.writing_explanation_heads)
    assert.deepEqual(Object.keys(row).sort(),[...writingHeadFields].sort(),'exact head export fields exclude private owner identity');
}
const withoutOwner=({owner_id,...row})=>row;
let db,world,port,api,mediaRoot,passed=0,failed;
const check=async(name,fn)=>{await fn();passed++;console.log('PASS '+name);};
const reject=(promise,code)=>assert.rejects(promise,error=>error.code===code);
async function fingerprint(){
  const facts=await world.store.inspect.fingerprint(),explanations=[];
  for(const table of ['writing_explanation_representation','writing_explanation_head','objective_explanation_representation','objective_explanation_head',
    'provider_attempt','provider_attempt_observation','explanation_review_target','content_review_authority','content_review_decision']){
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
async function explanationDecision(target,category,language,decision){
  return migration(async client=>{
    const actual=(await client.query('SELECT current_schema() AS schema,current_user AS role')).rows[0];
    assert.match(db.schema,/^ownapi_[a-f0-9]{16}$/);assert.deepEqual(actual,{schema:db.schema,role:db.roles.migration});
    const reviewerId='synthetic.c06.consumer.'+category+'.'+(language||'none');
    const evidence={evidenceRef:'fixture://c06/consumer/no-human-approval',evidenceSha256:'c'.repeat(64),rationale:'Synthetic disposable consumer acceptance; no real appointment or content approval'};
    const priorAuthority=(await client.query('SELECT authority_id,action FROM content_review_authority WHERE reviewer_id=$1 AND exam_id=$2 AND category=$3 AND language=$4 ORDER BY revision DESC LIMIT 1',[reviewerId,DTZ,category,language])).rows[0];
    const authority=priorAuthority?.action==='grant'?{authorityId:priorAuthority.authority_id}:await recordReviewerAuthority(client,{...evidence,eventId:randomUUID(),reviewerId,
      reviewerName:'Synthetic consumer fixture reviewer',examId:DTZ,category,language,action:'grant',expectedAuthorityId:priorAuthority?.authority_id??null});
    const s=target.subject,previous=(await client.query('SELECT decision_id FROM content_review_decision WHERE exam_id=$1 AND subject_kind=$2 AND subject_id=$3 AND subject_version=$4 AND subject_sha256=$5 AND category=$6 AND language=$7 ORDER BY revision DESC LIMIT 1',
      [s.examId,s.kind,s.subjectId,s.version,s.sha256,category,language])).rows[0];
    const packetSha256=decision==='approve'?(await readExplanationReviewPacket(client,s)).packetSha256:null;
    return recordContentReview(client,{...evidence,eventId:randomUUID(),subject:s,category,language,authorityId:authority.authorityId,expectedDecisionId:previous?.decision_id??null,decision,packetSha256});
  });
}
try{
  process.env.B1PREP_CONTENT_MODE='internal-preview';delete process.env.B1PREP_SERVE_REVIEW;delete process.env.B1PREP_SERVE_RIGHTS;
  mediaRoot=await mkdtemp(path.join(tmpdir(),'hatoove-explanation-consumers-'));
  db=await createFixture();
  console.log('Saved explanation consumer fixture: '+db.schema);
  world=await createPostgresWorld({fixture:db,examCatalogue:catalogue});
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
    assertWritingExportFields(exported);
    const storedRepresentations=(await db.admin.query('SELECT * FROM writing_explanation_representation WHERE owner_id=$1 ORDER BY submission_id,source_sha256,language,representation_version',[a.id])).rows;
    const storedHeads=(await db.admin.query('SELECT * FROM writing_explanation_head WHERE owner_id=$1 ORDER BY submission_id,source_sha256,language',[a.id])).rows;
    assert.ok(storedRepresentations.every(row=>row.owner_id===a.id&&row.submission_id===submissionId&&row.attempt_id===attempt.id));
    assert.ok(storedHeads.every(row=>row.owner_id===a.id&&row.submission_id===submissionId));
    assert.deepEqual(exported.writing_explanation_representations,storedRepresentations.map(withoutOwner),'every saved non-owner value and original provenance survives export');
    assert.deepEqual(exported.writing_explanation_heads,storedHeads.map(withoutOwner),'head linkage remains exact');
    assert.ok(exported.shared_explanation_representations.some(row=>row.context.evidence_id===evidence.evidence_id&&row.language==='en'));
    assert.ok(exported.shared_explanation_representations.some(row=>row.context.run_id===run.id));
    assert.ok(!JSON.stringify(exported).includes('UNSELECTED_EXPLANATION_MUST_NOT_LEAK'));
    assert.equal((await port.exportData(b.id)).writing_explanation_representations.length,0);
    assert.equal((await port.exportData(b.id)).writing_explanation_heads.length,0);
    assert.equal((await port.exportData(b.id)).shared_explanation_representations.length,0);
    assert.equal(await fingerprint(),before);
  });
  const register=async(s,targetKind,representation)=>migration(client=>registerExplanationReviewTarget(client,{scope:'objective',targetKind,sourceIdentity:s.identity,
    sourceSha256:s.sourceSha256,language:representation.language,representationVersion:representation.version,payloadSha256:representation.payload_sha256},{languageRegistry:registry}));
  const virtual=s=>({language:s.originalLanguage,version:'legacy-projection-v1',payload_sha256:explanationPayloadHash(s.originalPayload)});
  const translatedTarget=await register(source,'stored',current),originalTarget=await register(source,'original',virtual(source));
  const mockView=async(store=port,itemId=item.id)=>{
    const read=await store.readMockRun(a.id,run.id,{explanationLanguage:'en'});
    const exact=read.result.items.find(row=>row.set_id===set.setId&&row.version===set.version&&row.item_id===itemId);assert.ok(exact);
    return exact.explanation_view;
  };
  await check('educational and native decisions are independent exact dimensions on both protected reader origins',async()=>{
    await explanationDecision(translatedTarget,'educational','','approve');
    let view=await port.readObjectiveEvidenceExplanation(a.id,evidence.evidence_id,{language:'en'});
    assert.equal(view.review.educational.review_status,'approved');assert.equal(view.review.native_language.review_status,'unreviewed');
    await explanationDecision(translatedTarget,'language','en','approve');
    const before=await fingerprint();
    for(const view of [await port.readObjectiveEvidenceExplanation(a.id,evidence.evidence_id,{language:'en'}),await mockView()]){
      assert.equal(view.state,'translated');assert.equal(view.review.educational.review_status,'approved');assert.equal(view.review.native_language.review_status,'approved');
      for(const key of ['decision_ids','reviewer','packet','targetKind','reviewSourceBinding','sourceOrigin'])assert.equal(JSON.stringify(view).includes(key),false);
    }
    assert.equal(await fingerprint(),before);
  });
  await explanationDecision(originalTarget,'educational','','approve');await explanationDecision(originalTarget,'language','de','approve');
  await explanationDecision(translatedTarget,'language','en','withdraw');
  await check('actual translation withdrawal falls back to separately approved original and every export selector survives',async()=>{
    const before=await fingerprint();
    for(const view of [await port.readObjectiveEvidenceExplanation(a.id,evidence.evidence_id,{language:'en'}),await mockView()]){
      assert.equal(view.state,'fallback');assert.equal(view.requested_status,'blocked');assert.equal(view.reason,'representation_withdrawn');
      assert.equal(view.displayed_language,'de');assert.equal(view.representation.persisted,false);assert.equal(view.review.native_language.review_status,'approved');
    }
    const rows=(await port.exportData(a.id)).shared_explanation_representations.filter(row=>row.context.evidence_id===evidence.evidence_id);
    assert.equal(rows.length,1);assert.deepEqual(rows[0].selections.map(s=>s.selection_language),[null,...languages]);
    assert.deepEqual(rows[0].selections.find(s=>s.selection_language==='en'),{selection_language:'en',state:'fallback',requested_status:'blocked',reason:'representation_withdrawn',displayed_language:'de'});
    assert.equal(await fingerprint(),before);
  });
  await explanationDecision(originalTarget,'educational','','reject');
  await check('both exact targets blocked remove selected prose while saved facts and per-selector export refusals survive',async()=>{
    const before=await fingerprint();
    for(const view of [await port.readObjectiveEvidenceExplanation(a.id,evidence.evidence_id,{language:'en'}),await mockView()]){assert.equal(view.state,'blocked');assert.equal(view.representation,null);}
    const rows=(await port.exportData(a.id)).shared_explanation_representations.filter(row=>row.context.evidence_id===evidence.evidence_id);
    assert.equal(rows.length,6);assert.deepEqual(rows.map(row=>row.selections[0].selection_language),[null,...languages]);
    assert(rows.every(row=>row.language===null&&row.representation===null&&row.selections.length===1));
    assert.equal(JSON.stringify(rows).includes(originalValue),false);assert.equal(await fingerprint(),before);
    assert.deepEqual((await db.admin.query('SELECT result FROM mock_run WHERE id=$1',[run.id])).rows[0].result,storedRun);
  });
  await check('registered head-free source cannot evade withdrawal through trusted registry loss in either origin',async()=>{
    const probe=objectiveItems(set.payload,set.interaction).find(row=>row.id!==item.id);assert.ok(probe);
    const probeOriginal=set.explanations?.[probe.id]??set.explanations?._set_why?.[probe.id];
    const probeSource=extractObjectiveExplanationSource({examId:DTZ,setId:set.setId,setVersion:set.version,itemId:probe.id,originalValue:probeOriginal,originalLanguage:'de'});
    const probeEvidence=await port.answerObjectiveItem(a.id,{preparationId:a.prep.id,setId:set.setId,version:set.version,itemId:probe.id,answer:set.answers[probe.id]});
    const target=await register(probeSource,'original',virtual(probeSource));await explanationDecision(target,'educational','','withdraw');
    assert.equal((await db.admin.query('SELECT 1 FROM objective_explanation_head WHERE set_id=$1 AND set_version=$2 AND item_id=$3',[set.setId,set.version,probe.id])).rowCount,0,'no incompatible head may mask a broken binding classifier');
    const lostRegistry=createPostgresDatastore({pool:db.learner,examCatalogue:catalogue,mediaRoot,explanationLanguageRegistry:[]});
    const before=await fingerprint();
    for(const view of [await lostRegistry.readObjectiveEvidenceExplanation(a.id,probeEvidence.evidence_id,{language:'en'}),await mockView(lostRegistry,probe.id)]){
      assert.equal(view.state,'blocked');assert.equal(view.representation,null);assert.equal(view.original_language,null);assert.equal(view.review.educational.review_status,'unavailable');
    }
    const restored=await port.readObjectiveEvidenceExplanation(a.id,probeEvidence.evidence_id,{language:'en'});
    assert.equal(restored.reason,'representation_withdrawn');assert.equal(restored.representation,null);assert.equal(await fingerprint(),before);
  });
  const storedOriginal={language:'de',version:'legacy-projection-v1',source_sha256:source.sourceSha256,payload:structuredClone(source.originalPayload),payload_sha256:explanationPayloadHash(source.originalPayload),
    provenance:{kind:'publisher-authored',source_sha256:source.sourceSha256,producer_version:'synthetic-consumer-v1'}};
  await migration(client=>importObjectiveExplanations(client,{items:[{examId:DTZ,setId:set.setId,setVersion:set.version,itemId:item.id,sourceSha256:source.sourceSha256,
    representations:[storedOriginal],heads:[{language:'de',version:storedOriginal.version,expectedVersion:null}]}]},{languageRegistry:registry}));
  const storedOriginalTarget=await register(source,'stored',storedOriginal);
  await explanationDecision(storedOriginalTarget,'educational','','approve');await explanationDecision(storedOriginalTarget,'language','de','approve');
  await check('stored legacy-projection-v1 approval is distinct from the identically hashed rejected virtual original',async()=>{
    const before=await fingerprint(),view=await port.readObjectiveEvidenceExplanation(a.id,evidence.evidence_id,{language:'en'});
    assert.equal(view.state,'fallback');assert.equal(view.representation.persisted,true);assert.equal(view.review.educational.review_status,'approved');assert.equal(await fingerprint(),before);
  });
  await explanationDecision(originalTarget,'educational','','approve');await explanationDecision(storedOriginalTarget,'educational','','withdraw');
  await check('withdrawn stored original never falls through to an approved virtual artifact with the same tuple',async()=>{
    const before=await fingerprint(),view=await port.readObjectiveEvidenceExplanation(a.id,evidence.evidence_id,{language:'en'});
    assert.equal(view.state,'blocked');assert.equal(view.representation,null);assert.equal(view.reason,'representation_withdrawn');assert.equal(await fingerprint(),before);
  });
  await explanationDecision(storedOriginalTarget,'educational','','approve');await explanationDecision(translatedTarget,'language','en','approve');
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
  await migration(client=>client.query("INSERT INTO content_rights(content_version_id,basis,decided_by,note) VALUES($1,'unknown','synthetic test','Disposable writing explanation rights refusal')",[task.taskId+'@'+task.version]));
  await check('writing rights refusal keeps exact safe export identities while withholding protected explanation prose',async()=>{
    const before=await fingerprint(),exported=await port.exportData(a.id);
    assert.equal(exported.writing_explanation_representations.length,5);assert.equal(exported.writing_explanation_heads.length,5);
    assertWritingExportFields(exported,{blocked:true});
    const storedRepresentations=(await db.admin.query('SELECT * FROM writing_explanation_representation WHERE owner_id=$1 ORDER BY submission_id,source_sha256,language,representation_version',[a.id])).rows;
    const storedHeads=(await db.admin.query('SELECT * FROM writing_explanation_head WHERE owner_id=$1 ORDER BY submission_id,source_sha256,language',[a.id])).rows;
    assert.ok(storedRepresentations.every(row=>row.owner_id===a.id&&row.payload?.blocks?.length>0),'rights withholding must not erase stored prose');
    assert.deepEqual(exported.writing_explanation_representations,storedRepresentations.map(row=>({...withoutOwner(row),payload:null,blocked_reason:'rights_blocked'})));
    assert.deepEqual(exported.writing_explanation_heads,storedHeads.map(withoutOwner));
    assert.equal(exported.results.find(row=>row.submission_id===submissionId).feedback,null);
    assert.equal((await port.exportData(b.id)).writing_explanation_representations.length,0);
    assert.equal((await port.exportData(b.id)).writing_explanation_heads.length,0);
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
        EXISTS(SELECT 1 FROM pg_roles WHERE rolname=ANY($2::text[])) AS roles_exist,
        EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name=$1 OR usename=ANY($2::text[])) AS connections_exist`,[db.schema,Object.values(db.roles)])).rows[0];
      assert.deepEqual(row,{schema_exists:false,roles_exist:false,connections_exist:false});
    }catch(error){failed??=error;}finally{try{await verifier.end();}catch(error){failed??=error;}}
  }
  try{if(mediaRoot){const resolved=path.resolve(mediaRoot);assert.equal(path.dirname(resolved),path.resolve(tmpdir()));
    assert.ok(path.basename(resolved).startsWith('hatoove-explanation-consumers-'));await rm(resolved,{recursive:true,force:true});}}
  catch(error){failed??=error;}
}
if(failed)throw failed;
console.log(`Saved explanation consumers: ${passed} checks passed; disposable schema and roles removed`);

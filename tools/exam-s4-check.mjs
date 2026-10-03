#!/usr/bin/env node
/** Synthetic S4 discrimination fixtures, never educational content or live assessment. */
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { syntheticPackage } from './exam-s3-check.mjs';
import { validatePackage } from '../server/package-contract.mjs';
import { validateWritingChoice, validateFinaliseMockRun } from '../server/mock-contract.mjs';
import { DTZ_BANDS, DTZ_KEYS, DTZ_POLICY, DTZ_KIND, DTZ_INSTRUCTIONS } from '../server/writing-policy.mjs';
import { stubGrade, validateAssessment } from '../server/owned-postgres/worker.mjs';
export function syntheticS4Package({release='v8100',version='v1',state='internal',blocked=[]}={}) {
 const p=syntheticPackage();p.blueprint.version='v8100';p.release={version:release,state,resumeBlockedReleases:blocked};
 p.blueprint.sections.push({id:'SA',title:'Synthetic writing',parts:[{family:'writing',itemCount:1,interaction:'writing_choice',mediaRequired:false}]});
 p.rubrics=[{rubricId:'s4.synthetic.rubric',version,examId:p.exam.id,family:'writing',policy:DTZ_POLICY,feedbackKind:DTZ_KIND,
   criteria:DTZ_KEYS.map(key=>({key,label:key,bands:{...DTZ_BANDS},bandLabels:Object.fromEntries(Object.keys(DTZ_BANDS).map(k=>[k,k])),
     descriptors:Object.fromEntries(Object.keys(DTZ_BANDS).map(k=>[k,`Synthetic ${key} ${k} descriptor ${version}.`]))})),
   reviewStatus:'unreviewed',rightsStatus:'generated',source:'synthetic:exam-s4-check'}];
 p.writingTasks=['A','B'].map(id=>({taskId:'s4.synthetic.'+id.toLowerCase(),version,examId:p.exam.id,family:'writing',section:'SA',
   register:id==='A'?'Sie':'du',topic:'Synthetic option '+id,situation:`Synthetic ${id} prompt ${version}.`,adressat:'Synthetic recipient '+id,
   leitpunkte:['One','Two','Three','Four'],rubricId:p.rubrics[0].rubricId,rubricVersion:version,reviewStatus:'unreviewed',rightsStatus:'generated',source:'synthetic:exam-s4-check'}));
 const choice={id:'SA1',section:'SA',options:p.writingTasks.map((t,i)=>({id:i?'B':'A',taskId:t.taskId,taskVersion:t.version}))};
 p.forms=[{...p.forms[0],id:'s4-combined',version,sections:['LV','SA'],writingChoices:[choice]},
   {...p.forms[0],id:'s4-writing',version,sections:['SA'],members:[],writingChoices:[choice]}];
 return p;
}
export function runS4OfflineChecks() {
 let passed=0;const check=(name,fn)=>{fn();passed++;console.log('PASS '+name);};
 const bad=fn=>{const p=syntheticS4Package();fn(p);assert.throws(()=>validatePackage(p),e=>e.code==='invalid_package');};
 check('legacy package canonical input has no new optional fields injected',()=>{const p=syntheticPackage();assert.deepEqual(validatePackage(p),p);});
 check('distinct DTZ policy has four criteria with six source scale positions',()=>{
   const p=validatePackage(syntheticS4Package());assert.equal(p.forms[1].members.length,0);
   assert.deepEqual(p.rubrics[0].criteria.map(c=>c.key),DTZ_KEYS);
   assert.ok(p.rubrics[0].criteria.every(c=>Object.keys(c.bands).length===6));
 });
 check('package rejects telc relabelling, approval claims, invalid policy and choice identities',()=>{
   for(const f of [p=>p.rubrics[0].criteria[0].bands={A:5,B:3,C:1,D:0},p=>p.rubrics[0].criteria[0].key='aufgabe',
     p=>p.rubrics[0].policy='execute-code',p=>p.rubrics[0].examId='telc-deutsch-b1',p=>p.writingTasks[0].examId='telc-deutsch-b1',
     p=>p.rubrics[0].reviewStatus='approved',p=>p.writingTasks[0].reviewStatus='approved',p=>p.writingTasks[0].leitpunkte=[],
     p=>p.forms[0].writingChoices[0].options[1].id='A',p=>p.forms[0].writingChoices.push(p.forms[0].writingChoices[0]),
     p=>p.release.state='available']) bad(f);
 });
 check('transport accepts exact writing finalisation but rejects malformed and extra fields',()=>{
   const eventId='00000000-0000-4000-8000-000000000001';
   assert.equal(validateWritingChoice({expectedRevision:1,eventId,choiceGroupId:'SA1',optionId:'B'}).optionId,'B');
   assert.equal(validateFinaliseMockRun({expectedRevision:2,eventId,expectedWritingRevision:3,explanationLanguage:'ar'}).expectedWritingRevision,3);
   for(const patch of [{expectedWritingRevision:0},{explanationLanguage:'xx'},{ownerId:'other'}]) assert.throws(()=>validateFinaliseMockRun({expectedRevision:2,eventId,...patch}));
 });
 check('DTZ simulation is explicit and never infers bands from length or address',()=>{
   const r=syntheticS4Package().rubrics[0],rubric={...r,feedback_kind:r.feedbackKind};
   const a=stubGrade({text:'Hallo.',rubric,policy:DTZ_POLICY}),b=stubGrade({text:'X'.repeat(200),rubric,policy:DTZ_POLICY});
   assert.deepEqual(a.feedback.criteria.map(c=>c.band),b.feedback.criteria.map(c=>c.band));
   assert.equal(a.modelVersion,'dtz-simulation-v1');assert.match(a.feedback.criteria[0].comment,/Simulation/);
   validateAssessment(a,{rubric,text:'Hallo.'});assert.match(DTZ_INSTRUCTIONS,/ZERO in all four/);
   assert.throws(()=>validateAssessment({...a,feedback:{...a.feedback,total:20}},{rubric,text:'Hallo.'}));
 });
 check('per-criterion unequal synthetic scales discriminate rather than reusing first criterion',()=>{
   const rubric={feedback_kind:DTZ_KIND,criteria:[{key:'one',bands:{HIGH:1,LOW:0}},{key:'two',bands:{YES:9,MAYBE:4,NO:0}}]};
   const a={feedback:{kind:DTZ_KIND,criteria:[{key:'one',band:'HIGH',evidence:'Text',comment:'Synthetic'},{key:'two',band:'MAYBE',evidence:'Text',comment:'Synthetic'}],corrections:[]}};
   validateAssessment(a,{rubric,text:'Text'});a.feedback.criteria[1].band='HIGH';assert.throws(()=>validateAssessment(a,{rubric,text:'Text'}));
 });
 console.log(`\n${passed} passed, 0 failed (synthetic offline S4 contracts)`);
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)runS4OfflineChecks();

#!/usr/bin/env node
/** Source-only complete target format checks using disposable technical PCM fixtures. */
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { validatePackage, validateCompleteForm, validateCompleteMembers, packageHash } from '../server/package-contract.mjs';
import { createCompleteFixture } from './exam-s5b-fixture.mjs';

const root=await mkdtemp(path.join(os.tmpdir(),'hatoove-s5b-package-'));
const clone=x=>structuredClone(x),bad=p=>assert.throws(()=>validatePackage(p),e=>e.code==='invalid_package');
let passed=0;
const check=async(name,run)=>{await run();passed++;console.log('PASS '+name);};
try {
  const telc=await createCompleteFixture({mediaRoot:root}),dtz=await createCompleteFixture({examId:'dtz-a2-b1',mediaRoot:root});
  await check('old telc, DTZ reading/writing and independent exam hashes remain exact',async()=>{
    for(const file of ['content/exams/telc-deutsch-b1/manifest.json','content/exams/dtz-a2-b1/manifest.json','content/exams/dtz-a2-b1/writing-manifest.json','content/fixtures/exams/english-scale.json']) {
      const p=JSON.parse(await readFile(new URL('../'+file,import.meta.url),'utf8'));assert.deepEqual(validatePackage(p),p);assert.equal(packageHash(validatePackage(p)),packageHash(p));
    }
  });
  await check('complete telc60 and DTZ45 exact orders and full durations validate without mutation',()=>{
    for(const [p,count,seconds] of [[telc,60,9000],[dtz,45,6000]]) {
      assert.deepEqual(validatePackage(p),p);assert.equal(p.forms[0].members.reduce((n,m)=>n+m.itemCount,0),count);
      assert.equal(validateCompleteForm(p.exam,p.blueprint,p.forms[0]).reduce((n,g)=>n+g.seconds,0),seconds);
    }
  });
  await check('fixed schedule rejects shortcuts, extra fields, missing or reordered groups',()=>{
    for(const source of [telc,dtz]) for(const mutate of [
      p=>p.forms[0].timeLimitSeconds--,p=>p.forms[0].mode='untimed',p=>p.forms[0].attemptMode='practice',p=>delete p.forms[0].timingPolicy,
      p=>p.forms[0].timingPolicy='optional',p=>p.blueprint.timeGroups[0].seconds=1,p=>p.blueprint.timeGroups[0].seconds=1.5,
      p=>p.blueprint.timeGroups.reverse(),p=>p.blueprint.timeGroups.pop(),p=>p.blueprint.timeGroups.push(clone(p.blueprint.timeGroups[0])),
      p=>p.blueprint.timeGroups[0].skippable=true,p=>p.blueprint.timeGroups[0].sections.reverse(),
      p=>p.blueprint.sections[0].timeGroup='missing',p=>p.blueprint.timeGroups[0].sections.push(p.blueprint.timeGroups[1].sections[0])
    ]) {const p=clone(source);mutate(p);if(JSON.stringify(p)!==JSON.stringify(source))bad(p);}
  });
  await check('section and target part order, interactions, media and exact counts cannot be redefined',()=>{
    for(const source of [telc,dtz]) for(const mutate of [
      p=>p.forms[0].sections.reverse(),p=>p.blueprint.sections.reverse(),p=>p.forms[0].members.reverse(),p=>p.forms[0].members.pop(),
      p=>p.blueprint.sections[0].parts.reverse(),p=>p.blueprint.sections[0].parts[0].family='other',
      p=>p.blueprint.sections[0].parts[0].itemCount--,p=>p.blueprint.sections[0].parts[0].interaction='single_choice',
      p=>p.blueprint.sections.find(s=>s.id==='HV').parts[0].mediaRequired=false,p=>p.blueprint.sections.find(s=>s.id==='HV').parts[0].playback.mock=9,
      p=>p.exam.id='independent-exam',p=>p.exam.language='en'
    ]) {const p=clone(source);mutate(p);if(JSON.stringify(p)!==JSON.stringify(source))bad(p);}
  });
  await check('matching-sized resolved families cannot swap even in reference-only full forms',()=>{
    const p=clone(dtz),f=p.forms[0],rows=f.members.map(m=>p.sets.find(s=>s.setId===m.setId&&s.version===m.version));
    validateCompleteMembers(p.exam.id,p.blueprint,f,rows);
    [f.members[4],f.members[5]]=[f.members[5],f.members[4]];
    const swapped=f.members.map(m=>p.sets.find(s=>s.setId===m.setId&&s.version===m.version));
    assert.throws(()=>validateCompleteMembers(p.exam.id,p.blueprint,f,swapped),e=>e.code==='invalid_package');
    const missing=rows.slice();missing[0]=undefined;assert.throws(()=>validateCompleteMembers(p.exam.id,p.blueprint,p.forms[0],missing));
  });
  await check('telc assigned prompt is exact, exclusive and uses the unchanged known rubric',()=>{
    for(const mutate of [p=>delete p.forms[0].writingTask,p=>p.forms[0].writingTask.section='SA',p=>p.forms[0].writingTask.taskVersion='latest',
      p=>p.forms[0].writingTask.option='A',p=>p.forms[0].writingChoices=clone(dtz.forms[0].writingChoices),
      p=>p.writingTasks[0].rubricId='unrelated',p=>p.writingTasks[0].rubricVersion='v2',p=>p.writingTasks[0].section='LV',
      p=>p.writingTasks[0].reviewStatus='approved',p=>p.writingTasks[0].rightsStatus='licensed']) {const p=clone(telc);mutate(p);bad(p);}
    assert.equal(telc.writingTasks[0].rubricId,'writing.telc-b1');assert.equal(telc.writingTasks[0].rubricVersion,'v1');assert.equal(telc.rubrics,undefined);
  });
  await check('DTZ keeps one exact SA A/B group and rejects telc assigned semantics',()=>{
    for(const mutate of [p=>delete p.forms[0].writingChoices,p=>p.forms[0].writingChoices[0].section='writing',
      p=>p.forms[0].writingChoices[0].options.reverse(),p=>p.forms[0].writingChoices.push(clone(p.forms[0].writingChoices[0])),
      p=>{delete p.forms[0].writingChoices;p.forms[0].writingTask=clone(telc.forms[0].writingTask);}
    ]) {const p=clone(dtz);mutate(p);bad(p);}
  });
  await check('assigned section practice is supported without ordered timing or listening attempt mode',()=>{
    const p=clone(telc),f=p.forms[0];f.scope='section';f.sections=['writing'];f.members=[];f.mode='untimed';f.timeLimitSeconds=null;delete f.attemptMode;delete f.timingPolicy;
    assert.deepEqual(validatePackage(p),p);f.timingPolicy='ordered-fixed-v1';bad(p);
  });
  await check('group identities may vary but their section references must remain reciprocal',()=>{
    for(const source of [telc,dtz]) {const p=clone(source);for(const [i,g] of p.blueprint.timeGroups.entries()) {g.id='group-'+i;for(const s of p.blueprint.sections.filter(s=>g.sections.includes(s.id))) s.timeGroup=g.id;}assert.deepEqual(validatePackage(p),p);}
  });
} finally {
  assert.equal(path.dirname(path.resolve(root)),path.resolve(os.tmpdir()));assert(path.basename(root).startsWith('hatoove-s5b-package-'));await rm(root,{recursive:true,force:true});
}
console.log(`EXAM-S5B package: ${passed} passed`);

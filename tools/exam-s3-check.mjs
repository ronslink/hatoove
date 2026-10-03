#!/usr/bin/env node
/** EXAM-S3 grouped objective contracts. Synthetic content only; importing this module runs no tests. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { validatePackage, objectiveItems } from '../server/package-contract.mjs';
import { mockMemberItems, validatePinnedSnapshot } from '../server/mock-contract.mjs';
import { parseFamily } from '../server/owned-api.mjs';
import { ENABLED_EXAM_IDS } from '../server/preparation-contract.mjs';

export const S3_EXAM = 'dtz-a2-b1';
export const S3_GROUPED_SET = 's3.synthetic.grouped';
export function syntheticPackage({ release = 'v8001', version = 'v1', state = 'internal', blocked = [] } = {}) {
  const question = (n, options) => ({ n, question:`Synthetic question ${n}?`, options });
  const bool = { richtig:'Richtig', falsch:'Falsch' };
  const abc = { a:'Alpha', b:'Beta', c:'Gamma' };
  const grouped = { groups:[
    { id:'first',text:'Synthetic first passage.',questions:[question(31,bool),question(32,abc)] },
    { id:'second',text:'Synthetic second passage.',questions:[question(33,bool),question(34,abc)] },
  ] };
  const build = (setId,family,interaction,payload,answers) => ({ setId,version,examId:S3_EXAM,family,section:'LV',
    part:Number(family.slice(2)),title:'Synthetic '+family,payload,itemCount:Object.keys(answers).length,interaction,answers,
    explanations:Object.fromEntries(Object.keys(answers).map(id=>[id,`Synthetic ${version} explanation ${id}.`])),
    reviewStatus:'unreviewed',rightsStatus:'generated',source:'synthetic:exam-s3-check' });
  const sets = [
    build(S3_GROUPED_SET,'LV3','grouped_choice',grouped,{31:version==='v1'?'richtig':'falsch',32:version==='v1'?'a':'c',33:'falsch',34:'b'}),
    build('s3.synthetic.brochure','LV4','single_choice',{text:'Synthetic brochure.',questions:[question(35,bool),question(36,bool)]},{35:'richtig',36:'falsch'}),
    build('s3.synthetic.letter','LV5','gap_choice',{letter:'Synthetic letter [37] [38].',gaps:[{n:37,options:abc},{n:38,options:abc}]},{37:'b',38:'c'}),
  ];
  return { schemaVersion:1, exam:{id:S3_EXAM,title:'Synthetic DTZ test fixture',language:'de',levelModel:{type:'CEFR',levels:['A2','B1']}},
    blueprint:{version:'v8000',sections:[{id:'LV',title:'Reading',parts:sets.map(s=>({family:s.family,itemCount:s.itemCount,interaction:s.interaction,mediaRequired:false}))}],assessment:{policy:'objective-count-v1',correct:1,incorrect:0}},
    release:{version:release,state,resumeBlockedReleases:blocked},
    forms:[{id:'s3-reading',version,title:'Synthetic reading only',scope:'section',sections:['LV'],mode:'untimed',timeLimitSeconds:null,feedback:'finalise',
      members:sets.map(s=>({setId:s.setId,version:s.version,interaction:s.interaction,itemCount:s.itemCount}))}],sets };
}

export function originalPackage() {
  return JSON.parse(readFileSync(new URL('../content/exams/dtz-a2-b1/manifest.json',import.meta.url),'utf8'));
}

export function runOfflineChecks() {
  let passed=0;
  const check=(name,work)=>{work();passed++;console.log('PASS '+name);};
  const reject=mutate=>{const p=syntheticPackage();mutate(p);assert.throws(()=>validatePackage(p),e=>e.code==='invalid_package');};
  check('mixed grouped package uses scalar options and ordered group/question flattening',()=>{
    const p=validatePackage(syntheticPackage());
    assert.deepEqual(objectiveItems(p.sets[0].payload,'grouped_choice'),[
      {id:'31',options:['richtig','falsch']},{id:'32',options:['a','b','c']},
      {id:'33',options:['richtig','falsch']},{id:'34',options:['a','b','c']}]);
    assert.equal(p.sets[2].section,'LV');assert.equal(p.sets[2].interaction,'gap_choice');
  });
  check('empty, unknown and malformed groups and question shapes are refused',()=>{
    for(const mutation of [
      p=>p.sets[0].payload.groups=[],p=>p.sets[0].payload.extra=true,p=>p.sets[0].payload.groups[0].extra=true,
      p=>p.sets[0].payload.groups[0].text='  ',p=>p.sets[0].payload.groups[0].questions=[],
      p=>p.sets[0].payload.groups[0].questions[0].question='',p=>p.sets[0].payload.groups[0].id={},
      p=>p.sets[0].payload.groups[0].questions[0].options={richtig:'Only one'},
      p=>p.sets[0].payload.groups[0].questions[0].id=31,
    ])reject(mutation);
  });
  check('group and item identities are globally unique scalar tokens',()=>{
    reject(p=>p.sets[0].payload.groups[1].id='first');
    reject(p=>p.sets[0].payload.groups[1].questions[0].n=31);
    reject(p=>p.sets[0].payload.groups[1].questions[0].n={id:33});
    const p=syntheticPackage();p.sets[0].payload.groups[0].id=1;p.sets[0].payload.groups[1].id='1';
    assert.throws(()=>validatePackage(p),/duplicate group/);
  });
  check('protected nested fields and keys outside each question vocabulary are refused',()=>{
    reject(p=>p.sets[0].payload.groups[1].questions[0].correct_answer='falsch');
    reject(p=>p.sets[0].answers['31']='a');reject(p=>p.sets[0].answers['34']='richtig');
    reject(p=>p.sets[0].answers['missing']='b');reject(p=>delete p.sets[0].answers['32']);
  });
  check('pinned run validation spans both groups and exact versions',()=>{
    const s=syntheticPackage().sets[0];const m={set_id:s.setId,version:s.version,payload:s.payload,interaction:s.interaction,item_count:4};
    assert.equal(mockMemberItems(m)[3].id,'34');
    const response={setId:s.setId,version:'v1',itemId:'34',answer:'b'};
    validatePinnedSnapshot([m],[response],{member:0,item:3});
    assert.throws(()=>validatePinnedSnapshot([m],[{...response,answer:'richtig'}],{member:0,item:3}),e=>e.code==='invalid_mock_answer');
    assert.throws(()=>validatePinnedSnapshot([m],[{...response,version:'v2'}],{member:0,item:3}),e=>e.code==='unknown_mock_item');
    assert.throws(()=>validatePinnedSnapshot([m],[],{member:0,item:4}),e=>e.code==='invalid_mock_position');
  });
  check('original DTZ source has five reading parts, 25 exact items and separate S2 identities',()=>{
    const p=validatePackage(originalPackage());
    assert.equal(p.exam.id,S3_EXAM);assert.equal(p.blueprint.version,'v2');assert.equal(p.release.version,'v2');assert.equal(p.release.state,'internal');
    assert.deepEqual(p.sets.map(s=>s.family),['LV1','LV2','LV3','LV4','LV5']);
    assert.deepEqual(p.sets.map(s=>s.itemCount),[5,5,6,3,6]);assert.ok(p.sets.every(s=>s.section==='LV'));
    assert.deepEqual(p.sets.map(s=>s.interaction),['single_choice','matching_ads','grouped_choice','single_choice','gap_choice']);
    assert.deepEqual(p.sets.flatMap(s=>objectiveItems(s.payload,s.interaction).map(i=>Number(i.id))),Array.from({length:25},(_,i)=>i+21));
    assert.equal(p.forms.length,1);assert.equal(p.forms[0].mode,'untimed');assert.equal(p.forms[0].timeLimitSeconds,null);
    assert.equal(p.forms[0].id,'dtz-a2-b1.reading.original01');assert.ok(p.sets.every(s=>s.setId.endsWith('.original01')));
    const exposed=structuredClone(p);exposed.release.state='available';assert.throws(()=>validatePackage(exposed),e=>e.code==='invalid_package');
  });
  check('default catalogue and historical family parser remain telc-only and closed',()=>{
    assert.deepEqual(ENABLED_EXAM_IDS,['telc-deutsch-b1']);assert.equal(parseFamily('LV4'),null);assert.equal(parseFamily('LV5'),null);
    assert.equal(parseFamily('LV3').part,3);assert.equal(parseFamily('lv4'),null);
    reject(p=>p.release.state='available');
  });
  console.log(`\n${passed} passed, 0 failed (synthetic offline S3 contracts)`);
}
if (process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) runOfflineChecks();

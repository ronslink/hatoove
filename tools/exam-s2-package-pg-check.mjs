#!/usr/bin/env node
/** Actual publisher/runtime roles against a disposable PostgreSQL schema. Never the learner preview. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createFixture } from '../server/owned-postgres/bootstrap.mjs';
import { importPackage } from '../server/owned-postgres/package-importer.mjs';
import { listReleasedForms,readReleasedForm,importedSetGate } from '../server/owned-postgres/packages.mjs';

if(['4300','55440'].includes(process.env.OWNAPI_PG_PORT||'')) throw new Error('disposable PostgreSQL port required');
const read=async p=>JSON.parse(await readFile(new URL('../'+p,import.meta.url),'utf8'));
const telc=await read('content/exams/telc-deutsch-b1/manifest.json');
const english=await read('content/fixtures/exams/english-scale.json');
const dtz=await read('content/fixtures/exams/dtz-internal.json');
const clone=x=>structuredClone(x);
const oldMode=process.env.B1PREP_CONTENT_MODE;
process.env.B1PREP_CONTENT_MODE='internal-preview';
const db=await createFixture();
let passed=0,failed=0;
async function check(name,fn) {try{await fn();passed++;console.log('PASS '+name);}catch(e){failed++;console.error('FAIL '+name+': '+e.stack);}}
const count=async()=> (await db.migration.query(`SELECT
 (SELECT count(*) FROM exam_release)::int AS releases,(SELECT count(*) FROM exam_form)::int AS forms,
 (SELECT count(*) FROM objective_set)::int AS sets,(SELECT count(*) FROM content_version)::int AS content,
 (SELECT jsonb_agg(h ORDER BY exam_id) FROM exam_release_head h) AS heads`)).rows[0];
try {
  await check('same exact package import is idempotent and private keys are absent from shared manifest',async()=>{
    const before=await count();const r=await importPackage(db.migration,telc);assert.equal(r.unchanged,true);assert.deepEqual(await count(),before);
    const visible=(await db.learner.query('SELECT manifest FROM exam_release')).rows;
    assert(!JSON.stringify(visible).includes('"answers"'));assert(!JSON.stringify(visible).includes('"explanations"'));
  });
  await check('changed release/form/blueprint versions refuse atomically',async()=>{
    for(const mutate of [p=>p.forms[0].title+=' changed',p=>p.blueprint.assessment.correct=2,p=>p.release.state='hidden']){
      const p=clone(telc);mutate(p);const before=await count();await assert.rejects(importPackage(db.migration,p),/changed/);assert.deepEqual(await count(),before);
    }
  });
  await check('dry-run validates new package references without storing anything',async()=>{
    const before=await count();const receipt=await importPackage(db.migration,english,{dryRun:true});assert(receipt.changes.length>0);assert.deepEqual(await count(),before);
  });
  await check('conflicting public item aliases cannot create an unfinalisable immutable version',async()=>{
    for(const alias of ['different',[1]]){
      const p=clone(english);p.sets[0].payload.questions[0].id=alias;const before=await count();
      await assert.rejects(importPackage(db.migration,p),/conflicting item identity/);assert.deepEqual(await count(),before);
    }
  });
  await check('missing identities and unusable renderer text fail during dry-run without writes',async()=>{
    for(const mutate of [p=>delete p.forms[0].id,p=>delete p.sets[0].payload.questions[0].question,
      p=>p.sets[0].payload.questions[0].options={a:null,b:[]}]){
      const p=clone(english);mutate(p);const before=await count();await assert.rejects(importPackage(db.migration,p,{dryRun:true}),e=>e.code==='invalid_package');assert.deepEqual(await count(),before);
    }
  });
  await check('item identities must be scalar tokens accepted by saved-run transport',async()=>{
    for(const bad of ['bad item',['1'],{},true]){
      const p=clone(english);p.sets[0].payload.questions[0].n=bad;
      p.sets[0].answers={[String(bad)]:'a'};p.sets[0].explanations={};
      const before=await count();await assert.rejects(importPackage(db.migration,p,{dryRun:true}),e=>e.code==='invalid_package');assert.deepEqual(await count(),before);
    }
  });
  await check('oversized form cannot exceed the complete saved-response transport limit',async()=>{
    const p=clone(english);p.forms[0].members=Array.from({length:6},(_,i)=>({...p.forms[0].members[0],setId:'fixture.'+i,itemCount:100}));
    const before=await count();await assert.rejects(importPackage(db.migration,p,{dryRun:true}),/saved response limit/);assert.deepEqual(await count(),before);
  });
  await check('complete answer snapshot must fit the HTTP UTF-8 body limit',async()=>{
    const p=clone(english),prototype=clone(p.sets[0]);p.sets=[];p.forms[0].members=[];p.blueprint.sections[0].parts=[];
    for(let index=0;index<5;index++){
      const s=clone(prototype);s.setId='fixture.'+'x'.repeat(118)+index;s.family='LV'+index;s.itemCount=100;
      s.payload.questions=Array.from({length:100},(_,i)=>({n:String(i).padStart(32,'0'),question:'Synthetic question',options:{['a'.repeat(32)]:'A',['b'.repeat(32)]:'B'}}));
      s.answers=Object.fromEntries(s.payload.questions.map(q=>[q.n,'a'.repeat(32)]));s.explanations={};p.sets.push(s);
      p.blueprint.sections[0].parts.push({family:s.family,itemCount:100,interaction:s.interaction,mediaRequired:false});
      p.forms[0].members.push({setId:s.setId,version:s.version,itemCount:100,interaction:s.interaction});
    }
    const before=await count();await assert.rejects(importPackage(db.migration,p,{dryRun:true}),/saved response byte limit/);assert.deepEqual(await count(),before);
  });
  await check('alternative-language and fractional-scale package imports once with protected exact keys',async()=>{
    await importPackage(db.migration,english);const again=await importPackage(db.migration,english);assert(again.unchanged);
    const b=(await db.learner.query('SELECT payload FROM exam_blueprint WHERE exam_id=$1',[english.exam.id])).rows[0].payload;
    assert.equal(b.exam.language,'en');assert.equal(b.assessment.correct,2.5);
    await assert.rejects(db.learner.query('SELECT answers FROM objective_key'),/permission denied/);
    await assert.rejects(db.learner.query('UPDATE exam_release_head SET release_version=release_version'),/permission denied/);
    await assert.rejects(importPackage(db.learner,english),/schema-owner/);
  });
  await check('newly imported set cannot mutate payload or key under an existing version',async()=>{
    for(const table of ['objective_set','objective_key']) await assert.rejects(db.migration.query(`UPDATE ${table} SET version=version WHERE set_id=$1`,[english.sets[0].setId]),/immutable/);
    const p=clone(english);p.release.version='v2';p.sets[0].answers['1']='b';const before=await count();await assert.rejects(importPackage(db.migration,p),/changed set/);assert.deepEqual(await count(),before);
  });
  await check('available release cannot approve unreviewed content and leaves no partial publication',async()=>{
    const p=clone(english);p.release.version='v2';p.release.state='available';const before=await count();await assert.rejects(importPackage(db.migration,p),/qualified review/);assert.deepEqual(await count(),before);
    const partial=clone(dtz);partial.release.state='available';await assert.rejects(importPackage(db.migration,partial),/DTZ/);
  });
  await check('invalid exact reference/cross-exam membership rolls back the whole release',async()=>{
    const p=clone(telc);p.release.version='v2';p.forms[0].version='v2';p.forms[0].members[0].setId=english.sets[0].setId;
    const before=await count();await assert.rejects(importPackage(db.migration,p),/incompatible exact set/);assert.deepEqual(await count(),before);
    const missing=clone(telc);missing.release.version='v2';missing.forms[0].version='v2';missing.forms[0].members[0].version='v999';await assert.rejects(importPackage(db.migration,missing),/exact set/);assert.deepEqual(await count(),before);
  });
  await check('internal DTZ is fixture-only and public deployment refuses every internal form/direct imported set',async()=>{
    await importPackage(db.migration,dtz);assert((await listReleasedForms(db.learner,dtz.exam.id)).length===1);
    process.env.B1PREP_CONTENT_MODE='public';assert.deepEqual(await listReleasedForms(db.learner,telc.exam.id),[]);assert.deepEqual(await listReleasedForms(db.learner,dtz.exam.id),[]);
    const r=await db.learner.query(`SELECT s.set_id FROM objective_set s JOIN content_version c ON c.content_version_id=s.content_version_id WHERE s.exam_id=$1 AND ${importedSetGate()}`,[dtz.exam.id]);assert.equal(r.rowCount,0);
    process.env.B1PREP_CONTENT_MODE='internal-preview';
  });
  await check('withdrawal blocks new direct starts but preserves pinned form; explicit rights block withholds it',async()=>{
    const args={examId:english.exam.id,formId:english.forms[0].id,formVersion:'v1',releaseVersion:'v1'};
    assert(await readReleasedForm(db.learner,{...args,newStart:true}));
    const withdraw=clone(english);withdraw.release.version='v2';withdraw.release.state='withdrawn';withdraw.forms=[];withdraw.sets=[];await importPackage(db.migration,withdraw);
    assert.equal(await readReleasedForm(db.learner,{...args,newStart:true}),null);assert((await readReleasedForm(db.learner,args)).members.length>0);
    const gated=await db.learner.query(`SELECT s.set_id FROM objective_set s JOIN content_version c ON c.content_version_id=s.content_version_id WHERE s.exam_id=$1 AND ${importedSetGate()}`,[english.exam.id]);assert.equal(gated.rowCount,0);
    const block=clone(withdraw);block.release.version='v3';block.release.resumeBlockedReleases=['v1'];await importPackage(db.migration,block);
    const pinned=await readReleasedForm(db.learner,args);assert.equal(pinned.blockedReason,'rights_blocked');assert.deepEqual(pinned.members,[]);
    await importPackage(db.migration,english);assert.equal((await readReleasedForm(db.learner,args)).blockedReason,'rights_blocked','reimporting old identical content cannot reactivate it');
  });
} finally {await db.cleanup();if(oldMode===undefined) delete process.env.B1PREP_CONTENT_MODE;else process.env.B1PREP_CONTENT_MODE=oldMode;}
console.log(`EXAM-S2 package PostgreSQL: ${passed} passed, ${failed} failed`);
if(failed) process.exitCode=1;

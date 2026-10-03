#!/usr/bin/env node
/** Complete package publication/readers against an explicitly isolated disposable database. */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createFixture } from '../server/owned-postgres/bootstrap.mjs';
import { importPackage, importDefaultPackage } from '../server/owned-postgres/package-importer.mjs';
import { readReleasedForm, listReleasedForms, readWritingTask, writingAccess } from '../server/owned-postgres/packages.mjs';
import { createCompleteFixture } from './exam-s5b-fixture.mjs';

if(process.env.OWNAPI_PG_ALLOW!=='1'||!process.env.OWNAPI_PG_PORT||[4300,55440].includes(Number(process.env.OWNAPI_PG_PORT))) throw Error('Explicit isolated OWNAPI_PG_ALLOW/PORT required');
const root=await mkdtemp(path.join(os.tmpdir(),'hatoove-s5b-package-pg-'));
const prior=Object.fromEntries(['B1PREP_CONTENT_MODE','B1PREP_SERVE_REVIEW','B1PREP_SERVE_RIGHTS'].map(k=>[k,process.env[k]]));
process.env.B1PREP_CONTENT_MODE='internal-preview';delete process.env.B1PREP_SERVE_REVIEW;delete process.env.B1PREP_SERVE_RIGHTS;
let db,passed=0;
const check=async(name,run)=>{await run();passed++;console.log('PASS '+name);},clone=x=>structuredClone(x);
const args=p=>({examId:p.exam.id,formId:p.forms[0].id,formVersion:p.forms[0].version,releaseVersion:p.release.version});
const snapshot=async()=> (await db.learner.query(`SELECT (SELECT count(*) FROM content_version)::int AS content,
  (SELECT count(*) FROM exam_release)::int AS releases,(SELECT count(*) FROM exam_form)::int AS forms,
  (SELECT jsonb_agg(h ORDER BY exam_id) FROM exam_release_head h) AS heads`)).rows[0];
try {
  db=await createFixture();
  const telc=await createCompleteFixture({mediaRoot:root}),dtz=await createCompleteFixture({examId:'dtz-a2-b1',mediaRoot:root});
  const publish=p=>importPackage(db.migration,p,{mediaRoot:root});
  const reference=p=>({...clone(p),release:{...p.release,version:'v9101'},sets:[],media:[],writingTasks:[],...(p.rubrics?{rubrics:[]}:{} )});
  const seededRubric=(await db.learner.query("SELECT * FROM rubric_version WHERE rubric_id='writing.telc-b1' AND version='v1'")).rows[0];
  await check('complete dry runs are write-free and both target publications are idempotent',async()=>{
    for(const p of [telc,dtz]) {
      const before=await snapshot();assert((await importPackage(db.migration,p,{mediaRoot:root,dryRun:true})).changes.length>0);assert.deepEqual(await snapshot(),before);
      await publish(p);const after=await snapshot();assert.equal((await publish(p)).unchanged,true);assert.deepEqual(await snapshot(),after);
    }
  });
  await check('runtime bundles preserve exact60/45 ordered objective items, schedule and writing model',async()=>{
    for(const [p,count,assigned] of [[telc,60,true],[dtz,45,false]]) {
      const b=await readReleasedForm(db.learner,{...args(p),newStart:true});assert(b);assert.equal(b.members.reduce((n,m)=>n+m.item_count,0),count);
      assert.deepEqual(b.members.map(m=>m.set_id),p.forms[0].members.map(m=>m.setId));assert.deepEqual(b.timeGroups,p.blueprint.timeGroups);
      assert.equal(b.reviewStatus,'unreviewed');assert.equal(!!b.writingTask,assigned);assert.equal(b.writingChoices.length,assigned?0:1);
      if(assigned) {assert.equal(b.writingTask.section,'writing');assert.equal(b.writingTask.task.task_id,p.forms[0].writingTask.taskId);assert.equal(b.writingTask.task.rubric_id,'writing.telc-b1');assert.equal(b.writingTask.task.rubric_version,'v1');}
      else {assert.equal(b.writingChoices[0].section,'SA');assert.deepEqual(b.writingChoices[0].options.map(o=>o.id),['A','B']);}
      for(const member of b.members.filter(m=>m.media_required)) {assert(member.recordings.length);for(const recording of member.recordings) {assert.equal(recording.max_plays,p.blueprint.sections.find(s=>s.id==='HV').parts.find(x=>x.family===member.family).playback.mock);assert(!Object.hasOwn(recording,'path'));}}
      const forms=await listReleasedForms(db.learner,p.exam.id);assert.equal(forms.length,1);assert.equal(forms[0].item_count,count);assert.equal(forms[0].writing_task_count,assigned?1:0);assert.equal(forms[0].writing_choice_count,assigned?0:1);
    }
  });
  await check('assigned prompt reuses the exact existing telc rubric without rewriting it',async()=>{
    assert.deepEqual((await db.learner.query("SELECT * FROM rubric_version WHERE rubric_id='writing.telc-b1' AND version='v1'")).rows[0],seededRubric);
    const t=await readWritingTask(db.learner,telc.forms[0].writingTask.taskId,telc.forms[0].writingTask.taskVersion);assert.equal(await writingAccess(db.learner,t),null);
    assert.equal(t.section,'writing');assert.equal(t.criteria.length,3);assert.equal(t.max_total,45);
  });
  await check('reference-only complete releases resolve all immutable writing and media references',async()=>{
    for(const p of [telc,dtz]) {const next=reference(p);await publish(next);assert(await readReleasedForm(db.learner,{...args(next),newStart:true}));}
  });
  await check('reference-only equal-shaped listening members cannot swap their target families',async()=>{
    const p=reference(telc);p.release.version='v9102';p.forms[0].version='v9102';[p.forms[0].members[5],p.forms[0].members[7]]=[p.forms[0].members[7],p.forms[0].members[5]];
    const before=await snapshot();await assert.rejects(publish(p),/complete resolved member order/);assert.deepEqual(await snapshot(),before);
  });
  await check('missing version, cross-exam task and unbound historical section cannot supply assigned writing',async()=>{
    const options=[{...telc.forms[0].writingTask,taskVersion:'v9999'},
      {section:'writing',taskId:dtz.writingTasks[0].taskId,taskVersion:dtz.writingTasks[0].version},
      {section:'writing',taskId:'writing.du.besuch-einer-freundin',taskVersion:'v2'}];
    for(const writingTask of options) {const p=reference(telc);p.release.version='v9102';p.forms[0].version='v9102';p.forms[0].writingTask=writingTask;const before=await snapshot();await assert.rejects(publish(p),/incompatible assigned writing/);assert.deepEqual(await snapshot(),before);}
  });
  await check('shortened schedule, claimed approval and changed immutable prompt fail without writes',async()=>{
    for(const mutate of [p=>p.blueprint.timeGroups[0].seconds=1,p=>p.writingTasks[0].reviewStatus='approved',p=>p.writingTasks[0].situation+=' changed']) {
      const p=clone(telc);p.release.version='v9102';mutate(p);const before=await snapshot();await assert.rejects(publish(p));assert.deepEqual(await snapshot(),before);
    }
    for(const source of [telc,dtz]) {const p=reference(source);p.release.version='v9102';p.release.state='available';const before=await snapshot();await assert.rejects(publish(p),/qualified review/);assert.deepEqual(await snapshot(),before);}
  });
  await check('public mode and narrowed reviews expose no internal assigned prompt or member content',async()=>{
    const p=reference(telc);
    process.env.B1PREP_CONTENT_MODE='public';assert.equal(await readReleasedForm(db.learner,{...args(p),newStart:true}),null);
    const b=await readReleasedForm(db.learner,args(p));assert.equal(b.blockedReason,'content_policy_blocked');assert.equal(b.writingTask,null);assert.deepEqual(b.members,[]);assert.deepEqual(b.media,[]);
    process.env.B1PREP_CONTENT_MODE='internal-preview';process.env.B1PREP_SERVE_REVIEW='approved';assert.equal(await readReleasedForm(db.learner,{...args(p),newStart:true}),null);assert.equal((await readReleasedForm(db.learner,args(p))).writingTask,null);delete process.env.B1PREP_SERVE_REVIEW;
  });
  await check('reader independently refuses rubric rights at its query seam without changing immutable rights',async()=>{
    const task=await readWritingTask(db.learner,telc.writingTasks[0].taskId,telc.writingTasks[0].version);assert.equal(task.rights_status,'generated');assert.equal(task.rubric_rights_status,'generated');
    // The known rubric's historical rights decision is immutable. Simulate a denied policy
    // result at the read boundary; do not disable SQL guards or alter that existing decision.
    const denied={query:async(sql,values)=>{
      const result=await db.learner.query(sql,values);
      if(sql.includes('rc.review_status AS rubric_review_status')) return {...result,rows:result.rows.map(t=>({...t,rubric_rights_status:'unknown'}))};
      return result;
    }};
    const p=reference(telc);assert.equal(await readReleasedForm(denied,{...args(p),newStart:true}),null);
    const b=await readReleasedForm(denied,args(p));assert.equal(b.blockedReason,'rights_blocked');assert.equal(b.writingTask,null);assert.deepEqual(b.members,[]);
    assert((await readReleasedForm(db.learner,{...args(p),newStart:true})).writingTask);
  });
  await check('task rights withdrawal hides pinned assigned writing and denies reference republication',async()=>{
    const t=telc.writingTasks[0];await db.migration.query("INSERT INTO content_rights(content_version_id,basis,decided_by,note) VALUES($1,'unknown','synthetic test','Negative rights test only')",[t.taskId+'@'+t.version]);
    const p=reference(telc);assert.equal(await readReleasedForm(db.learner,{...args(p),newStart:true}),null);
    const b=await readReleasedForm(db.learner,args(p));assert.equal(b.blockedReason,'rights_blocked');assert.equal(b.writingTask,null);assert.deepEqual(b.members,[]);
    const task=await readWritingTask(db.learner,t.taskId,t.version);assert.equal(await writingAccess(db.learner,task,{historical:true}),'rights_blocked');
    p.release.version='v9102';const before=await snapshot();await assert.rejects(publish(p),/incompatible assigned writing/);assert.deepEqual(await snapshot(),before);
  });
  await check('non-media objective rights refusal hides every component of current and historical complete forms',async()=>{
    const p=reference(dtz),set=dtz.sets.find(s=>s.section==='LV'&&s.family==='LV1'),cv=set.setId+'@'+set.version;
    const before=await readReleasedForm(db.learner,{...args(p),newStart:true});assert.equal(before.members.reduce((n,m)=>n+m.item_count,0),45);assert.equal(before.writingChoices.length,1);
    assert.equal((await db.learner.query('SELECT 1 FROM content_rights WHERE content_version_id=$1',[cv])).rowCount,0);
    await db.migration.query("INSERT INTO content_rights(content_version_id,basis,decided_by,note) VALUES($1,'unknown','synthetic test','Complete reading rights-negative test only')",[cv]);
    assert.equal(await readReleasedForm(db.learner,{...args(p),newStart:true}),null);assert.deepEqual(await listReleasedForms(db.learner,p.exam.id),[]);
    for(const pinned of [p,dtz]) {
      const bundle=await readReleasedForm(db.learner,args(pinned));assert.equal(bundle.blockedReason,'rights_blocked');
      assert.deepEqual(bundle.members,[]);assert.deepEqual(bundle.media,[]);assert.deepEqual(bundle.writingChoices,[]);assert.equal(bundle.writingTask,null);
    }
  });
  await check('public registry retains no objective keys or private media paths',async()=>{
    const manifests=(await db.learner.query("SELECT manifest FROM exam_release WHERE version='v9100'")).rows;
    for(const {manifest} of manifests) {assert(!JSON.stringify(manifest).includes('"answers"'));assert(!JSON.stringify(manifest).includes('"explanations"'));assert(manifest.media.every(m=>!Object.hasOwn(m,'path')));}
  });
  await check('legacy default package reimport remains exact after complete package publication',async()=>{
    const before=await snapshot();assert.equal((await importDefaultPackage(db.migration)).unchanged,true);assert.deepEqual(await snapshot(),before);
  });
} finally {
  await db?.cleanup();assert.equal(path.dirname(path.resolve(root)),path.resolve(os.tmpdir()));assert(path.basename(root).startsWith('hatoove-s5b-package-pg-'));await rm(root,{recursive:true,force:true});
  for(const [key,value] of Object.entries(prior)) {if(value===undefined)delete process.env[key];else process.env[key]=value;}
}
console.log(`EXAM-S5B package PostgreSQL: ${passed} passed`);

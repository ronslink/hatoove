#!/usr/bin/env node
/** Exact S5 publication/reader checks on explicitly selected disposable PostgreSQL only. */
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createFixture } from '../server/owned-postgres/bootstrap.mjs';
import { importPackage, importDefaultPackage } from '../server/owned-postgres/package-importer.mjs';
import { readReleasedForm, listReleasedForms } from '../server/owned-postgres/packages.mjs';
import { createListeningFixture } from './exam-s5-fixture.mjs';

if(process.env.OWNAPI_PG_ALLOW!=='1'||!process.env.OWNAPI_PG_PORT||[4300,55440].includes(Number(process.env.OWNAPI_PG_PORT))) throw Error('Explicit isolated OWNAPI_PG_ALLOW/PORT required');
const root=await mkdtemp(path.join(os.tmpdir(),'hatoove-s5-package-pg-'));
const prior={mode:process.env.B1PREP_CONTENT_MODE,review:process.env.B1PREP_SERVE_REVIEW,rights:process.env.B1PREP_SERVE_RIGHTS};
process.env.B1PREP_CONTENT_MODE='internal-preview';delete process.env.B1PREP_SERVE_REVIEW;delete process.env.B1PREP_SERVE_RIGHTS;
let db,passed=0;
const check=async(name,run)=>{await run();passed++;console.log('PASS '+name);},clone=x=>structuredClone(x);
const counts=async()=> (await db.learner.query(`SELECT (SELECT count(*) FROM content_version)::int AS content,
  (SELECT count(*) FROM exam_media)::int AS media,(SELECT count(*) FROM exam_release)::int AS releases,
  (SELECT jsonb_agg(h ORDER BY exam_id) FROM exam_release_head h) AS heads`)).rows[0];
const args=p=>({examId:p.exam.id,formId:p.forms[0].id,formVersion:p.forms[0].version,releaseVersion:p.release.version});
try {
  db=await createFixture({stopBefore:'0029-'});
  await importDefaultPackage(db.migration);
  await check('forward migration preserves existing content/default release and exact reimport hashes',async()=>{
    const before=(await db.learner.query('SELECT * FROM exam_release ORDER BY exam_id,version')).rows;
    const count=(await db.learner.query('SELECT count(*)::int AS n FROM content_version')).rows[0].n;
    const applied=await db.applyRemaining();assert.equal(applied[0],'0029-fixed-media.sql');
    assert.deepEqual((await db.learner.query('SELECT * FROM exam_release ORDER BY exam_id,version')).rows,before);
    assert.equal((await db.learner.query('SELECT count(*)::int AS n FROM content_version')).rows[0].n,count);
    assert.equal((await importDefaultPackage(db.migration)).unchanged,true);
  });
  const dtz=await createListeningFixture({mediaRoot:root});
  const telc=await createListeningFixture({examId:'telc-deutsch-b1',mediaRoot:root});
  const publish=p=>importPackage(db.migration,p,{mediaRoot:root});
  await check('dry run resolves real bytes/references without writes, then publication is idempotent',async()=>{
    const before=await counts();const result=await importPackage(db.migration,dtz,{mediaRoot:root,dryRun:true});assert(result.changes.length>0);assert.deepEqual(await counts(),before);
    for(const p of [dtz,telc]) {await publish(p);const before=await counts();assert.equal((await publish(p)).unchanged,true);assert.deepEqual(await counts(),before);}
  });
  await check('private media rows are immutable and learner metadata is read-only',async()=>{
    assert.equal((await db.learner.query('SELECT * FROM exam_media')).rows.length,27);
    for(const sql of ['UPDATE exam_media SET duration_ms=duration_ms','DELETE FROM exam_media']) {
      await assert.rejects(db.learner.query(sql),/permission denied/);await assert.rejects(db.migration.query(sql),/immutable/);
    }
    await assert.rejects(db.learner.query('INSERT INTO exam_media SELECT * FROM exam_media'),/permission denied/);
    await assert.rejects(importPackage(db.learner,dtz,{mediaRoot:root}),/schema-owner/);
    assert.equal((await db.admin.query("SELECT has_table_privilege('public','exam_media','SELECT') AS allowed")).rows[0].allowed,false);
  });
  await check('exact listening reader includes counts and strips disk paths/keys from public descriptors',async()=>{
    for(const p of [dtz,telc]) {
      const bundle=await readReleasedForm(db.learner,{...args(p),newStart:true});assert(bundle);assert.equal(bundle.members.length,p.sets.length);
      assert.equal(bundle.media.length,p.media.length);assert.equal(bundle.reviewStatus,'unreviewed');
      for(const [i,member] of bundle.members.entries()) for(const recording of member.recordings) {
        assert.deepEqual(Object.keys(recording).sort(),['id','media_id','media_version','label','duration_ms','mime_type','max_plays'].sort());
        assert.equal(recording.max_plays,p.blueprint.sections[0].parts[i].playback.practice);assert.equal(recording.duration_ms,2000);
      }
      const forms=await listReleasedForms(db.learner,p.exam.id);assert.equal(forms.length,2);assert.deepEqual(forms.map(f=>f.attempt_mode).sort(),['mock','practice']);
      const manifest=(await db.learner.query('SELECT manifest FROM exam_release WHERE exam_id=$1 AND version=$2',[p.exam.id,p.release.version])).rows[0].manifest;
      assert(manifest.media.every(m=>!Object.hasOwn(m,'path')));assert(!JSON.stringify(manifest).includes('"answers"'));assert(!JSON.stringify(manifest).includes('"explanations"'));
    }
  });
  await check('changed media metadata/version, missing references and cross-exam references fail atomically',async()=>{
    for(const mutate of [p=>p.media[0].source+=' changed',p=>p.sets[0].payload.recordings[0].mediaVersion='v999',
      p=>{p.sets[0].payload.recordings[0].mediaId=telc.media[0].mediaId;},
      p=>{p.media[0].mediaId=p.sets[0].setId;}]) {
      const p=clone(dtz);p.release.version='v9002';p.forms.forEach(f=>f.version='v2');p.sets.forEach(s=>s.version='v2');p.forms.forEach(f=>f.members.forEach(m=>m.version='v2'));mutate(p);
      const before=await counts();await assert.rejects(publish(p),e=>e.code==='package_conflict');assert.deepEqual(await counts(),before);
    }
  });
  await check('one exact media cannot be repeated across parts in a form',async()=>{
    const p=clone(dtz);p.release.version='v9002';p.forms.forEach(f=>f.version='v2');p.sets.forEach(s=>s.version='v2');p.forms.forEach(f=>f.members.forEach(m=>m.version='v2'));
    p.sets[1].payload.recordings[0].mediaId=p.sets[0].payload.recordings[0].mediaId;
    const before=await counts();await assert.rejects(publish(p),/repeated media/);assert.deepEqual(await counts(),before);
  });
  await check('reference-only release resolves historical exact media and immutable sets',async()=>{
    const p=clone(telc);p.release.version='v9002';p.sets=[];p.media=[];await publish(p);
    const bundle=await readReleasedForm(db.learner,{...args(p),newStart:true});assert.equal(bundle.media.length,11);assert.equal(bundle.members.length,3);
  });
  await check('reference-only byte tampering is detected before a publishing transaction begins',async()=>{
    const p=clone(telc);p.release.version='v9003';p.sets=[];p.media=[];
    const target=path.join(root,telc.media[0].path.slice(14)),bytes=await readFile(target),corrupt=Buffer.from(bytes);corrupt[44]^=1;
    let begins=0;const before=await counts();
    const observed={connect:async()=>{const client=await db.migration.connect();return {query:async(sql,...rest)=>{if(sql==='BEGIN') begins++;return client.query(sql,...rest);},release:()=>client.release()};}};
    try {await writeFile(target,corrupt);await assert.rejects(importPackage(observed,p,{mediaRoot:root}),e=>e.code==='media_integrity');}
    finally {await writeFile(target,bytes);}
    assert.equal(begins,0);assert.deepEqual(await counts(),before);
  });
  await check('new public starts and narrowed/invalid content policies cannot expose internal media',async()=>{
    for(const mode of ['public','typo']) {
      process.env.B1PREP_CONTENT_MODE=mode;
      assert.equal(await readReleasedForm(db.learner,{...args(dtz),newStart:true}),null);
      const resume=await readReleasedForm(db.learner,args(dtz));assert(resume.blockedReason);assert.deepEqual(resume.members,[]);assert.deepEqual(resume.media,[]);
    }
    process.env.B1PREP_CONTENT_MODE='internal-preview';process.env.B1PREP_SERVE_REVIEW='approved';
    assert.equal(await readReleasedForm(db.learner,{...args(dtz),newStart:true}),null);
    assert.deepEqual((await readReleasedForm(db.learner,args(dtz))).members,[]);delete process.env.B1PREP_SERVE_REVIEW;
  });
  await check('new imports cannot grant release/content approval and failure leaves no partial publication',async()=>{
    const p=clone(telc);p.release.version='v9003';p.release.state='available';const before=await counts();
    await assert.rejects(publish(p),/qualified review/);assert.deepEqual(await counts(),before);
    const approved=clone(dtz);approved.media[0].reviewStatus='approved';await assert.rejects(publish(approved),e=>e.code==='invalid_package');assert.deepEqual(await counts(),before);
  });
  await check('media rights refusal hides pinned protected content and blocks new starts',async()=>{
    const m=dtz.media[0];await db.migration.query(`INSERT INTO content_rights(content_version_id,basis,decided_by,note) VALUES($1,'unknown','synthetic test','Synthetic rights-negative test; not an approval')`,[m.mediaId+'@'+m.version]);
    assert.equal(await readReleasedForm(db.learner,{...args(dtz),newStart:true}),null);
    const resume=await readReleasedForm(db.learner,args(dtz));assert.equal(resume.blockedReason,'rights_blocked');assert.deepEqual(resume.members,[]);assert.deepEqual(resume.media,[]);
    const next=clone(dtz);next.release.version='v9002';next.media=[];next.sets=[];const before=await counts();await assert.rejects(publish(next),/incompatible exact media/);assert.deepEqual(await counts(),before);
  });
  await check('explicit historical release block hides all media while preserving immutable references',async()=>{
    const p=clone(telc);p.release.version='v9003';p.release.state='withdrawn';p.release.resumeBlockedReleases=['v9001','v9002'];p.forms=[];p.sets=[];p.media=[];await publish(p);
    const resumed=await readReleasedForm(db.learner,args(telc));assert.equal(resumed.blockedReason,'rights_blocked');assert.deepEqual(resumed.media,[]);assert.deepEqual(resumed.members,[]);
    assert.equal((await db.learner.query('SELECT count(*)::int AS n FROM exam_media')).rows[0].n,27);
  });
  await check('default source file remains unchanged after media imports',async()=>{
    const source=JSON.parse(await readFile(new URL('../content/exams/telc-deutsch-b1/manifest.json',import.meta.url),'utf8'));
    const head=(await db.learner.query('SELECT release_version FROM exam_release_head WHERE exam_id=$1',[source.exam.id])).rows[0].release_version;
    assert.equal((await importDefaultPackage(db.migration)).unchanged,true);
    assert.equal((await db.learner.query('SELECT release_version FROM exam_release_head WHERE exam_id=$1',[source.exam.id])).rows[0].release_version,head);
  });
} finally {
  await db?.cleanup();
  assert.equal(path.dirname(path.resolve(root)),path.resolve(os.tmpdir()));assert(path.basename(root).startsWith('hatoove-s5-package-pg-'));await rm(root,{recursive:true,force:true});
  for(const [key,value] of Object.entries({B1PREP_CONTENT_MODE:prior.mode,B1PREP_SERVE_REVIEW:prior.review,B1PREP_SERVE_RIGHTS:prior.rights})) {if(value===undefined) delete process.env[key];else process.env[key]=value;}
}
console.log(`EXAM-S5 package PostgreSQL: ${passed} passed`);

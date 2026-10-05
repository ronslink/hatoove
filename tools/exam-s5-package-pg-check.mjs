#!/usr/bin/env node
/** Exact S5 publication/reader checks on explicitly selected disposable PostgreSQL only. */
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createFixture } from '../server/owned-postgres/bootstrap.mjs';
import {importHistoricalDefaultPackage,assertHistoricalProjectionAbsent} from './historical-content-fixture.mjs';
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
  await check('historical helper refuses unguarded, mismatched, non-migration and preexisting projection targets without writes',async()=>{
    const before=(await db.migration.query('SELECT * FROM content_version ORDER BY content_version_id')).rows;
    const allow=process.env.OWNAPI_PG_ALLOW,port=process.env.OWNAPI_PG_PORT;
    try {
      process.env.OWNAPI_PG_ALLOW='0';
      await assert.rejects(importHistoricalDefaultPackage(db),/explicit isolated ownapi/);
      process.env.OWNAPI_PG_ALLOW=allow;process.env.OWNAPI_PG_PORT=String(Number(port)===65535?65534:Number(port)+1);
      await assert.rejects(importHistoricalDefaultPackage(db),/connection target mismatch/);
    } finally {process.env.OWNAPI_PG_ALLOW=allow;process.env.OWNAPI_PG_PORT=port;}
    const spoof='ownapi_spoofed';
    await assert.rejects(importHistoricalDefaultPackage({...db,schema:spoof,roles:{...db.roles,migration:spoof+'_migration'}}),/schema or migration role mismatch/);
    await assert.rejects(importHistoricalDefaultPackage({...db,migration:db.learner}),/schema or migration role mismatch/);
    await db.migration.query('CREATE VIEW reviewed_content_version AS SELECT * FROM content_version');
    try {await assert.rejects(importHistoricalDefaultPackage(db),/projection must be absent/);}
    finally {await db.migration.query('DROP VIEW reviewed_content_version');}
    await assertHistoricalProjectionAbsent(db);
    // Fail the importer after the real temporary view exists; finally must still remove it.
    const failedImportPool={options:db.migration.options,query:db.migration.query.bind(db.migration),connect:async()=>{
      assert.equal((await db.migration.query("SELECT to_regclass('reviewed_content_version')::text AS projection")).rows[0].projection,'reviewed_content_version');
      throw Error('Synthetic importer connection refusal');
    }};
    await assert.rejects(importHistoricalDefaultPackage({...db,migration:failedImportPool}),/Synthetic importer connection refusal/);
    await assertHistoricalProjectionAbsent(db);
    assert.deepEqual((await db.migration.query('SELECT * FROM content_version ORDER BY content_version_id')).rows,before);
  });
  await importHistoricalDefaultPackage(db);
  await check('forward migration preserves existing content/default release and exact reimport hashes',async()=>{
    const before=(await db.learner.query('SELECT * FROM exam_release ORDER BY exam_id,version')).rows;
    const contentBefore=(await db.learner.query('SELECT * FROM content_version ORDER BY content_version_id')).rows;
    await assertHistoricalProjectionAbsent(db);
    const applied=await db.applyRemaining();assert.equal(applied[0],'0029-fixed-media.sql');
    await assert.rejects(importHistoricalDefaultPackage(db),/pre0035 schema/);
    assert.deepEqual((await db.learner.query('SELECT * FROM exam_release ORDER BY exam_id,version')).rows,before);
    /*
     * A FORWARD MIGRATION MAY ADD CONTENT ROWS; IT MAY NOT REWRITE ONE. This used to compare the COUNT of
     * `content_version` before and after, which was true only while the remaining migrations published
     * nothing: POOL-01 batch 1 (0047/0048) legitimately publishes six content rows and three recordings, so
     * the count grows. The invariant that actually matters is containment — every row present before is still
     * present, byte for byte — so an applied content row cannot be silently edited by a later migration.
     */
    const contentAfter=new Map((await db.learner.query('SELECT * FROM content_version')).rows.map(row=>[row.content_version_id,row]));
    for(const row of contentBefore)
      assert.deepEqual(contentAfter.get(row.content_version_id),row,`${row.content_version_id}: an applied content row must not move`);
    assert.ok(contentAfter.size>contentBefore.length,'and the remaining migrations published something (the POOL-01 batch)');
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
    /*
     * SCOPED TO THIS CHECK'S OWN SYNTHETIC MEDIA. The count used to be the whole `exam_media` table, which the
     * remaining migrations now also write: POOL-01 batch 1's release (0048) inserts the three rows its
     * released listening sets bind to. The subject here is the fixture's own import (`s5.*`), so that is what
     * is counted; the pool's rows have their own legs in tools/pool-01-check.mjs.
     */
    assert.equal((await db.learner.query("SELECT * FROM exam_media WHERE media_id LIKE 's5.%'")).rows.length,27);
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
    assert.equal((await db.learner.query("SELECT count(*)::int AS n FROM exam_media WHERE media_id LIKE 's5.%'")).rows[0].n,27);
  });
  await check('default source file remains unchanged after media imports',async()=>{
    const source=JSON.parse(await readFile(new URL('../content/exams/telc-deutsch-b1/manifest.json',import.meta.url),'utf8'));
    const head=(await db.learner.query('SELECT release_version FROM exam_release_head WHERE exam_id=$1',[source.exam.id])).rows[0].release_version;
    assert.equal((await importDefaultPackage(db.migration)).unchanged,true);
    assert.equal((await db.learner.query('SELECT release_version FROM exam_release_head WHERE exam_id=$1',[source.exam.id])).rows[0].release_version,head);
  });
  /*
   * THE REAL TELC PACKAGE, IMPORTED. Everything above imports synthetic tone fixtures. This imports the
   * package generated from the authored migration and the nine TTS recordings and asserts what only a
   * real import shows: the nine media rows exist with their exact identities, the `v2` blueprint and its
   * pins are in the database, and the reader resolves the allowance PER ATTEMPT MODE from them.
   * Skipped with a notice when the private audio root is not supplied, so CI stays green without bytes.
   */
  await check('the real telc listening package imports as media rows, v2 sets and 1/2/2 pins',async()=>{
    const realRoot=process.env.HATOVE_LISTENING_MEDIA_ROOT;
    if(!realRoot){console.log('     skipped: set HATOVE_LISTENING_MEDIA_ROOT to import the real package');return;}
    assert.ok(path.isAbsolute(realRoot),'HATOVE_LISTENING_MEDIA_ROOT must be an absolute private directory');
    const source=JSON.parse(await readFile(new URL('../content/exams/telc-deutsch-b1/listening-package.json',import.meta.url),'utf8'));
    const before=await counts();
    const formsBefore=await listReleasedForms(db.learner,'telc-deutsch-b1');
    const result=await importPackage(db.migration,source,{mediaRoot:realRoot});
    assert(result.changes.length>0);
    assert.equal((await counts()).media-before.media,9);
    const rows=(await db.learner.query(`SELECT media_id,version,sha256,byte_length,duration_ms,mime_type FROM exam_media WHERE exam_id='telc-deutsch-b1'`)).rows;
    for(const descriptor of source.media){
      const row=rows.find(candidate=>candidate.media_id===descriptor.mediaId&&candidate.version===descriptor.version);
      assert.ok(row,`missing media row ${descriptor.mediaId}@${descriptor.version}`);
      assert.equal(row.sha256,descriptor.sha256);assert.equal(row.byte_length,descriptor.byteLength);
      assert.equal(row.duration_ms,descriptor.durationMs);assert.equal(row.mime_type,'audio/wav');
    }
    const sets=(await db.learner.query(`SELECT set_id,item_count FROM objective_set WHERE exam_id='telc-deutsch-b1' AND version='v2' ORDER BY set_id`)).rows;
    assert.equal(sets.length,9);assert.equal(sets.reduce((total,row)=>total+row.item_count,0),60);
    const blueprint=(await db.learner.query(`SELECT payload FROM exam_blueprint WHERE exam_id='telc-deutsch-b1' AND version='v2'`)).rows[0];
    assert.ok(blueprint,'the v2 blueprint row is missing');
    assert.deepEqual(blueprint.payload.sections.find(section=>section.id==='HV').parts.map(part=>part.playback),
      [{practice:1,mock:1},{practice:1,mock:2},{practice:1,mock:2}]);
    const hv2Duration=source.media.find(media=>media.mediaId==='telc-deutsch-b1.hv2.01.audio').durationMs;
    for(const [formId,expected] of [['telc-deutsch-b1.listening.practice',1],['telc-deutsch-b1.listening.mock',2]]){
      const bundle=await readReleasedForm(db.learner,{examId:'telc-deutsch-b1',formId,formVersion:'v2',releaseVersion:'v2',newStart:true});
      assert.ok(bundle,`${formId} did not resolve from the imported package`);
      assert.equal(bundle.members.reduce((total,member)=>total+(member.item_count??member.itemCount),0),20);
      assert.equal(bundle.members[1].recordings[0].max_plays,expected,`${formId} HV2 allowance`);
      assert.equal(bundle.members[0].recordings[0].max_plays,1,`${formId} HV1 allowance`);
      assert.equal(bundle.members[1].recordings[0].duration_ms,hv2Duration);
    }
    /*
     * NOTHING MAY DISAPPEAR. Activating release v2 replaces its form rows, and the learner's cards come
     * from `listReleasedForms`, so every form that was listed before the import must still be listed
     * after it - otherwise adding listening quietly removes something else.
     */
    const formsAfter=await listReleasedForms(db.learner,'telc-deutsch-b1');
    for(const form of formsBefore)
      assert.ok(formsAfter.some(candidate=>candidate.form_id===form.form_id),
        `"${form.form_id}" disappeared when the listening release was activated`);
    assert.equal(formsAfter.filter(form=>form.sections.includes('HV')).length,2);
    assert.ok(formsAfter.length>formsBefore.length,'the two listening forms must be added');
    // Listed is not enough: the carried-over reading form has to still START under the new release.
    const carried=source.forms.find(form=>form.id==='telc-deutsch-b1.reading.01');
    const reading=await readReleasedForm(db.learner,{examId:'telc-deutsch-b1',formId:carried.id,formVersion:carried.version,releaseVersion:'v2',newStart:true});
    assert.ok(reading,'the reading form must still start after the listening release is activated');
    assert.equal(reading.members.length,3);
  });
} finally {
  await db?.cleanup();
  assert.equal(path.dirname(path.resolve(root)),path.resolve(os.tmpdir()));assert(path.basename(root).startsWith('hatoove-s5-package-pg-'));await rm(root,{recursive:true,force:true});
  for(const [key,value] of Object.entries({B1PREP_CONTENT_MODE:prior.mode,B1PREP_SERVE_REVIEW:prior.review,B1PREP_SERVE_RIGHTS:prior.rights})) {if(value===undefined) delete process.env[key];else process.env[key]=value;}
}
console.log(`EXAM-S5 package PostgreSQL: ${passed} passed`);

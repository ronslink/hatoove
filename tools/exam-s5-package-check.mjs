#!/usr/bin/env node
/** Synthetic source-only S5 package and real private-file integrity checks. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, symlink, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { validatePackage, objectiveItems, packageHash } from '../server/package-contract.mjs';
import { readMediaBytes, parsePcmWav, MAX_MEDIA_BYTES } from '../server/media-contract.mjs';
import { importPackage } from '../server/owned-postgres/package-importer.mjs';
import { createListeningFixture, s5AudioBytes } from './exam-s5-fixture.mjs';

const root=await mkdtemp(path.join(os.tmpdir(),'hatoove-s5-package-'));
const clone=x=>structuredClone(x),bad=p=>assert.throws(()=>validatePackage(p),e=>e.code==='invalid_package');
let passed=0;
const check=async(name,run)=>{await run();passed++;console.log('PASS '+name);};
try {
  const dtz=await createListeningFixture({mediaRoot:root});
  const telc=await createListeningFixture({examId:'telc-deutsch-b1',mediaRoot:root});
  await check('historical manifests retain exact canonical values and hashes',async()=>{
    for(const file of ['content/exams/telc-deutsch-b1/manifest.json','content/exams/dtz-a2-b1/manifest.json','content/fixtures/exams/english-scale.json']) {
      const source=JSON.parse(await readFile(new URL('../'+file,import.meta.url),'utf8'));
      assert.deepEqual(validatePackage(source),source);assert.equal(packageHash(validatePackage(source)),packageHash(source));
    }
  });
  await check('both target packages flatten all twenty questions and bind exact playback policies',async()=>{
    for(const source of [dtz,telc]) {
      assert.deepEqual(validatePackage(source),source);
      const items=source.sets.flatMap(set=>objectiveItems(set.payload,'fixed_audio'));
      assert.equal(items.length,20);assert.deepEqual(items.map(item=>item.id),Array.from({length:20},(_,i)=>String(i+1)));
    }
  });
  await check('audio public payload refuses duplicates, protected fields and unusable rendering',async()=>{
    const changes=[p=>p.sets[0].payload.script='secret',p=>p.sets[0].payload.recordings[0].transcript='secret',
      p=>p.sets[0].payload.recordings[0].questions[0].answer='a',p=>p.sets[0].payload.recordings[0].questions[0].question=' ',
      p=>p.sets[0].payload.recordings[0].questions[0].options={a:'Only one'},p=>p.sets[0].payload.recordings[0].questions[0].options={a:'A',b:2},
      p=>p.sets[0].payload.recordings[1].id=p.sets[0].payload.recordings[0].id,
      p=>p.sets[0].payload.recordings[1].questions[0].n=p.sets[0].payload.recordings[0].questions[0].n,
      p=>p.sets[0].payload.recordings[1].mediaId=p.sets[0].payload.recordings[0].mediaId,
      p=>p.sets[0].payload.recordings[0].mediaVersion='latest'];
    for(const change of changes) {const p=clone(dtz);change(p);bad(p);}
  });
  await check('target formats, attempt modes and allowance policies cannot be weakened by manifests',async()=>{
    for(const source of [dtz,telc]) for(const change of [
      p=>delete p.forms[0].attemptMode,p=>p.forms[0].attemptMode='practice-unlimited',
      p=>delete p.blueprint.sections[0].parts[0].playback,p=>p.blueprint.sections[0].parts[0].playback.mock=9,
      p=>p.blueprint.sections[0].parts[0].playback.practice=0,p=>p.blueprint.sections[0].parts[0].playback.loop=true,
      p=>p.blueprint.sections[0].parts[0].itemCount=3,p=>p.blueprint.sections[0].parts[0].family='different',
      p=>p.blueprint.sections[0].id='not-listening',p=>p.blueprint.sections[0].parts.pop(),
      p=>p.forms[0].scope='complete_supported_written']) {const p=clone(source);change(p);bad(p);}
  });
  await check('paths, imports claiming approval, codec and metadata bounds fail closed',async()=>{
    for(const value of ['https://example.invalid/a.wav','/etc/passwd','C:/audio.wav','content/exams/../a.wav',
      'content/exams/a/../../b.wav','content/exams/a\\b.wav','public/assets/a.wav','content/exams/a/%2e%2e.wav',
      'content/exams/a/con.wav','content/exams/a/trailing./b.wav']) {const p=clone(dtz);p.media[0].path=value;bad(p);}
    for(const change of [m=>m.reviewStatus='approved',m=>m.rightsStatus='licensed',m=>m.durationMs=3600001,
      m=>m.durationMs=0,m=>m.byteLength=MAX_MEDIA_BYTES+1,m=>m.sha256='bogus',m=>m.mimeType='audio/mp3',m=>m.transcript='private']) {
      const p=clone(dtz);change(p.media[0]);bad(p);
    }
  });
  await check('actual PCM bytes verify through both manifest and database metadata',async()=>{
    for(const p of [dtz,telc]) for(const media of p.media) {
      const bytes=await readMediaBytes(media,{mediaRoot:root});assert.equal(bytes.length,media.byteLength);
      assert.deepEqual(parsePcmWav(bytes),{byteLength:media.byteLength,durationMs:media.durationMs,mimeType:'audio/wav'});
    }
    const m=dtz.media[0];assert.equal((await readMediaBytes({path:m.path,sha256:m.sha256,byte_length:m.byteLength,duration_ms:m.durationMs,mime_type:m.mimeType},{mediaRoot:root})).length,m.byteLength);
  });
  await check('changed checksum, length or duration and missing files are rejected before database access',async()=>{
    let connections=0;
    const pool={connect:async()=>{connections++;throw Error('Unexpected database connection');}};
    for(const change of [m=>m.sha256='0'.repeat(64),m=>m.byteLength++,m=>m.durationMs++,m=>m.path='content/exams/missing/file.wav']) {
      const p=clone(dtz);change(p.media[0]);await assert.rejects(importPackage(pool,p,{mediaRoot:root}),e=>['media_integrity','media_unavailable'].includes(e.code));
    }
    assert.equal(connections,0);
  });
  await check('RIFF chunk lengths, duplicate audio, non-PCM codec and frame alignment are checked',async()=>{
    const changes=[b=>b.writeUInt16LE(3,20),b=>b.writeUInt32LE(12,4),b=>b.writeUInt32LE(15,16),b=>b.writeUInt32LE(0xffffffff,40),
      b=>b.writeUInt16LE(4,32),b=>b.writeUInt32LE(1,28),b=>b.writeUInt16LE(3,22),b=>b.writeUInt32LE(1,24)];
    for(const change of changes) {const bytes=s5AudioBytes();change(bytes);assert.throws(()=>parsePcmWav(bytes),e=>e.code==='media_integrity');}
    const original=s5AudioBytes(),extra=Buffer.concat([original,original.subarray(36)]);extra.writeUInt32LE(extra.length-8,4);
    assert.throws(()=>parsePcmWav(extra),e=>e.code==='media_integrity');
    const filename=path.join(root,'dtz-a2-b1','bad-codec.wav');const bytes=s5AudioBytes();bytes.writeUInt16LE(3,20);await writeFile(filename,bytes);
    const media={...dtz.media[0],path:'content/exams/dtz-a2-b1/bad-codec.wav',sha256:createHash('sha256').update(bytes).digest('hex')};
    await assert.rejects(readMediaBytes(media,{mediaRoot:root}),e=>e.code==='media_integrity');
  });
  await check('symlink/junction media escapes and directories never become audio files',async()=>{
    const external=path.join(root,'outside');await mkdir(external);await writeFile(path.join(external,'signal.wav'),s5AudioBytes());
    const link=path.join(root,'dtz-a2-b1','escape');await symlink(external,link,process.platform==='win32'?'junction':'dir');
    const media={...dtz.media[0],path:'content/exams/dtz-a2-b1/escape/signal.wav'};
    await assert.rejects(readMediaBytes(media,{mediaRoot:root}),e=>e.code==='media_unavailable');
    await assert.rejects(readMediaBytes({...media,path:'content/exams/dtz-a2-b1/s5-technical'},{mediaRoot:root}),e=>e.code==='media_unavailable');
  });
} finally {
  assert.equal(path.dirname(path.resolve(root)),path.resolve(os.tmpdir()));
  assert(path.basename(root).startsWith('hatoove-s5-package-'));await rm(root,{recursive:true,force:true});
}
console.log(`EXAM-S5 package: ${passed} passed`);

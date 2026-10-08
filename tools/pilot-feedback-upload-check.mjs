/** Binary route, ownership, immutable attachment, export and deletion on disposable PostgreSQL. */
import assert from 'node:assert/strict';
import { persistentWorld } from './owned-api-check.mjs';
import { feedbackPng } from './lib/feedback-image-fixtures.mjs';
const pg = await persistentWorld({ accountDeletion: true });
const run = Date.now() + '-' + process.pid;
const call = (method,path,cookie,body,type='application/json') => pg.api.handle({
  method,path,headers:{'content-type':type,...(cookie?{cookie}:{})},
  body:Buffer.isBuffer(body)?body:body===undefined?undefined:JSON.stringify(body),originChecked:true,
});
const json = r => JSON.parse(r.body);
const signUp = async label => {
  const r=await call('POST','/api/auth/sign-up/email',null,
    {name:'Synthetic upload '+label,email:'upload-'+run+'-'+label+'@example.invalid',password:'Synthetic-upload-password'});
  assert.equal(r.status,200,r.body);return String(r.headers['set-cookie']).split(';')[0];
};
let checks = 0;
const passed = label => { checks++;console.log('PASS '+label); };
try {
  await pg.throttle.clear('feedbackGlobal','all');
  const a = await signUp('a'), b = await signUp('b');
  const r = await call('POST','/api/v1/feedback',a,{category:'bug',body:'Synthetic screenshot fixture',route:'heute',interfaceLanguage:'de'});
  assert.equal(r.status,201,r.body);
  const id=json(r).feedback_id,path='/api/v1/feedback/'+id+'/screenshot',bytes=feedbackPng(320,240);
  assert.equal((await call('PUT',path,null,bytes,'image/png')).status,401);
  assert.equal((await call('PUT',path,b,bytes,'image/png')).status,404);
  passed('anonymous and foreign owners cannot attach to a report');
  assert.equal((await call('PUT',path,a,bytes,'image/webp')).status,415);
  assert.equal((await call('PUT',path,a,bytes.subarray(0,33),'image/png')).status,415);
  assert.equal((await call('PUT',path,a,bytes,'application/octet-stream')).status,415);
  assert.equal((await call('PUT',path,a,Buffer.alloc(1572865),'image/png')).status,413);
  assert.equal((await call('PUT',path,a,feedbackPng(1601,1),'image/png')).status,422);
  passed('MIME mismatch, malformed container, oversize body and excessive width are refused');
  const uploaded=await call('PUT',path,a,bytes,'image/png');
  assert.equal(uploaded.status,204,uploaded.body);
  assert.equal((await call('PUT',path,a,bytes,'image/png')).status,409);
  passed('one valid attachment is saved once');
  const exported = await call('GET','/api/v1/export',a);
  assert.equal(exported.status,200,exported.body);
  const data=json(exported);
  assert.ok(data?.feedback_screenshots,'image-file export is present');
  assert.equal(data.feedback_screenshots.length,1);
  assert.equal(data.feedback_screenshots[0].encoding,'base64');
  assert.ok(Buffer.from(data.feedback_screenshots[0].bytes,'base64').equals(bytes));
  assert.ok(!exported.body.includes('operator_note'));
  assert.equal(json(await call('GET','/api/v1/export',b)).feedback_screenshots.length,0);
  passed('export includes the exact owner bytes and excludes operator notes and foreign images');
  const removed=await call('DELETE','/api/v1/account',a,{});
  assert.equal(removed.status,200,removed.body);
  const stored=await pg.fixture.admin.query(`SELECT count(*)::int AS n FROM "${pg.fixture.schema}".pilot_feedback_screenshot WHERE feedback_id=$1`,[id]);
  assert.equal(stored.rows[0].n,0);
  passed('account deletion removes the image file');
  // The special binary ceiling must never weaken the JSON limit on another route.
  assert.equal((await call('POST','/api/v1/feedback',b,{category:'bug',body:'x'.repeat(70000),route:'heute'})).status,413);
  passed('ordinary JSON retains its 64 KiB body ceiling');
  console.log(checks+'/'+checks+' upload/export/deletion groups passed');
} finally { await pg.teardown(); }

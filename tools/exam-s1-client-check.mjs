import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const root = path.resolve(process.argv[2] || '.');
const {createApi}=await import(pathToFileURL(path.join(root,'public/app/api.js')));
const first={id:'11111111-1111-4111-8111-111111111111',state:'active'};
const second={id:'22222222-2222-4222-8222-222222222222',state:'active'};
let responder=async(url)=>({ok:true,status:200,json:async()=>url==='/api/auth/get-session'?{user:{id:'synthetic-owner'}}:{}});
const requests=[];
const api=createApi({fetchImpl:async(url,init)=>{requests.push({url,...init}); return responder(url,init);},onSessionInvalid:()=>{}});
let passed=0; const check=async(name,run)=>{await run();passed++;console.log('PASS '+name);};
await api.session();
await check('missing preparation refuses scoped calls before transport',async()=>{
  const before=requests.length;
  for(const run of [()=>api.tasks.list(),()=>api.objectiveSets.list(),()=>api.objectiveSets.read('set','v2'),()=>api.practice.next(),()=>api.practice.progress(),()=>api.practice.mistakes(),()=>api.writing.listAttempts(),()=>api.writing.openAttempts(),()=>api.writing.createAttempt(),()=>api.practice.answer('set',{version:'v2'})]) assert.equal((await run()).error,'preparation_required');
  assert.equal(requests.length,before);
});
await check('selected context qualifies every catalogue and practice/history read',async()=>{
  assert.equal(api.preparations.select(first),true);
  for(const run of [()=>api.tasks.list({family:'writing'}),()=>api.objectiveSets.list(),()=>api.objectiveSets.read('set','v2'),()=>api.practice.next(),()=>api.practice.progress(),()=>api.practice.mistakes(),()=>api.writing.listAttempts(),()=>api.writing.openAttempts()]){
    assert.equal((await run()).ok,true); const url=new URL(requests.at(-1).url,'http://synthetic.test'); assert.equal(url.searchParams.get('preparationId'),first.id);assert.equal(requests.at(-1).headers['X-Hatoove-Account'],'synthetic-owner');
  }
});
await check('answers and new writing preserve binding and carry selected preparation',async()=>{
  const answer={version:'v2',itemId:'1',answer:'b'}; await api.practice.answer('set',answer);
  assert.deepEqual(JSON.parse(requests.at(-1).body),{...answer,preparationId:first.id});
  const binding={taskId:'task',taskVersion:'v2',rubricId:'rubric',rubricVersion:'v1'};await api.writing.createAttempt(binding);
  assert.deepEqual(JSON.parse(requests.at(-1).body),{...binding,preparationId:first.id});
  const count=requests.length;assert.equal((await api.writing.createAttempt({...binding,preparationId:second.id})).error,'preparation_mismatch');assert.equal(requests.length,count);
});
await check('switch fences late scoped response even when transport ignores abort',async()=>{
  let finish;responder=()=>new Promise(resolve=>{finish=resolve;});
  const old=api.practice.progress();api.preparations.select(second);
  finish({ok:true,status:200,json:async()=>({totals:{attempts:99}})});
  assert.equal((await old).error,'stale_preparation');
  responder=async()=>({ok:true,status:200,json:async()=>({})});
});
await check('switch and clear fence late transport rejection',async()=>{
  for(const change of [()=>api.preparations.select(second),()=>api.preparations.clear()]){
    api.preparations.select(first);let reject;
    responder=()=>new Promise((resolve,no)=>{reject=no;});
    const pending=api.practice.progress();change();reject(new Error('old request offline'));
    const result=await pending;assert.equal(result.error,'stale_preparation');assert.equal(result.status,409);
  }
  responder=async()=>({ok:true,status:200,json:async()=>({})});
});
await check('legacy settings date stays readable but cannot be written through account settings',async()=>{
  const {createOwnedClient}=await import(pathToFileURL(path.join(root,'public/js/owned-client.js')));
  let count=0;
  const transport=createOwnedClient({fetchImpl:async(url)=>{count++;return new Response(JSON.stringify(url==='/api/v1/account'?{id:'synthetic-owner',email:'fixture@example.test',contractVersion:'0.1.0'}:{revision:0,settings:{examDate:'2026-13-40',language:'de'}}),{status:200,headers:{'content-type':'application/json'}});}});
  await transport.refreshAccount();assert.equal((await transport.readSettings()).settings.examDate,'2026-13-40');
  const before=count;assert.throws(()=>transport.saveSettings({expectedRevision:0,settings:{examDate:'2027-01-01'}}),error=>error.code==='invalid_request');assert.equal(count,before);
});
await check('archived context reads history but refuses new work',async()=>{
  api.preparations.select({...second,state:'archived'});
  assert.equal((await api.writing.listAttempts()).ok,true);const before=requests.length;
  assert.equal((await api.practice.answer('set',{version:'v2'})).error,'preparation_archived');assert.equal((await api.writing.createAttempt()).error,'preparation_archived');assert.equal(requests.length,before);
});
await check('saved record operations and parent revisions retain immutable server context',async()=>{
  api.preparations.clear();await api.writing.readAttempt('saved');assert.equal(requests.at(-1).url,'/api/v1/attempts/saved');
  await api.writing.createAttempt({parentSubmissionId:'parent'});assert.deepEqual(JSON.parse(requests.at(-1).body),{parentSubmissionId:'parent'});
  await api.writing.saveDraft('saved',2,'draft');assert.deepEqual(JSON.parse(requests.at(-1).body),{expectedRevision:2,text:'draft'});
});
await check('preparation endpoints never infer identity or grant credits',async()=>{
  await api.preparations.create('telc-b1');assert.deepEqual(JSON.parse(requests.at(-1).body),{examId:'telc-b1'});
  await api.preparations.update(first.id,3,{examDate:'2027-01-30'});assert.deepEqual(JSON.parse(requests.at(-1).body),{examDate:'2027-01-30',expectedRevision:3});
  await api.preparations.credits(first.id);assert.equal(requests.at(-1).url,'/api/v1/preparations/'+first.id+'/credits');
});
await check('session expiry clears and prevents reusing preparation',async()=>{
  api.preparations.select(first);responder=async()=>({ok:false,status:401,json:async()=>({error:'unauthenticated'})});
  assert.equal((await api.practice.progress()).status,401);const count=requests.length;
  assert.equal(api.preparations.select(first),false);assert.equal((await api.practice.progress()).status,401);assert.equal(requests.length,count);
});
console.log(passed+' passed; synthetic transport only.');

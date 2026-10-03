import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const root = path.resolve(process.argv[2] || '.');
const { createMockSession, mockMember } = await import(pathToFileURL(path.join(root, 'public/app/mock.js')));
const { createApi } = await import(pathToFileURL(path.join(root, 'public/app/api.js')));
const copy = value => JSON.parse(JSON.stringify(value));
const member = { set_id: 'fixture.lv1', version: 'v1', interaction: 'matching_headlines', item_count: 2, payload: { headlines: [{id:'a',text:'Alpha'}, {id:'b',text:'Beta'}], texts:[{id:'1',text:'One'}, {id:'2',text:'Two'}] } };
const base = { id:'saved-run', preparation_id:'11111111-1111-4111-8111-111111111111', revision:1, state:'active', members:[member], responses:[], position:{member:0,item:0}, result:null, expired:false, blocked_reason:null };
let passed = 0;
const check = async (name, test) => { await test(); passed++; console.log('PASS ' + name); };
function setup(extra = {}) {
  let saved = copy(base), serial = 0, transport = null, writes = [];
  const receipts = new Map();
  const perform = async (kind, id, body) => {
    writes.push({ kind, id, body: copy(body) });
    if (transport) { const intercepted = await transport(kind, id, body); if (intercepted) return intercepted; }
    if (receipts.has(body.eventId)) return copy(receipts.get(body.eventId));
    if (body.expectedRevision !== saved.revision) return {ok:false,status:409,error:'revision_conflict'};
    if (kind === 'save') saved = {...saved, revision:saved.revision+1, responses:copy(body.responses), position:copy(body.position)};
    else saved = {...saved,state:'finalised',result:{items:[],total:2,answered:saved.responses.length,unanswered:2-saved.responses.length,correct:0}};
    const response={ok:true,status:200,data:copy(saved)}; receipts.set(body.eventId,response); return response;
  };
  const session = createMockSession({api:{mock:{ save:(...args)=>perform('save',...args), finalise:(...args)=>perform('finalise',...args), read:async()=>({ok:true,status:200,data:copy(saved)})}}, eventId:()=> 'event-' + ++serial, ...extra});
  session.load(base);
  return {session,writes,get saved(){return saved;}, set saved(value){saved=copy(value);}, intercept(value){transport=value;}};
}
await check('interaction adapters preserve exact item and offered option identities', async()=>{
  assert.deepEqual(mockMember(member).items.map(v=>v.id),['1','2']);
  assert.equal(mockMember({interaction:'matching_ads',payload:{ads:[{id:'a',text:'Ad'}],situations:[{n:11,text:'Need'}]}}).options.at(-1).id,'x');
  assert.equal(mockMember({interaction:'single_choice',payload:{text:'Text',questions:[{n:6,question:'Which?',options:{a:'A',b:'B'}}]}}).items[0].options[1].id,'b');
  assert.equal(mockMember({interaction:'unknown'}),null);
});
await check('active selection stores no local correctness and persists exact full snapshot', async()=>{
  const {session,writes}=setup();session.answer(member,'1','b');assert.equal(session.state().run.result,null);
  assert.equal(await session.flush(),true);assert.deepEqual(writes[0].body,{expectedRevision:1,eventId:'event-1',responses:[{setId:'fixture.lv1',version:'v1',itemId:'1',answer:'b'}],position:{member:0,item:0}});
  assert.equal(session.state().dirty,false);
});
await check('lost response retries the same event and body before saving newer local selection', async()=>{
  const fixture=setup();let fail=true;
  fixture.intercept(async()=>fail?{ok:false,status:0,error:'network'}:null);
  fixture.session.answer(member,'1','a');assert.equal(await fixture.session.flush(),false);
  const first=copy(fixture.writes[0]);fixture.session.answer(member,'2','b');fail=false;
  assert.equal(await fixture.session.flush(),true);assert.deepEqual(fixture.writes[1],first);assert.equal(fixture.writes[2].body.expectedRevision,2);assert.equal(fixture.saved.responses.length,2);
});
await check('parallel flushes serialize and preserve edits made while the first save is pending', async()=>{
  const fixture=setup();let release;fixture.intercept(()=>new Promise(resolve=>{release=()=>{fixture.intercept(null);resolve(null);};}));
  fixture.session.answer(member,'1','a');const one=fixture.session.flush(), two=fixture.session.flush();
  fixture.session.answer(member,'2','b');assert.equal(fixture.writes.length,1);release();
  assert.deepEqual(await Promise.all([one,two]),[true,true]);assert.equal(fixture.writes.length,2);assert.equal(fixture.saved.responses.length,2);
});
await check('current-safe retry response cannot overwrite a newer tab automatically', async()=>{
  const fixture=setup();fixture.session.answer(member,'1','b');fixture.intercept(async()=>({ok:true,status:200,data:{...base,revision:3,responses:[{setId:member.set_id,version:'v1',itemId:'1',answer:'a'}]}}));
  assert.equal(await fixture.session.flush(),false);assert.equal(fixture.session.state().responses[0].answer,'b');assert.equal(fixture.session.state().error.status,409);assert.equal(fixture.writes.length,1);
});
await check('conflict blocks leaving and keeps selections plus an explicit reload copy', async()=>{
  const fixture=setup();fixture.session.answer(member,'1','b');fixture.saved={...fixture.saved,revision:2};
  assert.equal(await fixture.session.flush(),false);assert.equal(fixture.session.state().responses[0].answer,'b');
  assert.equal(await fixture.session.reload(),true);assert.match(fixture.session.state().localCopy,/"answer": "b"/);assert.deepEqual(fixture.session.state().responses,[]);assert.equal(fixture.session.state().run.revision,2);
});
await check('failed part navigation keeps local answers and does not acknowledge a new position', async()=>{
  const fixture=setup();fixture.session.answer(member,'1','a');fixture.intercept(async()=>({ok:false,status:0,error:'network'}));
  assert.equal(await fixture.session.move({member:0,item:1}),false);assert.deepEqual(fixture.session.state().position,{member:0,item:0});assert.equal(fixture.session.state().responses[0].answer,'a');
});
await check('finalise first saves answers and freezes the returned result', async()=>{
  const fixture=setup();fixture.session.answer(member,'1','a');assert.equal(await fixture.session.finalise(),true);
  assert.deepEqual(fixture.writes.map(v=>v.kind),['save','finalise']);assert.equal(fixture.writes[1].body.expectedRevision,2);assert.equal(fixture.session.state().writable,false);assert.equal(fixture.session.answer(member,'2','b'),false);
});
await check('uncertain finalise retry keeps its event and cannot create a second finalise', async()=>{
  const fixture=setup();let failed=false;fixture.intercept(async kind=>kind==='finalise'&&!failed?(failed=true,{ok:false,status:0,error:'network'}):null);
  assert.equal(await fixture.session.finalise(),false);assert.equal(await fixture.session.flush(),true);assert.deepEqual(fixture.writes[0],fixture.writes[1]);assert.equal(fixture.session.state().run.state,'finalised');
});
await check('session expiry preserves unsaved answers and refuses navigation', async()=>{
  let allowed=true;const fixture=setup({canEdit:()=>allowed});fixture.session.answer(member,'1','b');allowed=false;
  assert.equal(await fixture.session.flush(),false);assert.equal(fixture.writes.length,0);assert.equal(fixture.session.state().responses[0].answer,'b');
});
await check('obsolete save acknowledgement cannot replace a newly loaded run', async()=>{
  const fixture=setup();let release;fixture.intercept(()=>new Promise(resolve=>{release=()=>resolve({ok:true,status:200,data:{...base,revision:8}});}));
  fixture.session.answer(member,'1','a');const pending=fixture.session.flush();fixture.session.load({...base,id:'other'});release();assert.equal(await pending,false);assert.equal(fixture.session.state().run.id,'other');
});
await check('archived and rights-blocked runs remain read-only', async()=>{
  const archived=setup({canEdit:()=>false});assert.equal(archived.session.answer(member,'1','a'),false);assert.equal(await archived.session.finalise(),false);
  const blocked=setup();blocked.session.load({...base,blocked_reason:'rights',members:[]});assert.equal(blocked.session.answer(member,'1','a'),false);assert.equal(await blocked.session.finalise(),false);
});
await check('deadline uses server time and preserves unacknowledged answers on expiry', async()=>{
  let now=1000;const fixture=setup({now:()=>now});const timed={...base,server_now:new Date(10000).toISOString(),deadline_at:new Date(11000).toISOString()};fixture.saved=timed;fixture.session.load(timed);
  fixture.session.answer(member,'1','b');now=2001;assert.equal(fixture.session.state().writable,false);assert.equal(await fixture.session.flush(),false);assert.equal(fixture.writes.length,0);
  fixture.saved={...timed,server_now:new Date(11001).toISOString(),expired:true};await fixture.session.reload();assert.match(fixture.session.state().localCopy,/"b"/);assert.equal(await fixture.session.finalise(),true);
});
await check('new document state resumes acknowledged answers only', async()=>{
  const first=setup();first.session.answer(member,'1','a');await first.session.flush();first.session.answer(member,'2','b');
  const next=setup();next.session.load(first.saved);assert.equal(next.session.state().responses.length,1);assert.equal(next.session.state().dirty,false);
});
await check('API qualifies starts/lists and leaves owned run identities immutable', async()=>{
  const requests=[];const api=createApi({fetchImpl:async(url,init)=>{requests.push({url,...init});return {ok:true,status:200,json:async()=>url.includes('get-session')?{user:{id:'owner'}}:{}};},onSessionInvalid:()=>{}});
  await api.session();assert.equal((await api.mock.forms()).error,'preparation_required');api.preparations.select({id:base.preparation_id,state:'active'});
  await api.mock.forms();assert.equal(requests.at(-1).url,'/api/v1/mock-forms?preparationId='+base.preparation_id);
  await api.mock.start({formId:'reading',formVersion:'v1',releaseVersion:'v1',eventId:'event'});assert.equal(JSON.parse(requests.at(-1).body).preparationId,base.preparation_id);
  api.preparations.clear();await api.mock.read('original');assert.equal(requests.at(-1).url,'/api/v1/mock-runs/original');
  await api.mock.finalise('original',{expectedRevision:2,eventId:'same'});assert.deepEqual(JSON.parse(requests.at(-1).body),{expectedRevision:2,eventId:'same'});
});
await check('API fences save replies from a superseded preparation', async()=>{
  let release;const api=createApi({fetchImpl:async url=>url.includes('get-session')?{ok:true,status:200,json:async()=>({user:{id:'owner'}})}:new Promise(resolve=>{release=()=>resolve({ok:true,status:200,json:async()=>base});}),onSessionInvalid:()=>{}});
  await api.session();api.preparations.select({id:base.preparation_id,state:'active'});const pending=api.mock.save('original',{});api.preparations.clear();release();assert.equal((await pending).error,'stale_preparation');
});
console.log(passed+' passed; synthetic transport and pure controller checks only.');

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { LOCALES, setLocale, getLocale, validLocale, t } from '../public/assets/i18n/core.js';
import { shellMessages } from '../public/assets/i18n/shell-messages.js';
import { createLocalePreference, bindShellText, updateShellMessages, messageMarkup, s } from '../public/app/locale-preference.js';
import { checkoutMarkup, checkoutError, createCheckoutController, createCheckoutState } from '../public/app/checkout.js';
import { preparationChoices } from '../public/app/preparation.js';
import { guideContent } from '../public/app/guide-content.js';
import { INSTRUCTIONS, instructionMarkup } from '../public/assets/i18n/instructions.js';

let passed = 0;
const check = async (name, fn) => { await fn(); passed++; console.log('PASS ' + name); };
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const response = (language, revision, theme = 'dark') => ({ ok:true, status:200, data:{ revision,settings:{language,theme,dailyGoal:20} } });
const esc = value => String(value ?? '').replace(/[&<>"']/g,c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function preference({ write, read } = {}) {
  let owner = 'account-a', confirmed = response('de',3).data;
  const writes = [], reads = [], accepted = [], states = [];
  const model = createLocalePreference({ context:() => owner, confirmed:() => confirmed,
    write:async (...args) => { writes.push(structuredClone(args)); return write ? write(...args) : response(args[1].language,args[0]+1); },
    read:async () => { reads.push(owner); return read ? read() : response('ar',4); },
    accept:(data,options) => { confirmed = structuredClone(data); accepted.push({data:confirmed,options}); },
    changed:state => states.push(state),
  });
  return {model,writes,reads,accepted,states,get confirmed(){return confirmed;},switchOwner(value){owner=value;model.cancel();},setConfirmed(value){confirmed=value;}};
}

await check('all five shell dictionaries have exact keys and interpolation coverage', () => {
  const keys = Object.keys(shellMessages.de).sort(); assert.ok(keys.length > 400);
  for (const locale of LOCALES) {
    assert.deepEqual(Object.keys(shellMessages[locale]).sort(),keys);
    for (const key of keys) {
      const params = Object.fromEntries([...shellMessages.de[key].matchAll(/\{(\w+)\}/g)].map(match=>[match[1],'SYNTHETIC']));
      assert.equal(t('shell.'+key,params,locale),shellMessages[locale][key].replace(/\{\w+\}/g,'SYNTHETIC'));
    }
  }
});
await check('message markup escapes malicious dynamic parameters and unknown UI text', () => {
  setLocale('ar'); const payload = '<img src=x onerror="private()">';
  const markup = messageMarkup('welcomeName',{name:payload});
  assert.ok(markup.includes('&lt;img')); assert.ok(!markup.includes('<img')); assert.ok(!markup.includes('onerror="'));
  assert.ok(markup.includes('lang="ar" dir="rtl"'));
  assert.equal(messageMarkup(payload),esc(payload));
});
await check('a locale save sends only language at the confirmed revision and waits for authority', async () => {
  const held=deferred(),f=preference({write:()=>held.promise}); const saving=f.model.save('uk');
  assert.equal(f.confirmed.settings.language,'de'); assert.equal(f.model.busy,true);
  assert.deepEqual(f.writes,[[3,{language:'uk'}]]); assert.equal(await f.model.save('ar'),false);
  held.resolve(response('uk',4)); assert.equal(await saving,true);
  assert.equal(f.confirmed.settings.language,'uk'); assert.equal(f.confirmed.settings.theme,'dark');
  assert.deepEqual(f.accepted[0].options,{persist:true}); assert.equal(f.reads.length,0);
});
await check('a committed save with a lost response reconciles by one read without repeating mutation', async () => {
  const f=preference({write:()=>({ok:false,status:0}),read:()=>response('tr',4,'light')});
  assert.equal(await f.model.save('tr'),false);
  assert.deepEqual(f.writes,[[3,{language:'tr'}]]); assert.equal(f.reads.length,1);
  assert.equal(f.confirmed.settings.language,'tr'); assert.equal(f.confirmed.settings.theme,'light');
  assert.equal(f.model.status,'reconciled'); assert.deepEqual(f.accepted[0].options,{persist:false});
});
await check('unknown save plus failed read blocks further writes until an explicit successful read', async () => {
  let available=false; const f=preference({write:()=>{throw Error('network');},read:()=>available?response('ar',4):{ok:false,status:0}});
  await f.model.save('ar'); assert.equal(f.confirmed.settings.language,'de'); assert.equal(f.model.unresolved,true);
  assert.equal(await f.model.save('en'),false); assert.equal(f.writes.length,1);
  available=true; assert.equal(await f.model.reconcile(),true); assert.equal(f.confirmed.settings.language,'ar');
  assert.equal(f.writes.length,1); assert.equal(f.model.unresolved,false);
});
await check('conflict reads current settings and an explicit retry cannot overwrite unrelated fields', async () => {
  let conflict=true; const f=preference({write:(revision,patch)=>conflict?{ok:false,status:409}:response(patch.language,revision+1,'light'),read:()=>response('en',4,'light')});
  await f.model.save('uk'); assert.equal(f.model.status,'conflict'); assert.equal(f.confirmed.settings.theme,'light');
  assert.equal(f.writes.length,1); conflict=false; await f.model.save('uk');
  assert.deepEqual(f.writes,[[3,{language:'uk'}],[4,{language:'uk'}]]);
});
await check('an explicit refusal preserves confirmed language without a speculative read or write retry', async () => {
  const f=preference({write:()=>({ok:false,status:403})}); await f.model.save('en');
  assert.equal(f.confirmed.settings.language,'de'); assert.equal(f.model.status,'failed'); assert.equal(f.reads.length,0); assert.equal(f.writes.length,1);
  for(const invalid of ['EN','en-GB',null,{},'__proto__']) assert.equal(await f.model.save(invalid),false);
  assert.equal(f.writes.length,1);
});
await check('account generation fences delayed save and delayed reconciliation replies', async () => {
  const first=deferred(),f=preference({write:()=>first.promise});const saving=f.model.save('ar');f.switchOwner('account-b');first.resolve(response('ar',4));await saving;assert.equal(f.accepted.length,0);
  const second=deferred(),g=preference({write:()=>({status:0}),read:()=>second.promise});const reconciling=g.model.save('tr');await new Promise(r=>setImmediate(r));g.switchOwner('account-b');second.resolve(response('tr',4));await reconciling;assert.equal(g.accepted.length,0);
});
await check('BFCache suspension fences a held save and rereads authority before enabling language changes', async () => {
  const held = deferred(), reread = deferred();
  const f = preference({ write: () => held.promise, read: () => reread.promise });
  const saving = f.model.save('uk');
  f.model.suspend();
  assert.equal(f.model.unresolved, true); assert.equal(f.model.busy, false);
  assert.equal(f.states.at(-1).state, 'unresolved');
  assert.equal(await f.model.save('tr'), false); assert.equal(f.writes.length, 1);
  const restored = f.model.reconcile();
  assert.equal(f.model.busy, true); assert.equal(f.states.at(-1).state, 'reconciling');
  held.resolve(response('uk', 4)); await saving;
  assert.equal(f.accepted.length, 0, 'the reply from before pagehide cannot update a restored page');
  reread.resolve(response('ar', 5)); assert.equal(await restored, true);
  assert.equal(f.confirmed.settings.language, 'ar'); assert.equal(f.model.unresolved, false); assert.equal(f.model.busy, false);
  assert.equal(f.writes.length, 1, 'restoring performs no mutation or replay');
});
await check('failed BFCache read keeps writes blocked and owner changes fence its late response', async () => {
  const f = preference({ read: () => ({ ok: false, status: 0 }) });
  f.model.suspend(); await f.model.reconcile(); assert.equal(f.model.unresolved, true);
  assert.equal(await f.model.save('tr'), false); assert.equal(f.writes.length, 0);
  const held = deferred(), g = preference({ read: () => held.promise });
  g.model.suspend(); const reading = g.model.reconcile(); g.switchOwner('account-b');
  held.resolve(response('ar', 5)); await reading; assert.equal(g.accepted.length, 0);
});
await check('a response older than a newer confirmed revision cannot regress the preference', async () => {
  const held=deferred(),f=preference({write:()=>held.promise,read:()=>response('uk',6)});
  const saving=f.model.save('ar');f.setConfirmed(response('en',5).data);held.resolve(response('ar',4));await saving;
  assert.equal(f.confirmed.settings.language,'uk');assert.equal(f.confirmed.revision,6);assert.equal(f.reads.length,1);
});

function textNode() {
  return {isConnected:true,children:[],attributes:new Map(),querySelectorAll:()=>[],removeAttribute(key){this.attributes.delete(key);},
    set textContent(value){if(this.firstChild)this.firstChild.parentNode=null;this.firstChild={data:String(value),parentNode:this};this.children=[];},
    get textContent(){return this.firstChild?.data||'';},replaceChildren(){this.textContent='';},contains(child){return this===child;},matches:()=>false};
}
await check('dashboard title bindings keep authored language and reset translated fallback annotations', async () => {
  const source = await readFile(new URL('../public/app/app.js', import.meta.url), 'utf8');
  const body = source.slice(source.indexOf('function bindDashboardTitle('), source.indexOf('async function renderDashboard()'));
  const node = textNode();
  const bind = new Function('el', 'bindShellText', 'getLocale', body + ';return bindDashboardTitle;')(() => node, bindShellText, getLocale);
  for (const language of ['de', 'en', 'ar', null]) {
    bind(() => 'Exact authored title', () => language); const text = node.firstChild;
    for (const locale of LOCALES) { setLocale(locale); updateShellMessages(node); assert.equal(node.firstChild, text); assert.equal(node.textContent, 'Exact authored title'); assert.equal(node.lang, language || 'und'); assert.equal(node.dir, language === 'ar' ? 'rtl' : 'ltr'); }
  }
  bind(() => s('m106')); const text = node.firstChild;
  for (const locale of LOCALES) { setLocale(locale); updateShellMessages(node); assert.equal(node.firstChild, text); assert.equal(node.textContent, s('m106')); assert.equal(node.lang, locale); assert.equal(node.dir, locale === 'ar' ? 'rtl' : 'ltr'); }
  node.isConnected = false;
});
await check('locale text updates preserve a recovery control, active editor and audio identities', () => {
  setLocale('de');const status=textNode(),button={id:'retry'},editor={value:'Ungespeichert',selectionStart:4},audio={currentTime:8.2};
  bindShellText(status,()=>s('m185'));const originalText=status.firstChild;status.children.push(button,editor,audio);
  setLocale('ar');updateShellMessages(status);
  assert.equal(status.firstChild,originalText);assert.equal(status.textContent,s('m185'));
  assert.deepEqual(status.children,[button,editor,audio]);assert.equal(editor.value,'Ungespeichert');assert.equal(editor.selectionStart,4);assert.equal(audio.currentTime,8.2);
  status.isConnected=false;let calls=0;const removed=textNode();bindShellText(removed,()=>{calls++;return s('m196');});removed.isConnected=false;updateShellMessages(removed);assert.equal(calls,1);
});
await check('checkout states render translated bounded labels in all five languages without changing prices', () => {
  const offer={displayPrice:'12,00 €',termDays:30,allowance:4,existing:{allowance:4,used:1,reserved:1,expiresAt:null}};
  for(const locale of LOCALES){setLocale(locale);for(const mode of ['loading','market','ready','existing','starting','pending','paid','refunded','disputed','failed','unavailable','missing','no_exam','invalid','error']){
    const html=checkoutMarkup({mode,busy:false,examLabel:'telc Deutsch B1',offer,order:['paid','refunded','disputed'].includes(mode)?{id:'test-order',examId:'telc',entitlement:offer.existing}:null,orderId:null,operation:null,markets:[],autoChecks:0,testMode:true,error:checkoutError({status:0}),retry:'read'},esc);
    assert.ok(html.includes(s('m264')));assert.ok(!html.includes('undefined'));assert.ok(!html.includes('Translation unavailable.'));
    if(mode==='ready'){assert.ok(html.includes('12,00 €'));assert.ok(html.includes(s('feedbackCount',{count:4})));}
  }}
});
await check('checkout locale hook does not rerender, refetch, change market or recreate a pending payment event', async () => {
  const calls=[],held=deferred();let captured;const offer={examId:'telc',market:'DE',currency:'EUR',testMode:true,amountMinor:1200,displayPrice:'12,00 €',allowance:4,termDays:30,purchasable:true};
  const api={payments:{offer:async(exam,market)=>{calls.push('offer');return{ok:true,data:{testMode:true,markets:[{market:'DE',currency:'EUR'}],offer:market?offer:null}};},startSession:async body=>{captured=structuredClone(body);calls.push('start');return held.promise;}}};
  const session=createCheckoutState({api,eventId:()=> 'fixed-event',navigate:()=>{}});await session.open({examId:'telc'});await session.loadOffer('DE');const pending=session.start();setLocale('ar');assert.equal(session.snapshot().operation.eventId,'fixed-event');assert.equal(session.snapshot().market,'DE');held.resolve({ok:false,status:0});await pending;assert.deepEqual(captured,{examId:'telc',market:'DE',eventId:'fixed-event'});assert.equal(calls.filter(c=>c==='start').length,1);
  let writes=0;const host=textNode();Object.defineProperty(host,'innerHTML',{set(){writes++;},get(){return'';}});host.hidden=true;host.dataset={};host.querySelector=()=>null;
  const oldDocument=globalThis.document;globalThis.document={activeElement:null,querySelectorAll:()=>[],documentElement:{}};
  try{const controller=createCheckoutController({api,esc});await controller.open(host,{invalid:true});const before=writes;controller.updateLocale('uk');assert.equal(writes,before);controller.dispose();}finally{globalThis.document=oldDocument;}
});
await check('preparation choices localize actions without changing exam identity or selection keys', () => {
  const exams=[{exam_id:'telc',exam:'telc Deutsch B1'},{exam_id:'dtz',exam:'Deutsch-Test'}],preps=[{id:'owned',exam_id:'telc',exam:'telc Deutsch B1',state:'archived'}];
  for(const locale of LOCALES){setLocale(locale);const rows=preparationChoices(exams,preps);assert.equal(rows[0].id,'owned');assert.equal(rows[0].label,'telc Deutsch B1 · '+s('archive'));assert.ok(rows.find(r=>r.id==='new:dtz').label.endsWith(s('begin')));}
});
await check('library material remains original with explicit English alternatives and escaped content', () => {
  const payload={rule:'Deutsche Originalregel',ruleEn:'Existing English rule',example:{de:'Ich lerne.',en:'I am learning.'},bad:'<img onerror=evil()>'};
  for(const locale of LOCALES){setLocale(locale);const html=guideContent(payload,esc,locale);assert.ok(html.includes('Deutsche Originalregel'));assert.ok(html.includes('lang="de" dir="ltr"'));assert.ok(html.includes('Existing English rule'));assert.ok(html.includes('data-authored-alternative="en"'));assert.ok(!html.includes('<img'));assert.ok(html.includes(s('m267')));}
});
await check('an English guide-table alternative keeps German grammar cells explicitly German', () => {
  setLocale('ar');
  const table = { headers: ['Fall', 'Beispiel'], headersEn: ['Case', 'Example'], rows: [['Nominativ', 'Der Mann liest.']], firstColumnEn: ['Nominative'] };
  const html = guideContent(table, esc, 'en');
  assert.match(html, /<th scope="col" lang="en" dir="ltr">Case<\/th>/);
  assert.match(html, /<td lang="en" dir="ltr">Nominative<\/td>/);
  assert.equal((html.match(/<td lang="de" dir="ltr">Der Mann liest\.<\/td>/g) || []).length, 2);
  assert.doesNotMatch(html, /<table lang="en"/);
  assert.deepEqual(table.rows, [['Nominativ', 'Der Mann liest.']]);
});
await check('shell locale entry point calls label-only hooks and settings send no stale theme patch', async () => {
  const source=await readFile(new URL('../public/app/app.js',import.meta.url),'utf8');
  const hook=source.slice(source.indexOf('function updateLocaleLabels()'),source.indexOf('const unsubscribeLocale'));
  for(const name of ['writing','mock','explanations','readAloud','checkout'])assert.match(hook,new RegExp(name+'\\.updateLocale'));
  assert.doesNotMatch(hook,/api\.|\.open\(|\.mount\(|renderSettings\(|route\(|innerHTML\s*=/);
  assert.match(source,/write: \(revision, patch\) => api\.settings\.write\(revision, patch\)/);assert.doesNotMatch(source,/theme:\s*state\.settings/);
  assert.match(source,/state\.preparation\?\.exam_language/);assert.match(source,/instructionMarkup\(\{ id: form\.interaction/);
  assert.match(source,/const view = VIEW_TITLES\[key\] \? key : 'heute'/);
  assert.doesNotMatch(source,/esc\([^\n;]*\|\| messageMarkup/);
});
await check('actual Arabic dictionary rendering isolates every authored German field', async () => {
  const source=await readFile(new URL('../public/app/app.js',import.meta.url),'utf8');
  const render=source.slice(source.indexOf('async function renderDictionary()'),source.indexOf('/** NACHSCHLAGEN'));
  const row={de:'SENTINEL Wort',gender:'SENTINEL Geschlecht',plural:'SENTINEL Plural',theme:'SENTINEL Thema',rule:'SENTINEL Regel',pos:'SENTINEL Wortart',example:'SENTINEL Beispiel',en:'English alternative'};
  for (const mode of ['nouns','vocab']) {
    let html=''; const box={querySelectorAll:()=>[]};
    const factory=new Function('api','el','setShellHTML','readAloud','materialNotice','messageMarkup','getLocale','esc','uiText','dictMode',`let dictionaryRequest=0; ${render}; return renderDictionary;`);
    const list=async()=>({ok:true,data:[row]});
    setLocale('ar');
    await factory({nouns:{list},vocab:{list}},id=>id==='dict-results'?box:{value:''},(_node,value)=>{html=value;},{clear(){},mount(){}},()=>'',messageMarkup,getLocale,esc,s,mode)();
    for(const field of mode==='nouns'?['de','gender','plural','theme','rule','example']:['de','pos','plural','example']) {
      const offset=html.indexOf(row[field]); assert.ok(offset>0,field+' is preserved');
      const opening=html.slice(html.lastIndexOf('<',offset),offset);
      assert.match(opening,/lang="de" dir="ltr"/,field+' has its own original-language island');
    }
    assert.ok(html.includes('data-i18n="shell.m072"')); assert.ok(html.includes('data-authored-alternative="en" hidden'));
  }
});
await check('actual BFCache handlers suspend writes and reconcile a restored owned page without remounting', async () => {
  const source=await readFile(new URL('../public/app/app.js',import.meta.url),'utf8');
  const hooks=source.slice(source.indexOf("window.addEventListener('pagehide', event =>"),source.indexOf("el('header-language').addEventListener('change'"));
  const events=new Map(),calls=[];
  new Function('window','localePreference','readAloud','unsubscribeLocale','state','sessionProblem','guard',hooks)(
    {addEventListener:(name,callback)=>events.set(name,callback)},
    {suspend:()=>calls.push('suspend'),cancel:()=>calls.push('cancel'),reconcile:()=>{calls.push('read');return Promise.resolve();}},
    {stop:()=>calls.push('stop')},()=>calls.push('unsubscribe'),{account:{id:'same-owner'}},null,()=>{});
  events.get('pagehide')({persisted:true}); assert.deepEqual(calls,['suspend','stop']);
  events.get('pageshow')({persisted:true}); assert.deepEqual(calls,['suspend','stop','read']);
  events.get('pagehide')({persisted:false}); assert.deepEqual(calls.slice(-3),['unsubscribe','cancel','stop']);
  assert.match(source,/header-language'\)\.disabled = busy \|\| unresolved/);
});
await check('actual shell objective rendering keeps exam language and immutable options under Arabic chrome', async () => {
  const source=await readFile(new URL('../public/app/app.js',import.meta.url),'utf8');
  const render=source.slice(source.indexOf('function renderObjectiveForm('),source.indexOf('/** Post one answer'));
  let html='', examLanguage='en';
  const form={interaction:'single_choice',passages:[{label:'m131',lines:['Original English passage <untouched>']}],items:[{id:'1',prompt:'Original English question?',options:[{id:'a',label:'Original English answer'},{id:'b',label:'Other answer'}]}]};
  const execute=new Function('objectiveForm','setShellHTML','INSTRUCTIONS','instructionMarkup','getExamLanguage','examTextAttributes','messageMarkup','esc',render+'; return renderObjectiveForm;')(
    ()=>form,(_host,value)=>{html=value;},INSTRUCTIONS,instructionMarkup,()=>examLanguage,()=>`lang="${examLanguage||'und'}" dir="ltr"`,messageMarkup,esc);
  setLocale('ar'); execute({payload:{}},{});
  assert.match(html,/lang="en" dir="ltr">Original English question\?/);
  assert.ok(html.includes('Original English passage &lt;untouched&gt;'));
  /*
   * REDESIGN-01 C changed the tile markup (letter badge, label, verdict slot), so this asserts the parts
   * that must survive any restyle: the option id stays the bare `data-answer`, the visible text still opens
   * with the letter and then the authored label, and the label is rendered in full.
   */
  const tile=html.match(/<button class="btn answer-option"[^>]*data-answer="([^"]+)"[^>]*>([\s\S]*?)<\/button>/);
  assert.ok(tile,'the option renders as a tile button');
  assert.equal(tile[1],'a','the tile carries the bare option id');
  assert.match(tile[2],/^<span class="answer-letter"[^>]*>a\)\s*<\/span>/, 'the letter stays visible and unescaped');
  assert.ok(tile[2].includes('Original English answer'),'the authored label is rendered in full');
  assert.ok(html.includes('lang="ar"')); assert.ok(!html.includes(INSTRUCTIONS.single_choice.original));
  examLanguage='de';execute({payload:{}},{});assert.ok(html.includes(INSTRUCTIONS.single_choice.original));
  examLanguage=null;execute({payload:{}},{});assert.match(html,/lang="und" dir="ltr">Original English question\?/);
  assert.equal(form.items[0].options[0].label,'Original English answer');
});
await check('actual shell locale hook updates declared leaves without replacing active state or making requests', async () => {
  const source=await readFile(new URL('../public/app/app.js',import.meta.url),'utf8');
  const hook=source.slice(source.indexOf('function updateLocaleLabels()'),source.indexOf('const unsubscribeLocale'));
  const calls=[], header={value:'de'}, option={value:'owned',textContent:'old'}, editor={value:'Unsent',selectionStart:2,composing:true},audio={currentTime:3.75,paused:false};
  const notice={hidden:false},review={dataset:{reviewFacts:'{"review_status":"approved"}',shellReview:'label'},textContent:'old'};
  const document={querySelectorAll:selector=>selector==='[data-shell-review]'?[review]:selector==='[data-material-unavailable]'?[notice]:[]};
  const controller=name=>({updateLocale:locale=>calls.push([name,locale]),stop:()=>calls.push(['stop'])});
  const execute=new Function('updateShellMessages','updatePracticeLocale','translateInstructions','document','contentReviewLabel','reviewHistoryNotice','writing','mock','explanations','readAloud','sentenceCheck','checkout','getLocale','el','preparationChoices','state',hook+'; return updateLocaleLabels;')(
    ()=>calls.push(['shell']),()=>calls.push(['practice']),()=>calls.push(['instructions']),document,()=>s('m090'),()=>s('m153'),controller('writing'),controller('mock'),controller('explanations'),controller('speech'),controller('sentence'),controller('checkout'),getLocale,
    id=>id==='header-language'?header:{options:[option]},preparationChoices,{exams:[],preparations:[{id:'owned',exam_id:'telc',exam:'telc Deutsch B1',state:'active'}]});
  setLocale('uk');execute();assert.equal(header.value,'uk');assert.equal(option.value,'owned');assert.equal(option.textContent,'telc Deutsch B1 · '+s('m110'));
  assert.equal(review.textContent,s('m090'));assert.equal(notice.hidden,false);
  for(const name of ['writing','mock','explanations','speech','sentence','checkout'])assert.equal(calls.filter(c=>c[0]===name&&c[1]==='uk').length,1);
  assert.equal(calls.filter(c=>c[0]==='stop').length,1);
  assert.equal(calls.filter(c=>c[0]==='practice').length,1);
  assert.deepEqual(editor,{value:'Unsent',selectionStart:2,composing:true});assert.deepEqual(audio,{currentTime:3.75,paused:false});
});
await check('actual account refresh overrides the guest locale, ignores old revisions and fences account changes', async () => {
  const source=await readFile(new URL('../public/app/app.js',import.meta.url),'utf8');
  const accept=source.slice(source.indexOf('function acceptLocaleSettings('),source.indexOf('const localePreference ='));
  const refresh=source.slice(source.indexOf('async function refresh()'),source.indexOf('// ---------------------------------------------------------------- actions'));
  let settingsResponse=response('ar',4), read=async()=>settingsResponse;
  const calls=[], fields={language:{value:'en'},'header-language':{value:'en'}};
  const api={account:{read:async()=>({ok:true,data:{id:'owner-a',email:'synthetic@example.invalid'}})},settings:{read:()=>read()}};
  const factory=new Function('api','getLocale','setLocale','validLocale','el','explanations','uiText',`let state={account:null,settings:null,revision:null},accountGeneration=0,sessionProblem=null,bootReady=false;
    const showError=()=>{},renderAccount=()=>{},renderSettings=()=>{},renderChrome=()=>{},guard=()=>{};
    ${accept}\n${refresh}\nreturn {refresh,acceptLocaleSettings,state,changeAccount(){accountGeneration++;},block(){sessionProblem='account_changed';}};`);
  const app=factory(api,getLocale,setLocale,validLocale,id=>fields[id],{refresh:language=>calls.push(language)},s);
  setLocale('en');assert.equal(await app.refresh(),true);assert.equal(getLocale(),'ar');assert.equal(fields.language.value,'ar');assert.deepEqual(calls,['ar']);
  app.acceptLocaleSettings(response('uk',6).data);assert.equal(getLocale(),'uk');settingsResponse=response('tr',5);await app.refresh();assert.equal(getLocale(),'uk');assert.equal(app.state.revision,6);
  const held=deferred();read=()=>held.promise;const pending=app.refresh();await new Promise(r=>setImmediate(r));app.changeAccount();held.resolve(response('de',7));assert.equal(await pending,false);assert.equal(getLocale(),'uk');
  assert.deepEqual(calls,['ar','uk']);
});
setLocale('de');
console.log(`Shell locale: ${passed} checks passed.`);

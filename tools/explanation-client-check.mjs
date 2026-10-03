/** Saved-prose client checks: synthetic DTOs/transports only; no service, provider or database. */
import assert from 'node:assert/strict';
import { setLocale } from '../public/assets/i18n/core.js';
// These retained copy assertions deliberately exercise the German interface.
setLocale('de');
import {createExplanationState,createExplanationManager,validExplanationView,explanationStatus} from '../public/app/explanations.js';
import {createApi} from '../public/app/api.js';
import {createLocalSpeech} from '../public/app/read-aloud.js';
import {explanationProviderProbeSource} from './explanation-browser.mjs';
const langs=['de','en','uk','ar','tr'],review={review_status:'unreviewed',review_basis:'none',blocked:false,explicit_negative:false};
const original='  Gespeicherter Text\nmit unveränderten Leerzeichen.  ';
function dto(lang='de',extra={}){return {schema:'explanation-view-v1',source:{kind:'writing',source_sha256:'a'.repeat(64),submission_id:'submission-a',exam_id:'telc-deutsch-b1'},requested_language:lang,original_language:'de',displayed_language:lang,state:lang==='de'?'original':'translated',requested_status:'available',reason:null,representation:{version:'v1',payload_sha256:'b'.repeat(64),persisted:true,payload:{schema:'explanation-text-v1',blocks:[{slot:'criterion/aufgabe/comment',text:original}]},provenance_kind:'builtin-simulation-dictionary'},review:{educational:review,native_language:review},languages:langs.map(language=>({language,status:'available'})),operation:null,...extra};}
const defer=()=>{let resolve;return{promise:new Promise(r=>resolve=r),resolve:v=>resolve(v)};};
const response=data=>({ok:true,data});
let passed=0;async function check(name,fn){await fn();passed++;console.log('PASS '+name);}
await check('five language changes read exact same source without changing immutable parent facts',async()=>{
 const facts={criteria:[{key:'aufgabe',band:'B',evidence:'German quote'}],job:'succeeded',debits:1};const before=JSON.stringify(facts),calls=[];
 const model=createExplanationState({view:dto(),read:async language=>{calls.push(language);return response(dto(language));}});
 for(const lang of langs){assert.equal(await model.select(lang),true);assert.equal(model.state().view.displayed_language,lang);}
 assert.deepEqual(calls,langs);assert.equal(JSON.stringify(facts),before);
});
await check('A-B-A out-of-order reads cannot replace the newest confirmed language',async()=>{
 const requests=[];const model=createExplanationState({view:dto(),read:()=>{const d=defer();requests.push(d);return d.promise;}});
 const a=model.select('ar'),b=model.select('en'),c=model.select('ar');requests[2].resolve(response(dto('ar')));assert.equal(await c,true);
 requests[0].resolve(response(dto('ar',{representation:{...dto().representation,version:'obsolete'}})));requests[1].resolve(response(dto('en')));
 assert.equal(await a,false);assert.equal(await b,false);assert.equal(model.state().view.displayed_language,'ar');assert.equal(model.state().view.representation.version,'v1');
});
await check('failed reads preserve exact confirmed text and actual language; explicit retry reads only',async()=>{
 let fail=true,calls=0;const model=createExplanationState({view:dto(),read:async lang=>{calls++;if(fail)throw Error('offline');return response(dto(lang));}});
 assert.equal(await model.select('ar'),false);assert.equal(model.state().error,true);assert.equal(model.state().view.displayed_language,'de');assert.equal(model.state().view.representation.payload.blocks[0].text,original);
 fail=false;assert.equal(await model.select(model.state().wanted),true);assert.equal(calls,2);assert.equal(model.state().view.displayed_language,'ar');
});
for(const boundary of ['account','preparation','view','card'])await check(boundary+' switch fences a transport that ignores cancellation',async()=>{
 let current=true,confirmed=0;const pending=defer();const model=createExplanationState({view:dto(),read:()=>pending.promise,isCurrent:()=>current,onConfirmed:()=>confirmed++});
 const running=model.select('en');current=false;pending.resolve(response(dto('en')));assert.equal(await running,false);assert.equal(confirmed,0);assert.equal(model.state().view.displayed_language,'de');
});
await check('disposed old card cannot update a newly mounted card or parent',async()=>{
 const d=defer();let updates=0;const old=createExplanationState({view:dto(),read:()=>d.promise,onConfirmed:()=>updates++});const flight=old.select('tr');old.dispose();const newer=createExplanationState({view:dto('uk'),read:async()=>response(dto())});d.resolve(response(dto('tr')));assert.equal(await flight,false);assert.equal(updates,0);assert.equal(newer.state().view.displayed_language,'uk');
});
await check('different source digest or parent identity is refused without replacing confirmed prose',async()=>{
 for(const source of [{...dto().source,source_sha256:'c'.repeat(64)},{...dto().source,submission_id:'submission-b'}]){const model=createExplanationState({view:dto(),read:async()=>response(dto('en',{source}))});assert.equal(await model.select('en'),false);assert.equal(model.state().view.displayed_language,'de');}
});
await check('parent rights refusal redacts facts even when blocked mock has no item DTO',async()=>{
 let model,redacted=false;model=createExplanationState({view:dto(),read:async()=>({ok:true,data:undefined,parent:{blocked_reason:'rights_blocked',result:null}}),onConfirmed:()=>{redacted=true;model.dispose();}});
 assert.equal(await model.select('ar'),false);assert.equal(redacted,true);
});
await check('malformed blocked-parent projection cannot retain previously confirmed protected prose',async()=>{
 const model=createExplanationState({view:dto(),read:async()=>({ok:true,parent:{blocked_reason:'rights_blocked'}})});assert.equal(await model.select('ar'),false);assert.equal(model.state().view,null);assert.equal(model.state().error,true);
});
await check('withdrawn selected and original representations retain authorized source but remove prior prose',async()=>{
 const blocked=dto('ar',{state:'blocked',reason:'representation_withdrawn',requested_status:'blocked',displayed_language:null,representation:null});assert(validExplanationView(blocked));
 const model=createExplanationState({view:dto(),read:async()=>response(blocked)});assert.equal(await model.select('ar'),true);assert.equal(model.state().view.state,'blocked');assert.equal(model.state().view.source.source_sha256,dto().source.source_sha256);assert.equal(model.state().view.representation,null);assert.equal(model.state().error,false);
 assert.equal(validExplanationView({...blocked,reason:'content_blocked'}),false);
});
await check('fallback statuses state actual original language honestly and never create pending work',()=>{
 for(const status of ['missing','pending','failed','blocked']){const view=dto('ar',{displayed_language:'de',state:'fallback',requested_status:status});assert(validExplanationView(view));assert.match(explanationStatus(view),/Deutsch.*Originalfassung/);assert.equal(view.operation,null);}
 assert.match(explanationStatus(dto(null,{displayed_language:null,original_language:null})),/Originalsprache unbekannt/);
 for(const state of ['blocked','not_assessed'])assert(validExplanationView(dto('de',{state,source:null,representation:null})));
 assert.equal(validExplanationView(dto('de',{state:'blocked'})),false);
});
await check('invalid language, malformed payload and mismatched requested language cannot enter confirmed state',async()=>{
 let calls=0;const model=createExplanationState({view:dto(),read:async()=>{calls++;return response(dto('uk'));}});assert.equal(await model.select('fr'),false);assert.equal(calls,0);assert.equal(await model.select('ar'),false);
 for(const blocks of [[],[{slot:'x',text:' '}],[{slot:'x',text:'a'},{slot:'x',text:'b'}],[{slot:'x',text:'a'.repeat(4001)}]])assert.equal(validExplanationView(dto('de',{representation:{...dto().representation,payload:{schema:'explanation-text-v1',blocks}}})),false);
});
class Node {
 constructor(tag,doc){this.tagName=tag;this.doc=doc;this.children=[];this.dataset={};this.attrs={};this.isConnected=true;this.textContent='';}
 append(...items){for(const child of items){this.children.push(child);if(typeof child==='object')child.parent=this;}}
 replaceChildren(...items){for(const child of this.children)if(typeof child==='object')child.isConnected=false;this.children=[];this.append(...items);}
 contains(other){return this===other||this.children.some(child=>typeof child==='object'&&child.contains(other));}
 setAttribute(k,v){this.attrs[k]=v;}hasAttribute(k){return k==='data-explanation-language'?Object.hasOwn(this.dataset,'explanationLanguage'):Object.hasOwn(this.attrs,k);}focus(){this.doc.activeElement=this;}
}
const walk=(node,predicate)=>[node,...node.children.filter(x=>typeof x==='object').flatMap(x=>walk(x,predicate))].filter(predicate);
await check('actual renderer removes previously visible prose for representation-blocked source DTO',async()=>{
 const doc={activeElement:null,createElement(tag){return new Node(tag,this);}},host=doc.createElement('div');
 const manager=createExplanationManager({doc,getLanguage:()=> 'de'});const model=manager.mount(host,{view:dto(),read:async()=>response(dto('ar',{state:'blocked',reason:'representation_withdrawn',requested_status:'blocked',displayed_language:null,representation:null}))});
 assert.equal(walk(host,n=>Object.hasOwn(n.dataset,'explanationSlot')).length,1);assert.equal(await model.select('ar'),true);assert.equal(walk(host,n=>Object.hasOwn(n.dataset,'explanationSlot')).length,0);assert.equal(host.dataset.explanationState,'blocked');manager.dispose();
});
await check('rendered Arabic direction is prose-only; speech receives exact text and unknown language has no action',()=>{
 const doc={activeElement:null,createElement(tag){return new Node(tag,this);}},host=doc.createElement('div'),spoken=[];
 const speech={clear(){},stop(){},mount(node,options){spoken.push({text:node.textContent,language:options.language});}};
 const manager=createExplanationManager({doc,readAloud:speech,getLanguage:()=> 'ar'});
 manager.mount(host,{view:dto('ar'),read:async()=>response(dto('ar'))});
 const prose=walk(host,n=>Object.hasOwn(n.dataset,'explanationSlot'))[0];assert.equal(host.dir,'ltr');assert.equal(host.lang,'de');assert.equal(prose.dir,'rtl');assert.equal(prose.lang,'ar');assert.equal(prose.textContent,original);assert.deepEqual(spoken,[{text:original,language:'ar'}]);
 manager.dispose();spoken.length=0;
 const unknown=createExplanationManager({doc,readAloud:speech,getLanguage:()=>null});unknown.mount(host,{view:dto(null,{original_language:null,displayed_language:null,state:'original'}),read:async()=>response(dto())});assert.equal(spoken.length,0);assert(walk(host,n=>n.textContent.includes('Originalsprache ist nicht bekannt')).length);unknown.dispose();
});
await check('browser speech adapter preserves surrounding whitespace and line breaks exactly',()=>{
 const utterances=[],synthesis={getVoices:()=>[{lang:'de-DE',localService:true}],speak:value=>utterances.push(value),cancel(){},addEventListener(){},removeEventListener(){}};
 const speech=createLocalSpeech({synthesis,Utterance:class{constructor(text){this.text=text;}}});speech.play(original,'de',()=>{});assert.equal(utterances[0].text,original);speech.destroy();
});
await check('all explanation API selectors are GET-only, omitted original and exact evidence identity',async()=>{
 const calls=[],api=createApi({fetchImpl:async(url,init)=>{calls.push({url,...init});return {ok:true,status:200,json:async()=>url==='/api/auth/get-session'?{user:{id:'owner-a'}}:{schema:'response'}};}});
 await api.session();calls.length=0;
 for(const lang of [null,...langs]){await api.writing.result('saved-id',lang);await api.mock.read('run-id',lang);await api.practice.explanation('evidence-id',lang);}
 assert.equal(calls.length,18);assert(calls.every(c=>c.method==='GET'&&c.body===undefined&&c.headers['X-Hatoove-Account']==='owner-a'));
 assert.equal(calls[0].url,'/api/v1/submissions/saved-id');assert.equal(calls[2].url,'/api/v1/objective-evidence/evidence-id/explanation');assert.equal(calls.at(-1).url,'/api/v1/objective-evidence/evidence-id/explanation?language=tr');
});
await check('API language read is rejected after preparation identity changes',async()=>{
 const pending=defer();let wait=false;const api=createApi({fetchImpl:async url=>wait?pending.promise:{ok:true,status:200,json:async()=>({user:{id:'owner-a'}})}});await api.session();api.preparations.select({id:'11111111-2222-4333-8444-555555555555',state:'active'});wait=true;
 const request=api.practice.explanation('evidence-id','ar');api.preparations.clear();pending.resolve({ok:true,status:200,json:async()=>dto('ar')});assert.equal((await request).error,'stale_preparation');
});
await check('verified account-cookie transition rejects a previously dispatched explanation response',async()=>{
 const pending=defer();let owner='owner-a';const api=createApi({onSessionInvalid:()=>{},fetchImpl:async url=>url==='/api/auth/get-session'?{ok:true,status:200,json:async()=>({user:{id:owner}})}:pending.promise});await api.session();const request=api.writing.result('submission-a','ar');owner='owner-b';assert.equal((await api.session()).error,'account_changed');pending.resolve({ok:true,status:200,json:async()=>dto('ar')});assert.equal((await request).error,'stale_session');
});
await check('generated provider probe counts and refuses external string URL and Request before native I/O',()=>{
 let calls=0,appended=0;const scope={fetch:()=>{calls++;return 'local response';}},fakeFs={appendFileSync:()=>appended++};
 new Function('fs','URL','globalThis',explanationProviderProbeSource.replace("import fs from 'node:fs';",''))(fakeFs,URL,scope);
 for(const input of ['https://provider.invalid/test',new URL('https://provider.invalid/test'),new Request('https://provider.invalid/test')])assert.throws(()=>scope.fetch(input),/refuses external provider I\/O/);
 assert.equal(calls,0);assert.equal(appended,3);assert.equal(scope.__explanationProviderCalls,3);assert.equal(scope.fetch(new Request('http://127.0.0.1:4321/api/ready')),'local response');assert.equal(calls,1);
});
console.log(`Saved explanation client: ${passed} checks passed; synthetic DTO/transport evidence only.`);

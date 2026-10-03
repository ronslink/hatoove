/** Offline DOM ports and synthetic transports only; rendered/device acceptance is separate. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { LOCALES, setLocale, getLocale } from '../public/assets/i18n/core.js';
import { PRACTICE_MESSAGES, pt, pl, pa, bindPracticeText, updatePracticeLocale } from '../public/assets/i18n/practice-messages.js';
import { INSTRUCTIONS, instructionView, instructionMarkup, translateInstructions } from '../public/assets/i18n/instructions.js';
import { createWritingController, writingPrompt } from '../public/app/writing.js';
import { createListeningController } from '../public/app/listening.js';
import { createMockController, createMockSession, finaliseMockWriting } from '../public/app/mock.js';
import { createExplanationManager } from '../public/app/explanations.js';
import { createReadAloud } from '../public/app/read-aloud.js';
import { bindSentenceCheck } from '../public/app/sentence-check.js';

let passed=0;
const check=async(name,fn)=>{await fn();passed++;console.log('PASS '+name);};
const esc=value=>String(value ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]);
const decode=value=>String(value).replace(/&(?:amp|lt|gt|quot|#39);/g,c=>({'&amp;':'&','&lt;':'<','&gt;':'>','&quot;':'"','&#39;':"'"})[c]);
const parameters=text=>Object.fromEntries([...text.matchAll(/\{([A-Za-z][A-Za-z0-9_]*)\}/g)].map(([,key])=>[key,3]));
const defer=()=>{let resolve;return{promise:new Promise(r=>resolve=r),resolve:value=>resolve(value)};};
const tick=()=>new Promise(resolve=>setImmediate(resolve));

// The port parses only markup produced by these controllers, and preserves node identity.
class NodePort extends EventTarget {
  constructor(tag='div',doc=null){super();this.tagName=tag.toUpperCase();this.doc=doc;this.children=[];this.dataset={};this.attrs={};this.isConnected=true;this.value='';this.hidden=false;this.readOnly=false;this.disabled=false;this.text='';}
  append(...nodes){for(const node of nodes){node.parentElement=this;node.doc=this.doc;this.children.push(node);}}
  after(node){const parent=this.parentElement;if(parent){node.parentElement=parent;parent.children.splice(parent.children.indexOf(this)+1,0,node);}}
  remove(){this.isConnected=false;if(this.parentElement)this.parentElement.children=this.parentElement.children.filter(node=>node!==this);}
  replaceChildren(...nodes){for(const node of this.children)node.isConnected=false;this.children=[];this.text='';this.append(...nodes);}
  set textContent(value){this.replaceChildren();this.text=String(value);}
  get textContent(){return this.text+this.children.map(node=>node.textContent).join('');}
  setAttribute(key,value){this.attrs[key]=String(value);if(key.startsWith('data-'))this.dataset[key.slice(5).replace(/-([a-z])/g,(_,c)=>c.toUpperCase())]=String(value);else if(key==='id')this.id=String(value);else if(key==='class')this.className=String(value);else if(key==='lang'||key==='dir')this[key]=String(value);else if(key==='readonly')this.readOnly=true;else if(key==='disabled')this.disabled=true;}
  getAttribute(key){if(key.startsWith('data-'))return this.dataset[key.slice(5).replace(/-([a-z])/g,(_,c)=>c.toUpperCase())]??null;return this.attrs[key]??null;}
  hasAttribute(key){return this.getAttribute(key)!==null;}
  removeAttribute(key){delete this.attrs[key];}
  matches(selector){
    if(selector.includes(','))return selector.split(',').some(part=>this.matches(part.trim()));
    if(selector.startsWith('#'))return this.id===selector.slice(1);
    if(selector.startsWith('.'))return (this.className||'').split(' ').includes(selector.slice(1));
    const match=/^([a-z]+)?(?:\[([^=\]]+)(?:="([^"]*)")?\])?$/.exec(selector);
    return Boolean(match && (!match[1]||this.tagName===match[1].toUpperCase()) && (!match[2]||(match[3]===undefined?this.hasAttribute(match[2]):this.getAttribute(match[2])===match[3])));
  }
  querySelectorAll(selector){return this.children.flatMap(node=>[...(node.matches(selector)?[node]:[]),...node.querySelectorAll(selector)]);}
  querySelector(selector){return this.querySelectorAll(selector)[0]||null;}
  contains(node){return this===node||this.children.some(child=>child.contains(node));}
  closest(selector){return this.matches(selector)?this:this.parentElement?.closest(selector)||null;}
  focus(){if(this.doc)this.doc.activeElement=this;}
  scrollIntoView(){} getClientRects(){return this.isConnected?[{}]:[];}
  set innerHTML(html){
    this.replaceChildren();this.html=html;const stack=[this];
    for(const token of html.match(/<[^>]*>|[^<]+/g)||[]){
      if(token.startsWith('</')){if(stack.length>1)stack.pop();continue;}
      if(token.startsWith('<')){const tag=/^<([a-z0-9]+)/i.exec(token)?.[1];if(!tag)continue;const node=new NodePort(tag,this.doc);for(const attr of token.slice(tag.length+1,-1).matchAll(/([\w:-]+)(?:="([^"]*)")?/g))node.setAttribute(attr[1],decode(attr[2]??''));stack.at(-1).append(node);if(!['input','br','hr','img','meta','link'].includes(tag))stack.push(node);}
      else stack.at(-1).text+=decode(token);
    }
  }
  get innerHTML(){return this.html||'';}
}
const previous={window:globalThis.window,document:globalThis.document};
const doc={activeElement:null,createElement:tag=>new NodePort(tag,doc),getElementById:id=>doc.body.querySelector('#'+id)};
doc.body=new NodePort('body',doc);doc.documentElement=new NodePort('html',doc);
globalThis.window=new EventTarget();globalThis.document=doc;
const host=()=>{const node=doc.createElement('div');doc.body.append(node);return node;};
try {
  setLocale('de');
  await check('all five dictionaries have complete exact placeholder coverage and real text',()=>{
    const keys=Object.keys(PRACTICE_MESSAGES.de).sort();assert(keys.length>200);
    for(const locale of LOCALES){assert.deepEqual(Object.keys(PRACTICE_MESSAGES[locale]).sort(),keys);for(const key of keys){const value=PRACTICE_MESSAGES[locale][key];assert(value.trim());assert.deepEqual(Object.keys(parameters(value)).sort(),Object.keys(parameters(PRACTICE_MESSAGES.de[key])).sort());assert.equal(pt(key,parameters(value),locale),value.replace(/\{[A-Za-z][A-Za-z0-9_]*\}/g,'3'));}}
  });
  await check('instruction identities retain exact original digest across all five locales',()=>{
    for(const [id,entry] of Object.entries(INSTRUCTIONS))for(const locale of LOCALES){assert.equal(entry.sourceSha256,createHash('sha256').update(entry.original).digest('hex'));const params=id==='listening.playback'?{maxPlays:2}:{};const view=instructionView({id,examLanguage:'de',original:entry.original,parameters:params,locale});assert(view.known);assert.equal(view.original,entry.original.replace('{maxPlays}','2'));assert.equal(view.translation,locale==='de'?'':entry.translations[locale].replace('{maxPlays}','2'));}
  });
  await check('unknown language type original and malformed parameters never select another translation',()=>{
    const entry=INSTRUCTIONS['listening.playback'],base={id:entry.id,examLanguage:'de',original:entry.original,parameters:{maxPlays:2},locale:'uk'};let invoked=0;
    for(const patch of [{id:'__proto__'},{id:'new-type'},{examLanguage:'en'},{examLanguage:'und'},{locale:'fr'},{original:entry.original+'!'},{parameters:{}},{parameters:{maxPlays:'2'}},{parameters:{maxPlays:0}},{parameters:{maxPlays:101}},{parameters:{maxPlays:2,extra:1}},{parameters:Object.defineProperty({},'maxPlays',{get(){invoked++;return 2;}})}]){const view=instructionView({...base,...patch});assert.equal(view.known,false);assert.equal(view.digest,'');assert(view.translation);assert.equal(view.original,(patch.original||base.original));}assert.equal(invoked,0);
    assert.match(writingPrompt({topic:'Original',situation:'Original'},esc),/lang="und"/);assert.doesNotMatch(writingPrompt({topic:'Original',situation:'Original'},esc),/data-instruction-digest="[a-f0-9]{64}"/);
    setLocale('en');const future=writingPrompt({topic:'Original title',situation:'Original scenario'},esc,'en');assert(!future.includes(INSTRUCTIONS['writing.assigned'].original));assert.match(future,/unavailable in the exam language/);setLocale('de');
  });
  await check('instruction and message markup escape malicious text and never execute accessor parameters',()=>{
    const payload='<img src=x onerror="sentinel">';assert(!instructionMarkup({id:'unknown',examLanguage:'de',original:payload,locale:'ar'}).includes('<img'));
    assert(!pl('taskNumber',{id:payload},'en').includes('<img'));assert(!pa('aria-label','taskNumber',{id:payload},'en').includes('<img'));assert.equal(pa('onclick','close'), '');
    let invoked=0;const accessor=Object.defineProperty({},'id',{enumerable:true,get(){invoked++;throw Error('must not execute');}});assert.match(pl('taskNumber',accessor,'en'),/Translation unavailable/);assert.match(pa('title','taskNumber',accessor,'en'),/Translation unavailable/);assert.equal(invoked,0);
  });
  await check('leaf translation preserves controls parents selection and original instruction nodes',()=>{
    const root=host();root.innerHTML='<div data-practice-key="close"><textarea id="protected"></textarea></div>'+pl('taskNumber',{id:7})+'<button '+pa('aria-label','taskNumber',{id:7})+'></button>'+instructionMarkup({id:'single_choice',examLanguage:'de',original:INSTRUCTIONS.single_choice.original});
    const area=root.querySelector('#protected'),parent=area.parentElement,original=root.querySelector('[data-instruction-original]'),translated=root.querySelector('[data-instruction-translation]');area.value='Eigener Text';area.selectionStart=2;area.selectionEnd=5;area.composing=true;area.focus();const originalText=original.textContent;
    for(const locale of LOCALES){updatePracticeLocale(root,locale);translateInstructions(root,locale);assert.equal(root.querySelector('#protected'),area);assert.equal(area.parentElement,parent);assert.equal(doc.activeElement,area);assert.equal(area.value,'Eigener Text');assert.equal(area.selectionStart,2);assert.equal(area.selectionEnd,5);assert(area.composing);assert.equal(root.querySelector('[data-instruction-original]'),original);assert.equal(original.textContent,originalText);assert.equal(root.querySelector('[data-instruction-translation]'),translated);assert.equal(translated.hidden,locale==='de');assert.equal(root.querySelector('button').getAttribute('aria-label'),pt('taskNumber',{id:7},locale));}root.remove();
  });
  await check('actual writing locale hooks preserve dirty editor caret composition and pending save',async()=>{
    const root=host(),pending=defer(),calls=[];const controller=createWritingController({esc,getExamLanguage:()=> 'de',api:{writing:{readAttempt:async()=>({ok:true,data:{id:'draft',revision:2,text:'Saved'}}),saveDraft:async(...args)=>{calls.push(args);return pending.promise;}},rubrics:{read:async()=>({ok:true,data:{criteria:[]}})}}});
    try {await controller.open(root,{topic:'Deutscher Titel',situation:'Deutsches Szenario',leitpunkte:['Originalpunkt']},{attemptId:'draft',attached:true});await tick();const area=controller.active.area;area.value='Ungesicherter Text';area.selectionStart=4;area.selectionEnd=7;area.composing=true;area.focus();const state=controller.active,flight=controller.flush();await tick();assert.equal(calls.length,1);
      for(const locale of LOCALES){setLocale(locale);controller.updateLocale(locale);assert.equal(controller.active,state);assert.equal(state.area,area);assert.equal(area.value,'Ungesicherter Text');assert.equal(area.selectionStart,4);assert.equal(area.selectionEnd,7);assert(area.composing);assert.equal(doc.activeElement,area);assert.equal(calls.length,1);assert(root.textContent.includes('Deutsches Szenario'));assert.equal(area.lang,'de');}
      pending.resolve({ok:true,data:{revision:3}});assert.equal(await flight,true);assert.equal(state.revision,3);
    }finally{controller.dispose();root.remove();}
  });
  await check('pending standalone submission preserves exact receipt and frozen text across locale retry',async()=>{
    setLocale('de');const root=host(),pending=defer(),sent=[];const controller=createWritingController({esc,getExamLanguage:()=> 'de',api:{writing:{readAttempt:async()=>({ok:true,data:{id:'draft',revision:2,text:'Saved'}}),submit:async(...args)=>{sent.push(args);return sent.length===1?pending.promise:{ok:false,status:0,error:'network'};}},rubrics:{read:async()=>({ok:true,data:{criteria:[]}})}}});
    try {await controller.open(root,{topic:'Original',situation:'Aufgabe'},{attemptId:'draft'});const button=root.querySelector('#writing-submit'),area=controller.active.area,flight=button.onclick({currentTarget:button});await tick();assert.equal(sent.length,1);for(const locale of LOCALES){setLocale(locale);controller.updateLocale();assert.equal(root.querySelector('#writing-submit'),button);assert.equal(controller.active.area,area);assert(area.readOnly);assert.equal(sent.length,1);}pending.resolve({ok:false,status:0,error:'network'});await flight;await button.onclick({currentTarget:button});assert.equal(sent.length,2);assert.deepEqual(sent[1],sent[0]);assert.equal(area.value,'Saved');assert.equal(controller.active.eventId,sent[0][2]);
    }finally{controller.dispose();root.remove();}
  });
  await check('actual audio locale hooks preserve audio and position without another media or playback request',async()=>{
    class AudioPort extends NodePort {constructor(){super('audio',doc);this.currentTime=0;this.playbackRate=1;this.paused=true;}pause(){this.paused=true;}load(){}play(){this.paused=false;this.dispatchEvent(new Event('playing'));return Promise.resolve();}}
    setLocale('de');const root=host(),audio=new AudioPort(),calls=[];const clip={id:'recording',media_id:'media',media_version:'v1',duration_ms:90000,max_plays:2,label:'Originalaufnahme'};let row={...clip,revision:0,state:'ready',plays_used:0,position_ms:0,playback_id:null,uncertain:false};
    const controller=createListeningController({esc,getExamLanguage:()=> 'de',createAudio:()=>audio,createObjectURL:()=> 'blob:synthetic',revokeObjectURL:()=>{},api:{mock:{playback:async()=>{calls.push('read');return{ok:true,data:{items:[row]}};},media:async()=>{calls.push('media');return{ok:true,data:{}};},playbackEvent:async(id,body)=>{calls.push(body);row={...row,revision:row.revision+1,state:'playing',plays_used:1,playback_id:'play-id'};return{ok:true,data:row};}}}});
    try {controller.mount(root,{id:'run',exam_language:'de'},clip);await tick();await controller.loadMedia();audio.dispatchEvent(new Event('canplay'));await controller.play();await tick();audio.currentTime=3.25;const before=JSON.stringify(controller.state()),count=calls.length,progress=root.querySelector('progress');for(const locale of LOCALES){setLocale(locale);controller.updateLocale();assert.equal(root.querySelector('progress'),progress);assert.equal(doc.body.querySelector('audio'),audio);assert.equal(audio.currentTime,3.25);assert.equal(JSON.stringify(controller.state()),before);assert.equal(calls.length,count);}assert.equal(calls.filter(value=>typeof value==='object'&&value.action==='begin').length,1);
    }finally{controller.dispose();root.remove();}
  });
  await check('actual timed mock locale hook keeps selected radio original material deadline and request count',async()=>{
    setLocale('de');const root=host(),now=Date.now(),calls=[];const run={id:'timed',state:'active',revision:1,mode:'timed',scope:'section',exam_id:'synthetic',exam_language:'de',title:'Originaltitel',form_version:'v1',release_version:'v1',server_now:new Date(now).toISOString(),deadline_at:new Date(now+600000).toISOString(),position:{member:0,item:0},responses:[{setId:'set',version:'v1',itemId:'1',answer:'a'}],members:[{set_id:'set',version:'v1',interaction:'single_choice',section:'LV',item_count:1,title:'Originalteil',payload:{text:'Originalpassage',questions:[{n:1,question:'Originalfrage?',options:{a:'Originalantwort',b:'Andere Antwort'}}]}}]};
    const controller=createMockController({esc,getExamLanguage:()=> 'de',api:{mock:{read:async()=>{calls.push('read');return{ok:true,data:structuredClone(run)};}}}});
    try {await controller.showRun(root,run.id);const radio=root.querySelector('input[name="mock-answer"]'),question=root.querySelector('legend'),timer=root.querySelector('#mock-deadline');radio.focus();const start=timer.textContent;for(const locale of LOCALES){setLocale(locale);controller.updateLocale();assert.equal(root.querySelector('input[name="mock-answer"]'),radio);assert.equal(root.querySelector('legend'),question);assert.equal(root.querySelector('#mock-deadline'),timer);assert.equal(question.textContent,'Originalfrage?');assert(radio.hasAttribute('checked'));assert.equal(doc.activeElement,radio);assert.equal(calls.length,1);assert(root.textContent.includes('Originalpassage'));}assert.match(start,/10:00|9:59/);assert.match(timer.textContent,/10:00|9:59/);assert.equal(run.deadline_at,new Date(now+600000).toISOString());
    }finally{controller.dispose();root.remove();}
  });
  await check('held mock finalisation captures once and uncertain retry retains exact language and event',async()=>{
    setLocale('de');const ready=defer(),bodies=[];const run={id:'run',state:'active',revision:2,server_now:new Date().toISOString(),responses:[],position:{member:0,item:0},writing_task:{section:'SA'},writing:{attempt_id:'draft',draft_revision:3}};
    const session=createMockSession({api:{mock:{finalise:async(id,body)=>{bodies.push(structuredClone(body));return{ok:false,status:0,error:'network'};}}},eventId:()=> 'fixed-event'});session.load(run);
    const flight=finaliseMockWriting({session,writing:{active:{attempt:'draft',revision:3},flush:async()=>true},language:getLocale(),ready:ready.promise});setLocale('ar');ready.resolve(true);assert.equal(await flight,false);assert.equal(bodies[0].explanationLanguage,'de');setLocale('uk');assert.equal(await session.flush(),false);assert.deepEqual(bodies[1],bodies[0]);assert.equal(session.state().pendingKind,'finalise');session.dispose();
  });
  await check('explanation locale controls preserve exact saved prose source selector and read count',()=>{
    setLocale('de');const root=host();let reads=0;const view={schema:'explanation-view-v1',state:'original',requested_status:'available',requested_language:'de',original_language:'de',displayed_language:'de',operation:null,source:{source_sha256:'a'.repeat(64)},representation:{payload:{schema:'explanation-text-v1',blocks:[{slot:'criterion/example/comment',text:'  Originaler Erklärungstext\n  '}]}}};const manager=createExplanationManager({doc,getLanguage:()=> 'de'});
    try {manager.mount(root,{view,read:async()=>{reads++;return{ok:true,data:view};}});const prose=root.querySelector('[data-explanation-slot]'),select=root.querySelector('select'),text=prose.textContent;for(const locale of LOCALES){setLocale(locale);manager.updateLocale();assert.equal(root.querySelector('[data-explanation-slot]'),prose);assert.equal(root.querySelector('select'),select);assert.equal(select.value,'de');assert.equal(prose.textContent,text);assert.equal(prose.lang,'de');assert.equal(prose.dir,'ltr');assert.equal(root.dir,locale==='ar'?'rtl':'ltr');assert.equal(reads,0);}root.isConnected=false;manager.updateLocale('ar');assert.equal(reads,0);
    }finally{manager.dispose();root.remove();}
  });
  await check('speech chrome changes do not restart exact text and disposer removes listeners',()=>{
    setLocale('de');const root=host(),text=doc.createElement('p');text.textContent='Original';text.lang='de';root.append(text);let calls=0,stops=0,subscriptions=0;const speech={stop(){stops++;},play(value,language,report){calls++;assert.equal(value,'Original');assert.equal(language,'de');report({state:'playing',messageKey:'speechPlaying',parameters:{}});},subscribe(){subscriptions++;return()=>subscriptions--;},destroy(){},availability:()=>({voice:{}})};const manager=createReadAloud({speech,doc,events:globalThis.window});
    try {const box=manager.mount(text),button=box.querySelector('button');button.dispatchEvent(new Event('click'));assert.equal(calls,1);const beforeStops=stops;for(const locale of LOCALES){setLocale(locale);manager.updateLocale();assert.equal(box.querySelector('button'),button);assert.equal(button.textContent,pt('stop'));assert.equal(button.getAttribute('aria-label'),pt('stopLabel',{label:pt('text')}));assert.equal(calls,1);assert.equal(stops,beforeStops);}manager.clear(root);assert.equal(subscriptions,0);
    }finally{manager.destroy();root.remove();}
  });
  await check('sentence locale hook keeps input and request identity while educational source remains German',async()=>{
    const root=host();root.innerHTML='<form id="sentence-form"><textarea id="sentence-text"></textarea><button id="sentence-submit"></button></form><div id="sentence-result"></div>';const pending=defer();let calls=0;const binding=bindSentenceCheck({esc,api:{sentences:{check:async()=>{calls++;return pending.promise;}}}}),input=root.querySelector('#sentence-text'),output=root.querySelector('#sentence-result');input.value='Ich lerne Deutsch.';input.selectionStart=3;input.selectionEnd=5;
    try {root.querySelector('form').dispatchEvent(new Event('submit',{cancelable:true}));for(const locale of LOCALES){setLocale(locale);binding.updateLocale();assert.equal(root.querySelector('#sentence-text'),input);assert.equal(input.value,'Ich lerne Deutsch.');assert.equal(input.selectionStart,3);assert.equal(calls,1);}pending.resolve({ok:true,data:{limitation:'Originale Begrenzung',clauses:[{type:'main',text:input.value,rule:'Originalregel',hints:[]}]}});await tick();assert(output.textContent.includes('Originalregel'));assert.equal(output.querySelector('blockquote').lang,'de');binding.updateLocale('ar');assert.equal(output.querySelector('blockquote').dir,'ltr');
    }finally{binding.dispose();root.remove();}
  });
  await check('completed failed unassessed and blocked writing labels change without restoring restricted content',async()=>{
    for(const state of ['assessed','failed','unassessed','blocked']){
      setLocale('en');const root=host();let reads=0;const data={submission:{text:'Gespeicherter Originaltext'},task:{topic:'Originaltitel',situation:'Geschütztes Szenario'},rubric:{feedback_kind:'fixture-feedback',criteria:[]},job:{status:state==='assessed'?'succeeded':state==='blocked'?'failed':state,failure_code:'grader_error'},assessment:state==='assessed'?{feedback:{kind:'fixture-feedback',criteria:[{key:'x',label:'Originalkriterium',band:'A',evidence:'Originalbeleg'}]}}:null,blocked_reason:state==='blocked'?'rights_blocked':null};
      const controller=createWritingController({esc,getExamLanguage:()=> 'de',api:{writing:{result:async()=>{reads++;return{ok:true,data};}},rubrics:{read:async()=>({ok:true,data:data.rubric})}}});
      try {await controller.open(root,{}, {attached:true,submissionId:'submitted'});const count=reads,prose=root.querySelector('pre');assert.equal(prose.textContent,'Gespeicherter Originaltext');for(const locale of LOCALES){setLocale(locale);controller.updateLocale();assert.equal(reads,count);assert.equal(root.querySelector('pre'),prose);assert.equal(prose.textContent,'Gespeicherter Originaltext');assert(!root.textContent.includes(pt('__missing__',{},locale)));if(state==='blocked'){assert(!root.textContent.includes('Geschütztes Szenario'));assert(!root.querySelector('[data-instruction]'));assert(!root.querySelector('#writing-revise'));}else assert(root.textContent.includes('Geschütztes Szenario'));}}
      finally{controller.dispose();root.remove();}
    }
  });
  await check('finalised mock and external history bindings localize without replacing saved facts or links',async()=>{
    setLocale('de');const root=host(),external=host();let reads=0;const run={id:'finished',state:'finalised',revision:3,mode:'untimed',scope:'section',exam_id:'synthetic',exam_language:'de',title:'Originaltitel',form_version:'v1',release_version:'v2',updated_at:'2026-10-03T12:00:00.000Z',server_now:'2026-10-03T12:00:00.000Z',position:{member:0,item:0},responses:[],members:[{set_id:'set',version:'v1',section:'LV',interaction:'single_choice',item_count:1,payload:{text:'Originalpassage',questions:[{n:1,question:'Originalfrage',options:{a:'Originalantwort',b:'Andere Antwort'}}]}}],result:{correct:1,total:1,unanswered:0,items:[{set_id:'set',version:'v1',item_id:'1',answer:'a',correct:true,correct_answer:'a',unanswered:false}]}};
    const controller=createMockController({esc,getExamLanguage:()=> 'de',api:{mock:{read:async()=>{reads++;return{ok:true,data:structuredClone(run)};}}}});
    try {await controller.showRun(root,run.id);external.innerHTML=controller.historyMarkup([run]);const context=root.querySelector('[data-review-item]'),link=external.querySelector('a'),date=external.querySelector('[data-practice-date]');for(const locale of LOCALES){setLocale(locale);controller.updateLocale();updatePracticeLocale(external,locale);assert.equal(reads,1);assert.equal(root.querySelector('[data-review-item]'),context);assert.equal(external.querySelector('a'),link);assert.equal(external.querySelector('[data-practice-date]'),date);assert(root.textContent.includes(pt('sectionFinished')));assert(root.textContent.includes('Originalpassage'));assert(!root.textContent.includes(pt('__missing__',{},locale)));assert.equal(link.textContent,pt('view'));assert(!external.textContent.includes(pt('__missing__',{},locale)));}}
    finally{controller.dispose();root.remove();external.remove();}
  });
  await check('sentence failure localizes immediately and disposal removes the request listener',async()=>{
    for(const locale of LOCALES){setLocale(locale);const root=host();root.innerHTML='<form id="sentence-form"><textarea id="sentence-text"></textarea><button id="sentence-submit"></button></form><div id="sentence-result"></div>';let calls=0;const binding=bindSentenceCheck({esc,api:{sentences:{check:async()=>{calls++;return{ok:false};}}}}),form=root.querySelector('form');root.querySelector('textarea').value='Original';form.dispatchEvent(new Event('submit',{cancelable:true}));await tick();assert.equal(root.querySelector('#sentence-result').textContent,pt('ui70'));binding.dispose();form.dispatchEvent(new Event('submit',{cancelable:true}));assert.equal(calls,1);root.remove();}
  });
  await check('all controller locale hooks exclude transport and remount entry points',()=>{
    for(const file of ['writing','mock','listening','explanations']){const source=fs.readFileSync(new URL('../public/app/'+file+'.js',import.meta.url),'utf8'),hook=source.slice(source.indexOf('  function updateLocale('),source.indexOf('\n  return {',source.indexOf('  function updateLocale(')));assert(hook.includes('function updateLocale'));assert.doesNotMatch(hook,/\b(?:render|mount|open|refreshTiming|updateDeadline)\s*\(|api\.|\.innerHTML\s*=|replaceChildren\(/);}
  });
} finally {setLocale('de');globalThis.window=previous.window;globalThis.document=previous.document;}
console.log(`Practice locale: ${passed} checks passed; offline DOM/transport evidence, not browser or native translation acceptance.`);

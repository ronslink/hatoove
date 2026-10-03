/** Offline execution of the actual public/auth modules against a small DOM port.
 * No browser, network, service, account or database is used. Browser/device evidence is separate.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const read = path => fs.readFileSync(new URL('../' + path, import.meta.url), 'utf8');
const locales = ['de','en','uk','ar','tr'];
let count = 0;
async function check(name, work) { await work(); count++; console.log('PASS ' + name); }
const decode = text => text.replace(/&(amp|lt|gt|quot|#39);/g, (_, key) => ({amp:'&',lt:'<',gt:'>',quot:'"','#39':"'"}[key]));
const dataKey = name => name.slice(5).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
class Element {
  constructor(tag, doc) { this.tagName=tag.toUpperCase(); this.doc=doc; this.nodes=[]; this.attrs={}; this.dataset={}; this.events={}; this.value=''; this.hidden=false; this.checked=false; this.disabled=false; this.replacements=0; this.selectionStart=0; this.selectionEnd=0; this.isConnected=true; }
  get children() { return this.nodes.filter(node => node instanceof Element); }
  get textContent() { return this.nodes.map(node => typeof node === 'string' ? node : node.textContent).join(''); }
  set textContent(value) { this.nodes=[String(value)]; }
  set innerHTML(value) { this.replacements++; this.nodes=[]; parse(value,this,this.doc); }
  set className(value) { this.attrs.class=value; } get className() { return this.attrs.class || ''; }
  setAttribute(name,value) { if(name.startsWith('data-')) this.dataset[dataKey(name)]=String(value); else this.attrs[name]=String(value); if(['hidden','disabled','checked','open'].includes(name)) this[name]=true; if(name==='value') this.value=String(value); if(name==='lang'||name==='dir')this[name]=String(value); }
  getAttribute(name) { return name.startsWith('data-') ? this.dataset[dataKey(name)] ?? null : this.attrs[name] ?? null; }
  hasAttribute(name) { return this.getAttribute(name)!==null; }
  matches(selector) { return selector.split(',').some(part => {
    const bits=part.trim().split(/\s+/); const leaf=bits.pop();
    const matchSimple=(node,test)=>{const tag=/^[a-z]+/i.exec(test)?.[0]; if(tag&&node.tagName!==tag.toUpperCase())return false;
      for(const m of test.matchAll(/#([\w-]+)|\.([\w-]+)|\[([\w-]+)(?:="([^"]*)")?\]/g)){if(m[1]&&node.getAttribute('id')!==m[1])return false;if(m[2]&&!node.className.split(/\s+/).includes(m[2]))return false;if(m[3]&&(!node.hasAttribute(m[3])||(m[4]!==undefined&&node.getAttribute(m[3])!==m[4])))return false;}return true;};
    if(!matchSimple(this,leaf))return false; let ancestor=this.parent;
    for(const bit of bits.reverse()){while(ancestor&&!matchSimple(ancestor,bit))ancestor=ancestor.parent;if(!ancestor)return false;ancestor=ancestor.parent;}return true;
  }); }
  querySelectorAll(selector) { return this.children.flatMap(child => [...(child.matches(selector)?[child]:[]),...child.querySelectorAll(selector)]); }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  addEventListener(type,listener) { (this.events[type] ||= []).push(listener); }
  async fire(type,fields={}) { await Promise.all((this.events[type]||[]).map(listener=>listener({target:this,preventDefault(){},...fields}))); }
  focus() { this.doc.activeElement=this; }
  setCustomValidity(message) { this.validationMessage=message; }
  scrollIntoView() {}
  closest(selector) { for(let node=this;node;node=node.parent)if(node.matches(selector))return node;return null; }
  reset() { for(const input of this.querySelectorAll('input,textarea')) {input.value='';input.checked=false;} }
}
function parse(html,parent,doc) {
  const stack=[parent];
  for(const token of html.split(/(<[^>]+>)/)) {
    if(/^<\//.test(token)){if(stack.length>1){const closed=stack.pop();if(closed.tagName==='TEXTAREA')closed.value=closed.textContent;}continue;}
    if(token.startsWith('<')){const tag=/^<([a-z0-9]+)/i.exec(token)?.[1];if(!tag)continue;const node=new Element(tag,doc);node.parent=stack.at(-1);node.parent.nodes.push(node);
      for(const attr of token.slice(tag.length+1,-1).matchAll(/([\w:-]+)(?:="([^"]*)")?/g))node.setAttribute(attr[1],decode(attr[2]??''));
      if(!['meta','link','img','br','input','source','hr'].includes(tag))stack.push(node);
    }else stack.at(-1).nodes.push(decode(token));
  }
}
function makeDocument(html) {
  const doc={activeElement:null}; const top=new Element('document',doc);parse(html,top,doc);
  doc.documentElement=top.querySelector('html');doc.body=top.querySelector('body');
  doc.querySelectorAll=selector=>top.querySelectorAll(selector);doc.querySelector=selector=>top.querySelector(selector);doc.getElementById=id=>doc.querySelector('#'+id);doc.createElement=tag=>new Element(tag,doc);return doc;
}
const moduleBody = source => source.replace(/^import .*;\r?\n/gm,'').replace(/\bexport /g,'');
function boot(page='signin',locale='de',search='',response=null,sourceOverride=null) {
  const file=page==='public'?'index':page==='reset'?'reset-password':page==='verify'?'verify-email':'signin';
  const document=makeDocument(read('public/'+file+'.html'));const storage=new Map([['hatoove.interface-language.v1',locale]]),writes=[],calls=[],lifecycle={};
  const location={search,hash:'',pathname:'/'+file,replace(target){this.redirect=target;}};
  const context=vm.createContext({document,location,history:{replaceState(){location.search='';}},navigator:{languages:['en-US']},
    localStorage:{getItem:key=>storage.get(key)||null,setItem:(key,value)=>{writes.push([key,value]);storage.set(key,value);}},
    URLSearchParams,AbortController,setTimeout,clearTimeout,Intl,addEventListener:(type,listener)=>{(lifecycle[type]||=[]).push(listener);},
    fetch:async(url,options)=>{calls.push({url,...options});if(response)return response(url,options);return {ok:false,status:503,json:async()=>({error:'recovery_unavailable'})};},
  });
  const run=source=>vm.runInContext(source,context,{timeout:2000});
  run(moduleBody(read('public/assets/i18n/core.js')));
  for(const namespace of ['common',page==='public'?'public-messages':'auth-messages'])run('(()=>{'+moduleBody(read('public/assets/i18n/'+namespace+'.js'))+'})()');
  run('const instructionApi=(()=>{'+moduleBody(read('public/assets/i18n/instructions.js'))+';return {instructionMarkup,translateInstructions,INSTRUCTIONS};})();const {instructionMarkup,translateInstructions}=instructionApi;');
  run('(()=>{'+moduleBody(sourceOverride || read(page==='public'?'public/site.js':'public/auth/entry.js'))+'})()');
  return {document,storage,writes,calls,location,run,lifecycle,async locale(value){const select=document.getElementById('interface-language');select.value=value;await select.fire('change');},node:id=>document.getElementById(id),text:key=>run('t('+JSON.stringify(key)+')')};
}

await check('all five public and auth dictionaries register; every static binding resolves',()=>{
  for(const page of ['public','signin','reset','verify'])for(const locale of locales){const app=boot(page,locale);assert.equal(app.document.documentElement.lang,locale);assert.equal(app.document.documentElement.dir,locale==='ar'?'rtl':'ltr');assert.equal(app.node('interface-language').value,locale);assert.equal(app.writes.length,0);
    for(const node of app.document.querySelectorAll('[data-i18n]')){assert.equal(node.children.length,0,'binding replaces children');assert.equal(node.textContent,app.text(node.dataset.i18n));assert(!/Translation unavailable|Übersetzung nicht verfügbar|Переклад недоступний|الترجمة غير متاحة|Çeviri mevcut değil/.test(node.textContent),node.dataset.i18n);}
  }
});
await check('public radio, checked answer, feedback and input identity survive every locale',async()=>{
  const app=boot('public');const form=app.node('answer-form'),radio=app.document.querySelector('input[value="0"]');radio.checked=true;await form.fire('change',{target:radio});await form.fire('submit');
  const panel=app.node('practice-panel'),feedback=app.node('feedback'),replacements=panel.replacements;
  for(const locale of locales){await app.locale(locale);assert.equal(app.node('answer-form'),form);assert.equal(app.document.querySelector('input[value="0"]'),radio);assert(radio.checked);assert.equal(app.node('feedback'),feedback);assert.equal(feedback.hidden,false);assert.equal(panel.replacements,replacements);assert.equal(app.node('check-answer').textContent,app.text('public.checked'));assert.equal(app.document.querySelector('.task-stimulus').dir,'ltr');}
});
await check('public writing caret, composition value, checklist and details stay intact across locale changes',async()=>{
  const app=boot('public');await app.node('tab-writing').fire('click');const input=app.node('writing-response');input.value='Liebe Mila, ich helfe gern. العربية';input.selectionStart=6;input.selectionEnd=10;input.composing=true;input.focus();await input.fire('input');await app.node('review-writing').fire('click');const checkbox=app.document.querySelector('[data-review="2"]'),details=app.document.querySelector('.model-response');checkbox.checked=true;await checkbox.fire('change');details.open=true;await details.fire('toggle');const panel=app.node('practice-panel'),replacements=panel.replacements;
  for(const locale of locales){await app.locale(locale);assert.equal(app.node('writing-response'),input);assert.equal(input.value,'Liebe Mila, ich helfe gern. العربية');assert.equal(input.selectionStart,6);assert.equal(input.selectionEnd,10);assert(input.composing);assert.equal(app.document.activeElement,input);assert.equal(app.document.querySelector('[data-review="2"]'),checkbox);assert(checkbox.checked);assert.equal(app.document.querySelector('.model-response'),details);assert(details.open);assert.equal(panel.replacements,replacements);assert.equal(input.lang,'de');assert.equal(input.dir,'ltr');}
  await app.node('tab-reading').fire('click');await app.node('tab-writing').fire('click');assert.equal(app.node('writing-response').value,input.value);assert(app.document.querySelector('[data-review="2"]').checked);assert(app.document.querySelector('.model-response').open);
});
await check('actual frozen instruction registry shows one German original plus selected translation for all three demos',async()=>{
  const app=boot('public');for(const skill of ['reading','grammar','writing']){await app.node('tab-'+skill).fire('click');const expected=app.run('instructionApi.INSTRUCTIONS['+JSON.stringify('public.'+skill)+']');const original=app.document.querySelector('[data-instruction-original]');const translation=app.document.querySelector('[data-instruction-translation]');const container=app.document.querySelector('[data-instruction]');assert.equal(container.dataset.instructionDigest,expected.sourceSha256);
    for(const locale of locales){await app.locale(locale);assert.equal(app.document.querySelector('[data-instruction-original]'),original);assert.equal(original.textContent,expected.original);assert.equal(original.lang,'de');assert.equal(original.dir,'ltr');assert.equal(app.document.querySelector('[data-instruction-translation]'),translation);assert.equal(translation.hidden,locale==='de');assert.equal(translation.textContent,locale==='de'?'':expected.translations[locale]);assert.equal(translation.lang,locale);assert.equal(translation.dir,locale==='ar'?'rtl':'ltr');}
  }
});
await check('signup snapshots selected locale once while pending and preserves credentials during translation',async()=>{
  let resolve;const app=boot('signin','uk','?mode=signup',()=>new Promise(done=>{resolve=done;}));app.node('su-name').value=' Synthetic ';app.node('su-email').value=' test@example.test ';app.node('su-password').value='secret';const form=app.node('form-signup');const pending=form.fire('submit');await Promise.resolve();assert.equal(app.calls.length,1);assert.deepEqual(JSON.parse(app.calls[0].body),{email:'test@example.test',password:'secret',name:'Synthetic',language:'uk'});
  for(const locale of ['ar','tr','en']){await app.locale(locale);assert.equal(app.node('form-signup'),form);assert.equal(app.node('su-password').value,'secret');assert.equal(app.node('status').textContent,app.text('auth.signingUp'));assert(app.node('su-submit').disabled);}
  await form.fire('submit');assert.equal(app.calls.length,1);resolve({ok:false,status:422,json:async()=>({error:'invalid_email'})});await pending;assert.equal(app.node('error').textContent,app.text('auth.invalidEmail'));assert.equal(app.node('su-password').value,'secret');assert(!app.node('su-submit').disabled);assert.equal(JSON.parse(app.calls[0].body).language,'uk');
  assert(app.writes.every(([key,value])=>key==='hatoove.interface-language.v1'&&locales.includes(value)));assert.equal(app.storage.size,1);
});
await check('existing signin never sends guest language or writes account settings',async()=>{
  const app=boot('signin','ar');app.node('si-email').value='owner@example.test';app.node('si-password').value='secret';await app.node('form-signin').fire('submit');assert.deepEqual(JSON.parse(app.calls[0].body),{email:'owner@example.test',password:'secret'});assert.equal(app.calls[0].url,'/api/auth/sign-in/email');assert.equal(app.writes.length,0);
});
await check('back-forward cache restoration rereads only guest locale and retains live inputs',async()=>{
  for(const page of ['public','signin']){const app=boot(page);if(page==='public')await app.node('tab-writing').fire('click');const input=app.node(page==='public'?'writing-response':'si-email');input.value='retained value';input.focus();for(const handler of app.lifecycle.pagehide||[])handler({persisted:true});app.storage.set('hatoove.interface-language.v1','ar');for(const handler of app.lifecycle.pageshow||[])handler({persisted:true});assert.equal(app.document.documentElement.lang,'ar');assert.equal(app.node('interface-language').value,'ar');assert.equal(app.node(page==='public'?'writing-response':'si-email'),input);assert.equal(input.value,'retained value');assert.equal(app.document.activeElement,input);await app.locale('tr');assert.equal(app.node(page==='public'?'review-writing':'si-submit').textContent,app.text(page==='public'?'public.review':'auth.signin'));}
});
await check('native required and email validation follow locale and clear on editing',async()=>{
  const app=boot('signin');const email=app.node('si-email');email.validity={valueMissing:true,typeMismatch:false};await email.fire('invalid');assert.equal(email.validationMessage,app.text('auth.required'));
  await app.locale('uk');assert.equal(email.validationMessage,app.text('auth.required'));email.value='bad-address';await email.fire('input');assert.equal(email.validationMessage,'');email.validity={valueMissing:false,typeMismatch:true};await email.fire('invalid');await app.locale('ar');assert.equal(email.validationMessage,app.text('auth.invalidEmail'));email.value='valid@example.test';await email.fire('input');assert.equal(email.validationMessage,'');assert.equal(email.dataset.validationKey,undefined);
});
await check('all auth refusal classes are translated, keep inputs, and remain translatable after failure',async()=>{
  const cases=[[400,'invalid_token','invalidToken'],[401,'credentials','credentials'],[422,'invalid_email','invalidEmail'],[422,'invalid_name','invalidName'],[422,'invalid_password','invalidPassword'],[409,'user_exists','userExists'],[422,'invalid_language','invalidLanguage'],[403,'blocked','forbidden'],[429,'throttled','throttled'],[503,'recovery_unavailable','unavailable'],[503,'verification_unavailable','unavailable'],[500,'oops','server'],[400,'oops','failed']];
  for(const [status,error,key] of cases){const app=boot(error==='invalid_token'?'verify':'signin','de',error==='invalid_token'?'?token=test':'',async()=>({ok:false,status,json:async()=>({error})}));const form=app.node(error==='invalid_token'?'form-verify':'form-signin');if(error!=='invalid_token'){app.node('si-email').value='owner@example.test';app.node('si-password').value='retained';}await form.fire('submit');for(const locale of locales){await app.locale(locale);assert.equal(app.node('error').textContent,app.text('auth.'+key));assert.equal(app.node('error').hidden,false);}if(error!=='invalid_token')assert.equal(app.node('si-password').value,'retained');}
});
await check('recovery strips bearer URL, waits explicit action and translates success without replay',async()=>{
  for(const page of ['reset','verify']){const app=boot(page,'ar','?token=synthetic-bearer',async()=>({ok:true,status:200,json:async()=>({ok:true})}));assert.equal(app.location.search,'');assert.equal(app.calls.length,0);assert.equal(app.storage.size,1);assert(!JSON.stringify([...app.storage]).includes('synthetic-bearer'));if(page==='reset'){app.node('new-password').value='new-secret';app.node('confirm-password').value='wrong';await app.node('form-reset').fire('submit');assert.equal(app.calls.length,0);assert.equal(app.node('error').textContent,app.text('auth.mismatch'));app.node('confirm-password').value='new-secret';}
    await app.node('form-'+page).fire('submit');assert.equal(JSON.parse(app.calls[0].body).token,'synthetic-bearer');for(const locale of locales){await app.locale(locale);assert.equal(app.node('success').hidden,false);assert.equal(app.node('success-message').textContent,app.text(page==='reset'?'auth.resetSuccess':'auth.verifySuccess'));}await app.node('form-'+page).fire('submit');assert.equal(app.calls.length,1);
  }
});
await check('offline and timeout messages retain the exact uncertainty distinction',async()=>{
  for(const [page,search,name,key] of [['signin','','TypeError','offline'],['signin','','AbortError','timeout'],['reset','?token=synthetic','AbortError','resetTimeout']]){const app=boot(page,'de',search,async()=>{const error=new Error('synthetic');error.name=name;throw error;});if(page==='reset'){app.node('new-password').value='same';app.node('confirm-password').value='same';}await app.node(page==='signin'?'form-signin':'form-reset').fire('submit');for(const locale of locales){await app.locale(locale);assert.equal(app.node('error').textContent,app.text('auth.'+key));}}
});
await check('German assessed sample bank, writing points and model are byte-equivalent to the frozen base',()=>{
  const old=execFileSync('git',['-c','safe.directory='+root.replace(/[\\/]$/,''),'show','83e03310f32c02f80dcac01dbbfcef5d01f4ef72:public/site.js'],{cwd:root,encoding:'utf8'});
  const extract=source=>{const value=vm.runInNewContext(source.slice(source.indexOf('const bank ='),source.indexOf('const currentKey ='))+'\n({bank,writingPoints,model})');for(const items of Object.values(value.bank))for(const item of items){delete item.explanation;delete item.tip;}return JSON.stringify(value);};assert.equal(extract(read('public/site.js')),extract(old));
});
await check('all public copy bindings target only leaf nodes and never assessed German content',()=>{
  const app=boot('public');for(const node of app.document.querySelectorAll('[data-i18n]')){assert.equal(node.children.length,0);assert.equal(node.closest('.task-stimulus,.writing-points,#writing-response,.answer-option'),null,'translated assessed island');}
  assert(!read('public/site.js').includes('localStorage'));assert(!read('public/auth/entry.js').includes('localStorage'));
});
await check('frozen pre-change source discriminates missing demo locale handling and signup language snapshot',async()=>{
  const historical=path=>execFileSync('git',['-c','safe.directory='+root.replace(/[\\/]$/,''),'show','83e03310f32c02f80dcac01dbbfcef5d01f4ef72:'+path],{cwd:root,encoding:'utf8'});
  const oldDemo=boot('public','de','',null,historical('public/site.js'));oldDemo.run("setLocale('en')");assert.equal(oldDemo.node('check-answer').textContent,'Antwort prüfen');assert.notEqual(oldDemo.node('check-answer').textContent,oldDemo.text('public.check'));
  const oldAuth=boot('signin','uk','?mode=signup',null,historical('public/auth/entry.js'));await oldAuth.node('form-signup').fire('submit');assert.equal(Object.hasOwn(JSON.parse(oldAuth.calls[0].body),'language'),false);
});
console.log('Public/auth locale checks: '+count+' passed. Actual layout/device checks remain separate.');

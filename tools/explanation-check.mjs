/** Pure saved-prose contracts; synthetic data, no providers or database. */
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {packageHash} from '../server/package-contract.mjs';
import {readExplanationReview,readObjectiveEvidenceExplanation,readFinalisedMockItemExplanation} from '../server/owned-postgres/explanations.mjs';
import {projectStoredExplanation,selectedExplanationExports} from '../server/owned-postgres/explanation-views.mjs';
import {extractWritingExplanationSource as writing,extractObjectiveExplanationSource as objective,validateExplanationRepresentation as validate,makeOriginalExplanationRepresentation as original,projectExplanationView as project,unavailableExplanationView as unavailable} from '../server/explanation-contract.mjs';
import {resolveObjectiveExplanationLanguage as language,legacySeedLanguageRegistry} from '../server/explanation-language-registry.mjs';
let passed=0;const check=(name,fn)=>{fn();passed++;console.log('PASS '+name);};
const input={ownerId:'owner-a',attempt:{id:'attempt',exam_id:'telc-deutsch-b1',task_id:'task',rubric_id:'rubric'},submission:{id:'submission',attempt_id:'attempt',owner_id:'owner-a',task_version:'v1',rubric_version:'v1',explanation_language:'de'},assessment:{feedback:{comment:'  Unveränderte Rückmeldung.  '},model_version:'model',prompt_version:'prompt'}};
const source=writing(input),rep=original(source),head=r=>({language:r.language,source_sha256:r.source_sha256,representation_version:r.version});
const translated=(s,lang='ar')=>{const payload={schema:'explanation-text-v1',blocks:s.originalPayload.blocks.map(b=>({...b,text:'شرح تجريبي'}))};return {language:lang,version:'v1',source_sha256:s.sourceSha256,payload,payload_sha256:packageHash(payload),provenance:{kind:s.kind==='writing'?'builtin-simulation-dictionary':'publisher-authored',source_sha256:s.sourceSha256,...(s.kind==='writing'?{dictionary_version:'v1',dictionary_sha256:'a'.repeat(64)}:{producer_version:'v1'})}};};
check('canonical identity binds owner, all versions, model, prompt and original facts',()=>{for(const [group,key]of [['attempt','exam_id'],['attempt','task_id'],['attempt','rubric_id'],['submission','id'],['submission','task_version'],['submission','rubric_version'],['assessment','model_version'],['assessment','prompt_version']]){const x=structuredClone(input);x[group][key]+='-changed';assert.notEqual(writing(x).sourceSha256,source.sourceSha256);}const x=structuredClone(input);x.ownerId=x.submission.owner_id='other';assert.notEqual(writing(x).sourceSha256,source.sourceSha256);assert.throws(()=>writing({...input,ownerId:'other'}),/source_mismatch/);});
check('recorded unsupported language remains hash-bound and virtual, never guessed',()=>{const x=structuredClone(input);x.submission.explanation_language='zz';const a=writing(x);x.submission.explanation_language='xx';const b=writing(x);assert.equal(a.originalLanguage,null);assert.equal(a.sourceObject.original_language,'zz');assert.notEqual(a.sourceSha256,b.sourceSha256);assert.equal(original(a),null);const view=project({source:a,requestedLanguage:'ar'});assert.equal(view.state,'fallback');assert.equal(view.displayed_language,null);assert.equal(view.representation.persisted,false);});
check('virtual legacy original is unchanged, detached and unreviewed',()=>{const v=project({source});assert.equal(v.state,'original');assert.equal(v.representation.payload.blocks[0].text,input.assessment.feedback.comment);assert.equal(v.representation.provenance_kind,'virtual-original');assert.equal(v.review.educational.review_status,'unreviewed');assert.ok(Object.isFrozen(source.sourceObject));assert.equal(v.source.owner_id,undefined);});
check('stored original requires explicit exact head and complete payload',()=>{assert.equal(project({source,representations:[rep]}).representation.persisted,false);assert.equal(project({source,representations:[rep],heads:[head(rep)]}).representation.persisted,true);const x=structuredClone(rep);x.payload.blocks[0].text='different';x.payload_sha256=packageHash(x.payload);assert.throws(()=>validate(source,x));});
check('complete translation preserves whole slots, exact requested and displayed language',()=>{const r=translated(source);const v=project({source,requestedLanguage:'ar',representations:[r],heads:[head(r)]});assert.equal(v.state,'translated');assert.equal(v.displayed_language,'ar');assert.equal(v.languages.filter(x=>x.status==='available').length,2);assert.equal(v.operation,null);});
check('missing language falls back wholly without relabeling original',()=>{const v=project({source,requestedLanguage:'tr'});assert.equal(v.state,'fallback');assert.equal(v.displayed_language,'de');assert.equal(v.requested_language,'tr');assert.equal(v.requested_status,'missing');});
check('hash, slots, additional grade metadata and provenance fail closed',()=>{for(const mutate of [x=>x.source_sha256='b'.repeat(64),x=>x.payload_sha256='b'.repeat(64),x=>x.payload.blocks.push({slot:'extra',text:'extra'}),x=>x.payload.blocks[0].slot='criterion/forged/comment',x=>x.payload.score=4,x=>x.provenance.evidence='private',x=>x.provenance.kind='virtual-original']){const r=translated(source);mutate(r);assert.throws(()=>validate(source,r));const v=project({source,requestedLanguage:'ar',representations:[r],heads:[head(r)]});assert.equal(v.state,'fallback');}});
check('explicit rejection or withdrawal is exact-bound and strips private review fields',()=>{for(const status of ['rejected','withdrawn']){const r=translated(source);const review=[{targetKind:'stored',language:r.language,version:r.version,source_sha256:r.source_sha256,payload_sha256:r.payload_sha256,educational:{review_status:status,review_basis:'named_decision',blocked:true,explicit_negative:true,decision_ids:['secret'],reviewer:'private'}}];const v=project({source,requestedLanguage:'ar',representations:[r],heads:[head(r)],review});assert.equal(v.state,'fallback');assert.equal(v.requested_status,'blocked');assert.equal(JSON.stringify(v).includes('secret'),false);review[0].source_sha256='c'.repeat(64);assert.equal(project({source,requestedLanguage:'ar',representations:[r],heads:[head(r)],review}).state,'translated');}});
check('blocked original cannot be used as fallback',()=>{const review=[{targetKind:'stored',language:'de',version:rep.version,source_sha256:rep.source_sha256,payload_sha256:rep.payload_sha256,educational:{review_status:'withdrawn',review_basis:'named_decision',blocked:true,explicit_negative:true}}];const v=project({source,requestedLanguage:'tr',representations:[rep],heads:[head(rep)],review});assert.equal(v.state,'blocked');assert.equal(v.representation,null);});
check('parent blocked and unassessed views contain no source or prose',()=>{for(const [state,reason]of [['blocked','content_blocked'],['not_assessed','assessment_pending'],['not_assessed','assessment_failed']]){const v=unavailable({state,reason,requestedLanguage:'en'});assert.equal(v.source,null);assert.equal(v.representation,null);assert.equal(v.state,state);}assert.throws(()=>unavailable({state:'blocked',reason:'secret'}));});
check('three and four criterion formats preserve facts privately and expose prose only',()=>{for(const [kind,count]of [['telc-b1-bands',3],['dtz-writing-bands',4]]){const x=structuredClone(input);x.assessment.feedback={kind,criteria:Array.from({length:count},(_,i)=>({key:'k'+i,band:'B',evidence:'immutable evidence',comment:'Comment '+i})),corrections:['Correction']};const s=writing(x);assert.equal(s.originalPayload.blocks.length,count+1);assert.ok(!JSON.stringify(s.originalPayload).includes('evidence'));x.assessment.feedback.criteria[0].evidence='changed';assert.notEqual(writing(x).sourceSha256,s.sourceSha256);const r=translated(s);r.payload.blocks.reverse();r.payload_sha256=packageHash(r.payload);assert.throws(()=>validate(s,r));}});
check('UTF16 bounds and exact ECMAScript whitespace apply without shortening',()=>{for(const text of ['\u00a0','\ufeff','😀'.repeat(2001)])assert.equal(objective({examId:'x',setId:'s',setVersion:'v1',itemId:'1',originalValue:text}).supported,false);for(const text of ['\u0085','\u200b','😀'.repeat(2000)])assert.equal(objective({examId:'x',setId:'s',setVersion:'v1',itemId:'1',originalValue:text}).supported,true);});
check('unknown and empty originals remain missing, never invented',()=>{for(const feedback of [{comment:''},{comment:'  '},{kind:'future',data:{private:true}}]){const s=writing({...input,assessment:{feedback}});assert.equal(s.supported,false);assert.equal(project({source:s,requestedLanguage:'en'}).representation,null);}});
check('invalid languages and duplicate candidates cannot select arbitrary prose',()=>{assert.throws(()=>project({source,requestedLanguage:'fr'}),/invalid_explanation_language/);const r=translated(source);assert.equal(project({source,requestedLanguage:'ar',representations:[r,r],heads:[head(r)]}).state,'fallback');});
check('objective registry binds exact retained source and refuses modified/unknown bytes',()=>{const seed=JSON.parse(readFileSync(new URL('../data/seed.json',import.meta.url)));const row=seed.LV2[0].questions[0];const query={examId:'telc-deutsch-b1',setId:'telc-deutsch-b1.lv2.01',setVersion:'v1',itemId:String(row.n),originalValue:row.why};assert.equal(language(query),'de');assert.equal(language({...query,originalValue:row.why+' changed'}),null);assert.equal(language({...query,setVersion:'v999'}),null);});
check('retained seed LF and CRLF produce identical exact language declarations',()=>{
 const lf=Buffer.from(readFileSync(new URL('../data/seed.json',import.meta.url),'utf8').replace(/\r\n/g,'\n'));
 const crlf=Buffer.from(lf.toString('utf8').replace(/\n/g,'\r\n'));
 assert.notDeepEqual(lf,crlf,'the controls must exercise distinct checkout bytes');
 const a=legacySeedLanguageRegistry(lf),b=legacySeedLanguageRegistry(crlf);
 assert.ok(a.length>0);assert.deepEqual(b,a);assert.ok(Object.isFrozen(a)&&a.every(Object.isFrozen));
 const row=JSON.parse(lf).LV2[0].questions[0],declaration=a.find(value=>value.set_id==='telc-deutsch-b1.lv2.01'&&value.item_id===String(row.n));
 assert.deepEqual(declaration,{exam_id:'telc-deutsch-b1',set_id:'telc-deutsch-b1.lv2.01',set_version:'v1',item_id:String(row.n),original_value_sha256:packageHash(row.why),language:'de'});
});
check('seed trust rejects source edits and every normalization beyond CRLF to LF',()=>{
 const lf=readFileSync(new URL('../data/seed.json',import.meta.url),'utf8').replace(/\r\n/g,'\n');
 const seed=JSON.parse(lf),changed=structuredClone(seed);changed.LV2[0].questions[0].why+=' changed';
 const unrelated=structuredClone(seed);unrelated.LV2[0].questions[0].question+=' changed';
 for(const [label,bytes]of [['prose edit',JSON.stringify(changed)],['unrelated source edit',JSON.stringify(unrelated)],['extra whitespace',lf+' '],['JSON reserialization',JSON.stringify(seed)],['BOM','\ufeff'+lf],['bare CR',lf.replace(/\n/g,'\r')]]){
  assert.notEqual(bytes,lf,label+' must alter the control');
  assert.deepEqual(legacySeedLanguageRegistry(Buffer.from(bytes)),[],label+' cannot declare a language');
 }
 assert.deepEqual(legacySeedLanguageRegistry(lf),[],'the builder accepts bytes only');
});
check('trusted synthetic registry remains exact and conflicting declarations are unknown',()=>{const q={examId:'x',setId:'s',setVersion:'v1',itemId:'1',originalValue:'Synthetic'};const row={exam_id:'x',set_id:'s',set_version:'v1',item_id:'1',original_value_sha256:packageHash(q.originalValue),language:'en'};assert.equal(language(q,{registry:[row]}),'en');assert.equal(language(q,{registry:[row,{...row,language:'de'}]}),null);});
const asyncCheck=async(name,fn)=>{await fn();passed++;console.log('PASS '+name);};
const shared=objective({examId:'synthetic-exam',setId:'synthetic.set',setVersion:'v1',itemId:'1',originalValue:'Exact original.',originalLanguage:'de'});
const bundle=(s=shared,representations=[],heads=[],state='unregistered')=>({source:s,representations,heads,sourceOrigin:'standalone-key',reviewSourceBinding:{state}});
const statuses=(educational='unreviewed',native='unreviewed')=>[educational,native].map((status,index)=>({dimension:index?'native_language':'educational',
 review_status:status,review_basis:['approved','rejected','withdrawn'].includes(status)?'named_decision':'none',
 blocked:['rejected','withdrawn','unavailable'].includes(status),explicit_negative:['rejected','withdrawn'].includes(status),
 decision_ids:['approved','rejected','withdrawn'].includes(status)?['00000000-0000-4000-8000-000000000001']:[]}));
const sqlClient=(resolve=()=>statuses())=>({calls:[],async query(sql,args){this.calls.push({sql,args});return {rows:resolve(args)};}});
const locator={scope:'objective',sourceIdentity:shared.identity,sourceSha256:shared.sourceSha256,language:'de',
 representationVersion:'legacy-projection-v1',payloadSha256:packageHash(shared.originalPayload),targetKind:'original'};
await asyncCheck('two exact dimensions use all nine source/kind SQL bindings and redact private receipts',async()=>{
 const client=sqlClient(()=>statuses('approved','unreviewed')),view=await projectStoredExplanation(client,bundle());
 assert.equal(client.calls.length,1);assert.deepEqual(client.calls[0].args,['synthetic-exam','synthetic.set','v1','1',shared.sourceSha256,'de','legacy-projection-v1',packageHash(shared.originalPayload),'original']);
 assert.equal(view.review.educational.review_status,'approved');assert.equal(view.review.native_language.review_status,'unreviewed');
 for(const privateKey of ['decision_ids','sourceOrigin','reviewSourceBinding','review_source_binding','targetKind'])assert.equal(JSON.stringify(view).includes(privateKey),false);
});
await asyncCheck('malformed or missing review dimensions fail closed and SQL errors never become compatibility',async()=>{
 for(const rows of [[],statuses().slice(0,1),statuses().reverse(),statuses().map(row=>({...row,review_basis:'legacy_unattributed'})),statuses().map(row=>({...row,blocked:true}))]){
  const review=await readExplanationReview(sqlClient(()=>rows),locator);assert.equal(review.educational.review_status,'unavailable');assert.equal(review.native_language.blocked,true);
 }
 const client=sqlClient();const invalid=await readExplanationReview(client,{...locator,language:null});assert.equal(invalid.educational.blocked,true);assert.equal(client.calls.length,0);
 const error=Error('synthetic database failure');await assert.rejects(projectStoredExplanation({async query(){throw error;}},bundle()),e=>e===error);
});
await asyncCheck('personal writing remains owner-bound unreviewed without any editorial lookup',async()=>{
 const client=sqlClient(()=>assert.fail('personal review queried shared ledger'));
 const view=await projectStoredExplanation(client,{source,representations:[rep],heads:[head(rep)]});assert.equal(view.review.educational.review_status,'unreviewed');
 assert.equal((await readExplanationReview(client,{scope:'writing',sourceIdentity:source.identity,ownerId:'another-owner'})).educational.blocked,true);
 assert.equal(client.calls.length,0);
});
await asyncCheck('stored legacy-projection-v1 and virtual originals never share approval or withdrawal',async()=>{
 const r={...translated(shared,'de'),version:'legacy-projection-v1',payload:structuredClone(shared.originalPayload),payload_sha256:packageHash(shared.originalPayload)};
 const current=bundle(shared,[r],[head(r)]);
 let view=await projectStoredExplanation(sqlClient(args=>statuses(args[8]==='stored'?'approved':'withdrawn','approved')),current);
 assert.equal(view.state,'original');assert.equal(view.representation.persisted,true);assert.equal(view.review.educational.review_status,'approved');
 view=await projectStoredExplanation(sqlClient(args=>statuses(args[8]==='stored'?'withdrawn':'approved','approved')),current,'en');
 assert.equal(view.state,'blocked');assert.equal(view.representation,null);assert.equal(view.reason,'representation_withdrawn');
});
await asyncCheck('invalid and ambiguous current originals cannot manufacture a virtual fallback',async()=>{
 const r=translated(shared,'de'),bad={...r,payload_sha256:'f'.repeat(64)};
 for(const value of [bundle(shared,[bad],[head(bad)]),bundle(shared,[r,r],[head(r)]),bundle(shared,[r],[head(r),head(r)]),bundle(shared,[],[head(r)])]){
  const view=await projectStoredExplanation(sqlClient(()=>statuses('approved','approved')),value,'tr');assert.equal(view.state,'blocked');assert.equal(view.representation,null);
 }
 const english=translated(shared,'en'),view=await projectStoredExplanation(sqlClient(),bundle(shared,[english],[head(english)]),'tr');
 assert.equal(view.state,'fallback');assert.equal(view.displayed_language,'de');
});
await asyncCheck('unknown original compatibility needs valid unregistered binding and compatible retained heads',async()=>{
 const unknown=objective({...{examId:'synthetic-exam',setId:'synthetic.set',setVersion:'v1',itemId:'1'},originalValue:'Exact original.'});
 const client=sqlClient(()=>assert.fail('unknown virtual original sent to getter'));
 const view=await projectStoredExplanation(client,bundle(unknown), 'ar');assert.equal(view.state,'fallback');assert.equal(view.original_language,null);assert.equal(view.displayed_language,null);
 for(const state of ['registered','unavailable'])assert.equal((await projectStoredExplanation(client,bundle(unknown,[],[],state),'ar')).representation,null);
 const incompatible=head(translated(shared,'de'));
 assert.equal((await projectStoredExplanation(client,bundle(unknown,[],[incompatible]),'ar')).representation,null);
 const compatible=translated(unknown,'en');
 const allowed=await projectStoredExplanation(sqlClient(),bundle(unknown,[compatible],[head(compatible)]),'tr');assert.equal(allowed.state,'fallback');assert.equal(allowed.displayed_language,null);
 assert.equal((await projectStoredExplanation(sqlClient(),bundle(unknown,[compatible],[head(compatible),head(compatible)]),'tr')).representation,null);
 for(const sourceOrigin of [undefined,'claimed-history'])assert.equal((await projectStoredExplanation(client,{...bundle(unknown),sourceOrigin},'ar')).representation,null);
});
await asyncCheck('registry loss on a registered source withholds original; restored exact language observes negative',async()=>{
 const unknown=objective({examId:'synthetic-exam',setId:'synthetic.set',setVersion:'v1',itemId:'1',originalValue:'Exact original.'});
 assert.notEqual(unknown.sourceSha256,shared.sourceSha256);
 const client=sqlClient(()=>statuses('withdrawn','approved'));
 assert.equal((await projectStoredExplanation(client,bundle(unknown,[],[],'registered'))).representation,null);assert.equal(client.calls.length,0);
 const restored=await projectStoredExplanation(client,bundle(shared,[],[],'registered'));assert.equal(restored.reason,'representation_withdrawn');assert.equal(restored.representation,null);assert.equal(client.calls.length,1);
});
await asyncCheck('protected wrappers fix their own origins and reject malformed classifier metadata',async()=>{
 const envelope={kind:'objective',context:{...shared.identity},originalValue:'Exact original.',representations:[],heads:[],review_source_binding:{state:'unregistered'},sourceOrigin:'hostile-claim'};
 const client={async query(){return {rows:[{envelope:structuredClone(envelope)}]};}};
 assert.equal((await readObjectiveEvidenceExplanation(client,{evidenceId:'synthetic'})).sourceOrigin,'standalone-key');
 assert.equal((await readFinalisedMockItemExplanation(client,{runId:'synthetic',setId:'synthetic.set',setVersion:'v1',itemId:'1'})).sourceOrigin,'finalised-snapshot');
 for(const binding of [undefined,null,{}, {state:'future'},{state:'unregistered',authority:'forged'}]){
  envelope.review_source_binding=binding;await assert.rejects(readObjectiveEvidenceExplanation(client,{evidenceId:'synthetic'}),/invalid_explanation_envelope/);
 }
});
await asyncCheck('export deduplication retains every selector and requested withdrawal fallback reason',async()=>{
 const r=translated(shared,'en'),client=sqlClient(args=>statuses(args[5]==='en'?'withdrawn':'approved','approved'));
 const rows=await selectedExplanationExports(client,bundle(shared,[r],[head(r)]),{evidence_id:'synthetic'});
 assert.equal(rows.length,1);assert.equal(rows[0].language,'de');assert.equal(rows[0].representation.persisted,false);
 assert.deepEqual(rows[0].selections.map(s=>s.selection_language),[null,'de','en','uk','ar','tr']);
 assert.deepEqual(rows[0].selections.find(s=>s.selection_language==='en'),{selection_language:'en',state:'fallback',requested_status:'blocked',reason:'representation_withdrawn',displayed_language:'de'});
 assert.equal(JSON.stringify(rows).includes('decision_ids'),false);assert.equal(JSON.stringify(rows).includes('reviewSourceBinding'),false);
});
await asyncCheck('blocked and missing exports retain six separate prose-free selector receipts',async()=>{
 const rows=await selectedExplanationExports(sqlClient(()=>statuses('rejected','approved')),bundle(),{run_id:'synthetic',item_id:'1'});
 assert.equal(rows.length,6);assert.deepEqual(rows.map(row=>row.selections[0].selection_language),[null,'de','en','uk','ar','tr']);
 assert(rows.every(row=>row.language===null&&row.representation===null&&row.selections.length===1));
 assert.equal(JSON.stringify(rows).includes('Exact original.'),false);
 const missing=objective({examId:'synthetic-exam',setId:'synthetic.set',setVersion:'v1',itemId:'1',originalValue:null,originalLanguage:'de'});
 const absent=await selectedExplanationExports(sqlClient(()=>assert.fail('missing prose queried reviewer')),bundle(missing),{});assert.equal(absent.length,6);assert(absent.every(row=>row.representation===null&&row.selections[0].state==='missing'));
});
console.log(`Saved explanation pure checks: ${passed} passed.`);

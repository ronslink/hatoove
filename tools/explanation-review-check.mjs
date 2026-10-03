/** Offline exact-identity and operator dispatch checks. No database or provider. */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {validateExplanationReviewLocator as locator,validateExplanationReviewSubject as subject} from '../server/explanation-review-contract.mjs';
import {validateContentReview,validateReviewSubject} from '../server/content-review-contract.mjs';
import {registerExplanationReviewTarget,readExplanationReviewPacket,readExplanationCoverage} from '../server/owned-postgres/explanation-review.mjs';
import {parseReviewArgs,executeReviewCommand,main} from './review-content.mjs';
let passed=0;const check=async(name,fn)=>{await fn();passed++;console.log('PASS '+name);};
const p={scope:'objective',targetKind:'stored',sourceIdentity:{exam_id:'telc-deutsch-b1',set_id:'sample',set_version:'v1',item_id:'1'},sourceSha256:'a'.repeat(64),language:'ar',representationVersion:'translation-v1',payloadSha256:'b'.repeat(64)};
const s={kind:'explanation',examId:p.sourceIdentity.exam_id,subjectId:randomUUID(),version:p.representationVersion,sha256:'c'.repeat(64)};
const event={eventId:randomUUID(),subject:s,category:'language',language:'ar',authorityId:randomUUID(),expectedDecisionId:null,decision:'approve',evidenceRef:'fixture://review',evidenceSha256:'d'.repeat(64),rationale:'Synthetic review only',packetSha256:'e'.repeat(64)};
await check('stored locator is detached and original target has exact virtual version',()=>{
 const copy=locator(p);assert.deepEqual(copy,p);copy.sourceIdentity.item_id='2';assert.equal(p.sourceIdentity.item_id,'1');
 assert.equal(locator({...p,targetKind:'original',representationVersion:'legacy-projection-v1'}).targetKind,'original');
 assert.throws(()=>locator({...p,targetKind:'original'}));
});
await check('every missing and extra field is refused at both identity levels',()=>{
 for(const key of Object.keys(p)){const value={...p};delete value[key];assert.throws(()=>locator(value));}
 for(const key of Object.keys(p.sourceIdentity)){const i={...p.sourceIdentity};delete i[key];assert.throws(()=>locator({...p,sourceIdentity:i}));}
 for(const patch of [{ownerId:'private'},{submissionId:randomUUID()},{table:'submissions'},{authorityId:randomUUID()}])assert.throws(()=>locator({...p,...patch}));
 assert.throws(()=>locator({...p,sourceIdentity:{...p.sourceIdentity,owner_id:'private'}}));
});
await check('personal scopes, unsupported language and all digest/type mismatches refuse',()=>{
 for(const patch of [{scope:'writing'},{targetKind:'virtual'},{language:null},{language:'fr'},{sourceSha256:'A'.repeat(64)},{payloadSha256:'b'.repeat(63)},{representationVersion:''},{sourceSha256:1}])assert.throws(()=>locator({...p,...patch}));
 for(const key of Object.keys(p.sourceIdentity))assert.throws(()=>locator({...p,sourceIdentity:{...p.sourceIdentity,[key]:null}}));
});
await check('exact ASCII boundaries reject trailing line endings and Unicode aliases',()=>{
 for(const key of ['sourceSha256','payloadSha256','representationVersion'])for(const end of ['\n','\r\n','\u200b'])assert.throws(()=>locator({...p,[key]:p[key]+end}));
 for(const key of Object.keys(p.sourceIdentity))assert.throws(()=>locator({...p,sourceIdentity:{...p.sourceIdentity,[key]:p.sourceIdentity[key]+'\n'}}));
 assert.equal(locator({...p,representationVersion:'x'.repeat(64)}).representationVersion.length,64);assert.throws(()=>locator({...p,representationVersion:'x'.repeat(65)}));
});
await check('accessors, symbols, custom prototypes and proxies are rejected without evaluating hooks',()=>{
 let calls=0;const accessor={...p};Object.defineProperty(accessor,'language',{get(){calls++;throw Error('private');}});
 assert.throws(()=>locator(accessor));assert.throws(()=>locator(new Proxy(p,{ownKeys(){calls++;throw Error('private');}})));
 const nested={...p,sourceIdentity:new Proxy(p.sourceIdentity,{get(){calls++;throw Error('private');}})};assert.throws(()=>locator(nested));
 assert.throws(()=>locator({...p,[Symbol('private')]:true}));assert.throws(()=>locator(Object.assign(Object.create({}),p)));assert.equal(calls,0);
});
await check('new subject retains typed UUID and full representation version without loosening old kinds',()=>{
 assert.deepEqual(subject(s),s);assert.deepEqual(validateReviewSubject(s),s);assert.throws(()=>subject({...s,subjectId:'source@v1'}));
 assert.throws(()=>subject({...s,kind:'content'}));assert.throws(()=>subject({...s,version:s.version+'\n'}));
 assert.throws(()=>validateReviewSubject({kind:'form',examId:s.examId,subjectId:'form',version:'translation-v1',sha256:s.sha256}));
});
await check('language decisions are typed to explanations; both dimensions require packet hash for approval',()=>{
 assert.deepEqual(validateContentReview(event),event);assert.equal(validateContentReview({...event,category:'educational',language:''}).category,'educational');
 for(const patch of [{packetSha256:null},{category:'audio'},{category:'educational',language:'de'}])assert.throws(()=>validateContentReview({...event,...patch}));
 assert.throws(()=>validateContentReview({...event,subject:{kind:'content',examId:s.examId,subjectId:'x@v1',version:'',sha256:s.sha256}}));
 assert.equal(validateContentReview({...event,decision:'withdraw',packetSha256:null}).packetSha256,null);
});
await check('all personal operator targets fail before any database query',async()=>{
 const client={query(){throw Error('must not query personal data');}};
 await assert.rejects(registerExplanationReviewTarget(client,{...p,scope:'writing'}),{code:'review_input_invalid'});
 await assert.rejects(readExplanationReviewPacket(client,{...s,kind:'writing'}),{code:'review_input_invalid'});
 await assert.rejects(readExplanationCoverage(client,{examId:s.examId,languages:['fr']}),{code:'review_input_invalid'});
 await assert.rejects(readExplanationCoverage(client,{examId:s.examId,ownerId:'private'}),{code:'review_input_invalid'});
 await assert.rejects(readExplanationCoverage(client,{examId:s.examId,scope:'writing'}),{code:'review_input_invalid'});
});
await check('existing CLI accepts only exact new operation options and remains dry-run by default',()=>{
 assert.equal(parseReviewArgs(['explanation-target','--input','fixture.json']).apply,false);
 assert.equal(parseReviewArgs(['explanation-target','--input','fixture.json','--apply']).apply,true);
 for(const args of [['explanation-target','--input','x','--apply','--dry-run'],['explanation-packet','--subject-file','x','--output','y','--apply'],['explanation-coverage','--exam','x','--input','y'],['explanation-target','--owner','private']])assert.throws(()=>parseReviewArgs(args));
});
await check('registration exact replay is a receipt after rights loss and dry-run always rolls back',async()=>{
 const calls=[];const row={target_id:s.subjectId,exam_id:s.examId,representation_version:s.version,target_sha256:s.sha256};
 const client={async query(sql){calls.push(sql);if(sql.startsWith('SELECT current_user'))return {rows:[{allowed:true,isolation:'read committed'}]};if(sql.startsWith('SELECT * FROM explanation_review_target'))return {rows:[row]};if(/rights|objective_set/.test(sql))throw Error('replay must not read prose or rights');return {rows:[]};}};
 const result=await executeReviewCommand(client,parseReviewArgs(['explanation-target','--input','fixture']),{readJson:async()=>p});
 assert.equal(result.mode,'dry_run');assert.equal(result.receipt.unchanged,true);assert.equal(calls[0],'BEGIN');assert.equal(calls.at(-1),'ROLLBACK');assert.ok(!calls.includes('COMMIT'));
});
await check('new operator CLI never default-connects or infers a database',async()=>{
 await assert.rejects(main(['explanation-coverage','--exam','telc-deutsch-b1'],{}),{code:'review_database_selection_required'});
});
console.log('Explanation review offline: '+passed+' checks passed.');

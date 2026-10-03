/** Exact shared editorial identity only; no I/O, learner identity or authority inference. */
import {types} from 'node:util';
const ID=/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/,ITEM=/^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/;
const VERSION=/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/,SET_VERSION=/^v[0-9]{1,4}$/;
const SHA=/^[a-f0-9]{64}$/,UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const languages=['de','en','uk','ar','tr'];
const fail=()=>{const e=new Error('review_input_invalid');e.code='review_input_invalid';throw e;};
function exact(value,keys){
 if(!value||typeof value!=='object'||types.isProxy(value)||![Object.prototype,null].includes(Object.getPrototypeOf(value)))fail();
 const descriptors=Object.getOwnPropertyDescriptors(value),actual=Reflect.ownKeys(descriptors);
 if(actual.length!==keys.length||actual.some(key=>typeof key!=='string'||!keys.includes(key)||!Object.hasOwn(descriptors[key],'value')))fail();
 return Object.fromEntries(keys.map(key=>[key,descriptors[key].value]));
}
const matches=(value,pattern)=>typeof value==='string'&&pattern.exec(value)?.[0]===value;
export function validateExplanationReviewLocator(value){
 const p=exact(value,['scope','targetKind','sourceIdentity','sourceSha256','language','representationVersion','payloadSha256']);
 const i=exact(p.sourceIdentity,['exam_id','set_id','set_version','item_id']);
 if(p.scope!=='objective'||!['stored','original'].includes(p.targetKind)||!matches(i.exam_id,ID)||!matches(i.set_id,ID)||!matches(i.set_version,SET_VERSION)||!matches(i.item_id,ITEM)
  ||!matches(p.sourceSha256,SHA)||!matches(p.payloadSha256,SHA)||!languages.includes(p.language)||!matches(p.representationVersion,VERSION)
  ||p.targetKind==='original'&&p.representationVersion!=='legacy-projection-v1')fail();
 return {...p,sourceIdentity:i};
}
export function validateExplanationReviewSubject(value){
 const s=exact(value,['kind','examId','subjectId','version','sha256']);
 if(s.kind!=='explanation'||!matches(s.examId,ID)||!matches(s.subjectId,UUID)||!matches(s.version,VERSION)||!matches(s.sha256,SHA))fail();
 return s;
}

/** Immutable prose projection. No database, provider or grading side effects. */
import {packageHash,canonicalJson} from './package-contract.mjs';
export const EXPLANATION_LANGUAGES=Object.freeze(['de','en','uk','ar','tr']);
const VERSION=/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/,HASH=/^[a-f0-9]{64}$/;
const object=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const exact=(x,keys)=>object(x)&&Object.keys(x).length===keys.length&&keys.every(k=>Object.hasOwn(x,k));
const text=(x,max)=>typeof x==='string'&&x.trim().length>0&&x.length<=max;
const copy=x=>structuredClone(x);
const freeze=x=>{if(x&&typeof x==='object'){Object.values(x).forEach(freeze);Object.freeze(x);}return x;};
export function explanationError(code='invalid_explanation'){const e=new Error(code);e.code=code;throw e;}
const demand=(value,code)=>{if(!value)explanationError(code);};
export function validateExplanationLanguage(value){if(value!==null&&!EXPLANATION_LANGUAGES.includes(value))explanationError('invalid_explanation_language');return value;}
export const explanationPayloadHash=packageHash;

function descriptor(kind,identity,originalValue,originalLanguage,originalFormat,blocks,recordedLanguage=originalLanguage){
 const sourceObject={format_version:'explanation-source-v1',kind,...identity,original_language:recordedLanguage,original_format:originalFormat,original_value:originalValue??null};
 return freeze({formatVersion:'explanation-source-v1',kind,identity:copy(identity),sourceObject:copy(sourceObject),sourceSha256:packageHash(sourceObject),originalLanguage,originalFormat,
  originalPayload:blocks?{schema:'explanation-text-v1',blocks:copy(blocks)}:null,supported:Boolean(blocks?.length)});
}
export function extractObjectiveExplanationSource({examId,setId,setVersion,itemId,originalValue,originalLanguage=null}){
 const language=EXPLANATION_LANGUAGES.includes(originalLanguage)?originalLanguage:null;
 const supported=text(originalValue,4000);
 return descriptor('objective',{exam_id:examId,set_id:setId,set_version:setVersion,item_id:itemId},originalValue,language,
  typeof originalValue==='string'?'objective-string':'unsupported',supported?[{slot:'objective/comment',text:originalValue}]:null);
}
export function extractWritingExplanationSource({ownerId,attempt,submission,assessment}){
 demand(object(attempt)&&object(submission)&&object(assessment),'explanation_source_mismatch');
 demand(typeof ownerId==='string'&&ownerId===submission.owner_id&&attempt.id===submission.attempt_id,'explanation_source_mismatch');
 const identity={owner_id:ownerId,submission_id:submission.id,attempt_id:attempt.id,exam_id:attempt.exam_id??null,
  task_id:attempt.task_id,task_version:submission.task_version,rubric_id:attempt.rubric_id,rubric_version:submission.rubric_version,
  model_version:assessment.model_version??'unknown',prompt_version:assessment.prompt_version??'unknown'};
 const feedback=assessment.feedback??null,language=EXPLANATION_LANGUAGES.includes(submission.explanation_language)?submission.explanation_language:null;
 let format='unsupported',blocks=null;
 if(object(feedback)&&['telc-b1-bands','dtz-writing-bands'].includes(feedback.kind)){
  format=feedback.kind;
  const max=feedback.kind==='dtz-writing-bands'?4:3;
  if(exact(feedback,['kind','criteria','corrections'])&&Array.isArray(feedback.criteria)&&feedback.criteria.length===max&&Array.isArray(feedback.corrections)&&feedback.corrections.length<=40){
   const keys=new Set();blocks=[];
   for(const criterion of feedback.criteria){
    if(!exact(criterion,['key','band','evidence','comment'])||!text(criterion.key,128)||criterion.key.includes('/')||keys.has(criterion.key)||!text(criterion.comment,4000)){blocks=null;break;}
    keys.add(criterion.key);blocks.push({slot:'criterion/'+criterion.key+'/comment',text:criterion.comment});
   }
   if(blocks)for(const [index,correction] of feedback.corrections.entries()){
    if(!text(correction,1000)){blocks=null;break;}blocks.push({slot:'correction/'+index,text:correction});
   }
  }
 }else if(object(feedback)&&Object.keys(feedback).every(k=>['kind','comment'].includes(k))){
  format='legacy-comment';if(text(feedback.comment,4000))blocks=[{slot:'legacy/comment',text:feedback.comment}];
 }
 return descriptor('writing',identity,feedback,language,format,blocks,submission.explanation_language??null);
}
export function validateExplanationRepresentation(source,r){
 demand(source?.supported&&exact(r,['language','version','source_sha256','payload','payload_sha256','provenance']));
 demand(EXPLANATION_LANGUAGES.includes(r.language)&&VERSION.test(r.version)&&HASH.test(r.source_sha256)&&r.source_sha256===source.sourceSha256);
 demand(exact(r.payload,['schema','blocks'])&&r.payload.schema==='explanation-text-v1'&&Array.isArray(r.payload.blocks)
  &&r.payload.blocks.length===source.originalPayload.blocks.length&&r.payload.blocks.length<=44);
 r.payload.blocks.forEach((block,index)=>demand(exact(block,['slot','text'])&&block.slot===source.originalPayload.blocks[index].slot&&text(block.text,block.slot.startsWith('correction/')?1000:4000)));
 demand(HASH.test(r.payload_sha256)&&packageHash(r.payload)===r.payload_sha256);
 const p=r.provenance;
 if(p?.kind==='original-assessment'){
  demand(exact(p,['kind','source_sha256'])&&source.kind==='writing'&&r.language===source.originalLanguage&&canonicalJson(r.payload)===canonicalJson(source.originalPayload));
 }else if(p?.kind==='builtin-simulation-dictionary'){
  demand(exact(p,['kind','source_sha256','dictionary_version','dictionary_sha256'])&&source.kind==='writing'&&VERSION.test(p.dictionary_version)&&HASH.test(p.dictionary_sha256));
 }else if(p?.kind==='publisher-authored')demand(exact(p,['kind','source_sha256','producer_version'])&&source.kind==='objective'&&VERSION.test(p.producer_version));
 else explanationError();
 demand(p.source_sha256===source.sourceSha256);
 return copy(r);
}
export function makeOriginalExplanationRepresentation(source,{version='original-v1'}={}){
 if(!source?.supported||source.kind!=='writing'||!source.originalLanguage)return null;
 return validateExplanationRepresentation(source,{language:source.originalLanguage,version,source_sha256:source.sourceSha256,payload:copy(source.originalPayload),
  payload_sha256:packageHash(source.originalPayload),provenance:{kind:'original-assessment',source_sha256:source.sourceSha256}});
}
const defaultDimension=()=>({review_status:'unreviewed',review_basis:'none',blocked:false,explicit_negative:false});
export const unreviewedExplanation=()=>({educational:defaultDimension(),native_language:defaultDimension()});
function safeReview(value){
 const project=x=>{
  if(!x)return defaultDimension();
  const valid=['approved','unreviewed','rejected','withdrawn','unavailable'].includes(x.review_status)&&['none','named_decision','legacy_unattributed'].includes(x.review_basis)&&typeof x.blocked==='boolean'&&typeof x.explicit_negative==='boolean';
  if(!valid)return {review_status:'unavailable',review_basis:'none',blocked:true,explicit_negative:false};
  const negative=['rejected','withdrawn'].includes(x.review_status);
  return {review_status:x.review_status,review_basis:x.review_basis,blocked:x.blocked||negative||x.review_status==='unavailable',explicit_negative:negative};
 };
 return {educational:project(value?.educational),native_language:project(value?.native_language)};
}
const blocked=r=>r.educational.blocked||r.native_language.blocked;
const blockReason=r=>[r.educational,r.native_language].some(x=>x.review_status==='withdrawn')?'representation_withdrawn':
 [r.educational,r.native_language].some(x=>x.review_status==='rejected')?'representation_rejected':'representation_unavailable';
function base(requestedLanguage){return {schema:'explanation-view-v1',source:null,requested_language:requestedLanguage,original_language:null,displayed_language:null,
 state:'missing',requested_status:'missing',reason:'original_missing',representation:null,review:unreviewedExplanation(),
 languages:EXPLANATION_LANGUAGES.map(language=>({language,status:'missing'})),operation:null};}
export function unavailableExplanationView({requestedLanguage=null,state,reason}){
 validateExplanationLanguage(requestedLanguage);
 demand(['blocked','not_assessed'].includes(state)&&['content_blocked','assessment_pending','assessment_failed'].includes(reason));
 const value=base(requestedLanguage);value.state=state;value.reason=reason;
 if(state==='blocked'){value.requested_status='blocked';value.languages.forEach(x=>x.status='blocked');}
 return value;
}
export function projectExplanationView({source,requestedLanguage=null,representations=[],heads=[],review=[]}){
 validateExplanationLanguage(requestedLanguage);
 const requested=requestedLanguage??source?.originalLanguage??null,result=base(requested);
 if(!source)return result;
 const {owner_id,attempt_id,model_version,prompt_version,...publicIdentity}=source.identity;
 result.source={kind:source.kind,source_sha256:source.sourceSha256,...publicIdentity};result.original_language=source.originalLanguage;
 if(!source.supported){result.reason=source.sourceObject.original_value===null||source.sourceObject.original_value===''?'original_missing':'unsupported_original';return result;}
 const candidates=new Map();
 for(const r of representations){try{
  const valid=validateExplanationRepresentation(source,r);
  if(heads.filter(h=>h.language===valid.language&&h.source_sha256===valid.source_sha256&&h.representation_version===valid.version).length!==1)continue;
  if(candidates.has(valid.language)){candidates.set(valid.language,null);continue;}candidates.set(valid.language,valid);
 }catch{/* A corrupt optional sibling never changes the original result. */}}
 const virtual={language:source.originalLanguage,version:'legacy-projection-v1',source_sha256:source.sourceSha256,payload:source.originalPayload,payload_sha256:packageHash(source.originalPayload),provenance:{kind:'virtual-original'}};
 const reviewOf=r=>safeReview(review.find(x=>x.language===r.language&&x.version===r.version&&x.source_sha256===r.source_sha256&&x.payload_sha256===r.payload_sha256));
 const original=candidates.get(source.originalLanguage)||virtual;
 const originalReview=reviewOf(original);
 for(const language of result.languages){const r=candidates.get(language.language)||(language.language===source.originalLanguage?original:null);if(r)language.status=blocked(reviewOf(r))?'blocked':'available';}
 let selected=requested===source.originalLanguage?original:candidates.get(requested),selectedReview=selected?reviewOf(selected):null;
 if(selected&&blocked(selectedReview)){result.requested_status='blocked';result.reason=blockReason(selectedReview);selected=null;}
 else if(selected){result.requested_status='available';result.reason=null;}
 else {result.requested_status='missing';result.reason='translation_unavailable';}
 if(!selected){if(!blocked(originalReview)){selected=original;selectedReview=originalReview;result.state='fallback';}else{result.state='blocked';result.reason=blockReason(originalReview);result.review=originalReview;return result;}}
 else result.state=selected.language===source.originalLanguage?'original':'translated';
 result.displayed_language=selected.language;result.review=selectedReview;
 result.representation={version:selected.version,payload_sha256:selected.payload_sha256,persisted:selected!==virtual,payload:copy(selected.payload),provenance_kind:selected.provenance.kind};
 return result;
}

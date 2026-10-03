import {validateExplanationReviewSubject} from './explanation-review-contract.mjs';
/** Operator inputs only. This contract does not establish human qualifications. */
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHA=/^[0-9a-f]{64}$/;
export const REVIEW_LANGUAGES=Object.freeze(['de','en','uk','ar','tr']);
export const REVIEW_CATEGORIES=Object.freeze(['educational','language','audio','exam_format']);
export function reviewError(code='review_input_invalid'){const e=new Error(code);e.code=code;throw e;}
const demand=v=>{if(!v)reviewError();};
const text=(v,max,min=1)=>typeof v==='string'&&v.length<=max&&v.trim().length>=min&&!v.includes('\0');
const object=(v,keys)=>demand(v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).every(k=>keys.includes(k)));
const nullableUuid=v=>v===null||(typeof v==='string'&&UUID.test(v));
function evidence(p){demand(UUID.test(p.eventId??'')&&text(p.evidenceRef,500)&&SHA.test(p.evidenceSha256??'')&&text(p.rationale,2000,3));}
export function validateReviewSubject(s){
 if(s&&Object.getOwnPropertyDescriptor(s,'kind')?.value==='explanation')return validateExplanationReviewSubject(s);
 object(s,['kind','examId','subjectId','version','sha256']);
 demand(['content','blueprint','form'].includes(s.kind)&&text(s.examId,128)&&text(s.subjectId,300)&&SHA.test(s.sha256??''));
 demand(s.kind==='content'?s.version==='':typeof s.version==='string'&&/^v[0-9]{1,4}$/.test(s.version));
 demand(s.kind!=='blueprint'||s.subjectId===s.examId);
 return {kind:s.kind,examId:s.examId,subjectId:s.subjectId,version:s.version,sha256:s.sha256};
}
export function validateReviewerAuthority(p){
 object(p,['eventId','reviewerId','reviewerName','examId','category','language','action','expectedAuthorityId','evidenceRef','evidenceSha256','rationale']);evidence(p);
 demand(typeof p.reviewerId==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/.test(p.reviewerId)&&text(p.reviewerName,200,2)&&text(p.examId,128));
 demand(REVIEW_CATEGORIES.includes(p.category)&&typeof p.language==='string'&&['grant','revoke'].includes(p.action)&&nullableUuid(p.expectedAuthorityId));
 demand(['educational','exam_format'].includes(p.category)?p.language==='':REVIEW_LANGUAGES.includes(p.language));
 return {...p};
}
export function validateContentReview(p){
 object(p,['eventId','subject','category','language','authorityId','expectedDecisionId','decision','evidenceRef','evidenceSha256','rationale','packetSha256']);evidence(p);
 const subject=validateReviewSubject(p.subject);
 demand((subject.kind==='explanation'?['educational','language']:['educational','audio','exam_format']).includes(p.category)&&typeof p.language==='string'&&UUID.test(p.authorityId??'')&&nullableUuid(p.expectedDecisionId)&&['approve','reject','withdraw'].includes(p.decision));
 demand(['audio','language'].includes(p.category)?REVIEW_LANGUAGES.includes(p.language):p.language==='');
 demand(subject.kind!=='explanation'||p.decision!=='approve'||SHA.test(p.packetSha256??''));
 demand(p.packetSha256==null||SHA.test(p.packetSha256));
 return {...p,subject,packetSha256:p.packetSha256??null};
}

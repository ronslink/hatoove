/** Privileged operator workflow. Callers own a transaction on one migration-role client. */
import {validateReviewerAuthority,validateContentReview,validateReviewSubject,REVIEW_LANGUAGES,reviewError} from '../content-review-contract.mjs';
import {readMediaBytes} from '../media-contract.mjs';
import {packageHash,validateCompleteForm,validateCompleteMembers,objectiveItems} from '../package-contract.mjs';
import {contentPolicy} from '../content-policy.mjs';
import {readCurrentReleaseEligibility} from './release-eligibility.mjs';

async function operator(client){
 const {rows:[r]}=await client.query('SELECT current_user=pg_get_userbyid(nspowner) AS allowed FROM pg_namespace WHERE nspname=current_schema()');
 if(!r?.allowed)reviewError('review_operator_required');
}
async function fence(client,examId){await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,7351))',[examId]);}
const authorityReceipt=(r,unchanged)=>({authorityId:r.authority_id,eventId:r.event_id,revision:r.revision,action:r.action,requestSha256:r.request_sha256,recordedAt:r.recorded_at,unchanged});
const decisionReceipt=(r,unchanged)=>({decisionId:r.decision_id,eventId:r.event_id,revision:r.revision,decision:r.decision,requestSha256:r.request_sha256,recordedAt:r.recorded_at,unchanged});
export async function recordReviewerAuthority(client,input){
 const p=validateReviewerAuthority(input);await operator(client);await fence(client,p.examId);
 const old=await client.query('SELECT authority_id FROM content_review_authority WHERE event_id=$1',[p.eventId]);
 const {rows:[r]}=await client.query('SELECT * FROM append_review_authority($1::jsonb)',[JSON.stringify(p)]);
 return authorityReceipt(r,old.rowCount>0);
}
export async function recordContentReview(client,input,options={}){
 const p=validateContentReview(input);await operator(client);await fence(client,p.subject.examId);
 const old=await client.query('SELECT decision_id FROM content_review_decision WHERE event_id=$1',[p.eventId]);
 // Lost-response replay survives later authority revocation and missing media; SQL compares exact input.
 if(!old.rowCount&&p.category==='audio'&&p.decision==='approve'){
  const {rows:[m]}=await client.query('SELECT * FROM exam_media WHERE content_version_id=$1 AND exam_id=$2',[p.subject.subjectId,p.subject.examId]);
  await readMediaBytes(m,options);
 }
 const {rows:[r]}=await client.query('SELECT * FROM append_content_review($1::jsonb)',[JSON.stringify(p)]);
 return decisionReceipt(r,old.rowCount>0);
}
const backingQueries={
 task:'SELECT to_jsonb(t) AS data FROM task_version t WHERE content_version_id=$1',
 rubric:'SELECT to_jsonb(t) AS data FROM rubric_version t WHERE content_version_id=$1',
 guide:'SELECT to_jsonb(t) AS data FROM guide t WHERE content_version_id=$1',
 vocab:'SELECT to_jsonb(t) AS data FROM vocab_entry t WHERE content_version_id=$1',
 nouns:'SELECT to_jsonb(t) AS data FROM noun_entry t WHERE content_version_id=$1',
 media:'SELECT to_jsonb(t) AS data FROM exam_media t WHERE content_version_id=$1',
};
export async function readReviewPacket(client,input,options={}){
 const s=validateReviewSubject(input);await operator(client);
 const {rows:[target]}=await client.query('SELECT * FROM resolve_review_subject($1,$2,$3,$4)',[s.kind,s.examId,s.subjectId,s.version]);
 if(!target||target.subject_sha256!==s.sha256)reviewError('review_subject_mismatch');
 let source,protectedKeys=null,mediaVerified=null;
 if(s.kind==='content'){
  const {rows:[cv]}=await client.query('SELECT * FROM content_version WHERE content_version_id=$1',[s.subjectId]);
  const q=backingQueries[cv.kind==='lexicon'?cv.family:cv.kind];
  const backing=q?(await client.query(q+' ORDER BY to_jsonb(t)::text',[s.subjectId])).rows:[];
  const {rows:[set]}=await client.query('SELECT * FROM objective_set WHERE content_version_id=$1',[s.subjectId]);
  if(set){source={metadata:cv,objective:set};protectedKeys=(await client.query('SELECT * FROM objective_key WHERE set_id=$1 AND version=$2',[set.set_id,set.version])).rows;}
  else source={metadata:cv,backing:backing.map(x=>x.data)};
  if(cv.kind==='guide')source.sections=(await client.query('SELECT s.* FROM guide_section s JOIN guide g USING(guide_id) WHERE g.content_version_id=$1 ORDER BY s.guide_id,s.ordinal,s.section_id',[s.subjectId])).rows;
  if(cv.kind==='media'){await readMediaBytes(backing[0]?.data,options);mediaVerified=true;}
 }else{
  const query=s.kind==='blueprint'?'SELECT * FROM exam_blueprint WHERE exam_id=$1 AND version=$2':'SELECT * FROM exam_form WHERE exam_id=$1 AND form_id=$2 AND version=$3';
  source=(await client.query(query,s.kind==='blueprint'?[s.examId,s.version]:[s.examId,s.subjectId,s.version])).rows[0];
 }
 // PostgreSQL timestamptz rows arrive as Date objects; normalize them before canonical hashing.
 const packet=JSON.parse(JSON.stringify({schemaVersion:1,subject:s,requiredReview:{category:target.category,language:target.language},source,protectedKeys,mediaVerified}));
 return {packet,packetSha256:packageHash(packet)};
}
/** No artifact registration or learner-writing access exists at this seam yet. */
export async function readExplanationReview(_client,_identity){return {review_status:'unreviewed',review_basis:'none',blocked:false,explicit_negative:false,decision_ids:[],coverage:'not_modelled'};}

export async function readContentCoverage(client,{examId,releaseVersion,languages=REVIEW_LANGUAGES},options={}){
 await operator(client);
 if(typeof examId!=='string'||!examId||!Array.isArray(languages)||languages.some(x=>!REVIEW_LANGUAGES.includes(x)))reviewError();
 const {rows:[release]}=await client.query('SELECT r.* FROM exam_release r WHERE r.exam_id=$1 AND r.version=COALESCE($2,(SELECT release_version FROM exam_release_head WHERE exam_id=$1))',[examId,releaseVersion??null]);
 if(!release)reviewError('review_subject_unavailable');
 const {rows:[blueprint]}=await client.query('SELECT * FROM exam_blueprint WHERE exam_id=$1 AND version=$2',[examId,release.blueprint_version]);
 const {rows:[exam]}=await client.query('SELECT * FROM exam_package WHERE exam_id=$1',[examId]);
 const {rows:forms}=await client.query('SELECT f.* FROM exam_release_form rf JOIN exam_form f ON (f.exam_id,f.form_id,f.version)=(rf.exam_id,rf.form_id,rf.form_version) WHERE rf.exam_id=$1 AND rf.release_version=$2 ORDER BY f.form_id,f.version',[examId,release.version]);
 const subjects=new Map(),reports=[];
 async function add(id){
  if(subjects.has(id))return;
  const {rows:[r]}=await client.query(`SELECT cv.content_version_id,cv.kind,cv.family,cv.content_sha256,COALESCE(cr.basis,cv.rights_status) AS rights_status,p.* FROM content_version cv LEFT JOIN content_rights cr USING(content_version_id) CROSS JOIN LATERAL effective_content_review(cv.content_version_id) p WHERE cv.content_version_id=$1`,[id]);
  if(!r){subjects.set(id,{content_version_id:id,review_status:'unavailable',review_basis:'none',rights_status:'unknown',mediaVerified:null});return;}
  const required=(await client.query('SELECT category,language FROM resolve_review_subject($1,$2,$3,$4)',['content',examId,id,''])).rows[0];
  r.requiredReview=required??null;r.mediaVerified=null;
  if(r.kind==='media'){try{const {rows:[media]}=await client.query('SELECT * FROM exam_media WHERE content_version_id=$1',[id]);await readMediaBytes(media,options);r.mediaVerified=true;}catch{r.mediaVerified=false;}}
  subjects.set(id,r);
 }
 for(const f of forms){
  const members=(await client.query('SELECT s.*,m.item_count,m.interaction FROM exam_form_member m JOIN objective_set s ON (s.set_id,s.version,s.exam_id)=(m.set_id,m.set_version,m.exam_id) WHERE m.exam_id=$1 AND m.form_id=$2 AND m.form_version=$3 ORDER BY m.position',[examId,f.form_id,f.version])).rows;
  let shapeValid=true;
  try{validateCompleteForm({id:examId,language:exam.exam_language},blueprint.payload,f.payload);validateCompleteMembers(examId,blueprint.payload,f.payload,members);for(const m of members)if(objectiveItems(m.payload,m.interaction).length!==m.item_count)throw Error('count');}catch{shapeValid=false;}
  for(const m of members){await add(m.content_version_id);if(m.interaction==='fixed_audio')for(const r of m.payload.recordings||[]){const {rows:[media]}=await client.query('SELECT content_version_id FROM exam_media WHERE exam_id=$1 AND media_id=$2 AND version=$3',[examId,r.mediaId,r.mediaVersion]);if(media)await add(media.content_version_id);}}
  const writing=[];const refs=f.payload.writingTask?[f.payload.writingTask]:(f.payload.writingChoices||[]).flatMap(g=>g.options.map(o=>({...o,section:g.section})));
  for(const ref of refs){const {rows:[t]}=await client.query('SELECT t.*,r.content_version_id AS rubric_content_version_id FROM task_version t JOIN rubric_version r ON (r.rubric_id,r.version,r.exam_id)=(t.rubric_id,t.rubric_version,t.exam_id) WHERE t.task_id=$1 AND t.version=$2 AND t.exam_id=$3',[ref.taskId,ref.taskVersion,examId]);if(t){await add(t.content_version_id);await add(t.rubric_content_version_id);}writing.push({taskId:ref.taskId,taskVersion:ref.taskVersion,option:ref.id??ref.label??null,section:ref.section??null,present:!!t,rubric:t?{id:t.rubric_id,version:t.rubric_version}:null});}
  const review=(await client.query('SELECT * FROM effective_format_review($1,$2,$3,$4)',[examId,'form',f.form_id,f.version])).rows[0];
  reports.push({formId:f.form_id,version:f.version,scope:f.payload.scope??'unknown',shapeValid,shapeValidation:'complete_supported_written',review,actual:members.map(m=>({section:m.section,family:m.family,interaction:m.interaction,itemCount:m.item_count})),requirementsBasis:'exact_blueprint',required:blueprint.payload.sections??[],writing});
 }
 const blueprintReview=(await client.query('SELECT * FROM effective_format_review($1,$2,$3,$4)',[examId,'blueprint',examId,blueprint.version])).rows[0];
 const content=[...subjects.values()],reviews=[blueprintReview,...reports.map(f=>f.review),...content];
 const allowedRights=contentPolicy().rights;
 const admitted=await readCurrentReleaseEligibility(client,examId);
 return {examId,releaseVersion:release.version,releaseState:release.state,blueprint:{version:blueprint.version,review:blueprintReview},forms:reports,content,
  shapeValid:reports.length>0&&reports.some(f=>f.shapeValid),reviewComplete:reviews.length>0&&reviews.every(r=>r.review_status==='approved'&&r.review_basis==='named_decision'),
  legacyEligible:reviews.some(r=>r.review_basis==='legacy_unattributed')&&reviews.every(r=>r.review_status==='approved'),
  rightsAllowed:content.length>0&&content.every(r=>allowedRights.includes(r.rights_status)),
  mediaVerified:content.filter(r=>r.kind==='media').length?content.filter(r=>r.kind==='media').every(r=>r.mediaVerified===true):null,
  currentAdmission:admitted??null,languages:Object.fromEntries(languages.map(l=>[l,{status:'not_modelled',approved:0,missing:null}])),tagCoverage:'unknown'};
}

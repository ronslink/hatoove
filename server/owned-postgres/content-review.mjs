/** Privileged operator workflow. Callers own a transaction on one migration-role client. */
import {validateReviewerAuthority,validateContentReview,validateReviewSubject,REVIEW_LANGUAGES,reviewError} from '../content-review-contract.mjs';
import {readMediaBytes} from '../media-contract.mjs';
import {packageHash,validateCompleteForm,validateCompleteMembers,objectiveItems,INTERACTIONS} from '../package-contract.mjs';
import {contentPolicy} from '../content-policy.mjs';
import {readCurrentReleaseEligibility} from './release-eligibility.mjs';
import {readExplanationReviewPacket,readExplanationCoverage} from './explanation-review.mjs';

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
 if(!old.rowCount&&p.subject.kind==='explanation'&&p.decision==='approve')await readExplanationReviewPacket(client,p.subject);
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
 const s=validateReviewSubject(input);if(s.kind==='explanation')return readExplanationReviewPacket(client,s);await operator(client);
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
export {readExplanationReview} from './explanations.mjs';

export async function readContentCoverage(client,{examId,releaseVersion,languages=REVIEW_LANGUAGES},options={}){
 await operator(client);
 if(typeof examId!=='string'||!examId||!Array.isArray(languages)||languages.some(x=>!REVIEW_LANGUAGES.includes(x)))reviewError();
 const {rows:[release]}=await client.query('SELECT r.* FROM exam_release r WHERE r.exam_id=$1 AND r.version=COALESCE($2,(SELECT release_version FROM exam_release_head WHERE exam_id=$1))',[examId,releaseVersion??null]);
 if(!release)reviewError('review_subject_unavailable');
 const {rows:[blueprint]}=await client.query('SELECT * FROM exam_blueprint WHERE exam_id=$1 AND version=$2',[examId,release.blueprint_version]);
 const {rows:[exam]}=await client.query('SELECT * FROM exam_package WHERE exam_id=$1',[examId]);
 const {rows:forms}=await client.query('SELECT f.* FROM exam_release_form rf JOIN exam_form f ON (f.exam_id,f.form_id,f.version)=(rf.exam_id,rf.form_id,rf.form_version) WHERE rf.exam_id=$1 AND rf.release_version=$2 ORDER BY f.form_id,f.version',[examId,release.version]);
 const blueprintReview=(await client.query('SELECT * FROM effective_format_review($1,$2,$3,$4)',[examId,'blueprint',examId,blueprint.version])).rows[0];
 const subjects=new Map(),reports=[];
 const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
 const identity=value=>typeof value==='string'&&value.length>0;
 const positive=value=>Number.isSafeInteger(value)&&value>0;
 const sum=values=>values.every(v=>Number.isSafeInteger(v)&&v>=0)?values.reduce((a,b)=>a+b,0):null;
 async function add(id){
  if(subjects.has(id))return subjects.get(id);
  const {rows:[r]}=await client.query(`SELECT cv.content_version_id,cv.kind,cv.family,cv.content_sha256,COALESCE(cr.basis,cv.rights_status) AS rights_status,p.* FROM content_version cv LEFT JOIN content_rights cr USING(content_version_id) CROSS JOIN LATERAL effective_content_review(cv.content_version_id) p WHERE cv.content_version_id=$1`,[id]);
  if(!r){const missing={content_version_id:id,review_status:'unavailable',review_basis:'none',blocked:true,explicit_negative:false,decision_ids:[],rights_status:'unknown',mediaVerified:null,missing:true};subjects.set(id,missing);return missing;}
  const required=(await client.query('SELECT category,language FROM resolve_review_subject($1,$2,$3,$4)',['content',examId,id,''])).rows[0];
  r.requiredReview=required??null;r.mediaVerified=null;
  if(r.kind==='media'){try{const {rows:[media]}=await client.query('SELECT * FROM exam_media WHERE content_version_id=$1',[id]);await readMediaBytes(media,options);r.mediaVerified=true;}catch{r.mediaVerified=false;}}
  subjects.set(id,r);return r;
 }
 for(const f of forms){
  // A binding cannot dangle because its exact objective-set FK is enforced. However, payload
  // references need not have a binding at all, and JSON media/writing references have no FK.
  const members=(await client.query('SELECT s.*,m.item_count AS bound_item_count,m.interaction,m.position FROM exam_form_member m JOIN objective_set s ON (s.set_id,s.version,s.exam_id)=(m.set_id,m.set_version,m.exam_id) WHERE m.exam_id=$1 AND m.form_id=$2 AND m.form_version=$3 ORDER BY m.position',[examId,f.form_id,f.version])).rows;
  const payload=object(f.payload)?f.payload:{},missingReferences=[],formContent=new Map();
  const requiredSections=Array.isArray(blueprint.payload?.sections)?blueprint.payload.sections.filter(s=>object(s)&&(payload.scope==='complete_supported_written'||(Array.isArray(payload.sections)&&payload.sections.includes(s.id)))):[];
  const requiredParts=requiredSections.flatMap(s=>Array.isArray(s.parts)?s.parts.filter(object).map(p=>({...p,section:s.id})):[]);
  const requiredObjective=requiredParts.filter(p=>INTERACTIONS.includes(p.interaction));
  const requiredWriting=requiredParts.filter(p=>['writing_choice','extended_writing'].includes(p.interaction));
  function missing(referenceType,reference,reason){
   const entry={referenceType,reference,reason};missingReferences.push(entry);
   const row={...entry,content_version_id:null,kind:referenceType==='media'?'media':'unavailable',missing:true,
    review_status:'unavailable',review_basis:'none',blocked:true,explicit_negative:false,decision_ids:[],rights_status:'unknown',mediaVerified:referenceType==='media'?false:null};
   const key='missing:'+JSON.stringify([f.form_id,f.version,missingReferences.length]);subjects.set(key,row);formContent.set(key,row);
  }
  async function include(id){const row=await add(id);formContent.set(id,row);}
  const declared=Array.isArray(payload.members)?payload.members:[];
  if(f.blueprint_version!==blueprint.version)missing('blueprint',{version:f.blueprint_version},'form_release_blueprint_mismatch');
  if(!Array.isArray(payload.members))missing('objective_members',null,'malformed_member_list');
  if(payload.scope==='complete_supported_written')for(const [position,part]of requiredObjective.entries())if(!declared[position]){
   missing('objective_set',{position,section:part.section,family:part.family},'missing_required_objective_reference');
   if(part.interaction==='fixed_audio')missing('media',{section:part.section,family:part.family},'unresolved_recording_references');
  }
  for(const [position,ref]of declared.entries()){
   const bound=members.find(m=>m.position===position);
   if(!object(ref)||!identity(ref.setId)||!identity(ref.version)||!INTERACTIONS.includes(ref.interaction)||!positive(ref.itemCount)){
    missing('objective_set',{position},'malformed_member_reference');continue;
   }
   if(!bound||bound.set_id!==ref.setId||bound.version!==ref.version||bound.interaction!==ref.interaction||bound.bound_item_count!==ref.itemCount){
    missing('objective_set',{position,setId:ref.setId,version:ref.version},bound?'binding_mismatch':'missing_binding');
    if(ref.interaction==='fixed_audio')missing('media',{setId:ref.setId,version:ref.version},'unresolved_recording_references');
   }
  }
  for(const m of members)if(!declared[m.position])missing('objective_set',{position:m.position,setId:m.set_id,version:m.version},'undeclared_binding');
  let shapeValid=true;
  try{validateCompleteForm({id:examId,language:exam.exam_language},blueprint.payload,payload);validateCompleteMembers(examId,blueprint.payload,payload,members);}catch{shapeValid=false;}
  const actual=[];
  for(const m of members){
   await include(m.content_version_id);let itemCount=null;
   try{itemCount=objectiveItems(m.payload,m.interaction).length;if(itemCount!==m.item_count||itemCount!==m.bound_item_count)shapeValid=false;}catch{shapeValid=false;}
   actual.push({position:m.position,setId:m.set_id,version:m.version,section:m.section,family:m.family,interaction:m.interaction,itemCount,storedItemCount:m.item_count,boundItemCount:m.bound_item_count});
   if(m.interaction!=='fixed_audio')continue;
   if(!Array.isArray(m.payload?.recordings)||!m.payload.recordings.length){missing('media',{setId:m.set_id,version:m.version},'malformed_recordings');continue;}
   for(const r of m.payload.recordings){
    if(!object(r)||!identity(r.mediaId)||!identity(r.mediaVersion)){missing('media',{setId:m.set_id,version:m.version},'malformed_recording_reference');continue;}
    const ref={mediaId:r.mediaId,version:r.mediaVersion},media=(await client.query('SELECT content_version_id FROM exam_media WHERE exam_id=$1 AND media_id=$2 AND version=$3',[examId,r.mediaId,r.mediaVersion])).rows[0];
    if(media)await include(media.content_version_id);else missing('media',ref,'missing_media');
   }
  }
  const writing=[],refs=[];
  if(payload.writingTask!==undefined){
   if(object(payload.writingTask)){
    if(Object.keys(payload.writingTask).some(k=>!['section','taskId','taskVersion'].includes(k)))missing('writing_task',null,'malformed_assigned_task');
    refs.push({...payload.writingTask,id:null});
   }else missing('writing_task',null,'malformed_assigned_task');
  }
  if(payload.writingChoices!==undefined){
   if(!Array.isArray(payload.writingChoices)||payload.writingChoices.length!==1)missing('writing_choices',null,'malformed_choice_groups');
   if(Array.isArray(payload.writingChoices))for(const group of payload.writingChoices){
    if(!object(group)||!Array.isArray(group.options)){missing('writing_choices',null,'malformed_choice_options');continue;}
    if(Object.keys(group).some(k=>!['id','section','options'].includes(k)))missing('writing_choices',{groupId:group.id??null},'malformed_choice_group');
    if(group.options.length!==2||group.options[0]?.id!=='A'||group.options[1]?.id!=='B')missing('writing_choices',{groupId:group.id??null},'invalid_AB_options');
    for(const option of group.options){if(object(option)){
     if(Object.keys(option).some(k=>!['id','taskId','taskVersion'].includes(k)))missing('writing_task',{groupId:group.id??null,option:option.id??null},'malformed_choice_reference');
     refs.push({...option,section:group.section,groupId:group.id});
    }else missing('writing_task',{groupId:group.id??null},'malformed_choice_reference');}
   }
  }
  if(payload.writingTask!==undefined&&payload.writingChoices!==undefined)missing('writing_choices',null,'conflicting_writing_modes');
  for(const requirement of requiredWriting){
   const options= requirement.interaction==='writing_choice'?['A','B']:[null];
   for(const option of options)if(!refs.some(r=>r.section===requirement.section&&(r.id??null)===option)){
    missing('writing_task',{section:requirement.section,option},'missing_required_writing_reference');
    refs.push({section:requirement.section,id:option,missing:true});
   }
  }
  for(const ref of refs){
   const valid=identity(ref.taskId)&&identity(ref.taskVersion)&&identity(ref.section);
   const t=valid?(await client.query('SELECT t.*,r.content_version_id AS rubric_content_version_id FROM task_version t LEFT JOIN rubric_version r ON (r.rubric_id,r.version,r.exam_id)=(t.rubric_id,t.rubric_version,t.exam_id) WHERE t.task_id=$1 AND t.version=$2 AND t.exam_id=$3',[ref.taskId,ref.taskVersion,examId])).rows[0]:null;
   const reference={taskId:ref.taskId??null,taskVersion:ref.taskVersion??null,option:ref.id??null,section:ref.section??null};
   if(!t&&!ref.missing)missing('writing_task',reference,valid?'missing_writing_task':'malformed_writing_reference');
   else if(t){await include(t.content_version_id);if(t.rubric_content_version_id)await include(t.rubric_content_version_id);else missing('rubric',{rubricId:t.rubric_id,version:t.rubric_version},'missing_same_exam_rubric');}
   writing.push({...reference,present:!!t,rubric:t?{id:t.rubric_id,version:t.rubric_version,present:!!t.rubric_content_version_id}:null});
  }
  if(missingReferences.some(x=>x.reason.startsWith('malformed')||x.reason==='invalid_AB_options'||x.reason==='conflicting_writing_modes'))shapeValid=false;
  const review=(await client.query('SELECT * FROM effective_format_review($1,$2,$3,$4)',[examId,'form',f.form_id,f.version])).rows[0];
  const formRows=[...formContent.values()],formReviews=[blueprintReview,review,...formRows],referencesComplete=missingReferences.length===0;
  reports.push({formId:f.form_id,version:f.version,scope:payload.scope??'unknown',shapeValid,shapeValidation:'complete_supported_written',review,actual,requirementsBasis:'exact_blueprint',required:blueprint.payload?.sections??[],writing,
   referencesComplete,missingReferences,memberCounts:{required:requiredObjective.length,declared:declared.length,bound:members.length,resolved:actual.length},
   itemTotals:{required:sum(requiredObjective.map(p=>p.itemCount)),declared:sum(declared.map(m=>m?.itemCount)),bound:sum(members.map(m=>m.bound_item_count)),resolved:sum(actual.map(m=>m.itemCount))},
   writingCounts:{requiredOptions:sum(requiredWriting.map(p=>p.interaction==='writing_choice'?2:1)),declaredOptions:refs.filter(r=>!r.missing).length,resolvedOptions:writing.filter(w=>w.present).length},
   reviewComplete:referencesComplete&&formReviews.every(r=>r.review_status==='approved'&&r.review_basis==='named_decision'),
   rightsAllowed:referencesComplete&&formRows.length>0&&formRows.every(r=>contentPolicy().rights.includes(r.rights_status)),
   mediaVerified:formRows.some(r=>r.kind==='media')?formRows.filter(r=>r.kind==='media').every(r=>r.mediaVerified===true):null});
 }
 const content=[...subjects.values()],reviews=[blueprintReview,...reports.map(f=>f.review),...content];
 const allowedRights=contentPolicy().rights;
 const admitted=await readCurrentReleaseEligibility(client,examId);
 return {examId,releaseVersion:release.version,releaseState:release.state,blueprint:{version:blueprint.version,review:blueprintReview},forms:reports,content,
  shapeValid:reports.length>0&&reports.some(f=>f.shapeValid),referencesComplete:reports.length>0&&reports.every(f=>f.referencesComplete),reviewComplete:reports.length>0&&reports.every(f=>f.referencesComplete)&&reviews.every(r=>r.review_status==='approved'&&r.review_basis==='named_decision'),
  legacyEligible:reports.length>0&&reports.every(f=>f.referencesComplete)&&reviews.some(r=>r.review_basis==='legacy_unattributed')&&reviews.every(r=>r.review_status==='approved'),
  rightsAllowed:content.length>0&&content.every(r=>allowedRights.includes(r.rights_status)),
  mediaVerified:content.filter(r=>r.kind==='media').length?content.filter(r=>r.kind==='media').every(r=>r.mediaVerified===true):null,
  currentAdmission:admitted??null,explanations:await readExplanationCoverage(client,{examId,releaseVersion:release.version,languages},options),languages:Object.fromEntries(languages.map(l=>[l,{status:'not_modelled',approved:0,missing:null}])),tagCoverage:'unknown'};
}

/** Privileged shared-only editorial operations. Caller owns its migration-role transaction. */
import {validateExplanationReviewLocator,validateExplanationReviewSubject} from '../explanation-review-contract.mjs';
import {extractObjectiveExplanationSource,validateExplanationRepresentation,EXPLANATION_LANGUAGES} from '../explanation-contract.mjs';
import {resolveObjectiveExplanationLanguage} from '../explanation-language-registry.mjs';
import {objectiveItems,packageHash} from '../package-contract.mjs';
import {contentPolicy} from '../content-policy.mjs';
import {types} from 'node:util';
const fail=(code='review_subject_mismatch')=>{const e=new Error(code);e.code=code;throw e;};
async function operator(client,{writing=false}={}){
 const r=(await client.query("SELECT current_user=pg_get_userbyid(nspowner) AS allowed,current_setting('transaction_isolation') AS isolation,current_setting('transaction_read_only') AS read_only FROM pg_namespace WHERE nspname=current_schema()")).rows[0];
 if(!r?.allowed)fail('review_operator_required');if(writing&&r.isolation!=='read committed')fail('review_read_committed_required');
 return r;
}
const fence=(client,exam)=>client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,7351))',[exam]);
async function readFence(client,exam){const mode=await operator(client);if(mode.isolation==='read committed')await fence(client,exam);else if(mode.isolation!=='repeatable read'||mode.read_only!=='on')fail('review_read_isolation_required');}
const identityArgs=i=>[i.exam_id,i.set_id,i.set_version,i.item_id];
const params=p=>[p.targetKind,...identityArgs(p.sourceIdentity),p.sourceSha256,p.language,p.representationVersion,p.payloadSha256];
const targetQuery='SELECT * FROM explanation_review_target WHERE target_kind=$1 AND exam_id=$2 AND set_id=$3 AND set_version=$4 AND item_id=$5 AND source_sha256=$6 AND language=$7 AND representation_version=$8 AND payload_sha256=$9';
const receipt=(row,unchanged)=>({targetId:row.target_id,subject:{kind:'explanation',examId:row.exam_id,subjectId:row.target_id,version:row.representation_version,sha256:row.target_sha256},unchanged});
const locator=row=>({scope:'objective',targetKind:row.target_kind,sourceIdentity:{exam_id:row.exam_id,set_id:row.set_id,set_version:row.set_version,item_id:row.item_id},sourceSha256:row.source_sha256,language:row.language,representationVersion:row.representation_version,payloadSha256:row.payload_sha256});
async function sourceData(client,i){
 const binding=(await client.query('SELECT * FROM resolve_explanation_review_source($1,$2,$3,$4)',identityArgs(i))).rows[0];if(!binding)fail();
 const row=(await client.query(`SELECT s.*,k.answers,k.explanations,c.content_sha256,coalesce(r.basis,c.rights_status) AS rights_status FROM objective_set s JOIN objective_key k ON k.set_id=s.set_id AND k.version=s.version JOIN content_version c USING(content_version_id) LEFT JOIN content_rights r USING(content_version_id) WHERE s.exam_id=$1 AND s.set_id=$2 AND s.version=$3`,identityArgs(i).slice(0,3))).rows[0];
 let items;try{items=objectiveItems(row?.payload,binding.interaction);}catch{fail();}
 if(!row||row.content_version_id!==binding.content_version_id||items.filter(item=>item.id===i.item_id).length!==1||!Object.hasOwn(row.answers,i.item_id))fail();
 return {binding,row};
}
function requireRights(row){if(!contentPolicy().rights.includes(row.rights_status))fail('review_rights_blocked');}
async function packetFor(client,p,{languageRegistry,registered}={}){
 const {binding,row}=await sourceData(client,p.sourceIdentity);requireRights(row);
 const input={examId:p.sourceIdentity.exam_id,setId:p.sourceIdentity.set_id,setVersion:p.sourceIdentity.set_version,itemId:p.sourceIdentity.item_id,originalValue:binding.original_value};
 const language=registered?registered.original_language:resolveObjectiveExplanationLanguage(input,{registry:languageRegistry});
 if(!EXPLANATION_LANGUAGES.includes(language))fail('review_source_language_unknown');
 const source=extractObjectiveExplanationSource({...input,originalLanguage:language});
 if(!source.supported||source.sourceSha256!==p.sourceSha256||registered&&(registered.original_value_fingerprint!==binding.original_value_fingerprint||registered.content_version_id!==binding.content_version_id))fail();
 let representation;
 if(p.targetKind==='original'){
  if(p.language!==source.originalLanguage||p.representationVersion!=='legacy-projection-v1')fail();
  representation={language:p.language,version:p.representationVersion,source_sha256:source.sourceSha256,payload:source.originalPayload,payload_sha256:packageHash(source.originalPayload),provenance:{kind:'virtual-original'}};
 }else{
  const r=(await client.query('SELECT * FROM objective_explanation_representation WHERE exam_id=$1 AND set_id=$2 AND set_version=$3 AND item_id=$4 AND source_sha256=$5 AND language=$6 AND representation_version=$7',[...identityArgs(p.sourceIdentity),p.sourceSha256,p.language,p.representationVersion])).rows[0];
  if(!r||r.original_language!==source.originalLanguage||r.original_format!==source.originalFormat)fail();
  try{representation=validateExplanationRepresentation(source,{language:r.language,version:r.representation_version,source_sha256:r.source_sha256,payload:r.payload,payload_sha256:r.payload_sha256,provenance:r.provenance});}catch{fail();}
 }
 if(representation.payload_sha256!==p.payloadSha256)fail();
 const packet={schema:'explanation-review-packet-v1',locator:p,contentIdentity:{content_version_id:binding.content_version_id,content_sha256:binding.content_sha256},extractionVersion:source.formatVersion,
  taskContext:{interaction:binding.interaction,payload:row.payload},itemAnswer:row.answers[p.sourceIdentity.item_id],originalExplanation:binding.original_value,representation,requiredDimensions:['educational','native_language']};
 return {packet,packetSha256:packageHash(packet),source,binding};
}
export async function registerExplanationReviewTarget(client,input,{languageRegistry}={}){
 const p=validateExplanationReviewLocator(input);await operator(client,{writing:true});await fence(client,p.sourceIdentity.exam_id);
 const old=(await client.query(targetQuery,params(p))).rows[0];if(old)return receipt(old,true);
 const {packetSha256,source,binding}=await packetFor(client,p,{languageRegistry});
 const values={target_kind:p.targetKind,...p.sourceIdentity,content_version_id:binding.content_version_id,source_sha256:p.sourceSha256,language:p.language,representation_version:p.representationVersion,payload_sha256:p.payloadSha256,
  extraction_version:source.formatVersion,original_language:source.originalLanguage,original_format:source.originalFormat,packet_sha256:packetSha256};
 const row=(await client.query('SELECT * FROM register_explanation_review_target($1::jsonb)',[JSON.stringify(values)])).rows[0];if(!row)fail();return receipt(row,false);
}
export async function readExplanationReviewPacket(client,input){
 const s=validateExplanationReviewSubject(input);await readFence(client,s.examId);
 const row=(await client.query('SELECT * FROM explanation_review_target WHERE target_id=$1 AND exam_id=$2 AND representation_version=$3 AND target_sha256=$4',[s.subjectId,s.examId,s.version,s.sha256])).rows[0];if(!row)fail();
 const {packet,packetSha256}=await packetFor(client,validateExplanationReviewLocator(locator(row)),{registered:row});
 if(packetSha256!==row.packet_sha256)fail('review_packet_mismatch');return {packet,packetSha256};
}
export async function readExplanationCoverage(client,input={},options={}){
 if(!input||typeof input!=='object'||types.isProxy(input)||![Object.prototype,null].includes(Object.getPrototypeOf(input)))fail('review_input_invalid');
 const fields=Object.getOwnPropertyDescriptors(input);
 if(Reflect.ownKeys(fields).some(key=>typeof key!=='string'||!['examId','releaseVersion','languages'].includes(key)||!Object.hasOwn(fields[key],'value')))fail('review_input_invalid');
 const {examId,releaseVersion,languages=EXPLANATION_LANGUAGES}=input;
 if(typeof examId!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(examId)||releaseVersion!==undefined&&!/^v[0-9]{1,4}$/.test(releaseVersion)
  ||!Array.isArray(languages)||types.isProxy(languages)||languages.length<1||languages.length>5||new Set(languages).size!==languages.length||languages.some(l=>!EXPLANATION_LANGUAGES.includes(l)))fail('review_input_invalid');
 await readFence(client,examId);
 const release=(await client.query('SELECT r.* FROM exam_release r WHERE exam_id=$1 AND version=coalesce($2,(SELECT release_version FROM exam_release_head WHERE exam_id=$1))',[examId,releaseVersion??null])).rows[0];if(!release)fail('review_subject_unavailable');
 const forms=(await client.query('SELECT f.payload FROM exam_release_form rf JOIN exam_form f ON (f.exam_id,f.form_id,f.version)=(rf.exam_id,rf.form_id,rf.form_version) WHERE rf.exam_id=$1 AND rf.release_version=$2 ORDER BY f.form_id,f.version',[examId,release.version])).rows;
 const counts=Object.fromEntries(languages.map(l=>[l,{required:0,approved:0,unreviewed:0,rejected:0,withdrawn:0,missing:0,'unknown-source-language':0,not_modelled:0}]));
 const seen=new Set();let unresolvedReferences=0;
 const add=(status,n=1)=>{for(const value of Object.values(counts)){value.required+=n;value[status]+=n;}};
 for(const form of forms){
  if(!Array.isArray(form.payload?.members)){unresolvedReferences++;continue;}
  for(const member of form.payload.members){
   const key=JSON.stringify([member.setId,member.version]);if(seen.has(key))continue;seen.add(key);
   const row=(await client.query('SELECT payload,item_count FROM objective_set WHERE exam_id=$1 AND set_id=$2 AND version=$3',[examId,member.setId,member.version])).rows[0];
   let items;try{items=objectiveItems(row?.payload,member.interaction);if(items.length!==member.itemCount||row.item_count!==member.itemCount)throw Error();}catch{
    if(Number.isSafeInteger(member.itemCount)&&member.itemCount>0&&member.itemCount<=100)add(row?'not_modelled':'missing',member.itemCount);else unresolvedReferences++;continue;
   }
   for(const item of items){
    const i={exam_id:examId,set_id:member.setId,set_version:member.version,item_id:item.id};let data;
    try{data=await sourceData(client,i);}catch(error){if(error.code!=='review_subject_mismatch')throw error;add('missing');continue;}
    if(!contentPolicy().rights.includes(data.row.rights_status)){add('not_modelled');continue;}
    const input={examId,setId:member.setId,setVersion:member.version,itemId:item.id,originalValue:data.binding.original_value};
    const originalLanguage=resolveObjectiveExplanationLanguage(input,{registry:options.languageRegistry});
    if(!originalLanguage){add('unknown-source-language');continue;}
    const source=extractObjectiveExplanationSource({...input,originalLanguage});
    const reps=(await client.query('SELECT r.* FROM objective_explanation_representation r JOIN objective_explanation_head h USING(set_id,set_version,item_id,source_sha256,language,representation_version) WHERE r.exam_id=$1 AND r.set_id=$2 AND r.set_version=$3 AND r.item_id=$4 AND r.source_sha256=$5',[...identityArgs(i),source.sourceSha256])).rows;
    for(const language of languages){
     const count=counts[language];count.required++;const r=reps.find(x=>x.language===language);let version,payloadSha256,targetKind;
     if(r){try{validateExplanationRepresentation(source,{language:r.language,version:r.representation_version,source_sha256:r.source_sha256,payload:r.payload,payload_sha256:r.payload_sha256,provenance:r.provenance});}catch{count.not_modelled++;continue;}version=r.representation_version;payloadSha256=r.payload_sha256;targetKind='stored';}
     else if(language===source.originalLanguage){version='legacy-projection-v1';payloadSha256=packageHash(source.originalPayload);targetKind='original';}
     else{count.missing++;continue;}
     const rows=(await client.query('SELECT * FROM effective_explanation_review($1,$2,$3,$4,$5,$6,$7,$8,$9)',[...identityArgs(i),source.sourceSha256,language,version,payloadSha256,targetKind])).rows;
     const status=rows.some(r=>r.review_status==='unavailable')?'not_modelled':rows.some(r=>r.review_status==='withdrawn')?'withdrawn':rows.some(r=>r.review_status==='rejected')?'rejected':rows.length===2&&rows.every(r=>r.review_status==='approved'&&r.review_basis==='named_decision')?'approved':'unreviewed';count[status]++;
    }
   }
  }
 }
 if(unresolvedReferences)for(const value of Object.values(counts))value.required=null;
 return {scope:'shared_objective',examId,releaseVersion:release.version,languages:counts,unresolvedReferences,exclusions:{personal_feedback:'not_modelled',guides:'not_modelled',instructions:'not_modelled',interface:'not_modelled'}};
}

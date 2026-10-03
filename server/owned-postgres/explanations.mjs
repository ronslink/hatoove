/** Caller owns transaction, parent policy authorization and exact owner context. */
import {canonicalJson} from '../package-contract.mjs';
import {extractWritingExplanationSource,extractObjectiveExplanationSource,validateExplanationRepresentation,validateExplanationLanguage,explanationError,unreviewedExplanation} from '../explanation-contract.mjs';
import {resolveObjectiveExplanationLanguage} from '../explanation-language-registry.mjs';

const rowRepresentation=r=>({language:r.language,version:r.representation_version,source_sha256:r.source_sha256,payload:r.payload,payload_sha256:r.payload_sha256,provenance:r.provenance});
function envelopeResult(envelope,options){
 if(!envelope||envelope.kind!=='objective'||!envelope.context||!Array.isArray(envelope.representations)||!Array.isArray(envelope.heads)||envelope.representations.length>100)explanationError('invalid_explanation_envelope');
 const c=envelope.context,input={examId:c.exam_id,setId:c.set_id,setVersion:c.set_version,itemId:c.item_id,originalValue:envelope.originalValue};
 const source=extractObjectiveExplanationSource({...input,originalLanguage:resolveObjectiveExplanationLanguage(input,{registry:options.languageRegistry})});
 const representations=[];
 for(const r of envelope.representations)try{representations.push(validateExplanationRepresentation(source,r));}catch{/* Optional invalid siblings are not exposed. */}
 return {source,representations,heads:envelope.heads};
}
export async function readObjectiveEvidenceExplanation(client,{evidenceId,language=null},options={}){
 validateExplanationLanguage(language);
 const envelope=(await client.query('SELECT read_objective_evidence_explanation($1,$2) AS envelope',[evidenceId,language])).rows[0]?.envelope;
 return envelopeResult(envelope,options);
}
export async function readFinalisedMockItemExplanation(client,{runId,setId,setVersion,itemId,language=null},options={}){
 validateExplanationLanguage(language);
 const envelope=(await client.query('SELECT read_finalised_mock_item_explanation($1,$2,$3,$4,$5) AS envelope',[runId,setId,setVersion,itemId,language])).rows[0]?.envelope;
 return envelopeResult(envelope,options);
}
export async function readExplanationRepresentations(client,{source}){
 if(source?.kind!=='writing')explanationError('explanation_context_required');
 const {owner_id,submission_id}=source.identity;
 const rows=(await client.query(`SELECT r.* FROM writing_explanation_representation r JOIN writing_explanation_head h
  USING(owner_id,submission_id,source_sha256,language,representation_version)
  WHERE r.owner_id=$1 AND r.submission_id=$2 AND r.source_sha256=$3 ORDER BY r.language`,[owner_id,submission_id,source.sourceSha256])).rows;
 const representations=[];
 for(const row of rows)try{representations.push(validateExplanationRepresentation(source,rowRepresentation(row)));}catch{/* Preserve the immutable original on an unusable sibling. */}
 return {representations,heads:rows.map(r=>({language:r.language,source_sha256:r.source_sha256,representation_version:r.representation_version}))};
}
export async function readExplanationReview(_client,_identity){return unreviewedExplanation();}

export async function persistWritingExplanations(client,{ownerId,submissionId,representations}){
 if(!Array.isArray(representations)||representations.length>5)explanationError();
 const row=(await client.query(`SELECT a.id AS attempt_id,a.exam_id,a.task_id,a.rubric_id,s.id AS submission_id,s.owner_id,s.task_version,s.rubric_version,s.explanation_language,
  f.feedback,f.model_version,f.prompt_version FROM assessments f JOIN submissions s ON s.id=f.submission_id AND s.owner_id=f.owner_id
  JOIN attempts a ON a.id=s.attempt_id AND a.owner_id=s.owner_id WHERE f.submission_id=$1 AND f.owner_id=$2 AND a.deleted_at IS NULL`,[submissionId,ownerId])).rows[0];
 if(!row)explanationError('explanation_source_mismatch');
 const source=extractWritingExplanationSource({ownerId,attempt:{...row,id:row.attempt_id},submission:{...row,id:row.submission_id},assessment:row});
 if(!source.supported||!source.originalLanguage){if(representations.length)explanationError('explanation_source_mismatch');return {inserted:0,unchanged:0};}
 const batch=representations.map(r=>validateExplanationRepresentation(source,r));
 if(new Set(batch.map(r=>r.language)).size!==batch.length)explanationError('explanation_conflict');
 let inserted=0,unchanged=0;
 for(const r of batch){
  const args=[ownerId,submissionId,source.sourceSha256,r.language,r.version];
  const old=(await client.query(`SELECT * FROM writing_explanation_representation WHERE owner_id=$1 AND submission_id=$2 AND source_sha256=$3 AND language=$4 AND representation_version=$5`,args)).rows[0];
  if(old){if(canonicalJson(rowRepresentation(old))!==canonicalJson(r))explanationError('explanation_conflict');unchanged++;}
  else {
   const i=source.identity;
   await client.query(`INSERT INTO writing_explanation_representation(owner_id,submission_id,source_sha256,language,representation_version,
    attempt_id,exam_id,task_id,task_version,rubric_id,rubric_version,model_version,prompt_version,original_language,original_format,payload,payload_sha256,provenance)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::jsonb,$17,$18::jsonb)`,[...args,i.attempt_id,i.exam_id,i.task_id,i.task_version,i.rubric_id,i.rubric_version,i.model_version,i.prompt_version,source.originalLanguage,source.originalFormat,JSON.stringify(r.payload),r.payload_sha256,JSON.stringify(r.provenance)]);
   inserted++;
  }
  const head=(await client.query('SELECT representation_version FROM writing_explanation_head WHERE owner_id=$1 AND submission_id=$2 AND source_sha256=$3 AND language=$4',args.slice(0,4))).rows[0];
  if(head&&head.representation_version!==r.version)explanationError('explanation_conflict');
  if(!head)await client.query('INSERT INTO writing_explanation_head(owner_id,submission_id,source_sha256,language,representation_version) VALUES($1,$2,$3,$4,$5)',args);
 }
 return {inserted,unchanged};
}

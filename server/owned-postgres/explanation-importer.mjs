/** Privileged exact-source prose import; caller owns one migration-role transaction. */
import {canonicalJson,objectiveItems} from '../package-contract.mjs';
import {extractObjectiveExplanationSource,validateExplanationRepresentation,explanationError} from '../explanation-contract.mjs';
import {resolveObjectiveExplanationLanguage} from '../explanation-language-registry.mjs';
const exact=(x,keys)=>x&&typeof x==='object'&&!Array.isArray(x)&&Object.keys(x).length===keys.length&&keys.every(k=>Object.hasOwn(x,k));
export async function importObjectiveExplanations(client,input,{languageRegistry}={}){
 if(!exact(input,['items'])||!Array.isArray(input.items)||input.items.length<1||input.items.length>500)explanationError();
 const operator=(await client.query('SELECT current_user=pg_get_userbyid(nspowner) AS allowed FROM pg_namespace WHERE nspname=current_schema()')).rows[0];
 if(!operator?.allowed)explanationError('explanation_operator_required');
 for(const item of input.items)if(!exact(item,['examId','setId','setVersion','itemId','sourceSha256','representations','heads'])||typeof item.examId!=='string'||!Array.isArray(item.representations)||!Array.isArray(item.heads)||item.representations.length>100||item.heads.length>5)explanationError();
 for(const exam of [...new Set(input.items.map(x=>x.examId))].sort())await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,7351))',[exam]);
 let inserted=0,unchanged=0,promoted=0;
 for(const item of input.items){
  const row=(await client.query(`SELECT s.*,k.explanations,c.source_path FROM objective_set s JOIN objective_key k USING(set_id,version)
   JOIN content_version c USING(content_version_id) WHERE s.exam_id=$1 AND s.set_id=$2 AND s.version=$3`,[item.examId,item.setId,item.setVersion])).rows[0];
  if(!row)explanationError('explanation_source_mismatch');
  const interactions=(await client.query('SELECT DISTINCT interaction FROM exam_form_member WHERE exam_id=$1 AND set_id=$2 AND set_version=$3',[item.examId,item.setId,item.setVersion])).rows.map(x=>x.interaction);
  const legacy={LV1:'matching_headlines',LV2:'single_choice',LV3:'matching_ads',SB1:'gap_choice',SB2:'gap_bank'};
  const interaction=interactions.length===1?interactions[0]:interactions.length===0&&!row.source_path.startsWith('content/exams/')?legacy[row.family]:null;
  if(!objectiveItems(row.payload,interaction).some(x=>x.id===item.itemId))explanationError('explanation_source_mismatch');
  const originalValue=row.explanations?.[item.itemId]??row.explanations?._set_why?.[item.itemId]??null;
  const source=extractObjectiveExplanationSource({...item,originalValue,originalLanguage:resolveObjectiveExplanationLanguage({...item,originalValue},{registry:languageRegistry})});
  if(source.sourceSha256!==item.sourceSha256)explanationError('explanation_source_mismatch');
  const reps=item.representations.map(r=>validateExplanationRepresentation(source,r));
  for(const r of reps){
   const args=[item.setId,item.setVersion,item.itemId,source.sourceSha256,r.language,r.version];
   const old=(await client.query('SELECT * FROM objective_explanation_representation WHERE set_id=$1 AND set_version=$2 AND item_id=$3 AND source_sha256=$4 AND language=$5 AND representation_version=$6',args)).rows[0];
   if(old){
    const prior={language:old.language,version:old.representation_version,source_sha256:old.source_sha256,payload:old.payload,payload_sha256:old.payload_sha256,provenance:old.provenance};
    if(canonicalJson(prior)!==canonicalJson(r))explanationError('explanation_conflict');unchanged++;
   }else{
    await client.query(`INSERT INTO objective_explanation_representation(set_id,set_version,item_id,source_sha256,language,representation_version,exam_id,original_language,original_format,payload,payload_sha256,provenance)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12::jsonb)`,[...args,item.examId,source.originalLanguage,source.originalFormat,JSON.stringify(r.payload),r.payload_sha256,JSON.stringify(r.provenance)]);inserted++;
   }
  }
  if(new Set(item.heads.map(h=>h.language)).size!==item.heads.length)explanationError('explanation_conflict');
  for(const h of item.heads){
   if(!exact(h,['language','version','expectedVersion'])||!['de','en','uk','ar','tr'].includes(h.language)||typeof h.version!=='string'||(h.expectedVersion!==null&&typeof h.expectedVersion!=='string'))explanationError();
   const args=[item.setId,item.setVersion,item.itemId,source.sourceSha256,h.language];
   const current=(await client.query('SELECT representation_version FROM objective_explanation_head WHERE set_id=$1 AND set_version=$2 AND item_id=$3 AND source_sha256=$4 AND language=$5 FOR UPDATE',args)).rows[0]?.representation_version??null;
   if(current===h.version)continue;
   if(current!==h.expectedVersion)explanationError('explanation_conflict');
   if(current===null)await client.query('INSERT INTO objective_explanation_head(set_id,set_version,item_id,source_sha256,language,representation_version) VALUES($1,$2,$3,$4,$5,$6)',[...args,h.version]);
   else await client.query('UPDATE objective_explanation_head SET representation_version=$6 WHERE set_id=$1 AND set_version=$2 AND item_id=$3 AND source_sha256=$4 AND language=$5',[...args,h.version]);
   promoted++;
  }
 }
 return {inserted,unchanged,promoted};
}

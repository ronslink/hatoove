/** Consumer projection only. Parent authorization belongs to the owning datastore path. */
import {Fault} from '../owned-api.mjs';
import {EXPLANATION_LANGUAGES,projectExplanationView,unavailableExplanationView,validateExplanationRepresentation,unavailableExplanationReview,unreviewedExplanation,explanationPayloadHash} from '../explanation-contract.mjs';
import {canonicalJson} from '../package-contract.mjs';
import {readExplanationReview} from './explanations.mjs';

export function explanationLanguage(value=null) {
  if(value!==null&&!EXPLANATION_LANGUAGES.includes(value))throw new Fault(422,'invalid_explanation_language');
  return value;
}

export function blockedExplanation(language=null) {
  return unavailableExplanationView({requestedLanguage:explanationLanguage(language),state:'blocked',reason:'content_blocked'});
}

export async function projectStoredExplanation(client,bundle,language=null) {
  explanationLanguage(language);
  const {source,representations=[],heads=[]}=bundle,review=[];
  const objective=source.kind==='objective',trusted=!objective||(
    ['standalone-key','finalised-snapshot'].includes(bundle.sourceOrigin)
    &&bundle.reviewSourceBinding&&Object.keys(bundle.reviewSourceBinding).length===1
    &&['unregistered','registered'].includes(bundle.reviewSourceBinding.state));
  const dimensionsFor=async(candidate,targetKind)=>trusted?readExplanationReview(client,{scope:source.kind,sourceIdentity:source.identity,
    sourceSha256:source.sourceSha256,language:candidate.language,representationVersion:candidate.version,
    payloadSha256:candidate.payload_sha256,ownerId:source.identity.owner_id,targetKind}):unavailableExplanationReview();
  for(const row of representations){
    let valid;
    try{valid=validateExplanationRepresentation(source,row);}catch{continue;}
    if(!heads.some(head=>head.language===valid.language&&head.source_sha256===valid.source_sha256&&head.representation_version===valid.version))continue;
    const dimensions=await dimensionsFor(valid,'stored');
    review.push({targetKind:'stored',language:valid.language,version:valid.version,source_sha256:valid.source_sha256,payload_sha256:valid.payload_sha256,...dimensions});
  }
  if(source.supported){
    const virtual={language:source.originalLanguage,version:'legacy-projection-v1',payload_sha256:explanationPayloadHash(source.originalPayload)};
    const dimensions=objective&&source.originalLanguage===null
      ?trusted&&bundle.reviewSourceBinding.state==='unregistered'?unreviewedExplanation():unavailableExplanationReview()
      :await dimensionsFor(virtual,'original');
    review.push({targetKind:'original',language:virtual.language,version:virtual.version,source_sha256:source.sourceSha256,payload_sha256:virtual.payload_sha256,...dimensions});
  }
  return projectExplanationView({source,requestedLanguage:language,representations,heads,review,
    sourceOrigin:bundle.sourceOrigin,reviewSourceBinding:bundle.reviewSourceBinding});
}

/** An intentional SQL refusal must not poison the surrounding read/export transaction. */
export async function protectedExplanationRead(client,read) {
  await client.query('SAVEPOINT explanation_read');
  try {
    const value=await read();
    await client.query('RELEASE SAVEPOINT explanation_read');
    return value;
  } catch(error) {
    try {await client.query('ROLLBACK TO SAVEPOINT explanation_read');await client.query('RELEASE SAVEPOINT explanation_read');}catch{/* Outer transaction preserves the original failure. */}
    throw error;
  }
}

/** Export only valid current selections reachable through one already authorized saved context. */
export async function selectedExplanationExports(client,bundle,context) {
  const rows=[],seen=new Map();
  for(const language of [null,...EXPLANATION_LANGUAGES]){
    const view=await projectStoredExplanation(client,bundle,language);
    const selection={selection_language:language,state:view.state,requested_status:view.requested_status,reason:view.reason,displayed_language:view.displayed_language};
    if(!view.representation){rows.push({context,source:view.source,language:null,representation:null,review:view.review,selections:[selection]});continue;}
    const key=canonicalJson([context,view.source?.kind,view.source?.source_sha256,view.displayed_language,view.representation.version,view.representation.payload_sha256]);
    if(seen.has(key)){seen.get(key).selections.push(selection);continue;}
    const row={context,source:view.source,language:view.displayed_language,representation:view.representation,review:view.review,selections:[selection]};
    seen.set(key,row);rows.push(row);
  }
  return rows;
}

/** Map only intentional protected-reader failures; unexpected DB failures remain redacted errors. */
export function explanationFault(error) {
  if(error instanceof Fault)throw error;
  if(error?.message==='not_found')throw new Fault(404,'not_found');
  if(error?.message==='invalid_explanation_language')throw new Fault(422,'invalid_explanation_language');
  throw error;
}

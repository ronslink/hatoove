import {createHash} from 'node:crypto';
import {types} from 'node:util';
import {DTZ_POLICY} from './writing-policy.mjs';

export const PROVIDER_ATTEMPT_SCHEMA_VERSION=1;
export const MAX_USAGE_COUNT=1_000_000_000_000;
export const MAX_ELAPSED_MS=86_400_000;
export const MAX_REPORT_WINDOW_MS=31*24*60*60*1000;
export const MAX_REPORT_ATTEMPTS=100_000;
export const DEFAULT_RECLAIM_BATCH_SIZE=25;
export const MAX_RECLAIM_BATCH_SIZE=100;
const fail=code=>{throw Object.assign(Error(code),{code});};
const frozen=value=>{if(value&&typeof value==='object'){for(const child of Object.values(value))frozen(child);Object.freeze(value);}return value;};
const hash=value=>createHash('sha256').update(JSON.stringify(value),'utf8').digest('hex');
const record=(value,keys,required=keys)=>{
 if(!value||types.isProxy(value)||![Object.prototype,null].includes(Object.getPrototypeOf(value)))return false;
 const own=Reflect.ownKeys(value);
 return own.every(key=>typeof key==='string'&&keys.includes(key)&&Object.hasOwn(Object.getOwnPropertyDescriptor(value,key),'value'))&&required.every(key=>Object.hasOwn(value,key));
};
const identityKeys=['schemaVersion','adapterId','adapterVersion','providerId','operation','transportMode','requestedModel','promptVersion','pricingCardId','pricingCard','pricingSha256'];
const cardKeys=['schemaVersion','cardId','currency','modelIds','unit','inputRate','cachedInputRate','outputRate','reasoningOutputRate'];
const receiptKeys=['modelReported','inputTokens','outputTokens','cachedInputTokens','reasoningOutputTokens','usageBasis'];
const counterKeys=['inputTokens','outputTokens','cachedInputTokens','reasoningOutputTokens'];
const modelIds=['fixture-model-a','fixture-model-b'];
function priceCard(id){return {schemaVersion:1,cardId:id,currency:id==='synthetic-usd-v1'?'USD':'EUR',modelIds:['fixture-model-a'],unit:1_000_000,inputRate:'2',cachedInputRate:'0.5',outputRate:'4',reasoningOutputRate:'4'};}
function decimal(value){
 if(typeof value!=='string'||value.length>25||!/^(0|[1-9][0-9]{0,11})(\.[0-9]{0,11}[1-9])?$/.test(value)||/\s/u.test(value))fail('provider_identity_invalid');
 const [whole,fraction='']=value.split('.');return {coefficient:BigInt(whole+fraction),scale:fraction.length};
}
export function canonicalAmount(coefficient,scale=0){
 let raw=coefficient.toString().padStart(scale+1,'0');if(scale)raw=raw.slice(0,-scale)+'.'+raw.slice(-scale);
 return raw.includes('.')?raw.replace(/0+$/,'').replace(/\.$/,''):raw;
}
export function sumAmounts(values){let scale=0,total=0n;for(const value of values){const [w,f='']=value.split('.');if(f.length>scale){total*=10n**BigInt(f.length-scale);scale=f.length;}total+=BigInt(w+f)*10n**BigInt(scale-f.length);}return canonicalAmount(total,scale);}
function checkedCard(card){
 if(!record(card,cardKeys)||card.schemaVersion!==1||!['synthetic-usd-v1','synthetic-eur-v1'].includes(card.cardId)||!['USD','EUR'].includes(card.currency)
  ||!Array.isArray(card.modelIds)||types.isProxy(card.modelIds)||card.modelIds.length!==1||Object.getOwnPropertyDescriptor(card.modelIds,'0')?.value!=='fixture-model-a'
  ||Reflect.ownKeys(card.modelIds).some(key=>!['0','length'].includes(key))||card.currency!==(card.cardId==='synthetic-usd-v1'?'USD':'EUR')||![1,1000,1000000].includes(card.unit))fail('provider_identity_invalid');
 for(const key of ['inputRate','outputRate'])decimal(card[key]);for(const key of ['cachedInputRate','reasoningOutputRate'])if(card[key]!==null)decimal(card[key]);
 return Object.fromEntries(cardKeys.map(key=>[key,key==='modelIds'?['fixture-model-a']:card[key]]));
}
export function validateProviderIdentity(selector,{builtin=false,policy=null}={}){
 const defaultId=builtin?(policy===DTZ_POLICY?'local-dtz-stub-v1':'local-telc-stub-v1'):'synthetic-grader-v1';
 if(selector===undefined)selector={adapterId:defaultId,pricingCardId:null};
 if(!record(selector,['adapterId','pricingCardId'])||selector.adapterId!==defaultId||![null,'synthetic-usd-v1','synthetic-eur-v1'].includes(selector.pricingCardId)
  ||(builtin&&selector.pricingCardId!==null))fail('provider_identity_invalid');
 const card=selector.pricingCardId?priceCard(selector.pricingCardId):null;
 return frozen({schemaVersion:1,adapterId:defaultId,adapterVersion:defaultId,providerId:builtin?'none':'synthetic',operation:'writing_assessment',
  transportMode:builtin?'local_stub':'synthetic_fixture',requestedModel:builtin?null:'fixture-model-a',promptVersion:builtin?(policy===DTZ_POLICY?'dtz-simulation-v1':'stub-grader-v2'):'synthetic-prompt-v1',
  pricingCardId:selector.pricingCardId,pricingCard:card,pricingSha256:card?hash(card):null});
}
function checkedIdentity(identity){
 if(!record(identity,identityKeys))fail('provider_identity_invalid');
 const builtin=identity.transportMode==='local_stub',policy=identity.adapterId==='local-dtz-stub-v1'?DTZ_POLICY:null;
 const expected=validateProviderIdentity({adapterId:identity.adapterId,pricingCardId:identity.pricingCardId},{builtin,policy});
 const card=identity.pricingCard===null?null:checkedCard(identity.pricingCard);
 if((expected.pricingCardId===null)!==(card===null)||(card&&card.cardId!==expected.pricingCardId))fail('provider_identity_invalid');
 const normalized={...expected,pricingCard:card,pricingSha256:card?hash(card):null};
 if(identityKeys.some(key=>!['pricingCard','pricingSha256'].includes(key)&&identity[key]!==normalized[key])||identity.pricingSha256!==normalized.pricingSha256)fail('provider_identity_invalid');
 return normalized;
}
export function normalizeUsageReceipt(raw,identity){
 const trusted=checkedIdentity(identity);
 if(!record(raw,receiptKeys,['usageBasis'])||!['reported','missing','not_applicable','unsupported'].includes(raw.usageBasis))fail('invalid_receipt');
 const out={modelReported:raw.modelReported??null};
 if(out.modelReported!==null&&typeof out.modelReported!=='string')fail('invalid_receipt');
 let issue=null;const allowed=trusted.transportMode==='local_stub'?[trusted.promptVersion]:modelIds;
 if(out.modelReported!==null&&!allowed.includes(out.modelReported)){out.modelReported=null;issue='unrecognised_model';}
 for(const key of counterKeys){const value=raw[key]??null;if(value!==null&&(!Number.isSafeInteger(value)||Object.is(value,-0)||value<0||value>MAX_USAGE_COUNT))fail('invalid_receipt');out[key]=value;}
 if((out.cachedInputTokens!==null&&(out.inputTokens===null||out.cachedInputTokens>out.inputTokens))||(out.reasoningOutputTokens!==null&&(out.outputTokens===null||out.reasoningOutputTokens>out.outputTokens)))fail('invalid_receipt');
 if(raw.usageBasis!=='reported'&&counterKeys.some(key=>out[key]!==null))fail('invalid_receipt');
 if(raw.usageBasis==='not_applicable'&&(trusted.transportMode!=='local_stub'||out.modelReported!==trusted.promptVersion))fail('invalid_receipt');
 return frozen({...out,usageBasis:raw.usageBasis,receiptIssue:issue});
}
export function createUsageCapture(identity){
 checkedIdentity(identity);let receipt=null,issue=null,closed=false,effective=null;
 const captureUsage=raw=>{
  if(closed)return frozen({accepted:false,code:'capture_closed'});
  let normalized;try{normalized=normalizeUsageReceipt(raw,identity);}catch{if(issue!=='conflicting_receipt')issue='invalid_receipt';return frozen({accepted:false,code:'invalid_receipt'});}
  if(receipt&&JSON.stringify(receipt)!==JSON.stringify(normalized)){issue='conflicting_receipt';return frozen({accepted:false,code:'conflicting_receipt'});}
  const replay=receipt!==null;if(!receipt)receipt=normalized;return frozen({accepted:true,replay});
 };
 const close=()=>{if(!closed){closed=true;effective=frozen({...receipt??{modelReported:null,inputTokens:null,outputTokens:null,cachedInputTokens:null,reasoningOutputTokens:null,usageBasis:issue?'unsupported':'missing'},receiptIssue:issue??receipt?.receiptIssue??null});}return effective;};
 return Object.freeze({captureUsage,close});
}
export function estimateAttemptCost(identity,observation){
 const i=checkedIdentity(identity),card=i.pricingCard;
 const unknown=reason=>frozen({costStatus:'unknown',costReason:reason,currency:card?.currency??null,estimatedAmount:null,pricingSha256:i.pricingSha256});
 if(observation===null)return unknown('missing_observation');
 if(!record(observation,['transportStatus','receiptCaptured','receipt','disposition','failureCode','elapsedMs','elapsedIssue'],['transportStatus','receiptCaptured','receipt']))fail('provider_observation_invalid');
 const r=observation.receipt;
 if(!observation||!['response','uncertain','definite_not_sent'].includes(observation.transportStatus)||typeof observation.receiptCaptured!=='boolean'
  ||(observation.transportStatus==='response'&&!observation.receiptCaptured)||!record(r,[...receiptKeys,'receiptIssue'])
  ||![null,'invalid_receipt','conflicting_receipt','unrecognised_model'].includes(r.receiptIssue))fail('provider_observation_invalid');
 try{const normalized=normalizeUsageReceipt(Object.fromEntries(receiptKeys.map(key=>[key,r[key]])),i);
  if(receiptKeys.some(key=>normalized[key]!==r[key])||(r.receiptIssue==='unrecognised_model'&&r.modelReported!==null))fail('provider_observation_invalid');
 }catch{fail('provider_observation_invalid');}
 if(observation.transportStatus!=='response')return unknown('uncertain_transport');
 if(!r||['invalid_receipt','conflicting_receipt'].includes(r.receiptIssue))return unknown('invalid_receipt');
 if(i.transportMode==='local_stub'&&observation.receiptCaptured===true&&r.usageBasis==='not_applicable')return frozen({costStatus:'not_applicable',costReason:null,currency:null,estimatedAmount:null,pricingSha256:null});
 if(r.usageBasis==='unsupported')return unknown('unsupported_usage');if(r.usageBasis!=='reported')return unknown('missing_usage');
 if(!card)return unknown('missing_card');if(!r.modelReported||r.receiptIssue==='unrecognised_model')return unknown('model_unknown');
 if(!card.modelIds.includes(r.modelReported))return unknown('model_mismatch');
 let total=0n,scale=12;
 for(const [base,subset,rate,subsetRate] of [['inputTokens','cachedInputTokens','inputRate','cachedInputRate'],['outputTokens','reasoningOutputTokens','outputRate','reasoningOutputRate']]){
  const b=r[base],s=r[subset],equal=card[subsetRate]===null||card[subsetRate]===card[rate];
  if(b===null||b===undefined||(!equal&&(s===null||s===undefined)))return unknown('missing_billable_dimension');
  if(!Number.isSafeInteger(b)||b<0||b>MAX_USAGE_COUNT||Object.is(b,-0)||(!equal&&(!Number.isSafeInteger(s)||s<0||s>b||Object.is(s,-0))))fail('provider_observation_invalid');
  const a=decimal(card[rate]),c=decimal(equal?card[rate]:card[subsetRate]);
  total+=BigInt(equal?b:b-s)*a.coefficient*10n**BigInt(scale-a.scale);
  if(!equal)total+=BigInt(s)*c.coefficient*10n**BigInt(scale-c.scale);
 }
 scale+=card.unit===1?0:card.unit===1000?3:6;
 return frozen({costStatus:'estimated',costReason:null,currency:card.currency,estimatedAmount:canonicalAmount(total,scale),pricingSha256:i.pricingSha256});
}

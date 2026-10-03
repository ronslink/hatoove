/** Declared legacy language, not native review. Registry never follows current exam/request language. */
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {packageHash,objectiveItems} from './package-contract.mjs';
const pinned=Object.freeze([
 ['telc-deutsch-b1','67e3caf0fc54708986ec0619002dc8ea92e3b5d5629947be1f9dea3fb29a05ba'],
 ['dtz-a2-b1','8d6497fd1d878e9f7f76ee00365f473f5d8fa930857643a5685b64ea65dcf29e']
]);
export const EXPLANATION_LANGUAGE_REGISTRY_VERSION='bundled-original-de-v1';
const entries=[];
// Exact retained seed bytes declare German originals. No language inference from family or request.
try{
 const bytes=readFileSync(new URL('../data/seed.json',import.meta.url));
 if(createHash('sha256').update(bytes).digest('hex')==='ef26279dfaf3399de1039e0528f385465a5c1a2bc414f0bd0b5c270df2023bac'){
  const seed=JSON.parse(bytes);
  for(const [family,sets] of Object.entries(seed))for(const [index,set] of sets.entries()){
   const originals=new Map(Object.entries(set.why&&typeof set.why==='object'?set.why:{}));
   for(const rows of Object.values(set))if(Array.isArray(rows))for(const row of rows)if(row&&typeof row==='object'&&row.why!==undefined)originals.set(String(row.id??row.n??''),row.why);
   for(const [item,original]of originals)if(typeof original==='string')entries.push(Object.freeze({exam_id:'telc-deutsch-b1',set_id:`telc-deutsch-b1.${family.toLowerCase()}.${String(index+1).padStart(2,'0')}`,set_version:'v1',item_id:item,original_value_sha256:packageHash(original),language:'de'}));
  }
 }
}catch{/* Missing or changed legacy bytes remain unknown. */}
for(const [exam,digest] of pinned){
 try {
  const p=JSON.parse(readFileSync(new URL(`../content/exams/${exam}/manifest.json`,import.meta.url),'utf8'));
  if(packageHash(p)!==digest)continue;
  for(const set of p.sets)for(const item of objectiveItems(set.payload,set.interaction)){
   const original=set.explanations?.[item.id]??set.explanations?._set_why?.[item.id];
   if(typeof original==='string')entries.push(Object.freeze({exam_id:exam,set_id:set.setId,set_version:set.version,item_id:item.id,original_value_sha256:packageHash(original),language:'de'}));
  }
 }catch{/* Missing/changed/unsupported bundles have unknown language, never a guessed default. */}
}
const builtins=Object.freeze(entries);
export function resolveObjectiveExplanationLanguage({examId,setId,setVersion,itemId,originalValue},{registry=[]}={}){
 const digest=packageHash(originalValue??null),languages=new Set();
 for(const row of [...builtins,...(Array.isArray(registry)?registry:[])]){
  if(row.exam_id===examId&&row.set_id===setId&&row.set_version===setVersion&&row.item_id===itemId&&row.original_value_sha256===digest&&['de','en','uk','ar','tr'].includes(row.language))languages.add(row.language);
 }
 return languages.size===1?[...languages][0]:null;
}

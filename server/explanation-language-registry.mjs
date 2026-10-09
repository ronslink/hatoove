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
// Git checks this retained seed out as LF or CRLF. Canonicalize only CRLF byte pairs to LF;
// every other byte (including whitespace, BOM and JSON spelling) remains part of the pin.
// Latin-1 round-tripping preserves bytes rather than repairing malformed UTF-8.
export function legacySeedLanguageRegistry(bytes){
 const declared=[];
 if(!Buffer.isBuffer(bytes))return Object.freeze(declared);
 const canonical=Buffer.from(bytes.toString('latin1').replace(/\r\n/g,'\n'),'latin1');
 if(createHash('sha256').update(canonical).digest('hex')==='40a0a06616a539c291be4db1b6644f83f6027cf0423be81343f0dd8a5ed205a6'){
  const seed=JSON.parse(canonical);
  for(const [family,sets] of Object.entries(seed))for(const [index,set] of sets.entries()){
   const originals=new Map(Object.entries(set.why&&typeof set.why==='object'?set.why:{}));
   for(const rows of Object.values(set))if(Array.isArray(rows))for(const row of rows)if(row&&typeof row==='object'&&row.why!==undefined)originals.set(String(row.id??row.n??''),row.why);
   for(const [item,original]of originals)if(typeof original==='string')declared.push(Object.freeze({exam_id:'telc-deutsch-b1',set_id:`telc-deutsch-b1.${family.toLowerCase()}.${String(index+1).padStart(2,'0')}`,set_version:'v1',item_id:item,original_value_sha256:packageHash(original),language:'de'}));
  }
 }
 return Object.freeze(declared);
}
// Exact retained source declares German originals. No inference from family or requested language.
try{entries.push(...legacySeedLanguageRegistry(readFileSync(new URL('../data/seed.json',import.meta.url))));}
catch{/* Missing or changed legacy bytes remain unknown. */}
// The server image omits data/seed.json. This projection preserves the same exact declarations;
// it contains only identities/digests, and a changed original still resolves to unknown.
export function projectedLegacyLanguageRegistry(bytes) {
 try {
  if(!Buffer.isBuffer(bytes))return Object.freeze([]);
  const projected=JSON.parse(bytes.toString('utf8'));
  return packageHash(projected)==='a81b5b0b0c0fa4f691038514c8da3460ecddc595ddb286b621ef5bf4397d6d70'
   ? Object.freeze(projected.map(row=>Object.freeze(row))) : Object.freeze([]);
 } catch { return Object.freeze([]); }
}
try { entries.push(...projectedLegacyLanguageRegistry(readFileSync(new URL('./legacy-explanation-language.json',import.meta.url)))); }
catch {/* Missing projected metadata remains unknown. */}
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

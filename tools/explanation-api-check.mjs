/** Focused HTTP-port contract checks; no database, provider, server or environment file. */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createOwnedApi,Fault} from '../server/owned-api.mjs';
import {MOCK_METHODS} from '../server/mock-contract.mjs';

const owner=randomUUID(),id=randomUUID(),other=randomUUID(),calls=[];
let mutations=0,passed=0;
const sessions={getSession:async headers=>headers.cookie==='synthetic'?{userId:owner}:null,signUp:async()=>{},signIn:async()=>{},signOut:async()=>{}};
const datastore=Object.fromEntries(['create','read','save','submit','result','retry','remove',...MOCK_METHODS].map(name=>[name,async()=>{mutations++;return{};}]));
for(const name of ['result','readMockRun','readObjectiveEvidenceExplanation'])datastore[name]=async(account,identity,options)=>{
  assert.equal(account,owner,'identity is derived only from the authenticated session');
  if(identity!==id)throw new Fault(404,'not_found');
  calls.push({name,identity,options});
  return {saved_fact:'unchanged',explanation_view:{requested_language:options.explanationLanguage??options.language??null}};
};
const api=createOwnedApi({datastore,sessions});
const paths=[['result','/api/v1/submissions/'+id,'explanationLanguage'],['readMockRun','/api/v1/mock-runs/'+id,'explanationLanguage'],['readObjectiveEvidenceExplanation','/api/v1/objective-evidence/'+id+'/explanation','language']];
const request=(path,patch={})=>api.handle({path,method:'GET',headers:{cookie:'synthetic'},...patch});
const check=async(name,fn)=>{await fn();passed++;console.log('PASS '+name);};

await check('all five supported languages and omitted original select read methods only',async()=>{
  for(const [name,path,key] of paths)for(const language of [null,'de','en','uk','ar','tr']){
    const reply=await request(path+(language?'?'+key+'='+language:''));
    assert.equal(reply.status,200);assert.equal(JSON.parse(reply.body).saved_fact,'unchanged');
    assert.deepEqual(calls.at(-1),{name,identity:id,options:{[key]:language}});
  }
  assert.equal(mutations,0);
});
await check('invalid, empty, duplicate and unknown language queries fail before datastore reads',async()=>{
  const before=calls.length;
  for(const [,path,key] of paths)for(const suffix of [key+'=',key+'=DE',key+'=fr',key+'=de&'+key+'=en','owner='+owner,'source_sha256='+('a'.repeat(64)),key+'=ar&version=v2'])
    assert.equal((await request(path+'?'+suffix)).status,422,suffix);
  assert.equal(calls.length,before);assert.equal(mutations,0);
});
await check('anonymous and stale account requests cannot reach protected readers',async()=>{
  const before=calls.length;
  for(const [,path] of paths){
    assert.equal((await request(path,{headers:{}})).status,401);
    assert.equal((await request(path,{headers:{cookie:'synthetic','x-hatoove-account':other}})).status,409);
  }
  assert.equal(calls.length,before);
});
await check('foreign or absent parent IDs remain indistinguishable 404s',async()=>{
  for(const [,path] of paths)assert.equal((await request(path.replace(id,other))).status,404);
});
await check('standalone explanation capability is optional and cannot disable existing results',async()=>{
  const {readObjectiveEvidenceExplanation,...without}=datastore;
  const absent=createOwnedApi({datastore:without,sessions});assert.equal(absent.configured,true);
  const r=await absent.handle({path:paths[2][1],headers:{cookie:'synthetic'}});
  assert.equal(r.status,503);assert.equal(JSON.parse(r.body).error,'explanations_unavailable');
  assert.equal((await absent.handle({path:paths[0][1],headers:{cookie:'synthetic'}})).status,200);
});
await check('standalone route exposes no mutation or arbitrary-source selector',async()=>{
  const before=calls.length;
  for(const method of ['POST','PUT','DELETE'])assert.equal((await request(paths[2][1],{method,originChecked:true,headers:{cookie:'synthetic','content-type':'application/json'},body:'{}'})).status,404);
  assert.equal((await request('/api/v1/objective-evidence/not-a-uuid/explanation')).status,404);
  assert.equal(calls.length,before);assert.equal(mutations,0);
});
console.log(`Explanation API contract: ${passed} checks passed; no grading/mutation route invoked.`);

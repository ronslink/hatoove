/** Source-only HTTP proof: no database, environment file, provider or learner app. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createOwnedApi, Fault, BODY_LIMIT_BYTES } from '../server/owned-api.mjs';

let passed=0;
async function check(name,fn) { await fn(); console.log('PASS '+name); passed++; }
const owner=randomUUID(), order=randomUUID();
let paymentCalls=0, received;
const payments={
  offer:async(id,args)=>{paymentCalls++;assert.equal(id,owner);return {markets:[],offer:null,testMode:true,...args};},
  checkout:async(id,args)=>{paymentCalls++;assert.equal(id,owner);return {orderId:order,checkoutUrl:'https://checkout.stripe.com/c/test',expiresAt:'2030-01-01T00:00:00Z',testMode:true,...args};},
  order:async(id,value)=>{paymentCalls++;assert.equal(id,owner);if(value!==order)throw new Fault(404,'not_found');return{order:{id:value,testMode:true}};},
  webhook:async(raw,signature)=>{paymentCalls++;received=raw;assert.ok(Buffer.isBuffer(raw));if(signature!=='synthetic')throw new Fault(400,'invalid_webhook');return{received:true};},
};
const datastore=Object.fromEntries(['create','read','save','submit','result','retry','remove'].map(k=>[k,async()=>({})]));
const sessions={getSession:async headers=>headers.cookie==='synthetic-session'?{userId:owner}:null,signUp:async()=>{},signIn:async()=>{},signOut:async()=>{}};
const api=createOwnedApi({datastore,sessions,payments});
const request=(path,method='GET',body,extra={})=>api.handle({path,method,headers:{cookie:'synthetic-session','content-type':'application/json'},originChecked:true,body:body===undefined?'':JSON.stringify(body),...extra});
await check('payments are optional; absence does not disable owned API',async()=>{
 const absent=createOwnedApi({datastore,sessions});assert.equal(absent.configured,true);
 const r=await absent.handle({path:'/api/v1/checkout/offer?exam=telc-deutsch-b1',headers:{cookie:'synthetic-session'}});
 assert.equal(r.status,503);assert.equal(JSON.parse(r.body).error,'payments_unavailable');
});
await check('session, account context and origin guards precede payment calls',async()=>{
 const before=paymentCalls;
 assert.equal((await request('/api/v1/checkout/offer?exam=telc-deutsch-b1','GET',null,{headers:{}})).status,401);
 assert.equal((await request('/api/v1/checkout/offer?exam=telc-deutsch-b1','GET',null,{headers:{cookie:'synthetic-session','x-hatoove-account':'another'}})).status,409);
 assert.equal((await request('/api/v1/checkout/session','POST',{}, {originChecked:false})).status,403);
 assert.equal(paymentCalls,before);
});
await check('closed checkout body rejects owner, commercial terms and malformed selectors',async()=>{
 const input={examId:'telc-deutsch-b1',market:'DE',eventId:randomUUID()},before=paymentCalls;
 for(const extra of [{ownerId:owner},{amountMinor:1},{currency:'EUR'},{stripePriceId:'price_fake'},{market:'de'},{market:['DE']},{examId:['telc-deutsch-b1']},{eventId:'bad'}]) assert.equal((await request('/api/v1/checkout/session','POST',{...input,...extra})).status,422);
 assert.equal((await request('/api/v1/checkout/offer?exam=telc-deutsch-b1&market=DE&market=US')).status,422);
 assert.equal(paymentCalls,before);
 assert.equal((await request('/api/v1/checkout/session','POST',input)).status,201);
 assert.equal((await request('/api/v1/orders/'+randomUUID())).status,404);
});
await check('only exact webhook POST bypasses session/origin and retains raw bytes',async()=>{
 const raw=Buffer.from(' { "text": "Grüße", "nested": [1,2] } \n');
 const r=await request('/api/v1/payments/stripe/webhook','POST',null,{headers:{'stripe-signature':'synthetic'},body:raw,originChecked:false});
 assert.equal(r.status,200);assert.deepEqual(received,raw);
 for(const path of ['/api/v1/payments/stripe/webhook/','/api/v1/payments/stripe/webhook?x=1','/api/v1/payments/stripe/webhook-other']) assert.equal((await request(path,'POST',{}, {originChecked:false,headers:{}})).status,403);
 assert.equal((await request('/api/v1/payments/stripe/webhook','GET',null,{headers:{}})).status,401);
 assert.equal((await request('/api/v1/payments/stripe/webhook','POST',null,{body:Buffer.alloc(BODY_LIMIT_BYTES+1),headers:{},originChecked:false})).status,413);
});
const temp=await mkdtemp(path.join(os.tmpdir(),'hatoove-payments-http-'));
process.env.B1PREP_ENV_FILE=path.join(temp,'absent.env');
process.env.B1PREP_PROGRESS_FILE=path.join(temp,'absent.json');
delete process.env.B1PREP_ACCOUNTS;
const {createServer}=await import('../server.js');
const server=createServer({ownedApi:api});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const origin=`http://127.0.0.1:${server.address().port}`;
try {
 await check('real HTTP mount accepts exact raw webhook and rejects cross-origin siblings',async()=>{
  const raw=Buffer.from(' {"line":"ä\\ntext"}\n');
  let r=await fetch(origin+'/api/v1/payments/stripe/webhook',{method:'POST',headers:{origin:'https://foreign.invalid','stripe-signature':'synthetic'},body:raw});
  assert.equal(r.status,200);assert.deepEqual(received,raw);
  r=await fetch(origin+'/api/v1/payments/stripe/webhook',{method:'POST',headers:{'stripe-signature':'bad'},body:raw});assert.equal(r.status,400);
  for(const suffix of ['/','?x=1','-other']) {
   r=await fetch(origin+'/api/v1/payments/stripe/webhook'+suffix,{method:'POST',headers:{origin:'https://foreign.invalid','content-type':'application/json'},body:'{}'});assert.equal(r.status,403);
  }
  r=await fetch(origin+'/api/v1/payments/stripe/webhook',{method:'POST',headers:{'stripe-signature':'synthetic'},body:Buffer.alloc(BODY_LIMIT_BYTES+1)});assert.equal(r.status,413);
 });
} finally { await new Promise(resolve=>server.close(resolve));await rm(temp,{recursive:true,force:true}); }
console.log(`payments-api-check: ${passed}/${passed} passed`);

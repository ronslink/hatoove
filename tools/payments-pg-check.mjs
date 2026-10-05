/** Restricted-role payment proof. Only an explicitly selected disposable database is permitted. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp,rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createOwnedApi } from '../server/owned-api.mjs';
import { createFixture } from '../server/owned-postgres/bootstrap.mjs';
import {importHistoricalDefaultPackage,assertHistoricalProjectionAbsent} from './historical-content-fixture.mjs';
import { createPostgresWorld } from '../server/owned-postgres/fixture.mjs';
import { createPostgresPayments } from '../server/owned-postgres/payments.mjs';
import { createPostgresAccountDeletion } from '../server/owned-postgres/adapter.mjs';
import { createWorker,stubGrade } from '../server/owned-postgres/worker.mjs';
import { createExamCatalogue } from '../server/preparation-contract.mjs';
import { importPackage } from '../server/owned-postgres/package-importer.mjs';
import { syntheticS4Package } from './exam-s4-check.mjs';
import { runTableClassCheck } from './table-class-check.mjs';
import { InvalidSignature,createPaymentsPort } from '../server/payments/port.mjs';
import { buildSignatureHeader } from '../server/payments/signature.mjs';

/*
 * The expected forward-migration remainder is DERIVED from `server/migrations/MANIFEST.json`, not listed.
 * The hard-coded arrays this replaces ended at `0041`, so every one of these checks turned red the moment
 * `0042`-`0047` landed - and because they sit behind each other in the CI job, only the first was ever seen.
 * The manifest is an independent pinned record of which migrations exist and their digests, so the assertion
 * still proves the forward migrations applied in order, with none missing and none invented.
 */
const migrationManifest = JSON.parse(readFileSync(new URL('../server/migrations/MANIFEST.json', import.meta.url), 'utf8'));
const expectedRemainder = from => Object.keys(migrationManifest.migrations).filter(name => name >= from).sort().map(name => name + '.sql');

if(process.env.OWNAPI_PG_ALLOW!=='1'||!process.env.OWNAPI_PG_PORT||[4300,55440].includes(Number(process.env.OWNAPI_PG_PORT))) throw Error('Explicit isolated OWNAPI_PG_ALLOW/PORT required');
process.env.B1PREP_CONTENT_MODE='internal-preview';delete process.env.B1PREP_SERVE_REVIEW;delete process.env.B1PREP_SERVE_RIGHTS;
const TELC='telc-deutsch-b1',DTZ='dtz-a2-b1',origin='https://synthetic.invalid';
let passed=0;const check=async(name,fn)=>{await fn();console.log('PASS '+name);passed++;};
const reject=(p,code)=>assert.rejects(p,e=>e.code===code);
const db=await createFixture({stopBefore:'0028-'});
const world=await createPostgresWorld({fixture:db,examCatalogue:createExamCatalogue({enabled:[TELC,DTZ]})});
const sql=(s,p=[])=>db.admin.query(s,p), one=async(s,p=[])=>(await sql(s,p)).rows[0];
const fixtureClock=()=>new Date();
let creationCalls=[],uncertain=false;
const provider={configured:true,mode:'stub',
 async createCheckoutSession(args){creationCalls.push(args);if(uncertain)throw Error('DO NOT EXPOSE provider details');return{providerSessionId:'cs_test_'+args.orderId.replaceAll('-',''),url:`${origin}/app/#/checkout?order=${args.orderId}&checkout=stub`,expiresAt:new Date(Date.now()+3600000).toISOString()};},
 verifyWebhook:async({rawBody,signatureHeader})=>{assert.ok(Buffer.isBuffer(rawBody));if(signatureHeader!=='synthetic')throw new InvalidSignature('signature_mismatch');return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(rawBody));},
 readEvent:event=>event,
};
const payment=()=>createPostgresPayments({pool:db.payments,provider,publicOrigin:origin,now:fixtureClock});
let payments=payment();
const send=(event,port=payments)=>port.webhook(Buffer.from(JSON.stringify(event)),'synthetic');
async function user(tag){const r=await world.sessions.signUp({name:'Synthetic payment '+tag,email:`payments-${tag}-${randomUUID()}@example.invalid`,password:'synthetic-password'});const cookie=String(r.setCookie).split(';')[0];return (await world.sessions.getSession({cookie})).userId;}
const purchase=(owner,eventId=randomUUID(),market='DE')=>payments.checkout(owner,{examId:TELC,market,eventId});
const eventFor=async(orderId,extra={})=>{const o=await one('SELECT * FROM payment_order WHERE id=$1',[orderId]);return{id:'evt_'+randomUUID().replaceAll('-',''),type:'checkout.session.completed',kind:'paid',orderId,providerRef:o.provider_ref,paymentIntentRef:'pi_'+orderId.replaceAll('-',''),amountMinor:o.amount_minor,currency:o.currency,paymentStatus:'paid',livemode:false,...extra};};
async function asOwner(owner,fn){const c=await db.learner.connect();try{await c.query('BEGIN');await c.query("SELECT set_config('hatoove.owner_id',$1,true)",[owner]);const r=await fn(c);await c.query('COMMIT');return r;}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}}
const resetBalance=(owner,extra='')=>sql(`UPDATE entitlements SET allowance=10,used=10,reserved=0${extra} WHERE owner_id=$1 AND exam_id=$2`,[owner,TELC]);
try {
 await importHistoricalDefaultPackage(db);
 const legacy=await user('legacy');
 const before=await one('SELECT * FROM entitlements WHERE owner_id=$1',[legacy]);
 await check('forward migration preserves legacy balances and seeds no commercial offers',async()=>{
  await assertHistoricalProjectionAbsent(db);
  assert.deepEqual(await db.applyRemaining(), expectedRemainder('0028-payments'));
  assert.deepEqual(await one('SELECT owner_id,exam_id,allowance,used,reserved FROM entitlements WHERE owner_id=$1',[legacy]),before);
  assert.equal((await one('SELECT expires_at FROM entitlements WHERE owner_id=$1',[legacy])).expires_at,null);
  assert.equal((await one('SELECT count(*)::int AS n FROM payment_product')).n,0);
  assert.equal((await runTableClassCheck({db:db.admin,schema:db.schema,roles:db.roles})).ok,true);
 });
 await sql("INSERT INTO payment_product VALUES('synthetic-telc',$1,10,30,true)",[TELC]);
 await sql("INSERT INTO payment_price VALUES('synthetic-telc','DE','EUR',1000,'Synthetic EUR 10','price_synthetic',true),('synthetic-telc','US','USD',1200,'Synthetic USD 12','price_us',true)");
 const a=await user('a'),b=await user('b');
 await check('explicit markets, runtime exam gate, existing legacy balance and disabled payment reads',async()=>{
  const list=await payments.offer(a,{examId:TELC});assert.equal(list.offer,null);assert.equal(list.markets.length,2);
  const offer=(await payments.offer(a,{examId:TELC,market:'DE'})).offer;assert.equal(offer.purchasable,false);assert.equal(offer.existing.expiresAt,null);assert.equal(offer.testMode,true);
  await reject(purchase(a),'already_entitled');await reject(payments.offer(a,{examId:DTZ,market:'DE'}),'not_found');await reject(payments.offer(a,{examId:TELC,market:'ZZ'}),'not_found');
  await reject(createPostgresPayments({pool:db.payments,provider:{configured:false}}).offer(a,{examId:TELC}),'payments_unavailable');
 });
 await resetBalance(a);await resetBalance(b);
 let orderA,eventA;
 await check('uncertain creation persists order; concurrent requests reuse it and server terms',async()=>{
  uncertain=true;const eid=randomUUID();eventA=eid;await reject(purchase(a,eid),'provider_unavailable');uncertain=false;
  const stored=await one('SELECT * FROM payment_order WHERE owner_id=$1',[a]);assert.equal(stored.status,'pending');assert.equal(stored.provider_ref,null);
  const both=await Promise.all([purchase(a,eid),purchase(a)]);assert.equal(both[0].orderId,stored.id);assert.equal(both[1].orderId,stored.id);orderA=stored.id;
  assert.ok(creationCalls.filter(c=>c.ownerId===a).every(c=>c.orderId===stored.id&&c.price.amountMinor===1000));
  await reject(purchase(a,eid,'US'),'event_conflict');await reject(purchase(a,randomUUID(),'US'),'checkout_pending');
  assert.equal((await one('SELECT count(*)::int AS n FROM payment_order WHERE owner_id=$1',[a])).n,1);
 });
 await check('two-owner RLS, no learner grants, no auth/worker payment authority',async()=>{
  await reject(payments.order(b,orderA),'not_found');
  assert.equal((await asOwner(b,c=>c.query('SELECT * FROM payment_order WHERE id=$1',[orderA]))).rowCount,0);
  await assert.rejects(asOwner(a,c=>c.query("UPDATE payment_order SET status='paid' WHERE id=$1",[orderA])),e=>e.code==='42501');
  await assert.rejects(asOwner(a,c=>c.query('UPDATE entitlements SET allowance=999 WHERE owner_id=$1',[a])),e=>e.code==='42501');
  await assert.rejects(db.worker.query('SELECT * FROM payment_order'),e=>e.code==='42501');
  await assert.rejects(db.auth.query('SELECT * FROM payment_order'),e=>e.code==='42501');
  await assert.rejects(db.payments.query('SELECT email FROM "user"'),e=>e.code==='42501');
 });
 await check('invalid/live/unpaid/money/reference events durably refuse without grants',async()=>{
  for(const extra of [{livemode:true},{paymentStatus:'unpaid'},{amountMinor:null},{amountMinor:1},{currency:'USD'},{providerRef:'cs_test_wrong'}]) await send(await eventFor(orderA,extra));
  assert.equal((await one('SELECT count(*)::int AS n FROM payment_grant WHERE order_id=$1',[orderA])).n,0);
  assert.equal((await one('SELECT status FROM payment_order WHERE id=$1',[orderA])).status,'pending');
  await reject(payments.webhook(Buffer.from('{}'),'bad'),'invalid_webhook');
 });
 await check('signed grant rollback leaves no receipt, grant, status or balance change',async()=>{
  const event=await eventFor(orderA),before=await one('SELECT * FROM entitlements WHERE owner_id=$1',[a]);
  const failing=createPostgresPayments({pool:db.payments,provider,publicOrigin:origin,afterGrant:()=>{throw Error('synthetic rollback');}});
  await reject(send(event,failing),'payments_unavailable');
  assert.deepEqual(await one('SELECT * FROM entitlements WHERE owner_id=$1',[a]),before);
  assert.equal(await one('SELECT id FROM payment_event WHERE id=$1',[event.id]),undefined);
  assert.equal((await one('SELECT status FROM payment_order WHERE id=$1',[orderA])).status,'pending');
 });
 await check('concurrent same and different success events grant exactly once',async()=>{
  const event=await eventFor(orderA),other={...event,id:'evt_'+randomUUID().replaceAll('-','')};
  const gate=await db.admin.connect();let deliveries;
  try {
   await gate.query('BEGIN');await gate.query('SELECT pg_advisory_xact_lock(hashtextextended($1,7352))',[a]);
   const pid=(await gate.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
   deliveries=Promise.all([send(event),send(other)]);
   const deadline=Date.now()+5000;let waiting=0;
   while(Date.now()<deadline){waiting=(await one(`SELECT count(*)::int AS n FROM pg_stat_activity
     WHERE application_name=$1 AND $2::int=ANY(pg_blocking_pids(pid)) AND wait_event_type='Lock'`,[db.schema,pid])).n;
    if(waiting===2)break;await new Promise(resolve=>setTimeout(resolve,10));}
   assert.equal(waiting,2,'both independent webhook transactions overlap at the held owner gate');
   await gate.query('COMMIT');await deliveries;
  } finally {await gate.query('ROLLBACK').catch(()=>{});gate.release();if(deliveries)await deliveries;}
  await send(event);
  assert.equal((await one('SELECT count(*)::int AS n FROM payment_grant WHERE order_id=$1',[orderA])).n,1);
  const bal=await one('SELECT * FROM entitlements WHERE owner_id=$1',[a]);assert.equal(bal.allowance,20);assert.equal(bal.used,10);assert.equal(bal.expires_at,null);
  const off=createPostgresPayments({pool:db.payments,provider:{configured:false}});assert.equal((await off.order(a,orderA)).order.status,'paid');
  const calls=creationCalls.length,replay=await purchase(a,eventA);assert.equal(replay.status,'paid');assert.equal(replay.checkoutUrl,null);assert.equal(replay.orderId,orderA);assert.equal(creationCalls.length,calls);
  await reject(purchase(a,eventA,'US'),'event_conflict');
  for(const table of ['payment_order','payment_event','payment_grant','payment_checkout_event']) assert.equal((await asOwner(b,c=>c.query(`SELECT * FROM ${table} WHERE owner_id=$1`,[a]))).rowCount,0);
 });
 await check('refund mappings remain retryable until bound; partial refund preserves paid status',async()=>{
  const event=await eventFor(orderA,{kind:'refunded',type:'charge.refunded',fullRefund:true,amountRefunded:1000,providerRef:'ch_synthetic'});
  const missing={...event,id:'evt_'+randomUUID().replaceAll('-',''),orderId:null,paymentIntentRef:'pi_unknown'};
  await reject(send(missing),'payment_binding_pending');assert.equal(await one('SELECT id FROM payment_event WHERE id=$1',[missing.id]),undefined);
  await send({...event,id:'evt_'+randomUUID().replaceAll('-',''),amountRefunded:100,fullRefund:false});assert.equal((await payments.order(a,orderA)).order.status,'paid');
  await send({...event,orderId:null});assert.equal((await payments.order(a,orderA)).order.status,'refunded');
  await send(await eventFor(orderA));assert.equal((await one('SELECT count(*)::int AS n FROM payment_grant WHERE order_id=$1',[orderA])).n,1);
 });
 await check('expired grant drops unused expired units and retains used/reserved counters',async()=>{
  await sql("UPDATE entitlements SET allowance=50,used=7,reserved=2,expires_at=now()-interval '1 second' WHERE owner_id=$1",[b]);
  const order=await purchase(b);await send(await eventFor(order.orderId));
  const row=await one('SELECT * FROM entitlements WHERE owner_id=$1',[b]);assert.equal(row.allowance,19);assert.equal(row.used,7);assert.equal(row.reserved,2);assert.ok(row.expires_at>Date.now());
  await sql('UPDATE entitlements SET used=17 WHERE owner_id=$1',[b]);
  const expiry=row.expires_at.getTime(),next=await purchase(b);await send(await eventFor(next.orderId));
  const renewed=await one('SELECT * FROM entitlements WHERE owner_id=$1',[b]);assert.equal(renewed.allowance,29);assert.equal(renewed.used,17);assert.equal(renewed.reserved,2);assert.equal(renewed.expires_at.getTime(),expiry+30*86400000);
 });
 await check('expired pending session remains auditable and cannot be replaced',async()=>{
  const c=await user('expired');await resetBalance(c);const order=await purchase(c);
  await sql("UPDATE payment_order SET session_expires_at=now()-interval '1 second' WHERE id=$1",[order.orderId]);
  await reject(purchase(c),'checkout_expired');assert.equal((await payments.order(c,order.orderId)).order.status,'pending');
 });
 await check('unsafe redirects and live session references never become stored checkout destinations',async()=>{
  const c=await user('redirect');await resetBalance(c);const eventId=randomUUID();
  for(const bad of ['https://evil.invalid/','https://checkout.stripe.com.evil.invalid/',origin+'/app/#/checkout?order='+randomUUID(),origin.replace('://','://injected@')+'/app/#/checkout?order='+randomUUID()]) {
   const unsafe=createPostgresPayments({pool:db.payments,provider:{...provider,createCheckoutSession:async args=>({url:bad,providerSessionId:'cs_test_'+args.orderId.replaceAll('-',''),expiresAt:new Date(Date.now()+3600000).toISOString()})},publicOrigin:origin});
   await reject(unsafe.checkout(c,{examId:TELC,market:'DE',eventId}),'provider_unavailable');
  }
  const unsafe=createPostgresPayments({pool:db.payments,provider:{...provider,createCheckoutSession:async args=>({url:`${origin}/app/#/checkout?order=${args.orderId}`,providerSessionId:'cs_live_forbidden',expiresAt:new Date(Date.now()+3600000).toISOString()})},publicOrigin:origin});
  await reject(unsafe.checkout(c,{examId:TELC,market:'DE',eventId}),'provider_unavailable');
  const stored=await one('SELECT * FROM payment_order WHERE owner_id=$1',[c]);assert.equal(stored.checkout_url,null);assert.equal(stored.provider_ref,null);
  assert.equal((await purchase(c,eventId)).orderId,stored.id);
 });
 await check('real explicit stub verifies exact signed provider bytes before normalizing and granting',async()=>{
  const c=await user('signed');await resetBalance(c);
  const stub=createPaymentsPort({mode:'stub',publicOrigin:origin,webhookSecret:'whsec_synthetic_payments_pg_only'});
  const actual=createPostgresPayments({pool:db.payments,provider:stub,publicOrigin:origin});
  const checkout=await actual.checkout(c,{examId:TELC,market:'DE',eventId:randomUUID()});
  const stored=await one('SELECT * FROM payment_order WHERE id=$1',[checkout.orderId]);
  const raw=Buffer.from(JSON.stringify({id:'evt_'+randomUUID().replaceAll('-',''),type:'checkout.session.completed',livemode:false,data:{object:{object:'checkout.session',id:stored.provider_ref,livemode:false,
   client_reference_id:stored.id,metadata:{order_id:stored.id},payment_intent:'pi_'+stored.id.replaceAll('-',''),amount_total:1000,currency:'eur',payment_status:'paid'}}}));
  const signature=stub.signForTest(raw);await reject(actual.webhook(Buffer.concat([raw,Buffer.from(' ')]),signature),'invalid_webhook');
  await actual.webhook(raw,signature);assert.equal((await actual.order(c,stored.id)).order.status,'paid');
  const before=await one('SELECT * FROM entitlements WHERE owner_id=$1',[c]);await actual.webhook(raw,signature);assert.deepEqual(await one('SELECT * FROM entitlements WHERE owner_id=$1',[c]),before);
 });
 await check('signed irrelevant events have durable receipts while malformed known events remain refused',async()=>{
  const secret='whsec_synthetic_event_classification';
  const actual=createPostgresPayments({pool:db.payments,provider:createPaymentsPort({mode:'stub',webhookSecret:secret,publicOrigin:origin}),publicOrigin:origin});
  const suffix=randomUUID().replaceAll('-','');
  const deliver=event=>{const raw=Buffer.from(JSON.stringify(event));return actual.webhook(raw,buildSignatureHeader({rawBody:raw,secret,timestamp:Math.floor(Date.now()/1000)}));};
  const ignored={id:'evt_irrelevant_'+suffix,type:'customer.created',livemode:false,data:{object:{object:'customer',id:'cus_synthetic'}}};
  const grantsBefore=(await one('SELECT count(*)::int AS n FROM payment_grant')).n;
  await deliver(ignored);await deliver(ignored);
  const receipt=await one('SELECT owner_id,order_id,kind,disposition FROM payment_event WHERE id=$1',[ignored.id]);
  assert.equal(receipt.owner_id,null);assert.equal(receipt.order_id,null);assert.equal(receipt.kind,'ignored');assert.match(receipt.disposition,/^ignore:/);
  const malformed={...ignored,id:'evt_malformed_'+suffix,type:'checkout.session.completed'};
  await assert.rejects(deliver(malformed),error=>error.status===400&&error.code==='invalid_webhook');
  assert.equal(await one('SELECT id FROM payment_event WHERE id=$1',[malformed.id]),undefined);
  assert.equal((await one('SELECT count(*)::int AS n FROM payment_grant')).n,grantsBefore);
 });
 await check('signed HTTP du_ dispute retries before intent binding, then records once without changing credits',async()=>{
  const c=await user('dispute');
  await sql("UPDATE entitlements SET allowance=50,used=7,reserved=2,expires_at=now()-interval '1 second' WHERE owner_id=$1",[c]);
  const webhookSecret='whsec_synthetic_dispute_pg_only';let providerRequests=0;
  const stripe=createPaymentsPort({mode:'stripe-test',publicOrigin:origin,webhookSecret,secretKey:'sk_test_offlineFixture',
   fetchImpl:async(url,options)=>{
    providerRequests++;assert.equal(url,'https://api.stripe.com/v1/checkout/sessions');assert.equal(options.method,'POST');
    const form=new URLSearchParams(options.body),id=form.get('client_reference_id');
    assert.equal(form.get('metadata[owner_id]'),c);assert.equal(form.get('line_items[0][price]'),'price_synthetic');
    assert.equal(options.headers['Idempotency-Key'],'hatoove-checkout-'+id);
    return new Response(JSON.stringify({id:'cs_test_'+id.replaceAll('-',''),object:'checkout.session',mode:'payment',
     livemode:false,client_reference_id:id,metadata:{order_id:id},amount_total:1000,currency:'eur',
     status:'open',payment_status:'unpaid',expires_at:Math.floor(Date.now()/1000)+1800,
     url:'https://checkout.stripe.com/c/pay/cs_test_'+id.replaceAll('-','')}),{status:200});
   }});
  const sign=rawBody=>buildSignatureHeader({rawBody,secret:webhookSecret,timestamp:Math.floor(Date.now()/1000)});
  const actual=createPostgresPayments({pool:db.payments,provider:stripe,publicOrigin:origin});
  const checkout=await actual.checkout(c,{examId:TELC,market:'DE',eventId:randomUUID()});
  const stored=await one('SELECT * FROM payment_order WHERE id=$1',[checkout.orderId]);
  const intent='pi_'+stored.id.replaceAll('-',''),suffix=randomUUID().replaceAll('-','');
  // Stripe's dispute object has a du_ identity and maps to its order through payment_intent.
  // Metadata deliberately carries no order id; a dispute/charge reference is not a session reference.
  const dispute={id:'evt_dispute_'+suffix,object:'event',type:'charge.dispute.created',livemode:false,
   data:{object:{id:'du_'+suffix,object:'dispute',amount:1000,currency:'eur',livemode:false,
    charge:'ch_'+suffix,payment_intent:intent,status:'needs_response',metadata:{}}}};
  const success={id:'evt_success_'+suffix,object:'event',type:'checkout.session.completed',livemode:false,
   data:{object:{id:stored.provider_ref,object:'checkout.session',livemode:false,client_reference_id:stored.id,
    metadata:{order_id:stored.id},payment_intent:intent,amount_total:1000,currency:'eur',payment_status:'paid'}}};
  const disputeRaw=Buffer.from(' '+JSON.stringify(dispute)+'\n'),disputeSignature=sign(disputeRaw);
  const temp=await mkdtemp(path.join(os.tmpdir(),'hatoove-dispute-http-'));
  process.env.B1PREP_ENV_FILE=path.join(temp,'absent.env');process.env.B1PREP_PROGRESS_FILE=path.join(temp,'absent.json');
  delete process.env.B1PREP_ACCOUNTS;
  const {createServer}=await import('../server.js');
  const api=createOwnedApi({datastore:world.store.port,sessions:world.sessions,payments:actual});
  const server=createServer({ownedApi:api});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const endpoint=`http://127.0.0.1:${server.address().port}/api/v1/payments/stripe/webhook`;
  const post=async(raw,signature=sign(raw))=>{
   const response=await fetch(endpoint,{method:'POST',headers:{origin:'https://foreign.invalid','stripe-signature':signature},body:raw});
   return {status:response.status,body:await response.json()};
  };
  try {
   const before=await one('SELECT * FROM entitlements WHERE owner_id=$1',[c]);
   const unknown=await post(disputeRaw,disputeSignature);assert.equal(unknown.status,503);assert.equal(unknown.body.error,'payment_binding_pending');
   assert.equal(await one('SELECT id FROM payment_event WHERE id=$1',[dispute.id]),undefined);
   assert.equal((await actual.order(c,stored.id)).order.status,'pending');
   assert.deepEqual(await one('SELECT * FROM entitlements WHERE owner_id=$1',[c]),before);
   assert.equal((await post(Buffer.from(JSON.stringify(success)))).status,200);
   const granted=await one('SELECT * FROM entitlements WHERE owner_id=$1',[c]);
   assert.equal(granted.allowance,19);assert.equal(granted.used,7);assert.equal(granted.reserved,2);assert.ok(granted.expires_at>Date.now());
   assert.equal((await actual.order(c,stored.id)).order.status,'paid');
   const grant=await one('SELECT * FROM payment_grant WHERE order_id=$1',[stored.id]);assert.ok(grant);
   assert.equal((await post(disputeRaw,disputeSignature)).status,200);
   const settled=await actual.order(c,stored.id);assert.equal(settled.order.status,'disputed');assert.ok(settled.order.paidAt);
   const receipt=await one('SELECT * FROM payment_event WHERE id=$1',[dispute.id]);
   assert.equal(receipt.order_id,stored.id);assert.equal(receipt.owner_id,c);assert.equal(receipt.disposition,'dispute:provider_dispute');
   assert.deepEqual(await one('SELECT * FROM entitlements WHERE owner_id=$1',[c]),granted);
   assert.deepEqual(await one('SELECT * FROM payment_grant WHERE order_id=$1',[stored.id]),grant);
   // Same event replay and a different successful event for the disputed session cannot grant again.
   assert.equal((await post(disputeRaw,disputeSignature)).status,200);
   assert.deepEqual(await one('SELECT * FROM payment_event WHERE id=$1',[dispute.id]),receipt);
   assert.equal((await post(Buffer.from(JSON.stringify({...success,id:'evt_late_'+suffix})))).status,200);
   assert.equal((await actual.order(c,stored.id)).order.status,'disputed');
   assert.equal((await one('SELECT count(*)::int AS n FROM payment_grant WHERE order_id=$1',[stored.id])).n,1);
   assert.deepEqual(await one('SELECT * FROM entitlements WHERE owner_id=$1',[c]),granted);
   // An invented dp_ prefix must fail during authenticated normalization, before any receipt exists.
   const invented={...dispute,id:'evt_invented_'+suffix,data:{object:{...dispute.data.object,id:'dp_'+suffix}}};
   const refused=await post(Buffer.from(JSON.stringify(invented)));assert.equal(refused.status,400);assert.equal(refused.body.error,'invalid_webhook');
   assert.equal(await one('SELECT id FROM payment_event WHERE id=$1',[invented.id]),undefined);
   assert.equal((await actual.order(c,stored.id)).order.status,'disputed');
   assert.deepEqual(await one('SELECT * FROM entitlements WHERE owner_id=$1',[c]),granted);
   assert.equal(providerRequests,1,'all adapter transport was injected; webhook handling makes no provider request');
  } finally {await new Promise(resolve=>server.close(resolve));await rm(temp,{recursive:true,force:true});}
 });
 await check('expiry blocks submit/retry while reserved completion and history remain valid',async()=>{
  const c=await user('writing'),port=world.store.port,prep=(await port.listPreparations(c))[0];
  await sql(`INSERT INTO content_rights(content_version_id,basis,decided_by,note)
    SELECT content_version_id,'generated','payments synthetic check','Disposable fixture only' FROM content_version v
    WHERE family='writing' AND NOT EXISTS(SELECT 1 FROM content_rights r WHERE r.content_version_id=v.content_version_id)`);
  const draft=await port.create(c,null,null,prep.id);await port.save(c,draft.id,1,'Synthetic saved learner letter.');
  const sub=await port.submit(c,draft.id,2,randomUUID());
  const worker=createWorker({pool:db.worker,grade:async input=>{
   await sql("UPDATE entitlements SET expires_at=now()-interval '1 second' WHERE owner_id=$1",[c]);
   return stubGrade(input);
  }});
  assert.equal((await worker.runOnce()).outcome,'succeeded');
  assert.equal((await port.readCredits(c,prep.id)).available,0);assert.ok((await port.result(c,sub.submissionId)).assessment);
  const next=await port.create(c,null,null,prep.id);await port.save(c,next.id,1,'A second saved letter.');
  await reject(port.submit(c,next.id,2,randomUUID()),'allowance_exhausted');
  await sql('UPDATE entitlements SET expires_at=NULL WHERE owner_id=$1',[c]);const failed=await port.submit(c,next.id,2,randomUUID());await world.store.worker.claim(failed.submissionId);await world.store.worker.fail(failed.submissionId,'provider_unavailable');
  await sql("UPDATE entitlements SET expires_at=now()-interval '1 second' WHERE owner_id=$1",[c]);await reject(port.retry(c,failed.submissionId),'allowance_exhausted');
 });
 await check('expired mock writing preserves frozen submission without reserving a job',async()=>{
  await importPackage(db.migration,syntheticS4Package(),{publisher:'synthetic-payments-check'});
  const c=await user('mock'),port=world.store.port,prep=(await port.createPreparation(c,DTZ)).preparation;
  await sql("INSERT INTO entitlements(owner_id,exam_id,allowance,used,reserved,expires_at) VALUES($1,$2,10,0,0,now()-interval '1 second')",[c,DTZ]);
  let run=(await port.startMockRun(c,{preparationId:prep.id,formId:'s4-writing',formVersion:'v1',releaseVersion:'v8100',eventId:randomUUID()})).run;
  run=await port.selectMockWriting(c,run.id,{expectedRevision:run.revision,eventId:randomUUID(),choiceGroupId:'SA1',optionId:'A'});
  const draft=await port.save(c,run.writing.attempt_id,1,'Synthetic expired mock letter.');
  run=await port.finaliseMockRun(c,run.id,{expectedRevision:run.revision,eventId:randomUUID(),expectedWritingRevision:draft.revision,explanationLanguage:'de'});
  assert.equal(run.writing.failure_code,'allowance_exhausted');assert.equal(run.writing.assessment_state,'unassessed');
  assert.equal((await one('SELECT count(*)::int AS n FROM jobs WHERE owner_id=$1',[c])).n,0);
 });
 await check('export includes owned payments; atomic deletion prevents late grant resurrection',async()=>{
  const data=await world.store.port.exportData(a);assert.equal(data.payment_orders.length,1);assert.equal(data.payment_grants.length,1);assert.ok(data.payment_events.length>=1);assert.ok(data.payment_checkout_events.length>=2);assert.ok(!JSON.stringify(data.payment_orders).includes('provider_ref'));
  const c=await user('delete');await resetBalance(c);const order=await purchase(c),event=await eventFor(order.orderId);
  const failing=createPostgresAccountDeletion({pool:db.deletion,afterStep:(_n,name)=>{if(name==='payment_order')throw Error('synthetic delete rollback');}});
  await assert.rejects(failing.deleteAccount(c));assert.equal((await payments.order(c,order.orderId)).order.status,'pending');
  const deletion=await world.deletion.deleteAccount(c);assert.equal(deletion.verifiedAbsent,true);
  await send(event);assert.equal((await one('SELECT count(*)::int AS n FROM entitlements WHERE owner_id=$1',[c])).n,0);
  assert.equal((await one('SELECT count(*)::int AS n FROM payment_grant WHERE owner_id=$1',[c])).n,0);await reject(payments.order(c,order.orderId),'not_found');
 });
 await check('deletion waits for an in-flight atomic grant and removes its committed ledger',async()=>{
  const c=await user('delete-race');await resetBalance(c);const order=await purchase(c),event=await eventFor(order.orderId);
  let release,reached;const held=new Promise(resolve=>{release=resolve;}),entered=new Promise(resolve=>{reached=resolve;});
  let winnerPid;
  const heldPort=createPostgresPayments({pool:db.payments,provider,publicOrigin:origin,afterGrant:async(client)=>{winnerPid=(await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;reached();await held;}});
  const pending=send(event,heldPort);await entered;const deletion=world.deletion.deleteAccount(c);
  try {
   let waiting=0;const deadline=Date.now()+5000;
   while(Date.now()<deadline){waiting=(await one(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE application_name=$1
     AND $2::int=ANY(pg_blocking_pids(pid)) AND wait_event_type='Lock'`,[db.schema,winnerPid])).n;
    if(waiting>0)break;await new Promise(resolve=>setTimeout(resolve,10));}
   assert.ok(waiting>0,'deletion is blocked by the actual granting transaction');
  } finally {release();await pending;await deletion;}
  assert.equal((await one('SELECT count(*)::int AS n FROM payment_order WHERE owner_id=$1',[c])).n,0);
  assert.equal((await one('SELECT count(*)::int AS n FROM payment_grant WHERE owner_id=$1',[c])).n,0);
  await send({...event,id:'evt_'+randomUUID().replaceAll('-','')});assert.equal((await one('SELECT count(*)::int AS n FROM entitlements WHERE owner_id=$1',[c])).n,0);
 });
 console.log(`payments-pg-check: ${passed}/${passed} passed`);
} finally { await db.cleanup(); }

/** Complete DTZ payment admission, using disposable PostgreSQL and an injected provider with no network. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createFixture } from '../server/owned-postgres/bootstrap.mjs';
import { createPostgresWorld } from '../server/owned-postgres/fixture.mjs';
import { createPostgresPayments } from '../server/owned-postgres/payments.mjs';
import { createExamCatalogue } from '../server/preparation-contract.mjs';
import { importPackage } from '../server/owned-postgres/package-importer.mjs';
import { syntheticS4Package } from './exam-s4-check.mjs';
import { publishCompleteDtzFixture, syntheticContentReview } from './exam-s6-fixture.mjs';

if (process.env.OWNAPI_PG_ALLOW !== '1' || !process.env.OWNAPI_PG_PORT || [4300,55440].includes(Number(process.env.OWNAPI_PG_PORT))) {
  throw Error('Explicit disposable OWNAPI_PG_ALLOW=1 and OWNAPI_PG_PORT required; learner ports forbidden');
}
const savedEnv = Object.fromEntries(['B1PREP_CONTENT_MODE','B1PREP_SERVE_REVIEW','B1PREP_SERVE_RIGHTS'].map(key => [key,process.env[key]]));
const TELC = 'telc-deutsch-b1', DTZ = 'dtz-a2-b1', origin = 'https://synthetic.invalid';
const catalogue = createExamCatalogue({ enabled: [TELC,DTZ] });
let db, world, mediaRoot, passed = 0, failure;
const providerCalls = [];
let uncertain = false;
let version = 9620;
const nextVersion = () => 'v' + version++;
const complete = () => publishCompleteDtzFixture(db,{mediaRoot,version:nextVersion(),availableVersion:nextVersion()});
const provider = { configured: true, mode: 'stub',
  async createCheckoutSession(input) {
    providerCalls.push(input);
    if (uncertain) throw Error('Synthetic uncertain provider response');
    return { providerSessionId: 'cs_test_' + input.orderId.replaceAll('-',''),
      url: `${origin}/app/#/checkout?order=${input.orderId}&checkout=stub`, expiresAt: new Date(Date.now()+3600000).toISOString() };
  },
  async verifyWebhook({rawBody,signatureHeader}) { assert.equal(signatureHeader,'synthetic'); return JSON.parse(rawBody.toString('utf8')); },
  readEvent: event => event,
};
const check = async (name, work) => { await work(); passed++; console.log('PASS ' + name); };
const reject = (promise, code = 'not_found', status = 404) => assert.rejects(promise,error => error.code === code && error.status === status);
const sql = (query,params=[]) => db.admin.query(query,params);
const one = async (query,params=[]) => (await sql(query,params)).rows[0];
const payment = (options={}) => createPostgresPayments({pool:db.payments,provider,publicOrigin:origin,examCatalogue:catalogue,...options});
const checkout = (port,owner,extra={}) => port.checkout(owner,{examId:DTZ,market:'DE',eventId:randomUUID(),...extra});
async function owner(tag) {
  const signed = await world.sessions.signUp({name:'Synthetic S6 payment '+tag,email:`s6-payments-${tag}-${randomUUID()}@example.invalid`,password:'synthetic-s6-password'});
  const id = (await world.sessions.getSession({cookie:String(signed.setCookie).split(';')[0]})).userId;
  await sql('UPDATE entitlements SET used=allowance WHERE owner_id=$1',[id]);
  return id;
}
async function unchangedAfterRefusal(port, id, options={}) {
  const before = await one(`SELECT (SELECT count(*)::int FROM payment_order WHERE owner_id=$1) AS orders,
    (SELECT count(*)::int FROM payment_checkout_event WHERE owner_id=$1) AS receipts`,[id]);
  const calls = providerCalls.length;
  await reject(port.offer(id,{examId:DTZ,...options}));
  await reject(port.offer(id,{examId:DTZ,market:'DE',...options}));
  await reject(checkout(port,id,options));
  assert.deepEqual(await one(`SELECT (SELECT count(*)::int FROM payment_order WHERE owner_id=$1) AS orders,
    (SELECT count(*)::int FROM payment_checkout_event WHERE owner_id=$1) AS receipts`,[id]),before);
  assert.equal(providerCalls.length,calls);
}
const gate = () => { let open; const ready = new Promise(resolve => { open=resolve; }); return {ready,open}; };
async function bounded(promise,label) {
  let timer;
  try { return await Promise.race([promise,new Promise((_,reject) => { timer=setTimeout(() => reject(Error('Timed out: '+label)),8000); })]); }
  finally { clearTimeout(timer); }
}
function pausedPayment(matches) {
  const reached=gate(),resume=gate(); let pid=null,paused=false;
  return {reached:reached.ready,resume:resume.open,get pid(){return pid;},pool:{
    async connect() {
      const client=await db.payments.connect(); pid=client.processID;
      return {release:()=>client.release(),async query(query,params) {
        if (!paused && matches(query)) { paused=true; reached.open(); await bounded(resume.ready,'release payment barrier'); }
        const result=await client.query(query,params);
        if (query==='BEGIN') await client.query("SET LOCAL lock_timeout='6s'; SET LOCAL statement_timeout='8s'");
        return result;
      }};
    },
  }};
}
async function advisoryWait(waiter,blocker) {
  assert.notEqual(waiter,blocker);
  const deadline=Date.now()+4000;
  while (Date.now()<deadline) {
    const row=await one(`SELECT $2::integer=ANY(pg_blocking_pids($1)) AS blocked,
      EXISTS(SELECT 1 FROM pg_locks WHERE pid=$1 AND locktype='advisory' AND NOT granted) AS advisory`,[waiter,blocker]);
    if (row.blocked && row.advisory) return;
    await new Promise(resolve => setTimeout(resolve,20));
  }
  assert.fail('Expected actual separate-connection advisory wait');
}
async function simulatedReviewLoss(contentId) {
  const client=await db.migration.connect();
  try {
    await client.query('BEGIN');
    const row=(await client.query('SELECT exam_id,content_sha256 FROM content_version WHERE content_version_id=$1',[contentId])).rows[0];
    assert.ok(row);
    await syntheticContentReview(db,client,{kind:'content',examId:row.exam_id,subjectId:contentId,version:'',sha256:row.content_sha256},{decision:'withdraw'});
    await client.query('COMMIT');
  } catch(error) { await client.query('ROLLBACK');throw error; } finally { client.release(); }
}
const withdrawalSql="INSERT INTO content_rights(content_version_id,basis,decided_by,note) VALUES($1,'unknown','synthetic S6 payments','Synthetic negative rights decision; no human approval')";
async function paidEvent(orderId) {
  const order=await one('SELECT * FROM payment_order WHERE id=$1',[orderId]);
  return {id:'evt_'+randomUUID().replaceAll('-',''),type:'checkout.session.completed',kind:'paid',orderId,
    providerRef:order.provider_ref,paymentIntentRef:'pi_'+orderId.replaceAll('-',''),amountMinor:order.amount_minor,
    currency:order.currency,paymentStatus:'paid',livemode:false};
}

try {
  process.env.B1PREP_CONTENT_MODE='internal-preview'; delete process.env.B1PREP_SERVE_REVIEW; delete process.env.B1PREP_SERVE_RIGHTS;
  mediaRoot=await mkdtemp(path.join(os.tmpdir(),'hatoove-s6-payments-'));
  db=await createFixture();
  world=await createPostgresWorld({fixture:db,examCatalogue:catalogue});
  await importPackage(db.migration,syntheticS4Package(),{publisher:'synthetic-s6-payments-partial'});
  for (const [id,exam] of [['synthetic-telc',TELC],['synthetic-dtz',DTZ]]) {
    await sql('INSERT INTO payment_product VALUES($1,$2,10,30,true)',[id,exam]);
    await sql("INSERT INTO payment_price VALUES($1,'DE','EUR',1000,'Synthetic EUR 10',$2,true),($1,'US','USD',1200,'Synthetic USD 12',$3,true)",[id,'price_'+id,'price_us_'+id]);
  }
  const payments=payment();
  await check('default telc-only catalogue preserves telc terms and hides DTZ offers and new orders',async()=>{
    const id=await owner('default'),defaults=payment({examCatalogue:createExamCatalogue()});
    const offer=await defaults.offer(id,{examId:TELC,market:'DE'});
    assert.equal(offer.offer.amountMinor,1000);assert.equal(offer.offer.currency,'EUR');assert.equal(offer.offer.allowance,10);
    await defaults.checkout(id,{examId:TELC,market:'DE',eventId:randomUUID()});
    await unchangedAfterRefusal(defaults,id);
  });
  await check('internal partial DTZ remains explicitly available and preserves market selection',async()=>{
    const id=await owner('partial-internal');
    assert.equal((await payments.offer(id,{examId:DTZ})).markets.length,2);
    assert.equal((await payments.offer(id,{examId:DTZ,market:'DE'})).offer.examId,DTZ);
    await reject(payments.offer(id,{examId:DTZ,market:'ZZ'}));
    const result=await checkout(payments,id);assert.ok(result.orderId);
  });
  await check('public partial DTZ refuses markets, offers and new order without receipts or provider calls',async()=>{
    process.env.B1PREP_CONTENT_MODE='public';
    await unchangedAfterRefusal(payments,await owner('partial-public'));
  });

  await check('complete public synthetic DTZ admits offers and one order with server-owned commercial terms',async()=>{
    await complete();const id=await owner('complete');
    const offer=await payments.offer(id,{examId:DTZ,market:'DE'});
    assert.deepEqual(offer.markets,[{market:'DE',currency:'EUR'},{market:'US',currency:'USD'}]);
    assert.equal(offer.offer.purchasable,true);assert.equal(offer.offer.amountMinor,1000);assert.equal(offer.offer.allowance,10);
    const result=await checkout(payments,id,{amountMinor:1,currency:'USD',allowance:999});
    const row=await one('SELECT * FROM payment_order WHERE id=$1',[result.orderId]);
    assert.equal(row.amount_minor,1000);assert.equal(row.currency,'EUR');assert.equal(row.allowance,10);
    assert.equal(providerCalls.at(-1).price.stripePriceId,'price_synthetic-dtz');
  });
  await check('withdrawn, self-blocked and structurally incomplete available heads refuse every new payment admission',async()=>{
    const id=await owner('head-negative');
    for (const state of ['withdrawn','self-blocked','incomplete']) {
      const full=await complete();
      assert.equal((await payments.offer(id,{examId:DTZ,market:'DE'})).offer.purchasable,true);
      if (state==='incomplete') {
        const client=await db.admin.connect();
        try {
          await client.query('BEGIN');await client.query('SET LOCAL session_replication_role=replica');
          await client.query('DELETE FROM exam_release_form WHERE exam_id=$1 AND release_version=$2',[DTZ,full.releaseVersion]);
          await client.query('COMMIT');
        } catch(error) { await client.query('ROLLBACK');throw error; } finally { client.release(); }
      } else {
        const releaseVersion=nextVersion(),published=structuredClone(full.published);
        published.release={version:releaseVersion,state:state==='withdrawn'?'withdrawn':'available',resumeBlockedReleases:state==='self-blocked'?[releaseVersion]:[]};
        await importPackage(db.migration,published,{mediaRoot});
      }
      await unchangedAfterRefusal(payments,id);
    }
  });
  for (const kind of ['writing-A','writing-B','reading','media','rubric']) {
    await check(`${kind} review or rights loss closes offers and new checkout without side effects`,async()=>{
      const id=await owner(kind);
      for (const loss of ['review','rights']) {
        const full=await complete(),source=kind==='writing-A'?full.internal.writingTasks[0]
          :kind==='writing-B'?full.internal.writingTasks[1]:kind==='reading'?full.internal.sets.find(set=>set.family==='LV1')
          :kind==='media'?full.internal.media[0]:full.internal.rubrics[0];
        const contentId=(source.taskId??source.setId??source.mediaId??source.rubricId)+'@'+source.version;
        assert.ok(full.contentIds.includes(contentId));
        assert.equal((await payments.offer(id,{examId:DTZ,market:'DE'})).offer.purchasable,true);
        if(loss==='review')await simulatedReviewLoss(contentId);else await db.migration.query(withdrawalSql,[contentId]);
        await unchangedAfterRefusal(payments,id);
      }
    });
  }
  await check('configured rights narrowing and invalid content mode cannot be widened by checkout fields',async()=>{
    await complete();const id=await owner('policy');
    for(const rights of ['licensed','unknown','']) {
      process.env.B1PREP_SERVE_RIGHTS=rights;
      await unchangedAfterRefusal(payments,id,{allowedRights:['generated'],mode:'internal-preview',approved:true});
    }
    delete process.env.B1PREP_SERVE_RIGHTS;process.env.B1PREP_CONTENT_MODE='invalid';
    await unchangedAfterRefusal(payments,id,{mode:'public',approved:true});
    process.env.B1PREP_CONTENT_MODE='public';
    assert.equal((await payments.offer(id,{examId:DTZ,market:'DE'})).offer.purchasable,true);
  });
  await check('withdrawal preserves exact receipts, pending retries, order history and exactly one webhook grant',async()=>{
    const full=await complete(),id=await owner('continuation'),eventId=randomUUID();
    uncertain=true;await reject(checkout(payments,id,{eventId}),'provider_unavailable',502);uncertain=false;
    const before=await one('SELECT * FROM payment_order WHERE owner_id=$1',[id]);
    assert.equal(before.provider_ref,null);
    await db.migration.query(withdrawalSql,[full.internal.media[0].mediaId+'@'+full.internal.media[0].version]);
    await reject(payments.offer(id,{examId:DTZ,market:'DE'}));
    const exact=await checkout(payments,id,{eventId}),again=await checkout(payments,id);
    assert.equal(exact.orderId,before.id);assert.equal(again.orderId,before.id);
    const row=await one('SELECT * FROM payment_order WHERE id=$1',[before.id]);
    for(const key of ['owner_id','exam_id','product_id','market','currency','amount_minor','allowance','term_days','stripe_price_id','created_at'])assert.deepEqual(row[key],before[key]);
    assert.equal((await one('SELECT count(*)::int AS n FROM payment_order WHERE owner_id=$1',[id])).n,1);
    assert.equal((await one('SELECT count(*)::int AS n FROM payment_grant WHERE owner_id=$1',[id])).n,0);
    await reject(checkout(payments,id,{eventId,market:'US'}),'event_conflict',409);
    await reject(checkout(payments,id,{eventId,examId:TELC}),'event_conflict',409);
    await reject(checkout(payments,id,{market:'US'}),'checkout_pending',409);
    await sql("UPDATE payment_price SET amount_minor=1001 WHERE product_id='synthetic-dtz' AND market='DE'");
    try {await reject(checkout(payments,id),'checkout_pending',409);} finally {await sql("UPDATE payment_price SET amount_minor=1000 WHERE product_id='synthetic-dtz' AND market='DE'");}
    await sql("UPDATE payment_product SET allowance=11 WHERE id='synthetic-dtz'");
    try {await reject(checkout(payments,id),'checkout_pending',409);} finally {await sql("UPDATE payment_product SET allowance=10 WHERE id='synthetic-dtz'");}
    await sql("INSERT INTO payment_product VALUES('synthetic-dtz-alternate',$1,10,30,true)",[DTZ]);
    await sql("INSERT INTO payment_price VALUES('synthetic-dtz-alternate','DE','EUR',1000,'Synthetic alternate','price_alternate',true)");
    await sql("UPDATE payment_product SET active=false WHERE id='synthetic-dtz'");
    try {await reject(checkout(payments,id),'checkout_pending',409);} finally {await sql("UPDATE payment_product SET active=false WHERE id='synthetic-dtz-alternate'");await sql("UPDATE payment_product SET active=true WHERE id='synthetic-dtz'");}
    const oldBalance=await one('SELECT * FROM entitlements WHERE owner_id=$1 AND exam_id=$2',[id,TELC]);
    const historical=payment({examCatalogue:createExamCatalogue()});
    assert.equal((await checkout(historical,id,{eventId})).orderId,before.id);
    assert.equal((await historical.order(id,before.id)).order.status,'pending');
    const event=await paidEvent(before.id),raw=Buffer.from(JSON.stringify(event));
    await historical.webhook(raw,'synthetic');await historical.webhook(raw,'synthetic');
    assert.equal((await historical.order(id,before.id)).order.status,'paid');
    assert.equal((await checkout(historical,id,{eventId})).status,'paid');
    assert.equal((await one('SELECT count(*)::int AS n FROM payment_grant WHERE order_id=$1',[before.id])).n,1);
    assert.deepEqual(await one('SELECT * FROM entitlements WHERE owner_id=$1 AND exam_id=$2',[id,TELC]),oldBalance);
    assert.equal((await one('SELECT allowance FROM entitlements WHERE owner_id=$1 AND exam_id=$2',[id,DTZ])).allowance,10);
    const foreign=await owner('post-withdrawal');
    await unchangedAfterRefusal(payments,foreign);
    await reject(checkout(payments,foreign,{eventId}));await reject(payments.order(foreign,before.id));
    await complete();
    assert.equal((await payments.offer(id,{examId:DTZ,market:'DE'})).offer.purchasable,false);
    await reject(checkout(payments,id),'already_entitled',409);
  });
  await check('withdrawn pending checkout still applies its original session expiry without replacement',async()=>{
    const full=await complete(),id=await owner('expired'),eventId=randomUUID();
    const result=await checkout(payments,id,{eventId});
    await db.migration.query(withdrawalSql,[full.internal.media[0].mediaId+'@'+full.internal.media[0].version]);
    await sql("UPDATE payment_order SET session_expires_at=now()-interval '1 second' WHERE id=$1",[result.orderId]);
    const calls=providerCalls.length;
    await reject(checkout(payments,id,{eventId}),'checkout_expired',409);
    await reject(checkout(payments,id),'checkout_expired',409);
    assert.equal(providerCalls.length,calls);
    assert.equal((await payments.order(id,result.orderId)).order.status,'pending');
    assert.equal((await one('SELECT count(*)::int AS n FROM payment_order WHERE owner_id=$1',[id])).n,1);
  });
  await check('payment role gets minimal eligibility results without content reads or mutations',async()=>{
    await complete();
    const result=(await db.payments.query('SELECT * FROM current_release_eligibility($1,$2::text[])',[DTZ,['generated']])).rows[0];
    assert.equal(result.eligible,true);
    assert.ok(!JSON.stringify(result).includes('content/exams/'));
    assert.deepEqual(Object.keys(result).filter(key=>/payload|answers|transcript|path/i.test(key)),[]);
    for(const table of ['content_version','content_rights','exam_release','exam_release_head','exam_blueprint','exam_form','exam_form_member','objective_set','objective_key','task_version','rubric_version','exam_media']) {
      await assert.rejects(db.payments.query(`SELECT * FROM ${table} LIMIT 1`),error=>error.code==='42501',table+' must remain private to payments');
      assert.equal((await one("SELECT has_any_column_privilege($1,$2,'SELECT') AS allowed",[db.roles.payments,db.schema+'.'+table])).allowed,false);
      for(const privilege of ['INSERT','UPDATE','DELETE'])assert.equal((await one('SELECT has_table_privilege($1,$2,$3) AS allowed',[db.roles.payments,db.schema+'.'+table,privilege])).allowed,false);
    }
  });
  await check('payment-first rights withdrawal waits for the admitted order commit on a separate connection',async()=>{
    const full=await complete(),id=await owner('payment-first'),paused=pausedPayment(query=>query.startsWith('INSERT INTO payment_order'));
    const contentId=full.internal.media[0].mediaId+'@'+full.internal.media[0].version;
    let rights,operation,insertion;
    try {
      rights=await db.migration.connect();await rights.query('BEGIN');await rights.query("SET LOCAL lock_timeout='6s'; SET LOCAL statement_timeout='8s'");
      operation=checkout(payment({pool:paused.pool}),id);operation.catch(()=>{});
      await bounded(paused.reached,'payment before order INSERT');
      insertion=rights.query(withdrawalSql,[contentId]);insertion.catch(()=>{});
      await advisoryWait(rights.processID,paused.pid);
      assert.equal((await one('SELECT count(*)::int AS n FROM payment_order WHERE owner_id=$1',[id])).n,0);
      paused.resume();const order=await operation;await insertion;await rights.query('COMMIT');
      assert.equal((await one('SELECT count(*)::int AS n FROM payment_order WHERE owner_id=$1',[id])).n,1);
      assert.equal((await payments.order(id,order.orderId)).order.status,'pending');
      await reject(payments.offer(id,{examId:DTZ,market:'DE'}));
    } finally {
      paused.resume();if(rights){await rights.query('ROLLBACK').catch(()=>{});rights.release();}
      await Promise.allSettled([operation,insertion].filter(Boolean));
    }
  });
  await check('withdrawal-first payment waits, then rereads eligibility and creates no order or receipt',async()=>{
    const full=await complete(),id=await owner('rights-first'),paused=pausedPayment(query=>query.includes('7351'));
    const contentId=full.internal.media[0].mediaId+'@'+full.internal.media[0].version;
    let rights,operation;
    const calls=providerCalls.length;
    try {
      rights=await db.migration.connect();await rights.query('BEGIN');await rights.query("SET LOCAL lock_timeout='6s'; SET LOCAL statement_timeout='8s'");
      await rights.query(withdrawalSql,[contentId]);
      operation=checkout(payment({pool:paused.pool}),id);operation.catch(()=>{});
      await bounded(paused.reached,'payment exam gate');paused.resume();await advisoryWait(paused.pid,rights.processID);
      await rights.query('COMMIT');await reject(operation);
      assert.equal((await one('SELECT count(*)::int AS n FROM payment_order WHERE owner_id=$1',[id])).n,0);
      assert.equal((await one('SELECT count(*)::int AS n FROM payment_checkout_event WHERE owner_id=$1',[id])).n,0);
      assert.equal(providerCalls.length,calls);
    } finally {
      paused.resume();if(rights){await rights.query('ROLLBACK').catch(()=>{});rights.release();}
      await Promise.allSettled([operation].filter(Boolean));
    }
  });
  console.log(`${passed} passed, 0 failed`);
} catch (error) { failure=error; }
finally {
  const cleanupErrors=[];
  try { await db?.cleanup(); } catch(error) { cleanupErrors.push(error); }
  try { if(mediaRoot) await rm(mediaRoot,{recursive:true,force:true}); } catch(error) { cleanupErrors.push(error); }
  for(const [key,value] of Object.entries(savedEnv)) { if(value===undefined) delete process.env[key]; else process.env[key]=value; }
  if(!failure && cleanupErrors.length) failure=new AggregateError(cleanupErrors,'Synthetic payment fixture cleanup failed');
}
if(failure) throw failure;

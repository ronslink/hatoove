import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { localPool, migrateAuth } from './auth.mjs';
import { start } from './server.mjs';

const schema = `spike_${randomBytes(8).toString('hex')}`;
const pool = localPool(schema);
const secret = randomBytes(48).toString('base64url');
const feedback = {kind:'synthetic-formative',comment:'Saved fixture feedback; not an exam assessment.'};
let api;
async function request(path, {cookie, method='GET', body, origin}={}) {
  const res = await fetch(api.baseURL+path,{method,headers:{...(cookie?{cookie}:{}),
    ...(method!=='GET'?{'content-type':'application/json',origin:origin??api.baseURL}: {})},
    ...(method!=='GET'?{body:JSON.stringify(body??{})}:{})});
  return {status:res.status,body:await res.json(),cookies:res.headers.getSetCookie()};
}
async function account(email) {
  const data = {name:'Synthetic Learner',email,password:randomBytes(20).toString('hex')};
  const res = await request('/api/auth/sign-up/email',{method:'POST',body:data});
  assert.equal(res.status,200,JSON.stringify(res.body));
  const cookie = res.cookies.map(c=>c.split(';')[0]).join('; ');
  const me = await request('/api/v1/account',{cookie});
  assert.equal(me.status,200);
  await pool.query('INSERT INTO entitlements(owner_id,allowance) VALUES($1,10)',[me.body.id]);
  return {cookie,id:me.body.id,data};
}
async function draft(user,text='Guten Tag, dies ist ein synthetischer Entwurf.') {
  const a=await request('/api/v1/attempts',{cookie:user.cookie,method:'POST'});
  assert.equal(a.status,201);
  const saved=await request(`/api/v1/attempts/${a.body.id}`,{cookie:user.cookie,method:'PUT',body:{expectedRevision:1,text}});
  assert.equal(saved.status,200);
  return {...a.body,...saved.body};
}
const count = async table => Number((await pool.query(`SELECT count(*) FROM ${table}`)).rows[0].count);

test('local Better Auth and PostgreSQL contract 0.1.0',async t=>{
  await pool.query(`CREATE SCHEMA ${schema}`);
  try {
    const authSQL = await migrateAuth(pool);
    assert.equal(authSQL.trim(), (await readFile(new URL('./auth-schema.sql',import.meta.url),'utf8')).trim());
    assert.equal((await migrateAuth(pool)).trim(),';');
    await pool.query(await readFile(new URL('./schema.sql',import.meta.url),'utf8'));
    api=await start(pool,secret);
    let alice,bob,a,submission;
    await t.test('library auth schema, two accounts and public-route boundary',async()=>{
      const names=(await pool.query('SELECT table_name FROM information_schema.tables WHERE table_schema=$1',[schema])).rows.map(r=>r.table_name);
      for(const name of ['user','session','account','verification']) assert.ok(names.includes(name));
      alice=await account('alice@example.test'); bob=await account('bob@example.test');
      assert.equal((await request('/api/v1/account')).status,401);
      assert.equal((await request('/api/health')).status,200);
      assert.equal((await request('/api/progress',{cookie:alice.cookie})).status,404);
      assert.equal((await request('/api/v1/attempts',{cookie:alice.cookie,method:'POST',origin:'https://evil.example'})).status,403);
      assert.equal((await request('/api/auth/sign-out',{cookie:alice.cookie,method:'POST',origin:'null'})).status,403);
      const missingOrigin = await fetch(api.baseURL+'/api/v1/attempts',{method:'POST',headers:{cookie:alice.cookie,'content-type':'application/json'},body:'{}'});
      assert.equal(missingOrigin.status,403);
      assert.equal((await request('/api/v1/attempts',{cookie:alice.cookie,method:'POST',body:{ownerId:bob.id}})).status,422);
    });
    await t.test('owned drafts, two concurrent writes and UTF-8 text round trip',async()=>{
      a=await draft(alice,'Grüße! مرحبا');
      assert.equal((await request(`/api/v1/attempts/${a.id}`,{cookie:alice.cookie})).body.text,'Grüße! مرحبا');
      assert.equal((await request(`/api/v1/attempts/${a.id}`,{cookie:bob.cookie})).status,404);
      assert.equal((await request(`/api/v1/attempts/${a.id}`,{cookie:bob.cookie,method:'PUT',body:{expectedRevision:2,text:'stolen'}})).status,404);
      const results=await Promise.all(['first','second'].map(text=>request(`/api/v1/attempts/${a.id}`,{cookie:alice.cookie,method:'PUT',body:{expectedRevision:2,text}})));
      assert.deepEqual(results.map(r=>r.status).sort(),[200,409]);
      a=(await request(`/api/v1/attempts/${a.id}`,{cookie:alice.cookie})).body;
      assert.equal(a.revision,3);
    });
    await t.test('new session returns saved draft; logout revokes original session',async()=>{
      const login=await request('/api/auth/sign-in/email',{method:'POST',body:alice.data});
      assert.equal(login.status,200);
      const second=login.cookies.map(c=>c.split(';')[0]).join('; ');
      assert.equal((await request(`/api/v1/attempts/${a.id}`,{cookie:second})).body.text,a.text);
      assert.equal((await request('/api/auth/sign-out',{cookie:alice.cookie,method:'POST'})).status,200);
      assert.equal((await request('/api/v1/account',{cookie:alice.cookie})).status,401);
      alice.cookie=second;
    });
    await t.test('transaction rollback after enqueue failure preserves draft and allowance',async()=>{
      await pool.query(`CREATE FUNCTION reject_job() RETURNS trigger LANGUAGE plpgsql AS 'BEGIN RAISE EXCEPTION ''injected''; END';
        CREATE TRIGGER reject_job BEFORE INSERT ON jobs FOR EACH ROW EXECUTE FUNCTION reject_job()`);
      const result=await request(`/api/v1/attempts/${a.id}/submissions`,{cookie:alice.cookie,method:'POST',body:{expectedRevision:3,eventId:randomUUID()}});
      assert.equal(result.status,500); assert.equal(await count('submissions'),0); assert.equal(await count('jobs'),0);
      assert.equal((await pool.query('SELECT reserved FROM entitlements WHERE owner_id=$1',[alice.id])).rows[0].reserved,0);
      await pool.query('DROP TRIGGER reject_job ON jobs');
    });
    await t.test('concurrent submission replay, mismatch rejection and immutable revision lineage',async()=>{
      const eventId=randomUUID();
      const results=await Promise.all([1,2].map(()=>request(`/api/v1/attempts/${a.id}/submissions`,{cookie:alice.cookie,method:'POST',body:{expectedRevision:3,eventId}})));
      assert.deepEqual(results.map(r=>r.status),[202,202]);
      assert.equal(results[0].body.submissionId,results[1].body.submissionId); submission=results[0].body.submissionId;
      assert.equal(await count('submissions'),1); assert.equal(await count('jobs'),1);
      assert.equal((await request(`/api/v1/attempts/${a.id}/submissions`,{cookie:alice.cookie,method:'POST',body:{expectedRevision:2,eventId}})).status,409);
      assert.equal((await request(`/api/v1/attempts/${a.id}`,{cookie:alice.cookie,method:'PUT',body:{expectedRevision:3,text:'changed'}})).status,409);
      assert.equal((await request('/api/v1/attempts',{cookie:bob.cookie,method:'POST',body:{parentSubmissionId:submission}})).status,404);
      const revision=await request('/api/v1/attempts',{cookie:alice.cookie,method:'POST',body:{parentSubmissionId:submission}});
      assert.equal(revision.status,201);
      assert.equal((await pool.query('SELECT text FROM submissions WHERE id=$1',[submission])).rows[0].text,a.text);
      await assert.rejects(pool.query('UPDATE submissions SET text=$2 WHERE id=$1',[submission,'changed']),/immutable/);
    });
    await t.test('expired lease fencing and exactly one successful result/debit',async()=>{
      const old=await api.records.claim();
      await pool.query(`UPDATE jobs SET lease_until=now()-interval '1 second' WHERE id=$1`,[old.id]);
      const current=await api.records.claim(); assert.notEqual(old.lease_token,current.lease_token);
      assert.equal(await api.records.complete(old,feedback),false);
      const completed=await Promise.all([api.records.complete(current,feedback),api.records.complete(current,feedback)]);
      assert.deepEqual(completed.sort(),[false,true]);
      assert.equal(await count('assessments'),1); assert.equal(await count('usage_ledger'),1);
      const ent=(await pool.query('SELECT used,reserved FROM entitlements WHERE owner_id=$1',[alice.id])).rows[0];
      assert.deepEqual(ent,{used:1,reserved:0});
    });
    await t.test('last allowance reservation, malformed feedback, failure and safe retry',async()=>{
      await pool.query('UPDATE entitlements SET allowance=1 WHERE owner_id=$1',[bob.id]);
      const [b1,b2]=await Promise.all([draft(bob),draft(bob)]);
      const results=await Promise.all([b1,b2].map(b=>request(`/api/v1/attempts/${b.id}/submissions`,{cookie:bob.cookie,method:'POST',body:{expectedRevision:2,eventId:randomUUID()}})));
      assert.deepEqual(results.map(r=>r.status).sort(),[202,409]);
      const j=await api.records.claim();
      await assert.rejects(api.records.complete(j,{score:100}),/invalid_feedback/);
      assert.equal(await api.records.failJob(j,'malformed_feedback'),true);
      assert.equal(await api.records.failJob(j,'malformed_feedback'),false);
      assert.equal((await pool.query('SELECT used,reserved FROM entitlements WHERE owner_id=$1',[bob.id])).rows[0].used,0);
      await api.records.retry(bob.id,j.submission_id);
      const retry=await api.records.claim(); assert.equal(retry.submission_id,j.submission_id);
      assert.equal(await api.records.complete(retry,feedback),true);
    });
    await t.test('saved feedback reopens without another job or debit; ownership also covers results',async()=>{
      const before=await count('jobs');
      const result=await request(`/api/v1/submissions/${submission}`,{cookie:alice.cookie});
      assert.equal(result.status,200); assert.deepEqual(result.body.assessment.feedback,feedback);
      assert.equal((await request(`/api/v1/submissions/${submission}`,{cookie:bob.cookie})).status,404);
      assert.equal((await request(`/api/v1/submissions/${submission}/retry`,{cookie:bob.cookie,method:'POST'})).status,404);
      assert.equal(await count('jobs'),before);
    });
    await t.test('completion rollback keeps reservation and job for retry',async()=>{
      const d=await draft(alice); await api.records.submit(alice.id,d.id,2,randomUUID());
      const job=await api.records.claim(),before=await count('assessments');
      await pool.query(`CREATE TRIGGER reject_usage BEFORE INSERT ON usage_ledger FOR EACH ROW EXECUTE FUNCTION reject_job()`);
      await assert.rejects(api.records.complete(job,feedback),/injected/);
      assert.equal(await count('assessments'),before);
      assert.equal((await pool.query('SELECT status FROM jobs WHERE id=$1',[job.id])).rows[0].status,'running');
      await pool.query('DROP TRIGGER reject_usage ON usage_ledger');
      assert.equal(await api.records.complete(job,feedback),true);
    });
    await t.test('third worker crash releases reservation and leaves explicit unassessed failure',async()=>{
      const d=await draft(alice); const s=await api.records.submit(alice.id,d.id,2,randomUUID());
      for(let i=0;i<3;i++) {
        const j=await api.records.claim(); assert.ok(j);
        await pool.query(`UPDATE jobs SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1`,[j.id]);
      }
      assert.equal(await api.records.claim(),null);
      const result=await api.records.result(alice.id,s.submissionId);
      assert.equal(result.job.status,'failed'); assert.equal(result.job.failure_code,'retry_exhausted');
      assert.equal(result.assessment,null);
      await assert.rejects(api.records.retry(alice.id,s.submissionId),/retry_unavailable/);
      assert.equal((await pool.query('SELECT reserved FROM entitlements WHERE owner_id=$1',[alice.id])).rows[0].reserved,0);
    });
    await t.test('deletion defeats stale save, idempotency replay and late completion',async()=>{
      const d=await draft(alice),eventId=randomUUID();
      await api.records.submit(alice.id,d.id,2,eventId);
      const job=await api.records.claim();
      await api.records.remove(alice.id,d.id);
      await assert.rejects(api.records.save(alice.id,d.id,2,'stale'),/not_found/);
      await assert.rejects(api.records.submit(alice.id,d.id,2,eventId),/not_found/);
      assert.equal(await api.records.complete(job,feedback),false);
      assert.equal((await pool.query('SELECT reserved FROM entitlements WHERE owner_id=$1',[alice.id])).rows[0].reserved,0);
    });
  } finally {
    if(api) await api.close();
    await pool.query(`DROP SCHEMA ${schema} CASCADE`);
    await pool.end();
  }
});

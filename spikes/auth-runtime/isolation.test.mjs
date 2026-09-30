import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {isolatedFixture} from './isolation-fixture.mjs';
import {store} from './store.mjs';
import {start} from './server.mjs';
import {localPool} from './auth.mjs';

const denied=async promise=>assert.rejects(promise,e=>e.code==='42501');
test('separate login roles, forced RLS and real owned HTTP journey',async t=>{
  const f=await isolatedFixture();
  const secret=randomBytes(48).toString('base64url');
  let api;
  const request=async(path,{method='GET',body,cookie,target=api}={})=>{
    const response=await fetch(target.baseURL+path,{method,headers:{...(cookie?{cookie}:{}),
      ...(method!=='GET'?{origin:target.baseURL,'content-type':'application/json'}:{})},
      ...(method!=='GET'?{body:JSON.stringify(body??{})}:{})});
    return {status:response.status,body:await response.json(),cookies:response.headers.getSetCookie()};
  };
  const register=async email=>{
    const result=await request('/api/auth/sign-up/email',{method:'POST',body:{name:'Synthetic',email,password:randomBytes(20).toString('hex')}});
    assert.equal(result.status,200,JSON.stringify(result.body));
    const cookie=result.cookies.map(c=>c.split(';')[0]).join('; ');
    const me=await request('/api/v1/account',{cookie});
    await f.admin.query('INSERT INTO entitlements(owner_id,allowance) VALUES($1,3)',[me.body.id]);
    return {id:me.body.id,cookie};
  };
  let alice,bob,attempt,submitted;
  try {
    await t.test('real runtime login identities have no admin, role membership or DDL powers',async()=>{
      for(const kind of ['auth','learner','worker','migration']) {
        const identity=(await f[kind].query(`SELECT current_user,session_user,r.rolsuper,r.rolbypassrls,r.rolcreaterole,r.rolcreatedb
          FROM pg_roles r WHERE r.rolname=current_user`)).rows[0];
        assert.equal(identity.current_user,f.roles[kind]); assert.equal(identity.session_user,f.roles[kind]);
        for(const key of ['rolsuper','rolbypassrls','rolcreaterole','rolcreatedb']) assert.equal(identity[key],false);
        const memberships=await f.admin.query('SELECT 1 FROM pg_auth_members m JOIN pg_roles r ON r.oid=m.member WHERE r.rolname=$1',[f.roles[kind]]);
        assert.equal(memberships.rowCount,0);
      }
      for(const kind of ['auth','learner','worker']) {
        await denied(f[kind].query('CREATE TABLE forbidden(id int)'));
        await denied(f[kind].query('CREATE TEMP TABLE forbidden(id int)'));
        await denied(f[kind].query('ALTER TABLE attempts DISABLE ROW LEVEL SECURITY'));
        await denied(f[kind].query(`SET ROLE ${f.roles.migration}`));
      }
      const tables=await f.admin.query(`SELECT relname,relrowsecurity,relforcerowsecurity FROM pg_class
        WHERE relnamespace=$1::regnamespace AND relname=ANY($2::text[])`,[f.schema,['attempts','drafts','submissions','jobs','entitlements','assessments','usage_ledger']]);
      assert.equal(tables.rowCount,7); for(const table of tables.rows) {assert.equal(table.relrowsecurity,true); assert.equal(table.relforcerowsecurity,true);}
    });
    await t.test('authentication connects with its own role and cannot read learner records',async()=>{
      api=await start(f.auth,secret,{learnerPool:f.learner,workerPool:f.worker});
      alice=await register('alice@example.test'); bob=await register('bob@example.test');
      await denied(f.auth.query('SELECT * FROM drafts'));
      await denied(f.auth.query('SELECT * FROM attempts'));
      for(const kind of ['learner','worker']) {
        await denied(f[kind].query('SELECT * FROM account'));
        await denied(f[kind].query('SELECT token FROM session'));
        await denied(f[kind].query('SELECT * FROM "user"'));
        await denied(f[kind].query('SELECT * FROM verification'));
      }
    });
    await t.test('learner HTTP paths use restricted role and preserve cross-owner 404',async()=>{
      const created=await request('/api/v1/attempts',{cookie:alice.cookie,method:'POST'});
      assert.equal(created.status,201,JSON.stringify(created.body)); attempt=created.body.id;
      const saved=await request(`/api/v1/attempts/${attempt}`,{cookie:alice.cookie,method:'PUT',body:{expectedRevision:1,text:'Synthetischer Entwurf'}});
      assert.equal(saved.status,200,JSON.stringify(saved.body));
      assert.equal((await request(`/api/v1/attempts/${attempt}`,{cookie:bob.cookie})).status,404);
      assert.equal((await request(`/api/v1/attempts/${attempt}`,{cookie:alice.cookie})).body.text,'Synthetischer Entwurf');
      const result=await request(`/api/v1/attempts/${attempt}/submissions`,{cookie:alice.cookie,method:'POST',body:{expectedRevision:2,eventId:randomUUID()}});
      assert.equal(result.status,202,JSON.stringify(result.body)); submitted=result.body.submissionId;
    });
    await t.test('direct SQL without context is denied; cross-owner rows/forged inserts stay isolated',async()=>{
      assert.equal((await f.learner.query('SELECT * FROM attempts')).rowCount,0);
      assert.equal((await f.learner.query('SELECT * FROM drafts')).rowCount,0);
      await denied(f.learner.query(`INSERT INTO attempts(id,owner_id,task_version,rubric_version) VALUES($1,$2,'x','x')`,[randomUUID(),alice.id]));
      const c=await f.learner.connect();
      try {
        await c.query('BEGIN'); await c.query("SELECT set_config('hatoove.owner_id',$1,true)",[bob.id]);
        assert.equal((await c.query('SELECT * FROM drafts WHERE attempt_id=$1',[attempt])).rowCount,0);
        assert.equal((await c.query('UPDATE drafts SET text=$2 WHERE attempt_id=$1',[attempt,'attack'])).rowCount,0);
        await denied(c.query(`INSERT INTO attempts(id,owner_id,task_version,rubric_version) VALUES($1,$2,'x','x')`,[randomUUID(),alice.id]));
      } finally {await c.query('ROLLBACK'); c.release();}
      assert.equal((await f.migration.query('SELECT * FROM attempts')).rowCount,0,'FORCE also filters table owner without a policy');
    });
    await t.test('single-connection pool clears owner after commit and rollback',async()=>{
      const scoped=store(f.learner,{ownerId:alice.id});
      await scoped.read(alice.id,attempt);
      assert.equal((await f.learner.query('SELECT * FROM attempts')).rowCount,0);
      await assert.rejects(scoped.save(alice.id,attempt,999,'conflict'),/draft_conflict/);
      assert.equal((await f.learner.query('SELECT * FROM attempts')).rowCount,0);
      await assert.rejects(store(f.learner).read(alice.id,attempt),/not_found/);
      await assert.rejects(store(f.learner,{ownerId:bob.id}).read(alice.id,attempt),/not_found/);
      assert.equal((await request(`/api/v1/attempts/${attempt}`,{cookie:alice.cookie})).status,200);
    });
    await t.test('RLS cannot be switched off and owner-carrying foreign keys reject a hidden parent',async()=>{
      const c=await f.learner.connect();
      try {
        await c.query('BEGIN'); await c.query("SELECT set_config('hatoove.owner_id',$1,true)",[bob.id]);
        await assert.rejects(c.query(`INSERT INTO attempts(id,owner_id,task_version,rubric_version,parent_submission_id)
          VALUES($1,$2,'x','x',$3)`,[randomUUID(),bob.id,submitted]),e=>e.code==='23503');
        await c.query('ROLLBACK');
        await c.query('BEGIN'); await c.query('SET LOCAL row_security=off');
        await denied(c.query('SELECT * FROM attempts'));
      } finally {await c.query('ROLLBACK'); c.release();}
      await f.migration.query('CREATE TABLE future_private(id int)');
      await denied(f.learner.query('SELECT * FROM future_private'));
      await f.migration.query(`GRANT SELECT ON future_private TO ${f.roles.learner}`);
      await f.migration.query('INSERT INTO future_private VALUES(1)');
      await f.migration.query('ALTER TABLE future_private ENABLE ROW LEVEL SECURITY');
      assert.equal((await f.learner.query('SELECT * FROM future_private')).rowCount,0,'enabled RLS without a policy denies rows');
      await f.migration.query("CREATE FUNCTION future_helper() RETURNS int LANGUAGE sql AS 'SELECT 1'");
      await denied(f.learner.query('SELECT future_helper()'));
      const acl=await f.admin.query(`SELECT has_function_privilege($1,'future_helper()','EXECUTE') AS allowed,
        (SELECT count(*)::int FROM pg_default_acl WHERE defaclrole=$2::regrole AND defaclobjtype='f') AS defaults`,[f.roles.learner,f.roles.migration]);
      assert.equal(acl.rows[0].allowed,false); assert.equal(acl.rows[0].defaults,1);
    });
    await t.test('learner cannot manufacture allowance, success or feedback; worker cannot read drafts',async()=>{
      await denied(f.learner.query('UPDATE entitlements SET allowance=999'));
      await denied(f.learner.query('UPDATE entitlements SET used=0'));
      await denied(f.learner.query('UPDATE jobs SET tries=0'));
      await denied(f.learner.query('UPDATE attempts SET owner_id=$1',[bob.id]));
      await denied(f.learner.query('INSERT INTO assessments VALUES($1,$2,$3,$4,$5,$6)',[submitted,alice.id,{},'x','x','x']));
      await denied(f.learner.query('TRUNCATE jobs'));
      await denied(f.worker.query('SELECT * FROM drafts'));
      const c=await f.learner.connect();
      try {
        await c.query('BEGIN'); await c.query("SELECT set_config('hatoove.owner_id',$1,true)",[alice.id]);
        await denied(c.query("UPDATE jobs SET status='succeeded' WHERE submission_id=$1",[submitted]));
      } finally {await c.query('ROLLBACK'); c.release();}
    });
    await t.test('restricted worker can complete once; owned result and revision reopen',async()=>{
      const job=await api.records.claim(); assert.equal(job.submission_id,submitted);
      assert.equal(await api.records.complete(job,{kind:'synthetic-formative',comment:'Fixture only'}),true);
      assert.equal(await api.records.complete(job,{kind:'synthetic-formative',comment:'Duplicate'}),false);
      const result=await request(`/api/v1/submissions/${submitted}`,{cookie:alice.cookie});
      assert.equal(result.status,200,JSON.stringify(result.body)); assert.equal(result.body.job.status,'succeeded');
      assert.equal((await request(`/api/v1/submissions/${submitted}`,{cookie:bob.cookie})).status,404);
      const revision=await request('/api/v1/attempts',{cookie:alice.cookie,method:'POST',body:{parentSubmissionId:submitted}});
      assert.equal(revision.status,201,JSON.stringify(revision.body));
      const ent=(await f.admin.query('SELECT used,reserved FROM entitlements WHERE owner_id=$1',[alice.id])).rows[0];
      assert.deepEqual(ent,{used:1,reserved:0});
      const c=await f.learner.connect();
      try {
        for(const [owner,count] of [[alice.id,1],[bob.id,0]]) {
          await c.query('BEGIN'); await c.query("SELECT set_config('hatoove.owner_id',$1,true)",[owner]);
          const joined=await c.query(`SELECT s.id FROM submissions s JOIN jobs j ON j.submission_id=s.id
            JOIN assessments a ON a.submission_id=s.id JOIN usage_ledger u ON u.submission_id=s.id`);
          assert.equal(joined.rowCount,count);
          await c.query('COMMIT');
        }
      } finally {await c.query('ROLLBACK'); c.release();}
    });
    await t.test('restricted learner retry/delete and late worker completion remain correct',async()=>{
      const scoped=store(f.learner,{ownerId:alice.id});
      const d=await scoped.create(alice.id); await scoped.save(alice.id,d.id,1,'synthetic');
      const s=await scoped.submit(alice.id,d.id,2,randomUUID());
      const first=await api.records.claim(); await api.records.failJob(first,'provider_unavailable');
      await scoped.retry(alice.id,s.submissionId);
      const late=await api.records.claim();
      await scoped.remove(alice.id,d.id);
      assert.equal(await api.records.complete(late,{kind:'synthetic-formative',comment:'late'}),false);
      assert.equal((await f.admin.query('SELECT * FROM drafts WHERE attempt_id=$1',[d.id])).rowCount,0);
      assert.equal((await f.admin.query('SELECT reserved FROM entitlements WHERE owner_id=$1',[alice.id])).rows[0].reserved,0);
      await assert.rejects(scoped.read(alice.id,d.id),/not_found/);
      await assert.rejects(scoped.save(alice.id,d.id,2,'resurrect'),/not_found/);
      await assert.rejects(scoped.retry(alice.id,s.submissionId),/not_found/);
    });
    await t.test('concurrent two-account HTTP requests remain isolated across three pooled connections',async()=>{
      const pool=localPool(f.schema,{user:f.roles.learner,max:3});
      let concurrent;
      try {
        const b=await store(f.learner,{ownerId:bob.id}).create(bob.id);
        concurrent=await start(f.auth,secret,{learnerPool:pool,workerPool:f.worker});
        await Promise.all(Array.from({length:18},async(_,i)=>{
          const self=i%2?alice:bob,own=i%2?attempt:b.id,other=i%2?b.id:attempt;
          const success=await request(`/api/v1/attempts/${own}`,{cookie:self.cookie,target:concurrent});
          assert.equal(success.status,200); assert.equal(success.body.owner_id,self.id);
          assert.equal((await request(`/api/v1/attempts/${other}`,{cookie:self.cookie,target:concurrent})).status,404);
        }));
        const clients=[];
        try {
          for(let i=0;i<3;i++) clients.push(await pool.connect());
          const snapshots=await Promise.all(clients.map(c=>c.query('SELECT pg_backend_pid() AS pid,(SELECT count(*)::int FROM attempts) AS visible')));
          assert.equal(new Set(snapshots.map(s=>s.rows[0].pid)).size,3);
          for(const s of snapshots) assert.equal(s.rows[0].visible,0);
        } finally {for(const c of clients)c.release();}
      } finally {if(concurrent)await concurrent.close(); await pool.end();}
    });
  } finally { if(api) await api.close(); await f.cleanup(); }
});

import {randomBytes} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {localPool,migrateAuth} from './auth.mjs';

// Disposable local test bootstrap only. Never run against a shared database.
export async function isolatedFixture() {
  const schema='spike_'+randomBytes(8).toString('hex');
  const roles=Object.fromEntries(['migration','auth','learner','worker'].map(kind=>[kind,`${schema}_${kind}`]));
  const admin=localPool(schema);
  const pools={};
  const created=[];
  const cleanup=async()=>{
    await Promise.all(Object.values(pools).map(pool=>pool.end()));
    try {
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      if(created.includes(roles.migration))
        await admin.query(`ALTER DEFAULT PRIVILEGES FOR ROLE ${roles.migration} GRANT EXECUTE ON FUNCTIONS TO PUBLIC`);
      for(const role of created.reverse()) await admin.query(`DROP ROLE ${role}`);
    } finally { await admin.end(); }
  };
  try {
    // This is the dedicated hatoove_spike fixture DB, never another app's DB.
    await admin.query('REVOKE CREATE,TEMPORARY ON DATABASE hatoove_spike FROM PUBLIC');
    for(const [kind,role] of Object.entries(roles)) {
      await admin.query(`CREATE ROLE ${role} LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 5`);
      created.push(role);
      pools[kind]=localPool(schema,{user:role,max:kind==='learner'?1:2});
    }
    await admin.query(`CREATE SCHEMA ${schema} AUTHORIZATION ${roles.migration}`);
    await migrateAuth(pools.migration);
    await pools.migration.query(await readFile(new URL('./schema.sql',import.meta.url),'utf8'));
    let sql=await readFile(new URL('./isolation.sql',import.meta.url),'utf8');
    for(const [key,value] of Object.entries({SCHEMA:schema,AUTH:roles.auth,LEARNER:roles.learner,WORKER:roles.worker}))
      sql=sql.replaceAll(`__${key}__`,value);
    await pools.migration.query(sql);
    return {schema,roles,admin,...pools,cleanup};
  } catch(e) { await cleanup(); throw e; }
}

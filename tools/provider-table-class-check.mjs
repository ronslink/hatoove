#!/usr/bin/env node
/** Real, rollback-only catalogue mutations in an explicitly guarded disposable fixture. */
import assert from 'node:assert/strict';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createFixture} from '../server/owned-postgres/bootstrap.mjs';
import {ACCOUNT_TABLES} from '../server/owned-postgres/adapter.mjs';
import {PRIVATE_TELEMETRY_TABLES} from './lib/catalogue.mjs';
import {runTableClassCheck} from './table-class-check.mjs';

export function providerFixtureAllowed(env) {
  const local = env.OWNAPI_PG_PORT === '62563' && env.OWNAPI_PG_DATABASE === 'hatoove_spike';
  const actions = env.CI === 'true' && env.GITHUB_ACTIONS === 'true'
    && env.OWNAPI_PG_PORT === '5432' && env.OWNAPI_PG_DATABASE === 'hatoove_ci';
  return env.OWNAPI_PG_ALLOW === '1' && env.OWNAPI_PG_HOST === '127.0.0.1' && (local || actions);
}

const quote = value => '"' + String(value).replaceAll('"', '""') + '"';
export async function runProviderTableClassCheck() {
  if (!providerFixtureAllowed(process.env)) throw Error('Explicit assigned disposable PostgreSQL required');
  let db, provisioner, failure, passed = 0;
  const extraRoles = new Set();
  const classify = (client, options = {}) => runTableClassCheck({db:client, schema:db.schema, roles:db.roles, ...options});
  const detail = (report, table) => report.failures.find(row => row.table === table)?.detail || '';
  async function mutation(table, statements, expected, options = {}) {
    const client = await db.admin.connect();
    // Keep every catalogue query inside this exact transaction, including readCatalogue's batch.
    let pending = Promise.resolve();
    const transaction = {query(...args) {
      const result = pending.then(() => client.query(...args));
      pending = result.catch(() => {});
      return result;
    }};
    try {
      await transaction.query('BEGIN');
      assert.equal((await classify(transaction)).ok, true, 'unmodified control before each mutation');
      for (const sql of [].concat(statements || [])) await transaction.query(sql);
      const report = await classify(transaction, options);
      assert.equal(report.ok, false, 'actual mutation must fail the classifier');
      assert.match(detail(report, table), expected, `expected ${table} failure`);
      passed++;
    } finally {
      try { await transaction.query('ROLLBACK'); } finally { client.release(); }
    }
    assert.equal((await classify(db.admin)).ok, true, 'rollback restores the positive control');
  }
  try {
    db = await createFixture();
    assert.match(db.schema, /^ownapi_[a-z0-9_]+$/);
    const actual = (await db.admin.query('SELECT current_schema() AS schema')).rows[0].schema;
    assert.equal(actual, db.schema, 'mutations target the actual disposable fixture schema');
    console.log(`Provider classifier fixture created: ${db.schema}`);
    provisioner = `${db.schema}_provider_provisioner`;
    extraRoles.add(provisioner);
    await db.admin.query(`CREATE ROLE ${quote(provisioner)} NOLOGIN`);
    db.roles.provisioner = provisioner;
    const baseline = await classify(db.admin);
    assert.equal(baseline.ok, true, JSON.stringify(baseline.failures));
    const {schema} = db;
    const functions = baseline.catalogue.functionAccess;
    for (const table of PRIVATE_TELEMETRY_TABLES) {
      assert.equal(baseline.rows.find(row => row.table === table)?.cls, 'private-owned telemetry');
      const target = `${quote(schema)}.${quote(table)}`;
      const forbidden = [db.roles.learner, db.roles.auth, db.roles.payments, provisioner, 'PUBLIC'];
      for (const role of forbidden) for (const grant of ['SELECT', 'SELECT(owner_id)', 'INSERT', 'UPDATE(owner_id)', 'TRUNCATE']) {
        await mutation(table, `GRANT ${grant} ON ${target} TO ${role === 'PUBLIC' ? 'PUBLIC' : quote(role)}`, /private telemetry grants unexpected/);
      }
      const outsider = `${schema}_provider_outsider`;
      extraRoles.add(outsider);
      await mutation(table, [`CREATE ROLE ${quote(outsider)} NOLOGIN`,
        `GRANT SELECT ON ${target} TO ${quote(outsider)}`], /private telemetry grants unexpected/);
      for (const [role, grants] of [[db.roles.worker, ['INSERT','UPDATE(owner_id)','DELETE','TRUNCATE']],
        [db.roles.deletion, ['INSERT','UPDATE(owner_id)','TRUNCATE']]]) {
        for (const grant of grants) await mutation(table, `GRANT ${grant} ON ${target} TO ${quote(role)}`, /private telemetry grants unexpected/);
      }
      for (const [role, grants] of [[db.roles.worker, ['SELECT']], [db.roles.deletion, ['SELECT','DELETE']]]) {
        for (const grant of grants) await mutation(table, `REVOKE ${grant} ON ${target} FROM ${quote(role)}`, /private telemetry lacks/);
      }
      await mutation(table, [`REVOKE SELECT ON ${target} FROM ${quote(db.roles.deletion)}`,
        `GRANT SELECT(owner_id) ON ${target} TO ${quote(db.roles.deletion)}`], /private telemetry lacks SELECT/);
      for (const policy of ['provider_worker_read','provider_deletion','provider_function_owner']) {
        await mutation(table, `DROP POLICY ${quote(policy)} ON ${target}`, /private telemetry lacks .*policy/);
      }
      await mutation(table, `ALTER POLICY provider_deletion ON ${target} USING(true)`, /widens owner scope/);
      await mutation(table, `ALTER POLICY provider_deletion ON ${target} USING(owner_id=nullif(current_setting('hatoove.owner_id',true),'') OR true)`, /widens owner scope/);
      await mutation(table, [`DROP POLICY provider_deletion ON ${target}`,
        `CREATE POLICY provider_deletion ON ${target} AS RESTRICTIVE TO ${quote(db.roles.deletion)} USING(owner_id=nullif(current_setting('hatoove.owner_id',true),''))`], /lacks exact deletion owner policy/);
      await mutation(table, `CREATE POLICY provider_public_read ON ${target} FOR SELECT TO PUBLIC USING(true)`, /policy grants an unexpected role/);
      for (const change of ['NO FORCE ROW LEVEL SECURITY','DISABLE ROW LEVEL SECURITY']) {
        await mutation(table, `ALTER TABLE ${target} ${change}`, /ENABLE and FORCE ROW LEVEL SECURITY/);
      }
      await mutation(table, null, /absent from ACCOUNT_TABLES/,
        {accountTables:ACCOUNT_TABLES.filter(([name]) => name !== table)});
      await mutation(table, `ALTER TABLE ${target} ALTER COLUMN owner_id DROP NOT NULL`, /owner_id must exist and be NOT NULL/);
      const primaryId = table === 'provider_attempt' ? 'attempt_id' : 'event_id';
      const primary = (await db.admin.query("SELECT conname FROM pg_constraint WHERE conrelid=$1::regclass AND contype='p'", [target])).rows[0];
      assert.ok(primary);
      await mutation(table, `ALTER TABLE ${target} DROP CONSTRAINT ${quote(primary.conname)}`, new RegExp(`globally unique ${primaryId}`));
      await mutation(table, [`ALTER TABLE ${target} DROP CONSTRAINT ${quote(primary.conname)}`,
        `ALTER TABLE ${target} ADD UNIQUE(${primaryId})`,
        `ALTER TABLE ${target} ALTER COLUMN ${primaryId} DROP NOT NULL`], new RegExp(`${primaryId} must exist and be NOT NULL`));
      const fks = baseline.catalogue.foreignKeys.filter(fk => fk.table === table);
      for (const fk of fks) {
        await mutation(table, `ALTER TABLE ${target} DROP CONSTRAINT ${quote(fk.name)}`, /private telemetry lacks validated/);
        const definition = (await db.admin.query('SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid=$1::regclass AND conname=$2', [target,fk.name])).rows[0].definition;
        await mutation(table, [`ALTER TABLE ${target} DROP CONSTRAINT ${quote(fk.name)}`,
          `ALTER TABLE ${target} ADD CONSTRAINT ${quote(fk.name)} ${definition} NOT VALID`], /private telemetry lacks validated/);
      }
      const keys = (await db.admin.query(`SELECT conname,pg_get_constraintdef(oid) AS definition FROM pg_constraint
        WHERE conrelid=$1::regclass AND contype='u'`, [target])).rows;
      const isolatedKey = keys.find(key => table === 'provider_attempt' ? /UNIQUE \(job_id, claim_number\)/.test(key.definition)
        : /UNIQUE \(attempt_id, revision\)/.test(key.definition));
      assert.ok(isolatedKey, 'independent claim/revision uniqueness exists');
      await mutation(table, `ALTER TABLE ${target} DROP CONSTRAINT ${quote(isolatedKey.conname)}`, /private telemetry lacks unique/);
      const guard = table === 'provider_attempt' ? 'guard_provider_attempt' : 'guard_provider_observation';
      await mutation(table, `ALTER FUNCTION ${quote(schema)}.${guard}() SECURITY DEFINER`, /wrong security mode/);
      await mutation(table, `ALTER FUNCTION ${quote(schema)}.guard_provider_truncate() SECURITY DEFINER`, /wrong security mode/);
      const rowTrigger = baseline.catalogue.triggers.find(t => t.table === table && t.function_name === guard);
      const truncateTrigger = baseline.catalogue.triggers.find(t => t.table === table && t.function_name === 'guard_provider_truncate');
      assert.ok(rowTrigger && truncateTrigger);
      for (const trigger of [rowTrigger,truncateTrigger]) for (const change of ['DISABLE','ENABLE REPLICA']) {
        await mutation(table, `ALTER TABLE ${target} ${change} TRIGGER ${quote(trigger.name)}`, /private telemetry lacks enabled BEFORE/);
      }
      for (const shape of ['BEFORE UPDATE OR DELETE', 'AFTER INSERT OR UPDATE OR DELETE',
        'BEFORE INSERT OR UPDATE OF owner_id OR DELETE']) {
        await mutation(table, [`DROP TRIGGER ${quote(rowTrigger.name)} ON ${target}`,
          `CREATE TRIGGER ${quote(rowTrigger.name)} ${shape} ON ${target} FOR EACH ROW EXECUTE FUNCTION ${quote(schema)}.${guard}()`], /private telemetry lacks enabled BEFORE/);
      }
      await mutation(table, [`DROP TRIGGER ${quote(rowTrigger.name)} ON ${target}`,
        `CREATE TRIGGER ${quote(rowTrigger.name)} BEFORE INSERT OR UPDATE OR DELETE ON ${target} FOR EACH ROW WHEN(false) EXECUTE FUNCTION ${quote(schema)}.${guard}()`], /private telemetry lacks enabled BEFORE/);
      await mutation(table, [`DROP TRIGGER ${quote(truncateTrigger.name)} ON ${target}`,
        `CREATE TRIGGER ${quote(truncateTrigger.name)} AFTER TRUNCATE ON ${target} EXECUTE FUNCTION ${quote(schema)}.guard_provider_truncate()`], /BEFORE TRUNCATE statement guard/);
    }
    const observation = 'provider_attempt_observation', target = `${quote(schema)}.${observation}`;
    await mutation(observation, `DROP TABLE ${target}`, /missing from the installed pair/);
    await mutation(observation, `ALTER FUNCTION ${quote(schema)}.guard_provider_accepted() SECURITY INVOKER`, /wrong security mode/);
    for (const change of ['DISABLE', 'ENABLE REPLICA']) await mutation(observation,
      `ALTER TABLE ${target} ${change} TRIGGER provider_observation_accepted`, /initially-deferred accepted constraint/);
    for (const [event,deferral] of [['INSERT','DEFERRABLE INITIALLY IMMEDIATE'], ['INSERT','NOT DEFERRABLE'],
      ['UPDATE','DEFERRABLE INITIALLY DEFERRED']]) {
      await mutation(observation, [`DROP TRIGGER provider_observation_accepted ON ${target}`,
        `CREATE CONSTRAINT TRIGGER provider_observation_accepted AFTER ${event} ON ${target} ${deferral} FOR EACH ROW EXECUTE FUNCTION ${quote(schema)}.guard_provider_accepted()`], /initially-deferred accepted constraint/);
    }
    const entryPoints = [['begin_provider_attempt','uuid, uuid, jsonb',db.roles.worker],
      ['append_provider_observation','uuid, uuid, integer, jsonb, uuid',db.roles.worker],
      ['export_owned_provider_attempts','',db.roles.learner]];
    for (const [name,args,caller] of entryPoints) {
      const fn = `${quote(schema)}.${name}(${args})`;
      await mutation('provider_attempt', `REVOKE EXECUTE ON FUNCTION ${fn} FROM ${quote(caller)}`, /lacks required EXECUTE/);
      await mutation('provider_attempt', `ALTER FUNCTION ${fn} SECURITY INVOKER`, /wrong security mode/);
      await mutation('provider_attempt', `ALTER FUNCTION ${fn} SET search_path TO pg_catalog, public`, /lacks fixed definer authority/);
      if (name !== 'export_owned_provider_attempts') await mutation('provider_attempt', `ALTER FUNCTION ${fn} STABLE`, /must be VOLATILE/);
      for (const role of [db.roles.auth, db.roles.payments, provisioner, 'PUBLIC', caller === db.roles.worker ? db.roles.learner : db.roles.worker]) {
        await mutation('provider_attempt', `GRANT EXECUTE ON FUNCTION ${fn} TO ${role === 'PUBLIC' ? 'PUBLIC' : quote(role)}`, /grants unexpected EXECUTE/);
      }
    }
    const helpers = [...new Map(functions.filter(f => /(^|_)provider_/.test(f.name)
      && !entryPoints.some(([name]) => name === f.name)).map(f => [`${f.name}(${f.argument_types})`,f])).values()];
    assert.ok(helpers.length >= 4, 'actual guards/helper ACLs are included');
    for (const helper of helpers) await mutation('provider_attempt',
      `GRANT EXECUTE ON FUNCTION ${quote(schema)}.${quote(helper.name)}(${helper.argument_types}) TO PUBLIC`, /grants unexpected EXECUTE/);
    assert.equal((await classify(db.admin)).ok, true);
  } catch (error) { failure = error; }
  finally {
    if (db) {
      for (const role of extraRoles) {
        try { await db.admin.query(`DROP ROLE IF EXISTS ${quote(role)}`); } catch (error) { failure ??= error; }
      }
      delete db.roles.provisioner;
      try { await db.cleanup(); } catch (error) { failure ??= error; }
      const verifier = new db.admin.constructor({...db.config,max:1});
      try {
        const row = (await verifier.query(`SELECT EXISTS(SELECT 1 FROM pg_namespace WHERE nspname=$1) AS schema_exists,
          EXISTS(SELECT 1 FROM pg_roles WHERE rolname=ANY($2::text[])) AS roles_exist`,
        [db.schema,[...Object.values(db.roles),...extraRoles]])).rows[0];
        assert.deepEqual(row,{schema_exists:false,roles_exist:false},'own fixture and every generated role removed');
      } catch (error) { failure ??= error; }
      finally { try { await verifier.end(); } catch (error) { failure ??= error; } }
    }
  }
  if (failure) throw failure;
  console.log(`PASS provider table classification: ${passed} actual mutations detected; schema ${db.schema} and all fixture roles removed`);
  return passed;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await runProviderTableClassCheck();

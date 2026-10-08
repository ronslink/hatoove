#!/usr/bin/env node
/** Offline only: actual persistent builders and caller paths, with every network connection forbidden. */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import net from 'node:net';
import tls from 'node:tls';
import { persistentConfig, persistentRolePool, createAdminPool, ensureRolesAndSchema,
  openRuntimePools, closeRuntimePools, migrate, provisionPersistent } from '../server/owned-postgres/provision.mjs';
import { main as workerMain } from '../server/worker.mjs';

const require = createRequire(new URL('../server/owned-postgres/package.json', import.meta.url));
const pg = require('pg');
const Connection = require('pg/lib/connection');
const stream = require('pg/lib/stream');
const checks = [];
const check = (name, run) => checks.push({ name, run });
const poolList = [];
const pool = (config, role, options) => { const value = role === 'admin' ? createAdminPool(config, options) : persistentRolePool(config, role, options); poolList.push(value); return value; };
const options = (env = {}, role = 'learner', cap) => pool(persistentConfig(env), role, cap).options;
const fixed = (fn, code) => assert.throws(fn, error => error.message === code && (!error.code || error.code === code));
const temporary = mkdtempSync(join(tmpdir(), 'hatoove-pg-config-'));
let fileNumber = 0;
const file = value => { const path = join(temporary, `synthetic-${++fileNumber}`); writeFileSync(path, value); return path; };
const selectedEnv = ['PGSSLMODE', 'PGPASSWORD', ...Object.keys(process.env).filter(key => key.startsWith('OWNAPI_PG_'))];
const priorEnv = Object.fromEntries(selectedEnv.map(key => [key, process.env[key]]));
const originalConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function () { throw Error('offline_network_forbidden'); };
for (const key of selectedEnv) delete process.env[key];

async function fakePools(run, query = async () => ({ rows: [] })) {
  const Original = pg.Pool, created = [];
  class FakePool extends EventEmitter {
    constructor(value) { super(); this.options = value; this.ended = false; created.push(this); }
    async query(text, values) { return query(this, text, values); }
    async connect() { return { query: this.query.bind(this), release() {} }; }
    async end() { this.ended = true; }
  }
  pg.Pool = FakePool;
  try { await run(created); } finally { pg.Pool = Original; }
}

check('retained defaults plus one operator connection: exact 30-connection aggregate', () => {
  const config = persistentConfig({});
  assert.equal(config.admin.host, '127.0.0.1'); assert.equal(config.admin.port, 5432);
  assert.equal(config.admin.database, 'hatoove'); assert.equal(config.admin.user, 'postgres');
  assert.equal(config.connection.total, 30);
  assert.deepEqual(config.connection.roleTotals, { auth: 4, learner: 5, worker: 6, deletion: 4, payments: 4, provisioner: 2, admin: 2, migration: 2, operator: 1 });
  for (const [role, max] of Object.entries(config.connection.maxima)) {
    const actual = pool(config, role).options;
    assert.equal(actual.max, max); assert.equal(actual.ssl, false);
    assert.equal(actual.connectionTimeoutMillis, undefined);
    assert.equal(actual.options, '-c search_path=hatoove,pg_catalog');
  }
  assert.equal(pool(config, 'worker', { allocation: 'worker-runner' }).options.max, 2);
});

check('strict numeric configuration and both lower and upper bounds', () => {
  for (const key of ['OWNAPI_PG_POOL_AUTH_MAX', 'OWNAPI_PG_WORKER_RUNNER_POOL_MAX', 'OWNAPI_PG_APP_REPLICAS', 'OWNAPI_PG_WORKER_REPLICAS', 'OWNAPI_PG_CONNECTION_BUDGET', 'OWNAPI_PG_CONNECT_TIMEOUT_MS']) {
    for (const value of ['', ' 1', '1 ', '+1', '01', '1.0', '1e0', '0', '-1', 'Infinity', '1\n', 1]) fixed(() => persistentConfig({ [key]: value }), 'postgres_configuration_invalid');
  }
  for (const value of ['249', '30001']) fixed(() => persistentConfig({ OWNAPI_PG_CONNECT_TIMEOUT_MS: value }), 'postgres_configuration_invalid');
  for (const value of ['250', '30000']) assert.equal(options({ OWNAPI_PG_CONNECT_TIMEOUT_MS: value }).connectionTimeoutMillis, Number(value));
  for (const key of ['OWNAPI_PG_POOL_AUTH_MAX', 'OWNAPI_PG_WORKER_RUNNER_POOL_MAX', 'OWNAPI_PG_APP_REPLICAS', 'OWNAPI_PG_WORKER_REPLICAS']) fixed(() => persistentConfig({ [key]: '11' }), 'postgres_configuration_invalid');
  fixed(() => persistentConfig({ OWNAPI_PG_CONNECTION_BUDGET: '1001' }), 'postgres_configuration_invalid');
});

check('role, readiness and aggregate budgets cannot be understated', () => {
  fixed(() => persistentConfig({ OWNAPI_PG_POOL_LEARNER_MAX: '10' }), 'postgres_role_budget_exceeded');
  fixed(() => persistentConfig({ OWNAPI_PG_POOL_WORKER_MAX: '9' }), 'postgres_role_budget_exceeded');
  fixed(() => persistentConfig({ OWNAPI_PG_WORKER_REPLICAS: '4' }), 'postgres_role_budget_exceeded');
  fixed(() => persistentConfig({ OWNAPI_PG_APP_REPLICAS: '3' }), 'postgres_role_budget_exceeded');
  fixed(() => persistentConfig({ OWNAPI_PG_CONNECTION_BUDGET: '28' }), 'postgres_connection_budget_exceeded');
  fixed(() => persistentConfig({ OWNAPI_PG_CONNECTION_BUDGET: '29' }), 'postgres_connection_budget_exceeded');
  assert.equal(persistentConfig({ OWNAPI_PG_CONNECTION_BUDGET: '30' }).connection.total, 30);
  const replicas = persistentConfig({ OWNAPI_PG_APP_REPLICAS: '2', OWNAPI_PG_CONNECTION_BUDGET: '53' });
  assert.equal(replicas.connection.total, 53); assert.equal(replicas.connection.roleTotals.learner, 10); assert.equal(replicas.connection.roleTotals.worker, 10);
});

check('named allocation is authoritative; caps only lower', () => {
  const config = persistentConfig({ OWNAPI_PG_POOL_WORKER_MAX: '1', OWNAPI_PG_WORKER_RUNNER_POOL_MAX: '3' });
  assert.equal(pool(config, 'worker').options.max, 1);
  assert.equal(pool(config, 'worker', { allocation: 'worker-runner' }).options.max, 3);
  assert.equal(pool(config, 'worker', { allocation: 'worker-runner', max: 2 }).options.max, 2);
  for (const max of [0, 2, 11, 1.5, '1']) fixed(() => pool(config, 'worker', { max }), 'postgres_pool_cap_invalid');
  fixed(() => pool(config, 'learner', { allocation: 'worker-runner' }), 'postgres_configuration_invalid');
  fixed(() => pool(config, 'worker', { allocation: 'unbounded' }), 'postgres_configuration_invalid');
  assert.equal(pool(config, 'learner', { max: 1 }).options.max, 1);
  fixed(() => pool(config, 'admin', { max: 3 }), 'postgres_pool_cap_invalid');
});

check('actual runtime callers select configured maxima without admin secrets', async () => {
  await fakePools(async created => {
    const env = { OWNAPI_PG_REQUIRE_PASSWORDS: '1', OWNAPI_PG_PASSWORD_FILE: 'missing-unused-admin', OWNAPI_PG_MIGRATION_PASSWORD_FILE: 'missing-unused-migration' };
    for (const role of ['auth', 'learner', 'worker', 'deletion', 'payments', 'provisioner']) {
      env[`OWNAPI_PG_POOL_${role.toUpperCase()}_MAX`] = '1'; env[`OWNAPI_PG_${role.toUpperCase()}_PASSWORD`] = `synthetic-${role}`;
    }
    const runtime = await openRuntimePools({ config: persistentConfig(env) });
    assert.equal(created.length, 6); assert.ok(created.every(value => value.options.max === 1));
    assert.deepEqual(created.map(value => value.options.user), ['auth', 'learner', 'worker', 'deletion', 'payments', 'provisioner'].map(role => `hatoove_${role}`));
    await closeRuntimePools(runtime); assert.ok(created.every(value => value.ended));
  });
});

check('partial runtime initialization closes already-created pools', async () => {
  await fakePools(async created => {
    await assert.rejects(openRuntimePools({ config: persistentConfig({ OWNAPI_PG_REQUIRE_PASSWORDS: '1', OWNAPI_PG_AUTH_PASSWORD: 'synthetic-only-first' }) }), /postgres_password_required/);
    assert.equal(created.length, 1); assert.equal(created[0].ended, true);
  });
});

check('actual worker entry point selects runner separately and closes it', async () => {
  const env = { OWNAPI_PG_DATABASE: 'synthetic', OWNAPI_PG_USER: 'synthetic-admin', OWNAPI_PG_POOL_WORKER_MAX: '1', OWNAPI_PG_WORKER_RUNNER_POOL_MAX: '3', OWNAPI_PG_REQUIRE_PASSWORDS: '1', OWNAPI_PG_WORKER_PASSWORD: 'synthetic-runner', OWNAPI_PG_PASSWORD_FILE: 'unused-admin' };
  const log = console.log;
  try {
    Object.assign(process.env, env); console.log = () => {};
    await fakePools(async created => {
      assert.equal(await workerMain(['--once']), 0);
      assert.equal(created.length, 1); assert.equal(created[0].options.max, 3);
      assert.equal(created[0].options.user, 'hatoove_worker'); assert.equal(created[0].ended, true);
    });
  } finally { console.log = log; for (const key of Object.keys(env)) delete process.env[key]; }
});

check('actual migrator/provisioner use migration allocation and close on refusal', async () => {
  const config = persistentConfig({ OWNAPI_PG_POOL_ADMIN_MAX: '1', OWNAPI_PG_POOL_MIGRATION_MAX: '1' });
  for (const run of [migrate, provisionPersistent]) await fakePools(async created => {
    await assert.rejects(run({ config }), /offline_stop_at_migration/);
    assert.equal(created.length, 2); assert.deepEqual(created.map(value => value.options.max), [1, 1]);
    assert.ok(created.every(value => value.ended));
  }, async (p, text) => {
    if (p.options.user === config.roles.migration) throw Error('offline_stop_at_migration');
    if (text.startsWith('SELECT rolname')) return { rows: Object.values(config.roles).map(rolname => ({ rolname })) };
    return { rows: [] };
  });
});

check('supplied admin fields and password overrides remain effective', () => {
  const original = persistentConfig({ OWNAPI_PG_REQUIRE_PASSWORDS: '1', OWNAPI_PG_PASSWORD: 'synthetic-original' });
  const config = { ...original, admin: { ...original.admin, host: 'changed.example', port: 6432, database: 'changed_db', user: 'hatoove_nonexistent_admin', password: 'wrong-by-design' } };
  const actual = pool(config, 'admin').options;
  assert.equal(actual.user, 'hatoove_nonexistent_admin'); assert.equal(actual.password, 'wrong-by-design');
  assert.equal(actual.host, 'changed.example'); assert.equal(actual.port, 6432); assert.equal(actual.database, 'changed_db');
  config.passwords.learner = 'synthetic-overridden';
  assert.equal(pool(config, 'learner').options.password, 'synthetic-overridden');
  fixed(() => pool({ ...config, admin: { ...config.admin, password: '' } }, 'admin'), 'postgres_secret_invalid');
});

check('TLS modes are explicit against ambient downgrade on both builders', () => {
  process.env.PGSSLMODE = 'no-verify';
  try {
    // Counterfactual retained builder: omission really would consume the ambient downgrade.
    assert.equal(new pg.Client({ host: 'db.example' }).connectionParameters.ssl.rejectUnauthorized, false);
    for (const role of ['admin', 'learner']) {
      const selected = options({ OWNAPI_PG_TLS_MODE: 'verify-full', OWNAPI_PG_HOST: 'db.example' }, role);
      assert.deepEqual(new pg.Client(selected).connectionParameters.ssl, { rejectUnauthorized: true });
      assert.equal(new pg.Client(options({}, role)).connectionParameters.ssl, false);
    }
    const tampered = persistentConfig({ OWNAPI_PG_TLS_MODE: 'verify-full', OWNAPI_PG_HOST: 'db.example' });
    tampered.admin.ssl = { rejectUnauthorized: false, checkServerIdentity() {} };
    tampered.admin.connectionString = 'postgres://synthetic@wrong.invalid/db?sslmode=no-verify';
    const retained = new pg.Client(pool(tampered, 'admin').options).connectionParameters;
    assert.equal(retained.host, 'db.example'); assert.deepEqual(retained.ssl, { rejectUnauthorized: true });
    for (const mode of ['', 'require', 'no-verify', 'VERIFY-FULL', 'verify-full\n']) fixed(() => persistentConfig({ OWNAPI_PG_TLS_MODE: mode }), 'postgres_configuration_invalid');
  } finally { delete process.env.PGSSLMODE; }
});

check('CA files validate before connections and use no custom verifier', () => {
  const ca = file(tls.rootCertificates[0] + '\n' + tls.rootCertificates[1]);
  for (const role of ['admin', 'learner']) {
    const ssl = options({ OWNAPI_PG_TLS_MODE: 'verify-full', OWNAPI_PG_TLS_CA_FILE: ca }, role).ssl;
    assert.equal(ssl.rejectUnauthorized, true); assert.equal(ssl.ca, tls.rootCertificates[0] + '\n' + tls.rootCertificates[1]);
    assert.equal(ssl.checkServerIdentity, undefined); assert.equal(ssl.servername, undefined);
  }
  for (const path of ['', join(temporary, 'missing'), file(''), file('not a certificate'), file(tls.rootCertificates[0] + '\nSECRET'), file(Buffer.from([0xff]))]) fixed(() => persistentConfig({ OWNAPI_PG_TLS_MODE: 'verify-full', OWNAPI_PG_TLS_CA_FILE: path }), 'postgres_tls_ca_invalid');
  fixed(() => persistentConfig({ OWNAPI_PG_TLS_CA_FILE: ca }), 'postgres_configuration_invalid');
});

check('locked pg TLS upgrade preserves DNS and IP identity inputs', () => {
  const original = stream.getSecureStream;
  try {
    for (const host of ['db.example', '127.0.0.1', '::1']) {
      let observed;
      stream.getSecureStream = value => { observed = value; return new EventEmitter(); };
      const selected = options({ OWNAPI_PG_TLS_MODE: 'verify-full', OWNAPI_PG_HOST: host });
      const connection = new Connection({ stream: new EventEmitter(), ssl: selected.ssl });
      connection.upgradeToSSL(selected.host, () => {});
      assert.equal(observed.host, host); assert.equal(observed.rejectUnauthorized, true);
      assert.equal(observed.servername, net.isIP(host) ? undefined : host);
    }
  } finally { stream.getSecureStream = original; }
  const certificate = { subjectaltname: 'DNS:db.example, IP Address:127.0.0.1, IP Address:0:0:0:0:0:0:0:1' };
  for (const host of ['db.example', '127.0.0.1', '::1']) assert.equal(tls.checkServerIdentity(host, certificate), undefined);
  for (const host of ['wrong.example', '127.0.0.2', '::2']) assert.equal(tls.checkServerIdentity(host, certificate)?.code, 'ERR_TLS_CERT_ALTNAME_INVALID');
  for (const host of ['/socket', '[::1]', 'host/path', 'a..b', 'a:b', 'localhost\n']) assert.throws(() => options({ OWNAPI_PG_TLS_MODE: 'verify-full', OWNAPI_PG_HOST: host }), /^Error: postgres_(configuration|tls_host)_invalid$/);
});

check('strict credentials ignore ambient password and unused files', () => {
  process.env.PGPASSWORD = 'synthetic-ambient-must-not-authorize';
  try {
    for (const role of ['admin', 'learner']) fixed(() => options({ OWNAPI_PG_REQUIRE_PASSWORDS: '1' }, role), 'postgres_password_required');
    const config = persistentConfig({ OWNAPI_PG_REQUIRE_PASSWORDS: '1', OWNAPI_PG_WORKER_PASSWORD: 'synthetic-explicit', OWNAPI_PG_PASSWORD_FILE: 'missing-unused', OWNAPI_PG_AUTH_PASSWORD: '', OWNAPI_PG_AUTH_PASSWORD_FILE: '' });
    assert.equal(pool(config, 'worker').options.password, 'synthetic-explicit');
    fixed(() => pool(config, 'admin'), 'postgres_secret_invalid');
    fixed(() => pool(config, 'auth'), 'postgres_secret_conflict');
  } finally { delete process.env.PGPASSWORD; }
  for (const value of ['', 'true', '2', 1]) fixed(() => persistentConfig({ OWNAPI_PG_REQUIRE_PASSWORDS: value }), 'postgres_configuration_invalid');
});

check('file credentials remove exactly one terminal line ending and retain bytes', () => {
  for (const ending of ['', '\n', '\r\n']) {
    const path = file('synthetic-ä-秘密 ' + ending);
    for (const role of ['admin', 'learner']) {
      const key = role === 'admin' ? 'OWNAPI_PG_PASSWORD_FILE' : 'OWNAPI_PG_LEARNER_PASSWORD_FILE';
      assert.equal(options({ [key]: path, OWNAPI_PG_REQUIRE_PASSWORDS: '1' }, role).password, 'synthetic-ä-秘密 ');
    }
  }
  assert.equal(options({ OWNAPI_PG_LEARNER_PASSWORD_FILE: file('x'.repeat(4096) + '\r\n') }).password.length, 4096);
  assert.equal(options({ OWNAPI_PG_LEARNER_PASSWORD_FILE: file('ä'.repeat(2048)) }).password.length, 2048);
  assert.equal(options({ OWNAPI_PG_LEARNER_PASSWORD_FILE: file('\ufeffsynthetic') }).password, '\ufeffsynthetic');
  for (const value of ['', '\n', 'x\n\n', 'x\r', 'x\0y', 'x\ny', 'x'.repeat(4097), 'ä'.repeat(2049), Buffer.from([0xc3, 0x28])]) fixed(() => options({ OWNAPI_PG_LEARNER_PASSWORD_FILE: file(value) }), 'postgres_secret_invalid');
  fixed(() => options({ OWNAPI_PG_LEARNER_PASSWORD_FILE: temporary }), 'postgres_secret_invalid');
});

check('literal conflicts/invalid values and errors stay closed and redacted', () => {
  for (const literal of ['', 'synthetic-secret']) fixed(() => options({ OWNAPI_PG_LEARNER_PASSWORD: literal, OWNAPI_PG_LEARNER_PASSWORD_FILE: '' }), 'postgres_secret_conflict');
  for (const value of ['secret\n', 'secret\r', 'secret\0', '\ud800', 'x'.repeat(4097), 42]) fixed(() => options({ OWNAPI_PG_LEARNER_PASSWORD: value }), 'postgres_secret_invalid');
  assert.equal(options({ OWNAPI_PG_LEARNER_PASSWORD: ' spaced ' }).password, ' spaced ');
  assert.equal(options({ OWNAPI_PG_LEARNER_PASSWORD: '\ufeffsynthetic' }).password, '\ufeffsynthetic');
  fixed(() => persistentConfig({ OWNAPI_PG_SCHEMA: 'sensitive/invalid' }), 'postgres_configuration_invalid');
});

check('missing role preflight rejects before any provisioning DDL', async () => {
  const config = persistentConfig({ OWNAPI_PG_REQUIRE_PASSWORDS: '1', OWNAPI_PG_MIGRATION_PASSWORD: 'synthetic-migration' });
  const queries = [];
  const admin = { async query(text) { queries.push(text); return { rows: [] }; } };
  await assert.rejects(ensureRolesAndSchema(admin, config), /postgres_password_required/);
  assert.equal(queries.length, 1); assert.ok(queries[0].startsWith('SELECT rolname'));
});

check('existing roles never read unused credentials or rotate passwords', async () => {
  const config = persistentConfig({ OWNAPI_PG_REQUIRE_PASSWORDS: '1', OWNAPI_PG_AUTH_PASSWORD_FILE: 'missing-unused', OWNAPI_PG_MIGRATION_PASSWORD_FILE: 'missing-unused' });
  const queries = [];
  await ensureRolesAndSchema({ async query(text, values) {
    queries.push(text);
    if (text.startsWith('SELECT rolname')) { assert.deepEqual(values, [Object.values(config.roles)]); return { rows: Object.values(config.roles).map(rolname => ({ rolname })) }; }
    return { rows: [] };
  } }, config);
  assert.equal(queries.length, 3); assert.ok(!queries.some(text => /CREATE ROLE|ALTER ROLE|PASSWORD/.test(text)));
});

check('new role retains exact restricted attributes and safe password quoting', async () => {
  const config = persistentConfig({ OWNAPI_PG_REQUIRE_PASSWORDS: '1', OWNAPI_PG_AUTH_PASSWORD: "synthetic'quote\\slash$$$hatoove_role_0$" });
  const queries = [];
  await ensureRolesAndSchema({ async query(text) {
    queries.push(text);
    return { rows: text.startsWith('SELECT rolname') ? Object.entries(config.roles).filter(([role]) => role !== 'auth').map(([, rolname]) => ({ rolname })) : [] };
  } }, config);
  const creation = queries.find(text => text.includes('CREATE ROLE'));
  assert.match(creation, /LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 10/);
  assert.ok(creation.includes("PASSWORD E'synthetic''quote\\\\slash$$$hatoove_role_0$'"));
  assert.ok(creation.startsWith('DO $hatoove_role_1$')); assert.equal(creation.split('$hatoove_role_1$').length, 3);
  assert.equal(queries.filter(text => text.includes('CREATE ROLE')).length, 1);
});

check('local trust provisioning creates eight restricted roles with NULL passwords', async () => {
  const queries = [];
  await ensureRolesAndSchema({ async query(text) { queries.push(text); return { rows: [] }; } }, persistentConfig({}));
  const creation = queries.filter(text => text.includes('CREATE ROLE'));
  assert.equal(creation.length, 8); assert.ok(creation.every(text => text.includes('CONNECTION LIMIT 10 PASSWORD NULL')));
  assert.equal(queries[1].startsWith('REVOKE CREATE, TEMPORARY'), true);
  assert.equal(queries.at(-1), 'CREATE SCHEMA IF NOT EXISTS "hatoove" AUTHORIZATION "hatoove_migration"');
});

check('unchanged Compose empty literal works only in local trust mode', async () => {
  for (const strict of [undefined, '0', '1']) {
    const mode = strict === undefined ? {} : { OWNAPI_PG_REQUIRE_PASSWORDS: strict };
    for (const role of ['admin', 'payments']) {
      const key = role === 'admin' ? 'OWNAPI_PG_PASSWORD' : 'OWNAPI_PG_PAYMENTS_PASSWORD';
      const env = { ...mode, [key]: '' };
      if (strict === '1') fixed(() => options(env, role), 'postgres_secret_invalid');
      else assert.equal(options(env, role).password, null);
      fixed(() => options({ ...env, [`${key}_FILE`]: '' }, role), 'postgres_secret_conflict');
      fixed(() => options({ ...mode, [`${key}_FILE`]: file('') }, role), 'postgres_secret_invalid');
    }
    const config = persistentConfig({ ...mode, OWNAPI_PG_PAYMENTS_PASSWORD: '' });
    const queries = [];
    const admin = { async query(text) {
      queries.push(text);
      return { rows: text.startsWith('SELECT rolname') ? Object.entries(config.roles).filter(([role]) => role !== 'payments').map(([, rolname]) => ({ rolname })) : [] };
    } };
    if (strict === '1') {
      await assert.rejects(ensureRolesAndSchema(admin, config), /postgres_secret_invalid/);
      assert.equal(queries.length, 1); assert.ok(queries[0].startsWith('SELECT rolname'));
    } else {
      await ensureRolesAndSchema(admin, config);
      assert.equal(queries.filter(text => text.includes('CREATE ROLE')).length, 1);
      assert.ok(queries.find(text => text.includes('CREATE ROLE')).includes('PASSWORD NULL'));
      await fakePools(async created => {
        const runtime = await openRuntimePools({ config });
        assert.equal(created.length, 6); assert.equal(runtime.payments.options.password, null);
        await closeRuntimePools(runtime); assert.ok(created.every(value => value.ended));
      });
    }
  }
});

let passed = 0;
try {
  for (const { name, run } of checks) { await run(); console.log(`ok ${++passed} - ${name}`); }
  console.log(`PostgreSQL configuration: ${passed}/${checks.length} offline groups passed; no database or TLS handshake executed.`);
} finally {
  for (const value of poolList) await value.end();
  net.Socket.prototype.connect = originalConnect;
  for (const key of Object.keys(process.env).filter(key => key.startsWith('OWNAPI_PG_'))) delete process.env[key];
  for (const [key, value] of Object.entries(priorEnv)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  rmSync(temporary, { recursive: true, force: true });
}

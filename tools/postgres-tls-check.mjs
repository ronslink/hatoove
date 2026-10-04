#!/usr/bin/env node
/** PILOT-HOSTING-01: real TLS proof against a uniquely owned, disposable PostgreSQL. */
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  persistentConfig, createAdminPool, persistentRolePool, ensureRolesAndSchema,
} from '../server/owned-postgres/provision.mjs';

if (process.argv.length !== 3 || process.argv[2] !== '--run-disposable') {
  console.error('Refusing execution: pass --run-disposable for an isolated Docker TLS fixture.');
  process.exit(2);
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const id = `hatoove-pg-tls-${Date.now()}-${randomUUID().slice(0, 8)}`;
const label = `org.hatoove.tls-fixture=${id}`;
const database = 'hatoove_tls_fixture';
const roles = ['auth', 'learner', 'worker', 'deletion', 'payments', 'provisioner', 'migration'];
const dbName = `${id}-db`;
const certName = `${id}-cert`;
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), `${id}-`));
const childEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
  !/^(?:HATOVE_|HATOOVE_|OWNAPI_|B1PREP_|STRIPE_|PAYMENTS_|COMPOSE_|PG|DOCKER_(?:HOST|CONTEXT|TLS|TLS_VERIFY|CERT_PATH)$|NODE_OPTIONS$|NODE_PATH$)/i.test(key)));
const receipt = { fixture: id, checks: [], containers: [], scratch, cleanup: null };
let stage = 'initialization';
let failed = false;
let ambientSsl;
let ambientPassword;
let ambientSaved = false;
let dockerEndpoint;

function cliResult(args) {
  return spawnSync('docker', args, {
    cwd: root, env: childEnv, encoding: 'utf8', windowsHide: true,
    timeout: 90000, maxBuffer: 2 * 1024 * 1024,
  });
}

function pinLocalDocker() {
  // Context inspection reads local CLI configuration without contacting its daemon.
  const response = cliResult(['context', 'inspect']);
  if (response.error || response.status !== 0) throw new Error('local_docker_context_unavailable');
  const contexts = JSON.parse(response.stdout);
  assert.equal(contexts.length, 1, 'one Docker context required');
  const endpoint = contexts[0]?.Endpoints?.docker?.Host;
  const local = typeof endpoint === 'string' && (process.platform === 'win32'
    ? /^npipe:\/{2,4}\.\/pipe\/[A-Za-z0-9_.-]+$/.test(endpoint)
    : /^unix:\/\/\/[^?#\x00\r\n]+$/.test(endpoint));
  assert.ok(local, 'a local Docker pipe or socket is required');
  dockerEndpoint = endpoint;
  receipt.dockerEndpoint = endpoint;
}

function result(args) {
  assert.ok(dockerEndpoint, 'local Docker endpoint must be pinned first');
  return cliResult(['--host', dockerEndpoint, ...args]);
}

function docker(args) {
  const response = result(args);
  if (response.error || response.status !== 0) throw new Error('fixture_docker_command_failed');
  return response.stdout.trim();
}

function inspect(name) {
  const response = result(['container', 'inspect', name]);
  if (response.error) throw new Error('fixture_inspection_failed');
  if (response.status !== 0) {
    // A daemon failure is not evidence of absence.
    if (/No such (?:object|container)/i.test(response.stderr)) return null;
    throw new Error('fixture_inspection_failed');
  }
  return JSON.parse(response.stdout)[0];
}

function assertOwned(value, name) {
  assert.equal(value.Name, `/${name}`, 'fixture container name differs');
  assert.equal(value.Config.Labels?.['org.hatoove.tls-fixture'], id, 'fixture ownership differs');
}

async function withPool(pool, run) {
  try { return await run(pool); } finally { await pool.end(); }
}

function config(overrides = {}) {
  const env = {
    OWNAPI_PG_HOST: 'localhost', OWNAPI_PG_PORT: String(receipt.port),
    OWNAPI_PG_DATABASE: database, OWNAPI_PG_USER: 'postgres',
    OWNAPI_PG_SCHEMA: 'hatoove_tls', OWNAPI_PG_ROLE_PREFIX: 'hatoove_tls',
    OWNAPI_PG_PASSWORD_FILE: path.join(scratch, 'admin-password'),
    ...Object.fromEntries(roles.map(role => [
      `OWNAPI_PG_${role.toUpperCase()}_PASSWORD_FILE`, path.join(scratch, `${role}-password`),
    ])),
    OWNAPI_PG_REQUIRE_PASSWORDS: '1', OWNAPI_PG_TLS_MODE: 'verify-full',
    OWNAPI_PG_TLS_CA_FILE: path.join(scratch, 'ca.crt'),
    OWNAPI_PG_CONNECT_TIMEOUT_MS: '3000',
    ...overrides,
  };
  for (const key of Object.keys(env)) if (env[key] === undefined) delete env[key];
  return persistentConfig(env);
}

async function check(name, run) {
  stage = name;
  await run();
  receipt.checks.push(name);
  console.log(`PASS ${name}`);
}

const certificateErrors = new Set([
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'SELF_SIGNED_CERT_IN_CHAIN', 'DEPTH_ZERO_SELF_SIGNED_CERT',
]);

async function certificateRefusal(pool, expected) {
  await withPool(pool, async candidate => {
    let error;
    try { await candidate.query('SELECT 1'); } catch (caught) { error = caught; }
    assert.ok(error, 'connection unexpectedly succeeded');
    assert.ok(expected.has(error.code), 'connection failed for an unexpected reason');
  });
}

try {
  stage = 'local_docker_endpoint';
  pinLocalDocker();
  stage = 'existing_images';
  docker(['image', 'inspect', 'node:22-bookworm', 'postgres:17-alpine']);
  // Only synthetic credentials are written. No host .env or Docker secret is read.
  fs.writeFileSync(path.join(scratch, 'admin-password'), randomBytes(32).toString('hex'), { mode: 0o600 });
  for (const role of roles) {
    // Valid password metacharacters must survive actual provisioning SQL and SCRAM login.
    fs.writeFileSync(path.join(scratch, `${role}-password`),
      `${randomBytes(32).toString('hex')}-'\\-$$-$hatoove$-;--`, { mode: 0o600 });
  }
  fs.writeFileSync(path.join(scratch, 'server.ext'), 'subjectAltName=DNS:localhost\nextendedKeyUsage=serverAuth\n');
  fs.writeFileSync(path.join(scratch, 'pg_hba.conf'),
    'local all all trust\nhostssl all all all scram-sha-256\nhostnossl all all all reject\n');
  stage = 'fixture_certificates';
  docker(['run', '--name', certName, '--label', label, '--network', 'none', '--pull', 'never',
    '--mount', `type=bind,source=${scratch},target=/fixture`, 'node:22-bookworm', 'sh', '-ceu', [
      'cd /fixture',
      'openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj /CN=Hatoove-Disposable-CA -keyout ca.key -out ca.crt',
      'openssl req -newkey rsa:2048 -nodes -subj /CN=localhost -keyout server.key -out server.csr',
      'openssl x509 -req -in server.csr -CA ca.crt -CAkey ca.key -CAcreateserial -days 1 -extfile server.ext -out server.crt',
      'openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj /CN=Hatoove-Wrong-CA -keyout wrong-ca.key -out wrong-ca.crt',
    ].join('\n')]);

  stage = 'tls_database_start';
  docker(['run', '-d', '--name', dbName, '--label', label, '--pull', 'never',
    '--publish', '127.0.0.1::5432', '--tmpfs', '/var/lib/postgresql/data:rw',
    '--mount', `type=bind,source=${scratch},target=/fixture,readonly`,
    '--env', `POSTGRES_DB=${database}`, '--env', 'POSTGRES_PASSWORD_FILE=/fixture/admin-password',
    '--env', 'POSTGRES_HOST_AUTH_METHOD=scram-sha-256',
    '--env', 'POSTGRES_INITDB_ARGS=--auth-host=scram-sha-256 --auth-local=trust',
    'postgres:17-alpine', 'sh', '-ceu', [
      'mkdir -p /tmp/hatoove-tls',
      'cp /fixture/server.key /tmp/hatoove-tls/server.key',
      'cp /fixture/server.crt /tmp/hatoove-tls/server.crt',
      'chown postgres:postgres /tmp/hatoove-tls/server.key /tmp/hatoove-tls/server.crt',
      'chmod 600 /tmp/hatoove-tls/server.key',
      'exec docker-entrypoint.sh postgres -c ssl=on -c ssl_key_file=/tmp/hatoove-tls/server.key -c ssl_cert_file=/tmp/hatoove-tls/server.crt -c hba_file=/fixture/pg_hba.conf',
    ].join('\n')]);
  const running = inspect(dbName);
  assertOwned(running, dbName);
  assert.equal(running.Mounts.some(mount => mount.Type === 'volume'), false, 'no persistent database volume allowed');
  const binding = running.NetworkSettings.Ports['5432/tcp'];
  assert.equal(binding.length, 1, 'one loopback database binding required');
  assert.equal(binding[0].HostIp, '127.0.0.1', 'database must bind loopback only');
  receipt.port = Number(binding[0].HostPort);
  receipt.containers.push({ name: dbName, id: running.Id });
  const cert = inspect(certName);
  assertOwned(cert, certName);
  receipt.containers.push({ name: certName, id: cert.Id });

  stage = 'database_readiness';
  let ready = false;
  for (let attempt = 0; attempt < 80; attempt++) {
    const probe = result(['exec', dbName, 'pg_isready', '-h', '127.0.0.1', '-U', 'postgres', '-d', database]);
    if (probe.status === 0) { ready = true; break; }
    const state = inspect(dbName);
    assertOwned(state, dbName);
    assert.equal(state.State.Running, true, 'fixture PostgreSQL exited before readiness');
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  assert.ok(ready, 'fixture PostgreSQL did not become ready');

  ambientSsl = process.env.PGSSLMODE;
  ambientPassword = process.env.PGPASSWORD;
  ambientSaved = true;
  process.env.PGPASSWORD = 'synthetic-ambient-password-must-not-be-used';

  await check('admin_valid_ca_and_dns_identity_uses_tls', () => withPool(createAdminPool(config()), async pool => {
    const row = (await pool.query('SELECT ssl, version FROM pg_stat_ssl WHERE pid=pg_backend_pid()')).rows[0];
    assert.equal(row.ssl, true);
    assert.match(row.version, /^TLSv1\.[23]$/);
    await ensureRolesAndSchema(pool, config());
  }));

  for (const role of roles) {
    await check(`${role}_valid_ca_and_quoted_password_uses_tls`, () =>
      withPool(persistentRolePool(config(), role), async pool => {
        const row = (await pool.query('SELECT current_user, ssl FROM pg_stat_ssl WHERE pid=pg_backend_pid()')).rows[0];
        assert.equal(row.current_user, `hatoove_tls_${role}`);
        assert.equal(row.ssl, true);
      }));
  }

  for (const [name, factory] of [
    ['admin', value => createAdminPool(value)],
    ['restricted', value => persistentRolePool(value, 'learner')],
  ]) {
    await check(`${name}_rejects_untrusted_ca`, () => certificateRefusal(
      factory(config({ OWNAPI_PG_TLS_CA_FILE: path.join(scratch, 'wrong-ca.crt') })), certificateErrors));
    await check(`${name}_rejects_wrong_ip_hostname`, () => certificateRefusal(
      factory(config({ OWNAPI_PG_HOST: '127.0.0.1' })), new Set(['ERR_TLS_CERT_ALTNAME_INVALID'])));
    await check(`${name}_default_roots_reject_fixture_ca`, () => certificateRefusal(
      factory(config({ OWNAPI_PG_TLS_CA_FILE: undefined })), certificateErrors));
    await check(`${name}_ambient_no_verify_cannot_downgrade`, async () => {
      process.env.PGSSLMODE = 'no-verify';
      try {
        await certificateRefusal(factory(config({ OWNAPI_PG_TLS_CA_FILE: path.join(scratch, 'wrong-ca.crt') })), certificateErrors);
      } finally {
        if (ambientSsl === undefined) delete process.env.PGSSLMODE;
        else process.env.PGSSLMODE = ambientSsl;
      }
    });
    await check(`${name}_disabled_tls_refused_by_tls_only_host`, () =>
      withPool(factory(config({ OWNAPI_PG_TLS_MODE: 'disable', OWNAPI_PG_TLS_CA_FILE: undefined })), async pool => {
        let error;
        try { await pool.query('SELECT 1'); } catch (caught) { error = caught; }
        assert.equal(error?.code, '28000', 'plaintext must fail at PostgreSQL host authentication');
        assert.match(error.message, /no encryption/i, 'refusal must identify plaintext rather than a bad password');
      }));
  }
} catch (error) {
  failed = true;
  // Do not print driver/Docker exceptions, which may contain credentials or SQL.
  receipt.failure = { stage, reason: 'acceptance_check_failed' };
  console.error(`FAIL ${stage}: acceptance_check_failed`);
} finally {
  if (ambientSaved) {
    if (ambientSsl === undefined) delete process.env.PGSSLMODE;
    else process.env.PGSSLMODE = ambientSsl;
    if (ambientPassword === undefined) delete process.env.PGPASSWORD;
    else process.env.PGPASSWORD = ambientPassword;
  }
  const cleanup = { containersAbsent: false, scratchAbsent: false, errors: [] };
  if (dockerEndpoint) {
    for (const name of [dbName, certName]) {
      try {
        const value = inspect(name);
        if (!value) continue;
        assertOwned(value, name);
        // Exact resource identity, never a wildcard, and no retained data volume is involved.
        docker(['container', 'rm', '--force', '--volumes', value.Id]);
      } catch {
        cleanup.errors.push(`${name}:removal_not_verified`);
      }
    }
    const absent = [];
    for (const name of [dbName, certName]) {
      try {
        const verified = inspect(name) === null;
        absent.push(verified);
        if (!verified) cleanup.errors.push(`${name}:still_present`);
      } catch {
        absent.push(false);
        cleanup.errors.push(`${name}:absence_not_verified`);
      }
    }
    cleanup.containersAbsent = absent.length === 2 && absent.every(Boolean);
  } else {
    // No daemon call is permitted until pinning succeeds, so no container was attempted.
    cleanup.containersAbsent = true;
  }
  try {
    const resolvedScratch = fs.realpathSync(scratch);
    const tempRoot = fs.realpathSync(os.tmpdir());
    assert.equal(path.dirname(resolvedScratch), tempRoot, 'scratch must remain an immediate temp child');
    assert.ok(path.basename(resolvedScratch).startsWith(`${id}-`), 'scratch identity differs');
    fs.rmSync(resolvedScratch, { recursive: true, force: false });
    cleanup.scratchAbsent = !fs.existsSync(resolvedScratch);
    assert.equal(cleanup.scratchAbsent, true);
  } catch {
    cleanup.errors.push('scratch:removal_not_verified');
  }
  if (cleanup.errors.length) {
    failed = true;
    cleanup.failure = 'fixture_cleanup_not_verified';
    console.error('FAIL fixture_cleanup_not_verified');
  }
  receipt.cleanup = cleanup;
  receipt.passed = !failed;
  console.log(JSON.stringify(receipt));
  if (failed) process.exitCode = 1;
}

#!/usr/bin/env node
/** PILOT-HOSTING-01: real TLS proof against a uniquely owned, disposable PostgreSQL. */
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.argv.length !== 3 || !['--run-disposable', '--self-check'].includes(process.argv[2])) {
  console.error('Refusing execution: pass --run-disposable for an isolated Docker TLS fixture, or --self-check for pure fault controls.');
  process.exit(2);
}

const poolFault = { seen: false };
async function withPool(pool, run, fault = poolFault) {
  // Keep this listener through and after end(): an idle error must never bypass cleanup.
  pool.on('error', () => { fault.seen = true; });
  let value, failure, rejected = false;
  try {
    if (fault.seen) throw new Error('fixture_pool_error');
    value = await run(pool);
  } catch (error) { rejected = true; failure = error; }
  try { await pool.end(); }
  catch (error) { if (!rejected) { rejected = true; failure = error; } }
  if (fault.seen) throw new Error('fixture_pool_error');
  if (rejected) throw failure;
  return value;
}

/** A killed or unstarted CLI cannot establish whether its daemon mutation completed. */
function uncertainMutation(args, response) {
  const operation = args[0] === 'run' ? 'container_run'
    : args[0] === 'container' && args[1] === 'rm' ? 'container_remove' : null;
  if (!operation) return null;
  return response.error || response.signal || response.status === null || response.status === undefined
    || [130, 137, 143].includes(response.status) ? operation : null;
}

function cleanupDisposition(cleanup, uncertainOperations) {
  if (uncertainOperations.length) {
    cleanup.containersAbsent = false;
    cleanup.scratchRetained = true;
    cleanup.errors.push('daemon_operation_outcome_unresolved');
    return false;
  }
  return true;
}

async function runFixture() {
const {
  persistentConfig, createAdminPool, persistentRolePool, ensureRolesAndSchema,
} = await import('../server/owned-postgres/provision.mjs');
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
const receipt = { fixture: id, checks: [], containers: [], scratch, cleanup: null, uncertainOperations: [],
  recoveryScope: { label, containerNames: [dbName, certName] } };
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
  let response;
  try { response = cliResult(['--host', dockerEndpoint, ...args]); }
  catch { response = { status: null, error: true }; }
  const operation = uncertainMutation(args, response);
  if (operation) receipt.uncertainOperations.push({ operation,
    identity: operation === 'container_run' ? args[args.indexOf('--name') + 1] : args.at(-1),
    reason: 'daemon_operation_outcome_unresolved' });
  return response;
}

function docker(args) {
  const response = result(args);
  if (uncertainMutation(args, response)) throw new Error('daemon_operation_outcome_unresolved');
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
  if (poolFault.seen) throw new Error('fixture_pool_error');
  await run();
  if (poolFault.seen) throw new Error('fixture_pool_error');
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
      // The scratch directory is 0700 and owned by the invoking user, so the
      // unprivileged server cannot read a file bind-mounted from it: libpq's own
      // initdb-time server fails with "could not load pg_hba.conf" and the container
      // exits. Copy it into the container's directory like the key and certificate.
      'cp /fixture/pg_hba.conf /tmp/hatoove-tls/pg_hba.conf',
      'chown postgres:postgres /tmp/hatoove-tls/server.key /tmp/hatoove-tls/server.crt /tmp/hatoove-tls/pg_hba.conf',
      'chmod 600 /tmp/hatoove-tls/server.key',
      'chmod 644 /tmp/hatoove-tls/pg_hba.conf',
      'exec docker-entrypoint.sh postgres -c ssl=on -c ssl_key_file=/tmp/hatoove-tls/server.key -c ssl_cert_file=/tmp/hatoove-tls/server.crt -c hba_file=/tmp/hatoove-tls/pg_hba.conf',
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
  let attempts = 0;
  // A deadline rather than a fixed small attempt count, and fail at once when the
  // server has exited: burning the budget only produces a generic reason, which is
  // exactly what made the first failure of this stage undiagnosable.
  while (attempts < 240) {
    attempts += 1;
    const probe = result(['exec', dbName, 'pg_isready', '-q', '-h', '127.0.0.1', '-p', '5432', '-U', 'postgres', '-d', database]);
    if (probe.status === 0) { ready = true; break; }
    const state = inspect(dbName);
    assertOwned(state, dbName);
    if (state.State.Running !== true) {
      receipt.readiness = { attempts, status: state.State.Status ?? null, exitCode: state.State.ExitCode ?? null, oomKilled: state.State.OOMKilled ?? null };
      assert.fail('fixture PostgreSQL exited before readiness');
    }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  if (receipt.readiness === undefined) receipt.readiness = { attempts, status: 'running', exitCode: null, oomKilled: null };
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
  const reason = poolFault.seen ? 'fixture_pool_error' : 'acceptance_check_failed';
  receipt.failure = { stage, reason };
  console.error(`FAIL ${stage}: ${reason}`);
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
        if (!receipt.containers.some(row => row.id === value.Id)) receipt.containers.push({ name, id: value.Id });
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
  if (cleanupDisposition(cleanup, receipt.uncertainOperations)) try {
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
  if (poolFault.seen) {
    failed = true;
    receipt.failure = { stage, reason: 'fixture_pool_error' };
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
}

async function selfCheck() {
  const sentinel = 'PRIVATE_POOL_ERROR_SENTINEL';
  assert.throws(() => new EventEmitter().emit('error', new Error(sentinel)), new RegExp(sentinel));
  for (const phase of ['during_operation', 'during_teardown']) {
    const fault = { seen: false }, pool = new EventEmitter();
    let ended = false, continued = false, passed = false, diagnostic;
    pool.end = async () => {
      ended = true;
      if (phase === 'during_teardown') queueMicrotask(() => pool.emit('error', new Error(sentinel)));
      await Promise.resolve();
    };
    try {
      await withPool(pool, async candidate => {
        if (phase === 'during_operation') queueMicrotask(() => candidate.emit('error', new Error(sentinel)));
        await Promise.resolve();
        return 'completed';
      }, fault);
      passed = true;
    } catch (error) { diagnostic = error.message; }
    finally { continued = true; }
    assert.equal(ended, true); assert.equal(continued, true); assert.equal(passed, false);
    assert.equal(diagnostic, 'fixture_pool_error'); assert.equal(fault.seen, true);
    assert.ok(!JSON.stringify({ diagnostic }).includes(sentinel));
  }
  const lateFault = { seen: false }, latePool = new EventEmitter();
  latePool.end = async () => {};
  assert.equal(await withPool(latePool, async () => 42, lateFault), 42);
  assert.doesNotThrow(() => latePool.emit('error', new Error(sentinel)));
  assert.equal(lateFault.seen, true);
  const nextPool = new EventEmitter(); let nextCalled = false, nextEnded = false;
  nextPool.end = async () => { nextEnded = true; };
  await assert.rejects(withPool(nextPool, async () => { nextCalled = true; }, lateFault), { message: 'fixture_pool_error' });
  assert.equal(nextCalled, false); assert.equal(nextEnded, true);
  const clean = { seen: false }, rejectedPool = new EventEmitter();
  let rejectedEnded = false;
  rejectedPool.end = async () => { rejectedEnded = true; };
  await assert.rejects(withPool(rejectedPool, async () => { throw new Error('expected_operation_failure'); }, clean), /expected_operation_failure/);
  assert.equal(rejectedEnded, true);
  const endPool = new EventEmitter(); endPool.end = async () => { throw new Error('expected_end_failure'); };
  await assert.rejects(withPool(endPool, async () => 1, { seen: false }), /expected_end_failure/);
  const outcomes = [
    [{ status: 0 }, null], [{ status: 1 }, null],
    [{ status: null, error: new Error(sentinel) }, 'container_run'],
    [{ status: null, signal: 'SIGTERM' }, 'container_run'], [{ status: null }, 'container_run'],
    [{}, 'container_run'], [{ status: 130 }, 'container_run'], [{ status: 137 }, 'container_run'], [{ status: 143 }, 'container_run'],
  ];
  for (const [response, expected] of outcomes) assert.equal(uncertainMutation(['run', '--name', 'synthetic'], response), expected);
  assert.equal(uncertainMutation(['container', 'rm', '--force', 'synthetic'], { status: null }), 'container_remove');
  assert.equal(uncertainMutation(['container', 'inspect', 'synthetic'], { status: null }), null);
  const cleanup = { containersAbsent: true, scratchAbsent: false, errors: [] };
  const uncertain = [{ operation: 'container_run', identity: 'synthetic', reason: 'daemon_operation_outcome_unresolved' }];
  assert.equal(cleanupDisposition(cleanup, uncertain), false);
  assert.equal(cleanup.containersAbsent, false); assert.equal(cleanup.scratchRetained, true);
  assert.deepEqual(cleanup.errors, ['daemon_operation_outcome_unresolved']);
  assert.ok(!JSON.stringify({ cleanup, uncertain }).includes(sentinel));
  assert.equal(cleanupDisposition({ errors: [] }, []), true);
  console.log('PASS TLS checker offline: 6 pool error controls; 11 command-result controls; 2 cleanup-disposition controls; no database, subprocess or network');
}

if (process.argv[2] === '--self-check') {
  try { await selfCheck(); }
  catch { console.error('FAIL tls_checker_self_check_failed'); process.exitCode = 1; }
} else await runFixture();

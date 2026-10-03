#!/usr/bin/env node
/** Disposable diagnostic only. No erasure SLA, retention limit, provider call or optimisation claim. */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { EventEmitter } from 'node:events';
import { createPostgresAccountDeletion, ACCOUNT_DELETION_STEPS, ACCOUNT_TABLES } from '../server/owned-postgres/adapter.mjs';

const COHORTS = Object.freeze([100, 1000, 10000]);
const LIMITS = Object.freeze({ lockMs: 2000, statementMs: 15000, deletionMs: 30000, cancelGraceMs: 5000, sampleMs: 100, maxSamples: 420 });
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const normal = (sql) => String(sql).replace(/\s+/g, ' ').trim();
const labels = new Map([
  ['BEGIN', 'begin'], ['COMMIT', 'commit'], ['ROLLBACK', 'rollback'],
  ["SELECT set_config('hatoove.owner_id', $1, true)", 'owner_context'],
  ['SELECT pg_advisory_xact_lock(hashtextextended($1, 7352))', 'owner_fence'],
  ['SELECT 1 FROM entitlements WHERE owner_id = $1 ORDER BY exam_id FOR UPDATE', 'balance_locks'],
  ['SELECT id FROM attempts WHERE owner_id = $1', 'capture_attempt_ids'],
  ["SELECT set_config('hatoove.deleting_attempts', $1, true)", 'draft_context'],
  ['SELECT id FROM "user" WHERE id = $1 FOR UPDATE', 'user_lock'],
  ...ACCOUNT_DELETION_STEPS.map(([name, sql]) => [sql, `delete:${name}`]),
  ...ACCOUNT_TABLES.map(([name, predicate]) => [`SELECT count(*)::int AS n FROM ${name} WHERE ${predicate}`, `verify:${name.replaceAll('"', '')}`]),
].map(([sql, label]) => [normal(sql), label]));

export function guardErasureFixture(env = process.env) {
  if (env.OWNAPI_PG_ALLOW !== '1' || env.OWNAPI_PG_HOST !== '127.0.0.1' || env.OWNAPI_PG_PORT !== '62563'
    || env.OWNAPI_PG_DATABASE !== 'hatoove_spike' || env.OWNAPI_PG_USER !== 'postgres') throw Error('erasure_fixture_refused');
}
export function parseOptions(args) {
  if (args.length === 0 || (args.length === 1 && args[0] === '--offline')) return { postgres: false, cohorts: [] };
  if (args[0] !== '--postgres' || args.length > 2) throw Error('erasure_arguments_refused');
  if (args.length === 1) return { postgres: true, cohorts: [...COHORTS] };
  const match = /^--cohort=(100|1000|10000)$/.exec(args[1]);
  if (!match) throw Error('erasure_cohort_refused');
  return { postgres: true, cohorts: [Number(match[1])] };
}
export function stepLabel(sql) {
  const label = labels.get(normal(sql));
  if (!label) throw Error('erasure_unrecognised_sql_step');
  return label;
}
function errorCode(error) {
  return /^[A-Z0-9]{5}$/.test(error?.code || '') ? error.code : null;
}
function restore(key, value) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
function watchErrors(emitter, surface, state, onError = () => {}) {
  emitter.on('error', (error) => {
    // EventEmitter errors otherwise throw outside query promises. Never forward raw error text.
    state.faults.push({ surface, code: errorCode(error) }); state.aborted = true; onError();
  });
}
function watchPool(pool, surface, state, onError = () => {}) {
  watchErrors(pool, surface, state, onError);
  const watchClient = (client) => {
    if (state.clients.has(client)) return;
    state.clients.add(client); watchErrors(client, `${surface}:client`, state, onError);
  };
  // Existing idle fixture clients are covered by the pool; acquire also covers them before reuse.
  pool.on('connect', watchClient); pool.on('acquire', watchClient);
}
function requireHealthy(state) { if (state.aborted) throw Error('erasure_database_error'); }

// Never print SQL, query arguments, source rows, account IDs, tokens, passwords or private feedback.
async function inventory(observer) {
  return (await observer.query(`SELECT 'schema:'||nspname AS identity FROM pg_namespace WHERE nspname ~ '^ownapi_[0-9a-f]{16}$'
    UNION SELECT 'role:'||rolname FROM pg_roles WHERE rolname ~ '^ownapi_[0-9a-f]{16}_'
    UNION SELECT 'connection:'||application_name||':'||usename FROM pg_stat_activity
      WHERE application_name ~ '^ownapi_[0-9a-f]{16}$' OR usename ~ '^ownapi_[0-9a-f]{16}_'
    ORDER BY identity`)).rows.map((row) => row.identity);
}
async function ownerSnapshot(client, owner, savedAttemptIds = null) {
  const ids = savedAttemptIds ?? (await client.query('SELECT id FROM attempts WHERE owner_id=$1 ORDER BY id', [owner])).rows.map((r) => r.id);
  const tables = [];
  for (const [table, predicate, bind] of ACCOUNT_TABLES) {
    const row = (await client.query(`SELECT count(*)::int AS count,
      encode(sha256(convert_to(coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]'::jsonb)::text,'UTF8')),'hex') AS digest
      FROM ${table} t WHERE ${predicate}`, [bind === 'attempts' ? ids : owner])).rows[0];
    tables.push({ table, ...row });
  }
  return { ids, tables };
}

const BACKEND_WHERE = 'pid=$1 AND backend_start::text=$2 AND usename=$3 AND datname=$4 AND application_name=$5';
async function backendRow(observer, identity) {
  return (await observer.query(`SELECT pid,state,xact_start IS NULL AS outside_transaction,wait_event_type,wait_event,
    pg_blocking_pids(pid) AS blockers FROM pg_stat_activity WHERE ${BACKEND_WHERE}`, identity)).rows[0] ?? null;
}
async function waitForIdle(observer, identity, absentOnly = false) {
  const deadline = performance.now() + 2000;
  do {
    const row = await backendRow(observer, identity);
    if (row === null || (!absentOnly && row.state === 'idle' && row.outside_transaction)) return row;
    await pause(25);
  } while (performance.now() < deadline);
  throw Error('erasure_backend_did_not_settle');
}
async function signalBackend(observer, identity, terminate = false) {
  // The PID alone is insufficient: backend_start, restricted role, database and random fixture name must still match.
  const row = (await observer.query(`SELECT ${terminate ? 'pg_terminate_backend(pid,5000)' : 'pg_cancel_backend(pid)'} AS signalled
    FROM pg_stat_activity WHERE ${BACKEND_WHERE}`, identity)).rows[0];
  if (!row?.signalled) throw Error('erasure_backend_signal_unconfirmed');
}

async function measuredDeletion({ db, observer, pg, state, owner, mode = 'measure', blockerPid = null }) {
  const result = { mode, status: 'failed', limits: LIMITS, steps: [], samples: [], cancelled: false, terminated: false, rollbackVerified: false };
  const pool = new pg.Pool({ host: '127.0.0.1', port: 62563, database: 'hatoove_spike', user: db.roles.deletion,
    max: 1, connectionTimeoutMillis: 5000, application_name: db.schema,
    options: `-c search_path=${db.schema},pg_catalog -c lock_timeout=${LIMITS.lockMs} -c statement_timeout=${LIMITS.statementMs} -c idle_in_transaction_session_timeout=10000` });
  let client, identity, stopped = false, abortReason = null, activeStep = 'connect', monitor, operation, operationSettled = false;
  let value, caught, connectionError = null;
  watchPool(pool, 'deletion', state, () => { connectionError = true; abortReason ??= 'database_error'; });
  const started = performance.now();
  try {
    client = await pool.connect();
    requireHealthy(state);
    const own = (await client.query('SELECT pg_backend_pid() AS pid,current_user AS role,current_schema() AS schema')).rows[0];
    assert.equal(own.role, db.roles.deletion); assert.equal(own.schema, db.schema);
    const exact = (await observer.query('SELECT backend_start::text AS started,usename,datname,application_name FROM pg_stat_activity WHERE pid=$1', [own.pid])).rows[0];
    assert.equal(exact.usename, db.roles.deletion); assert.equal(exact.datname, 'hatoove_spike'); assert.equal(exact.application_name, db.schema);
    identity = [own.pid, exact.started, exact.usename, exact.datname, exact.application_name];
    result.backend = { pid: own.pid, started: exact.started, role: own.role, schema: own.schema };
    const wrapped = { async connect() { return { release() {}, async query(sql, args) {
      const label = stepLabel(sql);
      if (state.aborted) abortReason ??= 'database_error';
      if (abortReason && label !== 'rollback') throw Error('erasure_cancelled');
      activeStep = label; const start = performance.now(); let outcome = 'ok', code = null, rowCount = null;
      try { const reply = await client.query(sql, args); rowCount = reply.rowCount; return reply; }
      catch (error) { outcome = 'error'; code = errorCode(error); throw error; }
      finally { result.steps.push({ label, elapsedMs: Math.round((performance.now() - start) * 1000) / 1000, outcome, code, rowCount }); }
    } }; } };
    operation = createPostgresAccountDeletion({ pool: wrapped, afterStep: (_index, name) => {
      if (mode === 'rollback_control' && name === 'provider_attempt') throw Error('erasure_injected_rollback');
    } }).deleteAccount(owner).then((reply) => { value = reply; }, (error) => { caught = error; }).finally(() => { operationSettled = true; });
    monitor = (async () => {
      while (!stopped && !operationSettled) {
        requireHealthy(state);
        const elapsedMs = Math.round(performance.now() - started);
        const row = await backendRow(observer, identity);
        if (operationSettled) break;
        if (!row) { if (!result.terminated) throw Error('erasure_backend_disappeared'); break; }
        if (result.samples.length >= LIMITS.maxSamples) throw Error('erasure_sample_limit');
        result.samples.push({ elapsedMs, step: activeStep, ...row });
        const cancelControl = mode === 'cancel_control' && row.wait_event === 'advisory' && row.blockers.includes(blockerPid);
        if (!abortReason && (cancelControl || elapsedMs >= LIMITS.deletionMs)) {
          abortReason = cancelControl ? 'cancel_control' : 'overall_deadline';
          await signalBackend(observer, identity); result.cancelled = true;
        }
        if (elapsedMs >= LIMITS.deletionMs + LIMITS.cancelGraceMs && !result.terminated) {
          await signalBackend(observer, identity, true); result.terminated = true;
        }
        if (elapsedMs >= LIMITS.deletionMs + LIMITS.cancelGraceMs * 2) throw Error('erasure_abort_deadline');
        await pause(LIMITS.sampleMs);
      }
    })();
    // Observer failures also end the measurement, rather than silently dropping wait evidence.
    await Promise.race([operation, monitor.then(() => operation)]);
    stopped = true; await monitor;
    requireHealthy(state);
    const after = await waitForIdle(observer, identity);
    result.rollbackVerified = Boolean(caught && (after === null || (after.state === 'idle' && after.outside_transaction))
      && (result.terminated || result.steps.some((step) => step.label === 'rollback' && step.outcome === 'ok')));
    result.elapsedMs = Math.round((performance.now() - started) * 1000) / 1000;
    result.errorCode = errorCode(caught ?? connectionError);
    if (mode === 'measure' && !caught && !abortReason && value?.verifiedAbsent && value.existed) {
      assert.equal(result.steps.at(-1).label, 'commit'); result.status = 'pass'; result.removed = value.removed;
    } else if (mode === 'rollback_control' && caught?.message === 'erasure_injected_rollback' && result.rollbackVerified) result.status = 'control_pass';
    else if (mode === 'cancel_control' && result.cancelled && caught && result.rollbackVerified) result.status = 'control_pass';
    result.failure = result.status === 'failed' ? abortReason ?? (caught?.code === '57014' ? 'statement_cancelled' : caught?.code === '55P03' ? 'lock_timeout' : 'deletion_failed') : null;
  } catch (error) {
    result.failure = error.message.startsWith('erasure_') ? error.message : 'diagnostic_failed'; result.errorCode = errorCode(error);
  } finally {
    stopped = true;
    if (operation && !operationSettled && identity) {
      try { await signalBackend(observer, identity, true); result.terminated = true; } catch { result.failure = 'erasure_final_signal_failed'; }
    }
    if (client) client.release(!operationSettled || Boolean(connectionError));
    await Promise.race([operation ?? Promise.resolve(), pause(5000)]);
    if (!operationSettled && operation) result.failure = 'erasure_operation_not_settled';
    if (monitor) await monitor.catch(() => {});
    await pool.end();
    if (identity) assert.equal(await waitForIdle(observer, identity, true), null, 'dedicated deletion backend must be gone');
  }
  return result;
}

export async function runDiagnostic(cohorts = COHORTS) {
  guardErasureFixture(); assert(cohorts.length > 0 && cohorts.every((n) => COHORTS.includes(n)));
  // Every selective run includes the small cancellation/rollback controls before larger measurements.
  const executionCohorts = [...new Set([100, ...cohorts])];
  const saved = Object.fromEntries(['B1PREP_CONTENT_MODE', 'B1PREP_SERVE_REVIEW', 'B1PREP_SERVE_RIGHTS'].map((key) => [key, process.env[key]]));
  const report = { kind: 'synthetic-account-erasure-diagnostic', status: 'failed', shape: 'one-submission,distinct-intents,no-observations',
    deadlineScope: 'per-deletion; cancellation/termination grace is additional', deletionDeadlineMs: LIMITS.deletionMs,
    connectionTimeoutMs: 5000, observerStatementTimeoutMs: 10000, bootstrapGlobalCancellation: false, requiresSupervisedOuterProcessBound: true,
    requestedCohorts: cohorts, cohorts: [], controls: [], cleanupVerified: false, performanceClaim: false };
  let db, world, observer, baseline, admin, foreign, foreignBefore;
  const state = { faults: [], clients: new WeakSet(), aborted: false };
  const pg = createRequire(new URL('../server/owned-postgres/bootstrap.mjs', import.meta.url))('pg');
  try {
    process.env.B1PREP_CONTENT_MODE = 'internal-preview'; delete process.env.B1PREP_SERVE_REVIEW; delete process.env.B1PREP_SERVE_RIGHTS;
    observer = new pg.Pool({ host: '127.0.0.1', port: 62563, database: 'hatoove_spike', user: 'postgres', max: 1,
      connectionTimeoutMillis: 5000, query_timeout: 10000, options: '-c statement_timeout=10000 -c lock_timeout=2000', application_name: 'erasure-diagnostic-observer' });
    watchPool(observer, 'observer', state);
    baseline = new Set(await inventory(observer));
    const { createFixture } = await import('../server/owned-postgres/bootstrap.mjs');
    const { createPostgresWorld } = await import('../server/owned-postgres/fixture.mjs');
    const { beginProviderAttempt } = await import('../server/owned-postgres/provider-attempts.mjs');
    const { validateProviderIdentity } = await import('../server/provider-attempt-contract.mjs');
    db = await createFixture(); report.schema = db.schema;
    for (const name of ['admin', 'migration', 'auth', 'learner', 'worker', 'deletion', 'payments']) watchPool(db[name], `fixture:${name}`, state);
    requireHealthy(state); world = await createPostgresWorld({ fixture: db });
    admin = await db.admin.connect(); await admin.query("SET statement_timeout='15s'"); await admin.query("SET lock_timeout='2s'");
    report.sourceSha256 = {};
    for (const path of ['../server/owned-postgres/adapter.mjs', '../server/migrations/0038-provider-attempts.sql', './account-erasure-perf-check.mjs']) {
      report.sourceSha256[path] = createHash('sha256').update(await readFile(new URL(path, import.meta.url))).digest('hex');
    }
    const rls = (await admin.query("SELECT relname,relrowsecurity,relforcerowsecurity FROM pg_class WHERE relnamespace=$1::regnamespace AND relname IN ('provider_attempt','provider_attempt_observation') ORDER BY relname", [db.schema])).rows;
    assert.equal(rls.length, 2); assert(rls.every((r) => r.relrowsecurity && r.relforcerowsecurity));
    const triggers = (await admin.query(`SELECT tgname,tgenabled FROM pg_trigger WHERE tgrelid IN
      (SELECT oid FROM pg_class WHERE relnamespace=$1::regnamespace AND relname IN ('provider_attempt','provider_attempt_observation'))
      AND NOT tgisinternal ORDER BY tgname`, [db.schema])).rows;
    assert.deepEqual(triggers.map((r) => r.tgname), ['provider_attempt_guard', 'provider_attempt_truncate', 'provider_observation_accepted', 'provider_observation_guard', 'provider_observation_truncate']);
    assert(triggers.every((r) => r.tgenabled === 'O')); report.guardsAndForcedRlsVerified = true;
    const identity = validateProviderIdentity({ adapterId: 'synthetic-grader-v1', pricingCardId: 'synthetic-usd-v1' }, { builtin: false });
    async function seed(count) {
      requireHealthy(state);
      const signup = await world.sessions.signUp({ name: 'Synthetic erasure fixture', email: `erasure-${randomUUID()}@example.invalid`, password: 'synthetic-erasure-password' });
      const owner = (await world.sessions.getSession({ cookie: String(signup.setCookie).split(';')[0] })).userId;
      const prep = (await world.store.port.listPreparations(owner)).find((p) => p.state === 'active'); assert(prep);
      const attempt = await world.store.port.create(owner, null, null, prep.id);
      const draft = await world.store.port.save(owner, attempt.id, 1, 'SYNTHETIC erasure fixture letter; no learner or provider data.');
      const receipt = await world.store.port.submit(owner, attempt.id, draft.revision, randomUUID(), 'de');
      const token = randomUUID();
      const job = (await admin.query("UPDATE jobs SET status='running',tries=1,lease_token=$2,lease_until=clock_timestamp()+interval '10 minutes' WHERE submission_id=$1 RETURNING id", [receipt.submissionId, token])).rows[0];
      const worker = await db.worker.connect(); let id;
      try { await worker.query('BEGIN'); id = (await beginProviderAttempt(worker, { jobId: job.id, leaseToken: token, identity })).attemptId; await worker.query('COMMIT'); }
      catch (error) { await worker.query('ROLLBACK'); throw error; } finally { worker.release(); }
      const template = (await admin.query('SELECT to_jsonb(a) AS value FROM provider_attempt a WHERE attempt_id=$1', [id])).rows[0].value;
      // Same explicit volume seam as O01's cap fixture: all INSERT guards/FKs remain enabled.
      await admin.query(`INSERT INTO provider_attempt SELECT r.* FROM generate_series(2,$2::int) n
        CROSS JOIN LATERAL jsonb_populate_record(NULL::provider_attempt,$1::jsonb||jsonb_build_object('attempt_id',gen_random_uuid(),'claim_number',n)) r`, [JSON.stringify(template), count]);
      const counts = (await admin.query(`SELECT (SELECT count(*)::int FROM submissions WHERE owner_id=$1) submissions,
        (SELECT count(*)::int FROM provider_attempt WHERE owner_id=$1) intents,
        (SELECT count(*)::int FROM provider_attempt_observation WHERE owner_id=$1) observations`, [owner])).rows[0];
      assert.deepEqual(counts, { submissions: 1, intents: count, observations: 0 }); requireHealthy(state); return { owner, counts };
    }
    foreign = await seed(1); foreignBefore = await ownerSnapshot(admin, foreign.owner);
    for (const count of executionCohorts) {
      const target = await seed(count); const before = await ownerSnapshot(admin, target.owner);
      if (count === 100) {
        const rollback = await measuredDeletion({ db, observer, pg, state, owner: target.owner, mode: 'rollback_control' }); report.controls.push(rollback);
        assert.deepEqual(await ownerSnapshot(admin, target.owner, before.ids), before); assert.equal(rollback.status, 'control_pass');
        const blocker = await db.admin.connect();
        try {
          await blocker.query('BEGIN'); await blocker.query("SET LOCAL statement_timeout='15s'"); await blocker.query("SET LOCAL lock_timeout='2s'");
          await blocker.query('SELECT pg_advisory_xact_lock(hashtextextended($1,7352))', [target.owner]);
          const blockerPid = (await blocker.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
          const cancel = await measuredDeletion({ db, observer, pg, state, owner: target.owner, mode: 'cancel_control', blockerPid }); report.controls.push(cancel);
          assert.deepEqual(await ownerSnapshot(admin, target.owner, before.ids), before); assert.equal(cancel.status, 'control_pass');
        } finally { try { await blocker.query('ROLLBACK'); } finally { blocker.release(); } }
      }
      const measured = await measuredDeletion({ db, observer, pg, state, owner: target.owner }); report.cohorts.push({ count, cardinality: target.counts, ...measured });
      const after = await ownerSnapshot(admin, target.owner, before.ids);
      if (measured.status === 'pass') assert(after.tables.every((table) => table.count === 0), 'actual account rows remain');
      else assert.deepEqual(after, before, 'failed erasure must roll back all original rows');
      assert.deepEqual(await ownerSnapshot(admin, foreign.owner, foreignBefore.ids), foreignBefore, 'foreign owner changed');
      assert.equal(measured.status, 'pass', 'failed/timeout measurement is not acceptance');
    }
    requireHealthy(state); report.status = 'pass';
  } catch (error) { report.status = 'failed'; report.failure = error.message.startsWith('erasure_') ? error.message : 'diagnostic_assertion_or_setup_failed'; report.errorCode = errorCode(error); }
  finally {
    const cleanupErrors = [];
    if (admin && foreignBefore) {
      try { assert.deepEqual(await ownerSnapshot(admin, foreign.owner, foreignBefore.ids), foreignBefore); report.foreignPreserved = true; }
      catch { cleanupErrors.push('foreign_owner_changed_or_unverified'); }
    }
    if (admin) admin.release();
    try { if (db) await db.cleanup(); } catch { cleanupErrors.push('fixture_cleanup'); }
    try {
      if (observer && baseline) {
        assert.deepEqual((await inventory(observer)).filter((item) => !baseline.has(item)), []);
        if (db) {
          assert.equal((await observer.query('SELECT count(*)::int n FROM pg_namespace WHERE nspname=$1', [db.schema])).rows[0].n, 0);
          assert.equal((await observer.query('SELECT count(*)::int n FROM pg_roles WHERE rolname=ANY($1::text[])', [Object.values(db.roles)])).rows[0].n, 0);
          assert.equal((await observer.query('SELECT count(*)::int n FROM pg_stat_activity WHERE application_name=$1 OR usename=ANY($2::text[])', [db.schema, Object.values(db.roles)])).rows[0].n, 0);
        }
        report.cleanupVerified = true;
      }
    } catch { cleanupErrors.push('absence_verification'); }
    try { if (observer) await observer.end(); } catch { cleanupErrors.push('observer_close'); }
    for (const [key, value] of Object.entries(saved)) restore(key, value);
    if (state.faults.length) { report.databaseErrors = state.faults; cleanupErrors.push('database_emitter_error'); }
    if (cleanupErrors.length) { report.status = 'failed'; report.cleanupErrors = cleanupErrors; }
  }
  return report;
}

export async function offlineChecks() {
  const valid = { OWNAPI_PG_ALLOW: '1', OWNAPI_PG_HOST: '127.0.0.1', OWNAPI_PG_PORT: '62563', OWNAPI_PG_DATABASE: 'hatoove_spike', OWNAPI_PG_USER: 'postgres' };
  guardErasureFixture(valid);
  for (const key of Object.keys(valid)) assert.throws(() => guardErasureFixture({ ...valid, [key]: '' }), /erasure_fixture_refused/);
  assert.throws(() => guardErasureFixture({ ...valid, OWNAPI_PG_PORT: '5432', OWNAPI_PG_DATABASE: 'hatoove_ci', CI: 'true', GITHUB_ACTIONS: 'true' }));
  assert.deepEqual(parseOptions([]), { postgres: false, cohorts: [] }); assert.deepEqual(parseOptions(['--postgres']).cohorts, COHORTS);
  for (const n of COHORTS) assert.deepEqual(parseOptions(['--postgres', `--cohort=${n}`]).cohorts, [n]);
  for (const arg of ['--cohort=100001', '--cohort=0', '--cohort=0100', '--anything']) assert.throws(() => parseOptions(['--postgres', arg]));
  for (const [name, sql] of ACCOUNT_DELETION_STEPS) assert.equal(stepLabel(sql), `delete:${name}`);
  assert.equal(stepLabel('SELECT pg_advisory_xact_lock(hashtextextended($1, 7352))'), 'owner_fence');
  assert.equal(stepLabel('COMMIT'), 'commit'); assert.equal(stepLabel('ROLLBACK'), 'rollback');
  assert.throws(() => stepLabel('DELETE FROM arbitrary'), /erasure_unrecognised_sql_step/);
  const privateError = Object.assign(Error('PRIVATE offline sentinel must not enter diagnostic JSON'), { code: '57P01' });
  assert.throws(() => new EventEmitter().emit('error', privateError), (error) => error === privateError, 'old unhandled emitter behavior must throw');
  const errorState = { faults: [], clients: new WeakSet(), aborted: false };
  const poolEmitter = new EventEmitter(), clientEmitter = new EventEmitter(); let cleanupContinued = false, abortRequested = false;
  watchPool(poolEmitter, 'offline-pool', errorState, () => { abortRequested = true; });
  try {
    poolEmitter.emit('acquire', clientEmitter);
    assert.doesNotThrow(() => poolEmitter.emit('error', privateError));
    assert.doesNotThrow(() => clientEmitter.emit('error', privateError));
    assert.throws(() => requireHealthy(errorState), /erasure_database_error/);
  } finally { cleanupContinued = true; }
  assert.equal(cleanupContinued, true); assert.equal(abortRequested, true);
  assert.deepEqual(errorState.faults, [{ surface: 'offline-pool', code: '57P01' }, { surface: 'offline-pool:client', code: '57P01' }]);
  assert.equal(JSON.stringify(errorState.faults).includes('PRIVATE'), false);
  // Exercise the real port's query sequence against an in-memory pool: no implicit top-level test imports.
  for (const shouldFail of [false, true]) {
    const seen = []; let released = 0;
    const pool = { async connect() { return { release() { released++; }, async query(sql) {
      const label = stepLabel(sql); seen.push(label);
      return { rowCount: 1, rows: label === 'capture_attempt_ids' ? [{ id: '00000000-0000-4000-8000-000000000001' }] : label.startsWith('verify:') ? [{ n: 0 }] : [] };
    } }; } };
    const port = createPostgresAccountDeletion({ pool, afterStep: (_n, name) => { if (shouldFail && name === 'provider_attempt') throw Error('synthetic-offline-rollback'); } });
    if (shouldFail) { await assert.rejects(port.deleteAccount('synthetic-offline-owner'), /synthetic-offline-rollback/); assert.equal(seen.at(-1), 'rollback'); assert(!seen.includes('commit')); }
    else { assert.equal((await port.deleteAccount('synthetic-offline-owner')).verifiedAbsent, true); assert.equal(seen.at(-1), 'commit'); assert.equal(seen.filter((label) => label.startsWith('delete:')).length, ACCOUNT_DELETION_STEPS.length); }
    assert.equal(released, 1);
  }
  return { status: 'pass', targetControls: 7, cohortControls: 9, fixedDeletionLabels: ACCOUNT_DELETION_STEPS.length, actualPortOfflinePaths: 2, emitterFaultControls: 3, databaseAccess: false };
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    const options = parseOptions(process.argv.slice(2));
    const report = options.postgres ? await runDiagnostic(options.cohorts) : await offlineChecks();
    console.log(JSON.stringify(report, null, 2)); process.exitCode = report.status === 'pass' ? 0 : 1;
  } catch (error) { console.error(JSON.stringify({ status: 'failed', failure: error.message.startsWith('erasure_') ? error.message : 'diagnostic_failed' })); process.exitCode = 1; }
}

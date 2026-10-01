#!/usr/bin/env node
/**
 * PILOT-01 — the local bring-up: ONE documented sequence that produces a working installation.
 *
 * MASTER-PLAN LM-1 asks that a working local product be produced by a single documented
 * sequence, not by a list a human retypes. This tool is that sequence, and
 * `tools/local-bringup-check.mjs` drives its exports to hold it to that.
 *
 *   node tools/local-bringup.mjs            bring up the database, provision, then serve
 *   node tools/local-bringup.mjs --no-serve bring up and provision, print status, exit
 *   node tools/local-bringup.mjs --status   report what is running without changing anything
 *   node tools/local-bringup.mjs --down     stop the database container
 *   node tools/local-bringup.mjs --down --wipe   ...and remove its data volume
 *
 * WHAT IT DOES
 *   1. ensures a local PostgreSQL container exists and answers (`ensureDatabase`)
 *   2. applies the tracked migrations through the one provisioning path (`provisionLocal`)
 *   3. starts the API and the worker against it (`startRuntime`)
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 *   it never provisions as a superuser for a learner path, never calls a model provider, never
 *   sends email, and never touches `D:\B1_Prep`. The worker runs the deterministic stub grader
 *   until PILOT-06 injects a real one, so every byte of feedback produced locally is a stub.
 *
 * The database container is a NAMED, PERSISTENT local installation: unlike the fixture path it
 * keeps a volume, so a locally created account survives a restart. That is the point of a local
 * product; the checks use their own disposable containers instead.
 *
 * Configuration (all optional, `HATOVE_LOCAL_*`):
 *   HATOVE_LOCAL_CONTAINER   default hatoove-local-db
 *   HATOVE_LOCAL_VOLUME      default hatoove-local-db-data; empty string => no volume
 *   HATOVE_LOCAL_PORT        default 55440   (host port; the container's 5432)
 *   HATOVE_LOCAL_DATABASE    default hatoove
 *   HATOVE_LOCAL_USER        default postgres
 *   HATOVE_LOCAL_SCHEMA      default hatoove          (OWNAPI_PG_SCHEMA)
 *   HATOVE_LOCAL_ROLE_PREFIX default hatoove          (OWNAPI_PG_ROLE_PREFIX)
 *   HATOVE_LOCAL_APP_PORT    default 4300
 *   HATOVE_LOCAL_IMAGE       default postgres:17-alpine
 */

import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const DEFAULTS = Object.freeze({
  container: 'hatoove-local-db',
  volume: 'hatoove-local-db-data',
  port: 55440,
  database: 'hatoove',
  user: 'postgres',
  schema: 'hatoove',
  rolePrefix: 'hatoove',
  appPort: 4300,
  image: 'postgres:17-alpine',
});

const READY_TIMEOUT_MS = 45000;

/** The documented sequence. The check asserts this is non-trivial, so it is the tool's own contract. */
export const SEQUENCE = Object.freeze([
  { step: 1, name: 'database', description: 'ensure a local PostgreSQL container exists and answers' },
  { step: 2, name: 'provision', description: 'apply the tracked migrations and the least-privilege roles' },
  { step: 3, name: 'seed-report', description: 'report the seeded catalogue the runtime will serve' },
  { step: 4, name: 'runtime', description: 'start the API and the worker against that database' },
  { step: 5, name: 'serve', description: 'serve until interrupted, or stop after reporting with --no-serve' },
]);

export function localConfig(env = process.env) {
  const volume = env.HATOVE_LOCAL_VOLUME === undefined ? DEFAULTS.volume : env.HATOVE_LOCAL_VOLUME;
  return {
    container: env.HATOVE_LOCAL_CONTAINER || DEFAULTS.container,
    volume,
    port: Number(env.HATOVE_LOCAL_PORT || DEFAULTS.port),
    database: env.HATOVE_LOCAL_DATABASE || DEFAULTS.database,
    user: env.HATOVE_LOCAL_USER || DEFAULTS.user,
    schema: env.HATOVE_LOCAL_SCHEMA || DEFAULTS.schema,
    rolePrefix: env.HATOVE_LOCAL_ROLE_PREFIX || DEFAULTS.rolePrefix,
    appPort: Number(env.HATOVE_LOCAL_APP_PORT || DEFAULTS.appPort),
    image: env.HATOVE_LOCAL_IMAGE || DEFAULTS.image,
    startTimeoutMs: Number(env.HATOVE_LOCAL_START_TIMEOUT_MS || READY_TIMEOUT_MS),
  };
}

/** The `OWNAPI_PG_*` environment this installation's own modules read. Never contains a password. */
export function ownapiEnv(cfg) {
  return {
    OWNAPI_PG_HOST: '127.0.0.1',
    OWNAPI_PG_PORT: String(cfg.port),
    OWNAPI_PG_DATABASE: cfg.database,
    OWNAPI_PG_USER: cfg.user,
    OWNAPI_PG_SCHEMA: cfg.schema,
    OWNAPI_PG_ROLE_PREFIX: cfg.rolePrefix,
  };
}

// ---------------------------------------------------------------- docker plumbing

function docker(args, { allowFailure = false } = {}) {
  const result = spawnSync('docker', args, { encoding: 'utf8', windowsHide: true });
  if (result.error) {
    if (result.error.code === 'ENOENT') {
      throw new Error('the docker CLI was not found on PATH; the local bring-up needs it to host PostgreSQL');
    }
    throw result.error;
  }
  if (result.status !== 0 && !allowFailure) {
    const detail = (result.stderr || result.stdout || '').trim().split('\n').slice(-3).join(' ').slice(0, 300);
    throw new Error(`docker ${args[0]} failed (${result.status}): ${detail}`);
  }
  return { status: result.status, stdout: (result.stdout || '').trim(), stderr: (result.stderr || '').trim() };
}

/** 'running' | 'stopped' | 'missing' — the container's own state, asked of docker. */
export function containerState(name) {
  const found = docker(['inspect', '-f', '{{.State.Running}}', name], { allowFailure: true });
  if (found.status !== 0) return 'missing';
  return found.stdout === 'true' ? 'running' : 'stopped';
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Bring the local PostgreSQL up and wait until it genuinely answers a query — polling the
 * database itself, not `docker ps`, because a started container is not a ready database.
 */
export async function ensureDatabase(cfg) {
  const { persistentConfig, createAdminPool } = await import('../server/owned-postgres/provision.mjs');
  const state = containerState(cfg.container);
  let action = 'already running';

  if (state === 'missing') {
    const args = ['run', '-d', '--name', cfg.container, '--label', 'hatoove.local=1',
      '-e', 'POSTGRES_HOST_AUTH_METHOD=trust', '-e', `POSTGRES_DB=${cfg.database}`,
      '-p', `127.0.0.1:${cfg.port}:5432`];
    // A volume makes this a LOCAL INSTALLATION rather than a fixture: an account created here
    // survives a restart. An empty volume name means "disposable", which the checks use.
    if (cfg.volume) args.push('--volume', `${cfg.volume}:/var/lib/postgresql/data`);
    args.push(cfg.image);
    docker(args);
    action = 'created';
  } else if (state === 'stopped') {
    docker(['start', cfg.container]);
    action = 'started';
  }

  const admin = createAdminPool(persistentConfig({ ...process.env, ...ownapiEnv(cfg) }), { max: 1 });
  try {
    const deadline = Date.now() + (cfg.startTimeoutMs || READY_TIMEOUT_MS);
    for (;;) {
      try {
        const r = await admin.query('select version() as v');
        return { container: cfg.container, port: cfg.port, action, version: r.rows[0].v };
      } catch (error) {
        if (Date.now() > deadline) {
          throw new Error(`the database container ${cfg.container} did not answer on 127.0.0.1:${cfg.port} `
            + `within ${cfg.startTimeoutMs || READY_TIMEOUT_MS}ms: ${error.message}`);
        }
        await sleep(400);
      }
    }
  } finally {
    await admin.end().catch(() => {});
  }
}

/**
 * Apply the tracked migrations through the single provisioning path, then close every pool it
 * opened so a caller does not leak connections. Returns counters, never pools.
 */
export async function provisionLocal(cfg) {
  const { persistentConfig, provisionPersistent, closePersistent } = await import('../server/owned-postgres/provision.mjs');
  const pools = await provisionPersistent({ config: persistentConfig({ ...process.env, ...ownapiEnv(cfg) }) });
  try {
    return {
      schema: cfg.schema,
      applied: Array.isArray(pools.applied) ? pools.applied.length : 0,
      skipped: Array.isArray(pools.skipped) ? pools.skipped.length : 0,
      appliedIds: pools.applied || [],
    };
  } finally {
    await closePersistent(pools);
  }
}

/** The catalogue the runtime will serve, counted. Used for the bring-up report. */
export async function catalogueCounts(cfg) {
  const { persistentConfig, createAdminPool } = await import('../server/owned-postgres/provision.mjs');
  const admin = createAdminPool(persistentConfig({ ...process.env, ...ownapiEnv(cfg) }), { max: 1 });
  try {
    const counts = {};
    for (const table of ['content_version', 'rubric_version', 'task_version']) {
      const r = await admin.query(`select count(*)::int as n from ${cfg.schema}.${table}`);
      counts[table] = r.rows[0].n;
    }
    return counts;
  } finally {
    await admin.end().catch(() => {});
  }
}

/**
 * Start the API and the worker as REAL child processes against this installation.
 *
 * The worker is a separate process on purpose: the runtime must not carry the worker's
 * privileges, and `server/worker.mjs` connects with the restricted `<prefix>_worker` role.
 */
export async function startRuntime(cfg) {
  const env = {
    ...process.env,
    ...ownapiEnv(cfg),
    B1PREP_SAAS: '1',
    B1PREP_ACCOUNTS: '1',
    B1PREP_PORT: String(cfg.appPort),
  };
  const api = spawn(process.execPath, ['server.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const worker = spawn(process.execPath, ['server/worker.mjs'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });

  const log = [];
  for (const [name, child] of [['api', api], ['worker', worker]]) {
    child.stdout.on('data', (d) => log.push(`[${name}] ${d}`));
    child.stderr.on('data', (d) => log.push(`[${name}] ${d}`));
  }

  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    for (const child of [api, worker]) {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    }
    await sleep(600);
    for (const child of [api, worker]) {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
  };

  return {
    api,
    worker,
    url: `http://127.0.0.1:${cfg.appPort}`,
    log: () => log.join(''),
    stop,
  };
}

/** Stop the container, and optionally remove its data volume. Never touches another container. */
export async function stopDatabase(cfg, { wipe = false } = {}) {
  docker(['rm', '-f', cfg.container], { allowFailure: true });
  if (wipe && cfg.volume) docker(['volume', 'rm', cfg.volume], { allowFailure: true });
  return { container: cfg.container, removed: true, wiped: Boolean(wipe && cfg.volume) };
}

// ---------------------------------------------------------------- CLI

const USAGE = [
  'Usage: node tools/local-bringup.mjs [--no-serve | --status | --down [--wipe]] [--help]',
  '',
  '  (no flag)   bring the database up, provision it, then serve the API and worker',
  '  --no-serve  do the above, print the status, and exit without serving',
  '  --status    report what is running; change nothing',
  '  --down      stop the database container (--wipe also removes its data volume)',
].join('\n');

export async function main(argv = process.argv.slice(2), env = process.env) {
  if (argv.includes('--help') || argv.includes('-h')) { console.log(USAGE); return 0; }
  const unknown = argv.filter((a) => !['--no-serve', '--status', '--down', '--wipe', '--help', '-h'].includes(a));
  if (unknown.length) { console.error(`local-bringup: unknown argument(s): ${unknown.join(', ')}\n${USAGE}`); return 2; }

  const cfg = localConfig(env);
  console.log(`local bring-up: container=${cfg.container} port=${cfg.port} database=${cfg.database} `
    + `schema=${cfg.schema} volume=${cfg.volume || '(none)'}`);

  if (argv.includes('--down')) {
    const before = containerState(cfg.container);
    if (before === 'missing') { console.log('nothing to do: the container does not exist'); return 0; }
    await stopDatabase(cfg, { wipe: argv.includes('--wipe') });
    console.log(`stopped ${cfg.container}${argv.includes('--wipe') ? ' and removed its volume' : ''}`);
    return 0;
  }

  if (argv.includes('--status')) {
    const state = containerState(cfg.container);
    console.log(`container: ${state}`);
    if (state === 'running') {
      const counts = await catalogueCounts(cfg);
      console.log(`catalogue: ${Object.entries(counts).map(([t, n]) => `${t}=${n}`).join(' ')}`);
    }
    return 0;
  }

  // Steps 1 and 2 of SEQUENCE.
  const db = await ensureDatabase(cfg);
  console.log(`step 1/4 database: ${db.action}; ${String(db.version).split(' ').slice(0, 2).join(' ')}`);

  const provisioned = await provisionLocal(cfg);
  console.log(`step 2/4 provision: applied=${provisioned.applied} skipped=${provisioned.skipped} schema=${provisioned.schema}`);

  const counts = await catalogueCounts(cfg);
  console.log(`step 3/4 catalogue: ${Object.entries(counts).map(([t, n]) => `${t}=${n}`).join(' ')}`);

  if (argv.includes('--no-serve')) {
    console.log('step 4/4 runtime: not started (--no-serve)');
    return 0;
  }

  const runtime = await startRuntime(cfg);
  console.log(`step 4/4 runtime: serving at ${runtime.url} (API + worker, stub grader)`);
  console.log(`  ${runtime.url}/api/health   ${runtime.url}/api/ready`);
  console.log('  press Ctrl+C to stop the runtime; the database keeps running (stop it with --down)');

  await new Promise((resolve) => {
    const shutdown = () => { console.log('\nlocal bring-up: stopping the runtime'); resolve(); };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  });
  await runtime.stop();
  return 0;
}

const invokedDirectly = process.argv[1] && process.argv[1].endsWith('local-bringup.mjs');
if (invokedDirectly) {
  process.exitCode = await main().catch((error) => {
    console.error(`local-bringup: ${error.message}`);
    return 1;
  });
}

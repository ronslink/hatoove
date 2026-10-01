#!/usr/bin/env node
/**
 * The worker CLI (WORKER-RUNNER-01 Step 2): a thin, bounded entry point over
 * `createWorker()` in `server/owned-postgres/worker.mjs`.
 *
 * It connects with the **restricted `<prefix>_worker` role** — never `admin` or
 * `migration`; the runner must not carry a second superuser pool at runtime — and loops
 * `reclaimExpired()` then `runOnce()` with a bounded sleep between iterations.
 *
 * It is NOT started by `server.js` in this slice. Nothing here calls a model provider:
 * the grader is the deterministic stub until the grading slice injects a real one.
 *
 * It refuses to start without database configuration (naming the missing variables, never
 * their values) and prints no credential.
 *
 * Usage:
 *   OWNAPI_PG_HOST=127.0.0.1 OWNAPI_PG_PORT=5432 OWNAPI_PG_DATABASE=hatoove \
 *   OWNAPI_PG_USER=<admin> node server/worker.mjs [--once] [--interval=1000] [--max-iterations=N]
 */

import process from 'node:process';

import { persistentConfig, persistentRolePool } from './owned-postgres/provision.mjs';
import { createWorker, DEFAULT_LEASE_MS, DEFAULT_MAX_TRIES } from './owned-postgres/worker.mjs';

/** Variables without which the runner cannot know what to connect to. Host/port have local defaults. */
const REQUIRED_ENV = ['OWNAPI_PG_DATABASE', 'OWNAPI_PG_USER'];

/** Parse `--k=v` flags; unknown flags are refused rather than ignored. */
function parseArgs(argv) {
  const options = { once: false, intervalMs: 1000, maxIterations: Infinity };
  for (const arg of argv) {
    if (arg === '--once') { options.once = true; continue; }
    if (arg === '--help' || arg === '-h') { options.help = true; continue; }
    const match = /^--(interval|max-iterations)=(\d+)$/.exec(arg);
    if (match) {
      const value = Number(match[2]);
      if (match[1] === 'interval') options.intervalMs = value;
      else options.maxIterations = value;
      continue;
    }
    throw new Error(`unknown argument: ${arg}`);
  }
  if (options.once) options.maxIterations = 1;
  return options;
}

const USAGE = [
  'Usage: node server/worker.mjs [--once] [--interval=<ms>] [--max-iterations=<n>]',
  'Requires OWNAPI_PG_DATABASE and OWNAPI_PG_USER (plus OWNAPI_PG_HOST/OWNAPI_PG_PORT as needed).',
].join('\n');

/** A sleep that a signal can cut short, so shutdown does not wait out the whole interval. */
function sleep(ms, register) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => { register(null); resolve(); }, ms);
    register(() => { clearTimeout(timer); resolve(); });
  });
}

export async function main(argv = process.argv.slice(2)) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    console.error(`worker: ${error.message}\n${USAGE}`);
    return 2;
  }
  if (options.help) { console.log(USAGE); return 0; }

  const missing = REQUIRED_ENV.filter((name) => !process.env[name]);
  if (missing.length) {
    console.error(`worker: refusing to start without database configuration; missing: ${missing.join(', ')}`);
    return 2;
  }

  const config = persistentConfig();
  const pool = persistentRolePool(config, 'worker', { max: 2 });
  const worker = createWorker({ pool, leaseMs: DEFAULT_LEASE_MS, maxTries: DEFAULT_MAX_TRIES });

  let stopping = false;
  let cancelSleep = null;
  const stop = (signal) => {
    stopping = true;
    console.log(`worker: ${signal} received, finishing the current step`);
    if (cancelSleep) cancelSleep();
  };
  process.on('SIGINT', () => stop('SIGINT'));
  process.on('SIGTERM', () => stop('SIGTERM'));

  let iterations = 0;
  try {
    while (!stopping && iterations < options.maxIterations) {
      iterations += 1;
      const reclaimed = await worker.reclaimExpired();
      if (reclaimed.requeued || reclaimed.abandoned) {
        console.log(`worker: reclaimed requeued=${reclaimed.requeued} abandoned=${reclaimed.abandoned}`);
      }
      const result = await worker.runOnce();
      if (result.claimed) {
        console.log(`worker: ${result.outcome}${result.code ? ` (${result.code})` : ''} submission=${result.submissionId}`);
      }
      if (stopping || iterations >= options.maxIterations) break;
      await sleep(options.intervalMs, (cancel) => { cancelSleep = cancel; });
    }
  } catch (error) {
    // A connection failure or a bug: report the message only (never the config), and exit non-zero.
    console.error(`worker: iteration failed: ${error && error.message ? error.message : error}`);
    return 1;
  } finally {
    await pool.end().catch(() => {});
  }
  return 0;
}

const invokedDirectly = process.argv[1] && process.argv[1].endsWith('worker.mjs');
if (invokedDirectly) {
  process.exitCode = await main();
}

/** Offline readiness checks: synthetic pools and ephemeral loopback HTTP; no PostgreSQL or .env. */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createDatabaseReadiness } from '../server/readiness.mjs';

const temp = await mkdtemp(path.join(tmpdir(), 'hatoove-readiness-'));
process.env.B1PREP_ENV_FILE = path.join(temp, 'absent.env');
process.env.B1PREP_FORCE_OFFLINE = '1';
const override = process.argv.find((arg) => arg.startsWith('--server='));
// Discrimination seam: pass a source-only copy of the previous server.js. It must fail the
// same HTTP outage/timeout checks; no test changes or learner runtime are involved.
const serverUrl = override ? pathToFileURL(path.resolve(override.slice('--server='.length))) : new URL('../server.js', import.meta.url);
const { createServer } = await import(serverUrl.href);
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
function fakePool() {
  const pool = new EventEmitter();
  Object.assign(pool, { options: {}, connects: 0, queries: 0, releases: [], ends: 0,
    acquire: async () => {}, query: async () => {} });
  pool.connect = async () => {
    pool.connects++;
    await pool.acquire();
    return {
      query: async (sql) => { pool.queries++; assert.equal(sql.text, 'SELECT 1'); return pool.query(sql); },
      release: (destroy) => { pool.releases.push(Boolean(destroy)); },
    };
  };
  pool.end = async () => { pool.ends++; };
  return pool;
}
async function serve(readinessCheck, run) {
  const server = createServer({ readinessCheck });
  server.saasReadiness = { ready: true, reason: 'ready' };
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = async (route = '/api/ready') => {
    const response = await fetch(base + route, { signal: AbortSignal.timeout(1500) });
    return { status: response.status, body: await response.json() };
  };
  try { await run({ server, get }); }
  finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}
let passed = 0;
let failed = 0;
async function check(name, run) {
  try { await run(); passed++; console.log(`PASS ${name}`); }
  catch (error) { failed++; console.error(`FAIL ${name}: ${error.message}`); }
}

try {
  await check('startup and schema refusals precede database probing; static fixtures still work', async () => {
    let calls = 0;
    await serve(async () => { calls++; return { ready: true }; }, async ({ server, get }) => {
      for (const reason of ['starting', 'accounts_unavailable', 'accounts_failed', 'schema_behind']) {
        server.saasReadiness = { ready: false, reason };
        const response = await get();
        assert.equal(response.status, 503);
        assert.equal(response.body.reason, reason);
        assert.equal((await get('/api/health')).status, 200);
      }
      assert.equal(calls, 0);
    });
    await serve(null, async ({ get }) => { assert.equal((await get()).status, 200); });
  });
  await check('HTTP readiness detects a post-start database failure and recovers', async () => {
    const pool = fakePool();
    const readiness = createDatabaseReadiness({ pool, cacheMs: 0, timeoutMs: 100 });
    try {
      await serve(readiness.check, async ({ get }) => {
        assert.equal((await get()).status, 200);
        pool.acquire = async () => { throw new Error('synthetic-private-connection-detail'); };
        const down = await get();
        assert.equal(down.status, 503);
        assert.deepEqual(down.body, { ok: false, ready: false, mode: 'unconfigured', reason: 'database_unavailable' });
        assert.equal((await get('/api/health')).status, 200);
        pool.acquire = async () => {};
        assert.equal((await get()).status, 200);
      });
      assert.equal(pool.options.max, 1);
      assert.equal(pool.options.connectionTimeoutMillis, 100);
      assert.equal(pool.options.query_timeout, 100);
    } finally { await readiness.close(); }
  });
  await check('probe exceptions never leak through HTTP', async () => {
    await serve(async () => { throw new Error('synthetic-private-connection-detail'); }, async ({ get }) => {
      const response = await get();
      assert.equal(response.status, 503);
      assert.equal(response.body.reason, 'database_unavailable');
      assert.ok(!JSON.stringify(response).includes('synthetic-private'));
    });
  });
  await check('concurrent readiness requests share one connection and query', async () => {
    const pool = fakePool();
    const query = deferred();
    pool.query = () => query.promise;
    const readiness = createDatabaseReadiness({ pool, cacheMs: 0, timeoutMs: 500 });
    try {
      const requests = Array.from({ length: 30 }, () => readiness.check());
      await delay(0);
      assert.equal(pool.connects, 1);
      assert.equal(pool.queries, 1);
      query.resolve();
      assert.ok((await Promise.all(requests)).every((result) => result.ready));
      assert.deepEqual(pool.releases, [false]);
    } finally { await readiness.close(); }
  });
  await check('hung connection acquisition stays bounded and late connection is destroyed', async () => {
    const pool = fakePool();
    const acquisition = deferred();
    pool.acquire = () => acquisition.promise;
    const readiness = createDatabaseReadiness({ pool, cacheMs: 0, timeoutMs: 35 });
    try {
      const started = performance.now();
      const result = await readiness.check();
      assert.equal(result.ready, false);
      assert.ok(performance.now() - started < 750, 'readiness deadline must bound a hung acquisition');
      for (let i = 0; i < 20; i++) assert.equal((await readiness.check()).ready, false);
      assert.equal(pool.connects, 1, 'no retries while the first acquisition remains unsettled');
      acquisition.resolve();
      await delay(0);
      assert.equal(pool.queries, 0, 'late acquired connection must not query');
      assert.deepEqual(pool.releases, [true]);
      pool.acquire = async () => {};
      assert.equal((await readiness.check()).ready, true);
    } finally { acquisition.resolve(); await readiness.close(); }
  });
  await check('hung query returns HTTP 503, does not block liveness, and cannot cache late success', async () => {
    const pool = fakePool();
    const query = deferred();
    pool.query = () => query.promise;
    const readiness = createDatabaseReadiness({ pool, cacheMs: 0, timeoutMs: 60 });
    try {
      await serve(readiness.check, async ({ get }) => {
        const started = performance.now();
        const response = await get();
        assert.equal(response.status, 503);
        assert.ok(performance.now() - started < 1000);
        assert.equal((await get('/api/health')).status, 200);
        assert.deepEqual(pool.releases, [true]);
        query.resolve();
        await delay(0);
        pool.query = async () => { throw new Error('still unavailable'); };
        assert.equal((await get()).status, 503, 'late success from expired query must not restore readiness');
        pool.query = async () => {};
        assert.equal((await get()).status, 200);
      });
    } finally { query.resolve(); await readiness.close(); }
  });
  await check('short cache expires and idle pool errors invalidate a healthy result', async () => {
    const pool = fakePool();
    let time = 1000;
    const readiness = createDatabaseReadiness({ pool, now: () => time, cacheMs: 25, timeoutMs: 100 });
    try {
      assert.equal((await readiness.check()).ready, true);
      assert.equal((await readiness.check()).ready, true);
      assert.equal(pool.connects, 1);
      time += 26;
      assert.equal((await readiness.check()).ready, true);
      assert.equal(pool.connects, 2);
      pool.emit('error', new Error('synthetic-private-idle-detail'));
      assert.equal((await readiness.check()).ready, false);
      time += 26;
      assert.equal((await readiness.check()).ready, true);
    } finally { await readiness.close(); }
  });
  await check('closing expires pending probes and never accepts more work', async () => {
    const pool = fakePool();
    const query = deferred();
    pool.query = () => query.promise;
    const readiness = createDatabaseReadiness({ pool, cacheMs: 0, timeoutMs: 1000 });
    const request = readiness.check();
    await delay(0);
    await readiness.close();
    assert.equal((await request).ready, false);
    query.reject(new Error('late rejection after close'));
    await delay(0);
    assert.equal((await readiness.check()).ready, false);
    assert.equal(pool.connects, 1);
    assert.deepEqual(pool.releases, [true]);
  });
} finally {
  // This is the newly created synthetic fixture directory only.
  await rm(temp, { recursive: true, force: true });
}
console.log(`Readiness: ${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;

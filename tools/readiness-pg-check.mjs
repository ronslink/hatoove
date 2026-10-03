/** Disposable PostgreSQL readiness check. Never run against the learner's Compose database. */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createDatabaseReadiness } from '../server/readiness.mjs';

const database = process.env.OWNAPI_PG_DATABASE;
if (process.env.OWNAPI_PG_ALLOW !== '1' || !database || ['postgres', 'template0', 'template1'].includes(database)) {
  throw new Error('readiness-pg-check requires OWNAPI_PG_ALLOW=1 and an explicitly disposable OWNAPI_PG_DATABASE');
}
const temp = await mkdtemp(path.join(tmpdir(), 'hatoove-readiness-pg-'));
process.env.B1PREP_ENV_FILE = path.join(temp, 'absent.env');
process.env.B1PREP_FORCE_OFFLINE = '1';
let fixture;
let readiness;
let server;
let held;
try {
  const { createFixture } = await import('../server/owned-postgres/bootstrap.mjs');
  const { createServer } = await import('../server.js');
  fixture = await createFixture();
  // Advance only the short cache clock explicitly, so a slow CI host cannot skip the
  // unavailable result after the terminated backend. Driver deadlines remain real timers.
  let cacheTime = 0;
  readiness = createDatabaseReadiness({
    pool: fixture.learner, timeoutMs: 120, cacheMs: 250, now: () => cacheTime,
  });
  server = createServer({ readinessCheck: readiness.check });
  server.saasReadiness = { ready: true, reason: 'ready' };
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = async (route = '/api/ready') => {
    const response = await fetch(base + route, { signal: AbortSignal.timeout(2000) });
    return { status: response.status, body: await response.json() };
  };
  assert.equal((await get()).status, 200);
  held = await fixture.learner.connect();
  const role = (await held.query('SELECT current_user AS role')).rows[0].role;
  assert.equal(role, fixture.roles.learner, 'probe uses the restricted learner role');
  cacheTime += 251;
  const started = performance.now();
  const congested = await Promise.all(Array.from({ length: 12 }, () => get()));
  assert.ok(congested.every((response) => response.status === 503));
  assert.ok(performance.now() - started < 1800, 'pool acquisition is bounded');
  assert.ok(fixture.learner.waitingCount <= 1, 'concurrent requests cannot queue unbounded acquisitions');
  assert.equal((await get('/api/health')).status, 200);
  held.release(); held = null;
  cacheTime += 251;
  assert.equal((await get()).status, 200, 'readiness recovers once a connection is available');
  console.log('PASS restricted database probe, bounded/coalesced acquisition and recovery');

  held = await fixture.learner.connect();
  const pid = (await held.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
  held.release(); held = null;
  // Terminate only this test fixture's own idle backend, never another connection or the DB.
  const disconnected = once(fixture.learner, 'error', { signal: AbortSignal.timeout(2000) });
  const killed = await fixture.admin.query('SELECT pg_terminate_backend($1) AS killed', [pid]);
  assert.equal(killed.rows[0].killed, true);
  await disconnected;
  const down = await get();
  assert.equal(down.status, 503);
  assert.equal(down.body.reason, 'database_unavailable');
  cacheTime += 251;
  assert.equal((await get()).status, 200, 'a new backend restores readiness');
  console.log('PASS terminated fixture backend is reported unavailable and reconnects');
} finally {
  if (held) held.release(true);
  if (server) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
  if (readiness) await readiness.close();
  if (fixture) await fixture.cleanup();
  await rm(temp, { recursive: true, force: true });
}

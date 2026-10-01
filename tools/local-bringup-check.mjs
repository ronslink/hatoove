#!/usr/bin/env node
/**
 * PILOT-01 — the local bring-up check.
 *
 * The plan's LM-1 says a working installation is produced by ONE documented sequence, not by a
 * list a human retypes from a README. This check is that requirement's measure: it drives
 * `tools/local-bringup.mjs`'s own exported sequence and asserts the result in the DATABASE and
 * over HTTP, never from stdout — the worker in this codebase prints nothing when there is
 * nothing to claim (server/worker.mjs:100), so silence must never be read as success.
 *
 * WHAT THIS CHECK PROVES
 *   the sequence is callable and complete; the database comes up; every tracked migration is
 *   recorded with a checksum that matches the file on disk; the six roles are least-privilege;
 *   content is seeded; provisioning is idempotent; the runtime answers ready in SaaS mode; and
 *   the product's own journey counter still runs at zero failures.
 *
 * WHAT IT DOES NOT PROVE
 *   it does not re-prove the worker's one-debit property — `tools/journey-api-check.mjs` J7
 *   already does that by data, and leg L8 asserts that harness still runs clean rather than
 *   duplicating it. It establishes nothing about production auth, exam validity or any human gate.
 *
 * SAFETY
 *   it creates and removes its OWN container (`hatoove-pilot01-check-db`) on its own port and
 *   NEVER touches the local installation's container or volume. Synthetic data only.
 *
 * Usage: node tools/local-bringup-check.mjs
 */

import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BRINGUP_PATH = path.join(ROOT, 'tools', 'local-bringup.mjs');

/** This check's own disposable container. Deliberately NOT the local installation's. */
const CHECK_CONTAINER = 'hatoove-pilot01-check-db';
const CHECK_PORT = Number(process.env.PILOT01_CHECK_PORT || 55441);
const CHECK_APP_PORT = Number(process.env.PILOT01_CHECK_APP_PORT || 4398);
const READY_DEADLINE_MS = 30000;

const REQUIRED_EXPORTS = [
  'localConfig', 'ownapiEnv', 'ensureDatabase', 'provisionLocal', 'startRuntime', 'stopDatabase', 'SEQUENCE',
];

const results = [];
function record(id, title, outcome, detail) {
  results.push({ id, title, outcome, detail });
  console.log(`${outcome.padEnd(4)} ${id.padEnd(30)} ${title}`);
  if (detail) console.log(`     ${detail}`);
}
const pass = (id, title, detail) => record(id, title, 'PASS', detail);
const fail = (id, title, detail) => record(id, title, 'FAIL', detail);
const skip = (id, title, detail) => record(id, title, 'SKIP', detail);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Poll `probe` until it returns a truthy value or the deadline passes. Never hangs. */
async function until(probe, deadlineMs, intervalMs = 250) {
  const deadline = Date.now() + deadlineMs;
  for (;;) {
    const value = await probe().catch(() => null);
    if (value) return value;
    if (Date.now() > deadline) return null;
    await sleep(intervalMs);
  }
}

/** GET a URL, returning null instead of throwing so a probe can be polled. */
async function getJson(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(4000) });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-JSON body is not the probe's business */ }
  return { status: res.status, json, text };
}

// ---------------------------------------------------------------- the check

console.log('\n=== PILOT-01 local bring-up check ===\n');

if (!existsSync(BRINGUP_PATH)) {
  fail('L1-sequence-exists', 'tools/local-bringup.mjs exists and exports the documented sequence',
    'NOT IMPLEMENTED: tools/local-bringup.mjs is missing. PILOT-01 is the slice that creates it.');
  for (const [id, title] of [
    ['L2-database-comes-up', 'the local PostgreSQL comes up and answers'],
    ['L3-migrations-recorded', 'every tracked migration is applied and its checksum matches the file'],
    ['L4-roles-least-privilege', 'the six roles exist and none is superuser or BYPASSRLS'],
    ['L5-content-seeded', 'the writing catalogue is seeded'],
    ['L6-provision-idempotent', 'a second provision applies nothing'],
    ['L7-runtime-answers-ready', 'the runtime answers ready in SaaS mode'],
    ['L8-counter-runs', 'the product journey counter runs at zero failures'],
    ['D1-fails-loudly', 'a stopped database makes bring-up fail rather than report success'],
    ['L9-teardown', 'teardown removes the disposable container'],
  ]) skip(id, title, 'depends on L1');
  console.log(`\n${results.filter((r) => r.outcome === 'PASS').length} passed, `
    + `${results.filter((r) => r.outcome === 'SKIP').length} skipped, `
    + `${results.filter((r) => r.outcome === 'FAIL').length} failed\n`);
  process.exit(1);
}

const mod = await import(pathToFileURL(BRINGUP_PATH).href);
const {
  persistentConfig, createAdminPool, EXPECTED_MIGRATIONS, checksumOf,
} = await import(pathToFileURL(path.join(ROOT, 'server', 'owned-postgres', 'provision.mjs')).href);

// L1 — the sequence exists, is complete, and documents itself.
const missing = REQUIRED_EXPORTS.filter((name) => typeof mod[name] === 'undefined');
if (missing.length) {
  fail('L1-sequence-exists', 'tools/local-bringup.mjs exports the documented sequence',
    `missing export(s): ${missing.join(', ')}`);
  process.exit(1);
}
if (!Array.isArray(mod.SEQUENCE) || mod.SEQUENCE.length < 4) {
  fail('L1-sequence-exists', 'the sequence documents its own steps', `SEQUENCE has ${mod.SEQUENCE?.length ?? 0} step(s)`);
  process.exit(1);
}
pass('L1-sequence-exists', 'tools/local-bringup.mjs exports the documented sequence',
  `${mod.SEQUENCE.length} documented step(s); ${REQUIRED_EXPORTS.length} exports`);

/** Point the sequence at THIS check's disposable container, never the local installation. */
const cfg = mod.localConfig({
  ...process.env,
  HATOVE_LOCAL_CONTAINER: CHECK_CONTAINER,
  HATOVE_LOCAL_VOLUME: '',
  HATOVE_LOCAL_PORT: String(CHECK_PORT),
  HATOVE_LOCAL_DATABASE: 'hatoove',
  HATOVE_LOCAL_USER: 'postgres',
  HATOVE_LOCAL_APP_PORT: String(CHECK_APP_PORT),
});

let admin = null;
let runtime = null;
let infraOk = false;

try {
  // Repeatable: remove any container left by an earlier failed run.
  await mod.stopDatabase(cfg, { wipe: true }).catch(() => {});

  // L2 — the database comes up.
  let version = null;
  try {
    const started = await mod.ensureDatabase(cfg);
    const provCfg = persistentConfig({ ...process.env, ...mod.ownapiEnv(cfg) });
    admin = createAdminPool(provCfg, { max: 2 });
    version = await until(async () => {
      const r = await admin.query('select version() as v');
      return r.rows[0]?.v || null;
    }, READY_DEADLINE_MS);
    if (!version) throw new Error('the database did not answer within the deadline');
    infraOk = true;
    pass('L2-database-comes-up', 'the local PostgreSQL comes up and answers',
      `${started?.container || cfg.container} on 127.0.0.1:${cfg.port}; ${String(version).split(' ').slice(0, 2).join(' ')}`);
  } catch (error) {
    fail('L2-database-comes-up', 'the local PostgreSQL comes up and answers', error.message);
  }

  // L3 — every tracked migration is recorded with a checksum that matches the file on disk.
  if (!infraOk) {
    skip('L3-migrations-recorded', 'migrations recorded', 'depends on L2');
  } else {
    try {
      const provisioned = await mod.provisionLocal(cfg);
      const ledger = await admin.query(`select id, checksum from ${cfg.schema}.hatoove_migrations order by id`);
      const ids = ledger.rows.map((r) => r.id);
      const expected = [...EXPECTED_MIGRATIONS];
      if (JSON.stringify(ids) !== JSON.stringify(expected)) {
        throw new Error(`ledger ids differ from the tracked set\n  ledger:   ${ids.join(', ')}\n  expected: ${expected.join(', ')}`);
      }
      const mismatched = [];
      for (const row of ledger.rows) {
        const file = path.join(ROOT, 'server', 'migrations', `${row.id}.sql`);
        const actual = checksumOf(readFileSync(file));
        if (actual !== row.checksum) mismatched.push(`${row.id} (ledger ${row.checksum.slice(0, 12)} != file ${actual.slice(0, 12)})`);
      }
      if (mismatched.length) {
        throw new Error(`recorded checksum does not match the file on disk: ${mismatched.join('; ')}. `
          + 'This is the CRLF trap MASTER-PLAN section 3 warns about: the ledger hashes raw bytes.');
      }
      pass('L3-migrations-recorded', 'every tracked migration is applied and recorded',
        `${ids.length} applied, ${provisioned?.skipped ?? 0} skipped; every checksum matches the file on disk`);
    } catch (error) {
      fail('L3-migrations-recorded', 'every tracked migration is applied and recorded', error.message);
    }
  }

  // L4 — the roles exist and are least-privilege.
  if (!infraOk) {
    skip('L4-roles-least-privilege', 'roles least-privilege', 'depends on L2');
  } else {
    try {
      const roles = await admin.query(
        'select rolname, rolsuper, rolbypassrls, rolcanlogin from pg_roles where rolname like $1 order by rolname',
        [`${cfg.rolePrefix}\\_%`],
      );
      if (roles.rows.length !== 6) throw new Error(`expected 6 roles, found ${roles.rows.length}`);
      const privileged = roles.rows.filter((r) => r.rolsuper || r.rolbypassrls);
      if (privileged.length) throw new Error(`privileged role(s): ${privileged.map((r) => r.rolname).join(', ')}`);
      if (roles.rows.some((r) => !r.rolcanlogin)) throw new Error('a role cannot log in');
      pass('L4-roles-least-privilege', 'the six roles exist and none is superuser or BYPASSRLS',
        roles.rows.map((r) => r.rolname).join(', '));
    } catch (error) {
      fail('L4-roles-least-privilege', 'the six roles exist and none is superuser or BYPASSRLS', error.message);
    }
  }

  // L5 — the catalogue is seeded (PILOT-04 makes it exam-scoped; seeding exists today).
  if (!infraOk) {
    skip('L5-content-seeded', 'content seeded', 'depends on L2');
  } else {
    try {
      const counts = {};
      for (const table of ['content_version', 'rubric_version', 'task_version']) {
        const r = await admin.query(`select count(*)::int as n from ${cfg.schema}.${table}`);
        counts[table] = r.rows[0].n;
      }
      const empty = Object.entries(counts).filter(([, n]) => n === 0).map(([t]) => t);
      if (empty.length) throw new Error(`empty catalogue table(s): ${empty.join(', ')}`);
      pass('L5-content-seeded', 'the writing catalogue is seeded',
        Object.entries(counts).map(([t, n]) => `${t}=${n}`).join(' '));
    } catch (error) {
      fail('L5-content-seeded', 'the writing catalogue is seeded', error.message);
    }
  }

  // L6 — provisioning is idempotent: a second run must apply nothing.
  if (!infraOk) {
    skip('L6-provision-idempotent', 'provision idempotent', 'depends on L2');
  } else {
    try {
      const again = await mod.provisionLocal(cfg);
      if ((again?.applied ?? 0) !== 0) throw new Error(`a second provision applied ${again.applied} migration(s)`);
      pass('L6-provision-idempotent', 'a second provision applies nothing', `applied=0, skipped=${again?.skipped ?? 0}`);
    } catch (error) {
      fail('L6-provision-idempotent', 'a second provision applies nothing', error.message);
    }
  }

  // L7 — the runtime answers ready in SaaS mode when started by the sequence itself.
  if (!infraOk) {
    skip('L7-runtime-answers-ready', 'runtime answers ready', 'depends on L2');
  } else {
    try {
      runtime = await mod.startRuntime(cfg);
      const health = await until(async () => {
        const r = await getJson(`${runtime.url}/api/health`);
        return r.status === 200 ? r : null;
      }, READY_DEADLINE_MS);
      if (!health) throw new Error(`${runtime.url}/api/health did not answer 200 within the deadline`);
      const ready = await getJson(`${runtime.url}/api/ready`);
      if (ready.status !== 200 || ready.json?.mode !== 'saas') {
        throw new Error(`/api/ready answered ${ready.status} mode=${ready.json?.mode}; expected 200 mode=saas`);
      }
      pass('L7-runtime-answers-ready', 'the runtime answers ready in SaaS mode',
        `${runtime.url} health 200; ready 200 mode=saas reason=${ready.json.reason}`);
    } catch (error) {
      fail('L7-runtime-answers-ready', 'the runtime answers ready in SaaS mode', error.message);
    } finally {
      // STOP THE RUNTIME BEFORE L8. The journey harness starts a worker of its own against the
      // same database, and two workers competing for one job makes its reservation assertion
      // race — which is a defect in THIS check, not in the product. Measured, not assumed:
      // running both at once produced `4 passed, 6 pending, 1 failed`.
      if (runtime) { await runtime.stop().catch(() => {}); runtime = null; }
    }
  }

  // L8 — the product's own counter still runs clean. This is a GATE, not a re-implementation.
  if (!infraOk) {
    skip('L8-counter-runs', 'journey counter runs', 'depends on L2');
  } else {
    const env = { ...process.env, ...mod.ownapiEnv(cfg), OWNAPI_PG_ALLOW: '1' };
    const child = spawn(process.execPath, [path.join(ROOT, 'tools', 'journey-api-check.mjs')], {
      cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    const code = await new Promise((resolve) => child.on('close', resolve));
    const lines = out.split('\n');
    const summary = lines.filter((l) => /passed,.*pending,.*failed/.test(l)).pop();
    const at = lines.findIndex((l) => /^FAIL/.test(l.trim()));
    const failing = at >= 0 ? `${lines[at].trim()} :: ${(lines[at + 1] || '').trim()}` : null;
    if (code !== 0) fail('L8-counter-runs', 'the product journey counter runs at zero failures', `exit ${code}; ${failing || summary || out.slice(-200)}`);
    else if (!summary || !/0 failed/.test(summary)) fail('L8-counter-runs', 'the product journey counter runs at zero failures', failing || summary || 'no summary line printed');
    else pass('L8-counter-runs', 'the product journey counter runs at zero failures', summary.trim());
  }

  // D1 — DISCRIMINATION. Stop the database; the sequence must fail loudly, not report success.
  if (!infraOk) {
    skip('D1-fails-loudly', 'a stopped database fails loudly', 'depends on L2');
  } else {
    if (runtime) { await runtime.stop().catch(() => {}); runtime = null; }
    await admin.end().catch(() => {});
    admin = null;
    // Remove the container outright, then point the SAME provisioning path at it. If this
    // reported success the leg would be measuring nothing, which is the whole point of D1.
    await mod.stopDatabase(cfg, { wipe: false });
    let threw = false;
    let why = '';
    try {
      await mod.provisionLocal(cfg);
    } catch (error) {
      threw = true;
      why = error.message.split('\n')[0].slice(0, 140);
    }
    if (threw) pass('D1-fails-loudly', 'a stopped database makes bring-up fail rather than report success',
      `provisioning against the removed database threw: ${why}`);
    else fail('D1-fails-loudly', 'a stopped database makes bring-up fail rather than report success',
      'provisioning reported success against a database that is not running — the leg cannot fail');
  }

  // L9 — teardown removes the disposable container.
  try {
    await mod.stopDatabase(cfg, { wipe: true });
    const gone = await until(async () => {
      const r = await getJson(`http://127.0.0.1:${cfg.port}/`).catch(() => null);
      return r === null ? true : null;
    }, 8000, 400);
    if (!gone) throw new Error(`something still answers on port ${cfg.port}`);
    pass('L9-teardown', 'teardown removes the disposable container', `container ${cfg.container} removed; port ${cfg.port} closed`);
  } catch (error) {
    fail('L9-teardown', 'teardown removes the disposable container', error.message);
  }
} finally {
  if (runtime) await runtime.stop().catch(() => {});
  if (admin) await admin.end().catch(() => {});
}

const passed = results.filter((r) => r.outcome === 'PASS').length;
const skipped = results.filter((r) => r.outcome === 'SKIP').length;
const failed = results.filter((r) => r.outcome === 'FAIL').length;
console.log(`\n${passed} passed, ${skipped} skipped, ${failed} failed\n`);
process.exit(failed ? 1 : 0);

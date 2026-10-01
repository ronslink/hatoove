/**
 * MFP-01 — the migration contract, checked.
 *
 * The slice's central claim is **"the applied migrations are the ones that were reviewed"**.
 * A claim like that is worth nothing unless a check fails when it is broken, so this check
 * exists to fail on a tampered migration, on a ledger without a checksum, on a runtime that
 * migrates at start, and on a runtime that holds a privileged pool.
 *
 * Legs (each with a real assertion):
 *   1. fresh-database-applies-once-and-a-second-run-applies-nothing
 *        a fresh schema: `node server/migrate.mjs` applies every migration exactly once and
 *        exits 0; a second run applies nothing and changes no recorded checksum.
 *   2. ledger-checksums-match-the-frozen-files
 *        every applied migration has a checksum, and it equals the sha256 of the frozen file
 *        **computed here**, not read back from the ledger.
 *   3. tampered-migration-refused  (the leg that makes the slice evidence)
 *        in a scratch copy of the migrations directory, one byte of an already-applied
 *        migration is altered; `migrate` must exit non-zero naming that migration. Restoring
 *        the byte makes the same scratch directory pass, so the refusal is the tamper.
 *   4. runtime-never-migrates-and-reports-schema-behind
 *        the server started against a database with a pending migration answers `schema_behind`
 *        on /api/ready, keeps /api/health at 200, and applies nothing (ledger row count is
 *        unchanged before and after).
 *   5. runtime-holds-no-superuser-or-migration-pool
 *        the pools the running server builds are not SUPERUSER and not BYPASSRLS, and it
 *        retains no `admin`- or `migration`-capable pool (checked both on the pools the
 *        runtime module returns and on the live backends in `pg_stat_activity`).
 *   6. control-unmodified-tree-applies-cleanly
 *        an unmodified migrations directory applies with exit 0 — so "refuses everything"
 *        cannot pass leg 3.
 *
 * Safety: needs a **disposable** PostgreSQL database (`OWNAPI_PG_*`) and refuses the default
 * `postgres`/`template0`/`template1`. It creates and drops its own per-leg schemas and roles,
 * and never touches the `hatoove` schema a real installation would use. Synthetic only.
 *
 * Usage: node tools/migrate-check.mjs
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import {
  persistentConfig, createAdminPool, openRuntimePools, closeRuntimePools,
} from '../server/owned-postgres/provision.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MIGRATIONS_DIR = process.env.OWNAPI_MIGRATIONS_DIR || path.join(ROOT, 'server', 'migrations');
const FORBIDDEN = new Set(['postgres', 'template0', 'template1']);
const DATABASE = process.env.OWNAPI_PG_DATABASE || '';
const LEGS = ['mfp01_l1', 'mfp01_l2', 'mfp01_l3', 'mfp01_l4', 'mfp01_l5', 'mfp01_l6'];
const PORTS = { mfp01_l4: 4481, mfp01_l5: 4482 };

const checks = [];
const check = (name, run) => checks.push({ name, run });

/* ------------------------------------------------------------- filesystem */

/** The frozen migration files, by id: `NNNN-name` from `NNNN-name.sql`. Sorted, so order is the id order. */
function migrationFiles(dir = MIGRATIONS_DIR) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((name) => /^\d{4}-.*\.sql$/.test(name))
    .sort()
    .map((name) => ({ id: name.replace(/\.sql$/, ''), file: path.join(dir, name) }));
}

/** sha256 of a file's **bytes**. Computed here so the ledger is never the only source. */
const sha256File = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');

/* --------------------------------------------------------------- processes */

/** Run a node entry with the given environment; bounded, and never leaks a hung child. */
function runNode(args, extraEnv, timeoutMs = 180000) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, {
      cwd: ROOT, env: { ...process.env, ...extraEnv }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (c) => { out += String(c); });
    child.stderr.on('data', (c) => { out += String(c); });
    const timer = setTimeout(() => { child.kill('SIGKILL'); }, timeoutMs);
    child.once('exit', (code) => { clearTimeout(timer); resolve({ code, out }); });
  });
}

/** The environment for one leg: its own schema and role prefix, so legs cannot collide. */
function legEnv(leg, extra = {}) {
  return {
    OWNAPI_PG_SCHEMA: leg,
    OWNAPI_PG_ROLE_PREFIX: leg,
    OWNAPI_PG_ALLOW: '1',
    ...extra,
  };
}

const migrate = (leg, extra = {}) => runNode(['server/migrate.mjs'], legEnv(leg, extra));

/** Start the real server for a leg and wait for liveness. */
async function startServer(leg, port) {
  const env = {
    ...process.env, ...legEnv(leg),
    B1PREP_ACCOUNTS: '1',
    B1PREP_PORT: String(port),
    B1PREP_FORCE_OFFLINE: '1',
    B1PREP_ENV_FILE: path.join(os.tmpdir(), `mfp01-env-${leg}-${port}`),
    B1PREP_PROGRESS_FILE: path.join(os.tmpdir(), `mfp01-progress-${leg}-${port}.json`),
  };
  const child = spawn(process.execPath, ['server.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  child.stdout.on('data', (c) => { log += String(c); });
  child.stderr.on('data', (c) => { log += String(c); });
  const deadline = Date.now() + 30000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`server exited early (${child.exitCode}): ${log.slice(-400)}`);
    try { if ((await fetch(`http://127.0.0.1:${port}/api/health`)).ok) break; } catch { /* not up yet */ }
    if (Date.now() > deadline) throw new Error(`server did not answer on ${port}: ${log.slice(-400)}`);
    await new Promise((r) => setTimeout(r, 150));
  }
  return { child, log: () => log, stop: () => new Promise((resolve) => { child.once('exit', resolve); child.kill(); }) };
}

/* ------------------------------------------------------------ database leg */

const configFor = (leg) => persistentConfig({ ...process.env, ...legEnv(leg) });

async function withAdmin(leg, run) {
  const pool = createAdminPool(configFor(leg));
  try { return await run(pool); } finally { await pool.end().catch(() => {}); }
}

/** Drop a leg's schema and roles so the check is re-runnable on a disposable database. */
async function resetLeg(leg) {
  await withAdmin(leg, async (admin) => {
    await admin.query(`DROP SCHEMA IF EXISTS "${leg}" CASCADE`);
    const roles = (await admin.query('SELECT rolname FROM pg_roles WHERE rolname LIKE $1', [`${leg}\\_%`])).rows;
    for (const { rolname } of roles) {
      await admin.query(`DROP OWNED BY "${rolname}" CASCADE`).catch(() => {});
      await admin.query(`DROP ROLE IF EXISTS "${rolname}"`).catch(() => {});
    }
  });
}

/** The ledger rows (id, checksum) for a leg's schema. */
async function ledger(leg) {
  return withAdmin(leg, async (admin) => (await admin.query(
    `SELECT id, checksum FROM "${leg}".hatoove_migrations ORDER BY id`)).rows);
}

const count = (re, text) => {
  const m = String(text).match(re);
  return m ? Number(m[1]) : null;
};

/* =================================================================== legs */

check('fresh-database-applies-once-and-a-second-run-applies-nothing', async () => {
  const leg = 'mfp01_l1';
  const files = migrationFiles();
  assert.ok(files.length > 0, `no frozen migrations found in ${MIGRATIONS_DIR}`);
  await resetLeg(leg);

  const first = await migrate(leg);
  assert.equal(first.code, 0, `first migrate must exit 0:\n${first.out.slice(-800)}`);
  assert.equal(count(/applied=(\d+)/, first.out), files.length, `first run must apply all ${files.length} migrations:\n${first.out.slice(-400)}`);
  assert.equal(count(/skipped=(\d+)/, first.out), 0, 'a first run skips nothing');

  const before = await ledger(leg);
  assert.equal(before.length, files.length, 'every migration is recorded once');
  assert.deepEqual(before.map((r) => r.id).sort(), files.map((f) => f.id).sort());

  const second = await migrate(leg);
  assert.equal(second.code, 0, `second migrate must exit 0:\n${second.out.slice(-800)}`);
  assert.equal(count(/applied=(\d+)/, second.out), 0, 'a second run must apply nothing');
  assert.equal(count(/skipped=(\d+)/, second.out), files.length, 'a second run skips every migration');

  const after = await ledger(leg);
  assert.deepEqual(after, before, 'a second run must change no recorded checksum');
});

check('ledger-checksums-match-the-frozen-files', async () => {
  const leg = 'mfp01_l2';
  const files = migrationFiles();
  assert.ok(files.length > 0, `no frozen migrations found in ${MIGRATIONS_DIR}`);
  await resetLeg(leg);
  const run = await migrate(leg);
  assert.equal(run.code, 0, `migrate must exit 0:\n${run.out.slice(-800)}`);

  const rows = await ledger(leg);
  const byId = new Map(rows.map((r) => [r.id, r.checksum]));
  assert.equal(rows.length, files.length);
  for (const file of files) {
    assert.ok(byId.has(file.id), `${file.id} is missing from the ledger`);
    const recorded = byId.get(file.id);
    assert.ok(recorded, `${file.id} has no recorded checksum`);
    const computed = sha256File(file.file);
    assert.equal(recorded, computed, `${file.id}: ledger checksum must equal sha256 of the frozen file`);
  }
});

check('tampered-migration-refused', async () => {
  const leg = 'mfp01_l3';
  await resetLeg(leg);
  // Establish the applied state with the unmodified tree.
  const clean = await migrate(leg);
  assert.equal(clean.code, 0, `clean migrate must exit 0:\n${clean.out.slice(-800)}`);
  const before = await ledger(leg);

  // A scratch copy of the migrations directory, so the repository is never modified.
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'mfp01-migrations-'));
  for (const file of migrationFiles()) fs.copyFileSync(file.file, path.join(scratch, path.basename(file.file)));
  const target = path.join(scratch, '0002-owned-schema.sql');
  assert.ok(fs.existsSync(target), 'the tamper target 0002-owned-schema.sql must exist');
  const original = fs.readFileSync(target, 'utf8');
  const bytes = fs.readFileSync(target);
  // One byte, inside a leading comment, so the SQL stays valid and the ONLY difference is the digest.
  const marker = 'Synthetic spike records';
  const at = bytes.indexOf(Buffer.from(marker, 'utf8'));
  assert.ok(at >= 0, 'the tamper marker must exist in 0002');
  const tampered = Buffer.from(bytes); tampered[at] = 0x54; // 'S' -> 'T'
  fs.writeFileSync(target, tampered);

  const refused = await migrate(leg, { OWNAPI_MIGRATIONS_DIR: scratch });
  assert.notEqual(refused.code, 0, 'a tampered migration must make migrate exit non-zero');
  assert.match(refused.out, /0002/, 'the refusal must name the migration');
  assert.match(refused.out, /checksum|digest|sha256/i, 'the refusal must say it is a digest mismatch');

  // The ledger is untouched by the refusal: no row was rewritten or deleted.
  assert.deepEqual(await ledger(leg), before, 'a refused run must not change the ledger');

  // Discrimination: restore the byte and the SAME scratch directory applies/verifies cleanly,
  // so the refusal is the tamper and not "the scratch directory is broken".
  fs.writeFileSync(target, original);
  const restored = await migrate(leg, { OWNAPI_MIGRATIONS_DIR: scratch });
  assert.equal(restored.code, 0, `the restored scratch directory must pass:\n${restored.out.slice(-800)}`);
  fs.rmSync(scratch, { recursive: true, force: true });
});

check('runtime-never-migrates-and-reports-schema-behind', async () => {
  const leg = 'mfp01_l4';
  // A scratch directory with every migration EXCEPT the head, so the database is one behind.
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'mfp01-behind-'));
  const files = migrationFiles();
  assert.ok(files.length > 1, 'need more than one migration to have a head');
  const head = files[files.length - 1];
  for (const file of files.slice(0, -1)) fs.copyFileSync(file.file, path.join(scratch, path.basename(file.file)));

  await resetLeg(leg);
  const seeded = await migrate(leg, { OWNAPI_MIGRATIONS_DIR: scratch });
  assert.equal(seeded.code, 0, `seeding one-behind must exit 0:\n${seeded.out.slice(-800)}`);
  const before = await ledger(leg);
  assert.ok(!before.some((r) => r.id === head.id), `the head migration ${head.id} must be pending`);

  const port = PORTS[leg];
  const server = await startServer(leg, port);
  try {
    const ready = await fetch(`http://127.0.0.1:${port}/api/ready`);
    assert.equal(ready.status, 503, 'a behind schema must not be ready');
    const body = await ready.json();
    assert.equal(body.ready, false);
    assert.equal(body.reason, 'schema_behind', `expected schema_behind, got ${body.reason}`);

    // Liveness is not readiness: a supervisor must still see the process up.
    const health = await fetch(`http://127.0.0.1:${port}/api/health`);
    assert.equal(health.status, 200, '/api/health must keep answering while the process is up');

    // And the runtime applied NOTHING.
    const after = await ledger(leg);
    assert.deepEqual(after, before, 'the runtime must not touch the ledger');
    assert.ok(!after.some((r) => r.id === head.id), 'the runtime must not apply the pending migration');
  } finally {
    await server.stop();
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

check('runtime-holds-no-superuser-or-migration-pool', async () => {
  const leg = 'mfp01_l5';
  await resetLeg(leg);
  const run = await migrate(leg);
  assert.equal(run.code, 0, `migrate must exit 0:\n${run.out.slice(-800)}`);

  // Static: the pools the runtime module builds. It must expose the role each pool connects as,
  // and retain neither an admin nor a migration pool.
  const runtime = await openRuntimePools({ config: configFor(leg) });
  try {
    assert.ok(!('admin' in runtime), 'the runtime must not retain an admin pool');
    assert.ok(!('migration' in runtime), 'the runtime must not retain a migration pool');
    const names = Object.values(runtime.poolRoles || {});
    assert.ok(names.length > 0, 'the runtime must expose the roles its pools connect as');
    const roles = await withAdmin(leg, async (admin) => (await admin.query(
      'SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = ANY($1::text[])', [names])).rows);
    assert.equal(roles.length, names.length, 'every runtime pool role must exist');
    for (const role of roles) {
      assert.equal(role.rolsuper, false, `${role.rolname} must not be SUPERUSER`);
      assert.equal(role.rolbypassrls, false, `${role.rolname} must not be BYPASSRLS`);
    }
  } finally {
    await closeRuntimePools(runtime);
  }

  // Live: the backends the running server actually opened.
  const port = PORTS[leg];
  const server = await startServer(leg, port);
  try {
    const open = await withAdmin(leg, async (admin) => (await admin.query(
      `SELECT a.application_name AS app, r.rolsuper, r.rolbypassrls
         FROM pg_stat_activity a JOIN pg_roles r ON r.rolname = a.usename
        WHERE a.application_name LIKE $1`, [`${leg}:%`])).rows);
    assert.ok(open.length > 0, 'the running server must have opened at least one backend');
    for (const row of open) {
      assert.equal(row.rolsuper, false, `runtime backend ${row.app} must not be SUPERUSER`);
      assert.equal(row.rolbypassrls, false, `runtime backend ${row.app} must not be BYPASSRLS`);
      assert.ok(!/:admin$/.test(row.app), `runtime must not hold an admin backend (${row.app})`);
      assert.ok(!/:migration$/.test(row.app), `runtime must not hold a migration backend (${row.app})`);
    }
  } finally {
    await server.stop();
  }
});

check('control-unmodified-tree-applies-cleanly', async () => {
  const leg = 'mfp01_l6';
  const files = migrationFiles();
  await resetLeg(leg);
  const run = await migrate(leg);
  assert.equal(run.code, 0, `an unmodified tree must apply with exit 0:\n${run.out.slice(-800)}`);
  assert.equal(count(/applied=(\d+)/, run.out), files.length, 'the control applies every migration');
});

/* ==================================================================== run */

export async function runMigrateChecks() {
  if (FORBIDDEN.has(DATABASE)) {
    throw new Error(`refusing to run against ${DATABASE}; set OWNAPI_PG_DATABASE to a disposable database`);
  }
  if (!DATABASE) throw new Error('OWNAPI_PG_DATABASE must name a disposable database');
  if (process.env.OWNAPI_PG_ALLOW !== '1') throw new Error('set OWNAPI_PG_ALLOW=1 to confirm this is a disposable database');
  const results = [];
  for (const { name, run } of checks) {
    try {
      await run();
      results.push({ name, ok: true, detail: 'ok' });
    } catch (error) {
      results.push({ name, ok: false, detail: error && error.message ? error.message.split('\n')[0] : String(error) });
    }
  }
  return { ok: results.every((r) => r.ok), results };
}

const invokedDirectly = process.argv[1] && process.argv[1].endsWith('migrate-check.mjs');
if (invokedDirectly) {
  const report = await runMigrateChecks();
  for (const r of report.results) console.log(`${r.ok ? 'PASS' : 'FAIL'} ${r.name}${r.ok ? '' : `\n  ${r.detail}`}`);
  const failed = report.results.filter((r) => !r.ok).length;
  console.log(`\n${report.results.length - failed} passed, ${failed} failed`);
  console.log(`NOTE disposable schemas ${LEGS.join(', ')} are reset per run; the "hatoove" schema is never touched.`);
  process.exitCode = failed ? 1 : 0;
}

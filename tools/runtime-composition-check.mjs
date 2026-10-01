/**
 * MFP-02a — the RUNNING SERVER is not the test fixture.
 *
 * The claim this slice makes is a composition claim, and a composition claim is worth nothing
 * unless a check fails when the composition is wrong. So this checker is written **first**, runs
 * against the base, and fails there on purpose (legs 1, 2 and 4).
 *
 * What it proves, against a disposable PostgreSQL database:
 *
 *   1. `no-admin-or-migration-pool-in-runtime`
 *        the runtime's own entry point (`loadOwnedApi`) exposes no `admin`, no `migration` and no
 *        `provisioner` pool — and, because a name check alone can be passed by a runtime that
 *        says `learner` while connecting as `postgres`, the ROLES the returned pools actually
 *        connect as are read (`SELECT current_user`) and cross-checked against the live
 *        backends in `pg_stat_activity`: none is the bootstrap superuser, none is SUPERUSER,
 *        BYPASSRLS, CREATEDB or CREATEROLE. `migrate-check` leg 5 makes the same point about
 *        `openRuntimePools()`; this leg makes it about the object the server actually mounts.
 *   2. `no-test-hooks-on-runtime-api`
 *        the object the runtime hands to `createServer` exposes no `inspect` and no `worker`
 *        (the fixture's test hooks: a reader over every table and a job-completing writer).
 *        Asserted explicitly, so the day someone re-adds a seam for convenience it fails.
 *   3. `sign-up-provisions-allowance-without-admin`
 *        a learner signed up through the **runtime's own** path gets an `entitlements` row and a
 *        `learner_settings` row, and the allowance insert went through the `SECURITY DEFINER`
 *        `provision_learner` function rather than a privileged pool. This is the leg that proves
 *        the admin-pool call was REPLACED, not merely deleted.
 *   4. `auth-cannot-mint-allowance-directly-but-can-through-the-function`
 *        the pair that is the point of migration `0008`: the auth role's own `INSERT` into
 *        `entitlements` is refused (it cannot mint allowance), while `provision_learner` — which
 *        the auth role may EXECUTE — inserts. The function's catalogue facts (SECURITY DEFINER,
 *        owned by the migration role, `search_path` pinned, EXECUTE to the auth role only) are
 *        asserted in the same leg.
 *
 * Every leg gets a discrimination leg of its own (a check that cannot fail is not evidence):
 *
 *   D1  `discrimination-admin-passed-back-into-the-runtime-world-fails`
 *         an `admin` key is passed back into the runtime world → leg 1's assertion must throw.
 *         (The record also carries a scratch-tree run of leg 1 against a patched copy, which is
 *         the form §5 of the roadmap names.)
 *   D2  `discrimination-revoked-execute-fails-the-sign-up-leg`
 *         `REVOKE EXECUTE … FROM <auth>` on the real database → the sign-up leg's own path must
 *         fail with a 500 and write no entitlement; re-granting must make it succeed again. This
 *         is executed for real, not simulated.
 *   D3  `discrimination-a-fixture-exposing-runtime-fails-leg-2`
 *         a handle carrying the fixture world (and therefore `inspect`/`worker`) → leg 2's
 *         assertion must throw.
 *   D4  `discrimination-a-writable-entitlements-table-fails-leg-4`
 *         temporarily granting the auth role `INSERT` plus a permissive policy on the live
 *         disposable schema → the direct insert SUCCEEDS, so leg 4's "cannot insert directly"
 *         half is not vacuous. Restored immediately afterwards.
 *
 * Safety: a **disposable** PostgreSQL database (`OWNAPI_PG_*`, `OWNAPI_PG_ALLOW=1`); refuses the
 * default `postgres`/`template0`/`template1`. Each leg owns its own schema and role prefix
 * (`mfp02a_l1` … `mfp02a_l4`) and drops them at the start of its run; the `hatoove` schema a real
 * installation would use is never touched. Synthetic accounts only. No provider call.
 *
 * Usage:
 *   OWNAPI_PG_DATABASE=<disposable> OWNAPI_PG_ALLOW=1 node tools/runtime-composition-check.mjs
 *   ... node tools/runtime-composition-check.mjs --only=<substring>
 *   ... node tools/runtime-composition-check.mjs --list
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import { persistentConfig, createAdminPool, migrate } from '../server/owned-postgres/provision.mjs';
import { loadOwnedApi } from '../server/accounts.mjs';

const FORBIDDEN_DATABASES = new Set(['postgres', 'template0', 'template1']);
const DATABASE = process.env.OWNAPI_PG_DATABASE || '';
const ALLOWANCE = 10;
/** Pools a running server must never hold: the two privileged roles and the sign-up stopgap. */
const FORBIDDEN_POOL_KEYS = ['admin', 'migration', 'provisioner'];
/** The whole runtime surface. Anything else is the fixture world or a test seam. */
const RUNTIME_SURFACE = ['api', 'pools', 'schemaBehind', 'close'];
const LEGS = ['mfp02a_l1', 'mfp02a_l2', 'mfp02a_l3', 'mfp02a_l4'];

const checks = [];
const check = (name, run) => checks.push({ name, run });

/* ============================================================ pure assertions */
/* Exported so a discrimination leg can call them with a deliberately bad input. */

/**
 * Leg 1's assertion, as a pure function over a runtime handle.
 * @param {{pools?: object}} handle
 */
export function assertNoPrivilegedRuntimePool(handle) {
  assert.ok(handle && typeof handle === 'object', 'the runtime must return a handle');
  for (const source of [['the runtime handle', handle], ['the runtime fixture world', handle.fixture], ['runtime.pools', handle.pools]]) {
    const [label, object] = source;
    if (!object || typeof object !== 'object') continue;
    for (const key of FORBIDDEN_POOL_KEYS) {
      assert.ok(!(key in object),
        `${label} exposes a '${key}' pool; the runtime must hold no admin, migration or sign-up-provisioner pool`);
    }
  }
}

/**
 * Leg 2's assertion: the object handed to `createServer` carries no fixture world and no test
 * hook. Explicit on `inspect` and `worker`, because those are the two the fixture provides.
 */
export function assertNoTestHooks(handle) {
  assert.ok(handle && typeof handle === 'object', 'the runtime must return a handle');
  for (const key of ['inspect', 'worker']) {
    assert.ok(!(key in handle), `the runtime handle must not expose '${key}' — that is a test hook, not a server surface`);
  }
  for (const key of Object.keys(handle)) {
    assert.ok(RUNTIME_SURFACE.includes(key),
      `the runtime handle exposes '${key}'; the runtime surface is exactly {${RUNTIME_SURFACE.join(', ')}} — the fixture world is test-only`);
  }
  const api = handle.api;
  assert.ok(api && typeof api === 'object', 'the runtime must hand an api object to createServer');
  for (const key of ['inspect', 'worker', 'fixture', 'store', 'port']) {
    assert.ok(!(key in api), `the runtime api handed to createServer must not expose '${key}'`);
  }
}

/* ================================================================ environment */

/** One leg's config: its own schema AND role prefix, so legs cannot collide. */
const configFor = (leg) => persistentConfig({
  ...process.env, OWNAPI_PG_SCHEMA: leg, OWNAPI_PG_ROLE_PREFIX: leg, OWNAPI_PG_ALLOW: '1',
});

/** The env `loadOwnedApi()` reads: the runtime's entry point for this leg. */
const envFor = (leg) => ({
  ...process.env,
  B1PREP_ACCOUNTS: '1',
  OWNAPI_PG_SCHEMA: leg,
  OWNAPI_PG_ROLE_PREFIX: leg,
  OWNAPI_PG_ALLOW: '1',
});

/** A privileged pool for the checker's own setup and read-backs (never the runtime's). */
async function withAdmin(leg, run) {
  const pool = createAdminPool(configFor(leg), { applicationName: `${leg}:checker` });
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

/** Provision a leg's schema and roles by the MFP-01 command path (the only thing that migrates). */
async function migrateLeg(leg) {
  await resetLeg(leg);
  const summary = await migrate({ config: configFor(leg) });
  assert.ok(summary.applied.length > 0, `leg ${leg}: migrate must apply the frozen migrations`);
  return summary;
}

/* ------------------------------------------------------------------ the api */

/** POST /api/auth/sign-up/email through the runtime's own api object. */
async function httpSignUp(api, { email, name = 'Runtime Learner', password = 'synthetic-password' }) {
  return api.handle({
    method: 'POST',
    path: '/api/auth/sign-up/email',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, email, password }),
    originChecked: true,
  });
}

/** The account id behind a sign-up's cookie, read through the runtime's own api. */
async function sessionUserId(api, cookie) {
  const response = await api.handle({ method: 'GET', path: '/api/auth/get-session', headers: { cookie } });
  assert.equal(response.status, 200, 'get-session must answer 200');
  const body = JSON.parse(response.body);
  assert.ok(body && body.user && typeof body.user.id === 'string', 'a signed-up session must resolve to an account id');
  return body.user.id;
}

/** Every pg Pool reachable from a runtime handle (duck-typed: `query` + `connect` + `end`). */
function poolsOf(handle) {
  const found = [];
  const visit = (object) => {
    if (!object || typeof object !== 'object') return;
    for (const value of Object.values(object)) {
      if (value && typeof value === 'object'
        && typeof value.query === 'function' && typeof value.connect === 'function' && typeof value.end === 'function') {
        if (!found.includes(value)) found.push(value);
      }
    }
  };
  visit(handle);
  visit(handle.pools);
  return found;
}

/* ===================================================================== legs */

check('no-admin-or-migration-pool-in-runtime', async () => {
  const leg = 'mfp02a_l1';
  await migrateLeg(leg);
  const handle = await loadOwnedApi({ env: envFor(leg) });
  assert.ok(handle, 'the runtime entry point must build a runtime when accounts are configured');
  try {
    // (a) The name check: no privileged pool key.
    assertNoPrivilegedRuntimePool(handle);

    // (b) The check a name check cannot make: the roles those pools ACTUALLY connect as.
    //     Reading `current_user` opens one backend per pool, which is what makes (c) meaningful.
    const pools = poolsOf(handle);
    assert.ok(pools.length > 0, 'the runtime must return the pools it opened');
    const roles = [];
    for (const pool of pools) {
      const row = (await pool.query('SELECT current_user AS role')).rows[0];
      roles.push(row.role);
    }
    const bootstrapUser = persistentConfig(envFor(leg)).admin.user;
    assert.ok(!roles.includes(bootstrapUser),
      `the runtime must not connect as the bootstrap user '${bootstrapUser}' (roles: ${roles.join(', ')})`);

    await withAdmin(leg, async (admin) => {
      const attributes = (await admin.query(
        'SELECT rolname, rolsuper, rolbypassrls, rolcreatedb, rolcreaterole FROM pg_roles WHERE rolname = ANY($1::text[])',
        [[...new Set(roles)]])).rows;
      assert.equal(attributes.length, new Set(roles).size, 'every runtime pool role must exist');
      for (const role of attributes) {
        assert.equal(role.rolsuper, false, `${role.rolname} must not be SUPERUSER`);
        assert.equal(role.rolbypassrls, false, `${role.rolname} must not be BYPASSRLS`);
        assert.equal(role.rolcreatedb, false, `${role.rolname} must not be CREATEDB`);
        assert.equal(role.rolcreaterole, false, `${role.rolname} must not be CREATEROLE`);
      }

      // (c) The live backends the runtime's pools actually hold, by application_name.
      const open = (await admin.query(
        `SELECT a.application_name AS app, r.rolsuper, r.rolbypassrls
           FROM pg_stat_activity a JOIN pg_roles r ON r.rolname = a.usename
          WHERE a.application_name LIKE $1 AND a.application_name <> $2`,
        [`${leg}:%`, `${leg}:checker`])).rows;
      assert.ok(open.length > 0, 'the runtime must have opened at least one backend');
      for (const row of open) {
        assert.equal(row.rolsuper, false, `runtime backend ${row.app} must not be SUPERUSER`);
        assert.equal(row.rolbypassrls, false, `runtime backend ${row.app} must not be BYPASSRLS`);
        assert.ok(!/:(admin|migration|provisioner)$/.test(row.app),
          `the runtime must hold no privileged backend (found ${row.app})`);
      }
    });
  } finally {
    await handle.close();
  }
});

check('no-test-hooks-on-runtime-api', async () => {
  const leg = 'mfp02a_l2';
  await migrateLeg(leg);
  const handle = await loadOwnedApi({ env: envFor(leg) });
  assert.ok(handle, 'the runtime entry point must build a runtime when accounts are configured');
  try {
    assertNoTestHooks(handle);
  } finally {
    await handle.close();
  }
});

check('sign-up-provisions-allowance-without-admin', async () => {
  const leg = 'mfp02a_l3';
  await migrateLeg(leg);
  const handle = await loadOwnedApi({ env: envFor(leg) });
  assert.ok(handle, 'the runtime entry point must build a runtime when accounts are configured');
  const email = `signup-${randomUUID()}@mfp02a.invalid`;
  try {
    const response = await httpSignUp(handle.api, { email });
    assert.equal(response.status, 200, `sign-up must succeed: ${response.status} ${response.body}`);
    const cookie = response.headers['set-cookie'];
    assert.ok(cookie, 'sign-up must set a session cookie');
    const userId = await sessionUserId(handle.api, cookie);

    // The allowance row exists, written WITHOUT a privileged runtime pool: the runtime holds
    // none (leg 1), so the only way it was written is the function the auth role may execute.
    const entitlement = await withAdmin(leg, async (admin) => (await admin.query(
      `SELECT owner_id, allowance FROM "${leg}".entitlements WHERE owner_id = $1`, [userId])).rows[0]);
    assert.ok(entitlement, `sign-up must provision an entitlements row for ${userId}`);
    assert.equal(entitlement.allowance, ALLOWANCE, 'the allowance must be the runtime allowance');

    // The learner's settings record: reached through the runtime's own settings port. The row is
    // written by the first settings write (settings.mjs creates it lazily), never by a privileged
    // pool — so this half asserts the account path too, not a second admin-pool call.
    const settings = await handle.api.handle({
      method: 'PUT',
      path: '/api/v1/settings',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ expectedRevision: 0, theme: 'dark' }),
      originChecked: true,
    });
    assert.equal(settings.status, 200, `settings write must succeed: ${settings.status} ${settings.body}`);
    const settingsRow = await withAdmin(leg, async (admin) => (await admin.query(
      `SELECT user_id, revision FROM "${leg}".learner_settings WHERE user_id = $1`, [userId])).rows[0]);
    assert.ok(settingsRow, `sign-up + settings must have provisioned a learner_settings row for ${userId}`);

    /* ---- D2, executed for real: revoke EXECUTE and the same path must fail ---- */
    const authRole = configFor(leg).roles.auth;
    await withAdmin(leg, (admin) => admin.query(
      `REVOKE EXECUTE ON FUNCTION "${leg}".provision_learner(text, integer) FROM "${authRole}"`));
    const deniedEmail = `denied-${randomUUID()}@mfp02a.invalid`;
    const denied = await httpSignUp(handle.api, { email: deniedEmail });
    assert.notEqual(denied.status, 200,
      `with EXECUTE revoked, sign-up must fail — otherwise the leg does not prove the function is the path (got ${denied.status})`);
    await withAdmin(leg, (admin) => admin.query(
      `GRANT EXECUTE ON FUNCTION "${leg}".provision_learner(text, integer) TO "${authRole}"`));
    const recovered = await httpSignUp(handle.api, { email: `recovered-${randomUUID()}@mfp02a.invalid` });
    assert.equal(recovered.status, 200, 're-granting EXECUTE must make sign-up succeed again, so the denial was the revoke');
  } finally {
    await handle.close();
  }
});

check('auth-cannot-mint-allowance-directly-but-can-through-the-function', async () => {
  const leg = 'mfp02a_l4';
  await migrateLeg(leg);
  const config = configFor(leg);
  const handle = await loadOwnedApi({ env: envFor(leg) });
  assert.ok(handle, 'the runtime entry point must build a runtime when accounts are configured');
  try {
    // A user with NO entitlement yet, inserted through the auth role's own rights on "user".
    const userId = `mfp02a-${randomUUID()}`;
    await withAdmin(leg, (admin) => admin.query(
      `INSERT INTO "${leg}"."user"(id, name, email, "emailVerified", "createdAt", "updatedAt")
       VALUES ($1, 'Probe', $2, false, now(), now())`, [userId, `${userId}@mfp02a.invalid`]));

    // Half one: the auth role cannot INSERT into entitlements directly (it cannot mint allowance).
    const direct = await handle.pools.auth.query(
      `INSERT INTO "${leg}".entitlements(owner_id, allowance) VALUES ($1, 999)`, [userId]
    ).then(() => null, (error) => error);
    assert.ok(direct, 'the auth role must NOT be able to INSERT into entitlements directly');
    assert.match(String(direct.code), /42501|insufficient_privilege/, `expected a privilege refusal, got ${direct.code}: ${direct.message}`);

    // Half two: the same role CAN provision through the SECURITY DEFINER function.
    await handle.pools.auth.query('SELECT provision_learner($1, $2)', [userId, ALLOWANCE]);
    const row = await withAdmin(leg, async (admin) => (await admin.query(
      `SELECT owner_id, allowance FROM "${leg}".entitlements WHERE owner_id = $1`, [userId])).rows[0]);
    assert.ok(row, 'provision_learner must insert the entitlement the direct INSERT could not');
    assert.equal(row.allowance, ALLOWANCE);

    // The catalogue facts that make the function narrow: definer, migration-owned, path pinned,
    // EXECUTE to the auth role and to nobody else.
    await withAdmin(leg, async (admin) => {
      const fn = (await admin.query(
        `SELECT p.prosecdef, r.rolname AS owner, p.proconfig
           FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner
          WHERE p.proname = 'provision_learner' AND p.pronamespace = $1::regnamespace`,
        [`"${leg}"`])).rows[0];
      assert.ok(fn, 'provision_learner must exist in the leg schema');
      assert.equal(fn.prosecdef, true, 'provision_learner must be SECURITY DEFINER');
      assert.equal(fn.owner, config.roles.migration, 'provision_learner must be owned by the migration role');
      const path = (fn.proconfig || []).find((c) => c.startsWith('search_path='));
      assert.ok(path && path.includes(leg), `provision_learner must pin search_path to the schema (got ${path})`);

      const grantees = (await admin.query(
        `SELECT grantee FROM information_schema.routine_privileges
          WHERE routine_schema = $1 AND routine_name = 'provision_learner' AND privilege_type = 'EXECUTE'
            AND grantee <> $2`, [leg, config.roles.auth])).rows.map((r) => r.grantee);
      assert.deepEqual(grantees, [], `EXECUTE must be granted to the auth role only (also granted to: ${grantees.join(', ') || 'none'})`);
    });

    /* ---- D4, executed for real: make the direct path work and leg 4's half one must fail ---- */
    const authRole = config.roles.auth;
    await withAdmin(leg, async (admin) => {
      await admin.query(`GRANT INSERT ON "${leg}".entitlements TO "${authRole}"`);
      await admin.query(`CREATE POLICY mfp02a_discrimination ON "${leg}".entitlements FOR INSERT TO "${authRole}" WITH CHECK (true)`);
    });
    let writable;
    try {
      const other = `mfp02a-${randomUUID()}`;
      await withAdmin(leg, (admin) => admin.query(
        `INSERT INTO "${leg}"."user"(id, name, email, "emailVerified", "createdAt", "updatedAt")
         VALUES ($1, 'Probe', $2, false, now(), now())`, [other, `${other}@mfp02a.invalid`]));
      writable = await handle.pools.auth.query(
        `INSERT INTO "${leg}".entitlements(owner_id, allowance) VALUES ($1, 999)`, [other]
      ).then(() => true, (error) => { throw new Error(`discrimination setup did not actually make the table writable: ${error.message}`); });
    } finally {
      await withAdmin(leg, async (admin) => {
        await admin.query(`DROP POLICY IF EXISTS mfp02a_discrimination ON "${leg}".entitlements`);
        await admin.query(`REVOKE INSERT ON "${leg}".entitlements FROM "${authRole}"`);
      });
    }
    assert.equal(writable, true, 'the discrimination must make the direct INSERT succeed, proving half one is not vacuous');
  } finally {
    await handle.close();
  }
});

/* ========================================================= discriminations */

check('discrimination-admin-passed-back-into-the-runtime-world-fails', async () => {
  // §5 of the roadmap: pass `admin` back into the runtime world and leg 1 must fail.
  const withAdminPool = { api: {}, pools: { auth: {}, learner: {}, admin: {} }, schemaBehind: {}, close() {} };
  assert.throws(() => assertNoPrivilegedRuntimePool(withAdminPool),
    /exposes a 'admin' pool|admin/,
    'leg 1 must FAIL when an admin pool is passed back into the runtime world');
});

check('discrimination-a-fixture-exposing-runtime-fails-leg-2', async () => {
  const withFixtureWorld = {
    api: { handle() {}, handleNode() {}, matches() {} },
    pools: {},
    fixture: { worker: { claim() {}, complete() {} }, inspect: { submissionCount() {} } },
    schemaBehind: {},
    close() {},
  };
  assert.throws(() => assertNoTestHooks(withFixtureWorld),
    /fixture/,
    'leg 2 must FAIL when the fixture world (and its inspect/worker hooks) is handed to createServer');
});

/* ==================================================================== run */

function select(names) {
  const only = (process.argv.find((a) => a.startsWith('--only=')) || '').slice('--only='.length);
  if (!only) return names;
  return names.filter((name) => name.includes(only));
}

export async function runRuntimeCompositionChecks() {
  if (FORBIDDEN_DATABASES.has(DATABASE)) {
    throw new Error(`refusing to run against ${DATABASE}; set OWNAPI_PG_DATABASE to a disposable database`);
  }
  if (!DATABASE) throw new Error('OWNAPI_PG_DATABASE must name a disposable database');
  if (process.env.OWNAPI_PG_ALLOW !== '1') throw new Error('set OWNAPI_PG_ALLOW=1 to confirm this is a disposable database');
  const results = [];
  for (const { name, run } of select(checks)) {
    try {
      await run();
      results.push({ name, ok: true, detail: 'ok' });
    } catch (error) {
      results.push({ name, ok: false, detail: error && error.message ? error.message.split('\n')[0] : String(error) });
    }
  }
  return { ok: results.every((r) => r.ok), results };
}

const invokedDirectly = process.argv[1] && process.argv[1].endsWith('runtime-composition-check.mjs');
if (invokedDirectly) {
  if (process.argv.includes('--list')) {
    for (const { name } of checks) console.log(name);
    process.exit(0);
  }
  const report = await runRuntimeCompositionChecks();
  for (const r of report.results) console.log(`${r.ok ? 'PASS' : 'FAIL'} ${r.name}${r.ok ? '' : `\n  ${r.detail}`}`);
  const failed = report.results.filter((r) => !r.ok).length;
  console.log(`\n${report.results.length - failed} passed, ${failed} failed`);
  console.log(`NOTE disposable schemas ${LEGS.join(', ')} are reset per run; the "hatoove" schema is never touched.`);
  process.exitCode = failed ? 1 : 0;
}

/**
 * Account wiring for the running server (A-01 mount).
 *
 * The owned API (`server/owned-api.mjs`) and its PostgreSQL installation
 * (`server/owned-postgres/provision.mjs`) were built and proven rounds ago, but
 * `node server.js` never mounted them: `createServer()` was called with no owned API, so no
 * learner could sign in, no attempt could be owned, and the account-scoped progress store
 * (F-4) and the recoverable-draft service (DRAFT-SESSION-01) had no production caller.
 *
 * This module is the seam that mounts them, and it is deliberately **off by default**:
 *
 *   B1PREP_ACCOUNTS=1        enable accounts (requires a reachable PostgreSQL database)
 *   OWNAPI_PG_*              connection and schema settings; see server/owned-postgres/README.md
 *
 * With the flag unset the server behaves exactly as before - single-user, dependency-free,
 * no database - so nothing that works today stops working.
 *
 * What this does NOT do, stated plainly:
 *   - It is not an authentication hardening pass. The session port is a small synthetic
 *     implementation, not Better Auth: no expiry sweep, rotation, revocation, email
 *     verification, recovery or abuse controls. A hosted deployment also needs `Secure`
 *     cookies, which loopback testing cannot exercise.
 *   - It does not migrate the existing single-user progress file. Today's learner data stays
 *     where it is; reconciling it with owned attempts is the next slice, not this one.
 *   - It carries no secret management: database credentials come from the environment.
 */

/**
 * @returns {{enabled: boolean, reason: string}}
 */
export function accountsConfig(env = process.env) {
  const flag = env.B1PREP_ACCOUNTS;
  if (flag !== '1') {
    return { enabled: false, reason: flag === undefined ? 'B1PREP_ACCOUNTS is not set' : `B1PREP_ACCOUNTS=${flag}` };
  }
  if (!env.OWNAPI_PG_DATABASE) {
    return { enabled: false, reason: 'B1PREP_ACCOUNTS=1 but OWNAPI_PG_DATABASE is not set' };
  }
  return { enabled: true, reason: 'B1PREP_ACCOUNTS=1' };
}

/**
 * Provision the durable installation and build the owned API over it.
 *
 * The pools are shaped into the `fixture` interface `createPostgresWorld` expects
 * (`{schema, roles, learner, auth, worker, admin, close}`), so the world that the checks and
 * the running server use is built by the same code - there is no second, untested wiring.
 *
 * @returns {Promise<{api: object, pools: object, close: Function} | null>} null when accounts are off
 */
export async function loadOwnedApi({ env = process.env } = {}) {
  const config = accountsConfig(env);
  if (!config.enabled) return null;

  const { provisionPersistent, closePersistent, persistentConfig } = await import('./owned-postgres/provision.mjs');
  const { createPostgresWorld } = await import('./owned-postgres/fixture.mjs');
  const { createPostgresSettings } = await import('./owned-postgres/settings.mjs');

  const persistent = await provisionPersistent({ config: persistentConfig(env) });
  // A3: a `pg` pool whose backend disappears emits `error` on the *pool*; with no listener
  // Node aborts the process, so a database blink would take the whole hosted runtime down
  // instead of answering a refusal. Attach a listener that logs a secret-free line and lets
  // the request path return its own 5xx. Guarding every pool closes the idle-client case
  // (sockets dropped with nothing in flight) as well as the in-flight one.
  for (const key of ['migration', 'auth', 'learner', 'worker', 'deletion', 'admin']) {
    const pool = persistent[key];
    if (pool && typeof pool.on === 'function') {
      pool.on('error', (error) => {
        console.error(`  DB pool ${key}: ${error && error.message ? error.message : String(error)}`);
      });
    }
  }
  const fixture = {
    schema: persistent.config.schema,
    roles: persistent.config.roles,
    learner: persistent.learner,
    auth: persistent.auth,
    worker: persistent.worker,
    // The deletion port's pool, so `createPostgresWorld` wires `DELETE /api/v1/account` into
    // the api the running server mounts (HARD-DELETE-01 §6). Without this the route is a 503
    // in every configuration this repository can ship.
    deletion: persistent.deletion,
    admin: persistent.admin,
    // Account settings are part of the account, so they run on the same restricted learner
    // pool; `createPostgresWorld` would otherwise build its own, which would be a second
    // wiring of the same thing.
    settings: createPostgresSettings({ pool: persistent.learner }),
    close: () => closePersistent(persistent),
  };
  const world = await createPostgresWorld({ fixture });
  // `world.api` is built by the same code the checks use, so the running server and the tests
  // cannot drift apart. Building a second API here with the ports re-supplied by hand is what
  // dropped account settings on the floor once already.
  const api = world.api;

  return {
    api,
    pools: persistent,
    fixture,
    applied: persistent.applied,
    skipped: persistent.skipped,
    close: async () => {
      await world.teardown().catch(() => {});
      await closePersistent(persistent);
    },
  };
}

/** A one-line, secret-free summary for the startup banner. */
export function accountsSummary(loaded, { enabled, reason } = {}) {
  if (!loaded) return `accounts: off (${reason || 'not enabled'})`;
  const schema = loaded.fixture && loaded.fixture.schema ? loaded.fixture.schema : 'unknown';
  const applied = Array.isArray(loaded.applied) ? loaded.applied.length : 0;
  const skipped = Array.isArray(loaded.skipped) ? loaded.skipped.length : 0;
  return `accounts: on (schema ${schema}; ${applied} migration(s) applied, ${skipped} already present)`;
}

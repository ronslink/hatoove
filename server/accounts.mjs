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
  const { createOwnedApi } = await import('./owned-api.mjs');

  const persistent = await provisionPersistent({ config: persistentConfig(env) });
  const fixture = {
    schema: persistent.config.schema,
    roles: persistent.config.roles,
    learner: persistent.learner,
    auth: persistent.auth,
    worker: persistent.worker,
    admin: persistent.admin,
    close: () => closePersistent(persistent),
  };
  const world = await createPostgresWorld({ fixture });
  const api = createOwnedApi({ datastore: world.store.port, sessions: world.sessions });

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

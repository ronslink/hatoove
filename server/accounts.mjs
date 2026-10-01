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
 * The runtime's composition lives in `server/runtime.mjs` (`createRuntimeWorld`), which is NOT
 * the test fixture: it wires the datastore, sessions, settings and deletion ports over the
 * restricted pools and exposes no `inspect`, no `worker` and no privileged pool. MFP-02a moved
 * the server off `createPostgresWorld` (the checks' world) onto it, so the object the running
 * server mounts is a runtime object rather than a fixture one.
 *
 * MFP-01: the runtime does **not** apply migrations and holds no `admin` or `migration` pool.
 * `applied`/`skipped` are gone; `schemaBehind` says whether the database is behind the code.
 *
 * The returned surface is exactly `{api, pools, schemaBehind, close}` — no `fixture` key. The
 * check `runtime-composition-check` fails if either the fixture world or a privileged pool comes
 * back.
 *
 * @returns {Promise<{api: object, pools: object, schemaBehind: object, close: Function} | null>} null when accounts are off
 */
export async function loadOwnedApi({ env = process.env } = {}) {
  const config = accountsConfig(env);
  if (!config.enabled) return null;

  // MFP-01: the runtime opens **restricted pools only** — no `admin`, no `migration` — and
  // never applies a migration. It reports whether the applied head is behind what the code
  // expects (`schemaBehind`), which `server.js` maps to `ready:false reason:'schema_behind'`.
  const { openRuntimePools, closeRuntimePools, persistentConfig } = await import('./owned-postgres/provision.mjs');
  const { createRuntimeWorld } = await import('./runtime.mjs');

  const pools = await openRuntimePools({ config: persistentConfig(env) });
  // A3: a `pg` pool whose backend disappears emits `error` on the *pool*; with no listener
  // Node aborts the process, so a database blink would take the whole hosted runtime down
  // instead of answering a refusal. Attach a listener that logs a secret-free line and lets
  // the request path return its own 5xx. Guarding every pool closes the idle-client case
  // (sockets dropped with nothing in flight) as well as the in-flight one.
  for (const key of ['auth', 'learner', 'worker', 'deletion']) {
    const pool = pools[key];
    if (pool && typeof pool.on === 'function') {
      pool.on('error', (error) => {
        console.error(`  DB pool ${key}: ${error && error.message ? error.message : String(error)}`);
      });
    }
  }

  // The runtime world: datastore, sessions, settings and deletion, and no test hook.
  const world = await createRuntimeWorld({ pools });

  return {
    api: world.api,
    pools,
    schemaBehind: pools.behind,
    close: async () => {
      await closeRuntimePools(pools);
    },
  };
}

/** A one-line, secret-free summary for the startup banner. */
export function accountsSummary(loaded, { enabled, reason } = {}) {
  if (!loaded) return `accounts: off (${reason || 'not enabled'})`;
  const schema = loaded.pools && loaded.pools.config ? loaded.pools.config.schema : 'unknown';
  const behind = loaded.schemaBehind;
  if (behind && behind.behind) {
    return `accounts: on (schema ${schema}; SCHEMA BEHIND - expected head ${behind.expectedHead}, applied ${behind.appliedHead || 'none'}; run node server/migrate.mjs)`;
  }
  return `accounts: on (schema ${schema}; schema at the expected head)`;
}

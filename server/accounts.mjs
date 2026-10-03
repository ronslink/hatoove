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
 * MFP-01: the runtime does **not** apply migrations and holds no `admin` or `migration` pool.
 * `applied`/`skipped` are gone; `schemaBehind` says whether the database is behind the code.
 *
 * @returns {Promise<{api: object, pools: object, fixture: object, schemaBehind: object, close: Function} | null>} null when accounts are off
 */
export async function loadOwnedApi({ env = process.env } = {}) {
  const config = accountsConfig(env);
  if (!config.enabled) return null;

  // MFP-01: the runtime opens **restricted pools only** — no `admin`, no `migration` — and
  // never applies a migration. It reports whether the applied head is behind what the code
  // expects (`schemaBehind`), which `server.js` maps to `ready:false reason:'schema_behind'`.
  const { openRuntimePools, closeRuntimePools, persistentConfig, persistentRolePool } = await import('./owned-postgres/provision.mjs');
  const { createPostgresWorld } = await import('./owned-postgres/fixture.mjs');
  const { createPostgresSettings } = await import('./owned-postgres/settings.mjs');
  const { createConsoleNotifier } = await import('./notify.mjs');
  const { createDatabaseReadiness } = await import('./readiness.mjs');

  const runtime = await openRuntimePools({ config: persistentConfig(env) });
  // A3: a `pg` pool whose backend disappears emits `error` on the *pool*; with no listener
  // Node aborts the process, so a database blink would take the whole hosted runtime down
  // instead of answering a refusal. Attach a listener that logs a secret-free line and lets
  // the request path return its own 5xx. Guarding every pool closes the idle-client case
  // (sockets dropped with nothing in flight) as well as the in-flight one.
  for (const key of ['auth', 'learner', 'worker', 'deletion', 'provisioner']) {
    const pool = runtime[key];
    if (pool && typeof pool.on === 'function') {
      pool.on('error', (error) => {
        console.error(`  DB pool ${key}: ${error && error.message ? error.message : String(error)}`);
      });
    }
  }
  const fixture = {
    schema: runtime.config.schema,
    roles: runtime.config.roles,
    learner: runtime.learner,
    auth: runtime.auth,
    worker: runtime.worker,
    // The deletion port's pool, so `createPostgresWorld` wires `DELETE /api/v1/account` into
    // the api the running server mounts (HARD-DELETE-01 §6). Without this the route is a 503
    // in every configuration this repository can ship.
    deletion: runtime.deletion,
    // Compatibility alias for fixture inspection only, never a superuser pool.
    // Registration provisions through the migration-owned AFTER INSERT user trigger in its
    // auth transaction; the former provisioner INSERT and column SELECT grants are revoked.
    admin: runtime.provisioner,
    // Account settings are part of the account, so they run on the same restricted learner
    // pool; `createPostgresWorld` would otherwise build its own, which would be a second
    // wiring of the same thing.
    settings: createPostgresSettings({ pool: runtime.learner }),
  };
  /*
   * ACCOUNT RECOVERY'S DELIVERY CHANNEL (D6), wired here so the RUNNING server has it and not only the checks.
   *
   * The pilot is operator-assisted: `createConsoleNotifier` writes the reset link to the operator console and
   * NO message leaves the building, because the email provider is a data processor whose terms a human has to
   * accept and that decision (D6) is unanswered. Adopting one later replaces `server/notify.mjs` and nothing
   * else.
   *
   * The origin comes from configuration rather than from a request header: a link built from `Host:` would let
   * whoever sent the request choose where the learner's reset link points, which is a redirection primitive.
   */
  fixture.notifier = createConsoleNotifier({
    log: (line) => console.log(line),
    publicOrigin: env.B1PREP_PUBLIC_ORIGIN || env.HATOVE_PUBLIC_ORIGIN || null,
  });
  const world = await createPostgresWorld({ fixture });
  // `world.api` is built by the same code the checks use, so the running server and the tests
  // cannot drift apart. Building a second API here with the ports re-supplied by hand is what
  // dropped account settings on the floor once already.
  const api = world.api;
  // One dedicated restricted learner connection keeps health probes bounded without occupying
  // the application's query pool. It never reads learner data or holds migration privileges.
  const readiness = createDatabaseReadiness({ pool: persistentRolePool(runtime.config, 'learner', { max: 1 }) });

  return {
    api,
    pools: runtime,
    fixture,
    schemaBehind: runtime.behind,
    checkReadiness: readiness.check,
    close: async () => {
      await readiness.close();
      await world.teardown().catch(() => {});
      await closeRuntimePools(runtime);
    },
  };
}

/** A one-line, secret-free summary for the startup banner. */
export function accountsSummary(loaded, { enabled, reason } = {}) {
  if (!loaded) return `accounts: off (${reason || 'not enabled'})`;
  const schema = loaded.fixture && loaded.fixture.schema ? loaded.fixture.schema : 'unknown';
  /*
   * WHETHER RATE LIMITING IS ACTIVE IS PART OF THE SUMMARY, because the auth throttle FAILS OPEN: an
   * installation without the port keeps serving, which is the right choice for availability and a fact an
   * operator must be able to see rather than assume. A startup line that reads "throttle on" is the difference
   * between a known gap and a silent one.
   */
  const throttled = loaded.api && typeof loaded.api.throttled === 'boolean'
    ? (loaded.api.throttled ? '; auth throttle on' : '; AUTH THROTTLE OFF - sign-in, sign-up and password change are unlimited')
    : '';
  const behind = loaded.schemaBehind;
  if (behind && behind.behind) {
    return `accounts: on (schema ${schema}${throttled}; SCHEMA BEHIND - expected head ${behind.expectedHead}, applied ${behind.appliedHead || 'none'}; run node server/migrate.mjs)`;
  }
  return `accounts: on (schema ${schema}${throttled}; schema at the expected head)`;
}

/**
 * The RUNTIME world (MFP-02a).
 *
 * Until this slice the running server was assembled by `server/accounts.mjs` into the
 * **test fixture**'s interface and handed to `createPostgresWorld()` — the module the checks use.
 * That carried two things into production that have no business there:
 *
 *   - the fixture's test hooks (`inspect`, `worker`), one of which completes assessments, and
 *   - the `admin` key, which at this base was the narrow `_provisioner` stopgap pool.
 *
 * This module is the runtime's own composition, and it is deliberately NOT the fixture:
 *
 *   datastore -> the restricted learner pool (FORCE RLS is the ownership boundary)
 *   sessions  -> the restricted auth pool; sign-up provisions through `provision_learner`
 *   settings  -> the restricted learner pool
 *   deletion  -> the dedicated deletion pool (the one hard-delete transaction)
 *
 * There is no `inspect`, no `worker`, no `store` and no privileged pool. A caller that needs the
 * fixture's hooks builds the fixture world (`createPostgresWorld`, `fixture.mjs`) — that is what
 * `owned-api-check`, `deletion-check`, `worker-runner-check` and `worker-wire-check` do, and it
 * stays.
 *
 * The one step that needs more than the restricted roles is sign-up's allowance insert. It runs
 * as `provision_learner(user_id, allowance)`, a `SECURITY DEFINER` function owned by the
 * migration role and EXECUTE-able by the auth role alone (migration `0008-provision-learner`) —
 * so the runtime needs no pool that can write `entitlements` directly.
 */

import { createPostgresDatastore, createPostgresAccountDeletion } from './owned-postgres/adapter.mjs';
import { createPostgresSessions } from './owned-postgres/sessions.mjs';
import { createPostgresSettings } from './owned-postgres/settings.mjs';
import { createOwnedApi } from './owned-api.mjs';

/**
 * Build the runtime's API over the restricted pools `openRuntimePools()` opened.
 *
 * @param {{pools: object, allowance?: number}} options `pools` is the runtime pool set
 *   (`auth`, `learner`, `worker`, `deletion`) — no `admin` and no `migration` among them.
 * @returns {Promise<{api: object, datastore: object, sessions: object, settings: object, deletion: object|null}>}
 *   the runtime surface. It is exactly this: no fixture world, no test hook.
 */
export async function createRuntimeWorld({ pools, allowance = 10 } = {}) {
  if (!pools || typeof pools !== 'object') throw new TypeError('createRuntimeWorld requires the runtime pools');

  const datastore = createPostgresDatastore({ pool: pools.learner });
  const sessions = createPostgresSessions({
    pool: pools.auth,
    allowance,
    // The runtime has no privileged pool: the allowance arrives through the migration-owned
    // SECURITY DEFINER function, which the auth role — and only the auth role — may execute.
    provision: async (userId, value) => {
      await pools.auth.query('SELECT provision_learner($1, $2)', [userId, value]);
    },
  });
  const settings = createPostgresSettings({ pool: pools.learner });
  const deletion = pools.deletion ? createPostgresAccountDeletion({ pool: pools.deletion }) : null;
  const api = createOwnedApi({ datastore, sessions, settings, accountDeletion: deletion });

  return { api, datastore, sessions, settings, deletion };
}

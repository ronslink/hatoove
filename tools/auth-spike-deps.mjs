/**
 * AUTH-01-SPIKE — dependency loader for the probes.
 *
 * The root app is deliberately dependency-free (`package.json` has `"dependencies": {}`),
 * and this slice MUST NOT change that. So the probes do not `import 'better-auth'` from the
 * checkout; they import it from an installed tree OUTSIDE the checkout, whose path is given
 * by `AUTHSPIKE_DEPS` (default: the scratch tree the record names).
 *
 * Reproduce on any machine:
 *   mkdir -p /tmp/authspike-scratch && cd /tmp/authspike-scratch
 *   cp <checkout>/spikes/auth-runtime/package.json .   # pins better-auth 1.7.6, pg 8.23.1
 *   npm install
 *   AUTHSPIKE_DEPS=/tmp/authspike-scratch node <checkout>/tools/auth-spike-f1-hash.mjs
 *
 * `spikes/auth-runtime/package-lock.json` pins the exact tree the PR #11 spike exercised, so
 * `npm ci` there also reproduces it (that directory's `node_modules/` is gitignored).
 */
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';

export const DEFAULT_DEPS = '/root/workspaces/authspike-scratch';

export async function loadDeps(root = process.env.AUTHSPIKE_DEPS || DEFAULT_DEPS) {
  const require = createRequire(join(root, 'package.json'));
  const load = (spec) => import(pathToFileURL(require.resolve(spec)).href);
  const [authMod, migrationMod, cryptoMod, pgMod] = await Promise.all([
    load('better-auth'),
    load('better-auth/db/migration'),
    load('better-auth/crypto'),
    load('pg'),
  ]);
  const pg = pgMod.default ?? pgMod;
  return {
    root,
    betterAuth: authMod.betterAuth,
    getMigrations: migrationMod.getMigrations,
    crypto: cryptoMod,
    pg,
    Pool: pg.Pool,
  };
}

export function requireDepsMessage(root) {
  return `Could not load better-auth/pg from ${root}. Set AUTHSPIKE_DEPS to an npm-installed tree (see the file header).`;
}

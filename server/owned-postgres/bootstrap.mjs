/**
 * Disposable PostgreSQL fixture bootstrap for OWNAPI-02 (source-only).
 *
 * Creates a random `ownapi_<hex>` schema and five real LOGIN roles
 * (`_migration`, `_auth`, `_learner`, `_worker`, `_deletion`), then applies the SAME proven SQL
 * as the isolation spike, reused verbatim from `spikes/auth-runtime/`:
 *   - `auth-schema.sql`  the tracked pinned-library auth schema
 *   - `schema.sql`       attempts/drafts/submissions/jobs/entitlements/assessments/usage_ledger
 *   - `isolation.sql`    role grants, ENABLE + FORCE ROW LEVEL SECURITY, owner policies
 *   - `accountSettingsSql` + `deletionRoleSql` + `contentCatalogueSql` from `provisioning-sql.mjs`
 *     — the SAME builders `provision.mjs` records as migrations `0004`, `0005` and `0006`, so
 *     this fixture is a real installation's schema and least-privilege grants, not an
 *     approximation of them.
 *
 * It is never run automatically and never against a shared database: the target
 * defaults to the documented disposable fixture (127.0.0.1:55435, database
 * `hatoove_spike`) and every created object is random-named and dropped by
 * `cleanup()`. Configuration comes from `OWNAPI_PG_*` (see README.md).
 */

import pg from 'pg';
import { importDefaultPackage } from './package-importer.mjs';
import { randomBytes } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { accountSettingsSql, deletionRoleSql, contentCatalogueSql, examScopeSql } from './provisioning-sql.mjs';

const SPIKE = new URL('../../spikes/auth-runtime/', import.meta.url);
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;
const SCHEMA_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;
const ROLE_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;

const ident = (name) => {
  if (!IDENTIFIER.test(name)) throw new Error(`Unsafe identifier: ${String(name)}`);
  return `"${name}"`;
};

/** Connection settings; defaults match the disposable CI/local fixture. */
export function pgConfig(env = process.env) {
  return {
    host: env.OWNAPI_PG_HOST || '127.0.0.1',
    port: Number(env.OWNAPI_PG_PORT || 55435),
    database: env.OWNAPI_PG_DATABASE || 'hatoove_spike',
    user: env.OWNAPI_PG_USER || 'postgres',
    ...(env.OWNAPI_PG_PASSWORD ? { password: env.OWNAPI_PG_PASSWORD } : {}),
  };
}

const connection = (config, extra) => ({
  host: config.host, port: config.port, database: config.database, ...extra,
});

/** Pool bound to one restricted role, search_path fixed to the given schema. */
export function rolePool(config, schema, user, max = 2) {
  if (!SCHEMA_NAME.test(schema)) throw new Error(`Unsafe schema name: ${String(schema)}`);
  if (!ROLE_NAME.test(user)) throw new Error(`Unsafe role name: ${String(user)}`);
  return new pg.Pool({
    ...connection(config, { user }), max, application_name: schema,
    options: `-c search_path=${schema},pg_catalog`,
  });
}

/**
 * Provision one isolated schema + roles and apply the tracked SQL.
 * @returns {Promise<object>} pools, role names and an idempotent `cleanup()`.
 */
export async function createFixture({ stopBefore = null, ...overrides } = {}) {
  const config = { ...pgConfig(), ...overrides };
  const schema = `ownapi_${randomBytes(8).toString('hex')}`;
  const roles = Object.fromEntries(['migration', 'auth', 'learner', 'worker', 'deletion', 'payments', 'operator'].map((k) => [k, `${schema}_${k}`]));
  const admin = new pg.Pool({
    ...connection(config, { user: config.user }), max: 4, application_name: schema,
    options: `-c search_path=${schema},pg_catalog`,
  });
  const pools = {};
  const created = [];
  let cleaned = false;

  const cleanup = async () => {
    if (cleaned) return;
    cleaned = true;
    await Promise.all(Object.values(pools).map((pool) => pool.end().catch(() => {})));
    try {
      await admin.query(`DROP SCHEMA IF EXISTS ${ident(schema)} CASCADE`);
      if (created.includes(roles.migration)) {
        await admin.query(
          `ALTER DEFAULT PRIVILEGES FOR ROLE ${ident(roles.migration)} GRANT EXECUTE ON FUNCTIONS TO PUBLIC`);
      }
      for (const role of [...created].reverse()) {
        await admin.query(`DROP ROLE IF EXISTS ${ident(role)}`).catch(() => {});
      }
    } finally {
      await admin.end().catch(() => {});
    }
  };

  try {
    // This is the dedicated disposable fixture database, never another app's DB.
    await admin.query(`REVOKE CREATE, TEMPORARY ON DATABASE ${ident(config.database)} FROM PUBLIC`);
    for (const role of Object.values(roles)) {
      await admin.query(
        `CREATE ROLE ${ident(role)} LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 5`);
      created.push(role);
    }
    await admin.query(`CREATE SCHEMA ${ident(schema)} AUTHORIZATION ${ident(roles.migration)}`);
    pools.migration = rolePool(config, schema, roles.migration, 2);
    pools.auth = rolePool(config, schema, roles.auth, 2);
    pools.learner = rolePool(config, schema, roles.learner, 1);
    pools.worker = rolePool(config, schema, roles.worker, 2);
    pools.deletion = rolePool(config, schema, roles.deletion, 2);
    pools.payments = rolePool(config, schema, roles.payments, 2);
    // PILOT-FEEDBACK-01 (FB-D): the operator pool exists for the CHECK, and for the CLI when it runs against a
    // disposable installation. The running server never opens it.
    pools.operator = rolePool(config, schema, roles.operator, 1);

    await pools.migration.query(await readFile(new URL('auth-schema.sql', SPIKE), 'utf8'));
    await pools.migration.query(await readFile(new URL('schema.sql', SPIKE), 'utf8'));
    let isolation = await readFile(new URL('isolation.sql', SPIKE), 'utf8');
    for (const [key, value] of Object.entries({ SCHEMA: schema, AUTH: roles.auth, LEARNER: roles.learner, WORKER: roles.worker })) {
      isolation = isolation.replaceAll(`__${key}__`, value);
    }
    await pools.migration.query(isolation);
    // Migrations 0004, 0005 and 0006 of a persistent installation, from the one shared
    // builder — so the disposable fixture has the SAME schema and content an installation has.
    await pools.migration.query(accountSettingsSql({ schema, roles }));
    await pools.migration.query(deletionRoleSql({ schema, roles }));
    await pools.migration.query(contentCatalogueSql({ schema, roles }));
    // PILOT-04. Applied AFTER the catalogue, mirroring 0006 -> 0009 in the persistent path, so the
    // disposable fixture has the same exam scope an installation has. Without this the fixture had
    // no `exam_package` at all while the product did.
    await pools.migration.query(examScopeSql({ schema, roles }));
    /*
     * LIBRARY-SEED — every TRACKED content migration from 0010 onward, applied from the file.
     *
     * This used to name 0010 explicitly, which made the fixture correct for exactly one migration and
     * silently stale for the next four. Now every content migration is picked up automatically, so the
     * fixture gains vocab, nouns, the guides and whatever comes next WITHOUT another edit here -- and
     * the failure mode of forgetting is gone rather than merely postponed.
     *
     * The hand-mirrored generators above stop at 0009 (`contentCatalogueSql` mirrors 0006 because it
     * is a page of SQL). From 0010 the files are large generated inserts, so hand-mirroring them would
     * guarantee the fixture and the product drift -- invisibly, until a learner was marked against the
     * wrong key. 0010+ are therefore APPLIED, not duplicated.
     */
    const migrationDir = new URL('../migrations/', import.meta.url);
    /*
     * `stopBefore` (e.g. '0023-') builds the schema as it was BEFORE a migration, so an upgrade check can seed
     * legacy rows and then apply the rest with `applyRemaining()` — in one transaction per file, as the
     * persistent path does. Without it every file is applied, as before.
     */
    const contentMigrations = (await readdir(migrationDir))
      .filter((file) => /^\d{4}-.*\.sql$/.test(file) && file >= '0010-')
      .sort();
    const render = (text) => {
      /*
       * THE SAME PLACEHOLDERS THE DEPLOYMENT PATH RENDERS, and now in one loop so the two cannot drift.
       * `__AUTH__` was missing here while `renderSql` in `provision.mjs` substituted it: a migration granting
       * anything to the auth role — the throttle table is the first — would have left the literal
       * `__AUTH__` in the SQL and failed ONLY in the disposable fixture, which is the one place a check runs.
       */
      let rendered = text;
      for (const [key, value] of Object.entries({ SCHEMA: schema, AUTH: roles.auth, LEARNER: roles.learner, WORKER: roles.worker, DELETION: roles.deletion, PAYMENTS: roles.payments, OPERATOR: roles.operator })) {
        rendered = rendered.replaceAll(`__${key}__`, value);
      }
      return rendered;
    };
    const pending = stopBefore ? contentMigrations.filter((file) => file >= stopBefore) : [];
    for (const file of contentMigrations.filter((name) => !pending.includes(name))) {
      await pools.migration.query(render(await readFile(new URL(file, migrationDir), 'utf8')));
    }
    if (!pending.length) await importDefaultPackage(pools.migration);
    /** Apply the migrations `stopBefore` held back, each in its own transaction as the migration role. */
    const applyRemaining = async () => {
      const applied = [];
      while (pending.length) {
        const file = pending.shift();
        const client = await pools.migration.connect();
        try {
          await client.query('BEGIN');
          await client.query(render(await readFile(new URL(file, migrationDir), 'utf8')));
          await client.query('COMMIT');
          applied.push(file);
        } catch (error) {
          await client.query('ROLLBACK').catch(() => {});
          throw error;
        } finally {
          client.release();
        }
      }
      await importDefaultPackage(pools.migration);
      return applied;
    };

    return { schema, roles, config, admin, ...pools, cleanup, applyRemaining };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

/**
 * Persistent PostgreSQL provisioning for a multi-user server (OWNAPI-03).
 *
 * `bootstrap.mjs` next to this file is a **disposable test fixture**: it invents a random
 * `ownapi_<hex>` schema and four random roles and drops them on cleanup. That is exactly
 * right for a checker and exactly wrong for an install, because a restart would orphan the
 * learners' data in a schema nothing points at any more.
 *
 * This module is the durable counterpart. It is **idempotent**: it creates the schema and
 * the four least-privilege login roles only when they do not already exist, and it applies
 * each tracked SQL file **once**, recorded in `hatoove_migrations`. Running it twice is a
 * no-op; running it after a restart keeps every row.
 *
 * Role model (unchanged from the proven spike, and the reason FORCE RLS is meaningful):
 *   <prefix>_migration  owns the schema, applies DDL, has no runtime route
 *   <prefix>_auth       the pinned-library auth tables (user/session/account/verification)
 *   <prefix>_learner    serves learner routes; NON-superuser, NOBYPASSRLS, so RLS applies
 *   <prefix>_worker     claims and completes assessment jobs
 *   <prefix>_deletion   runs the one hard account-deletion transaction (HARD-DELETE-01 §6);
 *                       NON-superuser, NOBYPASSRLS, owner-scoped policies, no other route
 *
 * What this does NOT do, stated plainly:
 *   - It does not deploy anything and does not create the *database* itself; the operator
 *     supplies an existing database and credentials.
 *   - It carries no secret management. Passwords come from the environment; nothing is
 *     written to disk by this module.
 *   - It does not replace `bootstrap.mjs`, which stays for the isolated test runs.
 *   - Applying it proves schema and role isolation. It does not close the P-03/X-01 gate.
 *
 * DEPLOYMENT SHAPE — ONE database for every user (Ron, 2026-10-01)
 *
 * This is a **single PostgreSQL database shared by all users**. It is *not* a database per
 * user, and *not* a schema per user. Multi-tenancy is carried by **`owner_id` together with
 * `FORCE ROW LEVEL SECURITY`**: every user's rows live in the same tables, and the database
 * itself refuses to show one owner another owner's rows. That is the entire reason the learner
 * role is created `NOBYPASSRLS`, and why the isolation proof reads a foreign row as empty.
 *
 * `OWNAPI_PG_SCHEMA` therefore names the **one application schema** inside that database — a
 * deployment and upgrade unit, like a namespace — and **must never be varied per user or per
 * tenant**: a schema per user would multiply migrations, roles and policies by the number of
 * learners and would put isolation in the wrong place. The policies are the isolation.
 *
 * Configuration (`OWNAPI_PG_*`, all optional except in a real deployment):
 *   OWNAPI_PG_HOST, OWNAPI_PG_PORT, OWNAPI_PG_DATABASE, OWNAPI_PG_USER, OWNAPI_PG_PASSWORD
 *   OWNAPI_PG_SCHEMA        default `hatoove`
 *   OWNAPI_PG_ROLE_PREFIX   default `hatoove`
 *   OWNAPI_PG_<ROLE>_PASSWORD  optional per-role passwords; the restricted roles are
 *                              created with no password unless one is supplied, because a
 *                              local trust/peer connection needs none.
 *
 * See work/implementation/OWNAPI-03.md.
 */

import pg from 'pg';
import { readFile } from 'node:fs/promises';
import { accountSettingsSql, deletionRoleSql, contentCatalogueSql } from './provisioning-sql.mjs';

const SPIKE = new URL('../../spikes/auth-runtime/', import.meta.url);
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;
// `deletion` is the account-deletion port's role (HARD-DELETE-01 §6): least privilege for the
// one ordered transaction that removes an account, never used by a learner route.
const ROLES = ['migration', 'auth', 'learner', 'worker', 'deletion'];

/** The tracked SQL applied in order, once each, and recorded by id. */
export const MIGRATIONS = Object.freeze([
  { id: '0001-auth-schema', file: new URL('auth-schema.sql', SPIKE) },
  { id: '0002-owned-schema', file: new URL('schema.sql', SPIKE) },
  { id: '0003-isolation', file: new URL('isolation.sql', SPIKE) },
  // Hatoove's own table, not part of the reused spike SQL, so it is built in JS rather than
  // shipped as a file — but from the same builder `bootstrap.mjs` uses, so the disposable
  // fixture and a real installation cannot drift apart. Idempotent on its own: an installation
  // created before this migration exists already holds the tracked tables, and only this one
  // is added.
  { id: '0004-account-settings', sql: (config) => accountSettingsSql(config) },
  // The account-deletion role's grants and owner-scoped policies (HARD-DELETE-01 §6). Without
  // this, a provisioned installation has no role that can run the deletion at all.
  { id: '0005-account-deletion', sql: (config) => deletionRoleSql(config) },
  // SAAS-MODEL-01 Step 1: the writing task family as versioned shared content records, plus
  // the forward-only binding columns on `attempts`. Additive and non-destructive: it rewrites
  // no existing row. See `provisioning-sql.mjs` and `content-seed.mjs`.
  { id: '0006-content-and-catalogue', sql: (config) => contentCatalogueSql(config) },
]);

const ident = (name) => {
  if (!IDENTIFIER.test(name)) throw new Error(`Unsafe identifier: ${String(name)}`);
  return `"${name}"`;
};

/** Literal for a password, or NULL when none is configured. Never logged. */
const literal = (value) => (typeof value === 'string' && value.length
  ? `'${value.replaceAll("'", "''")}'` : 'NULL');

export function persistentConfig(env = process.env) {
  const schema = env.OWNAPI_PG_SCHEMA || 'hatoove';
  const prefix = env.OWNAPI_PG_ROLE_PREFIX || 'hatoove';
  if (!IDENTIFIER.test(schema)) throw new Error(`OWNAPI_PG_SCHEMA is not a safe identifier: ${schema}`);
  if (!IDENTIFIER.test(prefix)) throw new Error(`OWNAPI_PG_ROLE_PREFIX is not a safe identifier: ${prefix}`);
  const roles = Object.fromEntries(ROLES.map((role) => [role, `${prefix}_${role}`]));
  for (const name of Object.values(roles)) {
    if (name.length > 63) throw new Error(`role name too long: ${name}`);
  }
  const passwords = Object.fromEntries(
    ROLES.map((role) => [role, env[`OWNAPI_PG_${role.toUpperCase()}_PASSWORD`] || null]),
  );
  return {
    admin: {
      host: env.OWNAPI_PG_HOST || '127.0.0.1',
      port: Number(env.OWNAPI_PG_PORT || 5432),
      database: env.OWNAPI_PG_DATABASE || 'hatoove',
      user: env.OWNAPI_PG_USER || 'postgres',
      ...(env.OWNAPI_PG_PASSWORD ? { password: env.OWNAPI_PG_PASSWORD } : {}),
    },
    schema,
    prefix,
    roles,
    passwords,
  };
}

/** A pool bound to one restricted role with `search_path` pinned to the schema. */
export function persistentRolePool(config, role, { max = 4 } = {}) {
  const user = config.roles[role];
  if (!user) throw new Error(`unknown role: ${role}`);
  return new pg.Pool({
    host: config.admin.host,
    port: config.admin.port,
    database: config.admin.database,
    user,
    ...(config.passwords[role] ? { password: config.passwords[role] } : {}),
    max,
    application_name: `${config.schema}:${role}`,
    options: `-c search_path=${config.schema},pg_catalog`,
  });
}

/**
 * Create the schema and the four roles if (and only if) they are missing. Idempotent:
 * role creation is guarded on `pg_roles` because PostgreSQL has no `CREATE ROLE IF NOT
 * EXISTS`, and the schema is created only when absent so its owner is never changed.
 */
export async function ensureRolesAndSchema(admin, config) {
  await admin.query(`REVOKE CREATE, TEMPORARY ON DATABASE ${ident(config.admin.database)} FROM PUBLIC`);
  for (const role of ROLES) {
    const name = config.roles[role];
    await admin.query(`DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${name}') THEN
          CREATE ROLE ${ident(name)} LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 10 PASSWORD ${literal(config.passwords[role])};
        END IF;
      END $$;`);
  }
  await admin.query(`CREATE SCHEMA IF NOT EXISTS ${ident(config.schema)} AUTHORIZATION ${ident(config.roles.migration)}`);
}

/** The applied-migration ledger. Created on first use, never dropped. */
async function ensureLedger(pool, schema) {
  await pool.query(`CREATE TABLE IF NOT EXISTS ${ident(schema)}.hatoove_migrations (
    id text PRIMARY KEY,
    applied_at timestamptz NOT NULL DEFAULT now()
  )`);
}

/** Which migration ids have already been applied. */
export async function appliedMigrations(pool, schema) {
  const { rows } = await pool.query(`SELECT id FROM ${ident(schema)}.hatoove_migrations ORDER BY id`);
  return rows.map((row) => row.id);
}

/**
 * Apply every migration that has not been applied yet, in order, each in one transaction
 * together with its ledger row - so a failure leaves neither a half-applied schema nor a
 * recorded-but-unapplied migration.
 *
 * @returns {Promise<{applied: string[], skipped: string[]}>}
 */
export async function applyMigrations(pool, config) {
  await ensureLedger(pool, config.schema);
  const done = new Set(await appliedMigrations(pool, config.schema));
  const applied = [];
  const skipped = [];
  for (const migration of MIGRATIONS) {
    if (done.has(migration.id)) { skipped.push(migration.id); continue; }
    let sql = migration.sql
      ? migration.sql(config)
      : await readFile(migration.file, 'utf8');
    if (migration.id === '0003-isolation') {
      for (const [key, value] of Object.entries({
        SCHEMA: config.schema, AUTH: config.roles.auth, LEARNER: config.roles.learner, WORKER: config.roles.worker,
      })) sql = sql.replaceAll(`__${key}__`, value);
      // The isolation SQL hard-codes the schema name in a few places only through the
      // placeholders above; the tables themselves live in the pinned search_path.
    }
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query(`INSERT INTO ${ident(config.schema)}.hatoove_migrations (id) VALUES ($1)`, [migration.id]);
      await client.query('COMMIT');
      applied.push(migration.id);
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }
  return { applied, skipped };
}

/**
 * Provision (or verify) a persistent installation and return pools for the runtime roles.
 * Call once at server start; it is safe to call on every start.
 *
 * @param {object} [options]
 * @param {object} [options.config] precomputed `persistentConfig()` result
 * @returns {Promise<{config: object, migration: object, auth: object, learner: object, worker: object, applied: string[], skipped: string[]}>}
 */
export async function provisionPersistent({ config = persistentConfig() } = {}) {
  // The privileged pool carries the same pinned `search_path` as the role pools: several
  // adapters (notably sessions.mjs) use unqualified table names, and an empty search_path
  // here would fail with `relation "session" does not exist` while every role pool worked.
  const admin = new pg.Pool({
    ...config.admin, max: 2, application_name: `${config.schema}:admin`,
    options: `-c search_path=${config.schema},pg_catalog`,
  });
  let migrationPool = null;
  try {
    await ensureRolesAndSchema(admin, config);
    migrationPool = persistentRolePool(config, 'migration', { max: 2 });
    const result = await applyMigrations(migrationPool, config);
    const pools = {
      config,
      migration: migrationPool,
      auth: persistentRolePool(config, 'auth'),
      learner: persistentRolePool(config, 'learner', { max: 4 }),
      worker: persistentRolePool(config, 'worker'),
      // The account-deletion port's own connection pool. Built here so every consumer
      // (`server/accounts.mjs`, the checks) takes it from the one provisioning path.
      deletion: persistentRolePool(config, 'deletion'),
      ...result,
      admin,
    };
    return pools;
  } catch (error) {
    if (migrationPool) await migrationPool.end().catch(() => {});
    await admin.end().catch(() => {});
    throw error;
  }
}

/** Close every pool `provisionPersistent()` opened. Idempotent. */
export async function closePersistent(pools) {
  if (!pools) return;
  for (const key of ['migration', 'auth', 'learner', 'worker', 'deletion', 'admin']) {
    const pool = pools[key];
    if (pool && typeof pool.end === 'function') await pool.end().catch(() => {});
  }
}

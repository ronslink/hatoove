/**
 * Persistent PostgreSQL provisioning for a multi-user server (OWNAPI-03, MFP-01).
 *
 * `bootstrap.mjs` next to this file is a **disposable test fixture**: it invents a random
 * `ownapi_<hex>` schema and five random roles and drops them on cleanup. That is exactly
 * right for a checker and exactly wrong for an install, because a restart would orphan the
 * learners' data in a schema nothing points at any more.
 *
 * This module is the durable counterpart. It is **idempotent**: it creates the schema and the
 * least-privilege login roles only when they do not already exist, and it applies each tracked
 * SQL file **once**, recorded in `hatoove_migrations`. Running it twice is a no-op; running it
 * after a restart keeps every row.
 *
 * MFP-01 — migrations are frozen, checksummed, and applied by a command:
 *   - the applied SQL lives in `server/migrations/`, **not** in `spikes/`. `0001`-`0003` are
 *     byte-for-byte copies of the spike files (proved by hash), `0004`-`0006` are rendered from
 *     the shared builders in `provisioning-sql.mjs`. `spikes/` is left alone.
 *   - the ledger stores a **sha256 per migration**, and `applyMigrations` refuses to run when a
 *     frozen file's digest differs from the recorded one, except for an exact LF/CRLF checkout
 *     conversion. The recorded checksum remains over the **frozen bytes** actually applied;
 *     compatibility checks never rewrite an existing checksum or reapply a migration.
 *   - the ledger upgrade (the `checksum` column and its backfill) is performed by this engine,
 *     not by a numbered migration file: a checksum migration would itself need a checksum to be
 *     recorded, and the ledger must already carry one when it is written.
 *   - the **runtime never migrates**. `openRuntimePools()` opens restricted pools only — no
 *     `admin`, no `migration` — and reports whether the applied head is behind the code's
 *     expectation (`schemaBehind`). `provisionPersistent()` (the provisioner/checker path) and
 *     `migrate()` (the `server/migrate.mjs` command) are the only things that change the schema.
 *
 * Role model (unchanged from the proven spike, and the reason FORCE RLS is meaningful):
 *   <prefix>_migration    owns the schema, applies DDL, has no runtime route
 *   <prefix>_auth         the pinned-library auth tables (user/session/account/verification)
 *   <prefix>_learner      serves learner routes; NON-superuser, NOBYPASSRLS, so RLS applies
 *   <prefix>_worker       claims and completes assessment jobs
 *   <prefix>_deletion     runs the one hard account-deletion transaction (HARD-DELETE-01 §6)
 *   <prefix>_provisioner  the narrow stopgap for the sign-up allowance insert (MFP-01 §2.4):
 *                         NOSUPERUSER, NOBYPASSRLS, and its only right is INSERT on
 *                         `entitlements`. The durable replacement is a `SECURITY DEFINER`
 *                         `provision_learner` function, owned by MFP-02a — recorded as a finding.
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
 *   OWNAPI_MIGRATIONS_DIR   the frozen SQL directory; default `server/migrations/`
 *   OWNAPI_PG_<ROLE>_PASSWORD  optional per-role passwords; the restricted roles are
 *                              created with no password unless one is supplied, because a
 *                              local trust/peer connection needs none.
 *
 * See work/implementation/OWNAPI-03.md and work/implementation/MFP-01.md.
 */

import pg from 'pg';
import { readFile } from 'node:fs/promises';
import { existsSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const MIGRATIONS_DIR = process.env.OWNAPI_MIGRATIONS_DIR
  ? new URL(`file://${process.env.OWNAPI_MIGRATIONS_DIR.replaceAll('\\', '/').replace(/\/?$/, '/')}`)
  : new URL('../migrations/', import.meta.url);

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;
// `deletion` is the account-deletion port's role (HARD-DELETE-01 §6): least privilege for the
// one ordered transaction that removes an account, never used by a learner route.
// `provisioner` is MFP-01's narrow stopgap for the sign-up allowance insert (see the header).
const ROLES = ['migration', 'auth', 'learner', 'worker', 'deletion', 'provisioner'];

/**
 * The tracked SQL, in id order. The files are frozen under `server/migrations/`; an id is
 * recorded once and never rewritten. `spikes/` is no longer a migration source.
 *
 * The list is enumerated from the directory (NOT hard-coded) so a checkout can point the
 * directory at a scratch copy — which is how `tools/migrate-check.mjs` proves that a tampered
 * or partial set is refused or reported behind, without ever touching the repository tree.
 */
function frozenMigrations(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => /^\d{4}-.*\.sql$/.test(name))
    .sort()
    .map((name) => ({ id: name.replace(/\.sql$/, ''), file: new URL(name, dir) }));
}

export const MIGRATIONS = Object.freeze(frozenMigrations(MIGRATIONS_DIR));

/** The migration ids the code expects an installation to have applied, in order. */
export const EXPECTED_MIGRATIONS = Object.freeze(MIGRATIONS.map((migration) => migration.id));

const ident = (name) => {
  if (!IDENTIFIER.test(name)) throw new Error(`Unsafe identifier: ${String(name)}`);
  return `"${name}"`;
};

/** Literal for a password, or NULL when none is configured. Never logged. */
const literal = (value) => (typeof value === 'string' && value.length
  ? `'${value.replaceAll("'", "''")}'` : 'NULL');

/** The sha256 of a frozen migration's **bytes**. The digest is of the reviewed artifact. */
export const checksumOf = (bytes) => createHash('sha256').update(bytes).digest('hex');

/**
 * Git's historical Windows checkout conversion changed every LF to CRLF in frozen SQL.
 * Accept that one byte transformation in either direction, only for uniform line endings.
 * No trimming, encoding conversion, BOM removal, bare-CR or mixed-ending normalisation.
 * Latin-1 is a byte-preserving bridge here (SQL is still decoded as UTF-8 when executed).
 * New ledger entries always use checksumOf(originalBytes); old entries stay untouched.
 */
export function migrationChecksumMatches(bytes, recorded) {
  if (checksumOf(bytes) === recorded) return true;
  const raw = Buffer.from(bytes).toString('latin1');
  const withoutPairs = raw.replaceAll('\r\n', '');
  if (withoutPairs.includes('\r')) return false; // bare CR is not a checkout conversion
  const hasPairs = raw.includes('\r\n');
  if (hasPairs && withoutPairs.includes('\n')) return false; // mixed endings: fail closed
  if (!hasPairs && !raw.includes('\n')) return false;
  const alternate = hasPairs ? raw.replaceAll('\r\n', '\n') : raw.replaceAll('\n', '\r\n');
  return checksumOf(Buffer.from(alternate, 'latin1')) === recorded;
}

/**
 * Substitute the validated schema/role identifiers into a frozen file. `0001`-`0002` carry no
 * placeholders; `0003`-`0006` do. The digest is over the file BEFORE this substitution, so the
 * reviewed template is what is checksummed, and the substitution is deterministic.
 */
export function renderSql(text, config) {
  let out = text.replaceAll('__SCHEMA__', config.schema);
  for (const role of ['auth', 'learner', 'worker', 'deletion']) {
    out = out.replaceAll(`__${role.toUpperCase()}__`, config.roles[role]);
  }
  return out;
}

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
 * A privileged (bootstrap) pool for the operations that must precede the restricted roles:
 * creating the schema and the roles, and the ledger read a checker needs. The **runtime never
 * builds one of these** — it is the provisioning/checking path only.
 */
export function createAdminPool(config, { max = 2, applicationName = `${config.schema}:admin` } = {}) {
  return new pg.Pool({
    ...config.admin, max, application_name: applicationName,
    options: `-c search_path=${config.schema},pg_catalog`,
  });
}

/**
 * Create the schema and the roles if (and only if) they are missing. Idempotent:
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

/**
 * The applied-migration ledger, upgraded in place. MFP-01: it carries a `checksum` column, and
 * the runtime roles may READ it (so a runtime with no privileged pool can tell whether it is
 * behind). Created on first use, never dropped; existing rows are updated, never deleted.
 */
export async function ensureLedger(pool, config) {
  await pool.query(`CREATE TABLE IF NOT EXISTS ${ident(config.schema)}.hatoove_migrations (
    id text PRIMARY KEY,
    applied_at timestamptz NOT NULL DEFAULT now()
  )`);
  await pool.query(`ALTER TABLE ${ident(config.schema)}.hatoove_migrations ADD COLUMN IF NOT EXISTS checksum text`);
  await pool.query(`GRANT SELECT ON ${ident(config.schema)}.hatoove_migrations
    TO ${ident(config.roles.auth)}, ${ident(config.roles.learner)}`);
}

/** Which migration ids have already been applied. */
export async function appliedMigrations(pool, schema) {
  const { rows } = await pool.query(`SELECT id FROM ${ident(schema)}.hatoove_migrations ORDER BY id`);
  return rows.map((row) => row.id);
}

/** The ledger rows, id and recorded checksum. */
export async function readLedger(pool, schema) {
  const { rows } = await pool.query(`SELECT id, checksum FROM ${ident(schema)}.hatoove_migrations ORDER BY id`);
  return rows;
}

/**
 * Compute and store the checksum of every already-applied migration that has none, **from the
 * frozen files** (never from `spikes/`), so an installation provisioned before MFP-01 and one
 * provisioned after it agree. Existing rows are updated, never deleted. Returns the row count.
 */
export async function backfillChecksums(pool, config) {
  const recorded = new Map((await readLedger(pool, config.schema)).map((row) => [row.id, row.checksum]));
  let backfilled = 0;
  for (const migration of MIGRATIONS) {
    if (!recorded.has(migration.id)) continue; // not applied here
    if (recorded.get(migration.id)) continue; // already carries a checksum
    const digest = checksumOf(await readFile(migration.file));
    await pool.query(
      `UPDATE ${ident(config.schema)}.hatoove_migrations SET checksum = $2 WHERE id = $1 AND checksum IS NULL`,
      [migration.id, digest]);
    backfilled += 1;
  }
  return backfilled;
}

/**
 * Apply every migration that has not been applied yet, in order, each in one transaction
 * together with its ledger row - so a failure leaves neither a half-applied schema nor a
 * recorded-but-unapplied migration.
 *
 * Refuses changed bytes except the exact uniform LF/CRLF checkout conversion. A compatible
 * already-applied migration is skipped; its original checksum and rows are never rewritten.
 *
 * @returns {Promise<{applied: string[], skipped: string[], backfilled: number}>}
 */
export async function applyMigrations(pool, config) {
  await ensureLedger(pool, config);
  const backfilled = await backfillChecksums(pool, config);
  const recorded = new Map((await readLedger(pool, config.schema)).map((row) => [row.id, row.checksum]));
  const applied = [];
  const skipped = [];
  for (const migration of MIGRATIONS) {
    const bytes = await readFile(migration.file);
    const digest = checksumOf(bytes);
    if (recorded.has(migration.id)) {
      const prior = recorded.get(migration.id);
      if (!prior) {
        throw new Error(`migration ${migration.id} is recorded without a checksum that the frozen file can supply; refusing to continue`);
      }
      if (!migrationChecksumMatches(bytes, prior)) {
        throw new Error(`checksum mismatch for migration ${migration.id}: the ledger has ${prior}, the frozen file is ${digest}; refusing to apply a migration that is not the one that was reviewed`);
      }
      skipped.push(migration.id);
      continue;
    }
    const sql = renderSql(bytes.toString('utf8'), config);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query(
        `INSERT INTO ${ident(config.schema)}.hatoove_migrations (id, checksum) VALUES ($1, $2)`,
        [migration.id, digest]);
      await client.query('COMMIT');
      applied.push(migration.id);
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }
  return { applied, skipped, backfilled };
}

/**
 * The narrow stopgap for the sign-up allowance insert (MFP-01 §2.4, finding: owner MFP-02a).
 *
 * `sessions.mjs:129-131` inserts an `entitlements` row at sign-up; the restricted roles have no
 * INSERT on `entitlements`, so the runtime used to borrow a **superuser** pool for it. Until
 * MFP-02a adds the `SECURITY DEFINER` `provision_learner` function, the runtime uses this role
 * instead. Its whole surface: `INSERT` on `entitlements`, `SELECT(owner_id)` on `entitlements`
 * and nothing else — no UPDATE/DELETE, no other table, no CREATEROLE/CREATEDB, NOBYPASSRLS.
 *
 * Why the read side is needed: `sessions.mjs` writes `ON CONFLICT (owner_id) DO NOTHING`.
 * Under `FORCE ROW LEVEL SECURITY`, PostgreSQL needs to SEE the conflicting row to skip it, so
 * a bare INSERT grant fails with `permission denied` (no SELECT) and then
 * `new row violates row-level security policy` (a SELECT grant but no visible row). The
 * column-level grant plus the read policy is the minimum that makes the existing statement work
 * without editing `sessions.mjs`; MFP-02a removes the need for both.
 */
export async function grantProvisionerRights(pool, config) {
  const s = ident(config.schema);
  const role = ident(config.roles.provisioner);
  await pool.query(`GRANT USAGE ON SCHEMA ${s} TO ${role}`);
  await pool.query(`GRANT INSERT ON ${s}.entitlements TO ${role}`);
  await pool.query(`GRANT SELECT(owner_id) ON ${s}.entitlements TO ${role}`);
  await pool.query(`DROP POLICY IF EXISTS provisioner_entitlements ON ${s}.entitlements`);
  await pool.query(`CREATE POLICY provisioner_entitlements ON ${s}.entitlements FOR INSERT TO ${role} WITH CHECK (true)`);
  await pool.query(`DROP POLICY IF EXISTS provisioner_entitlements_read ON ${s}.entitlements`);
  await pool.query(`CREATE POLICY provisioner_entitlements_read ON ${s}.entitlements FOR SELECT TO ${role} USING (true)`);
}

/**
 * Provision (or verify) a persistent installation and return pools for the runtime roles.
 * This is the **provisioner and checker** path; it DOES apply pending migrations. The running
 * server must not call it — it calls `openRuntimePools()`, which has no privileged pool.
 *
 * @param {object} [options]
 * @param {object} [options.config] precomputed `persistentConfig()` result
 * @returns {Promise<object>}
 */
export async function provisionPersistent({ config = persistentConfig() } = {}) {
  // The privileged pool carries the same pinned `search_path` as the role pools: several
  // adapters (notably sessions.mjs) use unqualified table names, and an empty search_path
  // here would fail with `relation "session" does not exist` while every role pool worked.
  const admin = createAdminPool(config);
  let migrationPool = null;
  try {
    await ensureRolesAndSchema(admin, config);
    migrationPool = persistentRolePool(config, 'migration', { max: 2 });
    const result = await applyMigrations(migrationPool, config);
    await grantProvisionerRights(migrationPool, config);
    const pools = {
      config,
      migration: migrationPool,
      auth: persistentRolePool(config, 'auth'),
      learner: persistentRolePool(config, 'learner', { max: 4 }),
      worker: persistentRolePool(config, 'worker'),
      // The account-deletion port's own connection pool. Built here so every consumer
      // (`server/accounts.mjs`, the checks) takes it from the one provisioning path.
      deletion: persistentRolePool(config, 'deletion'),
      provisioner: persistentRolePool(config, 'provisioner', { max: 2 }),
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

/**
 * `server/migrate.mjs`'s body: apply pending migrations and return a summary. Uses the bootstrap
 * connection to ensure the roles/schema exist (a first-time install has none) and the
 * **migration role** for every statement that changes the schema. No runtime pool is built.
 *
 * @returns {Promise<{applied: string[], skipped: string[], backfilled: number, schema: string}>}
 */
export async function migrate({ config = persistentConfig() } = {}) {
  const admin = createAdminPool(config);
  let migrationPool = null;
  try {
    await ensureRolesAndSchema(admin, config);
    migrationPool = persistentRolePool(config, 'migration', { max: 2 });
    const result = await applyMigrations(migrationPool, config);
    await grantProvisionerRights(migrationPool, config);
    return { ...result, schema: config.schema };
  } finally {
    if (migrationPool) await migrationPool.end().catch(() => {});
    await admin.end().catch(() => {});
  }
}

/**
 * Is the applied head behind what this code expects? Read through a **restricted** pool, so the
 * runtime needs no privileged connection to answer it. A missing ledger (an unmigrated schema)
 * is behind by definition.
 */
export async function schemaBehind(pool, config) {
  try {
    const { rows } = await pool.query(`SELECT id FROM ${ident(config.schema)}.hatoove_migrations`);
    const applied = new Set(rows.map((row) => row.id));
    const missing = EXPECTED_MIGRATIONS.filter((id) => !applied.has(id));
    return {
      behind: missing.length > 0,
      missing,
      expectedHead: EXPECTED_MIGRATIONS[EXPECTED_MIGRATIONS.length - 1] || null,
      appliedHead: rows.length ? rows.map((row) => row.id).sort()[rows.length - 1] : null,
    };
  } catch (error) {
    return {
      behind: true,
      missing: [...EXPECTED_MIGRATIONS],
      expectedHead: EXPECTED_MIGRATIONS[EXPECTED_MIGRATIONS.length - 1] || null,
      appliedHead: null,
      error: error && error.message ? error.message : String(error),
    };
  }
}

/**
 * The **runtime** pools: restricted roles only. No `admin`, no `migration`, so a running server
 * cannot change the schema and does not hold a superuser. `provisioner` is the narrow sign-up
 * stopgap (see `grantProvisionerRights`); `behind` says whether `/api/ready` must answer
 * `schema_behind`.
 */
export async function openRuntimePools({ config = persistentConfig() } = {}) {
  const runtime = {
    config,
    auth: persistentRolePool(config, 'auth', { max: 4 }),
    learner: persistentRolePool(config, 'learner', { max: 4 }),
    worker: persistentRolePool(config, 'worker', { max: 4 }),
    deletion: persistentRolePool(config, 'deletion', { max: 4 }),
    provisioner: persistentRolePool(config, 'provisioner', { max: 2 }),
    poolRoles: {
      auth: config.roles.auth,
      learner: config.roles.learner,
      worker: config.roles.worker,
      deletion: config.roles.deletion,
      provisioner: config.roles.provisioner,
    },
  };
  runtime.behind = await schemaBehind(runtime.learner, config);
  return runtime;
}

/** Close the pools `openRuntimePools()` opened. Idempotent. */
export async function closeRuntimePools(runtime) {
  if (!runtime) return;
  for (const key of ['auth', 'learner', 'worker', 'deletion', 'provisioner']) {
    const pool = runtime[key];
    if (pool && typeof pool.end === 'function') await pool.end().catch(() => {});
  }
}

/** Close every pool `provisionPersistent()` opened. Idempotent. */
export async function closePersistent(pools) {
  if (!pools) return;
  for (const key of ['migration', 'auth', 'learner', 'worker', 'deletion', 'provisioner', 'admin']) {
    const pool = pools[key];
    if (pool && typeof pool.end === 'function') await pool.end().catch(() => {});
  }
}

// Kept so a caller can point at the frozen directory (the checker uses it to enumerate files).
export { MIGRATIONS_DIR, fileURLToPath };

#!/usr/bin/env node
/**
 * AUTH-01-SPIKE — schema addendum: what would Better Auth 1.7.6 ADD to the production schema?
 *
 * The production `user`/`session`/`account`/`verification` tables are already Better Auth's shape
 * (migration `0001`, `spikes/auth-runtime/auth-schema.sql`). This probe:
 *   1. builds a database holding EXACTLY that schema,
 *   2. asks Better Auth to compile its migrations against it (with `rateLimit.storage='database'`),
 *   3. prints the statements it would run and the tables that result.
 *
 * Run:  AUTHSPIKE_DEPS=/tmp/authspike-scratch AUTHSPIKE_PG_URL=... node tools/auth-spike-schema-diff.mjs
 */
import { readFileSync } from 'node:fs';
import { loadDeps, DEFAULT_DEPS } from './auth-spike-deps.mjs';

const DB_URL = process.env.AUTHSPIKE_PG_URL
  || 'postgres://authspike:authspike@127.0.0.1:5432/authspike_spike';
const AUTH_SCHEMA = new URL('../spikes/auth-runtime/auth-schema.sql', import.meta.url);

let deps;
try { deps = await loadDeps(); } catch (error) {
  console.error(`loadDeps failed (AUTHSPIKE_DEPS=${process.env.AUTHSPIKE_DEPS || DEFAULT_DEPS}): ${error.message}`);
  process.exit(2);
}
const { getMigrations, Pool } = deps;

const pool = new Pool({ connectionString: DB_URL });
await pool.query('DROP TABLE IF EXISTS "rateLimit", "verification", "account", "session", "user" CASCADE');
await pool.query(readFileSync(AUTH_SCHEMA, 'utf8'));
console.log('=== 1. tables BEFORE (the production shape, migration 0001) ===');
console.log((await pool.query(
  `SELECT table_name FROM information_schema.tables WHERE table_schema='public' ORDER BY table_name`))
  .rows.map((r) => r.table_name).join(', '));

const opts = (extra) => ({
  database: pool, baseURL: 'http://127.0.0.1:3999',
  secret: 'auth-spike-schema-secret-not-a-real-secret-0000',
  emailAndPassword: { enabled: true, minPasswordLength: 12 },
  telemetry: { enabled: false }, logger: { level: 'error' }, ...extra,
});

console.log('\n=== 2. Better Auth compileMigrations() with rateLimit.storage="database" ===');
const withDb = await getMigrations(opts({ rateLimit: { enabled: true, storage: 'database', window: 60, max: 100 } }));
console.log(await withDb.compileMigrations());

console.log('\n=== 3. compileMigrations() with the DEFAULT (memory) rate limiter ===');
const noDb = await getMigrations(opts({ rateLimit: { enabled: true, window: 60, max: 100 } }));
console.log(await noDb.compileMigrations());

console.log('\n=== 4. run the database-storage migrations, then list tables AFTER ===');
await withDb.runMigrations();
console.log((await pool.query(
  `SELECT table_name FROM information_schema.tables WHERE table_schema='public' ORDER BY table_name`))
  .rows.map((r) => r.table_name).join(', '));

await pool.end();

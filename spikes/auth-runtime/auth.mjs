import { betterAuth } from 'better-auth';
import { getMigrations } from 'better-auth/db/migration';
import pg from 'pg';
import { randomBytes } from 'node:crypto';

// Intentionally no .env loader, server entrypoint or production URL option.
export function localPool(schema) {
  if (!/^spike_[a-f0-9]+$/.test(schema)) throw new Error('Unsafe test schema');
  return new pg.Pool({ host: '127.0.0.1', port: 55435, database: 'hatoove_spike',
    user: 'postgres', max: 4, application_name: schema, options: `-c search_path=${schema}` });
}
export function authOptions(pool, baseURL, secret = randomBytes(48).toString('base64url')) {
  const url = new URL(baseURL);
  if (url.hostname !== '127.0.0.1' || url.protocol !== 'http:') throw new Error('Local spike only');
  return { database: pool, baseURL, secret, trustedOrigins: [baseURL],
    emailAndPassword: { enabled: true, minPasswordLength: 12 },
    session: { cookieCache: { enabled: false } },
    rateLimit: { enabled: true, window: 60, max: 100 },
    telemetry: { enabled: false }, logger: { level: 'error' } };
}
export function createAuth(pool, baseURL, secret) { return betterAuth(authOptions(pool,baseURL,secret)); }
export async function migrateAuth(pool) {
  const migration = await getMigrations(authOptions(pool,'http://127.0.0.1:55436'));
  const sql = await migration.compileMigrations();
  await migration.runMigrations();
  return sql;
}

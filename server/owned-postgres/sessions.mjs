/**
 * PostgreSQL session port for the owned-attempts seam (OWNAPI-02, test fixture).
 *
 * The datastore adapter is the point of this task; this port exists so the same
 * check suite can run against a real database instead of the in-memory session
 * fake. It is deliberately NOT a production auth system and NOT Better Auth:
 * it stores synthetic accounts and sessions in the tracked Better Auth schema
 * (`spikes/auth-runtime/auth-schema.sql`) so the `attempts.owner_id -> "user"(id)`
 * foreign key is satisfied by a genuine database row.
 *
 * Least privilege: every learner-facing read writes as the restricted `__AUTH__`
 * role, which can touch only `"user"`, `session`, `account` and `verification`.
 * It cannot read `attempts`, `drafts` or `submissions`.
 *
 * TWO PROVISIONING PATHS, and they are not the same thing (MFP-02a):
 *
 *   - **the runtime path** injects `provision(userId, allowance)`, which calls the migration-owned
 *     `SECURITY DEFINER` function `provision_learner` on the restricted auth pool. The running
 *     server holds no privileged pool at all (`server/runtime.mjs`, `server/accounts.mjs`).
 *   - **the disposable fixture path** (`fixture.mjs`, `owned-api-pg-check.mjs`) still passes
 *     `adminPool` and inserts the allowance row through it. The fixture's `bootstrap.mjs` schema
 *     is built from `spikes/` plus the shared builders and does not carry `provision_learner`;
 *     it is a checker's world, and it keeps its own privileged step.
 *
 * A world that still uses an admin pool while the runtime does not is exactly the drift this
 * slice removes — so the check `runtime-composition-check` asserts the ROLES the runtime's pools
 * connect as, and `sign-up-provisions-allowance-without-admin` drives the runtime's own path.
 */

import { randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';
import { Fault } from '../../server/owned-api.mjs';

const COOKIE_DEFAULT = 'hatoove_owned_session';

/** scrypt hash in a self-describing single column: `scrypt:<salt-hex>:<hash-hex>`. */
function hashPassword(password) {
  const salt = randomBytes(16);
  const digest = scryptSync(password, salt, 32);
  return `scrypt:${salt.toString('hex')}:${digest.toString('hex')}`;
}

function verifyPassword(password, stored) {
  const [scheme, saltHex, hashHex] = String(stored || '').split(':');
  if (scheme !== 'scrypt' || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function tokenFrom(headers, cookieName) {
  const cookie = String((headers && headers.cookie) || '');
  for (const part of cookie.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === cookieName) return rest.join('=');
  }
  return null;
}

/**
 * @param {{pool: object, adminPool?: object, provision?: Function, allowance?: number, sessionTtlSeconds?: number, cookieName?: string}} options
 *   `pool` connects as the restricted auth role. Exactly one provisioning path is used: the
 *   injected `provision(userId, allowance)` (the runtime's, which calls `provision_learner`), or
 *   `adminPool` (the disposable fixture's). Neither is required when `allowance` is null.
 */
export function createPostgresSessions({
  pool, adminPool = null, provision = null, allowance = 10, sessionTtlSeconds = 3600, cookieName = COOKIE_DEFAULT,
} = {}) {
  if (!pool || typeof pool.connect !== 'function') throw new TypeError('createPostgresSessions requires a pg Pool');
  if (allowance !== null && allowance !== undefined
    && typeof provision !== 'function' && (!adminPool || typeof adminPool.query !== 'function')) {
    throw new TypeError('createPostgresSessions requires a provisioning path: provision(userId, allowance) or an admin Pool');
  }

  async function inTransaction(work) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const value = await work(client);
      await client.query('COMMIT');
      return value;
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch { /* preserve the original failure */ }
      throw error;
    } finally {
      client.release();
    }
  }

  async function issueSession(client, userId) {
    const token = randomBytes(24).toString('base64url');
    await client.query(
      `INSERT INTO session(id, "expiresAt", token, "createdAt", "updatedAt", "userId")
       VALUES($1, now() + make_interval(secs => $2), $3, now(), now(), $4)`,
      [randomUUID(), sessionTtlSeconds, token, userId]);
    return { setCookie: `${cookieName}=${token}; Path=/; HttpOnly; SameSite=Lax` };
  }

  return {
    cookieName,

    /**
     * Fixture-only count of session rows. On a **persistent** installation (OWNAPI-03) the
     * table keeps every earlier run's sessions, so pass a `userId` to scope the count to one
     * account; without one this is the absolute total across the whole installation.
     *
     * This is a test hook, so it needs the privileged pool a check (never the runtime) supplies;
     * the runtime has none and does not call it.
     */
    async liveSessions(userId) {
      if (!adminPool) throw new Error('liveSessions is a fixture-only hook and needs an admin pool; the runtime holds none');
      const row = userId === undefined
        ? (await adminPool.query('SELECT count(*)::int AS n FROM session')).rows[0]
        : (await adminPool.query('SELECT count(*)::int AS n FROM session WHERE "userId" = $1', [userId])).rows[0];
      return row ? row.n : 0;
    },

    async getSession(headers) {
      const token = tokenFrom(headers, cookieName);
      if (!token) return null;
      const row = (await pool.query(
        `SELECT s."userId" AS "userId", u.email AS email, s."expiresAt" AS "expiresAt"
         FROM session s JOIN "user" u ON u.id = s."userId" WHERE s.token = $1`, [token])).rows[0];
      if (!row) return null;
      if (row.expiresAt && row.expiresAt.getTime() <= Date.now()) return null;
      return { userId: row.userId, email: row.email };
    },

    async signUp({ name, email, password }) {
      const id = `user-${randomUUID()}`;
      const existing = (await pool.query('SELECT 1 FROM "user" WHERE email = $1', [email])).rows[0];
      if (existing) throw new Fault(422, 'user_exists');
      try {
        return await inTransaction(async (client) => {
          await client.query(
            `INSERT INTO "user"(id, name, email, "emailVerified", "createdAt", "updatedAt")
             VALUES($1, $2, $3, false, now(), now())`, [id, name, email]);
          await client.query(
            `INSERT INTO account(id, "accountId", "providerId", "userId", password, "createdAt", "updatedAt")
             VALUES($1, $2, 'credential', $3, $4, now(), now())`,
            [randomUUID(), id, id, hashPassword(password)]);
          const cookie = await issueSession(client, id);
          return { ...cookie, userId: id };
        }).then(async (created) => {
          // The allowance: through the runtime's `provision_learner`, or through the fixture's
          // privileged pool. Never both, and never the restricted roles (they have no INSERT on
          // `entitlements`, which is the point).
          if (allowance !== null && allowance !== undefined) {
            if (typeof provision === 'function') {
              await provision(id, allowance);
            } else {
              await adminPool.query(
                'INSERT INTO entitlements(owner_id, allowance) VALUES($1, $2) ON CONFLICT (owner_id) DO NOTHING',
                [id, allowance]);
            }
          }
          return { setCookie: created.setCookie };
        });
      } catch (error) {
        if (error && error.code === '23505') throw new Fault(422, 'user_exists');
        throw error;
      }
    },

    async signIn({ email, password }) {
      const row = (await pool.query(
        `SELECT u.id AS "userId", a.password AS password
         FROM "user" u JOIN account a ON a."userId" = u.id
         WHERE u.email = $1 AND a."providerId" = 'credential'`, [email])).rows[0];
      if (!row || !verifyPassword(password, row.password)) throw new Fault(401, 'invalid_credentials');
      return inTransaction((client) => issueSession(client, row.userId));
    },

    async signOut(headers) {
      const token = tokenFrom(headers, cookieName);
      if (token) await pool.query('DELETE FROM session WHERE token = $1', [token]);
      return { setCookie: `${cookieName}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0` };
    },
  };
}

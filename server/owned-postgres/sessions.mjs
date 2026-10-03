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
 * EXAM-S1: sign-up provisions the initial preparation and its exam balance INSIDE the auth transaction,
 * through the SECURITY DEFINER `provision_learner` function (migration 0023), which only the auth role may
 * execute and which refuses any account the calling transaction did not create. It used to be a separate
 * post-COMMIT insert through a privileged pool, so a failure there left an account with a session and no
 * balance. Now a provisioning failure rolls back the account, the credential, the session, the preparation
 * and the balance together. `adminPool` is used only by the fixture-only `liveSessions` count.
 */

import { createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';
import { Fault } from '../../server/owned-api.mjs';
import { INITIAL_EXAM_ID } from '../preparation-contract.mjs';

const COOKIE_DEFAULT = 'hatoove_owned_session';

/** The erification.identifier prefix that makes a reset token recognisable as one. */
const RESET_PREFIX = 'reset-password:';
/** The prefix that makes a verification token recognisable as one, rather than a reset token. */
const VERIFY_PREFIX = 'verify-email:';
/** How long a verification link stays valid: a day, because it asserts an address rather than granting access. */
const VERIFY_TTL_SECONDS = 86400;
/** How long a reset link stays valid. Short, because it travels through an operator and a chat message. */
const RESET_TTL_SECONDS = 1800;

/**
 * The stored form of a reset token.
 *
 * SHA-256, NOT scrypt, and the difference is the point: the token is 256 bits of randomness, so there is no
 * dictionary to attack and a slow hash would only make every redemption slower. A PASSWORD is the opposite
 * case, which is why hashPassword above is scrypt with a per-password salt.
 */
function hashToken(token) {
  return createHash('sha256').update(String(token), 'utf8').digest('hex');
}

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
 * @param {{pool: object, adminPool: object, allowance?: number|null, sessionTtlSeconds?: number, cookieName?: string,
 *   registrationHook?: (stage: string, client: object) => (void|Promise<void>)}} options
 *   `pool` connects as the restricted auth role. `adminPool` serves only the fixture-only `liveSessions`.
 *   `allowance` is the initial telc balance (`null` provisions the preparation with no balance).
 *   `registrationHook` is a TEST seam for failure injection: it runs inside the sign-up transaction after
 *   provisioning, and a throw rolls the whole registration back.
 */
export function createPostgresSessions({
  pool, adminPool, allowance = 10, sessionTtlSeconds = 3600, cookieName = COOKIE_DEFAULT,
  notify = null, registrationHook = null,
} = {}) {
  if (!pool || typeof pool.connect !== 'function') throw new TypeError('createPostgresSessions requires a pg Pool');
  if (!adminPool || typeof adminPool.query !== 'function') throw new TypeError('createPostgresSessions requires an admin Pool');

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

  /**
   * THE SWEEP: delete expired sessions.
   *
   * Rejecting an expired session on read is not the same as getting rid of it. Every sign-in leaves a row and
   * nothing removed the expired ones, so the table grew without bound — a storage leak, and a privacy one,
   * because the rows outlive the sessions they describe.
   *
   * It runs as part of `issueSession` rather than from a scheduler: a job that must be configured, started
   * and monitored is a job that can silently not run, while this work is trivially bounded (a scan of one
   * small table) and idempotent. It is ALSO callable on its own, so an operator or a future job can sweep
   * without waiting for the next sign-in.
   */
  async function sweepExpired(client = pool) {
    const result = await client.query('DELETE FROM session WHERE "expiresAt" <= now()');
    return result.rowCount || 0;
  }

  async function issueSession(client, userId) {
    /*
     * SWEEP BEFORE ISSUING. Every sign-in is an opportunity to remove what has expired, which keeps the table
     * proportional to the sessions actually alive without anyone having to remember to run anything.
     */
    await sweepExpired(client);
    const token = randomBytes(24).toString('base64url');
    await client.query(
      `INSERT INTO session(id, "expiresAt", token, "createdAt", "updatedAt", "userId")
       VALUES($1, now() + make_interval(secs => $2), $3, now(), now(), $4)`,
      [randomUUID(), sessionTtlSeconds, token, userId]);
    return { setCookie: `${cookieName}=${token}; Path=/; HttpOnly; SameSite=Lax` };
  }

  /** One session row by token, or null — the shared read every lifecycle operation below starts from. */
  async function sessionOfToken(token) {
    if (!token) return null;
    return (await pool.query(
      'SELECT id, "userId" AS "userId", "expiresAt" AS "expiresAt" FROM session WHERE token = $1',
      [token])).rows[0] || null;
  }

  return {
    cookieName,

    /**
     * Fixture-only count of session rows. On a **persistent** installation (OWNAPI-03) the
     * table keeps every earlier run's sessions, so pass a `userId` to scope the count to one
     * account; without one this is the absolute total across the whole installation.
     */
    async liveSessions(userId) {
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
          // Same transaction: account, credential, initial preparation, balance and session commit together.
          await client.query('SELECT provision_learner($1, $2, $3)',
            [id, INITIAL_EXAM_ID, allowance === undefined ? null : allowance]);
          if (typeof registrationHook === 'function') await registrationHook('provisioned', client);
          const cookie = await issueSession(client, id);
          if (typeof registrationHook === 'function') await registrationHook('session', client);
          return { setCookie: cookie.setCookie };
        });
      } catch (error) {
        if (error && error.code === '23505') throw new Fault(422, 'user_exists');
        throw error;
      }
    },

    /**
     * SIGN IN, WITH ROTATION — the session-fixation fix.
     *
     * The attack: an attacker plants a session cookie in a victim's browser (shared machine, subdomain, XSS).
     * The victim signs in. If the planted session survives the sign-in, the attacker now holds an
     * authenticated session they never authenticated for. So the cookie that was PRESENTED is retired here,
     * and the sign-in issues a new one: from the moment the real user authenticates, the planted token is
     * worthless.
     *
     * `headers` is optional so an existing caller without it still works (it simply has no session to retire),
     * and the deletion is by token, so it can only ever retire the session that was actually presented.
     */
    async signIn({ email, password, headers }) {
      const row = (await pool.query(
        `SELECT u.id AS "userId", a.password AS password
         FROM "user" u JOIN account a ON a."userId" = u.id
         WHERE u.email = $1 AND a."providerId" = 'credential'`, [email])).rows[0];
      if (!row || !verifyPassword(password, row.password)) throw new Fault(401, 'invalid_credentials');
      const presented = tokenFrom(headers, cookieName);
      return inTransaction(async (client) => {
        if (presented) await client.query('DELETE FROM session WHERE token = $1', [presented]);
        return issueSession(client, row.userId);
      });
    },

    /**
     * The learner's own sessions, WITHOUT THEIR TOKENS.
     *
     * A session id is enough to revoke one; the token is a bearer credential for that session, so serving it
     * — even to its owner — turns a read route into a way to steal a session from a log, a screenshot or a
     * support ticket. The current session is flagged so the screen can say "dieses Gerät".
     */
    async listSessions(headers) {
      const current = await sessionOfToken(tokenFrom(headers, cookieName));
      if (!current) return null;
      // Sweep first: a list that shows sessions which are already dead is a list that lies.
      await sweepExpired();
      const rows = (await pool.query(
        `SELECT id, "createdAt" AS "createdAt", "expiresAt" AS "expiresAt"
         FROM session WHERE "userId" = $1 ORDER BY "createdAt" DESC`, [current.userId])).rows;
      return {
        sessions: rows.map((row) => ({
          id: row.id,
          created_at: row.createdAt instanceof Date ? row.createdAt.toISOString() : String(row.createdAt),
          expires_at: row.expiresAt instanceof Date ? row.expiresAt.toISOString() : String(row.expiresAt),
          current: row.id === current.id,
        })),
      };
    },

    /**
     * REVOKE ONE SESSION, and only if it belongs to the caller.
     *
     * The `userId` in the WHERE clause is the whole security property: without it, any learner could end any
     * other learner's session by guessing an id. Scoped this way the answer for someone else's session is
     * "nothing was revoked", which the route turns into a 404 — ids must not be an oracle for what exists.
     */
    async revokeSession(headers, sessionId) {
      const current = await sessionOfToken(tokenFrom(headers, cookieName));
      if (!current) return null;
      const result = await pool.query('DELETE FROM session WHERE id = $1 AND "userId" = $2', [sessionId, current.userId]);
      return { revoked: (result.rowCount || 0) > 0 };
    },

    /**
     * REVOKE EVERY SESSION FOR ONE ACCOUNT, optionally sparing one.
     *
     * Used by the password change: if a learner changes their password because someone else may have it, and
     * the intruder's session keeps working, the change achieved nothing.
     */
    async revokeAllSessions(userId, { exceptId = null } = {}) {
      const result = await pool.query(
        'DELETE FROM session WHERE "userId" = $1 AND ($2::text IS NULL OR id <> $2)', [userId, exceptId]);
      return result.rowCount || 0;
    },

    /**
     * CHANGE THE PASSWORD: verify the old one, store the new one, and end every session.
     *
     * Two decisions, both deliberate:
     *   * THE ACTING SESSION IS ROTATED, NOT SPARED. Sparing it would leave a token that existed before the
     *     password changed, which is exactly the token an intruder might hold. So all sessions die and the
     *     device that made the change gets a NEW one — signed in, holding nothing that predates the change.
     *   * THE NEW PASSWORD IS HASHED BY THE SAME `hashPassword` AS REGISTRATION, so there is one definition of
     *     how a password is stored rather than two that can drift (D5's hashing parameters are a human
     *     signoff item; whoever changes them changes them in one place).
     *
     * Returns null when there is no session, and throws `invalid_credentials` when the current password is
     * wrong — the caller turns that into a 403, and NOTHING is revoked in that path.
     */
    async changePassword(headers, { currentPassword, newPassword }) {
      const current = await sessionOfToken(tokenFrom(headers, cookieName));
      if (!current) return null;
      const row = (await pool.query(
        `SELECT a.id AS "accountId", a.password AS password
         FROM account a WHERE a."userId" = $1 AND a."providerId" = 'credential'`, [current.userId])).rows[0];
      if (!row || !verifyPassword(currentPassword, row.password)) throw new Fault(403, 'invalid_credentials');
      const stored = hashPassword(newPassword);
      return inTransaction(async (client) => {
        await client.query('UPDATE account SET password = $2, "updatedAt" = now() WHERE id = $1', [row.accountId, stored]);
        // EVERY session, including this one: see above. The new session below is the acting device's.
        await client.query('DELETE FROM session WHERE "userId" = $1', [current.userId]);
        return issueSession(client, current.userId);
      });
    },

    /**
     * REQUEST A PASSWORD RESET — the token path (D6), with the delivery left to the caller's notifier.
     *
     * ANSWERING THE SAME THING FOR EVERY ADDRESS IS THE CALLER'S JOB, not this function's: it returns whether
     * a message was produced, and the route ignores it. Splitting it this way is deliberate — a port that
     * decided the HTTP status would put an enumeration decision in the database layer, where nobody reviewing
     * the route would look for it.
     *
     * THE TOKEN IS STORED ONLY AS A HASH. A read of `verification` — a backup, a support query, a leaked dump
     * — must not hand over working reset links. A plain SHA-256 is the right hash here and NOT a password
     * hash: the token is 256 bits of randomness, so there is no dictionary to attack, and scrypt would only
     * make the lookup slower. (A PASSWORD is the opposite case, which is why `hashPassword` above is scrypt.)
     *
     * ONE LIVE LINK PER ACCOUNT: any earlier row for the same identifier is deleted first, so a learner who
     * clicks "send again" three times does not leave three working links behind.
     */
    async requestPasswordReset({ email }) {
      const user = (await pool.query('SELECT id, email FROM "user" WHERE email = $1', [email])).rows[0];
      // No account, no message — and no difference the caller is allowed to reveal.
      if (!user) return { delivered: false, requested: true };
      const token = randomBytes(32).toString('base64url');
      const identifier = `${RESET_PREFIX}${user.email}`;
      const expiresAt = new Date(Date.now() + RESET_TTL_SECONDS * 1000);
      await inTransaction(async (client) => {
        await client.query('DELETE FROM verification WHERE identifier = $1', [identifier]);
        await client.query(
          `INSERT INTO verification(id, identifier, value, "expiresAt", "createdAt", "updatedAt")
           VALUES($1, $2, $3, $4, now(), now())`,
          [randomUUID(), identifier, hashToken(token), expiresAt]);
      });
      const message = { to: user.email, kind: 'password-reset', token, expiresAt: expiresAt.toISOString() };
      /*
       * THE NOTIFIER IS TOLD THE TOKEN, and it is the ONLY consumer that gets it. It is never returned to
       * the caller's caller: the route answers {ok:true} and nothing else, because anyone can type someone
       * else's address into the form. The LINK is not built here: the delivery channel owns the deployment's
       * public origin, and one value in two places is how the running container once logged a link with no
       * origin at all.
       */
      if (notify && typeof notify.send === 'function') await notify.send(message);
      return { delivered: Boolean(notify && typeof notify.send === 'function'), requested: true };
    },

    /**
     * REDEEM A RESET TOKEN.
     *
     * The token resolves to its own account through the row's identifier, so a link minted for one learner can
     * never touch another's password — there is no account id in the request to get wrong.
     *
     * THREE THINGS HAPPEN TOGETHER, and each one matters:
     *   * the password is replaced, hashed by the SAME `hashPassword` as registration;
     *   * the row is DELETED, so the link works exactly once;
     *   * EVERY SESSION IS DELETED, because the reason a learner resets is that someone else may have the
     *     password — and an intruder's session surviving the reset means the reset achieved nothing.
     *
     * @returns {Promise<{userId: string} | null>} null for an unknown, expired or already-used token; the
     *   route turns that into 400 and says nothing more.
     */
    async resetPassword({ token, newPassword }) {
      if (typeof token !== 'string' || token.length < 16 || token.length > 512) return null;
      const row = (await pool.query(
        `SELECT id, identifier FROM verification
          WHERE value = $1 AND identifier LIKE $2 AND "expiresAt" > now()`,
        [hashToken(token), `${RESET_PREFIX}%`])).rows[0];
      if (!row) return null;
      const email = row.identifier.slice(RESET_PREFIX.length);
      const user = (await pool.query('SELECT id FROM "user" WHERE email = $1', [email])).rows[0];
      if (!user) return null;
      const account = (await pool.query(
        'SELECT id FROM account WHERE "userId" = $1 AND "providerId" = \'credential\'', [user.id])).rows[0];
      if (!account) return null;
      const stored = hashPassword(newPassword);
      return inTransaction(async (client) => {
        await client.query('UPDATE account SET password = $2, "updatedAt" = now() WHERE id = $1', [account.id, stored]);
        // Single use: the row goes, so the link cannot be replayed even by someone who saw the log.
        await client.query('DELETE FROM verification WHERE identifier = $1', [row.identifier]);
        // And every session with it — including the one that may not be the learner's.
        await client.query('DELETE FROM session WHERE "userId" = $1', [user.id]);
        return { userId: user.id };
      });
    },

    /**
     * REQUEST EMAIL VERIFICATION — the same token machinery as a reset, for a different purpose.
     *
     * TWO HONEST NO-OPS, and both must look identical to the caller to the "sent it" case:
     *   * an address with no account produces no message;
     *   * an account that is ALREADY verified produces no message and no token, because there is nothing left
     *     to prove and a live token in the table is a credential nobody needs.
     *
     * The link lives longer than a reset link (a day rather than half an hour) for the same reason the reset
     * link is short: a reset link IS a credential, while this one only asserts "this address is mine".
     */
    async requestEmailVerification({ email }) {
      const user = (await pool.query('SELECT id, email, "emailVerified" FROM "user" WHERE email = $1', [email])).rows[0];
      if (!user || user.emailVerified) return { delivered: false, requested: true };
      const token = randomBytes(32).toString('base64url');
      const identifier = `${VERIFY_PREFIX}${user.email}`;
      const expiresAt = new Date(Date.now() + VERIFY_TTL_SECONDS * 1000);
      await inTransaction(async (client) => {
        // One live link per account, exactly as the reset flow does: "send it again" must not leave two working.
        await client.query('DELETE FROM verification WHERE identifier = $1', [identifier]);
        await client.query(
          `INSERT INTO verification(id, identifier, value, "expiresAt", "createdAt", "updatedAt")
           VALUES($1, $2, $3, $4, now(), now())`,
          [randomUUID(), identifier, hashToken(token), expiresAt]);
      });
      if (notify && typeof notify.send === 'function') {
        await notify.send({ to: user.email, kind: 'email-verification', token, expiresAt: expiresAt.toISOString() });
      }
      return { delivered: Boolean(notify && typeof notify.send === 'function'), requested: true };
    },

    /**
     * REDEEM A VERIFICATION TOKEN.
     *
     * IT DOES NOT SIGN ANYONE IN, deliberately. An emailed link that both proved an address and authenticated
     * would turn the delivery channel — an operator console, a chat message, a screenshot of a log — into a way
     * to obtain a session. The link proves the address; the password still signs in.
     *
     * @returns {Promise<{userId: string, email: string} | null>} null for an unknown, expired or used token.
     */
    async verifyEmail({ token }) {
      if (typeof token !== 'string' || token.length < 16 || token.length > 512) return null;
      const row = (await pool.query(
        `SELECT id, identifier FROM verification
          WHERE value = $1 AND identifier LIKE $2 AND "expiresAt" > now()`,
        [hashToken(token), `${VERIFY_PREFIX}%`])).rows[0];
      if (!row) return null;
      const email = row.identifier.slice(VERIFY_PREFIX.length);
      const user = (await pool.query('SELECT id FROM "user" WHERE email = $1', [email])).rows[0];
      if (!user) return null;
      return inTransaction(async (client) => {
        await client.query('UPDATE "user" SET "emailVerified" = true, "updatedAt" = now() WHERE id = $1', [user.id]);
        // Single use, and the row goes rather than merely becoming unusable.
        await client.query('DELETE FROM verification WHERE identifier = $1', [row.identifier]);
        return { userId: user.id, email };
      });
    },

    /** Sweep on its own, for an operator or a future job. */
    async sweepExpired() {
      return sweepExpired();
    },

    async signOut(headers) {
      const token = tokenFrom(headers, cookieName);
      if (token) await pool.query('DELETE FROM session WHERE token = $1', [token]);
      return { setCookie: `${cookieName}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0` };
    },
  };
}

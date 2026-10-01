/**
 * PostgreSQL datastore adapter for the owned-attempts port (OWNAPI-02).
 *
 * This is the datastore port `server/owned-api.mjs` injects. Its SQL is the same
 * proven SQL as `spikes/auth-runtime/store.mjs`; the difference is that this file
 * implements exactly the seven methods the shipped module calls, and it is meant
 * to run as the restricted `__LEARNER__` role so row-level security is genuinely
 * in force. It must never be pointed at a superuser or BYPASSRLS connection:
 * that would void the ownership guarantee while every check still passed.
 *
 * Ownership is enforced twice, deliberately:
 *   1. the transaction sets `hatoove.owner_id` to the verified owner, so the
 *      FORCE ROW LEVEL SECURITY policies filter every row; and
 *   2. each statement also carries an explicit `owner_id = $2` predicate, so a
 *      record belonging to another owner is filtered even before the policy.
 *
 * A record of another owner is therefore indistinguishable from a missing one:
 * `Fault(404, 'not_found')`, never 403.
 *
 * `createPostgresAccountDeletion()` below is a separate port (HARD-DELETE-02): the
 * hard deletion of a whole account. It needs DELETE rights the learner role does not have.
 */

import { randomUUID } from 'node:crypto';
import { Fault } from '../../server/owned-api.mjs';

const UUID_RE = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const TEXT_LIMIT = 12000;
const TASK_VERSION = 'synthetic-writing-v1';
const RUBRIC_VERSION = 'formative-fixture-v1';

const fail = (status, code) => { throw new Fault(status, code); };
const first = (result) => result.rows[0];

/**
 * Build the owned-attempts datastore port over a pg Pool.
 * @param {{pool: object, onCall?: (name: string) => void}} options
 *   `pool` must connect as the restricted learner role.
 * @returns {object} the port `createOwnedApi({ datastore })` consumes.
 */
export function createPostgresDatastore({ pool, onCall } = {}) {
  if (!pool || typeof pool.connect !== 'function') {
    throw new TypeError('createPostgresDatastore requires a pg Pool');
  }
  const note = typeof onCall === 'function' ? onCall : () => {};

  /**
   * One transaction with the verified owner bound locally to `hatoove.owner_id`.
   * The setting is transaction-local (`set_config(..., true)`), so returning a
   * pooled connection never leaks a previous owner's context.
   */
  async function settle(owner, work) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('hatoove.owner_id', $1, true)", [owner]);
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

  /** Live, owned attempt or 404. Locked for the writer paths. */
  async function owned(client, owner, id) {
    const attempt = first(await client.query(
      'SELECT * FROM attempts WHERE id = $1 AND owner_id = $2 FOR UPDATE', [id, owner]));
    if (!attempt || attempt.deleted_at) fail(404, 'not_found');
    return attempt;
  }

  async function draftOf(client, id) {
    return first(await client.query('SELECT revision, text FROM drafts WHERE attempt_id = $1', [id]));
  }

  return Object.freeze({
    async create(owner, parent = null) {
      note('create');
      return settle(owner, async (client) => {
        if (parent) {
          const parentRow = first(await client.query(
            `SELECT a.id FROM submissions s JOIN attempts a ON a.id = s.attempt_id
             WHERE s.id = $1 AND s.owner_id = $2 AND a.deleted_at IS NULL FOR UPDATE OF a`, [parent, owner]));
          if (!parentRow) fail(404, 'not_found');
        }
        const id = randomUUID();
        await client.query(
          `INSERT INTO attempts(id, owner_id, task_version, rubric_version, parent_submission_id)
           VALUES($1, $2, $3, $4, $5)`, [id, owner, TASK_VERSION, RUBRIC_VERSION, parent]);
        await client.query('INSERT INTO drafts(attempt_id, revision, text) VALUES($1, 1, \'\')', [id]);
        return { id, revision: 1, text: '' };
      });
    },

    async read(owner, id) {
      note('read');
      return settle(owner, async (client) => {
        const attempt = await owned(client, owner, id);
        return { ...attempt, ...(await draftOf(client, id)) };
      });
    },

    async save(owner, id, expectedRevision, text) {
      note('save');
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1 ||
          typeof text !== 'string' || text.length > TEXT_LIMIT) fail(422, 'invalid_draft');
      return settle(owner, async (client) => {
        await owned(client, owner, id);
        const current = await draftOf(client, id);
        if (!current || current.revision !== expectedRevision) fail(409, 'draft_conflict');
        const submitted = first(await client.query('SELECT id FROM submissions WHERE attempt_id = $1', [id]));
        if (submitted) fail(409, 'revision_required');
        return first(await client.query(
          'UPDATE drafts SET revision = revision + 1, text = $2 WHERE attempt_id = $1 RETURNING revision, text', [id, text]));
      });
    },

    async submit(owner, id, expectedRevision, eventId) {
      note('submit');
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1 ||
          typeof eventId !== 'string' || !UUID_RE.test(eventId)) fail(422, 'invalid_submission');
      return settle(owner, async (client) => {
        // Serialize account idempotency and allowance before locking the attempt.
        const entitlement = first(await client.query(
          'SELECT * FROM entitlements WHERE owner_id = $1 FOR UPDATE', [owner]));
        const attempt = await owned(client, owner, id);
        const prior = first(await client.query(
          'SELECT * FROM submissions WHERE owner_id = $1 AND event_id = $2', [owner, eventId]));
        if (prior) {
          if (prior.attempt_id !== attempt.id || prior.draft_revision !== expectedRevision) fail(409, 'idempotency_conflict');
          return { submissionId: prior.id, replay: true };
        }
        const draft = await draftOf(client, id);
        if (!draft || draft.revision !== expectedRevision) fail(409, 'draft_conflict');
        if (!draft.text.trim()) fail(422, 'empty_submission');
        if (first(await client.query('SELECT id FROM submissions WHERE attempt_id = $1', [id]))) fail(409, 'already_submitted');
        if (!entitlement || entitlement.used + entitlement.reserved >= entitlement.allowance) fail(409, 'allowance_exhausted');
        const submissionId = randomUUID();
        await client.query(
          `INSERT INTO submissions(id, attempt_id, owner_id, event_id, draft_revision, text, task_version, rubric_version)
           VALUES($1, $2, $3, $4, $5, $6, $7, $8)`,
          [submissionId, id, owner, eventId, draft.revision, draft.text, attempt.task_version, attempt.rubric_version]);
        await client.query(
          "INSERT INTO jobs(id, submission_id, owner_id, status) VALUES($1, $2, $3, 'queued')",
          [randomUUID(), submissionId, owner]);
        await client.query('UPDATE entitlements SET reserved = reserved + 1 WHERE owner_id = $1', [owner]);
        return { submissionId, replay: false };
      });
    },

    async result(owner, submissionId) {
      note('result');
      return settle(owner, async (client) => {
        const submission = first(await client.query(
          'SELECT * FROM submissions WHERE id = $1 AND owner_id = $2', [submissionId, owner]));
        if (!submission) fail(404, 'not_found');
        await owned(client, owner, submission.attempt_id);
        const job = first(await client.query(
          'SELECT status, failure_code, tries FROM jobs WHERE submission_id = $1', [submissionId]));
        const assessment = first(await client.query(
          'SELECT feedback, model_version, prompt_version, rubric_version FROM assessments WHERE submission_id = $1', [submissionId]));
        return { submission, job, assessment: assessment ?? null };
      });
    },

    async retry(owner, submissionId) {
      note('retry');
      return settle(owner, async (client) => {
        const entitlement = first(await client.query(
          'SELECT * FROM entitlements WHERE owner_id = $1 FOR UPDATE', [owner]));
        const submission = first(await client.query(
          'SELECT * FROM submissions WHERE id = $1 AND owner_id = $2', [submissionId, owner]));
        if (!submission) fail(404, 'not_found');
        await owned(client, owner, submission.attempt_id);
        const job = first(await client.query(
          'SELECT * FROM jobs WHERE submission_id = $1 FOR UPDATE', [submissionId]));
        if (!job || job.status !== 'failed' || job.tries >= 3 || job.failure_code === 'retry_exhausted') {
          fail(409, 'retry_unavailable');
        }
        if (!entitlement || entitlement.used + entitlement.reserved >= entitlement.allowance) fail(409, 'allowance_exhausted');
        await client.query("UPDATE jobs SET status = 'queued', failure_code = NULL WHERE id = $1", [job.id]);
        await client.query('UPDATE entitlements SET reserved = reserved + 1 WHERE owner_id = $1', [owner]);
      });
    },

    async remove(owner, id) {
      note('remove');
      return settle(owner, async (client) => {
        await client.query('SELECT owner_id FROM entitlements WHERE owner_id = $1 FOR UPDATE', [owner]);
        await owned(client, owner, id);
        const cancelled = await client.query(
          `UPDATE jobs SET status = 'cancelled', lease_token = NULL, lease_until = NULL
           WHERE submission_id IN (SELECT id FROM submissions WHERE attempt_id = $1)
             AND status IN ('queued', 'running') RETURNING id`, [id]);
        if (cancelled.rowCount) {
          await client.query('UPDATE entitlements SET reserved = reserved - $2 WHERE owner_id = $1', [owner, cancelled.rowCount]);
        }
        await client.query('UPDATE attempts SET deleted_at = now() WHERE id = $1', [id]);
        await client.query('DELETE FROM drafts WHERE attempt_id = $1', [id]);
      });
    },
  });
}

/**
 * The hard account deletion (HARD-DELETE-01 §2), in the specification's order.
 *
 * No ownership key cascades except `learner_settings.user_id`, and `attempts` and
 * `submissions` reference each other (`attempts.parent_submission_id`), so the cycle is
 * broken FIRST and every dependant goes before what it points at. `"user"` is last.
 * `account` (the password hash) and `session` both cascade from `"user"` in the auth
 * schema; `session` is still deleted explicitly at step 10 so its count is reported.
 *
 * Each entry is `[name, sql]`; `$1` is the verified owner.
 */
export const ACCOUNT_DELETION_STEPS = Object.freeze([
  ['attempts_unlinked', 'UPDATE attempts SET parent_submission_id = NULL WHERE owner_id = $1 AND parent_submission_id IS NOT NULL'],
  ['usage_ledger', 'DELETE FROM usage_ledger WHERE owner_id = $1'],
  ['assessments', 'DELETE FROM assessments WHERE owner_id = $1'],
  ['jobs', 'DELETE FROM jobs WHERE owner_id = $1'],
  ['drafts', 'DELETE FROM drafts WHERE attempt_id IN (SELECT id FROM attempts WHERE owner_id = $1)'],
  ['submissions', 'DELETE FROM submissions WHERE owner_id = $1'],
  ['attempts', 'DELETE FROM attempts WHERE owner_id = $1'],
  ['entitlements', 'DELETE FROM entitlements WHERE owner_id = $1'],
  ['learner_settings', 'DELETE FROM learner_settings WHERE user_id = $1'],
  ['session', 'DELETE FROM session WHERE "userId" = $1'],
  ['user', 'DELETE FROM "user" WHERE id = $1'],
].map((step) => Object.freeze(step)));

/** Every table that holds an account's rows, and its ownership column, for the read-back. */
export const ACCOUNT_TABLES = Object.freeze([
  ['attempts', 'owner_id'], ['submissions', 'owner_id'], ['jobs', 'owner_id'],
  ['assessments', 'owner_id'], ['usage_ledger', 'owner_id'], ['entitlements', 'owner_id'],
  ['learner_settings', 'user_id'], ['session', '"userId"'], ['account', '"userId"'], ['"user"', 'id'],
].map((entry) => Object.freeze(entry)));

/**
 * Build the account-deletion port: `deleteAccount(owner) -> {existed, removed}`.
 *
 * The whole deletion is ONE transaction, so a failure at any step leaves the account
 * intact rather than half-removed. The `"user"` row is locked first: a concurrent sign-in
 * or attempt insert needs a key-share lock on it (its foreign key), so it waits for this
 * transaction and then fails on the missing row instead of re-creating data mid-deletion.
 * Before COMMIT the transaction reads every account table back and refuses (rolls back)
 * if any row of the owner is left - a schema change that adds an owned table without
 * adding it here fails loudly instead of leaving data behind.
 *
 * PRIVILEGES: this cannot run as the restricted learner role. `isolation.sql` grants that
 * role DELETE on `drafts` only, and no row-level-security policy allows DELETE on the
 * owned tables, so `pool` must be a role granted SELECT/DELETE on the account tables,
 * UPDATE(parent_submission_id) on attempts and an owner-scoped policy for each. No such
 * role is provisioned yet; see work/implementation/HARD-DELETE-01.md §6.
 *
 * @param {{pool: object, afterStep?: (index: number, name: string, client: object) => (void|Promise<void>)}} options
 *   `afterStep` is a test hook (failure injection); it runs inside the transaction after
 *   each step (with the transaction's client, so a test can observe the in-flight state),
 *   and a throw from it rolls the whole deletion back.
 */
export function createPostgresAccountDeletion({ pool, afterStep } = {}) {
  if (!pool || typeof pool.connect !== 'function') {
    throw new TypeError('createPostgresAccountDeletion requires a pg Pool');
  }
  const hook = typeof afterStep === 'function' ? afterStep : null;

  return Object.freeze({
    async deleteAccount(owner) {
      if (typeof owner !== 'string' || owner.trim() === '') fail(422, 'invalid_owner');
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query("SELECT set_config('hatoove.owner_id', $1, true)", [owner]);
        const existed = (await client.query('SELECT id FROM "user" WHERE id = $1 FOR UPDATE', [owner])).rowCount > 0;
        const removed = {};
        for (const [index, [name, sql]] of ACCOUNT_DELETION_STEPS.entries()) {
          removed[name] = (await client.query(sql, [owner])).rowCount;
          if (hook) await hook(index + 1, name, client);
        }
        for (const [table, column] of ACCOUNT_TABLES) {
          const left = first(await client.query(`SELECT count(*)::int AS n FROM ${table} WHERE ${column} = $1`, [owner])).n;
          if (left !== 0) throw new Error(`account deletion left ${left} row(s) in ${table}`);
        }
        await client.query('COMMIT');
        return { existed, removed };
      } catch (error) {
        try { await client.query('ROLLBACK'); } catch { /* preserve the original failure */ }
        throw error;
      } finally {
        client.release();
      }
    },
  });
}

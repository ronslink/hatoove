/**
 * Test world over the PostgreSQL adapter (OWNAPI-02).
 *
 * Mirrors the shape `tools/owned-api-check.mjs` builds in memory
 * (`{store: {port, inspect, worker}, sessions, api}`) so the SAME 24-check suite
 * runs against real PostgreSQL. The `inspect` and `worker` surfaces are test
 * hooks only; they are never part of the HTTP port and are reached with the
 * fixture's privileged pool or the restricted worker role, never through a
 * learner route.
 */

import { createFixture } from './bootstrap.mjs';
import { createPostgresDatastore } from './adapter.mjs';
import { createPostgresSessions } from './sessions.mjs';
import { createOwnedApi } from '../../server/owned-api.mjs';

/** Deterministic table order for `fingerprint()`. */
const FINGERPRINT_TABLES = [
  ['attempts', 'id'], ['drafts', 'attempt_id'], ['submissions', 'id'], ['jobs', 'id'],
  ['assessments', 'submission_id'], ['usage_ledger', 'submission_id'], ['entitlements', 'owner_id'],
];

/**
 * @param {{allowance?: number, fixture?: object}} options
 * @returns {Promise<{store: object, sessions: object, api: object, fixture: object, teardown: Function}>}
 */
export async function createPostgresWorld({ allowance = 10, fixture } = {}) {
  const db = fixture ?? await createFixture();
  const calls = [];
  const port = createPostgresDatastore({ pool: db.learner, onCall: (name) => calls.push(name) });
  const sessions = createPostgresSessions({ pool: db.auth, adminPool: db.admin, allowance });
  const api = createOwnedApi({ datastore: port, sessions });

  async function one(sql, params) {
    return (await db.admin.query(sql, params)).rows[0];
  }

  const inspect = {
    calls,
    /**
     * Submission count. On a **persistent** installation (OWNAPI-03) the table keeps every
     * earlier run's rows, so pass an `owner` to scope the count to one account; without one
     * this is the absolute total across the whole installation.
     */
    async submissionCount(owner) {
      const row = owner === undefined
        ? await one('SELECT count(*)::int AS n FROM submissions')
        : await one('SELECT count(*)::int AS n FROM submissions WHERE owner_id = $1', [owner]);
      return row.n;
    },
    async submission(id) {
      const row = await one('SELECT * FROM submissions WHERE id = $1', [id]);
      // Frozen so a caller cannot mutate a stored snapshot through the hook; the
      // real invariant is the immutable_submission trigger in schema.sql.
      return row ? Object.freeze(row) : undefined;
    },
    async job(submissionId) {
      const row = await one('SELECT * FROM jobs WHERE submission_id = $1', [submissionId]);
      return row ? { ...row } : undefined;
    },
    async attempt(id) {
      const row = await one('SELECT * FROM attempts WHERE id = $1', [id]);
      if (!row) return null;
      const draft = await one('SELECT revision, text FROM drafts WHERE attempt_id = $1', [id]);
      return { ...row, draft: draft ? { ...draft } : null };
    },
    async entitlement(owner) {
      const row = await one('SELECT * FROM entitlements WHERE owner_id = $1', [owner]);
      return row ? { ...row } : { allowance, used: 0, reserved: 0 };
    },
    async fingerprint() {
      const state = {};
      for (const [table, order] of FINGERPRINT_TABLES) {
        state[table] = (await db.admin.query(`SELECT * FROM ${table} ORDER BY ${order}`)).rows;
      }
      return JSON.stringify(state, (key, value) => (value instanceof Date ? value.toISOString() : value));
    },
  };

  async function workerTransaction(work) {
    const client = await db.worker.connect();
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

  const worker = {
    async claim(submissionId) {
      const result = await db.worker.query(
        `UPDATE jobs SET status = 'running', tries = tries + 1
         WHERE submission_id = $1 AND status = 'queued' RETURNING id`, [submissionId]);
      return result.rowCount > 0;
    },
    async complete(submissionId, comment) {
      return workerTransaction(async (client) => {
        const job = (await client.query(
          `SELECT j.id, j.status, s.owner_id, s.attempt_id, s.rubric_version
           FROM jobs j JOIN submissions s ON s.id = j.submission_id
           WHERE j.submission_id = $1 FOR UPDATE OF j`, [submissionId])).rows[0];
        if (!job || job.status !== 'running') return false;
        const attempt = (await client.query('SELECT deleted_at FROM attempts WHERE id = $1', [job.attempt_id])).rows[0];
        if (!attempt || attempt.deleted_at) return false;
        await client.query(
          `INSERT INTO assessments(submission_id, owner_id, feedback, model_version, prompt_version, rubric_version)
           VALUES($1, $2, $3::jsonb, 'fixture-v1', 'fixture-v1', $4)`,
          [submissionId, job.owner_id, JSON.stringify({ kind: 'synthetic-formative', comment }), job.rubric_version]);
        await client.query('INSERT INTO usage_ledger(submission_id, owner_id, units) VALUES($1, $2, 1)', [submissionId, job.owner_id]);
        await client.query('UPDATE entitlements SET reserved = reserved - 1, used = used + 1 WHERE owner_id = $1', [job.owner_id]);
        await client.query("UPDATE jobs SET status = 'succeeded', lease_token = NULL, lease_until = NULL WHERE id = $1", [job.id]);
        return true;
      });
    },
    async fail(submissionId, code) {
      return workerTransaction(async (client) => {
        const job = (await client.query(
          'SELECT j.id, j.status, s.owner_id FROM jobs j JOIN submissions s ON s.id = j.submission_id WHERE j.submission_id = $1 FOR UPDATE OF j',
          [submissionId])).rows[0];
        if (!job || job.status !== 'running') return false;
        await client.query("UPDATE jobs SET status = 'failed', failure_code = $2, lease_token = NULL, lease_until = NULL WHERE id = $1", [job.id, code]);
        await client.query('UPDATE entitlements SET reserved = reserved - 1 WHERE owner_id = $1', [job.owner_id]);
        return true;
      });
    },
  };

  return {
    store: { port, inspect, worker },
    sessions,
    api,
    fixture: db,
    // A disposable fixture drops its schema/roles; a *persistent* installation (OWNAPI-03,
    // built by provision.mjs) has no cleanup and must keep its rows, so teardown only
    // closes the pools it was handed.
    teardown: async () => {
      if (typeof db.cleanup === 'function') await db.cleanup();
      else await db.close();
    },
  };
}

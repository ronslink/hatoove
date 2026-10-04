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
import { stubGrade, rubricFor } from './worker.mjs';
import { createPostgresThrottle } from './throttle.mjs';
import { createPostgresAccountRequests } from './account-requests.mjs';
import { createConsoleNotifier } from '../../server/notify.mjs';
import { createPostgresDatastore, createPostgresAccountDeletion } from './adapter.mjs';
import { createPostgresSessions } from './sessions.mjs';
import { createPostgresSettings } from './settings.mjs';
import { createOwnedApi } from '../../server/owned-api.mjs';
import { createPostgresPayments } from './payments.mjs';
import { parsePublicOrigin } from '../public-origin.mjs';

/** Deterministic table order for `fingerprint()`. */
const FINGERPRINT_TABLES = [
  ['attempts', 'id'], ['drafts', 'attempt_id'], ['submissions', 'id'], ['jobs', 'id'],
  ['assessments', 'submission_id'], ['usage_ledger', 'submission_id'], ['entitlements', 'owner_id, exam_id'],
  // EXAM-S1: a refused request must leave preparations and evidence untouched too.
  ['learner_preparation', 'id'], ['item_evidence', 'evidence_id'],
  ['mock_run', 'id'], ['mock_run_event', 'owner_id, event_id'],
];
const INITIAL_EXAM = 'telc-deutsch-b1';

/**
 * @param {{allowance?: number, fixture?: object, deletion?: object}} options
 *   `deletion` is the pool the account-deletion port runs as. It is the seam the running
 *   server needs: `server/accounts.mjs` passes the pool `provisionPersistent()` built for the
 *   `<prefix>_deletion` role, so the api this world returns (the one `server.js` mounts) has
 *   the deletion wired. A fixture that carries its own `deletion` pool (a disposable
 *   `bootstrap.mjs` fixture does) is used when the option is omitted. When neither exists the
 *   API is built without the deletion port, exactly as an installation that has not migrated
 *   would be — the route then answers 503 rather than pretending.
 * @returns {Promise<{store: object, sessions: object, settings: object, api: object, deletion: object|null, throttle: object, accountRequests: object, fixture: object, teardown: Function}>}
 */
export async function createPostgresWorld({
  allowance = 10, fixture, deletion, limits = null, notifier = null,
  // EXAM-S1 test seams, server-side only: a disposable test may offer a second synthetic package and may
  // inject a registration failure. The running server passes neither.
  examCatalogue, registrationHook, paymentProvider, publicOrigin, requireHttps,
} = {}) {
  const trustedRequireHttps = requireHttps ?? fixture?.requireHttps ?? false;
  const trustedOrigin = parsePublicOrigin(publicOrigin ?? fixture?.publicOrigin, { requireHttps: trustedRequireHttps });
  const db = fixture ?? await createFixture();
  const calls = [];
  const port = createPostgresDatastore({ pool: db.learner, onCall: (name) => calls.push(name), ...(examCatalogue ? { examCatalogue } : {}) });
  /*
   * THE NOTIFIER IS INJECTABLE, and in the pilot it is the OPERATOR CONSOLE (D6): nothing leaves the building,
   * and a check can capture deliveries instead of printing them.
   *
   * Read from the FIXTURE object first, exactly as `db.settings` is read below: that is the established way an
   * injected fixture supplies its own wiring, and the running server sets `fixture.notifier` so its deliveries
   * reach the real console. The option remains for a caller that builds a world directly.
   */
  const notify = db.notifier ?? notifier ?? createConsoleNotifier({ log: () => {} });
  const sessions = createPostgresSessions({ pool: db.auth, adminPool: db.admin, allowance, notify, registrationHook,
    publicOrigin: trustedOrigin, requireHttps: trustedRequireHttps });
  /*
   * THE AUTH THROTTLE, ON THE AUTH POOL — the same restriction the sessions port runs under, because a limit
   * is auth material: only the auth role may see who has been failing to sign in (migration 0019's GRANT).
   * `limits` is injectable so a check can use a small window instead of waiting out a real one.
   */
  const throttle = createPostgresThrottle({ pool: db.auth, ...(limits ? { policy: limits } : {}) });
  /*
   * THE PILOT ACCOUNT-REQUEST QUEUE (`0041`), ON THE SAME AUTH POOL AS THE THROTTLE, for the same reason: a
   * request carries the address of somebody who is not an account holder yet, so only the auth seam may read
   * the queue. An injected fixture may supply its own port, exactly as it may supply settings.
   */
  const accountRequests = db.accountRequests ?? createPostgresAccountRequests({ pool: db.auth });
  // Account settings are part of the same account, so the world builds them from the same
  // restricted learner pool. An injected fixture may supply its own.
  const settings = db.settings ?? createPostgresSettings({ pool: db.learner });
  const deletionPool = deletion ?? db.deletion ?? null;
  const accountDeletion = deletionPool ? createPostgresAccountDeletion({ pool: deletionPool }) : null;
  const payments = db.payments ? createPostgresPayments({ pool: db.payments, provider: paymentProvider ?? db.paymentProvider,
    publicOrigin: publicOrigin ?? db.publicOrigin, ...(examCatalogue ? { examCatalogue } : {}) }) : null;
  const api = createOwnedApi({ datastore: port, sessions, settings, accountDeletion, throttle, payments, accountRequests });

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
    /** One (owner, exam) balance. EXAM-S1: an absent balance is zero, not the sign-up allowance. */
    async entitlement(owner, examId = INITIAL_EXAM) {
      const row = await one('SELECT * FROM entitlements WHERE owner_id = $1 AND exam_id = $2', [owner, examId]);
      return row ? { ...row } : { owner_id: owner, exam_id: examId, allowance: 0, used: 0, reserved: 0 };
    },
    /** Every preparation of an owner, archived included, in creation order. */
    async preparations(owner) {
      return (await db.admin.query(
        'SELECT * FROM learner_preparation WHERE owner_id = $1 ORDER BY created_at, id', [owner])).rows.map((row) => ({ ...row }));
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
          // `rubric_id` lives on the ATTEMPT, not on the submission — the submission carries the VERSIONS it
          // froze. Selecting `s.rubric_id` would be a column that does not exist (SQLSTATE 42703).
          `SELECT j.id, j.status, j.exam_id, s.owner_id, s.attempt_id, s.rubric_version, s.text, s.explanation_language,
                  a.rubric_id
           FROM jobs j JOIN submissions s ON s.id = j.submission_id
                       JOIN attempts a ON a.id = s.attempt_id
           WHERE j.submission_id = $1 FOR UPDATE OF j`, [submissionId])).rows[0];
        if (!job || job.status !== 'running') return false;
        const attempt = (await client.query('SELECT deleted_at FROM attempts WHERE id = $1', [job.attempt_id])).rows[0];
        if (!attempt || attempt.deleted_at) return false;
        /*
         * THE FIXTURE PRODUCES WHAT THE PRODUCT PRODUCES, from the same function the shipped stub uses.
         *
         * This used to write a one-comment `synthetic-formative` assessment, which stopped being the current
         * contract when the writing rubric became telc B1's three-criterion one. A fixture that fabricates a
         * shape the grader cannot produce is how a suite ends up asserting yesterday's contract: the
         * `comment` argument is kept for the RETIRED rubric (an old attempt being completed), and the
         * current rubric gets the band shape, built by `stubGrade` so there is one definition of it.
         */
        const rubric = rubricFor(job.rubric_id, job.rubric_version);
        const feedback = rubric
          ? stubGrade({ text: job.text, explanationLanguage: job.explanation_language }).feedback
          : { kind: 'synthetic-formative', comment };
        await client.query(
          `INSERT INTO assessments(submission_id, owner_id, feedback, model_version, prompt_version, rubric_version)
           VALUES($1, $2, $3::jsonb, 'fixture-v1', 'fixture-v1', $4)`,
          [submissionId, job.owner_id, JSON.stringify(feedback), job.rubric_version]);
        await client.query('INSERT INTO usage_ledger(submission_id, owner_id, units) VALUES($1, $2, 1)', [submissionId, job.owner_id]);
        // Same original-exam debit as the runtime worker (EXAM-S1).
        await client.query('UPDATE entitlements SET reserved = reserved - 1, used = used + 1 WHERE owner_id = $1 AND exam_id = $2',
          [job.owner_id, job.exam_id]);
        await client.query("UPDATE jobs SET status = 'succeeded', lease_token = NULL, lease_until = NULL WHERE id = $1", [job.id]);
        return true;
      });
    },
    async fail(submissionId, code) {
      return workerTransaction(async (client) => {
        const job = (await client.query(
          'SELECT j.id, j.status, j.exam_id, s.owner_id FROM jobs j JOIN submissions s ON s.id = j.submission_id WHERE j.submission_id = $1 FOR UPDATE OF j',
          [submissionId])).rows[0];
        if (!job || job.status !== 'running') return false;
        await client.query("UPDATE jobs SET status = 'failed', failure_code = $2, lease_token = NULL, lease_until = NULL WHERE id = $1", [job.id, code]);
        await client.query('UPDATE entitlements SET reserved = reserved - 1 WHERE owner_id = $1 AND exam_id = $2',
          [job.owner_id, job.exam_id]);
        return true;
      });
    },
  };

  return {
    store: { port, inspect, worker },
    sessions,
    settings,
    // The throttle the api was built with, for the same reason `deletion` is here: a check can then use the
    // SAME wiring the product uses instead of assembling a second one that can disagree with it.
    throttle,
    payments,
    // The account-request port the api above was built with, for the same reason `deletion` and `throttle`
    // are here: a check exercises the SAME wiring the product uses instead of assembling a second one.
    accountRequests,
    api,
    // The port the api above was built with, so a caller can exercise the port directly
    // (idempotence, failure injection) without assembling a second, differently-wired api.
    deletion: accountDeletion,
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

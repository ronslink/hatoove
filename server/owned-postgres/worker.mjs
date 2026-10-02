/**
 * The worker runner (WORKER-RUNNER-01): a bounded step function that claims one queued
 * job, grades it through an INJECTED grader, and commits the assessment under a lease
 * fence — or reclaims jobs whose lease has expired.
 *
 * It is deliberately NOT a daemon. `runOnce()` claims at most one job, does one unit of
 * work and returns; `reclaimExpired()` is one bounded pass. A caller loops them with a
 * bounded count (or a bounded sleep) — see `server/worker.mjs` — so a stall in this
 * process cannot masquerade as progress the way an unbounded `while (true)` loop can.
 *
 * This slice makes NO provider call: the default `grade` is a deterministic stub that
 * returns a fixed synthetic assessment. Wiring a real grader is a separate slice, and it
 * injects itself here without any change to the queue, the lease, the retry or the debit.
 *
 * Privileges: this module is written for the restricted `worker` role (`<prefix>_worker`),
 * never `admin` or `migration`. Its statements use only the column-level grants
 * `isolation.sql` gives that role:
 *   SELECT  attempts, submissions, jobs, entitlements, assessments, usage_ledger
 *   UPDATE  jobs(status,lease_token,lease_until,tries,failure_code)
 *   UPDATE  entitlements(used,reserved)
 *   INSERT  assessments, usage_ledger
 * Read the record `work/implementation/WORKER-RUNNER-01.md` §2 for why no migration is
 * needed: every column this module writes is already granted.
 *
 * Lease fencing (the property the whole design exists for): a claimed job carries a
 * random `lease_token`. The assessment is written in ONE transaction that re-reads the
 * job `FOR UPDATE` and requires the SAME token and `status='running'`. A worker whose
 * lease was reclaimed and re-claimed by someone else therefore holds a stale token and
 * its commit touches nothing — it returns `outcome:'stale'` and the assessment in the
 * database is the other worker's, exactly one of them.
 */

import { randomUUID } from 'node:crypto';

export const DEFAULT_LEASE_MS = 60000;
export const DEFAULT_MAX_TRIES = 3;
/** The failure code a job that exhausts its retries through reclamation is marked with. */
export const RETRY_EXHAUSTED = 'retry_exhausted';
/** The failure code used when the grader throws something without a usable `code`. */
export const GRADER_ERROR = 'grader_error';

const CODE_RE = /^[a-z][a-z0-9_]{0,63}$/;
const first = (result) => result.rows[0];

/**
 * The deterministic default grader. It is a synthetic assessment and makes **no**
 * provider call — the point of this slice is the queue and the debit, not the model.
 * @returns {{feedback: object, modelVersion: string, promptVersion: string}}
 */
export function stubGrade() {
  return {
    feedback: { kind: 'synthetic-formative', comment: 'Synthetic stub feedback (no provider call).' },
    modelVersion: 'stub-grader-v1',
    promptVersion: 'stub-grader-v1',
  };
}

/** A failure code a caller can trust: the grader's own `code` when it is one, else a constant. */
function failureCodeOf(error) {
  const code = error && typeof error.code === 'string' ? error.code : null;
  return code && CODE_RE.test(code) ? code : GRADER_ERROR;
}

/** The failure code for an assessment whose SHAPE the contract does not allow. */
export const INVALID_ASSESSMENT = 'invalid_assessment';

/*
 * THE ASSESSMENT SHAPE IS VALIDATED BEFORE ANYTHING IS STORED (MASTER-PLAN D4 / R11).
 *
 * The rubric contract is OPEN: a separately versioned three-criterion contract, or honestly labelled
 * provisional four-criterion internal feedback — and the decision notes say the two must never be
 * renormalised into each other. PILOT-06's result schema is blocked on that decision.
 *
 * While it is open, the danger is not that a grader picks the wrong one of the two. It is that a SHAPE
 * arrives through the data layer, where no screen check can see it: `completeSuccess` stored
 * `assessment.feedback` verbatim, so `{total: 35}`, `{bestanden: true}` or `criteria: [{score: 12}]`
 * would be written to `assessments`, served by `result()`, and rendered by any present or future client
 * as though the contract had been decided. That is a fabricated assessment, and "no /45 and no pass
 * line" is a red-line product rule rather than a formatting preference.
 *
 * SO THE ALLOWED SHAPE IS EXACTLY WHAT THE PRODUCT PROMISES TODAY: a `kind`, an optional `comment`, and
 * the versions the feedback was produced with. Anything else — a total, a score, a band, a verdict, a
 * criterion list, or an unknown field — fails the job with a stable code and stores NOTHING. When D4 is
 * decided, THIS FUNCTION is the one place to widen, and widening it is a deliberate, reviewable edit
 * rather than a silent consequence of a provider changing its response shape.
 */
const ASSESSMENT_FIELDS = ['feedback', 'modelVersion', 'promptVersion'];
const FEEDBACK_FIELDS = ['kind', 'comment'];
const COMMENT_LIMIT = 4000;
const VERSION_LIMIT = 120;

/**
 * A `kind` is a token WITH dashes allowed: the shipped stub reports `synthetic-formative`, and reusing the
 * failure-code pattern (`CODE_RE`, underscores only) rejected it — which the control case in
 * `worker-runner-check` leg 3b caught immediately. A validator that refuses the one assessment the
 * product ships is not validating, it is breaking.
 */
const KIND_RE = /^[a-z][a-z0-9_-]{0,47}$/;

export function validateAssessment(assessment) {
  const bad = (detail) => {
    const error = new Error(`The assessment shape is not allowed: ${detail}`);
    error.code = INVALID_ASSESSMENT;
    return error;
  };
  if (!assessment || typeof assessment !== 'object' || Array.isArray(assessment)) throw bad('not an object');
  for (const key of Object.keys(assessment)) {
    if (!ASSESSMENT_FIELDS.includes(key)) throw bad(`unknown assessment field "${key}"`);
  }
  const feedback = assessment.feedback;
  if (!feedback || typeof feedback !== 'object' || Array.isArray(feedback)) throw bad('feedback must be an object');
  for (const key of Object.keys(feedback)) {
    // `criteria`, `total`, `score`, `bestanden`… every one of them lands here, and the message names the
    // field so the failure is diagnosable rather than mysterious.
    if (!FEEDBACK_FIELDS.includes(key)) throw bad(`unknown feedback field "${key}"`);
  }
  if (feedback.kind !== undefined && (typeof feedback.kind !== 'string' || !KIND_RE.test(feedback.kind))) {
    throw bad('feedback.kind must be a token');
  }
  if (feedback.comment !== undefined
    && (typeof feedback.comment !== 'string' || feedback.comment.length > COMMENT_LIMIT)) {
    throw bad(`feedback.comment must be a string of at most ${COMMENT_LIMIT} characters`);
  }
  for (const field of ['modelVersion', 'promptVersion']) {
    const value = assessment[field];
    if (value !== undefined && (typeof value !== 'string' || value.length === 0 || value.length > VERSION_LIMIT)) {
      throw bad(`${field} must be a non-empty string of at most ${VERSION_LIMIT} characters`);
    }
  }
  return assessment;
}

/**
 * @param {{pool: object, grade?: Function, now?: () => Date, leaseMs?: number, maxTries?: number}} options
 *   `pool` must connect as the restricted `worker` role. `grade` receives
 *   `{submissionId, text, taskVersion, rubricVersion, ownerId}` and returns
 *   `{feedback, modelVersion, promptVersion}` or throws. `now` is injectable so a test can
 *   drive the clock rather than sleep.
 * @returns {Readonly<{runOnce: Function, reclaimExpired: Function}>}
 */
export function createWorker({ pool, grade, now = () => new Date(), leaseMs = DEFAULT_LEASE_MS, maxTries = DEFAULT_MAX_TRIES } = {}) {
  if (!pool || typeof pool.connect !== 'function') {
    throw new TypeError('createWorker requires a pg Pool connected as the restricted worker role');
  }
  const gradeFn = typeof grade === 'function' ? grade : stubGrade;
  if (!Number.isSafeInteger(leaseMs) || leaseMs <= 0) throw new TypeError('leaseMs must be a positive integer');
  if (!Number.isSafeInteger(maxTries) || maxTries < 1) throw new TypeError('maxTries must be a positive integer');

  /** One transaction with rollback-on-throw, on a pooled worker connection. */
  async function transaction(work) {
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
   * Claim at most one queued job and process it.
   *
   * The claim is the dispatch's pattern: an `UPDATE … WHERE id = (SELECT … FOR UPDATE SKIP
   * LOCKED LIMIT 1)`. `SKIP LOCKED` means two workers racing one row cannot both claim it —
   * the loser's sub-select finds no unlocked queued row and `claimed` is false. `tries` is
   * incremented HERE, at claim time, so a worker that dies mid-grade still consumes a try
   * and the job is not retried forever.
   *
   * @returns {Promise<{claimed:false} | {claimed:true, submissionId:string, outcome:'succeeded'|'failed'|'stale'|'skipped', code?:string}>}
   */
  async function runOnce() {
    const token = randomUUID();
    const leaseUntil = new Date(now().getTime() + leaseMs);
    const claimed = first(await pool.query(
      `UPDATE jobs SET status = 'running', lease_token = $1, lease_until = $2, tries = tries + 1, failure_code = NULL
       WHERE id = (
         SELECT j.id FROM jobs j JOIN submissions s ON s.id = j.submission_id
         WHERE j.status = 'queued'
         ORDER BY s.created_at, j.id
         FOR UPDATE OF j SKIP LOCKED
         LIMIT 1
       )
       RETURNING id, submission_id, owner_id, tries`, [token, leaseUntil]));
    if (!claimed) return { claimed: false };

    const submissionId = claimed.submission_id;
    const row = first(await pool.query(
      `SELECT s.id, s.owner_id, s.text, s.task_version, s.rubric_version, a.deleted_at
       FROM submissions s JOIN attempts a ON a.id = s.attempt_id
       WHERE s.id = $1`, [submissionId]));
    // Mirror the fixture's `complete`/`fail`: a submission whose attempt is tombstoned is
    // never (re)graded. The lease is left to expire so `reclaimExpired()` returns it; a
    // concurrent tombstone (`remove()`) has already cancelled the job and released the
    // reservation, so there is nothing here to undo.
    if (!row || row.deleted_at) return { claimed: true, submissionId, outcome: 'skipped', code: 'attempt_deleted' };

    let assessment;
    try {
      assessment = await gradeFn({
        submissionId,
        text: row.text,
        taskVersion: row.task_version,
        rubricVersion: row.rubric_version,
        ownerId: row.owner_id,
      });
      /*
       * THE SHAPE GATE, inside the same try so a bad shape is an ordinary job failure: a stable
       * `invalid_assessment` code, the reservation refunded, nothing written. Validating here rather than
       * in `completeSuccess` also means the refusal happens BEFORE the transaction that writes the row,
       * so there is no window in which a fabricated assessment exists.
       */
      validateAssessment(assessment);
    } catch (error) {
      return completeFailure({ submissionId, token, code: failureCodeOf(error) });
    }
    return completeSuccess({ submissionId, token, row, assessment });
  }

  /**
   * Commit a successful grade. The re-read (`FOR UPDATE`) plus the token/status predicate
   * are the lease fence: if another worker re-claimed the job after this lease lapsed, the
   * predicate matches no row and nothing is written.
   */
  async function completeSuccess({ submissionId, token, row, assessment }) {
    return transaction(async (client) => {
      const job = first(await client.query(
        'SELECT id, owner_id, status, lease_token FROM jobs WHERE submission_id = $1 FOR UPDATE', [submissionId]));
      if (!job || job.status !== 'running' || job.lease_token !== token) return { claimed: true, submissionId, outcome: 'stale' };
      const attempt = first(await client.query(
        `SELECT a.deleted_at FROM attempts a JOIN submissions s ON s.id = $1 WHERE a.id = s.attempt_id`, [submissionId]));
      if (!attempt || attempt.deleted_at) return { claimed: true, submissionId, outcome: 'skipped', code: 'attempt_deleted' };

      const feedback = assessment && assessment.feedback !== undefined ? assessment.feedback : { kind: 'synthetic-formative' };
      const modelVersion = (assessment && assessment.modelVersion) || 'unknown';
      const promptVersion = (assessment && assessment.promptVersion) || 'unknown';
      await client.query(
        `INSERT INTO assessments(submission_id, owner_id, feedback, model_version, prompt_version, rubric_version)
         VALUES($1, $2, $3::jsonb, $4, $5, $6)`,
        [submissionId, job.owner_id, JSON.stringify(feedback), modelVersion, promptVersion, row.rubric_version]);
      await client.query(
        'INSERT INTO usage_ledger(submission_id, owner_id, units) VALUES($1, $2, 1)', [submissionId, job.owner_id]);
      await client.query(
        'UPDATE entitlements SET reserved = reserved - 1, used = used + 1 WHERE owner_id = $1', [job.owner_id]);
      await client.query(
        "UPDATE jobs SET status = 'succeeded', lease_token = NULL, lease_until = NULL WHERE id = $1 AND lease_token = $2 AND status = 'running'",
        [job.id, token]);
      return { claimed: true, submissionId, outcome: 'succeeded' };
    });
  }

  /** Commit a failed grade: a stable `failure_code`, the lease released, the reservation refunded. */
  async function completeFailure({ submissionId, token, code }) {
    return transaction(async (client) => {
      const job = first(await client.query(
        'SELECT id, owner_id, status, lease_token FROM jobs WHERE submission_id = $1 FOR UPDATE', [submissionId]));
      if (!job || job.status !== 'running' || job.lease_token !== token) return { claimed: true, submissionId, outcome: 'stale' };
      await client.query(
        "UPDATE jobs SET status = 'failed', failure_code = $3, lease_token = NULL, lease_until = NULL WHERE id = $1 AND lease_token = $2 AND status = 'running'",
        [job.id, token, code]);
      await client.query('UPDATE entitlements SET reserved = reserved - 1 WHERE owner_id = $1', [job.owner_id]);
      return { claimed: true, submissionId, outcome: 'failed', code };
    });
  }

  /**
   * Return every job whose lease has expired to `queued`, or — once it has used
   * `maxTries` — mark it `failed retry_exhausted` and REFUND its reservation, so an
   * abandoned submission does not hold an allowance forever.
   *
   * `FOR UPDATE SKIP LOCKED` in its own transaction means two reclaimers cannot both act
   * on one row. The comparison uses the injected clock (`$1`), so a test can advance time
   * instead of sleeping.
   *
   * @returns {Promise<{requeued:number, abandoned:number}>}
   */
  async function reclaimExpired() {
    return transaction(async (client) => {
      const expired = (await client.query(
        `SELECT id, owner_id, tries FROM jobs
         WHERE status = 'running' AND lease_until IS NOT NULL AND lease_until <= $1
         FOR UPDATE SKIP LOCKED`, [now()])).rows;
      if (!expired.length) return { requeued: 0, abandoned: 0 };
      const requeue = expired.filter((r) => r.tries < maxTries).map((r) => r.id);
      const abandon = expired.filter((r) => r.tries >= maxTries);
      if (requeue.length) {
        await client.query(
          "UPDATE jobs SET status = 'queued', failure_code = NULL, lease_token = NULL, lease_until = NULL WHERE id = ANY($1::uuid[])",
          [requeue]);
      }
      if (abandon.length) {
        await client.query(
          "UPDATE jobs SET status = 'failed', failure_code = $2, lease_token = NULL, lease_until = NULL WHERE id = ANY($1::uuid[])",
          [abandon.map((r) => r.id), RETRY_EXHAUSTED]);
        // Group by owner so one statement refunds each owner exactly its abandoned count.
        const byOwner = new Map();
        for (const r of abandon) byOwner.set(r.owner_id, (byOwner.get(r.owner_id) || 0) + 1);
        for (const [ownerId, n] of byOwner) {
          await client.query('UPDATE entitlements SET reserved = reserved - $2 WHERE owner_id = $1', [ownerId, n]);
        }
      }
      return { requeued: requeue.length, abandoned: abandon.length };
    });
  }

  return Object.freeze({ runOnce, reclaimExpired });
}

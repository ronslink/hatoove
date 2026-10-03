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
import { TELC_B1_WRITING_RUBRIC, FORMATIVE_WRITING_RUBRIC } from './content-seed.mjs';

export const DEFAULT_LEASE_MS = 60000;
export const DEFAULT_MAX_TRIES = 3;
/** The failure code a job that exhausts its retries through reclamation is marked with. */
export const RETRY_EXHAUSTED = 'retry_exhausted';
/** The failure code used when the grader throws something without a usable `code`. */
export const GRADER_ERROR = 'grader_error';

const CODE_RE = /^[a-z][a-z0-9_]{0,63}$/;
const first = (result) => result.rows[0];

/**
 * The rubric an attempt was bound to, resolved from the SEED rather than from the request.
 *
 * `null` means "the retired formative contract" (one comment), which is what an old attempt being re-graded
 * must still produce. `undefined` means the worker does not know the rubric at all, and the caller turns
 * that into a refusal — a grader must not be able to pick a rubric the catalogue never declared.
 */
export function rubricFor(rubricId, rubricVersion) {
  if (rubricId === TELC_B1_WRITING_RUBRIC.rubricId && rubricVersion === TELC_B1_WRITING_RUBRIC.version) {
    return TELC_B1_WRITING_RUBRIC;
  }
  if (rubricId === FORMATIVE_WRITING_RUBRIC.rubricId && rubricVersion === FORMATIVE_WRITING_RUBRIC.version) {
    return null; // the retired contract: shaped as one comment, validated as such
  }
  return undefined;
}

/**
 * The deterministic default grader: a SYNTHETIC band assessment, and still no provider call.
 *
 * It has to produce the CURRENT contract, because the validator refuses anything else — and a stub that the
 * validator rejects would make the one assessment the product ships a failure (the control-case trap that
 * caught an over-strict `kind` pattern in the fabricated-assessment slice).
 *
 * The bands are derived from OBSERVABLE FEATURES of the text, not from a random generator, so the same
 * letter always gets the same bands and a reviewer can see why: whether the letter addresses a recipient,
 * and whether it has enough substance to have covered four Leitpunkte. The comments say what they are —
 * synthetic, produced without a model — in the SNAPSHOTTED explanation language, and the evidence is a
 * genuine slice of the learner's own text, which is what the validator checks it against.
 */
const SYNTHETIC_COMMENT = Object.freeze({
  de: 'Vorläufige Rückmeldung ohne Modell (Übungsbetrieb).',
  en: 'Provisional feedback without a model (practice mode).',
  uk: 'Попередній відгук без моделі (режим практики).',
  ar: 'ملاحظات مبدئية بدون نموذج (وضع التدريب).',
  tr: 'Model olmadan geçici geri bildirim (alıştırma kipi).',
});

/** The first sentence of the text, as a slice — so the quote is guaranteed to be the learner's own words. */
export function firstSentence(text) {
  const value = String(text || '').trim();
  if (!value) return '';
  const match = /^[\s\S]*?[.!?](\s|$)/.exec(value);
  const sentence = (match ? match[0] : value).trim();
  return sentence.length > 0 ? sentence : value.slice(0, 60);
}

export function stubGrade({ text = '', explanationLanguage = 'de' } = {}) {
  const body = String(text || '');
  const comment = SYNTHETIC_COMMENT[String(explanationLanguage || 'de').slice(0, 2)] || SYNTHETIC_COMMENT.de;
  const evidence = firstSentence(body);
  // Two observable features, no model: does the letter address someone, and is there any substance?
  const addressed = /(liebe|sehr geehrte|hallo|guten tag)/i.test(body);
  const substantial = body.length >= 120;
  const bands = {
    aufgabe: substantial ? 'B' : 'C',
    kommunikation: addressed ? 'B' : 'C',
    richtigkeit: 'B',
  };
  return {
    feedback: {
      kind: BAND_KIND,
      criteria: TELC_B1_WRITING_RUBRIC.criteria.map((criterion) => ({
        key: criterion.key,
        band: bands[criterion.key] || 'C',
        evidence,
        comment,
      })),
      corrections: [],
    },
    modelVersion: 'stub-grader-v2',
    promptVersion: 'stub-grader-v2',
  };
}

/** A failure code a caller can trust: the grader's own `code` when it is one, else a constant. */
function failureCodeOf(error) {
  const code = error && typeof error.code === 'string' ? error.code : null;
  return code && CODE_RE.test(code) ? code : GRADER_ERROR;
}

/** The failure code for an assessment whose SHAPE the contract does not allow. */
export const INVALID_ASSESSMENT = 'invalid_assessment';
/** The failure code for an attempt bound to a rubric this worker cannot grade against. The grader is never called. */
export const UNSUPPORTED_RUBRIC = 'unsupported_rubric';

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
/** The RETIRED contract's feedback: one comment. Kept so an old attempt can still be re-graded. */
const LEGACY_FEEDBACK_FIELDS = ['kind', 'comment'];
/** The CURRENT contract's feedback: one band per criterion, plus quoted evidence and corrections. */
const BAND_FEEDBACK_FIELDS = ['kind', 'criteria', 'corrections'];
const COMMENT_LIMIT = 4000;
const EVIDENCE_LIMIT = 2000;
const VERSION_LIMIT = 120;
const CORRECTION_LIMIT = 1000;
const MAX_CORRECTIONS = 40;
const BAND_KIND = 'telc-b1-bands';

/**
 * A `kind` is a token WITH dashes allowed: the shipped stub reports `synthetic-formative`, and reusing the
 * failure-code pattern (`CODE_RE`, underscores only) rejected it — which the control case in
 * `worker-runner-check` leg 3b caught immediately. A validator that refuses the one assessment the
 * product ships is not validating, it is breaking.
 */
const KIND_RE = /^[a-z][a-z0-9_-]{0,47}$/;

/**
 * THE BAND CONTRACT, VALIDATED AGAINST THE RUBRIC THE ATTEMPT WAS BOUND TO.
 *
 * Ron's D4/R11 answer: the writing feedback follows the exam's own marking structure — one BAND per
 * criterion, with the evidence QUOTED from the learner's text and a comment in the language the letter was
 * written under. Missing, duplicate or unknown criteria, a band outside A-D, or evidence that is not a quote
 * make the result a CLASSIFIED FAILURE ("Unbewertet", text preserved, reservation refunded) — never a
 * partial grade.
 *
 * TWO RULES THAT ARE EASY TO GET WRONG, AND ARE THEREFORE ASSERTED:
 *   * the rubric comes from the ATTEMPT, not from the grader: a grader cannot mark against a rubric of its
 *     own choosing, and a rubric this worker does not know is a failure rather than a free pass;
 *   * NOTHING NUMERIC is allowed anywhere in the feedback, because R15 (bands only vs a total out of 45) is
 *     still open and a number would decide it by accident.
 */
export function validateAssessment(assessment, { rubric = null, text = '' } = {}) {
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

  for (const field of ['modelVersion', 'promptVersion']) {
    const value = assessment[field];
    if (value !== undefined && (typeof value !== 'string' || value.length === 0 || value.length > VERSION_LIMIT)) {
      throw bad(`${field} must be a non-empty string of at most ${VERSION_LIMIT} characters`);
    }
  }

  /*
   * NO RUBRIC, NO BANDS. An attempt bound to a rubric this worker cannot resolve is marked "unbewertet"
   * rather than accepted on trust: the whole point of the binding is that someone can say which contract a
   * result was produced under.
   */
  if (!rubric) {
    // The RETIRED contract, for an old attempt being re-graded: one comment, unchanged.
    for (const key of Object.keys(feedback)) {
      if (!LEGACY_FEEDBACK_FIELDS.includes(key)) throw bad(`unknown feedback field "${key}"`);
    }
    if (feedback.kind !== undefined && (typeof feedback.kind !== 'string' || !KIND_RE.test(feedback.kind))) {
      throw bad('feedback.kind must be a token');
    }
    if (feedback.comment !== undefined
      && (typeof feedback.comment !== 'string' || feedback.comment.length > COMMENT_LIMIT)) {
      throw bad(`feedback.comment must be a string of at most ${COMMENT_LIMIT} characters`);
    }
    return assessment;
  }

  for (const key of Object.keys(feedback)) {
    // `total`, `score`, `bestanden`, `punkte`… every one of them lands here, and the message names the
    // field so the failure is diagnosable rather than mysterious.
    if (!BAND_FEEDBACK_FIELDS.includes(key)) throw bad(`unknown feedback field "${key}"`);
  }
  if (feedback.kind !== BAND_KIND) throw bad(`feedback.kind must be "${BAND_KIND}" for this rubric`);
  if (!Array.isArray(feedback.criteria)) throw bad('feedback.criteria must be an array');

  const expected = rubric.criteria.map((criterion) => criterion.key);
  // EACH CRITERION AGAINST ITS OWN SCALE, looked up by key: criteria may carry different bands, and a
  // grader may list them in any order (EXAM-S0). Reading the first criterion's scale for all was wrong.
  const bandsByKey = new Map(rubric.criteria.map((criterion) => [criterion.key, Object.keys(criterion.bands || {})]));
  const seen = new Set();
  for (const [index, criterion] of feedback.criteria.entries()) {
    if (!criterion || typeof criterion !== 'object' || Array.isArray(criterion)) throw bad(`criteria[${index}] must be an object`);
    for (const key of Object.keys(criterion)) {
      if (!['key', 'band', 'evidence', 'comment'].includes(key)) throw bad(`criteria[${index}]: unknown field "${key}"`);
    }
    if (!expected.includes(criterion.key)) throw bad(`criteria[${index}]: unknown criterion "${criterion.key}"`);
    if (seen.has(criterion.key)) throw bad(`criteria[${index}]: "${criterion.key}" appears twice`);
    seen.add(criterion.key);
    const bands = bandsByKey.get(criterion.key);
    if (!bands.includes(criterion.band)) throw bad(`criteria[${index}] (${criterion.key}): band must be one of ${bands.join('/')}, got ${JSON.stringify(criterion.band)}`);
    if (typeof criterion.evidence !== 'string' || criterion.evidence.trim().length === 0 || criterion.evidence.length > EVIDENCE_LIMIT) {
      throw bad(`criteria[${index}] (${criterion.key}): evidence must be a non-empty quote`);
    }
    /*
     * THE QUOTE MUST BE FROM THE LEARNER'S TEXT. This is the rule that makes the evidence worth reading: a
     * grader that invents a justification is inventing the reason for the band, and the learner sees the
     * quote beside their own sentence.
     */
    if (!String(text).includes(criterion.evidence)) {
      throw bad(`criteria[${index}] (${criterion.key}): evidence is not quoted from the submitted text`);
    }
    if (typeof criterion.comment !== 'string' || criterion.comment.trim().length === 0 || criterion.comment.length > COMMENT_LIMIT) {
      throw bad(`criteria[${index}] (${criterion.key}): comment must be a non-empty string`);
    }
  }
  const missing = expected.filter((key) => !seen.has(key));
  if (missing.length) throw bad(`missing criterion/criteria: ${missing.join(', ')}`);

  if (!Array.isArray(feedback.corrections)) throw bad('feedback.corrections must be an array');
  if (feedback.corrections.length > MAX_CORRECTIONS) throw bad(`at most ${MAX_CORRECTIONS} corrections`);
  for (const [index, correction] of feedback.corrections.entries()) {
    if (typeof correction !== 'string' || correction.trim().length === 0 || correction.length > CORRECTION_LIMIT) {
      throw bad(`corrections[${index}] must be a non-empty string`);
    }
  }

  // R15 IS OPEN: a number here would answer it. Checked last so the message names the field it found.
  const numeric = [];
  const scan = (value, at) => {
    if (typeof value === 'number') numeric.push(at);
    else if (value && typeof value === 'object') for (const [key, inner] of Object.entries(value)) scan(inner, `${at}.${key}`);
  };
  scan(feedback, 'feedback');
  if (numeric.length) throw bad(`nothing numeric may be stored while the score contract is open: ${numeric.join(', ')}`);

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
      `SELECT s.id, s.owner_id, s.text, s.task_version, s.rubric_version, s.explanation_language, a.rubric_id, a.deleted_at
       FROM submissions s JOIN attempts a ON a.id = s.attempt_id
       WHERE s.id = $1`, [submissionId]));
    // Mirror the fixture's `complete`/`fail`: a submission whose attempt is tombstoned is
    // never (re)graded. The lease is left to expire so `reclaimExpired()` returns it; a
    // concurrent tombstone (`remove()`) has already cancelled the job and released the
    // reservation, so there is nothing here to undo.
    if (!row || row.deleted_at) return { claimed: true, submissionId, outcome: 'skipped', code: 'attempt_deleted' };

    /*
     * THE RUBRIC IS RESOLVED FROM THE ATTEMPT BEFORE THE GRADER IS INVOKED (EXAM-S0). A rubric this worker
     * does not know cannot produce a valid assessment, so grading it would only spend a provider call on a
     * result that must be refused. It is a preserved, unassessed failure: text kept, reservation refunded.
     */
    const rubric = rubricFor(row.rubric_id, row.rubric_version);
    if (rubric === undefined) return completeFailure({ submissionId, token, code: UNSUPPORTED_RUBRIC });

    let assessment;
    try {
      assessment = await gradeFn({
        submissionId,
        text: row.text,
        taskVersion: row.task_version,
        rubricId: row.rubric_id,
        rubricVersion: row.rubric_version,
        // SNAPSHOTTED at submit time (migration 0018), so the feedback does not change language later.
        explanationLanguage: row.explanation_language,
        ownerId: row.owner_id,
      });
      /*
       * THE SHAPE GATE, inside the same try so a bad shape is an ordinary job failure: a stable
       * `invalid_assessment` code, the reservation refunded, nothing written. Validating here rather than
       * in `completeSuccess` also means the refusal happens BEFORE the transaction that writes the row,
       * so there is no window in which a fabricated assessment exists.
       *
       * The rubric was resolved from the ATTEMPT above, before grading. The retired formative contract
       * still validates in its own one-comment shape, so an old attempt can be re-graded without being
       * relabelled into the current one.
       */
      validateAssessment(assessment, { rubric, text: row.text });
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
        'SELECT id, owner_id, exam_id, status, lease_token FROM jobs WHERE submission_id = $1 FOR UPDATE', [submissionId]));
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
      // EXAM-S1: the debit lands on the balance the job reserved from, never another exam's.
      await client.query(
        'UPDATE entitlements SET reserved = reserved - 1, used = used + 1 WHERE owner_id = $1 AND exam_id = $2',
        [job.owner_id, job.exam_id]);
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
        'SELECT id, owner_id, exam_id, status, lease_token FROM jobs WHERE submission_id = $1 FOR UPDATE', [submissionId]));
      if (!job || job.status !== 'running' || job.lease_token !== token) return { claimed: true, submissionId, outcome: 'stale' };
      await client.query(
        "UPDATE jobs SET status = 'failed', failure_code = $3, lease_token = NULL, lease_until = NULL WHERE id = $1 AND lease_token = $2 AND status = 'running'",
        [job.id, token, code]);
      await client.query('UPDATE entitlements SET reserved = reserved - 1 WHERE owner_id = $1 AND exam_id = $2',
        [job.owner_id, job.exam_id]);
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
        `SELECT id, owner_id, exam_id, tries FROM jobs
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
        // Group by (owner, exam) so each balance is refunded exactly its own abandoned count (EXAM-S1),
        // in a stable order so two reclaimers cannot lock balances in opposite orders.
        const byBalance = new Map();
        for (const r of abandon) {
          const key = JSON.stringify([r.owner_id, r.exam_id]);
          byBalance.set(key, (byBalance.get(key) || 0) + 1);
        }
        for (const key of [...byBalance.keys()].sort()) {
          const [ownerId, examId] = JSON.parse(key);
          await client.query('UPDATE entitlements SET reserved = reserved - $3 WHERE owner_id = $1 AND exam_id = $2',
            [ownerId, examId, byBalance.get(key)]);
        }
      }
      return { requeued: requeue.length, abandoned: abandon.length };
    });
  }

  return Object.freeze({ runOnce, reclaimExpired });
}

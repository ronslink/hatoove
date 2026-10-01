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
import { DEFAULT_TASK_BINDING } from './content-seed.mjs';

const UUID_RE = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const TEXT_LIMIT = 12000;

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
    /**
     * PILOT-04 — the servable task catalogue.
     *
     * WHY IT LIVES ON THIS PORT, and the compromise that is: tasks are SHARED CONTENT, not owned
     * records, so a separate `catalogue` port would be the tidier shape. It is here because this
     * port already holds the learner connection, which is exactly the role granted SELECT on the
     * content tables by `0006`, so no new wiring was needed to reach it. If a catalogue port is ever
     * split out, this method moves and the route does not change.
     *
     * THE POLICY IS AN ARGUMENT, NOT A QUERY PARAMETER. A learner must never be able to ask for
     * unreviewed content by editing a URL, so the caller passes what the DEPLOYMENT allows and the
     * request can only narrow the result (exam, family).
     *
     * `rights_status` IS RETURNED, NOT FILTERED ON. Every seeded row is `rights_status='unknown'`,
     * which is an open question for Ron (D1). Filtering on it here would silently serve nothing and
     * make the route look broken; carrying the field means the gate can be added later without a
     * schema change or a change to this signature.
     */
    async listTasks(owner, { examId = null, family = null, serveReview = 'approved+unreviewed' } = {}) {
      note('listTasks');
      // An explicit `approved` is the fail-closed value; anything else is the pilot policy.
      const statuses = serveReview === 'approved' ? ['approved'] : ['approved', 'unreviewed'];
      return settle(owner, async (client) => {
        const rows = (await client.query(
          `SELECT t.task_id, t.version, t.family, t.register, t.topic, t.situation, t.adressat,
                  t.leitpunkte, t.rubric_id, t.rubric_version, t.exam_id,
                  c.review_status, c.rights_status
             FROM task_version t
             JOIN content_version c ON c.content_version_id = t.content_version_id
            WHERE t.exam_id = COALESCE($1, t.exam_id)
              AND ($2::text IS NULL OR t.family = $2)
              AND c.review_status = ANY($3::text[])
            ORDER BY t.task_id, t.version`,
          [examId, family, statuses])).rows;
        return rows.map((row) => ({
          task_id: row.task_id,
          version: row.version,
          exam_id: row.exam_id,
          family: row.family,
          register: row.register,
          topic: row.topic,
          situation: row.situation,
          adressat: row.adressat,
          leitpunkte: row.leitpunkte,
          rubric_id: row.rubric_id,
          rubric_version: row.rubric_version,
          review_status: row.review_status,
          rights_status: row.rights_status,
        }));
      });
    },
    /**
     * OBJECTIVE-SEED-01 — the servable objective sets (reading and language elements).
     *
     * WHY THIS DOES NOT JOIN `objective_key`, and why that is a design property rather than a
     * convention: the answers sit INLINE in the authored source, so the only thing standing between a
     * learner and 180 answer keys is that this query does not ask for them AND the learner role is not
     * granted the table. The first is a promise; the second is enforced by PostgreSQL. If a future
     * edit adds the join, the query fails with a permission error rather than leaking — which is the
     * failure mode to want.
     *
     * WHY `media_required` SETS ARE EXCLUDED: the HV families carry `script`, the transcript of audio
     * that does not exist yet. Listing them would offer a learner a listening task with no audio,
     * which is a Hören task wearing a Hören label while actually being a Lesen task. They stay in the
     * database, marked, until there is something to hear.
     */
    async listObjectiveSets(owner, { examId = null, family = null, serveReview = 'approved+unreviewed' } = {}) {
      note('listObjectiveSets');
      const statuses = serveReview === 'approved' ? ['approved'] : ['approved', 'unreviewed'];
      return settle(owner, async (client) => {
        const rows = (await client.query(
          `SELECT s.set_id, s.version, s.exam_id, s.family, s.section, s.part, s.title,
                  s.payload, s.item_count, s.media_required,
                  c.review_status, c.rights_status
             FROM objective_set s
             JOIN content_version c ON c.content_version_id = s.content_version_id
            WHERE s.exam_id = COALESCE($1, s.exam_id)
              AND ($2::text IS NULL OR s.family = $2)
              AND c.review_status = ANY($3::text[])
              AND s.media_required = false
            ORDER BY s.family, s.part, s.set_id`,
          [examId, family, statuses])).rows;
        return rows.map((row) => ({
          set_id: row.set_id,
          version: row.version,
          exam_id: row.exam_id,
          family: row.family,
          section: row.section,
          part: row.part,
          title: row.title,
          payload: row.payload,
          item_count: row.item_count,
          media_required: row.media_required,
          review_status: row.review_status,
          rights_status: row.rights_status,
        }));
      });
    },
    /**
     * LIBRARY-SEED-01 — the B1 core vocabulary.
     *
     * There is no secret side to withhold here and no split to perform: unlike the objective corpus,
     * a lexicon holds no answers. A learner-facing dictionary is the entire content, which is why this
     * method returns every column of its table and the table has no sibling.
     *
     * `q` is a SEARCH, not a filter expression: it is matched with `ILIKE` against the German headword
     * and the English gloss and is bounded by `limit`, so a learner cannot ask the server to
     * materialise all 300 rows on every keystroke. The parameter is passed as a VALUE through the
     * driver, never interpolated into the SQL.
     */
    async listVocab(owner, { examId = null, pos = null, q = null, limit = 50, serveReview = 'approved+unreviewed' } = {}) {
      note('listVocab');
      // The lexicon's review status lives on its ONE provenance row, so the serving policy is
      // honoured by a join rather than by a column on every word. An explicit `approved` therefore
      // serves nothing, exactly as for the task and objective catalogues.
      const statuses = serveReview === 'approved' ? ['approved'] : ['approved', 'unreviewed'];
      return settle(owner, async (client) => {
        const rows = (await client.query(
          `SELECT v.entry_id, v.exam_id, v.de, v.en, v.pos, v.plural, v.example, v.example_en,
                  c.review_status, c.rights_status
             FROM vocab_entry v
             JOIN content_version c ON c.content_version_id = v.content_version_id
            WHERE v.exam_id = COALESCE($1, v.exam_id)
              AND ($2::text IS NULL OR v.pos = $2)
              AND ($3::text IS NULL OR v.de ILIKE '%' || $3 || '%' OR v.en ILIKE '%' || $3 || '%')
              AND c.review_status = ANY($4::text[])
            ORDER BY v.ordinal
            LIMIT $5`,
          [examId, pos, q, statuses, limit])).rows;
        return rows.map((row) => ({
          entry_id: row.entry_id,
          exam_id: row.exam_id,
          de: row.de,
          en: row.en,
          pos: row.pos,
          plural: row.plural,
          example: row.example,
          example_en: row.example_en,
          review_status: row.review_status,
          rights_status: row.rights_status,
        }));
      });
    },
    /**
     * LIBRARY-SEED-02 — the B1 noun lexicon (gender, plural, the rule that decides the gender, theme).
     *
     * A sibling of `listVocab`, not a generalisation of it: the two corpora are the same KIND of thing
     * and not the same SHAPE, and one query with five nullable columns plus a "which corpus is this"
     * condition would be harder to read and easier to get wrong than two honest queries.
     *
     * `gender` and `theme` are exact filters (a learner drills `die` nouns, or browses "Personen");
     * `q` is a bounded substring search. All three are passed as VALUES through the driver.
     */
    async listNouns(owner, { examId = null, theme = null, gender = null, q = null, limit = 50, serveReview = 'approved+unreviewed' } = {}) {
      note('listNouns');
      const statuses = serveReview === 'approved' ? ['approved'] : ['approved', 'unreviewed'];
      return settle(owner, async (client) => {
        const rows = (await client.query(
          `SELECT n.entry_id, n.exam_id, n.de, n.en, n.gender, n.plural, n.rule, n.rule_en, n.theme,
                  n.example, n.example_en, c.review_status, c.rights_status
             FROM noun_entry n
             JOIN content_version c ON c.content_version_id = n.content_version_id
            WHERE n.exam_id = COALESCE($1, n.exam_id)
              AND ($2::text IS NULL OR n.theme = $2)
              AND ($3::text IS NULL OR n.gender = $3)
              AND ($4::text IS NULL OR n.de ILIKE '%' || $4 || '%' OR n.en ILIKE '%' || $4 || '%')
              AND c.review_status = ANY($5::text[])
            ORDER BY n.ordinal
            LIMIT $6`,
          [examId, theme, gender, q, statuses, limit])).rows;
        return rows.map((row) => ({
          entry_id: row.entry_id,
          exam_id: row.exam_id,
          de: row.de,
          en: row.en,
          gender: row.gender,
          plural: row.plural,
          rule: row.rule,
          rule_en: row.rule_en,
          theme: row.theme,
          example: row.example,
          example_en: row.example_en,
          review_status: row.review_status,
          rights_status: row.rights_status,
        }));
      });
    },
    /**
     * Create an owned attempt bound to an exact task/rubric version (SAAS-MODEL-01 Step 1).
     * `binding` defaults to the canonical writing task (`content-seed.mjs`); a caller that has
     * a task-selection route (SAAS-RESUME-01) can pass the chosen one. The composite foreign
     * keys added by migration `0006` make the binding a real, checked reference — an unknown
     * task id/version fails here instead of silently storing an unreviewed claim.
     */
    async create(owner, parent = null, binding = DEFAULT_TASK_BINDING) {
      note('create');
      const b = binding || DEFAULT_TASK_BINDING;
      return settle(owner, async (client) => {
        if (parent) {
          const parentRow = first(await client.query(
            `SELECT a.id FROM submissions s JOIN attempts a ON a.id = s.attempt_id
             WHERE s.id = $1 AND s.owner_id = $2 AND a.deleted_at IS NULL FOR UPDATE OF a`, [parent, owner]));
          if (!parentRow) fail(404, 'not_found');
        }
        const id = randomUUID();
        await client.query(
          `INSERT INTO attempts(id, owner_id, task_id, task_version, rubric_id, rubric_version, parent_submission_id)
           VALUES($1, $2, $3, $4, $5, $6, $7)`,
          [id, owner, b.taskId, b.taskVersion, b.rubricId, b.rubricVersion, parent]);
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

/**
 * Every table that holds an account's rows, with the `WHERE` predicate that selects exactly
 * this account's rows for the pre-COMMIT read-back. Each entry is `[table, predicate, bind]`;
 * the predicate always binds one parameter (`$1`) whose value is `bind === 'attempts'` ? the
 * account's attempt ids : the verified owner.
 *
 * `drafts` is here because it holds account rows: it has no owner column and is owned through
 * `attempts`, so it is selected by the attempt ids rather than by the owner (see the port).
 */
export const ACCOUNT_TABLES = Object.freeze([
  ['attempts', 'owner_id = $1', 'owner'], ['submissions', 'owner_id = $1', 'owner'],
  ['jobs', 'owner_id = $1', 'owner'], ['assessments', 'owner_id = $1', 'owner'],
  ['usage_ledger', 'owner_id = $1', 'owner'], ['entitlements', 'owner_id = $1', 'owner'],
  ['learner_settings', 'user_id = $1', 'owner'], ['session', '"userId" = $1', 'owner'],
  ['account', '"userId" = $1', 'owner'], ['drafts', 'attempt_id = ANY($1::uuid[])', 'attempts'],
  ['"user"', 'id = $1', 'owner'],
].map((entry) => Object.freeze(entry)));

/**
 * Build the account-deletion port: `deleteAccount(owner) -> {existed, removed, verifiedAbsent}`.
 *
 * The whole deletion is ONE transaction, so a failure at any step leaves the account intact
 * rather than half-removed. Two locks are taken first, in the order the writer paths take them
 * (`submit`/`retry` lock `entitlements` first, then an attempt row):
 *   - `entitlements FOR UPDATE`, so an in-flight `submit()` cannot insert a submission after the
 *     earlier steps have run and make a later step fail on the now-orphaned reference;
 *   - `"user" FOR UPDATE`, so a concurrent sign-in or attempt insert that needs a key-share lock
 *     on the row waits, and then fails on the missing row instead of re-creating data.
 * Lock order is entitlements -> attempts on both sides, so this introduces no deadlock.
 *
 * Before COMMIT the transaction reads the account tables back (`ACCOUNT_TABLES`) and refuses
 * (rolls back) if any row of the owner is left, and reports `verifiedAbsent: true` when it
 * returns. This is defensive: in the current schema it cannot be the thing that prevents a
 * silent partial delete, because every owned table either cascades from `"user"` or has a
 * `NO ACTION` key that makes a later step fail first — the guarantee comes from the step order
 * and those foreign keys. It is kept because a future migration that adds an owned table with
 * no such backstop is exactly the case it is meant to catch, and `drafts` is listed so the
 * account's own draft rows are counted too.
 *
 * PRIVILEGES: this cannot run as the restricted learner role. A provisioned installation gets
 * the rights from migration `0005-account-deletion` (`server/owned-postgres/provisioning-sql.mjs`),
 * which grants a `<prefix>_deletion` role SELECT/DELETE on the account tables,
 * UPDATE(parent_submission_id) on `attempts`, the column UPDATE privileges the two `FOR UPDATE`
 * statements need, and an owner-scoped policy for each FORCE-RLS table. See
 * work/implementation/HARD-DELETE-01.md §6.
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
        // Same lock the writer paths take first, in the same order (F6).
        await client.query('SELECT 1 FROM entitlements WHERE owner_id = $1 FOR UPDATE', [owner]);
        // `drafts` is owned through `attempts`, and every attempt will be gone by the time the
        // read-back runs. Capture the ids now and pin them transaction-locally so the read-back
        // (and the drafts policy) can still recognise a draft this account owns.
        const attemptIds = (await client.query('SELECT id FROM attempts WHERE owner_id = $1', [owner]))
          .rows.map((row) => row.id);
        await client.query("SELECT set_config('hatoove.deleting_attempts', $1, true)", [attemptIds.join(',')]);
        const existed = (await client.query('SELECT id FROM "user" WHERE id = $1 FOR UPDATE', [owner])).rowCount > 0;
        const removed = {};
        for (const [index, [name, sql]] of ACCOUNT_DELETION_STEPS.entries()) {
          removed[name] = (await client.query(sql, [owner])).rowCount;
          if (hook) await hook(index + 1, name, client);
        }
        for (const [table, predicate, bind] of ACCOUNT_TABLES) {
          const params = bind === 'attempts' ? [attemptIds] : [owner];
          const left = first(await client.query(
            `SELECT count(*)::int AS n FROM ${table} WHERE ${predicate}`, params)).n;
          if (left !== 0) throw new Error(`account deletion left ${left} row(s) in ${table}`);
        }
        await client.query('COMMIT');
        // Only true because the read-back above ran and found nothing: it is the proof, while
        // `removed` is the delete statements' own counts and is not.
        return { existed, removed, verifiedAbsent: true };
      } catch (error) {
        try { await client.query('ROLLBACK'); } catch { /* preserve the original failure */ }
        throw error;
      } finally {
        client.release();
      }
    },
  });
}

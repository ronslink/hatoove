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
import { contentPolicy, servableReview } from '../content-policy.mjs';
import { createExamCatalogue, preparationDto } from '../preparation-contract.mjs';
import { preparationMethods, requireActivePreparation, resolvePreparation } from './preparations.mjs';

const UUID_RE = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const TEXT_LIMIT = 12000;
const OBJECTIVE_VERSION_RE = /^v[0-9]{1,4}$/;

const fail = (status, code) => { throw new Fault(status, code); };
const first = (result) => result.rows[0];
/** No default version (EXAM-S0): v1 and v2 of a set may share item ids with different keys. */
const requireObjectiveVersion = (version) => {
  if (typeof version !== 'string' || !OBJECTIVE_VERSION_RE.test(version)) fail(422, 'invalid_version');
  return version;
};

/** The export form of a preparation: the DTO plus how its legacy exam date was dispositioned. */
const preparationExport = (row) => ({
  ...preparationDto(row), legacy_exam_date_disposition: row.legacy_exam_date_disposition ?? null,
});

/** EXAM-S1: practice reads are scoped to one preparation; there is no all-preparations default. */
const requirePreparationContext = (preparationId) => {
  if (typeof preparationId !== 'string' || !UUID_RE.test(preparationId)) fail(422, 'preparation_required');
  return preparationId;
};

/**
 * Build the owned-attempts datastore port over a pg Pool.
 * @param {{pool: object, onCall?: (name: string) => void, examCatalogue?: object}} options
 *   `pool` must connect as the restricted learner role. `examCatalogue` is the server-side package
 *   allowlist (`createExamCatalogue`); only a disposable test passes another one.
 * @returns {object} the port `createOwnedApi({ datastore })` consumes.
 */
export function createPostgresDatastore({ pool, onCall, examCatalogue = createExamCatalogue() } = {}) {
  if (!pool || typeof pool.connect !== 'function') {
    throw new TypeError('createPostgresDatastore requires a pg Pool');
  }
  const note = typeof onCall === 'function' ? onCall : () => {};

  /**
   * One transaction with the verified owner bound locally to `hatoove.owner_id`.
   * The setting is transaction-local (`set_config(..., true)`), so returning a
   * pooled connection never leaks a previous owner's context.
   */
  async function settle(owner, work, snapshot = false) {
    const client = await pool.connect();
    try {
      await client.query(snapshot ? 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY' : 'BEGIN');
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

  const bindingOf = (row) => ({
    taskId: row.task_id, taskVersion: row.task_version, rubricId: row.rubric_id, rubricVersion: row.rubric_version,
  });

  // Every new use checks the task AND its declared rubric. Existing snapshots remain readable.
  // Returns the exam both belong to, so a caller can compare it with the preparation BEFORE writing.
  async function requireServableBinding(client, binding) {
    const policy = contentPolicy();
    const row = first(await client.query(
      `SELECT t.exam_id FROM task_version t
         JOIN content_version c ON c.content_version_id = t.content_version_id
         LEFT JOIN content_rights cr ON cr.content_version_id = c.content_version_id
         JOIN rubric_version r ON r.rubric_id = t.rubric_id AND r.version = t.rubric_version
         JOIN content_version rc ON rc.content_version_id = r.content_version_id
         LEFT JOIN content_rights rr ON rr.content_version_id = rc.content_version_id
        WHERE t.task_id = $1 AND t.version = $2 AND t.rubric_id = $3 AND t.rubric_version = $4
          AND r.exam_id = t.exam_id
          AND c.review_status = ANY($5::text[]) AND rc.review_status = ANY($5::text[])
          AND COALESCE(cr.basis, c.rights_status) = ANY($6::text[])
          AND COALESCE(rr.basis, rc.rights_status) = ANY($6::text[])`,
      [binding.taskId, binding.taskVersion, binding.rubricId, binding.rubricVersion, policy.review, policy.rights]));
    if (!row) fail(422, 'task_not_servable');
    return row.exam_id;
  }

  /**
   * The exam an attempt's credits live in, read WITHOUT a lock so the (owner, exam) balance can be locked
   * first — the writer paths' lock order is balance, then attempt. `exam_id` is not updatable by any
   * runtime role, so reading it before the lock cannot race a change.
   */
  async function attemptExam(client, owner, id) {
    const row = first(await client.query(
      'SELECT exam_id FROM attempts WHERE id = $1 AND owner_id = $2 AND deleted_at IS NULL', [id, owner]));
    if (!row) fail(404, 'not_found');
    return row.exam_id;
  }

  async function lockBalance(client, owner, examId) {
    return first(await client.query(
      'SELECT * FROM entitlements WHERE owner_id = $1 AND exam_id = $2 FOR UPDATE', [owner, examId]));
  }

  const preparations = preparationMethods({ settle, note, catalogue: examCatalogue });

  // Call only after proving ownership of an attempt. These immutable historical records are
  // deliberately readable when the current deployment no longer offers them for new practice.
  async function historicalContent(client, attempt) {
    const task = first(await client.query(
      `SELECT task_id, version, rubric_id, rubric_version, exam_id, family, register, topic,
              situation, adressat, leitpunkte FROM task_version WHERE task_id = $1 AND version = $2`,
      [attempt.task_id, attempt.task_version]));
    const rubric = first(await client.query(
      `SELECT r.rubric_id, r.version, r.criteria, r.max_total, r.family, r.exam_id,
              c.review_status, COALESCE(cr.basis, c.rights_status) AS rights_status,
              c.review_status <> 'approved' AS provisional
         FROM rubric_version r JOIN content_version c ON c.content_version_id = r.content_version_id
         LEFT JOIN content_rights cr ON cr.content_version_id = c.content_version_id
        WHERE r.rubric_id = $1 AND r.version = $2`, [attempt.rubric_id, attempt.rubric_version]));
    return { task: task ?? null, rubric: rubric ?? null };
  }

  return Object.freeze({
    // EXAM-S1: listExams, listPreparations, readPreparation, resolvePreparation, createPreparation,
    // updatePreparation, readCredits — see preparations.mjs.
    ...preparations,
    /**
     * PILOT-04 — the servable task catalogue.
     *
     * WHY IT LIVES ON THIS PORT, and the compromise that is: tasks are SHARED CONTENT, not owned
     * records, so a separate `catalogue` port would be the tidier shape. It is here because this
     * port already holds the learner connection, which is exactly the role granted SELECT on the
     * content tables by `0006`, so no new wiring was needed to reach it. If a catalogue port is ever
     * split out, this method moves and the route does not change.
     *
     * THE POLICY IS DEPLOYMENT CONFIGURATION, NOT AN OPTION. Every method re-derives its statuses from
     * `content-policy.mjs`; `serveReview: 'approved'` may narrow them and any other value is ignored, so
     * neither a URL nor an adapter option can widen what the deployment serves (EXAM-S0).
     *
     * `rights_status` IS NOW THE EFFECTIVE BASIS (D1 answered, 2 October 2026): the append-only decision in
     * `content_rights` when one exists, otherwise the row's own seed-time value — which for everything seeded
     * before that decision is `unknown`, and `unknown` FAILS CLOSED in the route's policy. The content rows stay
     * immutable, the decision is its own recorded row, and what a learner sees is what the deployment stands
     * behind. The FILTER lives in the route beside `serveReview` so the policy has one home rather than seven.
     */
    async listTasks(owner, { examId = null, family = null, serveReview = 'approved+unreviewed' } = {}) {
      note('listTasks');
      const statuses = servableReview(serveReview);
      return settle(owner, async (client) => {
        const rows = (await client.query(
          `SELECT t.task_id, t.version, t.family, t.register, t.topic, t.situation, t.adressat,
                  t.leitpunkte, t.rubric_id, t.rubric_version, t.exam_id, t.created_at,
                  c.review_status, COALESCE(cr.basis, c.rights_status) AS rights_status
             FROM task_version t
             JOIN content_version c ON c.content_version_id = t.content_version_id
                  LEFT JOIN content_rights cr ON cr.content_version_id = c.content_version_id
             -- The declared rubric must be servable too (EXAM-S0), or the card would offer a task that
             -- create() refuses. Same rule as requireServableBinding: task AND rubric.
             JOIN rubric_version r ON r.rubric_id = t.rubric_id AND r.version = t.rubric_version
             JOIN content_version rc ON rc.content_version_id = r.content_version_id
                  LEFT JOIN content_rights rr ON rr.content_version_id = rc.content_version_id
            WHERE t.exam_id = COALESCE($1, t.exam_id)
              AND ($2::text IS NULL OR t.family = $2)
              AND c.review_status = ANY($3::text[])
              AND COALESCE(cr.basis, c.rights_status) = ANY($4::text[])
              AND rc.review_status = ANY($3::text[])
              AND COALESCE(rr.basis, rc.rights_status) = ANY($4::text[])
            ORDER BY t.task_id, t.version`,
          [examId, family, statuses, contentPolicy().rights])).rows;
        return rows.map((row) => ({
          task_id: row.task_id,
          version: row.version,
          exam_id: row.exam_id,
          // The route picks the NEWEST version per task from these rows, so the timestamp has to travel.
          created_at: row.created_at,
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
     * WHY IT DOES NOT RETURN `payload`: this is the INDEX. It used to carry every set's authored
     * structure, which meant listing 15 titles shipped all fifteen full task texts to the browser.
     * A list needs titles and counts; `readObjectiveSet` fetches one set when a learner actually opens
     * it. The distinction is the same one the guide index makes for 64 KB of grammar.
     *
     * WHY `media_required` SETS ARE EXCLUDED: the HV families carry `script`, the transcript of audio
     * that does not exist yet. Listing them would offer a learner a listening task with no audio,
     * which is a Hören task wearing a Hören label while actually being a Lesen task. They stay in the
     * database, marked, until there is something to hear.
     */
    async listObjectiveSets(owner, { examId = null, family = null, group = null, part = null, serveReview = 'approved+unreviewed' } = {}) {
      note('listObjectiveSets');
      const statuses = servableReview(serveReview);
      return settle(owner, async (client) => {
        const rows = (await client.query(
          `SELECT s.set_id, s.version, s.exam_id, s.family, s.section, s.part, s.title,
                  s.item_count, s.media_required,
                  c.review_status, COALESCE(cr.basis, c.rights_status) AS rights_status
             FROM objective_set s
             JOIN content_version c ON c.content_version_id = s.content_version_id
                  LEFT JOIN content_rights cr ON cr.content_version_id = c.content_version_id
            WHERE s.exam_id = COALESCE($1, s.exam_id)
              AND ($2::text IS NULL OR s.family = $2)
              AND ($4::text IS NULL OR s.family LIKE $4 || '%')
              AND ($5::int IS NULL OR s.part = $5)
              AND c.review_status = ANY($3::text[])
              AND s.media_required = false
              AND COALESCE(cr.basis, c.rights_status) = ANY($6::text[])
            ORDER BY s.family, s.part, s.set_id`,
          [examId, family, statuses, group, part, contentPolicy().rights])).rows;
        return rows.map((row) => ({
          set_id: row.set_id,
          version: row.version,
          exam_id: row.exam_id,
          family: row.family,
          section: row.section,
          part: row.part,
          title: row.title,
          item_count: row.item_count,
          media_required: row.media_required,
          review_status: row.review_status,
          rights_status: row.rights_status,
        }));
      });
    },
    /**
     * One servable objective set, WITH its authored payload. `null` when it does not exist or the
     * deployment will not serve it — the route turns both into 404, so it is not an oracle for what
     * exists but is withheld.
     */
    async readObjectiveSet(owner, { setId, version, serveReview = 'approved+unreviewed' } = {}) {
      note('readObjectiveSet');
      requireObjectiveVersion(version);
      const statuses = servableReview(serveReview);
      const row = first(await settle(owner, async (client) => client.query(
        `SELECT s.set_id, s.version, s.exam_id, s.family, s.section, s.part, s.title, s.payload,
                s.item_count, s.media_required, c.review_status, COALESCE(cr.basis, c.rights_status) AS rights_status
           FROM objective_set s
           JOIN content_version c ON c.content_version_id = s.content_version_id
                  LEFT JOIN content_rights cr ON cr.content_version_id = c.content_version_id
          WHERE s.set_id = $1 AND s.version = $2
            AND c.review_status = ANY($3::text[])
            AND s.media_required = false
            AND s.exam_id = COALESCE($4, s.exam_id)
            AND COALESCE(cr.basis, c.rights_status) = ANY($5::text[])`,
        [setId, version, statuses, null, contentPolicy().rights])));
      if (!row) return null;
      return {
        set_id: row.set_id, version: row.version, exam_id: row.exam_id, family: row.family,
        section: row.section, part: row.part, title: row.title, payload: row.payload,
        item_count: row.item_count, media_required: row.media_required,
        review_status: row.review_status, rights_status: row.rights_status,
      };
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
      const statuses = servableReview(serveReview);
      return settle(owner, async (client) => {
        const rows = (await client.query(
          `SELECT v.entry_id, v.exam_id, v.de, v.en, v.pos, v.plural, v.example, v.example_en,
                  c.review_status, COALESCE(cr.basis, c.rights_status) AS rights_status
             FROM vocab_entry v
             JOIN content_version c ON c.content_version_id = v.content_version_id
                  LEFT JOIN content_rights cr ON cr.content_version_id = c.content_version_id
            WHERE v.exam_id = COALESCE($1, v.exam_id)
              AND ($2::text IS NULL OR v.pos = $2)
              AND ($3::text IS NULL OR v.de ILIKE '%' || $3 || '%' OR v.en ILIKE '%' || $3 || '%')
              AND c.review_status = ANY($4::text[])
              AND COALESCE(cr.basis, c.rights_status) = ANY($6::text[])
            ORDER BY v.ordinal
            LIMIT $5`,
          [examId, pos, q, statuses, limit, contentPolicy().rights])).rows;
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
      const statuses = servableReview(serveReview);
      return settle(owner, async (client) => {
        const rows = (await client.query(
          `SELECT n.entry_id, n.exam_id, n.de, n.en, n.gender, n.plural, n.rule, n.rule_en, n.theme,
                  n.example, n.example_en, c.review_status, COALESCE(cr.basis, c.rights_status) AS rights_status
             FROM noun_entry n
             JOIN content_version c ON c.content_version_id = n.content_version_id
                  LEFT JOIN content_rights cr ON cr.content_version_id = c.content_version_id
            WHERE n.exam_id = COALESCE($1, n.exam_id)
              AND ($2::text IS NULL OR n.theme = $2)
              AND ($3::text IS NULL OR n.gender = $3)
              AND ($4::text IS NULL OR n.de ILIKE '%' || $4 || '%' OR n.en ILIKE '%' || $4 || '%')
              AND c.review_status = ANY($5::text[])
              AND COALESCE(cr.basis, c.rights_status) = ANY($7::text[])
            ORDER BY n.ordinal
            LIMIT $6`,
          [examId, theme, gender, q, statuses, limit, contentPolicy().rights])).rows;
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
     * LIBRARY-SEED-03 — the reference guides, as an index and then one document.
     *
     * WHY TWO METHODS and not one that returns everything: `grammar-guide` alone is 64 KB across 14
     * topics. A learner opening the guide list should not download five documents to find out what is
     * in them. The index carries titles and section counts; `readGuide` fetches one guide's sections.
     */
    async listGuides(owner, { examId = null, serveReview = 'approved+unreviewed' } = {}) {
      note('listGuides');
      const statuses = servableReview(serveReview);
      return settle(owner, async (client) => {
        const rows = (await client.query(
          `SELECT g.guide_id, g.family, g.title, g.intro, g.section_count,
                  c.review_status, COALESCE(cr.basis, c.rights_status) AS rights_status
             FROM guide g
             JOIN content_version c ON c.content_version_id = g.content_version_id
                  LEFT JOIN content_rights cr ON cr.content_version_id = c.content_version_id
            WHERE g.exam_id = COALESCE($1, g.exam_id)
              AND c.review_status = ANY($2::text[])
              AND COALESCE(cr.basis, c.rights_status) = ANY($3::text[])
            ORDER BY g.guide_id`,
          [examId, statuses, contentPolicy().rights])).rows;
        return rows.map((row) => ({
          guide_id: row.guide_id,
          family: row.family,
          title: row.title,
          intro: row.intro,
          section_count: row.section_count,
          review_status: row.review_status,
          rights_status: row.rights_status,
        }));
      });
    },
    /**
     * One guide with its sections, or `null` when it does not exist OR is not servable.
     *
     * Returning `null` rather than an empty section list is deliberate: an empty array cannot
     * distinguish "this guide has no sections" from "no such guide", and the route turns those into
     * answers a learner can act on — 404 versus 200 with an empty list — only if the difference
     * survives this far.
     */
    /**
     * One rubric, by id AND version.
     *
     * The version is required rather than defaulted: a result is only meaningful against the version it was
     * graded under, and an installation may hold several. Both rubrics stay readable indefinitely — the
     * retired four-criterion one included — so an old attempt's feedback can explain itself against the
     * contract it was actually graded under. Nothing is renormalised or relabelled.
     *
     * `provisional` is derived from the CONTENT's review status rather than stored as a flag of its own:
     * `review_status = 'unreviewed'` is the fact (nothing has been reviewed), and a second boolean would be a
     * second source of truth for the same claim, free to disagree with it.
     */
    async readRubric(owner, { rubricId, version, serveReview = 'approved+unreviewed' } = {}) {
      note('readRubric');
      const statuses = servableReview(serveReview);
      return settle(owner, async (client) => {
        const row = first(await client.query(
          `SELECT r.rubric_id, r.version, r.family, r.criteria, r.max_total, r.exam_id,
                  c.review_status, COALESCE(cr.basis, c.rights_status) AS rights_status
             FROM rubric_version r
             JOIN content_version c ON c.content_version_id = r.content_version_id
                  LEFT JOIN content_rights cr ON cr.content_version_id = c.content_version_id
            WHERE r.rubric_id = $1 AND r.version = $2 AND c.review_status = ANY($3::text[])
              AND COALESCE(cr.basis, c.rights_status) = ANY($4::text[])`,
          [rubricId, version, statuses, contentPolicy().rights]));
        if (!row) return null;
        return {
          rubric_id: row.rubric_id,
          version: row.version,
          family: row.family,
          exam_id: row.exam_id,
          max_total: Number(row.max_total),
          criteria: row.criteria,
          review_status: row.review_status,
          rights_status: row.rights_status,
          provisional: row.review_status !== 'approved',
        };
      });
    },

    async readGuide(owner, { guideId, serveReview = 'approved+unreviewed' } = {}) {      note('readGuide');
      const statuses = servableReview(serveReview);
      return settle(owner, async (client) => {
        const head = (await client.query(
          `SELECT g.guide_id, g.family, g.title, g.intro, g.intro_en, g.watch_out, g.watch_out_en,
                  g.section_count, c.review_status, COALESCE(cr.basis, c.rights_status) AS rights_status
             FROM guide g
             JOIN content_version c ON c.content_version_id = g.content_version_id
                  LEFT JOIN content_rights cr ON cr.content_version_id = c.content_version_id
            WHERE g.guide_id = $1 AND c.review_status = ANY($2::text[])
              AND COALESCE(cr.basis, c.rights_status) = ANY($3::text[])`,
          [guideId, statuses, contentPolicy().rights])).rows[0];
        if (!head) return null;
        const sections = (await client.query(
          `SELECT section_id, ordinal, kind, title, title_en, summary, summary_en, payload
             FROM guide_section
            WHERE guide_id = $1
            ORDER BY ordinal`,
          [guideId])).rows;
        return {
          guide_id: head.guide_id,
          family: head.family,
          title: head.title,
          intro: head.intro,
          intro_en: head.intro_en,
          watch_out: head.watch_out,
          watch_out_en: head.watch_out_en,
          section_count: head.section_count,
          review_status: head.review_status,
          rights_status: head.rights_status,
          sections: sections.map((row) => ({
            section_id: row.section_id,
            ordinal: row.ordinal,
            kind: row.kind,
            title: row.title,
            title_en: row.title_en,
            summary: row.summary,
            summary_en: row.summary_en,
            payload: row.payload,
          })),
        };
      });
    },
    /**
     * PILOT-22 — record one answered objective item, marked server-side.
     *
     * MARKING IS NOT DONE HERE, and deliberately: this connection is the LEARNER role, which is NOT
     * granted `objective_key`. The comparison happens inside `mark_objective_item`, a SECURITY DEFINER
     * function that reads the key as its owner and returns ONE BOOLEAN. Granting this role SELECT on
     * the key to make marking possible would have undone the isolation the objective seed exists for.
     *
     * Evidence is APPEND-ONLY. Answering again adds a row; it does not rewrite the last one, because
     * this table is the raw signal adaptive selection reads and a mutable score would be a claim
     * rather than a record.
     */
    async answerObjectiveItem(owner, { preparationId, setId, version, itemId, answer, latencyMs = null } = {}) {
      note('answerObjectiveItem');
      requireObjectiveVersion(version);
      requirePreparationContext(preparationId);
      const statuses = servableReview();
      return settle(owner, async (client) => {
        // EXAM-S1: owned (404) and active (409) before anything else; exam match (422) before marking.
        const prep = await requireActivePreparation(client, owner, preparationId);
        // The set must be one the deployment serves, and this also yields the exam/section the
        // evidence is attributed to. A set that is withheld or absent is 404, not a silent record.
        const set = first(await client.query(
          `SELECT s.exam_id, s.family, s.section, s.version
             FROM objective_set s
             JOIN content_version c ON c.content_version_id = s.content_version_id
                  LEFT JOIN content_rights cr ON cr.content_version_id = c.content_version_id
            WHERE s.set_id = $1 AND s.version = $2 AND c.review_status = ANY($3::text[])
              AND s.media_required = false
              AND COALESCE(cr.basis, c.rights_status) = ANY($4::text[])`,
          [setId, version, statuses, contentPolicy().rights]));
        if (!set) fail(404, 'not_found');
        if (set.exam_id !== prep.exam_id) fail(422, 'preparation_mismatch');

        let marked;
        try {
          marked = first(await client.query(
            'SELECT mark_objective_item($1, $2, $3, $4::jsonb) AS correct',
            [setId, version, itemId, JSON.stringify(answer)]));
        } catch (error) {
          // The function raises `unknown_item` rather than returning false, so a bad item id cannot
          // be recorded as "the learner got it wrong".
          if (/unknown_item/.test(error && error.message)) fail(422, 'unknown_item');
          throw error;
        }

        const evidenceId = randomUUID();
        await client.query(
          `INSERT INTO item_evidence
             (evidence_id, owner_id, exam_id, set_id, version, item_id, family, section, answer, correct, latency_ms, preparation_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $12)`,
          [evidenceId, owner, set.exam_id, setId, version, itemId, set.family, set.section,
            JSON.stringify(answer), marked.correct, latencyMs, prep.id]);
        return { evidence_id: evidenceId, item_id: itemId, correct: marked.correct, preparation_id: prep.id, exam_id: prep.exam_id };
      });
    },
    /**
     * PILOT-22b — what should this learner practise next, chosen by RULES over recorded evidence.
     *
     * ## Why the rules are here and not in a model call
     *
     * AI selection is unrepeatable (the same learner, asked twice, gets a different plan),
     * unauditable (nobody can say why), costs tokens on every request, and cannot be explained to the
     * learner. A deterministic choice over `item_evidence` can be — and the response carries the
     * EVIDENCE FOR ITS OWN CLAIM, so the learner is told "LV, 2 of 5 correct", not handed an item with
     * no reason. That is the difference between an adaptive product and an unpredictable one.
     *
     * ## The ordering, and why it is total
     *
     * Sections are ranked by: unstarted first (breadth before depth), then weakest accuracy, then
     * fewest attempts, then section name. Every tie is broken, so the same evidence always yields the
     * same choice — a plan that changes between two identical requests is a bug, not personalisation.
     *
     * Within the chosen section, sets are ordered by how much evidence they already have, so an
     * unattempted set is preferred and a started one is returned only when the section is exhausted.
     */
    async nextPractice(owner, { preparationId, serveReview = 'approved+unreviewed' } = {}) {
      note('nextPractice');
      const statuses = servableReview(serveReview);
      requirePreparationContext(preparationId);
      // The preparation decides the exam; evidence is counted for this preparation only.
      const { exam_id: examId } = await settle(owner, (client) => resolvePreparation(client, owner, preparationId));

      const sections = (await settle(owner, async (client) => (await client.query(
        `SELECT s.section, min(s.family) AS family
           FROM objective_set s
           JOIN content_version c ON c.content_version_id = s.content_version_id
                  LEFT JOIN content_rights cr ON cr.content_version_id = c.content_version_id
          WHERE s.media_required = false
            AND s.exam_id = $1
            AND c.review_status = ANY($2::text[])
            AND COALESCE(cr.basis, c.rights_status) = ANY($3::text[])
          GROUP BY s.section`,
        [examId, statuses, contentPolicy().rights])).rows));

      if (!sections.length) return null;

      const stats = await settle(owner, async (client) => (await client.query(
        `SELECT section, count(*)::int AS attempts, count(*) FILTER (WHERE correct)::int AS correct
           FROM item_evidence
          WHERE owner_id = $1 AND preparation_id = $2
          GROUP BY section`,
        [owner, preparationId])).rows);
      const bySection = new Map(stats.map((row) => [row.section, row]));

      const ranked = sections.map((section) => {
        const seen = bySection.get(section.section);
        const attempts = seen ? seen.attempts : 0;
        return {
          section: section.section,
          family: section.family,
          attempts,
          correct: seen ? seen.correct : 0,
          // `null` means NOT STARTED, which is not the same as 0% and must not be sorted as if it
          // were: a learner who has never seen a section has no accuracy, not a bad one.
          accuracy: attempts ? (seen.correct / attempts) : null,
        };
      }).sort((a, b) => {
        const av = a.accuracy === null ? -1 : a.accuracy;
        const bv = b.accuracy === null ? -1 : b.accuracy;
        if (av !== bv) return av - bv;
        if (a.attempts !== b.attempts) return a.attempts - b.attempts;
        return a.section < b.section ? -1 : (a.section > b.section ? 1 : 0);
      });

      const chosen = ranked[0];
      // `first()` reads a query RESULT (`result.rows[0]`) and is deliberately unguarded, so the
      // callback must return the RESULT and not the row. Handing it `rows[0]` made `first` evaluate
      // `row.rows[0]` on a plain object and throw, which surfaced as a 500 on this route -- a failure
      // that looked like "the selector is broken" and was a misuse of a helper.
      // `seen` is per exact (set, version): evidence for v1 says nothing about what v2 asks.
      const set = first(await settle(owner, async (client) => client.query(
        `SELECT s.set_id, s.version, s.title, s.family, s.section, s.part, s.item_count,
                (SELECT count(*)::int FROM item_evidence e
                  WHERE e.owner_id = $3 AND e.preparation_id = $6
                    AND e.set_id = s.set_id AND e.version = s.version) AS seen
           FROM objective_set s
           JOIN content_version c ON c.content_version_id = s.content_version_id
                  LEFT JOIN content_rights cr ON cr.content_version_id = c.content_version_id
          WHERE s.section = $1
            AND s.media_required = false
            AND s.exam_id = $4
            AND c.review_status = ANY($2::text[])
            AND COALESCE(cr.basis, c.rights_status) = ANY($5::text[])
          ORDER BY seen, s.part, s.set_id, s.version
          LIMIT 1`,
        [chosen.section, statuses, owner, examId, contentPolicy().rights, preparationId])));

      if (!set) return null;
      return {
        preparation_id: preparationId,
        exam_id: examId,
        reason: chosen.attempts === 0 ? 'section_not_started' : 'weakest_section',
        section: chosen.section,
        family: chosen.family,
        // The evidence for the claim, so the client can say WHY rather than just handing over an item.
        evidence: { attempts: chosen.attempts, correct: chosen.correct, accuracy: chosen.accuracy },
        set: {
          set_id: set.set_id, version: set.version, title: set.title, family: set.family,
          section: set.section, part: set.part, item_count: set.item_count, seen_items: set.seen,
        },
      };
    },
    /**
     * PILOT-22c — the learner's own practice evidence, aggregated by section.
     *
     * THIS RETURNS COUNTS, NOT A SCORE, and that is a product decision rather than a missing feature.
     * The supplied design's dashboard shows "Written estimate 152 / 225", a "Range 142–162" and a
     * "pass line 135". AGENTS.md and MASTER-PLAN forbid exactly that: provisional formative feedback,
     * NOT calibrated readiness scores, and no pass prediction. So this exposes what is TRUE — how many
     * items were answered, how many were right, per section — and the dashboard renders that.
     *
     * `accuracy` is `null` for a section with no attempts, not 0: never-seen is not the same as failed.
     */
    async practiceProgress(owner, { preparationId } = {}) {
      note('practiceProgress');
      requirePreparationContext(preparationId);
      const rows = await settle(owner, async (client) => {
        await resolvePreparation(client, owner, preparationId);
        return (await client.query(
          `SELECT e.section,
                  count(*)::int AS attempts,
                  count(*) FILTER (WHERE e.correct)::int AS correct
             FROM item_evidence e
            WHERE e.owner_id = $1 AND e.preparation_id = $2
            GROUP BY e.section
            ORDER BY e.section`,
          [owner, preparationId])).rows;
      });
      const totals = rows.reduce(
        (acc, row) => ({ attempts: acc.attempts + row.attempts, correct: acc.correct + row.correct }),
        { attempts: 0, correct: 0 });
      return {
        totals: {
          attempts: totals.attempts,
          correct: totals.correct,
          accuracy: totals.attempts ? totals.correct / totals.attempts : null,
          sections: rows.length,
        },
        sections: rows.map((row) => ({
          section: row.section,
          attempts: row.attempts,
          correct: row.correct,
          accuracy: row.attempts ? row.correct / row.attempts : null,
        })),
      };
    },
    /**
     * PILOT-22d — the items this learner is currently getting wrong.
     *
     * THE DEFINITION IS "THE MOST RECENT ANSWER WAS WRONG", not "was ever wrong". A mistake therefore
     * CLEARS ITSELF the moment the learner gets that item right, without a separate "mark as learned"
     * action and without a scheduler deciding when they have earned it. That is a plain fact about
     * their own record rather than a spaced-repetition claim.
     *
     * IT DOES NOT RETURN THE CORRECT ANSWER, and it must not: `objective_key` is not readable by this
     * role at all, and a mistakes list that revealed the key would hand over exactly what the practice
     * loop withholds. What comes back is what the LEARNER answered, so they can try again.
     */
    async listMistakes(owner, { preparationId, limit = 50 } = {}) {
      note('listMistakes');
      requirePreparationContext(preparationId);
      return settle(owner, async (client) => {
        await resolvePreparation(client, owner, preparationId);
        const rows = (await client.query(
          // Latest per exact (set, version, item): a correct v2 answer does not clear a wrong v1 one,
          // because the two versions may ask different questions under the same item id. Ties on the
          // timestamp are broken by the evidence id, and the final order is total, so the list is stable.
          `WITH latest AS (
             SELECT DISTINCT ON (e.set_id, e.version, e.item_id)
                    e.set_id, e.version, e.item_id, e.family, e.section, e.answer, e.correct, e.answered_at
               FROM item_evidence e
              WHERE e.owner_id = $1 AND e.preparation_id = $2
              ORDER BY e.set_id, e.version, e.item_id, e.answered_at DESC, e.evidence_id DESC
           )
           SELECT l.set_id, l.version, l.item_id, l.family, l.section, l.answer, l.answered_at,
                  s.title, s.item_count
             FROM latest l
             JOIN objective_set s ON s.set_id = l.set_id AND s.version = l.version
            WHERE l.correct = false
            ORDER BY l.answered_at DESC, l.set_id, l.version, l.item_id
            LIMIT $3`,
          [owner, preparationId, limit])).rows;
        return {
          preparation_id: preparationId,
          count: rows.length,
          items: rows.map((row) => ({
            set_id: row.set_id,
            version: row.version,
            set_title: row.title,
            item_id: row.item_id,
            family: row.family,
            section: row.section,
            set_item_count: row.item_count,
            // What the learner answered -- NOT what the key says.
            your_answer: row.answer,
            answered_at: row.answered_at,
          })),
        };
      });
    },
    /**
     * Create an owned attempt bound to an exact task/rubric version (SAAS-MODEL-01 Step 1).
     * `binding` defaults to the canonical writing task (`content-seed.mjs`); a caller that has
     * a task-selection route (SAAS-RESUME-01) can pass the chosen one. The composite foreign
     * keys added by migration `0006` make the binding a real, checked reference — an unknown
     * task id/version fails here instead of silently storing an unreviewed claim.
     */
    /**
     * EXAM-S1: a NEW attempt needs `preparationId`; a REVISION inherits its parent's exact preparation and
     * exam, and an explicitly different `preparationId` is refused. Ownership (404), state (409) and the
     * exam of the selected task/rubric (422 `preparation_mismatch`) are all checked before the INSERT, and
     * migration 0023's composite keys refuse the same mismatch in SQL.
     */
    async create(owner, parent = null, binding = null, preparationId = null) {
      note('create');
      return settle(owner, async (client) => {
        let b = binding || DEFAULT_TASK_BINDING;
        let text = '';
        let prepId = preparationId;
        if (parent) {
          const parentRow = first(await client.query(
            `SELECT a.task_id, s.task_version, a.rubric_id, s.rubric_version, s.text, a.preparation_id
               FROM submissions s JOIN attempts a ON a.id = s.attempt_id
              WHERE s.id = $1 AND s.owner_id = $2 AND a.owner_id = $2
                AND a.deleted_at IS NULL FOR UPDATE OF a`, [parent, owner]));
          if (!parentRow) fail(404, 'not_found');
          const inherited = bindingOf(parentRow);
          if (binding && Object.keys(inherited).some((key) => binding[key] !== inherited[key])) fail(422, 'parent_binding_mismatch');
          if (!parentRow.preparation_id) fail(422, 'preparation_unresolved');
          if (preparationId && preparationId !== parentRow.preparation_id) fail(422, 'preparation_mismatch');
          prepId = parentRow.preparation_id;
          b = inherited;
          text = parentRow.text;
        }
        requirePreparationContext(prepId);
        const prep = await requireActivePreparation(client, owner, prepId);
        const contentExam = await requireServableBinding(client, b);
        if (contentExam !== prep.exam_id) fail(422, 'preparation_mismatch');
        const id = randomUUID();
        await client.query(
          `INSERT INTO attempts(id, owner_id, task_id, task_version, rubric_id, rubric_version, parent_submission_id,
                                preparation_id, exam_id)
           VALUES($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [id, owner, b.taskId, b.taskVersion, b.rubricId, b.rubricVersion, parent, prep.id, prep.exam_id]);
        await client.query('INSERT INTO drafts(attempt_id, revision, text) VALUES($1, 1, $2)', [id, text]);
        return { id, revision: 1, text, task_id: b.taskId, task_version: b.taskVersion,
          rubric_id: b.rubricId, rubric_version: b.rubricVersion, parent_submission_id: parent,
          preparation_id: prep.id, exam_id: prep.exam_id };
      });
    },

    async read(owner, id) {
      note('read');
      return settle(owner, async (client) => {
        const attempt = await owned(client, owner, id);
        return { ...attempt, ...(await draftOf(client, id)), ...await historicalContent(client, attempt) };
      });
    },

    async listAttempts(owner, { preparationId } = {}) {
      note('listAttempts');
      requirePreparationContext(preparationId);
      return settle(owner, async (client) => {
        await resolvePreparation(client, owner, preparationId);
        return (await client.query(
        `SELECT a.id, a.task_id, a.task_version, a.rubric_id, a.rubric_version, a.preparation_id, a.exam_id,
                a.parent_submission_id, d.revision, a.created_at, t.topic, s.id AS submission_id,
                CASE WHEN s.id IS NULL THEN 'draft'
                     WHEN f.submission_id IS NOT NULL THEN 'assessed'
                     WHEN j.status IN ('failed', 'cancelled') THEN 'unassessed'
                     ELSE 'pending' END AS status
           FROM attempts a JOIN drafts d ON d.attempt_id = a.id
           JOIN task_version t ON t.task_id = a.task_id AND t.version = a.task_version
           LEFT JOIN submissions s ON s.attempt_id = a.id AND s.owner_id = a.owner_id
           LEFT JOIN jobs j ON j.submission_id = s.id AND j.owner_id = a.owner_id
           LEFT JOIN assessments f ON f.submission_id = s.id AND f.owner_id = a.owner_id
          WHERE a.owner_id = $1 AND a.preparation_id = $2 AND a.deleted_at IS NULL
          ORDER BY a.created_at DESC, a.id DESC`, [owner, preparationId])).rows;
      });
    },

    /**
     * Learner data only, selected explicitly: no auth tables, tokens, hashes or worker leases.
     *
     * `attempts` lists live attempts with their drafts. `submissions` and `results` list EVERY
     * retained submission of the owner, including those of attempts tombstoned under the retired
     * delete-anything behaviour: that data is still held, so it must not vanish from the export.
     * Each row carries `attempt_deleted_at` (null while the attempt is live) so a tombstoned
     * one is explicit rather than silently mixed in.
     */
    async exportData(owner) {
      note('exportData');
      return settle(owner, async (client) => {
        // EXAM-S1: every preparation (archived included) and every exam balance, and the context of
        // each record. Unresolved legacy records carry null context rather than a guessed one.
        const preparations = (await client.query(
          `SELECT p.id, p.exam_id, x.exam, x.exam_language, p.exam_date, p.state, p.revision,
                  p.legacy_exam_date_disposition, p.created_at, p.updated_at
             FROM learner_preparation p JOIN exam_package x ON x.exam_id = p.exam_id
            WHERE p.owner_id = $1 ORDER BY p.created_at, p.id`, [owner])).rows
          .map((row) => ({ ...preparationExport(row) }));
        const balances = (await client.query(
          `SELECT exam_id, allowance, used, reserved FROM entitlements
            WHERE owner_id = $1 ORDER BY exam_id`, [owner])).rows;
        const attempts = (await client.query(
          `SELECT a.id, a.task_id, a.task_version, a.rubric_id, a.rubric_version, a.preparation_id, a.exam_id,
                  a.parent_submission_id, a.created_at, d.revision, d.text
             FROM attempts a JOIN drafts d ON d.attempt_id = a.id
            WHERE a.owner_id = $1 AND a.deleted_at IS NULL ORDER BY a.created_at, a.id`, [owner])).rows;
        const submissions = (await client.query(
          `SELECT s.id, s.attempt_id, s.draft_revision, s.text, a.task_id, s.task_version,
                  a.rubric_id, s.rubric_version, s.explanation_language, s.created_at,
                  a.preparation_id, a.exam_id,
                  a.deleted_at AS attempt_deleted_at
             FROM submissions s JOIN attempts a ON a.id = s.attempt_id AND a.owner_id = s.owner_id
            WHERE s.owner_id = $1 ORDER BY s.created_at, s.id`, [owner])).rows;
        const results = (await client.query(
          `SELECT s.id AS submission_id, j.status, j.failure_code, j.tries, j.exam_id AS credit_exam_id,
                  f.feedback, f.model_version, f.prompt_version, f.rubric_version,
                  a.preparation_id, a.exam_id,
                  a.deleted_at AS attempt_deleted_at
             FROM submissions s JOIN attempts a ON a.id = s.attempt_id AND a.owner_id = s.owner_id
             LEFT JOIN jobs j ON j.submission_id = s.id AND j.owner_id = s.owner_id
             LEFT JOIN assessments f ON f.submission_id = s.id AND f.owner_id = s.owner_id
            WHERE s.owner_id = $1 ORDER BY s.created_at, s.id`, [owner])).rows;
        const objective_evidence = (await client.query(
          `SELECT evidence_id, exam_id, preparation_id, set_id, version, item_id, family, section, answer,
                  correct, latency_ms, answered_at FROM item_evidence
            WHERE owner_id = $1 ORDER BY answered_at, evidence_id`, [owner])).rows;
        return { preparations, balances, attempts, submissions, results, objective_evidence };
      }, true);
    },

    /**
     * The learner's UNFINISHED attempts, newest first — what a reload needs to offer "continue" instead of
     * a blank page.
     *
     * "Open" means exactly two things, and both matter: no submission exists for it (a submitted letter is
     * a frozen snapshot, and resuming it as a draft would let a learner edit what was marked), and it is
     * not deleted (a tombstone is not a draft). RLS scopes the rows to the owner, and the join to
     * `drafts` is the revision the client must save against.
     *
     * NO TEXT IS SELECTED. The client reads the one attempt it resumes through `read`; a list route that
     * returned letters would put a learner's writing in every response of a poll.
     */
    async listOpenAttempts(owner, { preparationId } = {}) {
      note('listOpenAttempts');
      requirePreparationContext(preparationId);
      return settle(owner, async (client) => {
        await resolvePreparation(client, owner, preparationId);
        const rows = (await client.query(
          `SELECT a.id, a.task_id, a.task_version, a.rubric_id, a.rubric_version, a.preparation_id, a.exam_id,
                  d.revision, a.created_at
             FROM attempts a
             JOIN drafts d ON d.attempt_id = a.id
            WHERE a.owner_id = $1
              AND a.preparation_id = $2
              AND a.deleted_at IS NULL
              AND NOT EXISTS (SELECT 1 FROM submissions s WHERE s.attempt_id = a.id)
            ORDER BY a.created_at DESC, a.id DESC`,
          [owner, preparationId])).rows;
        return rows.map((row) => ({
          id: row.id,
          preparation_id: row.preparation_id,
          exam_id: row.exam_id,
          task_id: row.task_id,
          task_version: row.task_version,
          rubric_id: row.rubric_id,
          rubric_version: row.rubric_version,
          revision: Number(row.revision),
          created_at: row.created_at,
        }));
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

    async submit(owner, id, expectedRevision, eventId, explanationLanguage = 'de') {
      note('submit');
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1 ||
          typeof eventId !== 'string' || !UUID_RE.test(eventId)) fail(422, 'invalid_submission');
      return settle(owner, async (client) => {
        // Serialize the attempt's EXAM balance before locking the attempt (EXAM-S1). Owner-wide
        // event uniqueness also covers concurrent submissions against independently locked exams.
        const examId = await attemptExam(client, owner, id);
        const entitlement = examId ? await lockBalance(client, owner, examId) : null;
        const attempt = await owned(client, owner, id);
        const prior = first(await client.query(
          'SELECT * FROM submissions WHERE owner_id = $1 AND event_id = $2', [owner, eventId]));
        if (prior) {
          if (prior.attempt_id !== attempt.id || prior.draft_revision !== expectedRevision) fail(409, 'idempotency_conflict');
          return { submissionId: prior.id, replay: true };
        }
        // An unresolved legacy attempt stays readable, but cannot spend a credit of a guessed exam.
        if (!attempt.preparation_id || !attempt.exam_id) fail(422, 'preparation_unresolved');
        await requireActivePreparation(client, owner, attempt.preparation_id);
        await requireServableBinding(client, bindingOf(attempt));
        const draft = await draftOf(client, id);
        if (!draft || draft.revision !== expectedRevision) fail(409, 'draft_conflict');
        if (!draft.text.trim()) fail(422, 'empty_submission');
        if (first(await client.query('SELECT id FROM submissions WHERE attempt_id = $1', [id]))) fail(409, 'already_submitted');
        if (!entitlement || entitlement.used + entitlement.reserved >= entitlement.allowance) fail(409, 'allowance_exhausted');
        const submissionId = randomUUID();
        try {
          await client.query(
            `INSERT INTO submissions(id, attempt_id, owner_id, event_id, draft_revision, text, task_version, rubric_version, explanation_language)
             VALUES($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
            [submissionId, id, owner, eventId, draft.revision, draft.text, attempt.task_version, attempt.rubric_version,
              // SNAPSHOTTED, not looked up later: the language the letter was written under travels with it.
              typeof explanationLanguage === 'string' && explanationLanguage.length <= 16 && explanationLanguage !== ''
                ? explanationLanguage : 'de']);
        } catch (error) {
          // Another exam may commit this owner's event after the prior lookup. Translate only that
          // exact uniqueness violation; settle() rolls back before any job or reservation is written.
          if (error.code === '23505' && error.table === 'submissions' && error.constraint === 'submissions_owner_id_event_id_key') {
            fail(409, 'idempotency_conflict');
          }
          throw error;
        }
        await client.query(
          "INSERT INTO jobs(id, submission_id, owner_id, status, exam_id) VALUES($1, $2, $3, 'queued', $4)",
          [randomUUID(), submissionId, owner, attempt.exam_id]);
        await client.query('UPDATE entitlements SET reserved = reserved + 1 WHERE owner_id = $1 AND exam_id = $2',
          [owner, attempt.exam_id]);
        return { submissionId, replay: false };
      });
    },

    async result(owner, submissionId) {
      note('result');
      return settle(owner, async (client) => {
        const submission = first(await client.query(
          'SELECT * FROM submissions WHERE id = $1 AND owner_id = $2', [submissionId, owner]));
        if (!submission) fail(404, 'not_found');
        const attempt = await owned(client, owner, submission.attempt_id);
        const job = first(await client.query(
          'SELECT status, failure_code, tries FROM jobs WHERE submission_id = $1', [submissionId]));
        const assessment = first(await client.query(
          'SELECT feedback, model_version, prompt_version, rubric_version FROM assessments WHERE submission_id = $1', [submissionId]));
        return { submission, job, assessment: assessment ?? null,
          task_id: attempt.task_id, task_version: submission.task_version,
          rubric_id: attempt.rubric_id, rubric_version: submission.rubric_version,
          parent_submission_id: attempt.parent_submission_id,
          preparation_id: attempt.preparation_id ?? null, exam_id: attempt.exam_id ?? null,
          ...await historicalContent(client, attempt) };
      });
    },

    /**
     * Retry settles against the balance the job ORIGINALLY reserved from (`jobs.exam_id`), so a failed
     * job is never re-charged to another exam. Allowed in an archived preparation: finishing pending work
     * is not new practice.
     */
    async retry(owner, submissionId) {
      note('retry');
      return settle(owner, async (client) => {
        const credit = first(await client.query(
          `SELECT j.exam_id FROM jobs j JOIN submissions s ON s.id = j.submission_id
            WHERE j.submission_id = $1 AND s.owner_id = $2`, [submissionId, owner]));
        if (!credit) fail(404, 'not_found');
        const entitlement = await lockBalance(client, owner, credit.exam_id);
        const submission = first(await client.query(
          'SELECT * FROM submissions WHERE id = $1 AND owner_id = $2', [submissionId, owner]));
        if (!submission) fail(404, 'not_found');
        const attempt = await owned(client, owner, submission.attempt_id);
        const job = first(await client.query(
          'SELECT * FROM jobs WHERE submission_id = $1 FOR UPDATE', [submissionId]));
        if (!job || job.status !== 'failed' || job.tries >= 3 || job.failure_code === 'retry_exhausted') {
          fail(409, 'retry_unavailable');
        }
        await requireServableBinding(client, bindingOf(attempt));
        if (!entitlement || entitlement.used + entitlement.reserved >= entitlement.allowance) fail(409, 'allowance_exhausted');
        await client.query("UPDATE jobs SET status = 'queued', failure_code = NULL WHERE id = $1", [job.id]);
        await client.query('UPDATE entitlements SET reserved = reserved + 1 WHERE owner_id = $1 AND exam_id = $2',
          [owner, job.exam_id]);
      });
    },

    /**
     * Discard an UNSUBMITTED draft. A submitted attempt is learner history and is refused with
     * 409 `submitted_attempt` whatever its job state (queued, running, succeeded, failed,
     * cancelled): removing it would cancel paid-for work, hide a result and lose a snapshot.
     *
     * Same lock order as `submit` (entitlement, then the attempt row FOR UPDATE), so the two
     * serialise on the attempt row. If `submit` commits first, the submissions read below is a
     * new READ COMMITTED statement and sees its row; if `remove` commits first, `submit`'s
     * locked re-read sees `deleted_at` and answers 404. Ownership is proven before the
     * submission test, so another owner's submitted attempt is still a plain 404.
     */
    async remove(owner, id) {
      note('remove');
      return settle(owner, async (client) => {
        // The same (owner, exam) balance lock `submit` takes first, so the two still serialise.
        const examId = await attemptExam(client, owner, id);
        if (examId) await lockBalance(client, owner, examId);
        await owned(client, owner, id);
        if (first(await client.query('SELECT id FROM submissions WHERE attempt_id = $1 LIMIT 1', [id]))) {
          fail(409, 'submitted_attempt');
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
  // EXAM-S1: evidence references a preparation, so it goes before the preparations it points at
  // (it would otherwise only cascade from "user", after the preparation delete had already failed).
  ['item_evidence', 'DELETE FROM item_evidence WHERE owner_id = $1'],
  ['learner_preparation', 'DELETE FROM learner_preparation WHERE owner_id = $1'],
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
  ['item_evidence', 'owner_id = $1', 'owner'],
  ['learner_preparation', 'owner_id = $1', 'owner'],
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
        // Same lock the writer paths take first (F6): every exam balance of the owner, in exam order,
        // so a concurrent submit/retry/remove on any exam either finishes first or sees the deletion.
        await client.query('SELECT 1 FROM entitlements WHERE owner_id = $1 ORDER BY exam_id FOR UPDATE', [owner]);
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

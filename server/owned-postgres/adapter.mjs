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
import {readOwnProviderAttempts} from './provider-attempts.mjs';
import { Fault } from '../../server/owned-api.mjs';
import { DEFAULT_TASK_BINDING } from './content-seed.mjs';
import { contentPolicy, servableReview, contentBlockReason } from '../content-policy.mjs';
import { entitlementExpired } from './entitlement.mjs';
import { createExamCatalogue, preparationDto } from '../preparation-contract.mjs';
import { preparationMethods, requireActivePreparation, resolvePreparation } from './preparations.mjs';
import { mockRunMethods, lockMockOwner, requireMockGroup } from './mock-runs.mjs';
import { playbackMethods } from './playback.mjs';
import { practicePlaybackMethods } from './practice-playback.mjs';
/* DRILL-01 (slice H): the drill's own port, composed the way task-17 composed its playback twin. */
import { drillMethods } from '../drill-pg.mjs';
import { feedbackMethods } from './feedback.mjs';
import { importedSetGate, objectiveInteractionSql, releasedObjectiveFamily, readWritingTask, writingAccess, readReleasedForm, readWritingOrigin } from './packages.mjs';
import { readCurrentReleaseEligibility } from './release-eligibility.mjs';
import { extractWritingExplanationSource, unavailableExplanationView } from '../explanation-contract.mjs';
import { readExplanationRepresentations, readObjectiveEvidenceExplanation as readEvidenceExplanation, readFinalisedMockItemExplanation } from './explanations.mjs';
import { explanationLanguage, blockedExplanation, projectStoredExplanation, explanationFault, protectedExplanationRead, selectedExplanationExports } from './explanation-views.mjs';
import { readGuideTranslations as readTranslations } from '../library-translations.mjs';
/* PRACTICE-UI-01 (slice B): the pure blueprint → parts normaliser the exam-parts route serves. */
import { blueprintParts } from '../exam-parts.mjs';
/* PRACTICE-01 (slice C): the pure selection rule and the served-set normaliser. */
import { selectPracticeSet, normalisePracticeSet, practiceRoundState } from '../practice-sets.mjs';

const UUID_RE = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const TEXT_LIMIT = 12000;
const OBJECTIVE_VERSION_RE = /^v[0-9]{1,4}$/;

const fail = (status, code) => { throw new Fault(status, code); };
const first = (result) => result.rows[0];
/**
 * FIX-N1 (second-pass review §N1) — WHICH EVIDENCE MAY COUNT.
 *
 * FIX-F1 established the right principle and implemented it too broadly. The principle: a PRACTICE answer to a
 * listening set the app cannot play is a guess about audio nobody heard, so it must not become a number a
 * learner reads nor a signal that steers the drill. The implementation was `media_required = true`, which is
 * about the SET — and the MOCK EXAM writes evidence for those very sets, with `mock_run_id` set
 * (`0030-listening-playback.sql:286-290`), where the audio really does play. Filtering on the set therefore
 * threw away real Probeprüfung listening results: after a full mock the Hören tiles said "nicht geübt".
 *
 * So the rule is about the ROW, not the set:
 *
 *   * `e.mock_run_id IS NOT NULL` — the answer came from a run in which the recording played. It counts, even
 *     when its set is media-bound, because the learner really did hear it.
 *   * otherwise the set must be one this deployment can play (`media_required = false`). A practice guess at a
 *     set with no playback path is the only thing dropped.
 *
 * Written as a boolean expression rather than a join so it can be dropped into any aggregate over
 * `item_evidence e` without changing that query's grouping. The JS twin is `playableEvidence` in
 * `server/drill-sets.mjs` (the drill ranks in memory); both implement this same rule and each names the other.
 *
 * THE SERVING FILTERS ARE A DIFFERENT RULE and are deliberately NOT this predicate: `checkPracticeAttempt`,
 * `drillCheckItem` and the drill's `CANDIDATE_SQL`/`readSet` use `s.media_required = false` because a SET
 * with no playable recording must not be MARKED at all — and `practiceSetForPart`, which must not SERVE one,
 * uses the same boolean for a set it cannot play plus POOL-01's playability half (a `media_required` set whose
 * `recordings[]` all resolve to an `exam_media` row IS served, because the practice player can play it; see
 * the note on that method). Mock evidence does not make a set playable — it records that one was playable
 * somewhere else (the mock's packaged form), which is exactly the distinction this predicate fixes. A set that
 * is not served cannot gather new practice evidence, so this predicate stays conservative where serving has
 * moved on.
 */
const COUNTED_EVIDENCE = `(e.mock_run_id IS NOT NULL OR EXISTS (SELECT 1 FROM objective_set ps
                                     WHERE ps.set_id = e.set_id AND ps.version = e.version
                                       AND ps.media_required = false))`;
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
export function createPostgresDatastore({ pool, onCall, examCatalogue = createExamCatalogue(), mediaRoot, explanationLanguageRegistry } = {}) {
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
      if (error?.message === 'mock_group_inactive' && !(error instanceof Fault)) fail(409,'mock_group_inactive');
      throw error;
    } finally {
      client.release();
    }
  }

  /** Live, owned attempt or 404. Locked for the writer paths. */
  async function owned(client, owner, id) {
    await lockMockOwner(client,owner);
    const exam=await attemptExam(client,owner,id);
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,7351))',[exam]);
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

  async function admissionExams(client, examId = null) {
    const ids = examId === null ? examCatalogue.ids : [examId], admitted = [];
    for (const id of ids) if ((await readCurrentReleaseEligibility(client, id, { catalogue: examCatalogue })).eligible) admitted.push(id);
    return admitted;
  }

  // Every new use checks the task AND its declared rubric. Existing snapshots remain readable.
  // Returns the exam both belong to, so a caller can compare it with the preparation BEFORE writing.
  async function requireServableBinding(client, binding, historical=false) {
    const identity=await readWritingTask(client,binding.taskId,binding.taskVersion);
    if (!historical && (!identity || !(await readCurrentReleaseEligibility(client, identity.exam_id, { catalogue: examCatalogue, lock: true })).eligible))
      fail(422, 'task_not_servable');
    if(identity) await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,7351))',[identity.exam_id]);
    const policy = contentPolicy();
    const row = first(await client.query(
      `SELECT t.exam_id FROM task_version t
         JOIN reviewed_content_version c ON c.content_version_id = t.content_version_id
         LEFT JOIN content_rights cr ON cr.content_version_id = c.content_version_id
         JOIN rubric_version r ON r.rubric_id = t.rubric_id AND r.version = t.rubric_version
         JOIN reviewed_content_version rc ON rc.content_version_id = r.content_version_id
         LEFT JOIN content_rights rr ON rr.content_version_id = rc.content_version_id
        WHERE t.task_id = $1 AND t.version = $2 AND t.rubric_id = $3 AND t.rubric_version = $4
          AND r.exam_id = t.exam_id
          AND c.review_status = ANY($5::text[]) AND rc.review_status = ANY($5::text[])
          AND COALESCE(cr.basis, c.rights_status) = ANY($6::text[])
          AND COALESCE(rr.basis, rc.rights_status) = ANY($6::text[])`,
      [binding.taskId, binding.taskVersion, binding.rubricId, binding.rubricVersion, policy.review, policy.rights]));
    if (!row) fail(422, 'task_not_servable');
    const task=await readWritingTask(client,binding.taskId,binding.taskVersion);
    if(task?.source_path?.startsWith('content/exams/') && (!examCatalogue.isEnabled(row.exam_id) || await writingAccess(client,task,{historical}))) fail(422,'task_not_servable');
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
    await lockMockOwner(client,owner);
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,7351))',[examId]);
    return first(await client.query(
      'SELECT * FROM entitlements WHERE owner_id = $1 AND exam_id = $2 FOR UPDATE', [owner, examId]));
  }

  /**
   * EXAM-S1-D: an unsubmitted draft may be edited or discarded only inside its own ACTIVE preparation.
   * An archived preparation is read-only to learner practice (409 `preparation_archived`), and an
   * unresolved legacy attempt is never edited under a guessed context (422 `preparation_unresolved`).
   * Call AFTER `owned()` has locked the attempt: the order attempt -> preparation FOR SHARE is the one
   * `create`/`submit` use, and archiving locks only the preparation row, so the two serialise without a
   * cycle. Whichever commits first wins; the loser either waits and re-reads `archived`, or archives after.
   */
  async function requireEditableContext(client, owner, attempt) {
    if (!attempt.preparation_id) fail(422, 'preparation_unresolved');
    await requireActivePreparation(client, owner, attempt.preparation_id);
  }

  const preparations = preparationMethods({ settle, note, catalogue: examCatalogue });

  // Call only after proving ownership of an attempt. These immutable historical records are
  // deliberately readable when the current deployment no longer offers them for new practice.
  async function writingContext(client,attempt,{completed=false}={}) {
    const attached=first(await client.query(`SELECT r.* FROM mock_writing w JOIN mock_run r ON r.id=w.run_id AND r.owner_id=w.owner_id WHERE w.attempt_id=$1 AND w.owner_id=$2`,[attempt.id,attempt.owner_id]));
    const origin=await readWritingOrigin(client,attempt.id,attempt.owner_id);
    const t=await readWritingTask(client,attempt.task_id,attempt.task_version);
    let blocked=await writingAccess(client,t,{historical:true,completed});
    let writingSection=null;
    let reviewWithdrawn=Boolean(t?.review_explicit_negative||t?.rubric_review_explicit_negative);
    if(t?.source_path?.startsWith('content/exams/') || origin) {
      blocked=blocked||(!examCatalogue.isEnabled(t?.exam_id)?'exam_unavailable':null);
      if(origin&&!blocked) {
        const bundle=await readReleasedForm(client,{examId:origin.exam_id,formId:origin.form_id,formVersion:origin.form_version,releaseVersion:origin.release_version,completed});
        blocked=bundle?.blockedReason??(!bundle?'content_unavailable':null);
        reviewWithdrawn ||= Boolean(bundle?.reviewWithdrawn);
        writingSection=bundle?.writingTask?.section??bundle?.writingChoices?.[0]?.section??null;
      }
    }
    return {mock_run_id:attached?.id??null,blocked_reason:blocked,review_withdrawn:reviewWithdrawn,review_basis:t?.review_basis??null,attached,writingSection};
  }
  async function requireWritingMutation(client,attempt,{standalone=false}={}) {
    if(attempt.exam_id) await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,7351))',[attempt.exam_id]);
    const context=await writingContext(client,attempt);
    if(standalone&&context.attached) fail(409,'attached_mock_attempt');
    if(context.blocked_reason) fail(409,context.blocked_reason);
    if(context.attached) {
      if(context.attached.state!=='active') fail(409,'mock_finalised');
      if(context.attached.deadline_at&&new Date(context.attached.deadline_at)<=new Date()) fail(409,'mock_expired');
      await requireMockGroup(client,context.attached.id,context.writingSection);
    }
  }
  async function historicalContent(client, attempt,{completed=false}={}) {
    const {mock_run_id,blocked_reason,review_withdrawn,review_basis}=await writingContext(client,attempt,{completed});
    if(blocked_reason) return {task:null,rubric:null,mock_run_id,blocked_reason};
    const task = first(await client.query(
      `SELECT task_id, version, rubric_id, rubric_version, exam_id, family, register, topic,
              situation, adressat, leitpunkte FROM task_version WHERE task_id = $1 AND version = $2`,
      [attempt.task_id, attempt.task_version]));
    const rubric = first(await client.query(
      `SELECT r.rubric_id, r.version, r.criteria, r.max_total, r.family, r.exam_id, r.policy, r.feedback_kind,
              c.review_status,c.review_basis,c.review_blocked,c.review_explicit_negative, COALESCE(cr.basis, c.rights_status) AS rights_status,
              c.review_status <> 'approved' AS provisional
         FROM rubric_version r JOIN reviewed_content_version c ON c.content_version_id = r.content_version_id
         LEFT JOIN content_rights cr ON cr.content_version_id = c.content_version_id
        WHERE r.rubric_id = $1 AND r.version = $2`, [attempt.rubric_id, attempt.rubric_version]));
    return { task: task ?? null, rubric: rubric ?? null, mock_run_id, blocked_reason, review_withdrawn, review_basis };
  }

  async function objectiveExplanationBundle(client,evidenceId,language=null) {
    const bundle=await protectedExplanationRead(client,()=>readEvidenceExplanation(client,{evidenceId,language},{languageRegistry:explanationLanguageRegistry}));
    const identity=bundle.source.identity;
    const content=first(await client.query(`SELECT c.source_path,c.review_status,c.review_blocked,c.review_explicit_negative,
      COALESCE(cr.basis,c.rights_status) AS rights_status
      FROM objective_set s JOIN reviewed_content_version c USING(content_version_id)
      LEFT JOIN content_rights cr USING(content_version_id)
      WHERE s.exam_id=$1 AND s.set_id=$2 AND s.version=$3`,[identity.exam_id,identity.set_id,identity.set_version]));
    if(contentBlockReason(content,{completed:true}) || (content?.source_path?.startsWith('content/exams/')&&!examCatalogue.isEnabled(identity.exam_id)))
      return null;
    if(content?.source_path?.startsWith('content/exams/')) {
      const states=contentPolicy().mode==='internal-preview'?['internal','available']:contentPolicy().mode==='public'?['available']:[];
      const historical=first(await client.query(`SELECT EXISTS(SELECT 1 FROM exam_release r
        JOIN exam_release_form rf ON rf.exam_id=r.exam_id AND rf.release_version=r.version
        JOIN exam_form_member m ON m.exam_id=rf.exam_id AND m.form_id=rf.form_id AND m.form_version=rf.form_version
        JOIN exam_release_head h ON h.exam_id=r.exam_id JOIN exam_release head ON head.exam_id=h.exam_id AND head.version=h.release_version
        WHERE r.exam_id=$1 AND m.set_id=$2 AND m.set_version=$3 AND r.state=ANY($4::text[])
          AND NOT(coalesce(head.manifest#>'{release,resumeBlockedReleases}','[]'::jsonb)?r.version)) AS allowed`,
        [identity.exam_id,identity.set_id,identity.set_version,states]));
      if(!historical?.allowed)return null;
    }
    return bundle;
  }

  return Object.freeze({
    // EXAM-S1: listExams, listPreparations, readPreparation, resolvePreparation, createPreparation,
    // updatePreparation, readCredits — see preparations.mjs.
    ...preparations,
    ...mockRunMethods({ settle, note, catalogue: examCatalogue, explanationLanguageRegistry }),
    ...playbackMethods({ settle, note, catalogue: examCatalogue, mediaRoot }),
    // PRACTICE-MEDIA (task-17): the same accounting model bound to a practice sitting instead of a mock run.
    ...practicePlaybackMethods({ settle, note, catalogue: examCatalogue, mediaRoot }),
    // DRILL-01 (slice H): the Einzelübungen port — `drillNext` and `drillCheckItem`. Additive.
    ...drillMethods({ settle, note, catalogue: examCatalogue }),
    // PILOT-FEEDBACK-01 (FB-B): the learner's own reports and the survey. Additive; the tables' policies carry
    // the ownership and triage rules, so this port only adds the closed request shapes and the 409/422 mapping.
    ...feedbackMethods({ settle, note }),
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
        const exams = await admissionExams(client, examId);
        if (!exams.length) return [];
        const rows = (await client.query(
          `SELECT t.task_id, t.version, t.family, t.register, t.topic, t.situation, t.adressat,
                  t.leitpunkte, t.rubric_id, t.rubric_version, t.exam_id, t.created_at,
                  c.review_status,c.review_basis,c.review_blocked,c.review_explicit_negative, COALESCE(cr.basis, c.rights_status) AS rights_status
             FROM task_version t
             JOIN reviewed_content_version c ON c.content_version_id = t.content_version_id
                  LEFT JOIN content_rights cr ON cr.content_version_id = c.content_version_id
             -- The declared rubric must be servable too (EXAM-S0), or the card would offer a task that
             -- create() refuses. Same rule as requireServableBinding: task AND rubric.
             JOIN rubric_version r ON r.rubric_id = t.rubric_id AND r.version = t.rubric_version
             JOIN reviewed_content_version rc ON rc.content_version_id = r.content_version_id
                  LEFT JOIN content_rights rr ON rr.content_version_id = rc.content_version_id
            WHERE t.exam_id = COALESCE($1, t.exam_id) AND t.exam_id = ANY($5::text[])
              AND ($2::text IS NULL OR t.family = $2)
              AND c.review_status = ANY($3::text[])
              AND COALESCE(cr.basis, c.rights_status) = ANY($4::text[])
              AND rc.review_status = ANY($3::text[])
              AND COALESCE(rr.basis, rc.rights_status) = ANY($4::text[])
            ORDER BY t.task_id, t.version`,
          [examId, family, statuses, contentPolicy().rights, exams])).rows;
        const permitted=[];
        for(const row of rows) {
          const task=await readWritingTask(client,row.task_id,row.version);
          if(examCatalogue.isEnabled(row.exam_id)&&!(await writingAccess(client,task))) permitted.push(row);
        }
        return permitted.map((row) => ({
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
          review_status: row.review_status, review_basis: row.review_basis,
          rights_status: row.rights_status,
        }));
      }, true);
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
    async hasObjectiveFamily(owner, { examId, family } = {}) {
      note('hasObjectiveFamily');
      if (!examCatalogue.isEnabled(examId)) return false;
      return settle(owner, async client => (await readCurrentReleaseEligibility(client, examId, { catalogue: examCatalogue })).eligible
        && releasedObjectiveFamily(client, examId, family), true);
    },
    /**
     * PRACTICE-UI-01 (slice B) — the written examination's parts, from the package blueprint this
     * installation already publishes.
     *
     * READ ONLY: a snapshot transaction, like every other catalogue read. The admission gate is the same
     * `readCurrentReleaseEligibility` the objective catalogue uses, so a withheld release answers an EMPTY
     * list, never a partial one, and a blueprint that does not parse is a 503 rather than a short list —
     * "the package is corrupt" and "this exam has fewer parts" must not look alike to the client.
     *
     * WHY THIS IS NOT `/objective-sets`: that query filters `s.media_required = false`, so HV1–HV3 are
     * structurally absent from it (and that is exactly why slice B's hearing tiles had no source). This
     * method is the only place the hearing parts' item counts and playback rule are served.
     *
     * NO POINTS: the packaged blueprint carries none (contract amendment A6 keeps per-part points as a cited
     * client constant until a blueprint revision carries them). The assembler therefore emits `points: null`
     * and `part: null` rather than omitting the members, and the client keeps the cited value wherever the
     * served one is null (REVIEW-PRACTICE-UI-01 F1). Null here means "the blueprint cannot answer this", not
     * "zero" — do not read it as a number.
     */
    async listExamParts(owner, { examId } = {}) {
      note('listExamParts');
      if (typeof examId !== 'string' || !examId) return [];
      return settle(owner, async (client) => {
        if (!(await readCurrentReleaseEligibility(client, examId, { catalogue: examCatalogue })).eligible) return [];
        const row = (await client.query(
          `SELECT b.payload
             FROM exam_release_head h
             JOIN exam_release r ON r.exam_id = h.exam_id AND r.version = h.release_version
             JOIN exam_blueprint b ON b.exam_id = r.exam_id AND b.version = r.blueprint_version
            WHERE h.exam_id = $1`, [examId])).rows[0];
        if (!row || !row.payload) return [];
        let parts;
        try { parts = blueprintParts(row.payload); }
        catch { fail(503, 'catalogue_unavailable'); }
        return [...parts];
      }, true);
    },
    async listObjectiveSets(owner, { examId = null, family = null, group = null, part = null, serveReview = 'approved+unreviewed' } = {}) {
      note('listObjectiveSets');
      const statuses = servableReview(serveReview);
      return settle(owner, async (client) => {
        const exams = await admissionExams(client, examId);
        if (!exams.length) return [];
        const rows = (await client.query(
          `SELECT s.set_id, s.version, s.exam_id, s.family, s.section, s.part, s.title,
                  s.item_count, s.media_required, ${objectiveInteractionSql()} AS interaction,
                  c.review_status,c.review_basis,c.review_blocked,c.review_explicit_negative, COALESCE(cr.basis, c.rights_status) AS rights_status
             FROM objective_set s
             JOIN reviewed_content_version c ON c.content_version_id = s.content_version_id
                  LEFT JOIN content_rights cr ON cr.content_version_id = c.content_version_id
            WHERE s.exam_id = COALESCE($1, s.exam_id) AND s.exam_id = ANY($7::text[])
              AND ($2::text IS NULL OR s.family = $2)
              AND ($4::text IS NULL OR s.family LIKE $4 || '%')
              AND ($5::int IS NULL OR s.part = $5)
              AND c.review_status = ANY($3::text[])
              AND s.media_required = false
              AND ${importedSetGate()}
              AND COALESCE(cr.basis, c.rights_status) = ANY($6::text[])
            ORDER BY s.family, s.part, s.set_id`,
          [examId, family, statuses, group, part, contentPolicy().rights, exams])).rows;
        return rows.map((row) => ({
          set_id: row.set_id,
          version: row.version,
          exam_id: row.exam_id,
          family: row.family,
          section: row.section,
          part: row.part,
          title: row.title,
          item_count: row.item_count,
          interaction: row.interaction,
          media_required: row.media_required,
          review_status: row.review_status, review_basis: row.review_basis,
          rights_status: row.rights_status,
        }));
      }, true);
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
      const row = await settle(owner, async (client) => {
        const found = first(await client.query(
        `SELECT s.set_id, s.version, s.exam_id, s.family, s.section, s.part, s.title, s.payload,
                s.item_count, s.media_required, ${objectiveInteractionSql()} AS interaction, c.review_status,c.review_basis,c.review_blocked,c.review_explicit_negative, COALESCE(cr.basis, c.rights_status) AS rights_status
           FROM objective_set s
           JOIN reviewed_content_version c ON c.content_version_id = s.content_version_id
                  LEFT JOIN content_rights cr ON cr.content_version_id = c.content_version_id
          WHERE s.set_id = $1 AND s.version = $2
            AND c.review_status = ANY($3::text[])
            AND s.media_required = false
            AND ${importedSetGate()}
            AND s.exam_id = ANY($4::text[])
            AND COALESCE(cr.basis, c.rights_status) = ANY($5::text[])`,
        [setId, version, statuses, examCatalogue.ids, contentPolicy().rights]));
        if (!found || !(await readCurrentReleaseEligibility(client, found.exam_id, { catalogue: examCatalogue })).eligible) return null;
        return found;
      }, true);
      if (!row) return null;
      return {
        set_id: row.set_id, version: row.version, exam_id: row.exam_id, family: row.family,
        section: row.section, part: row.part, title: row.title, payload: row.payload,
        item_count: row.item_count, media_required: row.media_required, interaction: row.interaction,
        review_status: row.review_status, review_basis: row.review_basis, rights_status: row.rights_status,
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
                  c.review_status,c.review_basis,c.review_blocked,c.review_explicit_negative, COALESCE(cr.basis, c.rights_status) AS rights_status
             FROM vocab_entry v
             JOIN reviewed_content_version c ON c.content_version_id = v.content_version_id
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
          review_status: row.review_status, review_basis: row.review_basis,
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
                  n.example, n.example_en, c.review_status,c.review_basis,c.review_blocked,c.review_explicit_negative, COALESCE(cr.basis, c.rights_status) AS rights_status
             FROM noun_entry n
             JOIN reviewed_content_version c ON c.content_version_id = n.content_version_id
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
          review_status: row.review_status, review_basis: row.review_basis,
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
                  c.review_status,c.review_basis,c.review_blocked,c.review_explicit_negative, COALESCE(cr.basis, c.rights_status) AS rights_status
             FROM guide g
             JOIN reviewed_content_version c ON c.content_version_id = g.content_version_id
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
          review_status: row.review_status, review_basis: row.review_basis,
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
          `SELECT r.rubric_id, r.version, r.family, r.criteria, r.max_total, r.exam_id, r.policy, r.feedback_kind,
                  c.review_status,c.review_basis,c.review_blocked,c.review_explicit_negative, COALESCE(cr.basis, c.rights_status) AS rights_status
             FROM rubric_version r
             JOIN reviewed_content_version c ON c.content_version_id = r.content_version_id
                  LEFT JOIN content_rights cr ON cr.content_version_id = c.content_version_id
            WHERE r.rubric_id = $1 AND r.version = $2 AND c.review_status = ANY($3::text[])
              AND COALESCE(cr.basis, c.rights_status) = ANY($4::text[])`,
          [rubricId, version, statuses, contentPolicy().rights]));
        if (!row || !examCatalogue.isEnabled(row.exam_id)) return null;
        if (!(await readCurrentReleaseEligibility(client, row.exam_id, { catalogue: examCatalogue })).eligible) return null;
        if(row.policy) {
          const tasks=(await client.query('SELECT task_id,version FROM task_version WHERE rubric_id=$1 AND rubric_version=$2',[rubricId,version])).rows;
          let permitted=false;
          for(const t of tasks) if(!(await writingAccess(client,await readWritingTask(client,t.task_id,t.version)))) permitted=true;
          if(!permitted) return null;
        }
        return {
          policy:row.policy,feedback_kind:row.feedback_kind,
          rubric_id: row.rubric_id,
          version: row.version,
          family: row.family,
          exam_id: row.exam_id,
          max_total: row.max_total===null?null:Number(row.max_total),
          criteria: row.criteria,
          review_status: row.review_status, review_basis: row.review_basis,
          rights_status: row.rights_status,
          provisional: row.review_status !== 'approved',
        };
      }, true);
    },

    async readGuide(owner, { guideId, serveReview = 'approved+unreviewed' } = {}) {      note('readGuide');
      const statuses = servableReview(serveReview);
      return settle(owner, async (client) => {
        const head = (await client.query(
          `SELECT g.guide_id, g.family, g.title, g.intro, g.intro_en, g.watch_out, g.watch_out_en,
                  g.section_count, c.review_status,c.review_basis,c.review_blocked,c.review_explicit_negative, COALESCE(cr.basis, c.rights_status) AS rights_status
             FROM guide g
             JOIN reviewed_content_version c ON c.content_version_id = g.content_version_id
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
          review_status: head.review_status, review_basis: head.review_basis,
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
     * LIBRARY-I18N-01 (F2) — the additive `translations` member of MIRROR-B1PREP-01 §4.3.
     *
     * A SHARED CONTENT READ, not an ownership read: the reference library carries no owner column, so
     * this is a read-only snapshot through the same learner pool as `readGuide` above. It returns
     * `null` rather than an empty object when the installation has nothing current in that locale, and
     * it never returns a rejected row or a row generated from a superseded guide version — see
     * `readGuideTranslations` in `server/library-translations.mjs` for that rule and for why stale and
     * absent deliberately share one answer.
     *
     * The route asks for it ONLY when a `locale` was supplied, so a consumer that does not send one
     * keeps the exact response shape it had before this slice.
     */
    async readGuideTranslations(owner, { guideId, locale } = {}) {
      note('readGuideTranslations');
      return settle(owner, (client) => readTranslations(client, { guideId, locale }), true);
    },
    /**
     * PILOT-22 — record one answered objective item, marked server-side.
     *
     * MARKING IS NOT DONE HERE, and deliberately: this connection is the LEARNER role, which is NOT
     * granted `objective_key`. The comparison happens inside `mark_objective_item`, a SECURITY DEFINER
     * function that reads the key as its owner and returns ONE BOOLEAN. Once the evidence row exists,
     * `reveal_objective_answer` (0041) returns that one item's expected answer for the result screen.
     * Granting this role SELECT on the key to make marking possible would have undone the isolation the
     * objective seed exists for.
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
        // Keep the same owner-before-exam order as writing, run starts and SQL admission guards.
        await lockMockOwner(client, owner);
        // EXAM-S1: owned (404) and active (409) before anything else; exam match (422) before marking.
        const prep = await requireActivePreparation(client, owner, preparationId);
        if (!examCatalogue.isEnabled(prep.exam_id)) fail(404, 'not_found');
        if (!(await readCurrentReleaseEligibility(client, prep.exam_id, { catalogue: examCatalogue, lock: true })).eligible)
          fail(404, 'not_found');
        // The set must be one the deployment serves, and this also yields the exam/section the
        // evidence is attributed to. A set that is withheld or absent is 404, not a silent record.
        const set = first(await client.query(
          `SELECT s.exam_id, s.family, s.section, s.version
             FROM objective_set s
             JOIN reviewed_content_version c ON c.content_version_id = s.content_version_id
                  LEFT JOIN content_rights cr ON cr.content_version_id = c.content_version_id
            WHERE s.set_id = $1 AND s.version = $2 AND c.review_status = ANY($3::text[])
              AND s.media_required = false
              AND ${importedSetGate()}
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
        // REDESIGN-01 A: the expected answer, now that this learner's own answer is recorded. Read through
        // `reveal_objective_answer` (0041), which returns it only to an owner with evidence for the item.
        const revealed = first(await client.query(
          'SELECT reveal_objective_answer($1, $2, $3) AS correct_answer', [setId, version, itemId]));
        return { evidence_id: evidenceId, item_id: itemId, correct: marked.correct,
          correct_answer: revealed ? revealed.correct_answer : null, preparation_id: prep.id, exam_id: prep.exam_id };
      });
    },
    /**
     * PRACTICE-01 (slice C) — the one released set this PART serves now, and the sitting it opens.
     *
     * The DECISION is `server/practice-sets.mjs` (unseen first, then most wrong, then oldest), which is pure
     * and proved offline against crafted evidence rows. This method owns the read, the admission gate and the
     * transaction, and it returns the rule's own numbers as the reason for its choice, so the client can say
     * "4 von 5 falsch" rather than handing over a set with no explanation.
     *
     * The sitting is created here, not at "Auswerten": from the moment a set is served there is an `open`
     * attempt, so an abandoned page is still a record. `checkPracticeAttempt` is what closes it.
     *
     * WHY `media_required` SETS ARE EXCLUDED (FIX-F1, outside review §F1). This was the ONE catalogue query
     * without that filter (:424, :463, :756, :1009, :1058 all carry it, for the reason recorded at :358). The
     * gap reached learners: no released practice set has recordings, so the runner served a Hören set with a
     * player that cannot play beside LIVE answer controls, and `POST /practice/check` wrote those blind
     * guesses into `item_evidence` — where the drill's ranking reads them. A learner could then be told their
     * weakness was listening and handed more unplayable items. A part whose sets all need media now answers
     * "nothing available", which is true, instead of serving an exercise the learner cannot do honestly.
     *
     * POOL-01 (task-49) NARROWED THAT FILTER, WITHOUT WEAKENING IT. The rule is no longer "the set is about
     * audio" but "this deployment can actually PLAY this set": a `media_required` set is admitted only when
     * every recording its payload binds resolves to an `exam_media` row for the same exam (the media route's
     * own key). So the three released listening sets (`hv1.04`/`hv2.04`/`hv3.04`, migration 0048) are served,
     * while FIX-F1's protection survives twice over: a set with NO binding, and a set whose binding names audio
     * this deployment does not have, are both still refused — they are not servable at all, so no sitting is
     * opened and no blind guess can be recorded. `checkPracticeAttempt`'s own `media_unavailable` refusal is
     * deliberately UNCHANGED: it is the backstop for an attempt opened before this rule, and a checked sitting
     * is not what makes audio honest.
     *
     * WHY THE SUBQUERY IS NOT SIMPLY "has a recordings binding": `practice-playback.mjs#recordingsOf` already
     * fails loudly (`media_unavailable`) for an authored recording whose media row was never imported, so
     * admitting one here would serve a set whose player cannot start — the exact defect F1 fixed, one layer
     * down. The admission check and the playback port therefore agree on the same key, by construction.
     */
    async practiceSetForPart(owner, { preparationId, family, serveReview = 'approved+unreviewed' } = {}) {
      note('practiceSetForPart');
      if (typeof family !== 'string' || !/^[A-Za-z]{2}\d?$/.test(family)) fail(422, 'invalid_family');
      requirePreparationContext(preparationId);
      const statuses = servableReview(serveReview);
      return settle(owner, async (client) => {
        const { exam_id: examId } = await resolvePreparation(client, owner, preparationId);
        if (!(await readCurrentReleaseEligibility(client, examId, { catalogue: examCatalogue })).eligible) return null;
        const candidates = (await client.query(
          `SELECT s.set_id, s.version, s.title, s.family, s.section, s.part, s.item_count, s.media_required, s.payload
             FROM objective_set s
             JOIN reviewed_content_version c ON c.content_version_id = s.content_version_id
                  LEFT JOIN content_rights cr ON cr.content_version_id = c.content_version_id
            WHERE s.exam_id = $1 AND s.family = $2
              AND (
                s.media_required = false
                OR EXISTS (
                  SELECT 1 FROM jsonb_array_elements(s.payload->'recordings') AS rec
                   WHERE EXISTS (SELECT 1 FROM exam_media m
                                  WHERE m.exam_id = s.exam_id
                                    AND m.media_id = rec->>'mediaId'
                                    AND m.version = rec->>'mediaVersion')
                )
              )
              AND NOT EXISTS (
                SELECT 1 FROM jsonb_array_elements(
                  CASE WHEN jsonb_typeof(s.payload->'recordings') = 'array' THEN s.payload->'recordings' ELSE '[]'::jsonb END) AS rec
                 WHERE NOT EXISTS (SELECT 1 FROM exam_media m
                                    WHERE m.exam_id = s.exam_id
                                      AND m.media_id = rec->>'mediaId'
                                      AND m.version = rec->>'mediaVersion')
              )
              AND ${importedSetGate()}
              AND c.review_status = ANY($3::text[])
              AND COALESCE(cr.basis, c.rights_status) = ANY($4::text[])`,
          [examId, family, statuses, contentPolicy().rights])).rows;
        if (!candidates.length) return null;
        const evidence = (await client.query(
          `SELECT set_id, correct, answered_at
             FROM item_evidence
            WHERE owner_id = $1 AND preparation_id = $2 AND family = $3`,
          [owner, preparationId, family])).rows;
        const chosen = selectPracticeSet(candidates, evidence);
        if (!chosen) return null;
        const row = candidates.find((entry) => entry.set_id === chosen.set_id && entry.version === chosen.version) || null;
        if (!row) return null;
        const payload = row.payload && typeof row.payload === 'object' ? row.payload : {};
        const served = normalisePracticeSet({ ...row, items: undefined }, payload.playback ?? null);
        const attemptId = randomUUID();
        await client.query(
          `INSERT INTO practice_attempt
             (attempt_id, owner_id, exam_id, preparation_id, set_id, version, family, section, item_count)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [attemptId, owner, examId, preparationId, row.set_id, row.version, row.family, row.section, served.item_count]);
        /* How many distinct sets of this part the learner has already CHECKED: the runner's wrap rule (A1). */
        const checked = first(await client.query(
          `SELECT count(DISTINCT set_id)::int AS checked
             FROM practice_attempt
            WHERE owner_id = $1 AND preparation_id = $2 AND family = $3 AND state = 'checked'`,
          [owner, preparationId, family]));
        return Object.freeze({
          preparation_id: preparationId,
          exam_id: examId,
          family,
          section: served.section,
          reason: chosen.tier,
          evidence: { seen: chosen.seen, wrong: chosen.wrong, first_seen_at: chosen.first_seen_at },
          attempt: Object.freeze({ attempt_id: attemptId, state: 'open' }),
          round: practiceRoundState({ setCount: candidates.length, checkedSets: checked ? checked.checked : 0 }),
          set: served,
        });
        /*
         * NOT a snapshot. This method SERVES AND OPENS: the `practice_attempt` INSERT above is the sitting, so
         * `settle`'s read-only flag must be false. It was passed `true` (`BEGIN ISOLATION LEVEL REPEATABLE READ
         * READ ONLY`) and the method had never been executed against a database, so the failure was invisible:
         * the normaliser threw first and masked it. With the normaliser fixed it surfaced as SQLSTATE 25006,
         * "cannot execute INSERT in a read-only transaction". Read-only means read-only.
         */
      }, false);
    },
    /**
     * PRACTICE-01 (slice C) — "Auswerten": mark every answer, record it as evidence, close the sitting, and
     * return the FULL review (verdict, the learner's pick, the key). The explanation is attached by the route
     * through the existing context-authorized reader (`readObjectiveEvidenceExplanation`), because the
     * explanation lives behind its own admission gate and this method must not bypass it.
     *
     * Marking is `mark_objective_item` (SECURITY DEFINER, 0015) and the key is `reveal_objective_answer`
     * (0041), which returns it only once the learner's own evidence row exists — so this response cannot leak
     * a key for an item the learner has not answered.
     *
     * The evidence rows carry `mock_run_id` NULL and reference the practice attempt's set/version: a practice
     * answer is distinguishable from a mock answer at rest, which is the point of the separate table.
     */
    async checkPracticeAttempt(owner, { preparationId, attemptId, answers } = {}) {
      note('checkPracticeAttempt');
      requirePreparationContext(preparationId);
      if (typeof attemptId !== 'string' || !UUID_RE.test(attemptId)) fail(422, 'invalid_attempt');
      if (!Array.isArray(answers) || answers.length === 0 || answers.length > 100) fail(422, 'invalid_answers');
      const statuses = servableReview();
      return settle(owner, async (client) => {
        await lockMockOwner(client, owner);
        const prep = await requireActivePreparation(client, owner, preparationId);
        const attempt = first(await client.query(
          `SELECT attempt_id, exam_id, preparation_id, set_id, version, family, section, item_count, state, mode
             FROM practice_attempt
            WHERE attempt_id = $1 AND owner_id = $2`, [attemptId, owner]));
        if (!attempt) fail(404, 'not_found');
        if (attempt.preparation_id !== prep.id) fail(422, 'preparation_mismatch');
        if (attempt.state === 'checked') fail(409, 'attempt_already_checked');
        /*
         * DRILL-01 (slice H): a DRILL sitting carries `mode='drill'` (migration 0046) and must never be
         * filled by this whole-set path. The drill answers ONE item at a time into its own row; letting the
         * runner mark all n items into it would append a second evidence row per item already answered and
         * rewrite `answered_count`/`correct_count` from the wrong baseline. The reverse direction is refused
         * by `drillCheckItem` (`not_a_drill_sitting`), so neither path can adopt the other's sitting.
         */
        if (attempt.mode === 'drill') fail(409, 'not_a_part_sitting');
        const set = first(await client.query(
          `SELECT s.exam_id, s.family, s.section, s.media_required
             FROM objective_set s
             JOIN reviewed_content_version c ON c.content_version_id = s.content_version_id
                  LEFT JOIN content_rights cr ON cr.content_version_id = c.content_version_id
            WHERE s.set_id = $1 AND s.version = $2
              AND c.review_status = ANY($3::text[])
              AND COALESCE(cr.basis, c.rights_status) = ANY($4::text[])`,
          [attempt.set_id, attempt.version, statuses, contentPolicy().rights]));
        if (!set) fail(404, 'not_found');
        /*
         * FIX-F1 — a listening set cannot be attempted honestly: there are no recordings, so any answer would
         * be a guess about audio the learner never heard. `practiceSetForPart` no longer SERVES one, so this is
         * the backstop for an attempt opened before that fix (or by a stale client): refuse the marking rather
         * than write the guess into `item_evidence`, where it would steer the drill's ranking.
         */
        if (set.media_required === true) fail(409, 'media_unavailable');
        const items = [];
        let correctCount = 0;
        for (const entry of answers) {
          const itemId = entry && typeof entry.item_id === 'string' ? entry.item_id : null;
          if (!itemId || !/^[A-Za-z0-9._-]{1,64}$/.test(itemId)) fail(422, 'invalid_item');
          if (entry.answer === undefined) fail(422, 'invalid_answer');
          let marked;
          try {
            marked = first(await client.query(
              'SELECT mark_objective_item($1, $2, $3, $4::jsonb) AS correct',
              [attempt.set_id, attempt.version, itemId, JSON.stringify(entry.answer)]));
          } catch (error) {
            if (/unknown_item/.test(error && error.message)) fail(422, 'unknown_item');
            throw error;
          }
          const evidenceId = randomUUID();
          await client.query(
            `INSERT INTO item_evidence
               (evidence_id, owner_id, exam_id, set_id, version, item_id, family, section, answer, correct,
                latency_ms, preparation_id)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $12)`,
            [evidenceId, owner, attempt.exam_id, attempt.set_id, attempt.version, itemId, attempt.family,
              attempt.section, JSON.stringify(entry.answer), marked.correct,
              Number.isSafeInteger(entry.latency_ms) ? entry.latency_ms : null, prep.id]);
          const revealed = first(await client.query(
            'SELECT reveal_objective_answer($1, $2, $3) AS expected', [attempt.set_id, attempt.version, itemId]));
          if (marked.correct) correctCount += 1;
          /*
           * `answer_kind` is the REVIEW's own disclosure of what kind of answer the key holds -- derived from
           * the revealed key's JSON type, the same fact migration `0037` refuses on. The route needs it to know
           * whether the CHOICE-family explanation reader can serve this item at all: a listening part's answer
           * is a JSON boolean, and that reader requires a string. It is `judgement` for exactly those items.
           */
          items.push({
            item_id: itemId,
            correct: marked.correct,
            chosen: entry.answer,
            expected: revealed ? revealed.expected : null,
            answer_kind: revealed && typeof revealed.expected === 'boolean' ? 'judgement' : 'choice',
            evidence_id: evidenceId,
            explanation: null,
          });
        }
        const checked = first(await client.query(
          `UPDATE practice_attempt
              SET state = 'checked', answered_count = $3, correct_count = $4, checked_at = now()
            WHERE attempt_id = $1 AND owner_id = $2
        RETURNING checked_at`, [attemptId, owner, items.length, correctCount]));
        return {
          attempt_id: attemptId,
          set_id: attempt.set_id,
          version: attempt.version,
          family: attempt.family,
          section: attempt.section,
          state: 'checked',
          checked_at: checked ? checked.checked_at : null,
          item_count: attempt.item_count,
          answered_count: items.length,
          correct_count: correctCount,
          /* The choice-family explanation reader refuses any media_required set (0037), so the review says so. */
          media_required: set.media_required === true,
          items,
        };
      }, false);
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
      return settle(owner, async client => {
        // The preparation decides the exam; evidence is counted for this preparation only.
        const { exam_id: examId } = await resolvePreparation(client, owner, preparationId);
        if (!(await readCurrentReleaseEligibility(client, examId, { catalogue: examCatalogue })).eligible) return null;

        const sections = (await client.query(
          `SELECT s.section, min(s.family) AS family
             FROM objective_set s
             JOIN reviewed_content_version c ON c.content_version_id = s.content_version_id
                    LEFT JOIN content_rights cr ON cr.content_version_id = c.content_version_id
            WHERE s.media_required = false
              AND ${importedSetGate()}
              AND s.exam_id = $1
              AND c.review_status = ANY($2::text[])
              AND COALESCE(cr.basis, c.rights_status) = ANY($3::text[])
            GROUP BY s.section`,
          [examId, statuses, contentPolicy().rights])).rows;

        if (!sections.length) return null;

        const stats = (await client.query(
          `SELECT section, count(*)::int AS attempts, count(*) FILTER (WHERE correct)::int AS correct
             FROM item_evidence
            WHERE owner_id = $1 AND preparation_id = $2
            GROUP BY section`,
          [owner, preparationId])).rows;
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
        // `seen` is per exact (set, version): evidence for v1 says nothing about what v2 asks.
        const set = first(await client.query(
          `SELECT s.set_id, s.version, s.title, s.family, s.section, s.part, s.item_count, ${objectiveInteractionSql()} AS interaction,
                  (SELECT count(*)::int FROM item_evidence e
                    WHERE e.owner_id = $3 AND e.preparation_id = $6
                      AND e.set_id = s.set_id AND e.version = s.version) AS seen
             FROM objective_set s
             JOIN reviewed_content_version c ON c.content_version_id = s.content_version_id
                    LEFT JOIN content_rights cr ON cr.content_version_id = c.content_version_id
            WHERE s.section = $1
              AND s.media_required = false
              AND ${importedSetGate()}
              AND s.exam_id = $4
              AND c.review_status = ANY($2::text[])
              AND COALESCE(cr.basis, c.rights_status) = ANY($5::text[])
            ORDER BY seen, s.part, s.set_id, s.version
            LIMIT 1`,
          [chosen.section, statuses, owner, examId, contentPolicy().rights, preparationId]));

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
            section: set.section, part: set.part, item_count: set.item_count, seen_items: set.seen, interaction: set.interaction,
          },
        };
      }, true);
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
      const progress = await settle(owner, async (client) => {
        await resolvePreparation(client, owner, preparationId);
        /*
         * PRACTICE-UI-01 (slice B) — the SAME evidence, grouped twice.
         *
         * `sections` is the pre-slice answer and is unchanged, member for member. `parts` is the new one:
         * `item_evidence.family` is the part id (`LV1`…`HV3`, migration 0015-item-evidence.sql), so one more
         * GROUP BY attributes an attempt to the PART the learner actually practised. That is what a part
         * tile needs, and it is exactly what a section count must never be used for: "LV: 7 of 10 correct"
         * says nothing about LV1, LV2 or LV3 individually. Same owner, same preparation filter, so both
         * groupings necessarily see the same rows.
         *
         * FIX-N1 RESTORED THAT PROMISE FOR `sections`. FIX-F1 had dropped the "unchanged, member for member"
         * sentence by putting the playability filter on BOTH aggregates, which also made the section figure
         * lose every Probeprüfung listening result. `sections` is back to counting every answered item — the
         * pre-slice behaviour, verbatim — and only `parts` carries the evidence rule, because a part figure is
         * what a learner acts on and what the drill's ranking reads. The asymmetry is deliberate: the section
         * number is a historical count, the part number is a live signal.
         */
        const sections = await client.query(
          `SELECT e.section,
                  count(*)::int AS attempts,
                  count(*) FILTER (WHERE e.correct)::int AS correct
             FROM item_evidence e
            WHERE e.owner_id = $1 AND e.preparation_id = $2
            GROUP BY e.section
            ORDER BY e.section`,
          [owner, preparationId]);
        const parts = await client.query(
          `SELECT e.family,
                  count(*)::int AS attempts,
                  count(*) FILTER (WHERE e.correct)::int AS correct
             FROM item_evidence e
            WHERE e.owner_id = $1 AND e.preparation_id = $2 AND e.family IS NOT NULL
              AND ${COUNTED_EVIDENCE}
            GROUP BY e.family
            ORDER BY e.family`,
          [owner, preparationId]);
        return { rows: sections.rows, parts: parts.rows };
      });
      const rows = progress.rows;
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
        /* PRACTICE-UI-01 (slice B): the same evidence per part. Additive; consumers that ignore it see the
           exact previous shape, and a part with no evidence is simply absent rather than zero. */
        parts: progress.parts.map((row) => ({
          family: row.family,
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
     * THE CORRECT ANSWER COMES BACK WITH THE LEARNER'S OWN (REDESIGN-01 A, Ron 4 October 2026). The
     * key is still not readable by this role; `reveal_objective_answer` (0041) returns one item's answer
     * only because this learner's answer to that item is already on record, so a mistakes list cannot
     * reveal anything the practice loop has not already shown them.
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
                  s.title, s.item_count, reveal_objective_answer(l.set_id, l.version, l.item_id) AS correct_answer
             FROM latest l
             JOIN objective_set s ON s.set_id = l.set_id AND s.version = l.version
             JOIN reviewed_content_version c ON c.content_version_id = s.content_version_id
            WHERE l.correct = false
              AND ${importedSetGate()}
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
            your_answer: row.answer,
            // REDESIGN-01 A: revealed only because this learner's answer to the item is on record (0041).
            correct_answer: row.correct_answer ?? null,
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
        await lockMockOwner(client,owner);
        let b = binding || DEFAULT_TASK_BINDING;
        let text = '';
        let prepId = preparationId;
        if (parent) {
          const identity=first(await client.query('SELECT a.exam_id FROM submissions s JOIN attempts a ON a.id=s.attempt_id AND a.owner_id=s.owner_id WHERE s.id=$1 AND s.owner_id=$2',[parent,owner]));
          if(!identity)fail(404,'not_found');
          await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,7351))',[identity.exam_id]);
          const parentRow = first(await client.query(
            `SELECT a.id,a.owner_id,a.exam_id,a.task_id, s.task_version, a.rubric_id, s.rubric_version, s.text, a.preparation_id
               FROM submissions s JOIN attempts a ON a.id = s.attempt_id
              WHERE s.id = $1 AND s.owner_id = $2 AND a.owner_id = $2
                AND a.deleted_at IS NULL FOR UPDATE OF a`, [parent, owner]));
          if (!parentRow) fail(404, 'not_found');
          if(parentRow.exam_id) await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,7351))',[parentRow.exam_id]);
          const parentContext=await writingContext(client,parentRow);
          if(parentContext.blocked_reason) fail(409,parentContext.blocked_reason);
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
        const contentExam = await requireServableBinding(client, b,Boolean(parent));
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
                (SELECT run_id FROM mock_writing WHERE attempt_id=a.id) AS mock_run_id,
                CASE WHEN s.id IS NULL THEN 'draft'
                     WHEN f.submission_id IS NOT NULL THEN 'assessed'
                     WHEN j.status IS NULL OR j.status IN ('failed', 'cancelled') THEN 'unassessed'
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
          `SELECT exam_id, allowance, used, reserved, expires_at FROM entitlements
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
          `SELECT evidence_id, exam_id, preparation_id, set_id, version, item_id, family, section, answer, mock_run_id,
                  correct, latency_ms, answered_at FROM item_evidence
            WHERE owner_id = $1 ORDER BY answered_at, evidence_id`, [owner])).rows;
        // Original pinned identities/responses, including archived and blocked runs.
        // Protected feedback follows publication policy; learner responses and evidence stay exportable.
        // No keys or transcripts are fetched to make an export; result is the immutable learner snapshot.
        const mock_runs = (await client.query(`SELECT id,preparation_id,exam_id,release_version,blueprint_version,
          form_id,form_version,title,scope,mode,state,revision,responses,position,
          CASE WHEN EXISTS (SELECT 1 FROM exam_release_head h JOIN exam_release er
            ON er.exam_id = h.exam_id AND er.version = h.release_version
            WHERE h.exam_id = r.exam_id AND coalesce(er.manifest #> '{release,resumeBlockedReleases}', '[]'::jsonb) ? r.release_version)
            OR EXISTS (SELECT 1 FROM exam_release pinned WHERE pinned.exam_id=r.exam_id AND pinned.version=r.release_version
              AND pinned.state IN ('internal','hidden') AND (NOT (r.exam_id=ANY($2::text[])) OR NOT $3::boolean))
            THEN NULL ELSE result END AS result,created_at,updated_at,
          deadline_at,finalised_at,
          (SELECT coalesce(jsonb_agg(jsonb_build_object('set_id',i->>'set_id','set_version',i->>'version','item_id',i->>'item_id')),'[]'::jsonb)
            FROM jsonb_array_elements(r.result->'items') i) AS explanation_contexts
          FROM mock_run r WHERE owner_id = $1 ORDER BY created_at,id`, [owner, examCatalogue.ids, contentPolicy().mode==='internal-preview'])).rows;
        const mockExplanationContexts=new Map(mock_runs.map(run=>[run.id,run.explanation_contexts]));
        for(const run of mock_runs)delete run.explanation_contexts;
        const mock_writing=(await client.query('SELECT run_id,attempt_id,binding_kind,choice_group_id,selected_option_id,submission_id,failure_code FROM mock_writing WHERE owner_id=$1 ORDER BY run_id',[owner])).rows;
        const mock_run_time_groups=(await client.query('SELECT run_id,ordinal,group_id,sections,starts_at,deadline_at FROM mock_run_time_group WHERE owner_id=$1 ORDER BY run_id,ordinal',[owner])).rows;
        // Transport event IDs/playback UUIDs are deliberately absent from the learner export.
        const listening_playback = (await client.query(`SELECT run_id,media_id,media_version,revision,state,plays_used,
          max_plays,position_ms,duration_ms,created_at,updated_at FROM listening_playback
          WHERE owner_id=$1 ORDER BY run_id,media_id,media_version`, [owner])).rows;
        for (const run of mock_runs) {
          if (run.state!=='finalised') continue;
          const bundle = await readReleasedForm(client, { examId: run.exam_id, formId: run.form_id,
            formVersion: run.form_version, releaseVersion: run.release_version,completed:run.state==='finalised' });
          run.blocked_reason=!bundle?'content_unavailable':bundle.blockedReason??(!run.result&&mockExplanationContexts.get(run.id)?.length?'content_policy_blocked':null);
          if (run.blocked_reason) run.result = null;
          run.review_withdrawn=Boolean(bundle?.reviewWithdrawn);run.review_basis=bundle?.reviewBasis??null;
        }
        const blockedWriting=new Map();
        for(const result of results) {
          const submission=submissions.find(s=>s.id===result.submission_id);
          if(submission) {
            const context=await writingContext(client,{id:submission.attempt_id,owner_id:owner,task_id:submission.task_id,task_version:submission.task_version},{completed:Boolean(result.feedback)});
            if(context.blocked_reason){result.feedback=null;blockedWriting.set(submission.id,context.blocked_reason);}
            result.review_withdrawn=context.review_withdrawn;result.review_basis=context.review_basis;
          }
        }
        const writing_explanation_representations=(await client.query(`SELECT submission_id,source_sha256,language,representation_version,
          attempt_id,exam_id,task_id,task_version,rubric_id,rubric_version,model_version,prompt_version,
          original_language,original_format,payload,payload_sha256,provenance,created_at FROM writing_explanation_representation
          WHERE owner_id=$1 ORDER BY submission_id,source_sha256,language,representation_version`,[owner])).rows.map(row=>{
            const blocked=blockedWriting.get(row.submission_id);
            return blocked?{...row,payload:null,blocked_reason:blocked}:row;
          });
        const writing_explanation_heads=(await client.query(`SELECT submission_id,source_sha256,language,representation_version FROM writing_explanation_head
          WHERE owner_id=$1 ORDER BY submission_id,source_sha256,language`,[owner])).rows;
        const shared_explanation_representations=[];
        for(const evidence of objective_evidence){
          if(evidence.mock_run_id)continue;
          const context={evidence_id:evidence.evidence_id};
          try {
            const bundle=await objectiveExplanationBundle(client,evidence.evidence_id);
            if(bundle)shared_explanation_representations.push(...await selectedExplanationExports(client,bundle,context));
            else shared_explanation_representations.push({context,representation:null,blocked_reason:'content_blocked'});
          }catch(error){
            if(['not_found','explanation_content_blocked'].includes(error?.message))shared_explanation_representations.push({context,representation:null,blocked_reason:error.message});
            else throw error;
          }
        }
        for(const run of mock_runs){
          if(run.state!=='finalised')continue;
          if(!run.result){
            for(const item of mockExplanationContexts.get(run.id)??[])shared_explanation_representations.push({
              context:{run_id:run.id,...item},representation:null,blocked_reason:run.blocked_reason??'content_unavailable'});
            continue;
          }
          for(const item of run.result.items??[]){
            const context={run_id:run.id,set_id:item.set_id,set_version:item.version,item_id:item.item_id};
            try {
              const bundle=await protectedExplanationRead(client,()=>readFinalisedMockItemExplanation(client,
                {runId:run.id,setId:item.set_id,setVersion:item.version,itemId:item.item_id},{languageRegistry:explanationLanguageRegistry}));
              shared_explanation_representations.push(...await selectedExplanationExports(client,bundle,context));
            }catch(error){
              if(['not_found','explanation_content_blocked'].includes(error?.message))shared_explanation_representations.push({context,representation:null,blocked_reason:error.message});
              else throw error;
            }
          }
        }
        const payment_orders = (await client.query(`SELECT id,exam_id,product_id,market,currency,amount_minor,allowance,term_days,status,created_at,paid_at
          FROM payment_order WHERE owner_id=$1 ORDER BY created_at,id`, [owner])).rows;
        const payment_events = (await client.query('SELECT id,order_id,kind,disposition,created_at FROM payment_event WHERE owner_id=$1 ORDER BY created_at,id', [owner])).rows;
        const payment_grants = (await client.query('SELECT order_id,event_id,exam_id,allowance,expires_at,created_at FROM payment_grant WHERE owner_id=$1 ORDER BY created_at,order_id', [owner])).rows;
        const payment_checkout_events = (await client.query('SELECT event_id,order_id FROM payment_checkout_event WHERE owner_id=$1 ORDER BY event_id', [owner])).rows;
        const provider_attempts=await readOwnProviderAttempts(client);
        // PILOT-FEEDBACK-01 (0049, FB-A): the learner's OWN reports and survey rows, with `status` and WITHOUT
        // `operator_note` — that note is the operator's internal triage record, not the learner's data. The
        // screenshot bytes belong in the export as FILES (FB-E), so this projection carries no bytes and no
        // image metadata; it must never grow an `operator_note`.
        const feedback = (await client.query(
          `SELECT feedback_id, kind, category, body, route, exam_id, set_id, version, item_id,
                  guide_id, section_id, run_id, interface_language, app_version, survey_round,
                  survey_answers, status, created_at, handled_at
             FROM pilot_feedback WHERE owner_id = $1 ORDER BY created_at, feedback_id`, [owner])).rows;
        return { provider_attempts, preparations, balances, attempts, submissions, results, objective_evidence, mock_runs, mock_writing, mock_run_time_groups, listening_playback, payment_orders, payment_events, payment_grants, payment_checkout_events,
          feedback,
          writing_explanation_representations,writing_explanation_heads,shared_explanation_representations };
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
                  d.revision, a.created_at,(SELECT run_id FROM mock_writing WHERE attempt_id=a.id) AS mock_run_id
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
          mock_run_id:row.mock_run_id??null,
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
        await lockMockOwner(client,owner);
        const attempt = await owned(client, owner, id);
        // An unresolved historical row has no admission subject; retain its explicit recovery error.
        if (!attempt.preparation_id) fail(422, 'preparation_unresolved');
        await requireWritingMutation(client,attempt,{});
        const current = await draftOf(client, id);
        if (!current || current.revision !== expectedRevision) fail(409, 'draft_conflict');
        const submitted = first(await client.query('SELECT id FROM submissions WHERE attempt_id = $1', [id]));
        if (submitted) fail(409, 'revision_required');
        await requireEditableContext(client, owner, attempt);
        return first(await client.query(
          'UPDATE drafts SET revision = revision + 1, text = $2 WHERE attempt_id = $1 RETURNING revision, text', [id, text]));
      });
    },

    async submit(owner, id, expectedRevision, eventId, explanationLanguage = 'de') {
      note('submit');
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1 ||
          typeof eventId !== 'string' || !UUID_RE.test(eventId)) fail(422, 'invalid_submission');
      return settle(owner, async (client) => {
        await lockMockOwner(client,owner);
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
        await requireWritingMutation(client,attempt,{standalone:true});
        // An unresolved legacy attempt stays readable, but cannot spend a credit of a guessed exam.
        if (!attempt.preparation_id || !attempt.exam_id) fail(422, 'preparation_unresolved');
        await requireActivePreparation(client, owner, attempt.preparation_id);
        await requireServableBinding(client, bindingOf(attempt),true);
        const draft = await draftOf(client, id);
        if (!draft || draft.revision !== expectedRevision) fail(409, 'draft_conflict');
        if (!draft.text.trim()) fail(422, 'empty_submission');
        if (first(await client.query('SELECT id FROM submissions WHERE attempt_id = $1', [id]))) fail(409, 'already_submitted');
        if (!entitlement || entitlementExpired(entitlement) || entitlement.used + entitlement.reserved >= entitlement.allowance) fail(409, 'allowance_exhausted');
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

    async result(owner, submissionId, {explanationLanguage:requestedLanguage=null}={}) {
      note('result');
      explanationLanguage(requestedLanguage);
      return settle(owner, async (client) => {
        const submission = first(await client.query(
          'SELECT * FROM submissions WHERE id = $1 AND owner_id = $2', [submissionId, owner]));
        if (!submission) fail(404, 'not_found');
        const attempt = await owned(client, owner, submission.attempt_id);
        const job = first(await client.query(
          'SELECT status, failure_code, tries FROM jobs WHERE submission_id = $1', [submissionId]));
        const assessment = first(await client.query(
          'SELECT feedback, model_version, prompt_version, rubric_version FROM assessments WHERE submission_id = $1', [submissionId]));
        const content=await historicalContent(client,attempt,{completed:Boolean(assessment)});
        const attachment=first(await client.query('SELECT failure_code FROM mock_writing WHERE submission_id=$1 AND owner_id=$2',[submissionId,owner]));
        let explanation_view;
        if(content.blocked_reason)explanation_view=blockedExplanation(requestedLanguage);
        else if(!assessment)explanation_view=unavailableExplanationView({requestedLanguage,state:'not_assessed',
          reason:['failed','cancelled','unassessed'].includes(job?.status)||attachment?.failure_code?'assessment_failed':'assessment_pending'});
        else {
          const source=extractWritingExplanationSource({ownerId:owner,attempt,submission,assessment});
          explanation_view=await projectStoredExplanation(client,{source,...await readExplanationRepresentations(client,{source})},requestedLanguage);
        }
        return { submission, job:job??(attachment?.failure_code?{status:'unassessed',failure_code:attachment.failure_code,tries:0}:null), assessment:content.blocked_reason?null:assessment ?? null,
          explanation_view,
          task_id: attempt.task_id, task_version: submission.task_version,
          rubric_id: attempt.rubric_id, rubric_version: submission.rubric_version,
          parent_submission_id: attempt.parent_submission_id,
          preparation_id: attempt.preparation_id ?? null, exam_id: attempt.exam_id ?? null,
          ...content };
      });
    },

    async readObjectiveEvidenceExplanation(owner,evidenceId,{language=null}={}) {
      note('readObjectiveEvidenceExplanation');explanationLanguage(language);
      return settle(owner,async client=>{
        try {
          const bundle=await objectiveExplanationBundle(client,evidenceId,language);
          return bundle?await projectStoredExplanation(client,bundle,language):blockedExplanation(language);
        } catch(error) {
          if(error?.message==='explanation_content_blocked')return blockedExplanation(language);
          return explanationFault(error);
        }
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
        await lockMockOwner(client,owner);
        const credit = first(await client.query(
          `SELECT j.exam_id FROM jobs j JOIN submissions s ON s.id = j.submission_id
            WHERE j.submission_id = $1 AND s.owner_id = $2`, [submissionId, owner]));
        if (!credit) fail(404, 'not_found');
        const entitlement = await lockBalance(client, owner, credit.exam_id);
        const submission = first(await client.query(
          'SELECT * FROM submissions WHERE id = $1 AND owner_id = $2', [submissionId, owner]));
        if (!submission) fail(404, 'not_found');
        const attempt = await owned(client, owner, submission.attempt_id);
        if(attempt.exam_id) await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,7351))',[attempt.exam_id]);
        const context=await writingContext(client,attempt);
        if(context.blocked_reason) fail(409,context.blocked_reason);
        const job = first(await client.query(
          'SELECT * FROM jobs WHERE submission_id = $1 FOR UPDATE', [submissionId]));
        if (!job || job.status !== 'failed' || job.tries >= 3 || job.failure_code === 'retry_exhausted') {
          fail(409, 'retry_unavailable');
        }
        await requireServableBinding(client, bindingOf(attempt),true);
        if (!entitlement || entitlementExpired(entitlement) || entitlement.used + entitlement.reserved >= entitlement.allowance) fail(409, 'allowance_exhausted');
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
        await lockMockOwner(client,owner);
        // The same (owner, exam) balance lock `submit` takes first, so the two still serialise.
        const examId = await attemptExam(client, owner, id);
        if (examId) await lockBalance(client, owner, examId);
        const attempt = await owned(client, owner, id);
        if (!attempt.preparation_id) fail(422, 'preparation_unresolved');
        await requireWritingMutation(client,attempt,{standalone:true});
        if (first(await client.query('SELECT id FROM submissions WHERE attempt_id = $1 LIMIT 1', [id]))) {
          fail(409, 'submitted_attempt');
        }
        // Discarding a draft is an edit: refused while archived or unresolved (EXAM-S1-D).
        await requireEditableContext(client, owner, attempt);
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
  ['provider_attempt_observation','DELETE FROM provider_attempt_observation WHERE owner_id = $1'],
  ['provider_attempt','DELETE FROM provider_attempt WHERE owner_id = $1'],
  ['mock_writing', 'DELETE FROM mock_writing WHERE owner_id = $1'],
  ['attempts_unlinked', 'UPDATE attempts SET parent_submission_id = NULL WHERE owner_id = $1 AND parent_submission_id IS NOT NULL'],
  ['writing_explanation_head', 'DELETE FROM writing_explanation_head WHERE owner_id = $1'],
  ['writing_explanation_representation', 'DELETE FROM writing_explanation_representation WHERE owner_id = $1'],
  ['usage_ledger', 'DELETE FROM usage_ledger WHERE owner_id = $1'],
  ['assessments', 'DELETE FROM assessments WHERE owner_id = $1'],
  ['jobs', 'DELETE FROM jobs WHERE owner_id = $1'],
  ['drafts', 'DELETE FROM drafts WHERE attempt_id IN (SELECT id FROM attempts WHERE owner_id = $1)'],
  ['submissions', 'DELETE FROM submissions WHERE owner_id = $1'],
  ['attempts', 'DELETE FROM attempts WHERE owner_id = $1'],
  // EXAM-S1: evidence references a preparation, so it goes before the preparations it points at
  // (it would otherwise only cascade from "user", after the preparation delete had already failed).
  ['item_evidence', 'DELETE FROM item_evidence WHERE owner_id = $1'],
  // PRACTICE-01 (slice C): a practice attempt points at the preparation as well, so it is removed for
  // the same reason, before the preparations it references. PRACTICE-MEDIA (task-17) playback rows hang off
  // the sitting, so they go first (their events cascade from them, but the explicit order matches 0030's).
  ['practice_playback_event', 'DELETE FROM practice_playback_event WHERE owner_id = $1'],
  ['practice_playback', 'DELETE FROM practice_playback WHERE owner_id = $1'],
  ['practice_attempt', 'DELETE FROM practice_attempt WHERE owner_id = $1'],
  ['mock_run_event', 'DELETE FROM mock_run_event WHERE owner_id = $1'],
  ['listening_playback_event', 'DELETE FROM listening_playback_event WHERE owner_id = $1'],
  ['listening_playback', 'DELETE FROM listening_playback WHERE owner_id = $1'],
  ['mock_run_time_group', 'DELETE FROM mock_run_time_group WHERE owner_id = $1'],
  ['mock_run', 'DELETE FROM mock_run WHERE owner_id = $1'],
  ['learner_preparation', 'DELETE FROM learner_preparation WHERE owner_id = $1'],
  ['payment_grant', 'DELETE FROM payment_grant WHERE owner_id = $1'],
  ['payment_event', 'DELETE FROM payment_event WHERE owner_id = $1'],
  ['payment_checkout_event', 'DELETE FROM payment_checkout_event WHERE owner_id = $1'],
  ['payment_order', 'DELETE FROM payment_order WHERE owner_id = $1'],
  ['entitlements', 'DELETE FROM entitlements WHERE owner_id = $1'],
  ['learner_settings', 'DELETE FROM learner_settings WHERE user_id = $1'],
  ['session', 'DELETE FROM session WHERE "userId" = $1'],
  // PILOT-FEEDBACK-01 (0049, FB-A): the screenshot references its report, so it is deleted first; both
  // reference "user", so both precede it — the same ordering reason item_evidence precedes preparations above.
  ['pilot_feedback_screenshot', 'DELETE FROM pilot_feedback_screenshot WHERE owner_id = $1'],
  ['pilot_feedback', 'DELETE FROM pilot_feedback WHERE owner_id = $1'],
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
  ['provider_attempt_observation','owner_id = $1','owner'], ['provider_attempt','owner_id = $1','owner'],
  ['writing_explanation_head', 'owner_id = $1', 'owner'], ['writing_explanation_representation', 'owner_id = $1', 'owner'],
  ['payment_order', 'owner_id = $1', 'owner'], ['payment_event', 'owner_id = $1', 'owner'],
  ['payment_grant', 'owner_id = $1', 'owner'], ['payment_checkout_event', 'owner_id = $1', 'owner'],
  ['mock_writing', 'owner_id = $1', 'owner'],
  ['attempts', 'owner_id = $1', 'owner'], ['submissions', 'owner_id = $1', 'owner'],
  ['jobs', 'owner_id = $1', 'owner'], ['assessments', 'owner_id = $1', 'owner'],
  ['usage_ledger', 'owner_id = $1', 'owner'], ['entitlements', 'owner_id = $1', 'owner'],
  ['learner_settings', 'user_id = $1', 'owner'], ['session', '"userId" = $1', 'owner'],
  ['account', '"userId" = $1', 'owner'], ['drafts', 'attempt_id = ANY($1::uuid[])', 'attempts'],
  ['item_evidence', 'owner_id = $1', 'owner'],
  ['practice_attempt', 'owner_id = $1', 'owner'],
  ['practice_playback', 'owner_id = $1', 'owner'], ['practice_playback_event', 'owner_id = $1', 'owner'],
  ['mock_run', 'owner_id = $1', 'owner'], ['mock_run_event', 'owner_id = $1', 'owner'],
  ['listening_playback', 'owner_id = $1', 'owner'], ['listening_playback_event', 'owner_id = $1', 'owner'],
  ['mock_run_time_group', 'owner_id = $1', 'owner'],
  ['learner_preparation', 'owner_id = $1', 'owner'],
  // PILOT-FEEDBACK-01 (0049, FB-A): the learner's own reports, and at most one screenshot each.
  ['pilot_feedback', 'owner_id = $1', 'owner'],
  ['pilot_feedback_screenshot', 'owner_id = $1', 'owner'],
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
        await lockMockOwner(client, owner);
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

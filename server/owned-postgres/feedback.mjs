/**
 * PILOT-FEEDBACK-01 (slice FB-B) — the learner's own feedback: one report form for the whole app, and the survey.
 *
 * THE SHAPE OF THIS FILE follows the other `…Methods` modules (`practice-playback.mjs`, `playback.mjs`): a
 * factory returns plain async methods that the datastore spreads, all inside `settle`'s owner-bound transaction,
 * with unqualified table names because the pool's search_path is the installed schema.
 *
 * WHAT THE DATABASE ALREADY ENFORCES, so this file must NOT re-implement it:
 *   * `owner_id` cannot be forged — the INSERT policy's WITH CHECK binds it to the session (proved by leg 5b);
 *   * `status` is forced to 'new' and the triage columns to NULL — a learner cannot file a report that claims
 *     to be handled (legs 8 and 9);
 *   * `body` is required for a report and bounded, `route` is a closed list, and a survey's answers are checked
 *     against ITS round's question set (legs 10, 11, 14);
 *   * a second survey row for the same (owner, round) is refused by a unique partial index (leg 12).
 * Re-checking those here would create a second, weaker rule that can drift from the one that actually holds.
 * This layer adds what SQL cannot: the closed request field set, the context rule, and the 409/422 mapping.
 */
import { randomUUID } from 'node:crypto';

import { Fault } from '../owned-api.mjs';
import { FEEDBACK_CATEGORIES, FEEDBACK_ROUTES } from '../feedback-vocabulary.mjs';

const BODY_MAX = 2000;

export { FEEDBACK_CATEGORIES, FEEDBACK_ROUTES };

/** Today's account age in whole days, or null when the session has no owner. Definitive; see A13. */
const AGE_DAYS = 'feedback_account_age_days()';

export function feedbackMethods({ settle, note = () => {}, appVersion = 'unknown' } = {}) {
  if (typeof settle !== 'function') throw new TypeError('feedbackMethods requires the datastore settle helper');

  /**
   * THE CAPTURED CONTEXT, VALIDATED AND OTHERWISE DROPPED.
   *
   * It is the learner's own description that makes a report actionable, so a stale page must never cost them the
   * report. Each group is validated against a row the learner can actually see — their own run, an existing guide
   * section, an existing set — and if it does not check out the whole context is dropped and the report is saved
   * anyway, with `context: "dropped"` in the response so the client can say so.
   *
   * HONEST LIMIT, recorded in the contract: this proves the referenced row EXISTS and is the learner's own. It
   * does not prove they were *served* that item, and Stage 1 does not verify an `item_id` inside a set's payload
   * — an item id without a valid set is dropped rather than trusted. Context is advisory; it is never an access
   * decision, so the residual risk is a mislabelled report, not a leak.
   */
  async function resolveContext(client, owner, context) {
    const asked = Object.values(context).some((value) => value !== null && value !== undefined);
    if (!asked) return { context: null, dropped: false };

    const { runId, guideId, sectionId, examId, setId, version, itemId } = context;
    if (runId) {
      const own = (await client.query(
        `SELECT 1 FROM mock_run WHERE id = $1 AND owner_id = $2
         UNION ALL
         SELECT 1 FROM practice_attempt WHERE id = $1 AND owner_id = $2 LIMIT 1`, [runId, owner])).rowCount > 0;
      return own ? { context, dropped: false } : { context: null, dropped: true };
    }
    if (guideId && sectionId) {
      const found = (await client.query(
        'SELECT 1 FROM guide_section WHERE guide_id = $1 AND section_id = $2', [guideId, sectionId])).rowCount > 0;
      return found ? { context, dropped: false } : { context: null, dropped: true };
    }
    if (examId && setId && version) {
      const found = (await client.query(
        'SELECT 1 FROM objective_set WHERE exam_id = $1 AND set_id = $2 AND version = $3',
        [examId, setId, version])).rowCount > 0;
      // An item id is kept ONLY alongside a set that exists; it is never validated on its own (see above).
      return found ? { context, dropped: false } : { context: null, dropped: true };
    }
    return { context: null, dropped: true };
  }

  return Object.freeze({
    /** File a report. The API has already validated the closed field set, the category, the route and the body. */
    async createFeedback(owner, input) {
      note('createFeedback');
      const body = String(input.body).trim();
      if (!body || body.length > BODY_MAX) throw new Fault(422, 'invalid_body');
      return settle(owner, async (client) => {
        const { context, dropped } = await resolveContext(client, owner, input.context ?? {});
        const feedbackId = randomUUID();
        await client.query(
          `INSERT INTO pilot_feedback
             (feedback_id, owner_id, kind, category, body, route,
              exam_id, set_id, version, item_id, guide_id, section_id, run_id,
              interface_language, app_version)
           VALUES ($1,$2,'report',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
          [feedbackId, owner, input.category, body, input.route,
            context?.examId ?? null, context?.setId ?? null, context?.version ?? null, context?.itemId ?? null,
            context?.guideId ?? null, context?.sectionId ?? null, context?.runId ?? null,
            input.interfaceLanguage, appVersion]);
        return { feedback_id: feedbackId, ...(dropped ? { context: 'dropped' } : {}) };
      });
    },

    /**
     * The learner's own reports, newest first, WITHOUT `operator_note`.
     *
     * `operator_note` is the operator's internal triage record, not the learner's data — the contract excludes it
     * here and from the export. The SELECT policy already fences the owner; the explicit predicate is there so
     * the intent survives a change to the policy.
     */
    async listFeedback(owner) {
      note('listFeedback');
      return settle(owner, async (client) => (await client.query(
        `SELECT feedback_id, kind, category, body, route, exam_id, set_id, version, item_id,
                guide_id, section_id, run_id, interface_language, app_version, survey_round,
                survey_answers, status, created_at, handled_at
           FROM pilot_feedback
          WHERE owner_id = $1 AND kind = 'report'
          ORDER BY created_at DESC, feedback_id`, [owner])).rows, true);
    },

    /**
     * The open round this learner has neither answered nor skipped, if they are old enough. Otherwise null, and
     * the route answers 204.
     *
     * `feedback_account_age_days()` is a SECURITY DEFINER reader that takes NO argument (A13): the learner role
     * has no grant at all on `"user"`, so this is the only way to read the account's age, and taking no argument
     * is what stops one learner asking about another.
     */
    async currentSurveyRound(owner) {
      note('currentSurveyRound');
      return settle(owner, async (client) => {
        const round = (await client.query(
          `SELECT r.round_id, r.questions, r.opens_at, r.closes_at, r.min_account_age_days
             FROM survey_round r
            WHERE r.opens_at <= now() AND r.closes_at > now()
              AND COALESCE(${AGE_DAYS}, 0) >= r.min_account_age_days
              AND NOT EXISTS (SELECT 1 FROM pilot_feedback f
                               WHERE f.owner_id = $1 AND f.kind = 'survey' AND f.survey_round = r.round_id)
            ORDER BY r.opens_at DESC, r.round_id
            LIMIT 1`, [owner])).rows[0];
        return round ?? null;
      }, true);
    },

    /**
     * Answer a round, or skip it. A skip is a ROW with NULL answers, not the absence of one — that is what makes
     * "the learner is not asked again in this round" true.
     *
     * The answers themselves are validated by `0049`'s trigger against that round's question set, so an
     * out-of-range rating or an unknown question id is refused there rather than here. The unique partial index
     * makes a second submission a 23505, which this maps to a 409.
     */
    async submitSurvey(owner, roundId, input) {
      note('submitSurvey');
      return settle(owner, async (client) => {
        const round = (await client.query(
          'SELECT round_id, opens_at, closes_at FROM survey_round WHERE round_id = $1', [roundId])).rows[0];
        if (!round) throw new Fault(422, 'invalid_survey_round');
        const open = (await client.query(
          'SELECT (opens_at <= now() AND closes_at > now()) AS open FROM survey_round WHERE round_id = $1',
          [roundId])).rows[0].open;
        if (!open) throw new Fault(409, 'survey_round_closed');

        try {
          await client.query(
            `INSERT INTO pilot_feedback
               (feedback_id, owner_id, kind, route, interface_language, app_version, survey_round, survey_answers)
             VALUES ($1,$2,'survey',$3,$4,$5,$6,$7)`,
            [randomUUID(), owner, input.route ?? 'other', input.interfaceLanguage, appVersion, roundId,
              input.skip ? null : JSON.stringify(input.answers ?? {})]);
        } catch (error) {
          // The unique partial index is the second-submission guard; name it rather than leaking a 23505.
          if (error?.code === '23505') throw new Fault(409, 'survey_already_answered');
          throw error;
        }
        return { round_id: roundId, skipped: Boolean(input.skip) };
      });
    },
  });
}

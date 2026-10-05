/**
 * DRILL-01 (MIRROR-B1PREP-01 slice H) — the drill's PostgreSQL port: which part, which item, and the
 * per-item check with instant feedback.
 *
 * WHY THIS IS ITS OWN MODULE. `adapter.mjs` composes its port from one module per concern (`preparations`,
 * `mock-runs`, `playback`, `practice-playback`, …), and slice C's practice path lives inside the adapter
 * body. Slice H adds two methods and changes no slice-C behaviour, so it arrives the way task-17 did: a
 * spread of `drillMethods({ settle, note, catalogue })` into the adapter's returned object. The reviewed
 * practice methods are not touched.
 *
 * WHAT IS REUSED, NOT REBUILT:
 *   * `practice_attempt` (0044/0045, `mode` added by 0046) is the sitting. There is no drill table.
 *   * `item_evidence` is the answer record: one append-only row per answered item, `mock_run_id` NULL.
 *   * `mark_objective_item` (0015) decides right/wrong; `reveal_objective_answer` (0041) hands back the key
 *     ONLY once the learner's own evidence row exists — which is why `drillCheckItem` writes the evidence
 *     BEFORE it reads the key. That ordering IS the key-reveal guarantee; it is not a style choice.
 *   * `normalisePracticeSet` serves the set (and its items) WITHOUT any key; `selectPracticeSet` picks the
 *     set inside the chosen part; `practiceRoundState` reports the part's rounds; and the drill's own
 *     decisions — `rankDrillParts`, `pickDrillSitting`, `nextDrillItem`, `drillProgress` — are pure and live
 *     in `server/drill-sets.mjs`.
 *
 * ONE ITEM AT A TIME, IN SERVED ORDER. The drill answers a sitting strictly in the order the set serves its
 * items, and `drillCheckItem` refuses anything that is not the next one. That refusal is what makes
 * `practice_attempt.answered_count` an exact count of "items answered in this sitting" without a position
 * column and without a second table — and it is what lets an interrupted drill be resumed after a reload
 * instead of starting the set again.
 */
import { randomUUID } from 'node:crypto';
/* `Fault` is the owned API's own refusal type; the adapter imports it the same way. */
import { Fault } from './owned-api.mjs';
import { contentPolicy, servableReview } from './content-policy.mjs';
import { importedSetGate } from './owned-postgres/packages.mjs';
import { readCurrentReleaseEligibility } from './owned-postgres/release-eligibility.mjs';
import { requireActivePreparation, resolvePreparation } from './owned-postgres/preparations.mjs';
import { lockMockOwner } from './owned-postgres/mock-runs.mjs';
import { normalisePracticeSet, practiceRoundState, selectPracticeSet } from './practice-sets.mjs';
import { drillProgress, drillStatsFromEvidence, nextDrillItem, pickDrillSitting, playableEvidence, rankDrillParts, selectDrillTarget } from './drill-sets.mjs';

const fail = (status, code) => { throw new Fault(status, code); };
const first = (result) => result.rows[0];
const UUID_RE = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
/** The same item-id shape the runner's whole-set check accepts (`checkPracticeAttempt`). */
const ITEM_ID_RE = /^[A-Za-z0-9._-]{1,64}$/;

/** EXAM-S1: practice reads are scoped to one preparation; there is no all-preparations default. */
const requirePreparationContext = (preparationId) => {
  if (typeof preparationId !== 'string' || !UUID_RE.test(preparationId)) fail(422, 'preparation_required');
  return preparationId;
};

const payloadOf = (row) => (row?.payload && typeof row.payload === 'object' ? row.payload : {});
const playbackOf = (row) => (payloadOf(row).playback && typeof payloadOf(row).playback === 'object' ? payloadOf(row).playback : null);

/**
 * The servable objective sets of one exam, with the payload the normaliser needs.
 *
 * The SAME gate `practiceSetForPart` applies (released content version, imported set, servable review
 * status, servable rights) — read ONCE for the whole exam rather than once per part, because the drill's
 * choice is over PARTS and it has to see every part before it can rank them.
 */
const CANDIDATE_SQL = `SELECT s.set_id, s.version, s.title, s.family, s.section, s.part, s.item_count,
                              s.media_required, s.payload
                         FROM objective_set s
                         JOIN reviewed_content_version c ON c.content_version_id = s.content_version_id
                              LEFT JOIN content_rights cr ON cr.content_version_id = c.content_version_id
                        WHERE s.exam_id = $1
                          AND ${importedSetGate()}
                          AND c.review_status = ANY($2::text[])
                          AND COALESCE(cr.basis, c.rights_status) = ANY($3::text[])`;

/** One exact (set, version) under the same gate — the single-set read the per-item check needs. */
const SET_SQL = `SELECT s.set_id, s.version, s.title, s.exam_id, s.family, s.section, s.part, s.item_count,
                        s.media_required, s.payload
                   FROM objective_set s
                   JOIN reviewed_content_version c ON c.content_version_id = s.content_version_id
                        LEFT JOIN content_rights cr ON cr.content_version_id = c.content_version_id
                  WHERE s.set_id = $1 AND s.version = $2
                    AND ${importedSetGate()}
                    AND c.review_status = ANY($3::text[])
                    AND COALESCE(cr.basis, c.rights_status) = ANY($4::text[])`;

/**
 * DRILL-01 — the drill's two methods, ready to spread into the adapter's port.
 *
 * `settle` is the adapter's owner-bound transaction (it binds `hatoove.owner_id`, commits or rolls back);
 * `catalogue` is the server-side exam allowlist. Nothing else is taken from the adapter.
 */
export function drillMethods({ settle, note = () => {}, catalogue } = {}) {
  if (typeof settle !== 'function') throw new TypeError('drillMethods requires the adapter settle()');

  /** The set row, or `undefined`. A read: no state moves. */
  const readSet = async (client, setId, version, statuses) =>
    first(await client.query(SET_SQL, [setId, version, statuses, contentPolicy().rights]));

  /** The part's rounds, from the SAME counter slice C's wrap rule reads (every mode counts). */
  const readRound = async (client, owner, preparationId, family, setCount) => {
    const row = first(await client.query(
      `SELECT count(DISTINCT set_id)::int AS checked
         FROM practice_attempt
        WHERE owner_id = $1 AND preparation_id = $2 AND family = $3 AND state = 'checked'`,
      [owner, preparationId, family]));
    return practiceRoundState({ setCount, checkedSets: row ? row.checked : 0 });
  };

  /**
   * The drill's own open sitting for one part, or `undefined`.
   *
   * `mode = 'drill'` is the whole point of migration 0046: the runner's row is `'part'` and can never be
   * adopted here, while this row can never be handed to `checkPracticeAttempt`, which marks a WHOLE set
   * into the attempt it is given.
   */
  const readSitting = async (client, owner, preparationId, family) => pickDrillSitting((await client.query(
    `SELECT attempt_id, set_id, version, item_count, answered_count, created_at
       FROM practice_attempt
      WHERE owner_id = $1 AND preparation_id = $2 AND family = $3
        AND state = 'open' AND mode = 'drill'
      ORDER BY created_at DESC, attempt_id ASC
      LIMIT 5`, [owner, preparationId, family])).rows);

  return {
    /**
     * DRILL-01 — the next Einzelübung: the WEAKEST part that still has an unpractised item, the item
     * itself, and the sitting it belongs to.
     *
     * The decision is pure (`server/drill-sets.mjs`): parts are ranked weak → unseen → strong, weakest
     * accuracy first, then more recorded answers, then family. This method owns the reads, the admission
     * gate and the transaction, and it returns the rule's own numbers as the reason for its choice, so the
     * learner can be told "Ihr schwächster Teil: LV2 — 1 von 4 richtig" instead of handed an item.
     *
     * It reveals NOTHING: no key is read here, so a served item cannot leak one.
     */
    async drillNext(owner, { preparationId, serveReview = 'approved+unreviewed' } = {}) {
      note('drillNext');
      requirePreparationContext(preparationId);
      const statuses = servableReview(serveReview);
      return settle(owner, async (client) => {
        const { exam_id: examId } = await resolvePreparation(client, owner, preparationId);
        if (!(await readCurrentReleaseEligibility(client, examId, { catalogue })).eligible) return null;
        const candidates = (await client.query(CANDIDATE_SQL, [examId, statuses, contentPolicy().rights])).rows;
        if (!candidates.length) return null;
        /*
         * FIX-N1 — the evidence that may steer this choice. `playableEvidence` drops rows about a set this
         * deployment cannot serve or cannot play (a listening set has no practice playback path), so blind
         * guesses neither make a part look weak nor pick a set. `mock_run_id` is fetched because a result from a
         * run in which the recording PLAYED — the Probeprüfung — is not a blind guess and must still count.
         * The rows themselves stay in `item_evidence`: they are the learner's own history.
         */
        const evidence = playableEvidence((await client.query(
          `SELECT set_id, version, family, correct, answered_at, mock_run_id
             FROM item_evidence
            WHERE owner_id = $1 AND preparation_id = $2`, [owner, preparationId])).rows, candidates);
        /* The per-family numbers come from THAT evidence, in the pure layer, so the rule is one rule. */
        const partStats = drillStatsFromEvidence(evidence);
        const byFamily = new Map();
        for (const row of candidates) {
          const rows = byFamily.get(row.family) ?? [];
          rows.push(row);
          byFamily.set(row.family, rows);
        }
        const ranked = rankDrillParts({
          /* `media` is true when EVERY released set of the part needs media: the drill cannot play audio, so
             such a part is not a candidate (REVIEW-DRILL-01 H1 / `selectDrillTarget`). */
          families: [...byFamily.entries()].map(([family, rows]) => ({
            family, sets: rows.length, media: !rows.some((row) => row.media_required !== true),
          })),
          parts: partStats,
        });
        const target = selectDrillTarget(ranked);
        if (target.kind === 'listening_only') {
          /*
           * There is NOTHING PLAYABLE to drill: every part the ranking holds is a listening part, and the
           * client cannot play one. This is the honest note — no item to guess at, and no silent switch to a
           * part the learner is not weak in. Nothing is written: no sitting, no evidence, no key.
           *
           * This is deliberately the RARE outcome (FIX-F1): a weak listening part no longer stops the walk, so
           * the learner normally gets the weakest part they CAN practise. The card appears only when that part
           * does not exist.
           */
          return {
            preparation_id: preparationId,
            exam_id: examId,
            blocked: 'listening',
            family: target.part.family,
            /* The part's section, so the client can print the exam play rule for it. */
            section: byFamily.get(target.part.family)?.[0]?.section ?? null,
            reason: target.part.tier,
            /*
             * FIX-N1 — THE SAME NUMBERS THE FILTER USES. These come from `drillStatsFromEvidence` over the
             * evidence `playableEvidence` kept, so they can no longer be "0 von 0 richtig" for a part the drill
             * calls the weakest: if the part ranks as `weak` there is counted evidence behind it, and if there
             * is none the tier is `unseen`, which the copy distinguishes (the client switches key on
             * `attempts === 0` rather than printing a contradiction).
             */
            evidence: { attempts: target.part.attempts, correct: target.part.correct, accuracy: target.part.accuracy },
            attempt: null,
            round: null,
            set: null,
            item: null,
            progress: null,
          };
        }
        if (target.kind === 'none') return null;
        for (const part of [target.part, ...ranked.filter((row) => row !== target.part)]) {
          const rows = (byFamily.get(part.family) ?? []).filter((row) => row.media_required !== true);
          if (!rows.length) continue;
          /* Continue the drill's own sitting when it still has an unpractised item; otherwise open one. */
          let served = null;
          let answeredCount = 0;
          let attemptId = null;
          let resumed = false;
          const sitting = await readSitting(client, owner, preparationId, part.family);
          if (sitting) {
            const row = rows.find((entry) => entry.set_id === sitting.set_id && entry.version === sitting.version);
            if (row) {
              const carried = normalisePracticeSet({ ...row, items: undefined }, playbackOf(row));
              if (nextDrillItem(carried.items, sitting.answered_count)) {
                served = carried;
                answeredCount = sitting.answered_count;
                attemptId = sitting.attempt_id;
                resumed = true;
              }
            }
          }
          if (!served) {
            const chosen = selectPracticeSet(rows, evidence);
            if (!chosen) continue;
            const row = rows.find((entry) => entry.set_id === chosen.set_id && entry.version === chosen.version);
            if (!row) continue;
            served = normalisePracticeSet({ ...row, items: undefined }, playbackOf(row));
          }
          const item = nextDrillItem(served.items, answeredCount);
          /* A set with no item left (or none at all) cannot be drilled: the next part gets its turn rather
             than the learner being served an empty page. */
          if (!item) continue;
          if (!attemptId) {
            attemptId = randomUUID();
            await client.query(
              `INSERT INTO practice_attempt
                 (attempt_id, owner_id, exam_id, preparation_id, set_id, version, family, section, item_count, mode)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'drill')`,
              [attemptId, owner, examId, preparationId, served.set_id, served.version, served.family,
                served.section, served.item_count]);
          }
          return {
            preparation_id: preparationId,
            exam_id: examId,
            family: part.family,
            section: served.section,
            /* The tier IS the reason, and `evidence` is the numbers behind it. */
            reason: part.tier,
            evidence: { attempts: part.attempts, correct: part.correct, accuracy: part.accuracy },
            attempt: {
              attempt_id: attemptId, state: 'open', answered_count: answeredCount,
              item_count: served.item_count, resumed,
            },
            round: await readRound(client, owner, preparationId, part.family, rows.length),
            set: {
              set_id: served.set_id, version: served.version, title: served.title, family: served.family,
              section: served.section, part: served.part, item_count: served.item_count,
              media_required: served.media_required, playback: served.playback, material: served.material,
            },
            item,
            progress: drillProgress({ answeredCount, itemCount: served.item_count }),
          };
        }
        return null;
      }, false);
    },

    /**
     * DRILL-01 — mark ONE item of a drill sitting and answer "is it right, and why".
     *
     * The verdict is `mark_objective_item`'s; the key is `reveal_objective_answer`'s, read only AFTER the
     * learner's evidence row is written, so no caller can obtain a key for an item this learner has not
     * answered. An item that is not the NEXT one in the served order is refused (`item_out_of_order`) rather
     * than quietly appending a second evidence row, which is what keeps the sitting's counts exact.
     *
     * The sitting closes itself on its LAST item: `state = 'checked'` with the counts frozen, exactly the
     * shape slice C's wrap rule and the part index's rounds read. An abandoned sitting stays `open` and is
     * resumed by `drillNext`.
     */
    async drillCheckItem(owner, { preparationId, attemptId, itemId, answer, latencyMs } = {}) {
      note('drillCheckItem');
      requirePreparationContext(preparationId);
      if (typeof attemptId !== 'string' || !UUID_RE.test(attemptId)) fail(422, 'invalid_attempt');
      if (typeof itemId !== 'string' || !ITEM_ID_RE.test(itemId)) fail(422, 'invalid_item');
      if (answer === undefined) fail(422, 'invalid_answer');
      const statuses = servableReview();
      return settle(owner, async (client) => {
        /* The same owner lock every practice writer takes, so two concurrent checks cannot both read the
           same `answered_count` and both advance it. */
        await lockMockOwner(client, owner);
        const prep = await requireActivePreparation(client, owner, preparationId);
        const attempt = first(await client.query(
          `SELECT attempt_id, exam_id, preparation_id, set_id, version, family, section, item_count,
                  state, answered_count, mode
             FROM practice_attempt
            WHERE attempt_id = $1 AND owner_id = $2`, [attemptId, owner]));
        if (!attempt) fail(404, 'not_found');
        if (attempt.mode !== 'drill') fail(409, 'not_a_drill_sitting');
        if (attempt.preparation_id !== prep.id) fail(422, 'preparation_mismatch');
        if (attempt.state === 'checked') fail(409, 'drill_sitting_complete');
        const set = await readSet(client, attempt.set_id, attempt.version, statuses);
        if (!set) fail(404, 'not_found');
        /*
         * FIX-F1 — a listening set cannot be attempted honestly, so it must not be MARKED either. The drill no
         * longer opens a sitting for one (`selectDrillTarget` passes a media part over), so this is the
         * backstop for a sitting opened before that change: refuse rather than write a guess about audio the
         * learner never heard into `item_evidence`, where the ranking reads it. The same guard sits in
         * `checkPracticeAttempt`; both paths answer the same code.
         */
        if (set.media_required === true) fail(409, 'media_unavailable');
        const served = normalisePracticeSet({ ...set, items: undefined }, playbackOf(set));
        const index = served.items.findIndex((entry) => entry.item_id === itemId);
        if (index < 0) fail(422, 'unknown_item');
        if (index !== attempt.answered_count) fail(409, 'item_out_of_order');
        let marked;
        try {
          marked = first(await client.query(
            'SELECT mark_objective_item($1, $2, $3, $4::jsonb) AS correct',
            [attempt.set_id, attempt.version, itemId, JSON.stringify(answer)]));
        } catch (error) {
          if (/unknown_item/.test(error && error.message)) fail(422, 'unknown_item');
          throw error;
        }
        /* EVIDENCE FIRST, KEY SECOND. `reveal_objective_answer` returns a key only because this row exists. */
        const evidenceId = randomUUID();
        await client.query(
          `INSERT INTO item_evidence
             (evidence_id, owner_id, exam_id, set_id, version, item_id, family, section, answer, correct,
              latency_ms, preparation_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $12)`,
          [evidenceId, owner, attempt.exam_id, attempt.set_id, attempt.version, itemId, attempt.family,
            attempt.section, JSON.stringify(answer), marked.correct,
            Number.isSafeInteger(latencyMs) ? latencyMs : null, prep.id]);
        const revealed = first(await client.query(
          'SELECT reveal_objective_answer($1, $2, $3) AS expected', [attempt.set_id, attempt.version, itemId]));
        const counted = first(await client.query(
          `UPDATE practice_attempt
              SET answered_count = answered_count + 1,
                  correct_count = correct_count + CASE WHEN $3::boolean THEN 1 ELSE 0 END,
                  state = CASE WHEN answered_count + 1 >= item_count THEN 'checked' ELSE 'open' END,
                  checked_at = CASE WHEN answered_count + 1 >= item_count THEN now() ELSE NULL END
            WHERE attempt_id = $1 AND owner_id = $2 AND state = 'open'
        RETURNING answered_count, correct_count, item_count, state, checked_at`,
          [attemptId, owner, marked.correct]));
        if (!counted) fail(409, 'drill_sitting_complete');
        return {
          attempt_id: attemptId,
          set_id: attempt.set_id,
          version: attempt.version,
          family: attempt.family,
          section: attempt.section,
          item_id: itemId,
          correct: marked.correct,
          chosen: answer,
          expected: revealed ? revealed.expected : null,
          /* The route needs this to know whether the CHOICE-family explanation reader can serve the item at
             all (`0037` refuses a boolean answer and any media_required set), exactly as slice C's review. */
          answer_kind: revealed && typeof revealed.expected === 'boolean' ? 'judgement' : 'choice',
          media_required: set.media_required === true,
          evidence_id: evidenceId,
          explanation: null,
          answered_count: counted.answered_count,
          correct_count: counted.correct_count,
          item_count: counted.item_count,
          complete: counted.state === 'checked',
          checked_at: counted.checked_at ?? null,
        };
      }, false);
    },
  };
}

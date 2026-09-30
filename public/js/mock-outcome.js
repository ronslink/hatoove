/**
 * Honest outcomes for the written mock exercise.
 *
 * The mock can score the objective parts (Leseverstehen, Sprachbausteine,
 * Hoerverstehen) from stored answer keys. It cannot score Schreiben without a
 * model, and it cannot score Sprechen at all. This module therefore:
 *
 *   * keeps absent, too-short or failed writing explicitly **unassessed** -
 *     never a silent zero and never a points value derived from an offline
 *     heuristic;
 *   * marks successful model feedback as **provisional**, not an exam result;
 *   * aggregates objective practice points with their own denominator;
 *   * derives **no** whole-exam pass/fail, grade band or readiness percentage,
 *     because speaking is unassessed in this pilot.
 *
 * It is dependency-light (blueprint data only) so it runs unchanged in the
 * browser and under Node in `tools/mock-outcome-check.mjs`.
 */
import { PARTS } from './blueprint.js';

export const WRITING_PART = 'SA1';
/** telc B1 Schreiben is worth 45 points; that is the only denominator we show. */
export const WRITING_MAX = 45;
/** Below this word count a model judgment is not asked for at all. */
export const WRITING_MIN_WORDS = 40;

/** telc-B1 rubric maxima; a model reply is only accepted if it matches these. */
const CRITERIA_MAXIMA = { aufgabe: 15, kommunikation: 10, richtigkeit: 12, ausdruck: 8 };

const REASONS = new Set(['unavailable', 'too_short', 'malformed_feedback', 'feedback_failed']);

/**
 * Formative assessment of one mock writing block.
 *
 * Returns an entry whose `status` is `'unassessed'` unless a model reply was
 * received AND passed validation, in which case it is `'provisional'`. The
 * submitted `text` is always preserved so the learner can see what the app did
 * (or could not) judge.
 *
 * @param {object} input
 * @param {string} input.text        the learner's submitted text (kept verbatim)
 * @param {object} [input.task]      the writing task
 * @param {object} [input.analysis]  `engine.analyseWriting` output
 * @param {boolean} input.configured whether a model provider is configured
 * @param {Function} [input.grade]   `ai.gradeWriting`-shaped async grader
 */
export async function assessMockWriting({ text, task, analysis, configured, grade }) {
  const kept = typeof text === 'string' ? text : '';
  const entry = {
    partId: WRITING_PART,
    rubric: true,
    points: null,
    correct: null,
    total: 0,
    items: [],
    text: kept,
    task: task || null,
    analysis: analysis || null,
    aiResult: null,
    status: 'unassessed',
    reason: null,
  };

  if (!configured) return { ...entry, reason: 'unavailable' };
  if ((analysis?.words ?? 0) < WRITING_MIN_WORDS) return { ...entry, reason: 'too_short' };
  if (typeof grade !== 'function') return { ...entry, reason: 'unavailable' };

  let feedback;
  try {
    feedback = await grade({ text: kept, task, analysis });
  } catch {
    // Provider error strings may carry internal details; keep a stable reason.
    return { ...entry, reason: 'feedback_failed' };
  }
  if (!validFeedback(feedback)) return { ...entry, reason: 'malformed_feedback' };

  return {
    ...entry,
    points: Math.round(feedback.total),
    status: 'provisional',
    aiResult: feedback,
  };
}

/**
 * A model reply is provisional feedback, so it is only accepted when it is
 * internally consistent: four known criteria within their maxima, a total that
 * equals their sum, and the string/array fields the UI renders. Anything else
 * is treated as no feedback at all rather than trusted.
 */
export function validFeedback(value) {
  if (!value || !Number.isFinite(value.total) || value.total < 0 || value.total > WRITING_MAX) return false;
  if (!Array.isArray(value.criteria) || value.criteria.length !== 4) return false;
  const keys = new Set();
  let sum = 0;
  for (const criterion of value.criteria) {
    if (!criterion || !Object.hasOwn(CRITERIA_MAXIMA, criterion.key) || keys.has(criterion.key)) return false;
    if (!Number.isFinite(criterion.points) || criterion.points < 0 || criterion.points > CRITERIA_MAXIMA[criterion.key]) return false;
    if (!Number.isFinite(criterion.score) || criterion.score < 0 || criterion.score > 100) return false;
    keys.add(criterion.key);
    sum += criterion.points;
  }
  if (Math.abs(sum - value.total) >= 0.01) return false;
  if (!Array.isArray(value.corrections)) return false;
  if (!value.corrections.every((c) => c
    && ['original', 'corrected', 'explanation'].every((key) => typeof c[key] === 'string'))) return false;
  if (!['strengths', 'priorities'].every((key) => Array.isArray(value[key])
    && value[key].every((s) => typeof s === 'string'))) return false;
  return typeof value.modelAnswer === 'string';
}

/** Normalise a block result into the writing section of the summary. */
export function writingOutcome(entry) {
  const assessed = Boolean(entry)
    && entry.status === 'provisional'
    && Number.isFinite(entry.points);
  return {
    status: assessed ? 'provisional' : 'unassessed',
    reason: assessed ? null : (REASONS.has(entry?.reason) ? entry.reason : 'unassessed'),
    points: assessed ? entry.points : null,
    max: WRITING_MAX,
    text: typeof entry?.text === 'string' ? entry.text : '',
    words: entry?.analysis?.words ?? 0,
    analysis: entry?.analysis ?? null,
    aiResult: assessed ? entry.aiResult : null,
  };
}

/**
 * Aggregate the finished mock into an honest summary.
 *
 * Objective parts keep their own denominator (`points`/`max`). Writing is
 * reported separately and is never folded into the objective total. `pass`,
 * `band` and `readinessPercent` are always `null`: the pilot has no oral
 * assessment, so a whole-exam verdict cannot be computed, let alone shown.
 */
export function buildMockSummary(blockResults = []) {
  const byPart = {};
  let points = 0;
  let max = 0;
  let correct = 0;
  let total = 0;
  let writing = null;

  for (const entry of Array.isArray(blockResults) ? blockResults : []) {
    if (!entry || !entry.partId) continue;
    if (entry.rubric || entry.partId === WRITING_PART) {
      writing = writingOutcome(entry);
      continue;
    }
    const part = PARTS[entry.partId];
    if (!part) continue;
    const partTotal = Number.isFinite(entry.total) ? entry.total : 0;
    const partCorrect = Number.isFinite(entry.correct) ? entry.correct : 0;
    const partPoints = partTotal > 0 ? (part.pts * partCorrect) / partTotal : 0;
    byPart[entry.partId] = {
      group: part.group,
      label: part.label,
      correct: partCorrect,
      total: partTotal,
      points: partPoints,
      max: part.pts,
      percent: partTotal > 0 ? (partCorrect / partTotal) * 100 : 0,
    };
    points += partPoints;
    max += part.pts;
    correct += partCorrect;
    total += partTotal;
  }

  return {
    objective: { byPart, points, max, correct, total },
    writing,
    // Not computable in this pilot: Sprechen is not assessed here.
    pass: null,
    band: null,
    readinessPercent: null,
  };
}

/**
 * One completion per block, even when a timer, a click or a re-render races.
 *
 * `collect` and `commit` run at most once per gate. A completion that is no
 * longer current (the learner left the block, or a new mock started) is dropped
 * before `commit`, so a stale result can never be attached to a later mock.
 */
export function createCompletionGate() {
  let pending;
  return ({ isCurrent, collect, commit }) => {
    if (pending) return pending;
    if (!isCurrent()) return Promise.resolve(false);
    pending = Promise.resolve().then(collect).then((result) => {
      if (!isCurrent()) return false;
      commit(result);
      return true;
    });
    return pending;
  };
}

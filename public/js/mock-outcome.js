/**
 * Mock-exam outcomes: what the app may and may not claim.
 *
 * Hatoove's pilot assesses reading, language elements, listening and (provisionally)
 * writing. Speaking is NOT assessed here. Nothing in this module may therefore derive a
 * whole-exam pass/fail, a grade band or a readiness percentage: those would be claims the
 * pilot cannot support.
 *
 * Two rules drive the writing path:
 *   1. A missing, too-short, unavailable or failed assessment stays explicitly
 *      `unassessed` with `points: null`. It is never silently converted to zero.
 *   2. Successful AI feedback is `provisional` only, and a genuine zero from a complete
 *      rubric response is kept as `points: 0` - a legitimate zero, distinct from "missing".
 *
 * The module is dependency-free (no DOM, no store) so it can be exercised under `node --test`.
 */

export const WRITING_MAX = 45;

const WRITING_MAXIMA = { aufgabe: 15, kommunikation: 10, richtigkeit: 12, ausdruck: 8 };

/** Every reason a writing block can stay unassessed. Public, stable strings. */
export const WRITING_REASONS = Object.freeze({
  empty: 'kein Text abgegeben',
  unavailable: 'Feedback nicht verfügbar',
  too_short: 'Text zu kurz für belastbares Feedback',
  malformed_feedback: 'unvollständige Antwort des Anbieters',
  feedback_failed: 'Feedback konnte nicht abgerufen werden',
});

/** An unassessed entry that still preserves the learner's own text. */
function unassessed({ text, task, analysis, reason }) {
  return {
    partId: 'SA1',
    rubric: true,
    status: 'unassessed',
    reason,
    points: null,
    max: WRITING_MAX,
    correct: null,
    total: 0,
    items: [],
    text,
    task,
    analysis,
    aiResult: null,
  };
}

/**
 * True only for a complete, internally consistent rubric response.
 * Everything else - a partial object, an unknown criterion, points above the per-criterion
 * maximum, a total that does not equal the sum - is treated as malformed rather than trusted.
 */
export function isProvisionalFeedback(value) {
  if (!value || !Number.isFinite(value.total) || value.total < 0 || value.total > WRITING_MAX) return false;
  if (!Array.isArray(value.criteria) || value.criteria.length !== 4) return false;
  const seen = new Set();
  let sum = 0;
  for (const criterion of value.criteria) {
    if (!criterion || !Object.hasOwn(WRITING_MAXIMA, criterion.key) || seen.has(criterion.key)) return false;
    if (!Number.isFinite(criterion.points) || criterion.points < 0 || criterion.points > WRITING_MAXIMA[criterion.key]) return false;
    if (!Number.isFinite(criterion.score) || criterion.score < 0 || criterion.score > 100) return false;
    seen.add(criterion.key);
    sum += criterion.points;
  }
  if (Math.abs(sum - value.total) >= 0.01) return false;
  if (!Array.isArray(value.corrections) || !value.corrections.every((c) => c
    && ['original', 'corrected', 'explanation'].every((key) => typeof c[key] === 'string'))) return false;
  if (!['strengths', 'priorities'].every((key) => Array.isArray(value[key])
    && value[key].every((s) => typeof s === 'string'))) return false;
  return typeof value.modelAnswer === 'string';
}

/**
 * Assess the mock's writing block. A provider error, an absent provider or a malformed
 * response never becomes a mark: the entry stays unassessed with its text preserved.
 *
 * @param {object}   o
 * @param {string}   o.text       the learner's own text (kept either way)
 * @param {object}   o.task       the writing task
 * @param {object}   o.analysis   engine.analyseWriting output (offline hints, never marks)
 * @param {boolean}  o.configured whether an AI provider is configured
 * @param {Function} o.grade      the AI call, invoked only when feedback can be meaningful
 * @param {number}   [o.minWords] minimum word count for feedback (default 40)
 */
export async function assessMockWriting({ text, task, analysis, configured, grade, minWords = 40 }) {
  const body = String(text ?? '');
  const base = { text: body, task, analysis };
  if (!body.trim()) return unassessed({ ...base, reason: 'empty' });
  if (!configured) return unassessed({ ...base, reason: 'unavailable' });
  if (!(Number(analysis?.words) >= minWords)) return unassessed({ ...base, reason: 'too_short' });

  let feedback;
  try {
    feedback = await grade({ text: body, task, analysis });
  } catch {
    // Provider error strings may carry internal details; keep a stable public reason.
    return unassessed({ ...base, reason: 'feedback_failed' });
  }
  if (!isProvisionalFeedback(feedback)) return unassessed({ ...base, reason: 'malformed_feedback' });

  return {
    ...unassessed({ ...base, reason: null }),
    status: 'provisional',
    points: Math.round(feedback.total),
    aiResult: feedback,
  };
}

/**
 * Aggregate a finished mock honestly.
 *
 * Objective parts keep their own correct/total counts. The writing outcome is returned
 * separately and never folded into the objective denominator as a zero. The result object
 * deliberately contains no pass/fail, band, readiness percentage or overall score.
 */
export function summarizeMockOutcome(results = [], { objectiveMax = 180 } = {}) {
  const list = Array.isArray(results) ? results : [];
  const objectiveParts = [];
  let correct = 0;
  let total = 0;
  let writing = null;

  for (const r of list) {
    if (!r || typeof r !== 'object') continue;
    if (r.rubric) { writing = r; continue; }
    if (!Number.isFinite(r.correct) || !Number.isFinite(r.total) || r.total <= 0) continue;
    objectiveParts.push({ partId: r.partId, correct: r.correct, total: r.total });
    correct += r.correct;
    total += r.total;
  }

  return {
    objective: { correct, total, max: objectiveMax, parts: objectiveParts },
    writing: writing ? {
      partId: writing.partId,
      status: writing.status === 'provisional' ? 'provisional' : 'unassessed',
      reason: writing.reason ?? null,
      points: Number.isFinite(writing.points) ? writing.points : null,
      max: Number.isFinite(writing.max) ? writing.max : WRITING_MAX,
      hasText: Boolean(String(writing.text ?? '').trim()),
      text: String(writing.text ?? ''),
    } : null,
  };
}

/**
 * One completion per block, even when a timer, a click or a re-render races.
 *
 * `isCurrent` guards against a stale block: once the mock advances or is replaced, an
 * in-flight result is dropped instead of being committed to the wrong block or mock.
 */
export function createCompletionGate() {
  let pending = null;
  return ({ isCurrent, collect, commit }) => {
    if (pending) return pending;
    if (!isCurrent()) return Promise.resolve(false);
    pending = Promise.resolve()
      .then(collect)
      .then((result) => {
        if (!isCurrent()) return false;
        commit(result);
        return true;
      }, (error) => {
        pending = null; // a failed attempt must not lock the block forever
        throw error;
      });
    return pending;
  };
}

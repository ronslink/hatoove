/**
 * DRILL-01 (MIRROR-B1PREP-01 slice H) — which PART an Einzelübung drills, which item it serves next, and
 * which sitting it continues.
 *
 * PURE. No SQL, no connection, no policy: the adapter owns the read, the admission gate and the transaction,
 * and this module owns the DECISION — so the decision can be proved offline against crafted rows and
 * mutation-proved (`tools/drill-check.mjs` drives exactly that), the same split slice C uses in
 * `server/practice-sets.mjs`.
 *
 * ## WHAT "WEAK" MEANS, exactly
 *
 * A part is measured by the learner's OWN recorded answers for THIS preparation: `item_evidence` grouped by
 * `family`, which is the `parts[]` array `GET /api/v1/practice/progress` already serves. For one part:
 *
 *   attempts = count of that learner's evidence rows in the part
 *   correct  = count of those rows whose `correct` is true
 *   accuracy = correct / attempts, and `null` when attempts is 0
 *
 * `null` is NOT zero. A part the learner has never answered has no accuracy; calling it "0%" would invent
 * evidence and would make the first tap of a brand-new account look like a diagnosis.
 *
 * The three tiers, in the order the rule prefers them:
 *
 *   1. `weak`   — attempts > 0 AND accuracy < 1: the learner has actually got something wrong here. A part
 *                 with ANY recorded wrong answer is preferred over every unseen and every strong part,
 *                 because it is the only tier for which there is evidence of a weakness. Weakest first:
 *                 accuracy ascending.
 *   2. `unseen` — attempts === 0. No evidence either way. It outranks a strong part (nothing proven) and
 *                 yields to a weak one (something proven wrong).
 *   3. `strong` — attempts > 0 AND accuracy === 1: nothing recorded wrong yet. Drilled last.
 *
 * Within a tier the tie-breaks are, in order:
 *
 *   (a) accuracy ascending — the weakest part wins. `null` sorts as `1`, which only ever compares two unseen
 *       parts (all equal), so it never decides a cross-tier choice.
 *   (b) attempts DESCENDING — the same accuracy from MORE recorded answers is stronger evidence of the same
 *       weakness, and the part where the learner has more at stake. (Slice C's `nextPractice` breaks its
 *       section ties the other way, with attempts ascending, because it is choosing breadth of coverage;
 *       the drill is choosing where the weakness is, so it reads the evidence the other way round. Both are
 *       named; neither is an accident.)
 *   (c) family ascending — a TOTAL order, so the same evidence always yields the same part. A choice that
 *       changes between two identical requests is a bug, not personalisation.
 *
 * WHY NOT "unseen first", which slice C's `nextPractice` does for sections: the part index and the part
 * runner already cover the parts breadth-first, and a drill is the surface for the part the learner is
 * getting wrong. DRILL-01.md records the consequence honestly — a learner who keeps one part weak keeps
 * drilling it, and rotates only when that part's recorded accuracy stops being the lowest.
 */

/** The tier names, in the order the rule applies them. Exported so a check can name a tier. */
export const DRILL_TIERS = Object.freeze(['weak', 'unseen', 'strong']);

const isPlainObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const nonEmpty = (value) => (typeof value === 'string' && value.trim() ? value.trim() : null);
const count = (value) => (Number.isInteger(value) && value >= 0 ? value : 0);
const familyOf = (value) => {
  const family = nonEmpty(value);
  return family && /^[A-Za-z]{2}\d?$/.test(family) ? family : null;
};

/** One part's recorded evidence, normalised so a caller cannot mis-order the raw rows. */
export function drillPartStats(row) {
  if (!isPlainObject(row)) return null;
  const family = familyOf(row.family);
  if (!family) return null;
  const attempts = count(row.attempts);
  const correct = Math.min(count(row.correct), attempts);
  return Object.freeze({
    family,
    attempts,
    correct,
    wrong: attempts - correct,
    /* `null` for an unattempted part: not started is not the same as failed. */
    accuracy: attempts ? correct / attempts : null,
  });
}

/** Which tier one part belongs to. Exported because the tier IS the decision's first key. */
export function drillPartTier(stats) {
  if (!isPlainObject(stats)) return null;
  const attempts = count(stats.attempts);
  const correct = Math.min(count(stats.correct), attempts);
  if (attempts === 0) return 'unseen';
  return correct < attempts ? 'weak' : 'strong';
}

/**
 * Rank the parts the exam can actually serve, weakest first.
 *
 * `families` is what the deployment RELEASES: `[{family, sets}]`, one row per objective family with the
 * number of released sets it holds. `parts` is what the learner has DONE: `[{family, attempts, correct}]`,
 * the `parts[]` member of the practice-progress DTO.
 *
 * A family with no released set is not a candidate at all (it cannot be drilled), and evidence for a family
 * the deployment no longer serves is IGNORED rather than guessed at — the same rule slice C applies to
 * evidence for an unknown set.
 *
 * Returns a new array, best first, each row carrying the tier and the numbers behind it, so the caller can
 * explain its choice rather than assert it.
 */
export function rankDrillParts({ families, parts } = {}) {
  const released = new Map();
  for (const row of Array.isArray(families) ? families : []) {
    if (!isPlainObject(row)) continue;
    const family = familyOf(row.family);
    const sets = count(row.sets);
    if (!family || sets === 0) continue;
    released.set(family, (released.get(family) ?? 0) + sets);
  }
  const seen = new Map();
  for (const row of Array.isArray(parts) ? parts : []) {
    const stats = drillPartStats(row);
    if (!stats) continue;
    const current = seen.get(stats.family);
    seen.set(stats.family, current
      ? { family: stats.family, attempts: current.attempts + stats.attempts, correct: current.correct + stats.correct }
      : { family: stats.family, attempts: stats.attempts, correct: stats.correct });
  }
  const ranked = [...released.entries()].map(([family, sets]) => {
    const evidence = seen.get(family);
    const attempts = evidence ? evidence.attempts : 0;
    const correct = evidence ? Math.min(evidence.correct, attempts) : 0;
    const stats = { family, attempts, correct, wrong: attempts - correct, accuracy: attempts ? correct / attempts : null };
    return { ...stats, sets, tier: drillPartTier(stats) };
  });

  return ranked.sort((a, b) => {
    // 1. weak before unseen before strong.
    const at = DRILL_TIERS.indexOf(a.tier);
    const bt = DRILL_TIERS.indexOf(b.tier);
    if (at !== bt) return at - bt;
    // 2. the weakest accuracy first; an unseen part's null accuracy sorts with the unseen tier only.
    const av = a.accuracy === null ? 1 : a.accuracy;
    const bv = b.accuracy === null ? 1 : b.accuracy;
    if (av !== bv) return av - bv;
    // 3. more recorded answers first: the same accuracy on more evidence is the stronger claim.
    if (a.attempts !== b.attempts) return b.attempts - a.attempts;
    // 4. total order: the same evidence must always choose the same part.
    return a.family < b.family ? -1 : (a.family > b.family ? 1 : 0);
  });
}

/** The one part the drill opens now, or null when the deployment releases no part at all. */
export function selectDrillPart(input) {
  const ranked = rankDrillParts(input);
  return ranked.length ? ranked[0] : null;
}

/**
 * The drill's OWN sitting, out of the open attempts of one part.
 *
 * A drill sitting is an OPEN `practice_attempt` this learner's drill has already answered into. The caller
 * (the adapter's SQL) is what proves that: the runner never leaves a sitting open with answers in it —
 * `checkPracticeAttempt` writes every evidence row and the `checked` state in ONE transaction — so the rows
 * handed here are the adapter's filtered set, and this function only decides WHICH of them to continue.
 *
 * Most recent first, then `attempt_id` ascending, so the choice is total: continuing a different sitting on
 * two identical requests would be the same bug as selecting a different part twice.
 *
 * Returns `{attempt_id, set_id, version, item_count, answered_count}` or null.
 */
export function pickDrillSitting(openAttempts) {
  const rows = (Array.isArray(openAttempts) ? openAttempts : [])
    .filter((row) => isPlainObject(row) && nonEmpty(row.attempt_id) && nonEmpty(row.set_id) && nonEmpty(row.version))
    .map((row) => ({
      attempt_id: nonEmpty(row.attempt_id),
      set_id: nonEmpty(row.set_id),
      version: nonEmpty(row.version),
      item_count: count(row.item_count),
      answered_count: count(row.answered_count),
      created_at: nonEmpty(row.created_at) ?? (row.created_at instanceof Date ? row.created_at.toISOString() : null),
    }));
  if (!rows.length) return null;
  rows.sort((a, b) => {
    const at = a.created_at === null ? '' : a.created_at;
    const bt = b.created_at === null ? '' : b.created_at;
    if (at !== bt) return at < bt ? 1 : -1; // newest first
    return a.attempt_id < b.attempt_id ? -1 : (a.attempt_id > b.attempt_id ? 1 : 0);
  });
  return rows[0];
}

/**
 * The one item a drill sitting serves NOW: the next one in the set's SERVED order.
 *
 * A drill answers a sitting strictly in order — the per-item check refuses an item that is not the next one
 * — which is what makes `answered_count` an exact, unambiguous count of what has been answered in this
 * sitting, with no second table and no per-item position column. `null` therefore means the sitting is
 * exhausted, and the caller moves on rather than serving item one again.
 */
export function nextDrillItem(items, answeredCount) {
  const list = Array.isArray(items) ? items : [];
  const answered = Number.isInteger(answeredCount) && answeredCount > 0 ? answeredCount : 0;
  return answered < list.length ? list[answered] : null;
}

/** How far through its sitting a drill is. A count of what happened, never a score. */
export function drillProgress({ answeredCount, itemCount } = {}) {
  const total = count(itemCount);
  const answered = Math.min(count(answeredCount), total);
  return Object.freeze({ answered, total, complete: total > 0 && answered >= total });
}

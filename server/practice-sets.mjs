/**
 * PRACTICE-01 (MIRROR-B1PREP-01 slice C) — which released set a part serves next, and what the runner says
 * when the part is exhausted.
 *
 * PURE. No SQL, no policy, no connection: the adapter owns the read, the transaction and the admission gate;
 * this module owns the DECISION, so the decision can be proved offline against crafted evidence rows and
 * mutation-proved (tools/practice-selection-check.mjs drives exactly that).
 *
 * THE RULE (Ron's decision 3, contract §5 slice C): unseen sets first, then the sets with the most wrong
 * items, then the oldest. Every tie is broken by set id, so the same evidence always yields the same set —
 * a choice that changes between two identical requests is a bug, not personalisation.
 *
 * THE WRAP (A1: three released sets per part). The FOURTH "Noch ein Satz" must not silently start set one
 * again: with `setCount` sets and `checkedSets` already finished in this part, the tap that would begin
 * round `setCount + 1` returns a wrap notice instead. `practiceRoundState` is that rule, and
 * `practiceRunnerCheck` pins the message.
 */

/** The tier names, in the order the rule applies them. Exported so a check can name a tier. */
export const PRACTICE_TIERS = Object.freeze(['unseen', 'most-wrong', 'oldest']);

const isPlainObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const nonEmpty = (value) => (typeof value === 'string' && value.trim() ? value.trim() : null);
const positiveInt = (value) => (Number.isInteger(value) && value > 0 ? value : null);
const asTime = (value) => {
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'string' || typeof value === 'number') {
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return null;
};

/**
 * The evidence summary one candidate set is ranked by.
 *
 * `seen` counts the learner's answers in this set for THIS preparation; `wrong` counts the wrong ones;
 * `firstSeenAt` is when the learner first touched the set (the "oldest" tier reads it). Evidence for
 * another set, or a row without a `set_id`, is ignored rather than guessed at.
 */
export function summariseEvidence(candidates, evidence) {
  const bySet = new Map();
  const ids = new Set((Array.isArray(candidates) ? candidates : []).map((row) => nonEmpty(row?.set_id)).filter(Boolean));
  for (const row of Array.isArray(evidence) ? evidence : []) {
    if (!isPlainObject(row)) continue;
    const setId = nonEmpty(row.set_id);
    if (!setId || !ids.has(setId)) continue;
    const current = bySet.get(setId) || { setId, seen: 0, wrong: 0, firstSeenAt: null, lastSeenAt: null };
    current.seen += 1;
    if (row.correct === false) current.wrong += 1;
    const at = asTime(row.answered_at ?? row.answeredAt ?? null);
    if (at !== null) {
      if (current.firstSeenAt === null || at < current.firstSeenAt) current.firstSeenAt = at;
      if (current.lastSeenAt === null || at > current.lastSeenAt) current.lastSeenAt = at;
    }
    bySet.set(setId, current);
  }
  return bySet;
}

/**
 * Rank every candidate set by the rule. Returns a new array, best first, each entry carrying the tier it was
 * placed in and the numbers behind it, so the caller can explain the choice rather than assert it.
 */
export function rankPracticeSets(candidates, evidence) {
  const rows = (Array.isArray(candidates) ? candidates : []).filter(isPlainObject);
  const summary = summariseEvidence(rows, evidence);
  const ranked = rows.map((row) => {
    const setId = nonEmpty(row.set_id);
    if (!setId) return null;
    const stats = summary.get(setId) || { seen: 0, wrong: 0, firstSeenAt: null };
    return {
      set_id: setId,
      version: nonEmpty(row.version),
      item_count: positiveInt(row.item_count) ?? null,
      media_required: row.media_required === true,
      seen: stats.seen,
      wrong: stats.wrong,
      first_seen_at: stats.firstSeenAt === null ? null : new Date(stats.firstSeenAt).toISOString(),
      tier: stats.seen === 0 ? 'unseen' : (stats.wrong > 0 ? 'most-wrong' : 'oldest'),
    };
  }).filter(Boolean);

  return ranked.sort((a, b) => {
    // 1. unseen before seen.
    if ((a.seen === 0) !== (b.seen === 0)) return a.seen === 0 ? -1 : 1;
    // 2. most wrong items first (only meaningful among seen sets).
    if (a.wrong !== b.wrong) return b.wrong - a.wrong;
    // 3. oldest first; a set with no timestamp sorts last within its tier rather than first.
    const at = a.first_seen_at === null ? Infinity : Date.parse(a.first_seen_at);
    const bt = b.first_seen_at === null ? Infinity : Date.parse(b.first_seen_at);
    if (at !== bt) return at - bt;
    // 4. total order: the same evidence must always choose the same set.
    return a.set_id < b.set_id ? -1 : (a.set_id > b.set_id ? 1 : 0);
  });
}

/** The one set the part serves now, or null when the part has no released set at all. */
export function selectPracticeSet(candidates, evidence) {
  const ranked = rankPracticeSets(candidates, evidence);
  return ranked.length ? ranked[0] : null;
}

/**
 * The runner's round rule.
 *
 * `setCount` is how many released sets the part has (A1: three). `checkedSets` is how many DISTINCT sets of
 * this part the learner has already checked. The next tap is a wrap when every set is done — the fourth tap
 * of a three-set part — and the caller must then say the wrap message instead of starting set one again.
 *
 * `round` is the 1-based round the next tap begins, so the copy can be pinned without recomputing it.
 */
export function practiceRoundState({ setCount, checkedSets } = {}) {
  const total = positiveInt(setCount) ?? 0;
  const done = Number.isInteger(checkedSets) && checkedSets > 0 ? Math.min(checkedSets, total || checkedSets) : 0;
  const wrapped = total > 0 && done >= total;
  return Object.freeze({
    setCount: total,
    checkedSets: done,
    wrapped,
    round: wrapped ? total : done + 1,
    /* The exact string the check pins; the client renders the catalogue value for this key. */
    notice: wrapped ? 'practiceAllSets' : null,
  });
}

/**
 * The served shape of ONE set: the items the learner answers, without a key, a transcript or an explanation.
 *
 * `objective_set.payload` carries the authored items; anything that could reveal an answer is dropped here
 * rather than trusted to the caller, because this module is the last place before the wire.
 */
export function normalisePracticeSet(row, playback = null) {
  if (!isPlainObject(row)) throw new TypeError('practice_set_invalid');
  const setId = nonEmpty(row.set_id);
  const version = nonEmpty(row.version);
  if (!setId || !version) throw new TypeError('practice_set_invalid');
  const payload = isPlainObject(row.payload) ? row.payload : {};
  /* The authored member name is not assumed: if none of the known shapes is present this THROWS rather than
     serving an empty set, so a wrong assumption fails loudly instead of showing a blank page. */
  const rawItems = Array.isArray(payload.items) ? payload.items
    : (Array.isArray(payload.texts) ? payload.texts
      : (Array.isArray(payload.questions) ? payload.questions : null));
  if (!rawItems || !rawItems.length) throw new TypeError('practice_set_items_unknown');
  const items = rawItems.map((item, index) => {
    const itemId = nonEmpty(item?.item_id) ?? nonEmpty(item?.id);
    if (!itemId) throw new TypeError('practice_set_invalid');
    return Object.freeze({
      item_id: itemId,
      ordinal: Number.isInteger(item.ordinal) ? item.ordinal : index + 1,
      prompt: typeof item.prompt === 'string' ? item.prompt : '',
      prompt_en: typeof item.prompt_en === 'string' ? item.prompt_en : null,
      options: Array.isArray(item.options) ? item.options.map((option) => ({
        id: nonEmpty(option?.id) ?? String(option?.id ?? ''),
        text: typeof option?.text === 'string' ? option.text : '',
      })).filter((option) => option.id) : [],
    });
  });
  return Object.freeze({
    set_id: setId,
    version,
    title: typeof row.title === 'string' ? row.title : '',
    family: nonEmpty(row.family),
    section: nonEmpty(row.section),
    part: nonEmpty(row.part),
    item_count: positiveInt(row.item_count) ?? items.length,
    media_required: row.media_required === true,
    playback: playback && isPlainObject(playback) ? Object.freeze({ ...playback }) : null,
    items: Object.freeze(items),
  });
}

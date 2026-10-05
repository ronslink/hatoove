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
 * `setCount` is how many released sets this part has. That is THREE for every part except SB1, which has FOUR
 * (`telc-deutsch-b1.sb1.grammar-wortstellung-v1`, the recovered grammar drill from migration `0022`), so the
 * rule must count what the part actually serves rather than assume A1's three: the caller passes
 * `candidates.length`. `checkedSets` is how many DISTINCT sets of this part the learner has already checked.
 * The next tap is a wrap when every set is done — the FOURTH tap of a three-set part, the FIFTH of SB1's four —
 * and the caller must then say the wrap message instead of starting set one again.
 *
 * `round` is the 1-based round a tap BEGINS, which is why a wrap does not advance it: on a wrap no further
 * round begins, so `round` stays at the part's last round (`setCount`) and never exceeds it. A client can
 * therefore render "Runde {round} von {setCount}" without a special case, and reads `wrapped`/`notice` to
 * decide whether the tap happened at all. (REVIEW-PRACTICE-01-SERVER D4: the field was right and this comment
 * was wrong; the previous wording said "the round the next tap begins" unconditionally, which reads as 4 on a
 * three-set wrap. `round <= setCount` is now pinned by a leg.)
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
 * The authored item members of the released practice corpus, and the set-level option banks a member draws its
 * choices from. The DATABASE is the source of truth for the shape: every released set stores its items under
 * exactly one of these members, and its answer keys — `objective_key.answers` — are the stringified `id`/`n`
 * of those same items. This table exists so a well-formed authored set can never be mistaken for a malformed
 * one again: the first version of this module accepted `items`/`texts`/`questions`, read
 * `item.item_id ?? item.id`, and built options only from an ARRAY `item.options`, which was wrong for SEVEN of
 * the eight parts (LV2/HV1-HV3 threw `practice_set_invalid`, LV3/SB1/SB2 threw `practice_set_items_unknown`,
 * LV1 served an empty prompt). It had never been run against a database. Now it is, per family, and the legs
 * below pin the identity of each served item to the key.
 *
 * NOT ALL 25 SETS COME FROM ONE MIGRATION, and REVIEW-PRACTICE-01-SERVER D2 is why this is spelled out:
 * `0010-objective-catalogue.sql` seeds 24 of them; the 25th — `telc-deutsch-b1.sb1.grammar-wortstellung-v1`,
 * a 12-item grammar drill — comes from `0022-recovered-grammar-drills.sql`, sourced from
 * `content/drills/recovered-grammar.json`. So SB1 has FOUR released sets, and the A1 wrap for SB1 therefore
 * fires on the FIFTH tap, not the fourth. The drill is released practice content and is NOT filtered out; it
 * carries its own disclosure (`practice_kind`, `instruction`), which `MATERIAL_MEMBERS` now serves.
 */
const ITEM_MEMBERS = Object.freeze(['items', 'texts', 'questions', 'situations', 'gaps']);
/** The authored field that carries an item's text, most specific first. SB gaps have no text: the letter does. */
const PROMPT_FIELDS = Object.freeze(['question', 'statement', 'text']);
/** Set-level option banks, in resolution order, and the authored field that carries the option's text. */
const OPTION_BANKS = Object.freeze([
  Object.freeze({ member: 'headlines', text: 'text' }),
  Object.freeze({ member: 'ads', text: 'text' }),
  Object.freeze({ member: 'bank', text: 'word' }),
]);
/**
 * The authored set-level material a runner must render around the items. All public: keys live elsewhere.
 *
 * `practice_kind` and `instruction` are the set's OWN disclosure and were being dropped (D2). The recovered
 * grammar drill carries `practice_kind = 'grammar-drill'` and an instruction that says in as many words that
 * it is not a telc exam set — "Ergänze die Sätze. Dies sind einzelne Grammatikübungen, kein
 * telc-Prüfungssatz." A learner meeting 12 gap items with nothing saying so is the defect; the drill stays in
 * the corpus, labelled, rather than being hidden from the part it belongs to.
 *
 * `recordings` is the practice playback path's member (task-17): a packaged `fixed_audio` set carries its
 * recordings at set level, and without the member the serving path answered 500 for exactly the sets that
 * carry audio. REVIEW-PRACTICE-MEDIA F7 flagged that this line is where both slices diverge; the merge keeps
 * every member from both, which is the whole point of resolving it by union.
 */
const MATERIAL_MEMBERS = Object.freeze(['text', 'letter', 'headlines', 'ads', 'bank', 'practice_kind', 'instruction', 'recordings']);
/** LV3's "no ad fits" choice; `objectiveItems` (package-contract) adds the same sentinel and keys use it. */
const NO_MATCH = Object.freeze({ id: 'x', text: '', value: 'x' });

/**
 * One offered answer. `id` is the stable identity the review and the key speak in; `value` is the JSON value
 * to POST, which is the same string for a choice and a real BOOLEAN for a richtig/falsch item. The distinction
 * is not cosmetic: `mark_objective_item` compares jsonb (`expected = p_answer`), so an HV answer posted as the
 * string "true" is silently marked WRONG against the key's boolean `true`.
 */
const optionEntry = (id, text, value) => Object.freeze({
  id: String(id),
  text: typeof text === 'string' ? text : '',
  value: value === undefined ? String(id) : value,
});

/** The choices an authored item offers: its own object options, else its set's bank, else HV's truth pair. */
const authoredOptions = (item, payload) => {
  if (isPlainObject(item.options)) {
    return Object.entries(item.options).map(([id, text]) => optionEntry(id, text));
  }
  for (const bank of OPTION_BANKS) {
    const rows = payload[bank.member];
    if (!Array.isArray(rows) || !rows.length) continue;
    const options = rows.map((row) => optionEntry(row?.id ?? '', row?.[bank.text]));
    if (bank.member === 'ads' && !options.some((option) => option.id === NO_MATCH.id)) options.push(NO_MATCH);
    return options;
  }
  if (typeof item.statement === 'string') return [optionEntry('true', '', true), optionEntry('false', '', false)];
  return [];
};

/**
 * The authored item rows of a set.
 *
 * A PACKAGED `fixed_audio` set keeps its questions inside `recordings[]` — the `listening-package.json` shape
 * that slice A/B imports — rather than in a top-level member. Those questions ARE the items the learner
 * answers, so they are flattened here in recording order then question order, which is the order
 * `finalise_mock_run` and `objectiveItems` already use for the same payload. The recordings themselves stay in
 * `material.recordings`, so a runner can bind each item to the audio that carries it (each question's `n`).
 *
 * Returns `null` when the set carries no items at all, so the caller can fail loudly instead of serving a page
 * the learner cannot answer.
 */
const authoredItems = (payload) => {
  const member = ITEM_MEMBERS.find((name) => Array.isArray(payload[name]) && payload[name].length);
  if (member) return payload[member];
  if (Array.isArray(payload.recordings) && payload.recordings.length) {
    return payload.recordings.flatMap((recording) => {
      if (!isPlainObject(recording) || !Array.isArray(recording.questions) || !recording.questions.length) {
        throw new TypeError('practice_set_invalid');
      }
      return recording.questions;
    });
  }
  return null;
};

/**
 * The served shape of ONE set: the items the learner answers, without a key, a transcript or an explanation.
 *
 * Each item is REBUILT from named fields rather than spread from the payload, so a field that must never reach
 * the wire (an answer, a transcript, an explanation) cannot ride along even if the authored row grows one.
 * `item_id` is `String(item.id ?? item.n)`, which is exactly the key `objective_key.answers` uses.
 *
 * A set whose item member is absent, whose declared count disagrees with its authored rows, or whose items
 * offer no answer at all THROWS rather than serving a page the learner cannot answer.
 */
export function normalisePracticeSet(row, playback = null) {
  if (!isPlainObject(row)) throw new TypeError('practice_set_invalid');
  const setId = nonEmpty(row.set_id);
  const version = nonEmpty(row.version);
  if (!setId || !version) throw new TypeError('practice_set_invalid');
  const payload = isPlainObject(row.payload) ? row.payload : {};
  const rawItems = authoredItems(payload);
  if (!rawItems) throw new TypeError('practice_set_items_unknown');
  const declared = positiveInt(row.item_count);
  if (declared !== null && declared !== rawItems.length) throw new TypeError('practice_set_invalid');
  const items = rawItems.map((item, index) => {
    if (!isPlainObject(item)) throw new TypeError('practice_set_invalid');
    const rawId = item.id ?? item.n;
    if (typeof rawId !== 'string' && !Number.isSafeInteger(rawId)) throw new TypeError('practice_set_invalid');
    const promptField = PROMPT_FIELDS.find((field) => typeof item[field] === 'string');
    const options = authoredOptions(item, payload).filter((option) => option.id);
    if (!options.length) throw new TypeError('practice_set_invalid');
    return Object.freeze({
      item_id: String(rawId),
      ordinal: Number.isInteger(item.ordinal) ? item.ordinal : index + 1,
      prompt: promptField ? item[promptField] : '',
      prompt_en: typeof item.prompt_en === 'string' ? item.prompt_en : null,
      answer_kind: options.some((option) => typeof option.value === 'boolean') ? 'judgement' : 'choice',
      options: Object.freeze(options),
    });
  });
  const material = Object.fromEntries(MATERIAL_MEMBERS
    .filter((name) => payload[name] !== undefined)
    .map((name) => [name, payload[name]]));
  return Object.freeze({
    set_id: setId,
    version,
    title: typeof row.title === 'string' ? row.title : '',
    family: nonEmpty(row.family),
    section: nonEmpty(row.section),
    part: nonEmpty(row.part),
    item_count: declared ?? items.length,
    media_required: row.media_required === true,
    playback: playback && isPlainObject(playback) ? Object.freeze({ ...playback }) : null,
    material: Object.freeze(material),
    items: Object.freeze(items),
  });
}

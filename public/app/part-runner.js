/**
 * PRACTICE-01 (MIRROR-B1PREP-01 slice C) — the part runner.
 *
 * WHAT THIS IS. One part of the written examination, practised as a whole on ONE page, UNTIMED, with a
 * single "Auswerten" at the end. There is no per-item marking, no stepper and no clock: the learner
 * answers every task of the set, taps once, and gets the FULL review — the prompt, every option, their own
 * pick marked, the key marked, and the explanation in their chosen language.
 *
 * THE THREE ACTIONS. After the review there are exactly three, in this order:
 *   Noch ein Satz · Fehler üben · Zur Auswahl
 * "Noch ein Satz" asks the server for another released set of the same part; "Fehler üben" opens a fresh
 * sitting of the part and narrows the page to the tasks that were wrong; "Zur Auswahl" hands the same host
 * back to the index. When the part is exhausted the wrap is ANNOUNCED — "Alle Sätze dieses Teils geübt —
 * von vorn" — instead of silently starting set one again. **The tap is not fixed at four**: the count comes
 * from the served `round` (`setCount`/`checkedSets`/`wrapped`), so for a three-set part it is the fourth tap
 * and for SB1, whose fourth set is the migration-`0022` grammar drill (contract A9), it is the FIFTH.
 *
 * A FAILED "AUSWERTEN" IS AN ERROR, NOT A NOTICE. `checkFailureOf` classifies the refusal: a transport or
 * 5xx failure is RETRYABLE and keeps the "Auswerten" control as the retry; a closed sitting
 * (`attempt_already_checked` with no review on screen), an archived preparation, and every other refusal are
 * NOT retryable, so the alert says something true, "Auswerten" is disabled, and two ways forward are
 * offered. The copy promises a retry only where retrying can succeed.
 *
 * LISTENING, AND WHAT THIS MODULE REFUSES TO FAKE. The recordings EXIST as content
 * (`content/exams/telc-deutsch-b1/listening-package.json` carries the media ids, paths and sha256), but
 * there is no practice-bound PLAYBACK PATH: the shipped player is bound to a mock run
 * (`public/app/listening.js` -> `api.mock.media(run.id, …)`, accounted by `listening_playback` rows keyed
 * to a mock run). So the runner renders the player and the EXAM play rule read from
 * `/api/v1/exam-parts` (`playback.mock`, per family), DISABLES playback, and says which path is missing.
 * It never writes "the recording does not exist" — it does. A practice-bound media route reusing the
 * server's `plays_used`/`max_plays` accounting is its own queued slice.
 *
 * D22. Nothing here turns a count into a probability, a forecast, a readiness figure or a streak. The
 * review says "3 von 5 richtig" and nothing else; the source is the server's own marked verdicts.
 *
 * THE SEAM. The client consumes the DTO `server/practice-sets.mjs#normalisePracticeSet` is REQUIRED to
 * emit: per item `{item_id, ordinal, prompt, prompt_en, options:[{id,text}]}`. `readServedItems` also
 * tolerates the AUTHORED shapes the corpus is stored in as a RENDERING BRIDGE (item id from `id`/`n`,
 * prompt from `question`/`statement`/`text`, options from an array OR an object, option text from `text`
 * OR `word`, and the set-level option lists `headlines`/`ads`/`bank`), because the server half does not yet
 * build the DTO from that corpus (see the implementation note, "blocked on the server half"). The bridge is
 * not the contract: `tools/practice-runner-check.mjs` asserts the DTO shape in its own legs, separate from
 * the legs that pass only because of the bridge.
 */
import { getLocale, subscribeLocale } from '../assets/i18n/core.js';
import { pt } from '../assets/i18n/practice-messages.js';
import { validExplanationView, explanationStatus, EXPLANATION_LANGUAGES, EXPLANATION_LANGUAGE_NAMES } from './explanations.js';
import { createPracticeListeningPlayer, servedRecording } from './practice-listening.js';
import { taskLayout, answerTiles } from './task-layout.js';

const defaultEsc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const nonEmpty = value => (typeof value === 'string' && value.trim() ? value.trim() : null);
const countOrNull = value => (Number.isInteger(value) && value >= 0 ? value : null);
const t = (esc, key, parameters, locale) => esc(pt(key, parameters, locale));

/** The three actions after the review, in the order the learner reads them. */
export const RUNNER_ACTIONS = Object.freeze(['next', 'mistakes', 'index']);
/** The catalogue key of each action. `next` swaps to the wrap copy when the part is exhausted. */
export const ACTION_KEYS = Object.freeze({
  next: 'partRunnerStillOneSet',
  mistakes: 'partRunnerPractiseMistakes',
  index: 'partRunnerBackToIndex',
});
/** The key the SERVER names in `round.notice` (server/practice-sets.mjs) and the client renders. */
export const WRAP_KEY = 'practiceAllSets';
/** Shell section keys — the same mapping the shell uses (app.js SECTION_NAMES, part-index.js SECTION_KEYS). */
const SECTION_KEYS = Object.freeze({ LV: 'm002', SB: 'm003', HV: 'm004' });
/** The exam-language vocabulary of a richtig/falsch task. EXAM CONTENT, not interface copy: the corpus
 *  stores HV items as `{n, statement}` and its keys as booleans, so these are the two answers that exist.
 *  The served DTO carries a judgement item's options with an EMPTY `text` (the authored corpus has no option
 *  text for HV); the labels below are the exam's own words and fill that gap. */
const TRUE_FALSE = Object.freeze([
  Object.freeze({ id: 'true', text: 'richtig', value: true }),
  Object.freeze({ id: 'false', text: 'falsch', value: false }),
]);
/** The server's literal for a zwei-Antworten item (`server/practice-sets.mjs`: `answer_kind` is
 *  `'judgement'` or `'choice'`). The other spellings are accepted so a renamed constant degrades instead
 *  of breaking the page. */
const JUDGEMENT_KINDS = Object.freeze(['judgement', 'judgment', 'truth', 'boolean']);
/** LV3's "no advertisement fits" sentinel: served with an empty `text`, id `x`, value `x`. */
const NO_MATCH_ID = 'x';

/* ------------------------------------------------------------------------- normalisation */

/**
 * One option list, from the SERVED DTO or the authored shapes the rendering bridge still accepts.
 *
 * `value` is what gets POSTed, and the server's own `value` wins whenever it is there: `mark_objective_item`
 * compares JSONB with `expected = p_answer`, so an HV `true` posted as the string "true" is silently marked
 * WRONG. Without a served value the id is used, with the two boolean literals typed (the authored shapes
 * carry no `value`).
 */
export function readOptions(options) {
  const typed = id => (id === 'true' ? true : (id === 'false' ? false : id));
  const valueOf = (option, id) => {
    if (!option || !Object.hasOwn(option, 'value')) return typed(id);
    const value = option.value;
    return (typeof value === 'boolean' || typeof value === 'string' || typeof value === 'number') ? value : typed(id);
  };
  if (Array.isArray(options)) {
    return options.map((option) => {
      const id = nonEmpty(option?.id) ?? nonEmpty(option?.key);
      if (!id) return null;
      const text = typeof option?.text === 'string' ? option.text : (typeof option?.word === 'string' ? option.word : '');
      return { id, text, value: valueOf(option, id) };
    }).filter(Boolean);
  }
  if (options && typeof options === 'object') {
    return Object.entries(options)
      .filter(([id]) => typeof id === 'string' && id)
      .map(([id, text]) => ({ id, text: typeof text === 'string' ? text : '', value: typed(id) }));
  }
  return [];
}

/** The set-level option lists the authored corpus carries for LV1 (`headlines`), LV3 (`ads`), SB2 (`bank`). */
export function readSetOptions(payload) {
  if (!payload || typeof payload !== 'object') return [];
  for (const member of ['headlines', 'ads', 'bank']) {
    const options = readOptions(payload[member]);
    if (options.length) return options;
  }
  return [];
}

/** The two answers of a judgement item, with the exam's own labels (the served `text` is empty). */
function truthOptions() {
  return TRUE_FALSE.map(option => ({ ...option }));
}

/**
 * What the learner READS on an option.
 *
 * The served text wins. A judgement option has none, so the exam's own `richtig`/`falsch` fills it; a choice
 * option with none (the LV3 no-match sentinel) falls back to its id, which is the letter the answer key
 * speaks in.
 */
export function optionLabel(option, answerKind) {
  const text = nonEmpty(option?.text);
  if (text) return text;
  if (answerKind === 'judgement') return option?.value === true ? 'richtig' : (option?.value === false ? 'falsch' : String(option?.id ?? ''));
  return String(option?.id ?? '');
}

/**
 * The items of one served set, as the view needs them.
 *
 * PRIMARY SHAPE is the served DTO: `{item_id, ordinal, prompt, prompt_en, answer_kind, options:[{id,text,value}]}`.
 * The authored per-item shapes are still read as a RENDERING BRIDGE (item id from `id`/`n`, prompt from
 * `question`/`statement`/`text`, options from an array OR an object, the set-level `headlines`/`ads`/`bank`
 * lists, and the truth pair for a bare `statement`).
 *
 * `answer_kind` from the server decides the control; it is inferred only when the field is absent.
 *
 * Returns `{ items, blocked }`. `blocked` names a shape the page cannot practise honestly: `'item_id'` when
 * an item carries no id the server could mark, `'options'` when an item offers no answer at all — the page
 * then says so instead of rendering a task nobody can answer.
 */
export function readServedItems(set) {
  const payload = set && typeof set.payload === 'object' && set.payload ? set.payload : {};
  const member = ['items', 'texts', 'questions', 'situations', 'gaps']
    .map(name => (Array.isArray(payload[name]) ? payload[name] : null))
    .find(Boolean);
  const raw = Array.isArray(set?.items) && set.items.length ? set.items : (member ?? []);
  const setOptions = readSetOptions(payload);
  const items = [];
  for (const [index, entry] of raw.entries()) {
    if (!entry || typeof entry !== 'object') continue;
    const itemId = nonEmpty(entry.item_id) ?? nonEmpty(entry.id)
      ?? (entry.n === undefined || entry.n === null ? null : String(entry.n));
    if (!itemId) return { items: [], blocked: 'item_id' };
    const prompt = nonEmpty(entry.prompt) ?? nonEmpty(entry.question) ?? nonEmpty(entry.statement) ?? nonEmpty(entry.text) ?? '';
    let options = readOptions(entry.options);
    if (!options.length) options = setOptions;
    if (!options.length && typeof entry.statement === 'string') options = truthOptions();
    if (!options.length) return { items: [], blocked: 'options' };
    const servedKind = nonEmpty(entry.answer_kind);
    const answerKind = servedKind
      ? (JUDGEMENT_KINDS.includes(servedKind.toLowerCase()) ? 'judgement' : 'choice')
      : (options.some(option => typeof option.value === 'boolean') ? 'judgement' : 'choice');
    items.push({
      item_id: itemId,
      ordinal: Number.isInteger(entry.ordinal) ? entry.ordinal : index + 1,
      prompt,
      prompt_en: nonEmpty(entry.prompt_en),
      answer_kind: answerKind,
      options,
    });
  }
  return { items, blocked: items.length ? null : 'items' };
}

/**
 * The passages a set is worked from: LV2's `material.text`, SB1/SB2's `material.letter`.
 *
 * The option banks (`headlines`/`ads`/`bank`) are deliberately NOT rendered here: every item already carries
 * them as its own option list, and printing them twice would double the page for no gain.
 */
export function readMaterial(set) {
  const served = set && typeof set.material === 'object' && set.material && !Array.isArray(set.material) ? set.material : {};
  const payload = set && typeof set.payload === 'object' && set.payload ? set.payload : {};
  return {
    text: nonEmpty(served.text) ?? nonEmpty(payload.text),
    letter: nonEmpty(served.letter) ?? nonEmpty(payload.letter),
  };
}

/** The material blocks the view renders, in reading order. */
export function materialBlocks(set) {
  const material = readMaterial(set);
  return [
    material.text ? { kind: 'text', body: material.text } : null,
    material.letter ? { kind: 'letter', body: material.letter } : null,
  ].filter(Boolean);
}

/**
 * The disclosure a set carries when it is NOT a telc examination set.
 *
 * Amendment A9(c): the migration-`0022` grammar drill is "labelled, not filtered". The server must serve
 * `practice_kind`/`instruction` (it does not yet — see the note), and this module renders them **when they
 * arrive**: the instruction is authored content in the examination's language, so it stays an island and no
 * interface string is invented for it. The client does not decide that a set is a drill; it echoes what it
 * is told.
 */
export function readDisclosure(set) {
  const served = set && typeof set === 'object' && !Array.isArray(set) ? set : {};
  /* The server serves the disclosure INSIDE `material` (`MATERIAL_MEMBERS` gained `practice_kind` and
     `instruction`, server/practice-sets.mjs @905cc89); the top-level fallback keeps a set that carries them
     directly readable, and nothing is invented when neither is present. */
  const material = served.material && typeof served.material === 'object' && !Array.isArray(served.material) ? served.material : {};
  return {
    practiceKind: nonEmpty(material.practice_kind) ?? nonEmpty(served.practice_kind),
    instruction: nonEmpty(material.instruction) ?? nonEmpty(served.instruction),
  };
}

/**
 * How a refused "Auswerten" must be reported. Pure, so the check drives every branch without a server.
 *
 *  - `retryable`     a transport failure or a 5xx: the same request can succeed later, so the copy may
 *                    promise a retry and the "Auswerten" control stays the retry.
 *  - `recover-review` the sitting is already checked AND this view still holds the review: show it.
 *  - `closed`        the sitting is already checked and NO review ever arrived: retrying can only repeat
 *                    the 409, so the copy says so and "Auswerten" is disabled.
 *  - `archived`      the preparation is archived, refused by the transport before the request is sent.
 *  - `blocked`       anything else (400/401/404/422/428 and any other 409): a retry sends the same body.
 */
export function checkFailureOf(response, { hasReview = false } = {}) {
  const status = Number.isInteger(response?.status) ? response.status : 0;
  const code = nonEmpty(response?.error) ?? 'check_failed';
  if (status === 409 && code === 'attempt_already_checked') {
    return { code, status, kind: hasReview ? 'recover-review' : 'closed' };
  }
  if (status === 409 && code === 'preparation_archived') return { code, status, kind: 'archived' };
  if (status === 0 || status >= 500) return { code, status, kind: 'retryable' };
  return { code, status, kind: 'blocked' };
}

/** The catalogue key each failure kind prints; `recover-review` prints no alert at all. */
export const CHECK_FAILURE_KEYS = Object.freeze({
  retryable: 'partRunnerCheckFailed',
  closed: 'partRunnerCheckClosed',
  archived: 'partRunnerCheckArchived',
  blocked: 'partRunnerCheckBlocked',
});

/* ------------------------------------------------------------------------------- state */

function normaliseRound(round) {
  if (!round || typeof round !== 'object') return { setCount: null, checkedSets: null, wrapped: false, round: null, notice: null };
  return {
    setCount: countOrNull(round.setCount),
    checkedSets: countOrNull(round.checkedSets),
    wrapped: round.wrapped === true,
    round: countOrNull(round.round),
    notice: nonEmpty(round.notice),
  };
}

/** A fresh answering state for one served set. */
export function runnerStateFromServed({ family = '', response = {}, examRule = null, examLanguage = 'und' } = {}) {
  const data = response?.data ?? {};
  const set = data.set ?? null;
  const served = readServedItems(set);
  const round = normaliseRound(data.round);
  return {
    family: nonEmpty(data.family) ?? family,
    phase: 'answering',
    examLanguage,
    examRule: examRule ? { ...examRule } : null,
    section: nonEmpty(set?.section) ?? nonEmpty(examRule?.section),
    part: countOrNull(set?.part ?? examRule?.part),
    set: set ? { ...set, items: served.items } : null,
    blocked: served.blocked,
    reason: nonEmpty(data.reason),
    evidence: data.evidence && typeof data.evidence === 'object' ? { ...data.evidence } : null,
    attemptId: nonEmpty(data.attempt?.attempt_id),
    round,
    wrapNotice: round.wrapped === true,
    wrapNoticeKey: round.wrapped === true ? WRAP_KEY : null,
    mode: 'set',
    mistakesOf: null,
    answers: {},
    checked: null,
    notice: null,
    error: null,
    explanationLanguage: null,
    busy: false,
  };
}

/**
 * Narrow a freshly served set to the tasks that were wrong in the reviewed one (the "Fehler üben" round).
 * When none of the wrong item ids exist in the new set, the whole set is served and the state says so
 * rather than pretending the mistakes were carried over.
 */
export function applyMistakeRound(state, response, { examRule = null } = {}) {
  const next = runnerStateFromServed({ family: state.family, response, examRule: examRule ?? state.examRule, examLanguage: state.examLanguage });
  const wrong = Array.isArray(state.mistakesOf) ? state.mistakesOf : [];
  const offered = new Set(next.set?.items?.map(item => item.item_id) ?? []);
  const kept = wrong.filter(id => offered.has(id));
  next.mode = 'mistakes';
  if (kept.length && next.set) {
    next.set = { ...next.set, items: next.set.items.filter(item => kept.includes(item.item_id)) };
    next.mistakesOf = kept;
    next.notice = { key: 'partRunnerMistakesRound', parameters: { count: kept.length } };
  } else {
    next.mistakesOf = null;
    next.notice = { key: 'partRunnerMistakesElsewhere', parameters: {} };
  }
  return next;
}

/** The review state, from the server's checked response. Pure, so the check drives it without a server. */
export function applyChecked(state, checked, { explanationLanguage = null } = {}) {
  const items = Array.isArray(checked?.items) ? checked.items : [];
  const wrong = items.filter(item => item?.correct === false).map(item => String(item.item_id));
  return {
    ...state,
    phase: 'review',
    busy: false,
    error: null,
    checked: {
      ...checked,
      items,
      correct_count: countOrNull(checked?.correct_count) ?? items.filter(item => item?.correct === true).length,
      answered_count: countOrNull(checked?.answered_count) ?? items.length,
      item_count: countOrNull(checked?.item_count) ?? (state.set?.items?.length ?? items.length),
    },
    mistakesOf: state.mode === 'mistakes' && state.mistakesOf ? state.mistakesOf : wrong,
    explanationLanguage: explanationLanguage ?? state.explanationLanguage,
  };
}

/* ------------------------------------------------------------------------ the three actions */

/**
 * The three actions with the copy each one carries. `next` swaps to the A1 wrap copy once the part is
 * exhausted, so the restart is announced instead of silent; `mistakes` is present but disabled when the
 * reviewed set had nothing wrong (its `reason` names the key that says so).
 */
export function runnerActions(state, locale = getLocale()) {
  const checked = state.checked;
  const nothingWrong = checked ? (checked.answered_count ?? 0) - (checked.correct_count ?? 0) <= 0 : true;
  return RUNNER_ACTIONS.map((action) => {
    if (action === 'next') {
      const wrapped = state.round?.wrapped === true;
      return { action, key: wrapped ? WRAP_KEY : ACTION_KEYS.next, wrapped, disabled: state.busy === true, reason: null };
    }
    if (action === 'mistakes') {
      return { action, key: ACTION_KEYS.mistakes, wrapped: false, disabled: nothingWrong || state.busy === true, reason: nothingWrong ? 'partRunnerMistakesNone' : null };
    }
    return { action, key: ACTION_KEYS.index, wrapped: false, disabled: false, reason: null };
  });
}

/* ----------------------------------------------------------------------------- markup */

function languageAttributes(value) {
  return ' lang="' + defaultEsc(value || 'und') + '" dir="' + (value === 'ar' ? 'rtl' : 'ltr') + '"';
}

function sectionNameOf(section, uiText) {
  const key = SECTION_KEYS[section];
  return key ? uiText(key) : String(section ?? '');
}

/**
 * The passage a set is worked from, as an exam-language island (LV2's text, SB1/SB2's letter). The authored
 * passages carry blank-line paragraphs, so they are split rather than printed as one run-on line.
 */
function materialMarkup(state, { esc, examLanguage, locale }) {
  const blocks = materialBlocks(state?.set);
  if (!blocks.length) return '';
  return blocks.map(block => '<section class="part-runner-material" data-runner-material data-material-kind="' + esc(block.kind) + '">'
    + '<h2 class="part-runner-material-label small muted">' + t(esc, 'partRunnerMaterial', {}, locale) + '</h2>'
    + '<div class="part-runner-material-body"' + languageAttributes(examLanguage) + '>'
    + block.body.split(/\n{2,}/).map(paragraph => '<p>' + esc(paragraph.trim()) + '</p>').join('')
    + '</div></section>').join('');
}

/** The drill disclosure, printed only when the served set actually carries it (amendment A9(c)). */
function disclosureMarkup(state, { esc, examLanguage }) {
  const disclosure = readDisclosure(state?.set);
  if (!disclosure.instruction && !disclosure.practiceKind) return '';
  return '<section class="part-runner-disclosure" data-runner-disclosure'
    + (disclosure.practiceKind ? ' data-runner-practice-kind="' + esc(disclosure.practiceKind) + '"' : '') + '>'
    + (disclosure.instruction
      ? '<p class="part-runner-instruction" data-runner-instruction' + languageAttributes(examLanguage) + '>' + esc(disclosure.instruction) + '</p>'
      : '')
    + '</section>';
}

/**
 * A refused "Auswerten", as an ERROR rather than a muted notice.
 *
 * The alert is `role="alert"` with its own attribute, and the control set follows the classification: a
 * retryable failure leaves "Auswerten" as the retry, and every non-retryable one disables it and offers two
 * ways forward (`data-runner-recover`) so the learner is never told to repeat a request that cannot succeed.
 */
function checkFailureMarkup(state, { esc, locale }) {
  const failure = state?.checkFailure;
  const key = failure ? CHECK_FAILURE_KEYS[failure.kind] : null;
  if (!key) return '';
  const retryable = failure.kind === 'retryable';
  return '<p class="err part-runner-check-error" role="alert" data-runner-check-error="' + esc(failure.code) + '"'
    + ' data-runner-check-status="' + esc(String(failure.status)) + '" data-retryable="' + (retryable ? 'true' : 'false') + '">'
    + t(esc, key, {}, locale) + '</p>'
    + (retryable ? '' : '<div class="part-runner-actions part-runner-recovery" data-runner-recovery>'
      + '<button type="button" class="btn btn-primary" data-runner-recover="next">' + t(esc, 'partRunnerStillOneSet', {}, locale) + '</button>'
      + '<button type="button" class="btn" data-runner-recover="index">' + t(esc, 'partRunnerBackToIndex', {}, locale) + '</button>'
      + '</div>');
}

/** True when the answering form must NOT offer another attempt (a non-retryable refusal). */
function evaluateBlocked(state) {
  const kind = state?.checkFailure?.kind;
  return Boolean(kind) && kind !== 'retryable' && kind !== 'recover-review';
}

/** One option's visible label, plus the documented no-match hint when the server served no text for it. */
function optionTextMarkup(option, answerKind, { esc, locale }) {
  const label = optionLabel(option, answerKind);
  const noMatch = answerKind === 'choice' && !nonEmpty(option.text) && option.id === NO_MATCH_ID;
  return esc(label) + (noMatch ? ' <span class="small muted" data-option-nomatch>' + t(esc, 'partRunnerNoMatch', {}, locale) + '</span>' : '');
}

function reasonLine(state, locale) {
  const evidence = state.evidence ?? {};
  if (state.reason === 'unseen') return pt('partRunnerReasonUnseen', {}, locale);
  if (state.reason === 'most-wrong') return pt('partRunnerReasonMostWrong', { wrong: countOrNull(evidence.wrong) ?? 0, seen: countOrNull(evidence.seen) ?? 0 }, locale);
  if (state.reason === 'oldest') return pt('partRunnerReasonOldest', {}, locale);
  return null;
}

function audioMarkup(state, { esc, examLanguage, locale }) {
  const rule = state.examRule;
  const listening = Boolean(rule && rule.playback && Number.isInteger(rule.playback.practice))
    || state.section === 'HV' || state.set?.media_required === true;
  if (!listening) return '';
  const mock = countOrNull(rule?.playback?.mock);
  const practice = countOrNull(rule?.playback?.practice);
  const reviewed = state.phase === 'review';
  const recording = servedRecording(state?.set);
  const ruleLine = mock === null
    ? t(esc, 'partIndexPending', {}, locale)
    : t(esc, 'partRunnerAudioRule', { plays: mock }, locale);
  /*
   * TWO STATES, AND THEY MUST NOT READ ALIKE.
   *
   *   * the set carries `material.recordings[]` AND this view opened a sitting: the PRACTICE player is real
   *     (`practice-listening.js`), the play rule is the server's own, and the sentence printed here is the
   *     one-play-before-"Auswerten" rule rather than the exam's allowance line — because that is the rule the
   *     server will actually apply to this sitting.
   *   * otherwise (or after the transport has refused) the block keeps the FIX-F1 sentence for a set that
   *     cannot be played here. That path still exists and is still honest: the recordings exist, the practice
   *     playback path answered `practice_playback_unavailable`, and nothing claims otherwise.
   */
  const player = Boolean(recording) && Boolean(nonEmpty(state.attemptId));
  return '<section class="part-runner-audio" data-runner-audio'
    + ' data-audio-state="' + (player ? 'player' : 'unavailable') + '"'
    + (player ? ' data-runner-audio-source="practice"' : '')
    + (practice === null ? '' : ' data-playback-practice="' + esc(String(practice)) + '"')
    + (mock === null ? '' : ' data-playback-mock="' + esc(String(mock)) + '"')
    + ' aria-labelledby="part-runner-audio-title">'
    + '<h2 id="part-runner-audio-title" class="part-runner-audio-title">' + t(esc, 'partRunnerListening', {}, locale) + '</h2>'
    + '<div class="part-runner-player" data-runner-player role="group" aria-label="' + t(esc, 'partRunnerListening', {}, locale) + '">'
    + '<div class="part-runner-audio-mount" data-listening-mount></div>'
    + '<p class="small muted part-runner-play-rule" data-runner-play-rule>' + ruleLine + '</p>'
    + '</div>'
    + (player
      ? '<p class="hint" data-runner-playback-rule role="status">' + t(esc, 'partRunnerAudioReady', {}, locale) + '</p>'
      : '<p class="hint" data-runner-playback-missing role="status">' + t(esc, 'partRunnerAudioUnavailable', {}, locale) + '</p>')
    + (reviewed ? '' : '<p class="small muted" data-runner-replay-rule>' + t(esc, 'partRunnerNoReplay', {}, locale) + '</p>')
    + '</section>';
}

function answeringItemsMarkup(state, { esc, examLanguage, locale }) {
  const answered = state.answers ?? {};
  const items = state.set?.items ?? [];
  const rows = items.map(item => {
    const options = answerTiles(item, { answer: answered[item.item_id], esc, examLanguage, locale });
    return '<li class="part-runner-item" data-item-id="' + esc(item.item_id) + '" data-answered="' + (answered[item.item_id] ? 'true' : 'false') + '"'
      + ' data-item-options="' + esc(String(item.options.length)) + '" data-answer-kind="' + esc(item.answer_kind ?? 'choice') + '">'
      + '<p class="part-runner-item-label small muted">' + t(esc, 'partRunnerItem', { id: item.item_id }, locale) + '</p>'
      + '<p class="part-runner-prompt"' + languageAttributes(examLanguage) + '>' + esc(item.prompt) + '</p>'
      + (item.prompt_en ? '<p class="small muted part-runner-prompt-translation" lang="en" dir="ltr">' + esc(item.prompt_en) + '</p>' : '')
      + options
      + '</li>';
  }).join('');
  const total = items.length;
  const done = items.filter(item => answered[item.item_id]).length;
  const complete = total > 0 && done === total;
  return (taskLayout(state, { esc, examLanguage, locale }) ?? '<ol class="part-runner-items" data-runner-items data-item-count="' + esc(String(total)) + '">' + rows + '</ol>')
    + '<p class="small muted part-runner-progress" data-runner-progress data-answered="' + esc(String(done)) + '" data-total="' + esc(String(total)) + '" data-complete="' + (complete ? 'true' : 'false') + '">'
    + t(esc, 'partRunnerProgress', { answered: done, total }, locale)
    + (complete ? '' : ' · ' + t(esc, 'partRunnerAnswerAll', {}, locale)) + '</p>';
}

/**
 * The explanation prose of one reviewed item, from the projected `explanation-view-v1` DTO.
 *
 * A reviewed item whose explanation was NOT served is `null`, and since the server fix that is the HONEST
 * value for a judgement item and for any item of a media-required set (the choice-family reader cannot read
 * them, and a media-aware reader is a separate follow-up). `null` therefore renders "no explanation is
 * available for this task" — never the "not loaded yet" copy, which would promise something that is not
 * coming.
 */
export function explanationBlocks(view, locale = getLocale()) {
  if (!validExplanationView(view)) {
    return { status: pt('partRunnerExplanationUnavailable', {}, locale), blocks: [], language: null, state: 'unavailable' };
  }
  const blocks = view.representation && Array.isArray(view.representation.payload?.blocks) ? view.representation.payload.blocks : [];
  return { status: explanationStatus(view, locale), blocks, language: view.displayed_language ?? null, state: view.state ?? 'available' };
}

/** The language of the explanation, switchable in the review through the per-evidence read route.
 *  Offered only when at least one reviewed item actually HAS an explanation to re-read. */
function explanationLanguageMarkup(state, { esc, locale }) {
  const selectable = (state.checked?.items ?? []).filter(item => validExplanationView(item.explanation)).length > 0;
  if (!selectable) return '';
  const current = nonEmpty(state.explanationLanguage) ?? locale;
  const options = EXPLANATION_LANGUAGES.map(lang => '<option value="' + esc(lang) + '" lang="' + esc(lang) + '" dir="' + (lang === 'ar' ? 'rtl' : 'ltr') + '"'
    + (lang === current ? ' selected' : '') + '>' + esc(EXPLANATION_LANGUAGE_NAMES[lang]) + '</option>').join('');
  return '<div class="part-runner-explanation-language"><label class="field-label" for="part-runner-explanation-language">'
    + t(esc, 'expLanguage', {}, locale) + '</label>'
    + '<select class="select" id="part-runner-explanation-language" data-runner-explanation-language>' + options + '</select></div>';
}

function reviewItemsMarkup(state, { esc, examLanguage, locale }) {
  const reviewDetails = (item, result) => {
    const explanation = explanationBlocks(result?.explanation, locale);
    const verdict = result ? result.correct ? 'correct' : 'wrong' : 'unanswered';
    return '<span class="layout-review-detail"' + languageAttributes(locale) + '><span class="part-runner-verdict" tabindex="-1" role="status" data-review-verdict="' + verdict + '">' + t(esc, { correct: 'partRunnerCorrect', wrong: 'partRunnerWrong', unanswered: 'partRunnerUnanswered' }[verdict], {}, locale) + '</span>'
      + '<span class="part-runner-explanation" data-explanation-card data-explanation-for="' + esc(result?.evidence_id ?? '') + '"><span class="small muted" data-explanation-status="' + esc(explanation.state) + '">' + esc(explanation.status) + '</span>'
      + explanation.blocks.map(block => '<span class="part-runner-explanation-block" data-explanation-slot="' + esc(block.slot) + '"><span class="part-runner-explanation-label">' + t(esc, block.slot.startsWith('correction/') ? 'correctionHint' : 'explanation', {}, locale) + '</span><span class="part-runner-explanation-prose"' + languageAttributes(explanation.language) + '>' + esc(block.text) + '</span></span>').join('') + '</span></span>';
  };
  const shaped = taskLayout(state, { esc, examLanguage, locale, reviewDetails });
  if (shaped) return shaped;
  const checked = state.checked ?? {};
  const byId = new Map((checked.items ?? []).map(item => [String(item.item_id), item]));
  const keyOf = value => (value === undefined || value === null ? null : String(value));
  const rows = (state.set?.items ?? []).map((item) => {
    const result = byId.get(item.item_id) ?? null;
    const key = keyOf(result?.expected);
    const chosen = keyOf(result?.chosen);
    const options = answerTiles(item, { result, esc, examLanguage, locale });
    const verdict = result ? (result.correct === true ? 'correct' : 'wrong') : 'unanswered';
    const verdictKey = { correct: 'partRunnerCorrect', wrong: 'partRunnerWrong', unanswered: 'partRunnerUnanswered' }[verdict];
    const explanation = explanationBlocks(result?.explanation ?? null, locale);
    const evidenceId = nonEmpty(result?.evidence_id);
    return '<li class="part-runner-review-item" data-review-item="' + esc(item.item_id) + '" data-verdict="' + verdict + '">'
      + '<p class="part-runner-item-label small muted">' + t(esc, 'partRunnerItem', { id: item.item_id }, locale) + '</p>'
      + '<p class="part-runner-prompt"' + languageAttributes(examLanguage) + '>' + esc(item.prompt) + '</p>'
      + options
      + '<p class="part-runner-verdict" tabindex="-1" role="status" data-review-verdict="' + verdict + '">' + t(esc, verdictKey, {}, locale) + '</p>'
      + '<div class="part-runner-explanation" data-explanation-card data-explanation-for="' + esc(evidenceId ?? '') + '">'
      + (evidenceId ? '<p class="small muted part-runner-explanation-status" data-explanation-status="' + esc(explanation.state) + '">' + esc(explanation.status) + '</p>' : '')
      + (explanation.blocks.length
        ? '<div class="part-runner-explanation-body">' + explanation.blocks.map(block => '<div class="part-runner-explanation-block" data-explanation-slot="' + esc(block.slot) + '">'
          + '<p class="part-runner-explanation-label">' + t(esc, block.slot.startsWith('correction/') ? 'correctionHint' : 'explanation', {}, locale) + '</p>'
          + '<p class="part-runner-explanation-prose"' + languageAttributes(explanation.language) + '>' + esc(block.text) + '</p>'
          + '</div>').join('') + '</div>'
        : '')
      + '</div></li>';
  }).join('');
  return '<ol class="part-runner-items part-runner-review" data-runner-review>' + rows + '</ol>';
}

function actionsMarkup(state, { esc, locale }) {
  const actions = runnerActions(state, locale);
  return '<div class="part-runner-actions" data-runner-actions>'
    + actions.map(action => '<button type="button" class="btn' + (action.action === 'next' ? ' btn-go' : action.action === 'index' ? '' : ' btn-primary') + '"'
      + ' data-runner-action="' + esc(action.action) + '"'
      + (action.wrapped ? ' data-runner-wrap="true"' : '')
      + (action.disabled ? ' disabled aria-disabled="true"' : '')
      + (action.reason ? ' data-runner-action-reason="' + esc(action.reason) + '"' : '')
      + '>' + t(esc, action.key, {}, locale) + '</button>').join('')
    + '</div>';
}

/**
 * The runner's markup for one state. Pure and exported, so the check reads exactly the text the learner
 * reads — the same reason `part-index.js` exports `indexMarkup`.
 */
export function runnerMarkup(state, { esc = defaultEsc, uiText = key => key, examLanguage = 'und', locale = getLocale() } = {}) {
  const family = state?.family ?? '';
  const section = state?.section ?? (typeof family === 'string' ? family.slice(0, 2) : '');
  const rtl = locale === 'ar';
  const shell = key => esc(uiText(key));
  const heading = section ? shell(SECTION_KEYS[section] ?? '') : '';
  const partLabel = state?.part === null || state?.part === undefined ? '' : t(esc, 'part', { part: state.part }, locale);
  const authoredTitle = state?.set?.title || '';
  const title = /^(LV|SB|HV)\d+\s+\d+$/.test(authoredTitle) ? '' : authoredTitle;
  const wrapNotice = state?.wrapNotice && state?.wrapNoticeKey
    ? '<p class="part-runner-wrap-notice" data-runner-wrap-notice role="status">' + t(esc, state.wrapNoticeKey, {}, locale) + '</p>'
    : '';
  const notice = state?.notice
    ? '<p class="part-runner-notice small muted" data-runner-notice="' + esc(state.notice.key) + '">' + t(esc, state.notice.key, state.notice.parameters ?? {}, locale) + '</p>'
    : '';
  const reason = reasonLine(state, locale);
  const material = materialMarkup(state, { esc, examLanguage, locale });
  const header = '<header class="page-head part-runner-head"><div>'
    + '<h1 id="part-runner-title">' + heading + (partLabel ? ' · ' + partLabel : '') + '</h1>'
    + (title ? '<p class="part-runner-set-title"' + languageAttributes(examLanguage) + '>' + esc(title) + '</p>' : '')
    + '<p class="small muted part-runner-kicker-line">' + t(esc, 'partRunnerKicker', {}, locale) + '</p>'
    + (reason ? '<p class="small muted" data-runner-reason="' + esc(state.reason ?? '') + '">' + esc(reason) + '</p>' : '')
    + '<p class="part-runner-lead">' + t(esc, 'partRunnerLead', {}, locale) + '</p>'
    + '</div></header>';

  let body;
  if (state?.phase === 'loading') {
    body = '<p class="muted" data-runner-loading>' + t(esc, 'partRunnerLoading', {}, locale) + '</p>';
  } else if (state?.phase === 'empty') {
    /*
     * FIX-F1 — an EMPTY answer has two different causes and they must not read alike. The server stops serving
     * a part whose released sets all need audio (there is no playback path yet), so a listening part arrives
     * here as "nothing available": that is not "no set for this part", it is "this part cannot be practised in
     * the app yet", and the learner is told which one they are looking at rather than being left to guess why
     * a part they were promised does nothing.
     */
    const listening = state?.emptyReason === 'listening';
    body = '<p class="card" data-runner-empty' + (listening ? ' data-runner-empty-reason="listening"' : '') + '>'
      + t(esc, listening ? 'partRunnerListeningUnavailable' : 'partRunnerEmpty', {}, locale) + '</p>';
  } else if (state?.phase === 'error') {
    body = '<p class="err" role="alert" data-runner-error="' + esc(state.error?.code ?? 'failed') + '">' + t(esc, 'partRunnerFailed', {}, locale) + '</p>'
      + '<div class="part-runner-evaluate-row"><button type="button" class="btn" data-runner-retry>' + t(esc, 'partRunnerRetry', {}, locale) + '</button></div>';
  } else if (state?.blocked) {
    body = '<p class="err" role="alert" data-runner-blocked="' + esc(state.blocked) + '">' + t(esc, 'partRunnerNoOptions', {}, locale) + '</p>';
  } else if (state?.phase === 'review' && state.checked) {
    body = '<p class="part-runner-result" data-runner-result data-correct="' + esc(String(state.checked.correct_count)) + '" data-total="' + esc(String(state.checked.answered_count)) + '">'
      + t(esc, 'partRunnerResult', { correct: state.checked.correct_count, total: state.checked.answered_count }, locale) + '</p>'
      + explanationLanguageMarkup(state, { esc, locale })
      + reviewItemsMarkup(state, { esc, examLanguage, locale })
      + actionsMarkup(state, { esc, locale });
  } else {
    const answered = state?.answers ?? {};
    const items = state?.set?.items ?? [];
    const complete = items.length > 0 && items.every(item => answered[item.item_id]);
    const blocked = evaluateBlocked(state);
    const ready = complete && !state?.busy && !blocked;
    body = (state?.phase === 'checking'
      ? '<p class="muted" data-runner-checking role="status">' + t(esc, 'partRunnerEvaluating', {}, locale) + '</p>'
      : '')
      + checkFailureMarkup(state, { esc, locale })
      + answeringItemsMarkup(state, { esc, examLanguage, locale })
      + '<div class="part-runner-evaluate-row"><button type="button" class="btn btn-primary" data-runner-evaluate'
      + ' data-runner-evaluate-ready="' + (ready ? 'true' : 'false') + '"'
      + (ready ? '' : ' disabled aria-disabled="true"') + '>'
      + t(esc, state?.busy ? 'partRunnerEvaluating' : 'partRunnerEvaluate', {}, locale) + '</button></div>';
  }

  const feedbackContext = { examId: state?.set?.exam_id, setId: state?.set?.set_id, version: state?.set?.version };
  return '<section class="part-runner" data-part-runner data-feedback-context="' + esc(JSON.stringify(feedbackContext)) + '" data-runner-phase="' + esc(state?.phase ?? 'loading') + '" data-runner-family="' + esc(family) + '"'
    + ' lang="' + esc(locale) + '" dir="' + (rtl ? 'rtl' : 'ltr') + '" aria-labelledby="part-runner-title">'
    + header + wrapNotice + notice
    + ((state?.phase === 'answering' || state?.phase === 'checking' || state?.phase === 'review')
      ? disclosureMarkup(state, { esc, examLanguage }) + (family === 'LV2' || ['SB1', 'SB2'].includes(family) && taskLayout(state, { esc, examLanguage, locale }) ? '' : material)
      : '')
    + audioMarkup(state, { esc, examLanguage, locale }) + '<div class="layout-workspace' + (family === 'LV2' ? ' layout-reading' : '') + '">' + (family === 'LV2' ? material : '') + '<div class="layout-task-body">' + body + '</div></div>'
    + '</section>';
}

/* ------------------------------------------------------------------------------- the view */

/** Read the exam play rule for one part, from `/api/v1/exam-parts` (slice B). */
export async function readExamRule(api, family, providedParts = null) {
  const parts = Array.isArray(providedParts) ? providedParts : await readExamPartsThrough(api);
  const part = parts.find(entry => entry?.family === family) ?? null;
  if (!part) return null;
  const practice = countOrNull(part.playback?.practice);
  if (!practice) return { family, section: nonEmpty(part.section), part: countOrNull(part.part), itemCount: countOrNull(part.itemCount), playback: null };
  return {
    family,
    section: nonEmpty(part.section),
    part: countOrNull(part.part),
    itemCount: countOrNull(part.itemCount),
    playback: { practice, mock: countOrNull(part.playback?.mock) },
  };
}

/* A dynamic import, not a static one: `part-index.js` dynamically imports THIS module, and a static
   import back would make the two a cycle for no gain. Cached after the first open. */
async function readExamPartsThrough(api) {
  try {
    const module = await import('./part-index.js');
    if (typeof module.readExamParts !== 'function') return [];
    const result = await module.readExamParts(api);
    return Array.isArray(result?.parts) ? result.parts : [];
  } catch { return []; }
}

/**
 * The runner's own stylesheet, injected on mount.
 *
 * §4.2 gives a module its own CSS file, but the shell injects a stylesheet only for the module its ROUTE
 * names (`app.js` loads `part-index.css`); this module is composed INTO that one's host, so nothing else
 * would ever load `part-runner.css`. The href comes from `import.meta.url`, not the document, so it is
 * correct wherever the app is mounted. Idempotent, and a no-op without a document (the check drives the
 * module in Node).
 */
export function ensureStylesheet(doc = globalThis.document) {
  if (!doc || typeof doc.createElement !== 'function') return false;
  const href = new URL('./part-runner.css', import.meta.url).href;
  if (typeof doc.querySelector === 'function' && doc.querySelector('link[data-module-style="' + href + '"]')) return true;
  const link = doc.createElement('link');
  link.rel = 'stylesheet';
  link.href = href;
  link.dataset.moduleStyle = href;
  (doc.head ?? doc.body)?.append?.(link);
  return true;
}

/**
 * The frozen §4.2 interface: `createPartRunnerView(ctx)` → `{ mount(host), unmount() }`.
 *
 * `ctx` is the shell's `{ api, uiText, esc, language, examLanguage, navigate, state }` plus the two
 * members this composition adds — `family` (the part the tile opened) and `onBack` (how the index gets
 * its host back). No shell ctx member is added and no second route is registered.
 */
export function createPartRunnerView(ctx = {}) {
  const esc = typeof ctx.esc === 'function' ? ctx.esc : defaultEsc;
  const uiText = typeof ctx.uiText === 'function' ? ctx.uiText : key => key;
  const family = typeof ctx.family === 'string' ? ctx.family : '';
  const providedParts = Array.isArray(ctx.examParts) ? ctx.examParts : null;
  let host = null;
  let unsubscribe = null;
  let generation = 0;
  let state = {
    phase: 'loading', family, section: null, part: null, set: null, answers: {}, checked: null,
    round: { setCount: null, checkedSets: null, wrapped: false, round: null, notice: null },
    wrapNotice: false, wrapNoticeKey: null, notice: null, error: null, busy: false,
    examRule: null, examLanguage: ctx.examLanguage || 'und', reason: null, evidence: null,
    attemptId: null, blocked: null, mode: 'set', mistakesOf: null, explanationLanguage: null,
    checkFailure: null, emptyReason: null,
  };

  const renderOptions = () => ({ esc, uiText, examLanguage: ctx.examLanguage || 'und', locale: getLocale() });

  /*
   * THE PRACTICE PLAYER, one per view, created lazily because `part-runner.js` and
   * `practice-listening.js` must not import each other (the player imports the shared renderer in
   * `listening.js`; the runner only needs its factory). It renders into the mount point the audio block
   * carries and survives every re-render of the page around it: `syncPlayer()` re-points it at the new
   * node and the sitting — not the node — decides whether it is a new attempt.
   */
  let player = null;
  function playerFor() {
    if (!player) {
      player = createPracticeListeningPlayer({
        api: ctx.api, esc, getExamLanguage: () => ctx.examLanguage || 'und',
        canEdit: () => Boolean(host) && !state.busy,
        onChange: () => { if (host) render(); },
      });
    }
    return player;
  }
  function syncPlayer() {
    if (!host) return;
    const target = host.querySelector?.('[data-listening-mount]');
    const recording = servedRecording(state?.set);
    const attemptId = nonEmpty(state.attemptId);
    if (!target || !recording || !attemptId) { player?.dispose?.(); player = null; return; }
    playerFor().mount(target, { attemptId, recording });
  }

  function render() {
    if (!host) return;
    ctx.onPartIdentity?.(state.section, state.part);
    host.innerHTML = runnerMarkup(state, renderOptions());
    if (state.busy) for (const control of host.querySelectorAll?.('[data-answer-item], [data-gap-open]') ?? []) control.disabled = true;
    syncPlayer();
  }

  function unchecked() { return state.phase !== 'review' && Object.keys(state.answers ?? {}).length > 0; }
  function beforeUnload(event) { if (unchecked()) { event.preventDefault(); event.returnValue = ''; } }
  let leaveApproved = false;
  function canLeave() {
    if (!unchecked() || leaveApproved) return true;
    leaveApproved = globalThis.confirm?.(pt('layoutLeave', {}, getLocale())) === true;
    return leaveApproved;
  }

  /** One served response → the answering state. False when the caller must show its own state. */
  function adopt(response, { mistakeRound = false } = {}) {
    leaveApproved = false;
    const data = response?.data ?? {};
    if (!data.set) {
      /*
       * FIX-F1 — WHY there is no set decides the sentence. The server withholds a part whose released sets all
       * need audio (a listening part, until a practice playback transport exists), and that is a different
       * answer from "this part has no released set". The exam rule is the authority when it was read; the
       * section is the fallback, because the rule read can fail independently of the serving call.
       */
      const rule = state.examRule;
      const familyId = typeof family === 'string' ? family : '';
      const listening = Boolean(rule && rule.playback) || familyId.slice(0, 2) === 'HV';
      state = { ...state, phase: 'empty', busy: false, set: null, checked: null, error: null, answers: {},
        blocked: null, emptyReason: listening ? 'listening' : null };
      return true;
    }
    state = mistakeRound
      ? applyMistakeRound(state, response, { examRule: state.examRule })
      : runnerStateFromServed({ family, response, examRule: state.examRule, examLanguage: ctx.examLanguage || 'und' });
    return true;
  }

  async function load({ mistakeRound = false } = {}) {
    const ticket = ++generation;
    state = { ...state, phase: 'loading', busy: false, error: null, notice: null, blocked: null, answers: {}, checkFailure: null };
    render();
    const response = await Promise.resolve(ctx.api?.practice?.next?.(family) ?? { ok: false, status: 0, error: 'practice_unavailable' });
    if (ticket !== generation || !host) return false;
    if (!response?.ok) {
      state = { ...state, phase: 'error', error: { code: nonEmpty(response?.error) ?? 'practice_failed', status: response?.status ?? 0 } };
      render();
      return false;
    }
    state.examRule = await readExamRule(ctx.api, family, providedParts);
    if (ticket !== generation || !host) return false;
    adopt(response, { mistakeRound });
    render();
    return true;
  }

  async function evaluate() {
    if (state.busy) return false;
    const attemptId = nonEmpty(state.attemptId);
    const items = state.set?.items ?? [];
    const answers = items.map((item) => {
      const picked = state.answers?.[item.item_id];
      return picked ? { item_id: item.item_id, answer: picked.value } : null;
    }).filter(Boolean);
    if (!attemptId || !answers.length || answers.length !== items.length) return false;
    /* A non-retryable refusal has already been answered: never re-send the same body. */
    if (evaluateBlocked(state)) return false;
    /*
     * "AUSWERTEN" CLOSES THE LISTENING, so the player is flushed and frozen BEFORE the request goes out: the
     * sitting is about to become `checked`, and a play left running would be acknowledged against a sitting
     * that has already moved on. A refusal below un-freezes it, so a retry is still possible.
     */
    const ticket = ++generation;
    state = { ...state, phase: 'checking', busy: true, error: null, notice: null, checkFailure: null };
    render();
    const checkingPlayer = player;
    if (checkingPlayer) {
      try { if (!(await checkingPlayer.flush())) throw new Error('playback_flush_failed'); } catch {
        if (ticket !== generation || !host) return false;
        state = { ...state, phase: 'answering', busy: false, checkFailure: checkFailureOf({ ok: false, status: 0 }) };
        render();
        return false;
      }
      if (ticket !== generation || !host || player !== checkingPlayer) return false;
      checkingPlayer.freeze(true);
    }
    const language = typeof ctx.language === 'string' && ctx.language ? ctx.language : null;
    let response;
    try {
      response = await Promise.resolve(ctx.api?.practice?.check?.({ attemptId, answers, language })
        ?? { ok: false, status: 0, error: 'practice_unavailable' });
    } catch {
      response = { ok: false, status: 0, error: 'practice_unavailable' };
    }
    if (ticket !== generation || !host) return false;
    state = { ...state, busy: false };
    if (response?.ok) {
      state = applyChecked(state, response.data, { explanationLanguage: language });
      /* The sitting is checked now: the player says so, and offers the replay the allowance still permits. */
      player?.markChecked?.();
      render();
      host.querySelector?.('[data-review-verdict]')?.focus?.();
      return true;
    }
    const failure = checkFailureOf(response, { hasReview: Boolean(state.checked) });
    /* The sitting is checked and this view still holds the review: show it, and say why it came back. */
    if (failure.kind === 'recover-review') {
      state = { ...state, phase: 'review', checkFailure: null, notice: { key: 'partRunnerAlreadyChecked', parameters: {} } };
      render();
      return true;
    }
    /* Everything else is an ERROR on the page, not a muted notice: `checkFailureMarkup` says whether a retry
       can succeed and, when it cannot, disables "Auswerten" and offers two ways forward. */
    player?.freeze?.(failure.kind === 'retryable');
    state = { ...state, phase: 'answering', checkFailure: failure, notice: null, error: null };
    render();
    return false;
  }

  /** Re-read every reviewed item's explanation in the chosen language, through the existing route. */
  async function reloadExplanations(language) {
    const items = state.checked?.items ?? [];
    if (!items.length || typeof ctx.api?.practice?.explanation !== 'function') return false;
    const ticket = ++generation;
    const updated = await Promise.all(items.map(async (item) => {
      if (!nonEmpty(item.evidence_id)) return item;
      const response = await Promise.resolve(ctx.api.practice.explanation(item.evidence_id, language)).catch(() => null);
      return response?.ok ? { ...item, explanation: response.data } : item;
    }));
    if (ticket !== generation || !host) return false;
    state = { ...state, checked: { ...state.checked, items: updated }, explanationLanguage: language };
    render();
    return true;
  }

  /** Answer one item in place: the focus and the radio stay, only the facts around them change. */
  function answer(itemId, option) {
    if (state.busy || state.phase === 'review') return;
    leaveApproved = false;
    const answers = { ...state.answers };
    if (option) answers[itemId] = { key: option.id, value: option.value };
    else delete answers[itemId];
    state = { ...state, answers };
    const items = state.set?.items ?? [];
    const host$ = host;
    if (!host$) return;
    const row = host$.querySelector?.('[data-item-id="' + itemId + '"]');
    if (row) row.dataset.answered = String(Boolean(option));
    for (const tile of row?.querySelectorAll?.('[data-tile-state]') ?? []) {
      tile.dataset.tileState = tile.querySelector('input')?.checked ? 'selected' : 'idle';
    }
    const toggle = row?.querySelector?.('[data-gap-open]');
    if (toggle && option) {
      toggle.textContent = itemId + ' · ' + option.id + (option.text ? ' · ' + option.text : '');
      toggle.setAttribute('aria-label', pt('layoutGapPick', { id: itemId }, getLocale()) + ': ' + option.id + (option.text ? ' · ' + option.text : ''));
    }
    const used = new Set(Object.values(state.answers).map(answer => answer.key));
    for (const entry of host$.querySelectorAll?.('[data-bank-key]') ?? []) entry.dataset.used = String(used.has(entry.dataset.bankKey));
    const done = items.filter(item => state.answers[item.item_id]).length;
    const total = items.length;
    const complete = total > 0 && done === total;
    const progress = host$.querySelector?.('[data-runner-progress]');
    if (progress) {
      progress.dataset.answered = String(done);
      progress.dataset.complete = complete ? 'true' : 'false';
      progress.textContent = pt('partRunnerProgress', { answered: done, total }, getLocale())
        + (complete ? '' : ' · ' + pt('partRunnerAnswerAll', {}, getLocale()));
    }
    const button = host$.querySelector?.('[data-runner-evaluate]');
    if (button) {
      const ready = complete && !evaluateBlocked(state);
      button.dataset.runnerEvaluateReady = ready ? 'true' : 'false';
      button.disabled = !ready;
      button.setAttribute('aria-disabled', ready ? 'false' : 'true');
    }
  }

  return {
    async mount(target) {
      if (!target) return false;
      ensureStylesheet();
      if (unsubscribe) { unsubscribe(); unsubscribe = null; }
      host = target;
      globalThis.addEventListener?.('beforeunload', beforeUnload);
      generation++;
      host.onclick = (event) => {
        const gap = event.target.closest?.('[data-gap-open]');
        if (gap) {
          const panel = host.querySelector('[id="' + gap.getAttribute('aria-controls') + '"]');
          const expanded = gap.getAttribute('aria-expanded') !== 'true';
          gap.setAttribute('aria-expanded', String(expanded));
          if (panel) { panel.hidden = !expanded; if (expanded) (panel.querySelector('input:checked') ?? panel.querySelector('input'))?.focus(); }
          return;
        }
        /*
         * THE PLAYER'S OWN CONTROLS GO FIRST. `practice-listening.js` renders `data-listening-action`
         * buttons inside the mount point (the mock player's own attribute, so the two players stay
         * indistinguishable to a stylesheet or a test); the runner only routes the click.
         */
        const listening = event.target.closest?.('[data-listening-action]');
        if (listening && player) {
          if (state.busy) return;
          const action = listening.dataset.listeningAction;
          if (['play', 'recover'].includes(action)) void player.play();
          else if (action === 'pause') void player.pause();
          else if (action === 'retry') void player.retry();
          else if (action === 'reload') void player.reload();
          return;
        }
        if (event.target.closest?.('[data-runner-evaluate]')) { void evaluate(); return; }
        if (event.target.closest?.('[data-runner-retry]')) { void load(); return; }
        /* The two ways forward after a NON-retryable refusal; deliberately not `data-runner-action`, which
           is reserved for the three actions that follow a review. */
        const recover = event.target.closest?.('[data-runner-recover]');
        if (recover) {
          if (!canLeave()) return;
          if (recover.dataset.runnerRecover === 'next') void load();
          else if (recover.dataset.runnerRecover === 'index' && typeof ctx.onBack === 'function') ctx.onBack();
          return;
        }
        const action = event.target.closest?.('[data-runner-action]');
        if (!action) return;
        const name = action.dataset.runnerAction;
        if (name === 'next') void load();
        else if (name === 'mistakes') void load({ mistakeRound: true });
        else if (name === 'index' && typeof ctx.onBack === 'function') ctx.onBack();
      };
      host.onchange = (event) => {
        const languageSelect = event.target.closest?.('[data-runner-explanation-language]');
        if (languageSelect) { void reloadExplanations(languageSelect.value); return; }
        const radio = event.target.closest?.('[data-answer-item]');
        if (!radio) return;
        const itemId = radio.dataset.answerItem;
        const option = (state.set?.items ?? []).find(item => item.item_id === itemId)?.options
          ?.find(candidate => candidate.id === (radio.dataset.answerKey ?? radio.value));
        if (option || radio.tagName === 'SELECT' && radio.value === '') answer(itemId, option ?? null);
      };
      host.onkeydown = event => {
        if (!['Escape', 'Enter'].includes(event.key)) return;
        const panel = event.target.closest?.('.layout-gap-options');
        if (!panel) return;
        if (event.key === 'Enter' && event.target.matches?.('input[data-answer-item]')) {
          const input = event.target;
          const option = state.set?.items.find(item => item.item_id === input.dataset.answerItem)?.options.find(option => option.id === input.dataset.answerKey);
          if (option) { input.checked = true; answer(input.dataset.answerItem, option); }
        }
        panel.hidden = true;
        const toggle = panel.parentElement.querySelector('[data-gap-open]');
        toggle?.setAttribute('aria-expanded', 'false'); toggle?.focus(); event.preventDefault();
      };
      unsubscribe = typeof subscribeLocale === 'function' ? subscribeLocale(() => { render(); }) : null;
      return load();
    },
    unmount() {
      globalThis.removeEventListener?.('beforeunload', beforeUnload);
      generation++;
      if (unsubscribe) { unsubscribe(); unsubscribe = null; }
      player?.dispose?.();
      player = null;
      if (host) { host.onclick = null; host.onchange = null; host.onkeydown = null; host.innerHTML = ''; }
      host = null;
    },
    /* Test seams, so the check can drive the view without a DOM. */
    snapshot() { return state; },
    canLeave,
    markup() { return runnerMarkup(state, renderOptions()); },
    reload: load,
    evaluate,
    reloadExplanations,
  };
}

/**
 * DRILL-01 (MIRROR-B1PREP-01 slice H) — Einzelübungen: ONE item at a time, with instant feedback.
 *
 * WHAT THIS IS. The released practice pool, drilled one item at a time and WEIGHTED TO THE WEAK PART. The
 * server chooses the part and the item (`GET /api/v1/practice/drill/next`), the learner answers, and
 * `POST /api/v1/practice/drill/check` marks that ONE item and returns the verdict together with the key —
 * which the server can only reveal because the learner's own evidence row for that item now exists. This
 * module never marks anything and never decides what to practise.
 *
 * WHAT IT IS NOT (D22). No readiness figure, no streak, no study plan, no forecast and no pass prediction.
 * The only numbers on the page are COUNTS OF WHAT HAPPENED: which task of how many in this sitting, and the
 * learner's own right/wrong tally for the part the server chose. Nothing here turns a count into a
 * probability, and the word "bestanden" does not appear — `tools/drill-check.mjs` leg D22 asserts that in
 * all five interface languages.
 *
 * ONE ITEM AT A TIME IS NOT THE PART RUNNER WITH A STEPPER. `part-runner.js` renders a WHOLE part on one
 * page and marks it once with "Auswerten"; this module renders ONE task, marks it, and then asks the server
 * for the next one. The two therefore share their DTO reader and their key/verdict vocabulary and nothing
 * else — `readServedItems`, `readOptions`, `optionLabel`, `readMaterial`, `materialBlocks`, `readDisclosure`
 * and `explanationBlocks` are IMPORTED from `part-runner.js` rather than copied, so the served-shape
 * tolerance lives in exactly one place.
 *
 * THE SEAM. No URL literal and no `fetch` in this file: the transport is `ctx.api.practice`, exactly as the
 * runner's is (`tools/drill-check.mjs` leg 9b enforces it the same way `practice-runner-check` does for the
 * runner). `ctx` is the §4.2 shell object `{api, uiText, esc, language, examLanguage, navigate, state}`;
 * nothing is added to it and no route is registered here.
 *
 * DEGRADING HONESTLY. A shell whose api layer has no drill transport, or a deployment whose pool is empty,
 * gets a state that says so — never a spinner that never resolves and never an empty page.
 */
import { getLocale, subscribeLocale } from '../assets/i18n/core.js';
import { pt } from '../assets/i18n/practice-messages.js';
import {
  checkFailureOf, explanationBlocks, materialBlocks, optionLabel, readDisclosure, readExamRule, readServedItems,
} from './part-runner.js';

const defaultEsc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));
const t = (esc, key, parameters, locale) => esc(pt(key, parameters, locale));
const nonEmpty = (value) => (typeof value === 'string' && value.trim() ? value.trim() : null);
const countOrNull = (value) => (Number.isInteger(value) && value >= 0 ? value : null);
/** The server's literal for a zwei-Antworten item (`server/practice-sets.mjs`). Renamed spellings degrade. */
const JUDGEMENT_KINDS = Object.freeze(['judgement', 'judgment', 'truth', 'boolean']);
/** LV3's "no advertisement fits" sentinel: served with an empty `text`, id `x`, value `x`. */
const NO_MATCH_ID = 'x';
/** The three tiers `server/drill-sets.mjs` names; the client prints the one the server reported. */
export const DRILL_TIERS = Object.freeze(['weak', 'unseen', 'strong']);

/* ------------------------------------------------------------------------------- normalisation */

function languageAttributes(value) {
  return ' lang="' + defaultEsc(value || 'und') + '" dir="' + (value === 'ar' ? 'rtl' : 'ltr') + '"';
}

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

/**
 * The ONE task a drill response serves, through the runner's own DTO reader.
 *
 * The response carries the set's metadata and material plus a single `item`; narrowing the set to that one
 * item and handing it to `readServedItems` keeps ONE reader for the served shape (including the authored
 * bridge) instead of a second, subtly different one here.
 */
export function readDrillItem(data) {
  const set = data?.set ?? null;
  const item = data?.item ?? null;
  if (!set || !item || typeof item !== 'object') return { item: null, blocked: set ? 'items' : null, set: null };
  const narrowed = { ...set, items: [item] };
  const served = readServedItems(narrowed);
  if (!served.items.length) return { item: null, blocked: served.blocked ?? 'items', set: narrowed };
  return { item: served.items[0], blocked: null, set: { ...narrowed, items: served.items } };
}

/**
 * The reason the server gave for choosing this part, as a line the learner can read.
 *
 * The parameters are EXACTLY the placeholders each key declares: `core.js#t` refuses a call whose parameter
 * set does not match the template's placeholders (it answers "Übersetzung nicht verfügbar."), so a helpful
 * extra member here would silently replace the sentence with a fallback. The wrong count is therefore
 * derived in the German/English copy rather than passed in.
 */
export function drillReasonLine(state, locale = getLocale()) {
  const evidence = state?.evidence ?? {};
  const family = nonEmpty(state?.family) ?? '';
  const correct = countOrNull(evidence.correct) ?? 0;
  const attempts = countOrNull(evidence.attempts) ?? 0;
  if (state?.reason === 'weak') return pt('drillReasonWeak', { family, correct, attempts }, locale);
  if (state?.reason === 'unseen') return pt('drillReasonUnseen', { family }, locale);
  if (state?.reason === 'strong') return pt('drillReasonStrong', { family, attempts }, locale);
  return null;
}

/* ----------------------------------------------------------------------------------- state */

/**
 * A fresh drill state from one served response. Pure, so the check drives every phase without a server.
 *
 * `phase: 'empty'` is the server's honest `reason: 'nothing_available'` (nothing is servable for this
 * deployment) — not an error and not a spinner. `poolBlocked: 'listening'` is the FIX-F1 state: nothing the
 * drill could serve is playable (the released parts it can see are listening parts and playback is missing),
 * so the server names that instead of offering an item. A WEAK listening part does NOT produce this state —
 * the server passes it over and serves the weakest playable part (FIX-F1 corrected the first H1 rule, which
 * blocked there and closed Einzelübungen for anyone who had ever opened Hören).
 *
 * A served item whose set needs media is treated as the SAME blocked state even if a server ever sends one:
 * an item that cannot be attempted honestly is never rendered as an exercise. That is a second layer, not the
 * fix — the pool filter in `drill-pg.mjs` is the fix — but it means no future path can put answer controls on
 * an unplayable item and write a guess into the learner's evidence.
 */
export function drillStateFromServed({ response = {}, examLanguage = 'und' } = {}) {
  const data = response?.data ?? {};
  const base = {
    phase: 'loading', family: null, section: null, part: null, reason: null, evidence: null,
    attempt: null, round: normaliseRound(null), set: null, item: null, blocked: null, poolBlocked: null,
    progress: { answered: 0, total: 0 }, answer: null, checked: null, busy: false,
    error: null, failure: null, examLanguage, examRule: null, startedAt: null,
  };
  const blockedPool = nonEmpty(data?.blocked);
  if (!data || typeof data !== 'object' || !data.item || blockedPool) {
    return {
      ...base,
      phase: 'empty',
      family: nonEmpty(data?.family),
      section: nonEmpty(data?.section),
      reason: nonEmpty(data?.reason),
      evidence: data.evidence && typeof data.evidence === 'object' ? { ...data.evidence } : null,
      poolBlocked: blockedPool,
    };
  }
  const served = readDrillItem(data);
  const progress = data.progress && typeof data.progress === 'object' ? data.progress : {};
  /* Defence in depth (H1): an item whose set needs media is not an exercise this client can run. */
  const mediaBlocked = served.set?.media_required === true;
  return {
    ...base,
    phase: mediaBlocked ? 'empty' : (served.blocked ? 'blocked' : 'answering'),
    poolBlocked: mediaBlocked ? 'listening' : null,
    family: nonEmpty(data.family),
    section: nonEmpty(data.section) ?? nonEmpty(data.set?.section),
    part: countOrNull(data.set?.part),
    reason: nonEmpty(data.reason),
    evidence: data.evidence && typeof data.evidence === 'object' ? { ...data.evidence } : null,
    attempt: mediaBlocked ? null : (data.attempt && typeof data.attempt === 'object' ? { ...data.attempt } : null),
    round: normaliseRound(data.round),
    set: served.set,
    item: mediaBlocked ? null : served.item,
    blocked: served.blocked,
    progress: {
      answered: countOrNull(progress.answered) ?? 0,
      total: countOrNull(progress.total) ?? countOrNull(data.set?.item_count) ?? 0,
    },
    startedAt: Date.now(),
  };
}

/**
 * The feedback state from one checked item. The verdict and the key are the SERVER's, never a client guess:
 * `correct` is what `mark_objective_item` decided against the stored key, and `expected` is what
 * `reveal_objective_answer` returned after the evidence row was written.
 */
export function drillStateChecked(state, checked, { explanationLanguage = null } = {}) {
  return {
    ...state,
    phase: 'feedback',
    busy: false,
    error: null,
    failure: null,
    answer: null,
    checked: {
      item_id: nonEmpty(checked?.item_id) ?? state.item?.item_id ?? null,
      correct: checked?.correct === true,
      chosen: checked?.chosen ?? null,
      expected: checked?.expected ?? null,
      answer_kind: nonEmpty(checked?.answer_kind) ?? state.item?.answer_kind ?? 'choice',
      evidence_id: nonEmpty(checked?.evidence_id),
      explanation: checked?.explanation ?? null,
      complete: checked?.complete === true,
      answered_count: countOrNull(checked?.answered_count),
      correct_count: countOrNull(checked?.correct_count),
      item_count: countOrNull(checked?.item_count),
    },
    progress: {
      answered: countOrNull(checked?.answered_count) ?? state.progress.answered,
      total: countOrNull(checked?.item_count) ?? state.progress.total,
    },
    explanationLanguage,
  };
}

/* --------------------------------------------------------------------------------- markup */

/** One option's visible label, with the documented no-match hint when the server served no text for it. */
function optionTextMarkup(option, answerKind, { esc, locale }) {
  const label = optionLabel(option, answerKind);
  const noMatch = answerKind === 'choice' && !nonEmpty(option.text) && option.id === NO_MATCH_ID;
  return esc(label) + (noMatch ? ' <span class="small muted" data-drill-nomatch>' + t(esc, 'partRunnerNoMatch', {}, locale) + '</span>' : '');
}

/** One reviewed option: the key and the learner's own pick are marked on the SERVED option list. */
function optionReviewMarkup(option, item, checked, { esc, examLanguage, locale }) {
  const key = checked?.expected === undefined || checked?.expected === null ? null : String(checked.expected);
  const chosen = checked?.chosen === undefined || checked?.chosen === null ? null : String(checked.chosen);
  const isKey = key !== null && String(option.id) === key;
  const isChosen = chosen !== null && String(option.id) === chosen;
  const stateAttr = isKey && isChosen ? 'key-chosen' : (isKey ? 'key' : (isChosen ? 'chosen' : 'plain'));
  const marker = isKey ? t(esc, 'partRunnerKey', {}, locale) : (isChosen ? t(esc, 'partRunnerYourPick', {}, locale) : '');
  return '<li class="drill-option drill-option-review" data-option-id="' + esc(option.id) + '"'
    + ' data-option-state="' + esc(stateAttr) + '" data-option-marker="' + (isKey ? 'key' : (isChosen ? 'chosen' : '')) + '">'
    + '<span class="drill-option-text"' + languageAttributes(examLanguage) + '>' + optionTextMarkup(option, item.answer_kind, { esc, locale }) + '</span>'
    + (marker ? '<span class="chip drill-marker">' + marker + '</span>' : '')
    + '</li>';
}

function materialMarkup(state, { esc, examLanguage, locale }) {
  const blocks = materialBlocks(state?.set);
  if (!blocks.length) return '';
  return blocks.map((block) => '<section class="drill-material" data-drill-material data-material-kind="' + esc(block.kind) + '">'
    + '<h2 class="drill-material-label small muted">' + t(esc, 'partRunnerMaterial', {}, locale) + '</h2>'
    + '<div class="drill-material-body"' + languageAttributes(examLanguage) + '>'
    + block.body.split(/\n{2,}/).map((paragraph) => '<p>' + esc(paragraph.trim()) + '</p>').join('')
    + '</div></section>').join('');
}

/** The set's own disclosure (amendment A9(c)): a grammar drill is LABELLED, not filtered. */
function disclosureMarkup(state, { esc, examLanguage }) {
  const disclosure = readDisclosure(state?.set);
  if (!disclosure.instruction && !disclosure.practiceKind) return '';
  return '<section class="drill-disclosure" data-drill-disclosure'
    + (disclosure.practiceKind ? ' data-drill-practice-kind="' + esc(disclosure.practiceKind) + '"' : '') + '>'
    + (disclosure.instruction
      ? '<p class="drill-instruction" data-drill-instruction' + languageAttributes(examLanguage) + '>' + esc(disclosure.instruction) + '</p>'
      : '')
    + '</section>';
}

/**
 * A LISTENING item, and the same honest sentence slice C's runner prints.
 *
 * The recordings EXIST as content — `set.material.recordings` carries them and the server has an
 * accounting path for a practice sitting — but this client has no transport for practice playback (the
 * runner deliberately disables it too), so the drill must say that rather than serve an item whose audio
 * cannot be played and call it an exercise. The EXAM play rule is printed from `/api/v1/exam-parts`, which
 * is the number the learner is held to, and the player is disabled rather than pretending.
 *
 * The copy is slice C's (`partRunnerAudioRule` / `partRunnerAudioUnavailable`), not a second claim about
 * the same missing piece: one statement, one place to change when the transport lands.
 */
function audioMarkup(state, { esc, locale }) {
  const rule = state?.examRule;
  const listening = Boolean(rule && rule.playback && Number.isInteger(rule.playback.mock))
    || state?.section === 'HV' || state?.set?.media_required === true
    || state?.item?.answer_kind === 'judgement';
  if (!listening) return '';
  const mock = countOrNull(rule?.playback?.mock);
  const ruleLine = mock === null
    ? t(esc, 'partIndexPending', {}, locale)
    : t(esc, 'partRunnerAudioRule', { plays: mock }, locale);
  return '<section class="drill-audio" data-drill-audio data-audio-state="unavailable"'
    + (mock === null ? '' : ' data-playback-mock="' + esc(String(mock)) + '"')
    + ' aria-labelledby="drill-audio-title">'
    + '<h2 id="drill-audio-title" class="drill-audio-title">' + t(esc, 'partRunnerListening', {}, locale) + '</h2>'
    + '<div class="drill-player" data-drill-player role="group" aria-label="' + t(esc, 'partRunnerListening', {}, locale) + '">'
    + '<button type="button" class="btn btn-small" data-drill-play disabled aria-disabled="true">' + t(esc, 'partRunnerPlay', {}, locale) + '</button>'
    + '<p class="small muted drill-play-rule" data-drill-play-rule>' + ruleLine + '</p>'
    + '</div>'
    + '<p class="hint" data-drill-playback-missing role="status">' + t(esc, 'partRunnerAudioUnavailable', {}, locale) + '</p>'
    + '</section>';
}

function answeringItemMarkup(state, { esc, examLanguage, locale }) {
  const item = state.item;
  const picked = state.answer?.key ?? null;
  const options = item.options.map((option) => {
    const selected = picked !== null && picked === option.id;
    return '<label class="drill-option">'
      + '<input type="radio" name="drill-answer" value="' + esc(option.id) + '" data-drill-option="' + esc(option.id) + '"'
      + (selected ? ' checked' : '') + '>'
      + '<span class="drill-option-text"' + languageAttributes(examLanguage) + '>' + optionTextMarkup(option, item.answer_kind, { esc, locale }) + '</span>'
      + '</label>';
  }).join('');
  const index = countOrNull(item.ordinal) ?? 1;
  return '<form class="drill-item" data-drill-item data-item-id="' + esc(item.item_id) + '"'
    + ' data-answer-kind="' + esc(item.answer_kind ?? 'choice') + '" data-item-options="' + esc(String(item.options.length)) + '">'
    + '<p class="drill-item-label small muted">' + t(esc, 'drillItemPosition', { index, total: state.progress.total || item.ordinal || 1 }, locale) + '</p>'
    + '<p class="drill-prompt"' + languageAttributes(examLanguage) + '>' + esc(item.prompt) + '</p>'
    + (item.prompt_en ? '<p class="small muted drill-prompt-translation" lang="en" dir="ltr">' + esc(item.prompt_en) + '</p>' : '')
    + '<fieldset class="drill-options"><legend class="drill-legend sr-only">'
    + t(esc, 'drillItemPosition', { index, total: state.progress.total || item.ordinal || 1 }, locale) + '</legend>' + options + '</fieldset>'
    + '</form>';
}

function feedbackMarkup(state, { esc, examLanguage, locale }) {
  const checked = state.checked ?? {};
  const item = state.item;
  if (!item) return '';
  const keyLabel = keyOf(checked.expected);
  const chosenLabel = keyOf(checked.chosen);
  const explanation = explanationBlocks(checked.explanation, locale);
  const options = item.options.map((option) => optionReviewMarkup(option, item, checked, { esc, examLanguage, locale })).join('');
  return '<section class="drill-feedback" data-drill-feedback data-verdict="' + (checked.correct ? 'correct' : 'wrong') + '"'
    + ' data-drill-complete="' + (checked.complete ? 'true' : 'false') + '" role="status" aria-live="polite">'
    + '<p class="drill-verdict" data-drill-verdict="' + (checked.correct ? 'correct' : 'wrong') + '">'
    + t(esc, checked.correct ? 'drillCorrect' : 'drillWrong', {}, locale) + '</p>'
    + '<p class="drill-prompt"' + languageAttributes(examLanguage) + '>' + esc(item.prompt) + '</p>'
    + '<ul class="drill-options drill-options-review"' + languageAttributes(examLanguage) + '>' + options + '</ul>'
    + '<p class="small drill-key" data-drill-key-line>' + t(esc, 'drillKey', { answer: keyLabel }, locale) + '</p>'
    + '<p class="small muted drill-pick" data-drill-pick-line>' + t(esc, 'drillYourPick', { answer: chosenLabel }, locale) + '</p>'
    + '<div class="drill-explanation" data-drill-explanation data-explanation-for="' + esc(checked.evidence_id ?? '') + '"'
    + ' data-explanation-status="' + esc(explanation.state) + '">'
    + '<p class="small muted drill-explanation-status">' + esc(explanation.status) + '</p>'
    + explanation.blocks.map((block) => '<div class="drill-explanation-block" data-explanation-slot="' + esc(block.slot ?? '') + '">'
      + (block.label ? '<p class="drill-explanation-label">' + esc(block.label) + '</p>' : '')
      + '<p class="drill-explanation-prose"' + languageAttributes(explanation.language ?? null) + '>' + esc(block.text ?? '') + '</p>'
      + '</div>').join('')
    + '</div>'
    + '<div class="drill-actions">'
    + '<button type="button" class="btn btn-primary" data-drill-next>'
    + t(esc, 'drillNext', {}, locale) + '</button>'
    + '</div>'
    + (checked.complete ? '<p class="small muted" data-drill-set-done>' + t(esc, 'drillSetDone', {}, locale) + '</p>' : '')
    + '</section>';
}

/** The key or the learner's pick, as the learner reads it: a boolean is the exam's own richtig/falsch. */
function keyOf(value) {
  if (value === undefined || value === null) return '—';
  if (typeof value === 'boolean') return value ? 'richtig' : 'falsch';
  const text = String(value);
  return text || '—';
}

/**
 * The drill's markup for one state. Pure and exported, so the check reads exactly the text the learner gets.
 *
 * `esc`, `uiText` and `locale` come from the shell; `examLanguage` labels the authored exam-language islands
 * (`lang`/`dir`) so the Arabic interface keeps German tasks LTR.
 */
export function drillMarkup(state, { esc = defaultEsc, uiText = (key) => key, examLanguage = 'und', locale = getLocale() } = {}) {
  const attrs = ' class="drill" data-drill data-drill-phase="' + esc(state.phase) + '"'
    + (state.family ? ' data-drill-family="' + esc(state.family) + '"' : '')
    + (state.reason ? ' data-drill-reason="' + esc(state.reason) + '"' : '');
  const head = '<header class="drill-head">'
    + '<p class="drill-kicker small muted">' + t(esc, 'drillKicker', {}, locale) + '</p>'
    + '<h1 class="drill-title">' + t(esc, 'drillTitle', {}, locale) + '</h1>';
  if (state.phase === 'loading') {
    return '<section' + attrs + '><div class="drill-head">' + '<p class="drill-kicker small muted">' + t(esc, 'drillKicker', {}, locale) + '</p>'
      + '<h1 class="drill-title">' + t(esc, 'drillTitle', {}, locale) + '</h1>'
      + '<p class="muted" data-drill-loading role="status">' + t(esc, 'drillLoading', {}, locale) + '</p></div></section>';
  }
  if (state.phase === 'empty') {
    /*
     * THE HONEST LISTENING NOTE (REVIEW-DRILL-01 H1, corrected by FIX-F1). The drill no longer stops when the
     * learner's weakest part is a listening part: it PASSES THAT PART OVER and serves the weakest part it can
     * actually play, so this card is only what remains when nothing playable is left at all (a deployment
     * whose released parts are listening parts). It names the situation and the part with its numbers, and it
     * offers no answer control, so nothing can be guessed into the learner's evidence.
     */
    if (state.poolBlocked === 'listening') {
      const evidence = state.evidence ?? {};
      return '<section' + attrs + '>' + head + '</header>'
        + audioMarkup(state, { esc, locale })
        + '<div class="card" data-drill-listening-blocked>'
        + '<h2 class="drill-empty-title">' + t(esc, 'drillListeningTitle', {}, locale) + '</h2>'
        /* The body carries the part AND its numbers, so there is no second reason line repeating them. */
        + '<p class="muted" data-drill-listening-body>' + t(esc, 'drillListeningBlocked', {
          family: state.family ?? '', correct: countOrNull(evidence.correct) ?? 0, attempts: countOrNull(evidence.attempts) ?? 0,
        }, locale) + '</p>'
        + '<div class="drill-actions"><button type="button" class="btn" data-drill-part-index>'
        + t(esc, 'drillListeningAction', {}, locale) + '</button></div>'
        + '</div></section>';
    }
    return '<section' + attrs + '>' + head + '</header>'
      + '<div class="card" data-drill-empty><h2 class="drill-empty-title">' + t(esc, 'drillEmptyTitle', {}, locale) + '</h2>'
      + '<p class="muted" data-drill-empty-body>' + t(esc, 'drillEmpty', {}, locale) + '</p></div></section>';
  }
  if (state.phase === 'unavailable') {
    return '<section' + attrs + '>' + head + '</header>'
      + '<div class="card" data-drill-unavailable><p class="muted">' + t(esc, 'drillUnavailable', {}, locale) + '</p></div></section>';
  }
  if (state.phase === 'blocked') {
    return '<section' + attrs + '>' + head + '</header>'
      + '<div class="card" data-drill-blocked="' + esc(state.blocked ?? 'items') + '">'
      + '<p class="muted">' + t(esc, 'drillNoOptions', {}, locale) + '</p></div></section>';
  }
  if (state.phase === 'error') {
    const code = state.error?.code ?? 'drill_failed';
    return '<section' + attrs + '>' + head + '</header>'
      + '<div class="card" data-drill-error="' + esc(code) + '">'
      + '<p class="err" role="alert">' + t(esc, 'drillFailed', {}, locale) + '</p>'
      + '<div class="drill-actions"><button type="button" class="btn" data-drill-retry>' + t(esc, 'drillRetry', {}, locale) + '</button></div>'
      + '</div></section>';
  }
  const reason = drillReasonLine(state, locale);
  const wrap = state.round?.wrapped === true && state.round?.notice
    ? '<p class="drill-wrap-notice" data-drill-wrap-notice="' + esc(state.round.notice) + '">' + t(esc, state.round.notice, {}, locale) + '</p>'
    : '';
  const failure = state.failure
    ? '<p class="err drill-check-error" role="alert" data-drill-check-error="' + esc(state.failure.code) + '"'
      + ' data-drill-check-status="' + esc(String(state.failure.status)) + '">'
      + t(esc, state.failure.kind === 'retryable' ? 'drillCheckFailed' : 'drillCheckBlocked', {}, locale) + '</p>'
    : '';
  const position = '<p class="small muted drill-progress" data-drill-progress data-answered="' + esc(String(state.progress.answered)) + '"'
    + ' data-total="' + esc(String(state.progress.total)) + '" aria-live="polite">'
    + t(esc, 'drillProgress', { answered: state.progress.answered, total: state.progress.total }, locale) + '</p>';
  if (state.phase === 'feedback') {
    return '<section' + attrs + '>' + head
      + (reason ? '<p class="drill-reason" data-drill-reason-line="' + esc(state.reason) + '">' + esc(reason) + '</p>' : '')
      + '</header>' + wrap + materialMarkup(state, { esc, examLanguage, locale })
      + audioMarkup(state, { esc, locale })
      + disclosureMarkup(state, { esc, examLanguage })
      + feedbackMarkup(state, { esc, examLanguage, locale }) + position + '</section>';
  }
  /* answering / checking */
  const busy = state.phase === 'checking' || state.busy === true;
  const ready = Boolean(state.answer) && !busy;
  return '<section' + attrs + '>' + head
    + (reason ? '<p class="drill-reason" data-drill-reason-line="' + esc(state.reason) + '">' + esc(reason) + '</p>' : '')
    + '</header>' + wrap + materialMarkup(state, { esc, examLanguage, locale })
    + audioMarkup(state, { esc, locale })
    + disclosureMarkup(state, { esc, examLanguage })
    + answeringItemMarkup(state, { esc, examLanguage, locale })
    + failure
    + '<div class="drill-actions">'
    + '<button type="button" class="btn btn-primary" data-drill-check data-drill-check-ready="' + (ready ? 'true' : 'false') + '"'
    + (ready ? '' : ' disabled aria-disabled="true"') + '>'
    + t(esc, busy ? 'drillChecking' : 'drillCheck', {}, locale) + '</button>'
    + (state.answer ? '' : '<p class="small muted" data-drill-choose-hint>' + t(esc, 'drillChoose', {}, locale) + '</p>')
    + '</div>' + position + '</section>';
}

/* --------------------------------------------------------------------------------- the view */

/**
 * The drill's own stylesheet, injected on mount.
 *
 * §4.2 gives a module its own CSS file, and the shell already injects the routed module's stylesheet
 * (`MODULE_VIEWS.ueben.css`) with the RELATIVE href it was configured with. This function derives the
 * ABSOLUTE href from `import.meta.url` (never the document) so it is correct wherever the app is mounted,
 * and it treats an already-present link as present by comparing RESOLVED hrefs — otherwise the shell's
 * `drill.css` and this module's absolute URL would count as two different stylesheets and the file would be
 * fetched twice. Idempotent, and a no-op without a document, so the check can drive the module in Node.
 */
export function ensureStylesheet(doc = globalThis.document) {
  if (!doc || typeof doc.createElement !== 'function') return false;
  const href = new URL('./drill.css', import.meta.url).href;
  const resolve = (link) => {
    const raw = (typeof link?.getAttribute === 'function' ? link.getAttribute('href') : null) ?? link?.href ?? '';
    if (!raw) return '';
    try { return new URL(raw, href).href; } catch { return String(raw); }
  };
  const links = typeof doc.querySelectorAll === 'function' ? [...doc.querySelectorAll('link[rel="stylesheet"]')] : [];
  if (links.some((link) => resolve(link) === href)) return true;
  const link = doc.createElement('link');
  link.rel = 'stylesheet';
  link.href = href;
  link.dataset.moduleStyle = href;
  (doc.head ?? doc.body)?.append?.(link);
  return true;
}

/**
 * The frozen §4.2 interface: `createDrillView(ctx)` → `{ mount(host), unmount() }`.
 */
export function createDrillView(ctx = {}) {
  const esc = typeof ctx.esc === 'function' ? ctx.esc : defaultEsc;
  const uiText = typeof ctx.uiText === 'function' ? ctx.uiText : (key) => key;
  const transport = ctx.api?.practice ?? null;
  let host = null;
  let unsubscribe = null;
  let generation = 0;
  let state = {
    phase: 'loading', family: null, section: null, part: null, reason: null, evidence: null, attempt: null,
    round: normaliseRound(null), set: null, item: null, blocked: null, progress: { answered: 0, total: 0 },
    answer: null, checked: null, busy: false, error: null, failure: null,
    examLanguage: ctx.examLanguage || 'und', examRule: null, startedAt: null, explanationLanguage: null,
  };

  const renderOptions = () => ({ esc, uiText, examLanguage: ctx.examLanguage || 'und', locale: getLocale() });

  function render() {
    if (!host) return;
    host.innerHTML = drillMarkup(state, renderOptions());
  }

  /** Can this shell drill at all? A missing transport is a state, not a crash. */
  function transportReady() {
    return typeof transport?.drillNext === 'function' && typeof transport?.drillCheck === 'function';
  }

  async function load() {
    const ticket = ++generation;
    state = { ...state, phase: 'loading', busy: false, error: null, failure: null, answer: null, checked: null };
    render();
    if (!transportReady()) {
      state = { ...state, phase: 'unavailable' };
      render();
      return false;
    }
    const response = await Promise.resolve(transport.drillNext())
      .catch(() => ({ ok: false, status: 0, error: 'drill_unavailable' }));
    if (ticket !== generation || !host) return false;
    if (!response?.ok) {
      state = { ...state, phase: 'error', error: { code: nonEmpty(response?.error) ?? 'drill_failed', status: response?.status ?? 0 } };
      render();
      return false;
    }
    state = drillStateFromServed({ response, examLanguage: ctx.examLanguage || 'und' });
    /*
     * The EXAM play rule of the part just served, read through the runner's own helper (`/api/v1/exam-parts`).
     * It is enrichment: a failure leaves `examRule` null and the audio block prints the honest pending line
     * rather than inventing a play count. `ctx.examParts` is passed on when the shell already holds it.
     */
    if (state.family) {
      state.examRule = await readExamRule(ctx.api, state.family, Array.isArray(ctx.examParts) ? ctx.examParts : null);
      if (ticket !== generation || !host) return false;
    }
    render();
    return true;
  }

  /** The learner picked one option: hold it, and open the check control without re-rendering the form. */
  function choose(option) {
    if (!option || state.phase !== 'answering') return false;
    state = { ...state, answer: { key: option.id, value: option.value } };
    const check = host?.querySelector?.('[data-drill-check]');
    if (check) {
      check.dataset.drillCheckReady = 'true';
      check.disabled = false;
      check.setAttribute('aria-disabled', 'false');
    }
    host?.querySelector?.('[data-drill-choose-hint]')?.remove?.();
    return true;
  }

  /** Mark THIS item on the server. The verdict, the key and the explanation all come back in one answer. */
  async function check() {
    const attemptId = nonEmpty(state.attempt?.attempt_id);
    const item = state.item;
    const picked = state.answer;
    if (!attemptId || !item || !picked || state.phase !== 'answering') return false;
    const language = typeof ctx.language === 'string' && ctx.language ? ctx.language : null;
    const latency = Number.isFinite(state.startedAt) ? Math.max(0, Math.min(Date.now() - state.startedAt, 3600000)) : null;
    const ticket = ++generation;
    state = { ...state, phase: 'checking', busy: true, error: null, failure: null };
    render();
    const response = await Promise.resolve(transport.drillCheck({
      attemptId, itemId: item.item_id, answer: picked.value, language, latencyMs: latency,
    })).catch(() => ({ ok: false, status: 0, error: 'drill_unavailable' }));
    if (ticket !== generation || !host) return false;
    state = { ...state, busy: false };
    if (response?.ok) {
      state = drillStateChecked(state, response.data, { explanationLanguage: language });
      render();
      return true;
    }
    const failure = checkFailureOf(response, { hasReview: false });
    /*
     * `item_out_of_order` means THIS item was already answered in this sitting — the honest recovery is to
     * ask the server for the next one, not to re-send a request that cannot succeed.
     */
    if (failure.code === 'item_out_of_order') {
      state = { ...state, phase: 'answering', failure: null };
      render();
      return load();
    }
    state = { ...state, phase: 'answering', failure, checked: null };
    render();
    return false;
  }

  /** The next item. A fresh server read, because the server owns which item and which part is next. */
  function next() {
    return load();
  }

  return {
    async mount(target) {
      if (!target) return false;
      ensureStylesheet();
      if (unsubscribe) { unsubscribe(); unsubscribe = null; }
      host = target;
      generation++;
      host.onclick = (event) => {
        if (event.target.closest?.('[data-drill-check]')) { void check(); return; }
        if (event.target.closest?.('[data-drill-next]')) { void next(); return; }
        if (event.target.closest?.('[data-drill-part-index]')) {
          if (typeof ctx.navigate === 'function') ctx.navigate('#/pruefungsteile');
          return;
        }
        if (event.target.closest?.('[data-drill-retry]')) { void load(); }
      };
      host.onchange = (event) => {
        const radio = event.target.closest?.('[data-drill-option]');
        if (!radio) return;
        const option = (state.item?.options ?? []).find((candidate) => candidate.id === radio.dataset.drillOption);
        if (!option) return;
        if (radio.checked === false) { state = { ...state, answer: null }; return; }
        choose(option);
      };
      unsubscribe = typeof subscribeLocale === 'function' ? subscribeLocale(() => { render(); }) : null;
      return load();
    },
    unmount() {
      generation++;
      if (unsubscribe) { unsubscribe(); unsubscribe = null; }
      if (host) { host.onclick = null; host.onchange = null; host.innerHTML = ''; }
      host = null;
    },
    /* Test seams, so the check drives the view without a browser. */
    snapshot() { return state; },
    markup() { return drillMarkup(state, renderOptions()); },
    reload: load,
    choose,
    check,
    next,
    /* Kept so a shell can tell whether this module could do anything with the api it was given. */
    transportReady,
  };
}

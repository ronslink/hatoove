import { pt } from '../assets/i18n/practice-messages.js';

const escapeText = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const attrs = language => ' lang="' + escapeText(language || 'und') + '" dir="' + (language === 'ar' ? 'rtl' : 'ltr') + '"';
const keyOf = value => value === undefined || value === null ? null : String(value);

export function answerLabel(item, key, locale) {
  const option = item.options.find(entry => String(entry.id) === String(key));
  if (!option) return '';
  const text = option.text || (item.answer_kind === 'judgement' ? (option.value ? 'richtig' : 'falsch') : '');
  return option.id === 'x' && !text ? 'x · ' + pt('layoutNoMatch', {}, locale) : option.id + (text ? ' · ' + text : '');
}

/** One tile language across practice and review. Keys are passed only after the server has checked. */
export function answerTiles(item, { answer = null, result = null, locale = 'de', examLanguage = 'de', esc = escapeText, namespace = 'part-runner' } = {}) {
  const chosen = keyOf(result ? result.chosen : answer?.key), expected = keyOf(result?.expected);
  const prefix = namespace === 'drill' ? 'drill' : namespace === 'mock' ? 'mock' : 'part-runner';
  return '<fieldset class="' + prefix + '-options"><legend class="' + prefix + '-legend sr-only"' + attrs(locale) + '>' + esc(pt('partRunnerItem', { id: item.item_id }, locale)) + '</legend>'
    + item.options.map(option => {
      const picked = chosen === String(option.id), right = expected === String(option.id);
      const state = result ? (right ? 'correct' : picked ? 'wrong' : 'neutral') : picked ? 'selected' : 'idle';
      const text = option.text || (item.answer_kind === 'judgement' ? (option.value ? 'richtig' : 'falsch') : option.id === 'x' ? pt('layoutNoMatch', {}, locale) : '');
      return '<label class="' + prefix + '-option answer-tile" data-tile-state="' + state + '" data-option-id="' + esc(option.id) + '" data-option-state="' + (right && picked ? 'key-chosen' : right ? 'key' : picked ? 'chosen' : 'plain') + '">'
        + '<input type="radio" name="answer-' + esc(item.item_id) + '" value="' + esc(option.id) + '" data-answer-item="' + esc(item.item_id) + '" ' + (prefix === 'drill' ? 'data-drill-option' : 'data-answer-key') + '="' + esc(option.id) + '"' + (picked ? ' checked' : '') + (result ? ' disabled' : '') + '>'
        + '<span class="answer-letter"' + attrs(examLanguage) + '>' + esc(item.answer_kind === 'judgement' ? option.value ? '✓' : '✗' : option.id) + '</span><span class="' + prefix + '-option-text"' + attrs(examLanguage) + '>' + esc(text) + '</span>'
        + (result && picked ? '<span class="chip" data-option-marker="chosen"' + attrs(locale) + '>' + esc(pt('partRunnerYourPick', {}, locale)) + '</span>' : '')
        + (right ? '<span class="chip" data-option-marker="key"' + attrs(locale) + '>✓ ' + esc(pt('partRunnerKey', {}, locale)) + '</span>' : result && picked ? '<span aria-hidden="true">✗</span>' : '') + '</label>';
    }).join('') + '</fieldset>';
}

function reviewPick(item, result, { esc, locale, examLanguage }) {
  if (!result) return '';
  return '<span class="layout-pick-review"' + attrs(locale) + ' data-verdict="' + (result.correct ? 'correct' : 'wrong') + '">'
    + '<span class="layout-your-pick" data-option-id="' + esc(keyOf(result.chosen)) + '" data-option-marker="chosen">' + esc(pt('partRunnerYourPick', {}, locale)) + ': <b' + attrs(examLanguage) + '>' + esc(answerLabel(item, result.chosen, locale)) + '</b></span>'
    + '<span class="layout-correct-pick" data-option-id="' + esc(keyOf(result.expected)) + '" data-option-marker="key">✓ ' + esc(pt('partRunnerKey', {}, locale)) + ': <b' + attrs(examLanguage) + '>' + esc(answerLabel(item, result.expected, locale)) + '</b></span></span>';
}

function picker(item, answer, result, config) {
  const { esc, locale, examLanguage, gap } = config;
  const number = /^\d+$/.test(item.item_id) ? item.item_id : item.ordinal;
  const name = pt(gap ? 'layoutGapPick' : 'layoutPick', { id: number }, locale);
  if (result) return '<span class="layout-gap-number">' + esc(number) + '</span>' + reviewPick(item, result, config);
  return '<label class="layout-picker"' + attrs(locale) + '><span class="sr-only">' + esc(name) + '</span><select class="select" data-answer-item="' + esc(item.item_id) + '" aria-label="' + esc(name) + '"' + attrs(locale) + '>'
    + '<option value="">' + esc(number + ' · ' + pt('layoutEmpty', {}, locale)) + '</option>'
    + item.options.map(option => '<option value="' + esc(option.id) + '"' + attrs(option.id === 'x' && !option.text ? locale : examLanguage) + (answer?.key === option.id ? ' selected' : '') + '>' + esc(answerLabel(item, option.id, locale)) + '</option>').join('') + '</select></label>';
}

export function optionBank(items, answers, config) {
  const { esc, locale, examLanguage } = config, options = items[0]?.options ?? [];
  const selected = new Set(Object.values(answers ?? {}).map(answer => answer.key));
  return '<details class="layout-bank" open data-layout-bank><summary>' + esc(pt('layoutOptions', {}, locale)) + '</summary><ul' + attrs(examLanguage) + '>'
    + options.filter(option => option.id !== 'x').map(option => '<li data-bank-key="' + esc(option.id) + '" data-used="' + selected.has(option.id) + '"><span class="answer-letter">' + esc(option.id) + '</span><span>' + esc(option.text) + '</span><span class="layout-used"' + attrs(locale) + '>' + esc(pt('layoutUsed', {}, locale)) + '</span></li>').join('')
    + '</ul></details>';
}

/** Return an exam-shaped answering surface, or null for ordinary question tiles. */
export function taskLayout(state, { esc = escapeText, locale = 'de', examLanguage = 'de', reviewDetails = () => '' } = {}) {
  const config = { esc, locale, examLanguage, gap: state.family.startsWith('SB') }, items = state.set?.items ?? [], answers = state.answers ?? {};
  const results = new Map((state.checked?.items ?? []).map(result => [String(result.item_id), result]));
  const reviewing = state.phase === 'review';
  if (['LV1', 'LV3'].includes(state.family)) {
    return '<div class="layout-matching" data-task-layout="matching">' + optionBank(items, answers, config) + '<ol class="part-runner-items" data-runner-items>'
      + items.map(item => '<li class="part-runner-item' + (reviewing ? ' part-runner-review-item' : '') + '" data-item-id="' + esc(item.item_id) + '" data-answered="' + Boolean(answers[item.item_id]) + '"' + (reviewing ? ' data-review-item="' + esc(item.item_id) + '" data-verdict="' + (results.get(item.item_id)?.correct ? 'correct' : 'wrong') + '"' : '') + '><p class="part-runner-item-label">' + esc(pt('partRunnerItem', { id: item.item_id }, locale)) + '</p><p class="part-runner-prompt"' + attrs(examLanguage) + '>' + esc(item.prompt) + '</p>'
        + picker(item, answers[item.item_id], reviewing ? results.get(item.item_id) : null, config) + (reviewing ? reviewDetails(item, results.get(item.item_id)) : '') + '</li>').join('') + '</ol></div>';
  }
  const letter = state.set?.material?.letter ?? state.set?.payload?.letter;
  if (!['SB1', 'SB2'].includes(state.family) || typeof letter !== 'string') return null;
  const byId = new Map(items.map(item => [item.item_id, item]));
  // A drill without authored gap markers keeps ordinary tiles; never move or invent exam content.
  const found = [...letter.matchAll(/\{(\d+)\}/g)].map(match => match[1]);
  if (!items.length || !items.every(item => found.includes(item.item_id))) return null;
  const tokens = letter.split(/(\{\d+\})/g).map(token => {
    const id = token.match(/^\{(\d+)\}$/)?.[1], item = byId.get(id);
    if (!item) return id ? '<span class="layout-gap-number">' + esc(id) + '</span>' : esc(token);
    const result = reviewing ? results.get(id) : null, answer = answers[id];
    const control = state.family === 'SB2' || result ? picker(item, answer, result, config)
      : '<span class="layout-gap"><button type="button" class="btn layout-gap-toggle"' + attrs(locale) + ' aria-label="' + esc(pt('layoutGapPick', { id }, locale) + ': ' + (answer ? answerLabel(item, answer.key, locale) : pt('layoutEmpty', {}, locale))) + '" data-gap-open="' + esc(id) + '" aria-expanded="false" aria-controls="gap-options-' + esc(id) + '">' + esc(id + ' · ' + (answer ? answerLabel(item, answer.key, locale) : pt('layoutEmpty', {}, locale))) + '</button>'
        + '<span class="layout-gap-options" id="gap-options-' + esc(id) + '" hidden>' + answerTiles(item, { ...config, answer }) + '</span></span>';
    return '<span class="layout-gap-slot" data-item-id="' + esc(id) + '" data-answered="' + Boolean(answer) + '"' + (reviewing ? ' data-review-item="' + esc(id) + '" data-verdict="' + (result?.correct ? 'correct' : 'wrong') + '"' : '') + '>' + control + (reviewing ? reviewDetails(item, result) : '') + '</span>';
  }).join('');
  return '<section class="layout-letter" data-task-layout="inline-gaps">' + (state.family === 'SB2' ? optionBank(items, answers, config) : '')
    + '<div class="layout-letter-body"' + attrs(examLanguage) + '>' + tokens + '</div></section>';
}

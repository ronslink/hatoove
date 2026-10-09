import { getLocale, subscribeLocale } from '../assets/i18n/core.js';
import { pt } from '../assets/i18n/practice-messages.js';
import { answerLabel } from './task-layout.js';
import { createPartRunnerView } from './part-runner.js';
const escapeText = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const attrs = language => ' lang="' + escapeText(language || 'und') + '" dir="' + (language === 'ar' ? 'rtl' : 'ltr') + '"';
const optionValue = (task, value) => task?.options?.find(option => option.value === value)?.id ?? value;
export function mistakeMarkup(row, { esc = escapeText, locale = getLocale(), examLanguage = 'und', index = 0, uiText = key => key } = {}) {
  const task = row.task;
  const label = value => task ? answerLabel(task, optionValue(task, value), locale) || pt('mistakeAnswerUnavailable', {}, locale) : pt('mistakeAnswerUnavailable', {}, locale);
  const letter = row.material?.letter;
  const passage = row.material?.text;
  const prompt = task?.prompt || (letter ? pt('layoutGapPick', {id: task?.item_id}, locale) : pt('mistakeQuestionUnavailable', {}, locale));
  const letterContext = typeof letter === 'string' ? letter.replace(/\{(\d+)\}/g, (_, id) => id === task?.item_id ? id + ' ____' : id) : null;
  return '<article class="card stack mistake-card" data-mistake-card="' + index + '">'
    + '<h2>' + esc(uiText({LV:'m002',SB:'m003',HV:'m004'}[row.section] || 'm002')) + ' · ' + esc(pt('part', {part:row.part}, locale)) + ' · ' + esc(pt('partRunnerItem', {id: index + 1}, locale)) + '</h2>'
    + (row.set_title && !/^(LV|SB|HV)\d/i.test(row.set_title) ? '<p class="muted"' + attrs(examLanguage) + '>' + esc(row.set_title) + '</p>' : '')
    + (typeof passage === 'string' ? '<details open><summary>' + esc(pt('partRunnerMaterial', {}, locale)) + '</summary><p class="text-block"' + attrs(examLanguage) + '>' + esc(passage) + '</p></details>' : '')
    + (letterContext ? '<details open><summary>' + esc(pt('partRunnerMaterial', {}, locale)) + '</summary><p class="text-block"' + attrs(examLanguage) + '>' + esc(letterContext) + '</p></details>' : '')
    + '<p class="text-block"' + attrs(task?.prompt ? examLanguage : locale) + '>' + esc(prompt) + '</p>'
    + '<p class="mistake-your"><strong>' + esc(pt('partRunnerYourPick', {}, locale)) + ':</strong> <span' + attrs(examLanguage) + '>' + esc(label(row.your_answer)) + '</span></p>'
    + '<p class="mistake-key"><strong>✓ ' + esc(pt('partRunnerKey', {}, locale)) + ':</strong> <span' + attrs(examLanguage) + '>' + esc(label(row.correct_answer)) + '</span></p>'
    + '<div data-mistake-explanation="' + index + '"></div>'
    + '<button class="btn btn-primary" type="button" data-mistake-retry="' + index + '"' + (!row.evidence_id || !task ? ' disabled' : '') + '>' + esc(pt('mistakeRetry', {}, locale)) + '</button></article>';
}
export function createMistakesView(ctx = {}) {
  const esc = ctx.esc || escapeText;
  let host = null, generation = 0, rows = [], runner = null, unsubscribe = null, failed = false;
  const current = ticket => Boolean(host) && ticket === generation;
  function render() {
    if (!host || runner) return;
    ctx.onPartIdentity?.(null, null);
    const locale = getLocale();
    host.innerHTML = '<section class="stack" data-mistakes-view' + attrs(locale) + '><header class="page-head"><div><h1>' + esc(ctx.uiText('m396')) + '</h1><p>' + esc(ctx.uiText(rows.length ? 'm120' : 'm119')) + '</p></div></header>'
      + (failed ? '<p class="err" role="alert">' + esc(ctx.uiText('m117')) + '</p><button class="btn btn-primary" data-mistakes-reload>' + esc(ctx.uiText('m301')) + '</button>' : rows.map((row,index) => mistakeMarkup(row,{esc,locale,examLanguage:ctx.examLanguage,index,uiText:ctx.uiText})).join(''))
      + '</section>';
    const ticket = generation;
    for (let index = 0; index < rows.length; index++) if (rows[index].evidence_id) ctx.explanations?.mount(host.querySelector('[data-mistake-explanation="' + index + '"]'), {
      read: language => ctx.api.practice.explanation(rows[index].evidence_id, language),
      isCurrent: () => current(ticket) && !runner,
    });
  }
  async function mount(target) {
    if (!target) return false;
    runner?.unmount(); runner = null; ctx.explanations?.dispose(host); unsubscribe?.();
    host = target; const ticket = ++generation;
    rows = []; failed = false;
    host.innerHTML = '<p role="status">' + esc(ctx.uiText('m317')) + '</p>';
    const result = await ctx.api.practice.mistakes().catch(() => null);
    if (!current(ticket)) return false;
    failed = !result?.ok; rows = result?.ok && Array.isArray(result.data?.items) ? result.data.items : [];
    if (result?.ok) ctx.onMistakeCount?.(Number.isInteger(result.data?.count) ? result.data.count : rows.length);
    render();
    host.onclick = event => {
      if (event.target.closest?.('[data-mistakes-reload]')) { void mount(host); return; }
      const button = event.target.closest?.('[data-mistake-retry]'); if (!button || runner || button.disabled) return;
      const row = rows[Number(button.dataset.mistakeRetry)]; if (!row?.evidence_id || !row.task) return;
      button.disabled = true;
      ctx.explanations?.dispose(host);
      runner = createPartRunnerView({...ctx, family:row.family, retryEvidenceId:row.evidence_id, onBack:()=>mount(host)});
      void runner.mount(host);
    };
    unsubscribe = subscribeLocale(()=>{if(!runner){ctx.explanations?.dispose(host);render();}});
    return true;
  }
  return {mount, canLeave:()=>!runner||runner.canLeave(), unmount(){
    generation++; unsubscribe?.(); unsubscribe=null; runner?.unmount(); runner=null;
    ctx.explanations?.dispose(host); if(host){host.onclick=null;host.innerHTML='';} host=null;
  }};
}

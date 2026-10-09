import { getLocale } from '../assets/i18n/core.js';
import { pt, pl, bindPracticeText, updatePracticeLocale } from '../assets/i18n/practice-messages.js';
import { contentReviewLabel, reviewHistoryNotice } from './review-labels.js';
import { INSTRUCTIONS, instructionMarkup, translateInstructions } from '../assets/i18n/instructions.js';

/** Bound rubric metadata supplies criterion names and scales; never convert between exams. */
export function writingCriterion(criterion, rubric) {
  const bound = rubric?.criteria?.find(c => (c.key || c.id) === (criterion.key || criterion.id));
  const legacyLabel = { aufgabe: 'Aufgabenbewältigung', kommunikation: 'Kommunikative Gestaltung', richtigkeit: 'Formale Richtigkeit' }[criterion.key];
  return { label: bound?.label || bound?.name || criterion.label || legacyLabel || criterion.key || criterion.id || '',
    band: bound?.bandLabels?.[criterion.band] ?? criterion.band ?? '' };
}
export function writingFeedbackState(data) {
  if (data?.blocked_reason) return 'blocked';
  if (data?.job?.status === 'succeeded' && data.assessment) return 'assessed';
  if (data?.job?.status === 'failed') return 'failed';
  if (data?.job?.status === 'unassessed') return 'unassessed';
  return 'pending';
}
export function writingLabels(rubric, feedbackKind = null, locale = getLocale()) {
  const boundKind = rubric?.feedback_kind || (rubric?.rubric_id === 'writing.telc-b1' ? 'telc-b1-bands' : null);
  const telc = (!rubric?.exam_id || rubric.exam_id === 'telc-deutsch-b1')
    && (boundKind ? boundKind === 'telc-b1-bands' && (!feedbackKind || feedbackKind === boundKind) : !rubric && feedbackKind === 'telc-b1-bands');
  return {
    heading: telc ? pt('feedbackTelc', {}, locale) : pt('feedbackGeneral', {}, locale),
    notice: pt(telc ? 'rubricNoticeTelc' : 'rubricNotice', {}, locale),
  };
}
export function writingPrompt(task, esc, examLanguage = task?.exam_language || 'und') {
  return `<div class="card-head"><h3 lang="${esc(examLanguage)}" dir="${examLanguage === 'ar' ? 'rtl' : 'ltr'}">${task.topic ? esc(task.topic) : pl('ui19')}</h3><span class="chip">${pl('ui01')}</span></div>${task.situation ? instructionMarkup({id:'writing.assigned',examLanguage,original:INSTRUCTIONS['writing.assigned'].examLanguage===examLanguage ? INSTRUCTIONS['writing.assigned'].original : ''}) : ''}<p lang="${esc(examLanguage)}" dir="${examLanguage === 'ar' ? 'rtl' : 'ltr'}">${esc(task.situation || '')}</p>${task.adressat ? `<p class="small muted">${pl('salutation')} <span lang="${esc(examLanguage)}" dir="${examLanguage === 'ar' ? 'rtl' : 'ltr'}">${esc(task.adressat)}</span></p>` : ''}<ul class="leitpunkte" lang="${esc(examLanguage)}" dir="${examLanguage === 'ar' ? 'rtl' : 'ltr'}">${(task.leitpunkte || []).map(p => `<li>${esc(p)}</li>`).join('')}</ul>`;
}

/** Owned writing lifecycle. Drafts and submitted feedback stay on the server. */
export function writingExplanationLabels(data) {
  return Object.fromEntries((data?.assessment?.feedback?.criteria || []).map(c => ['criterion/' + (c.key || c.id) + '/comment', writingCriterion(c, data.rubric).label]));
}
export function createWritingController({ getExamLanguage = () => null, api, esc, readAloud = null, explanations = null, onChange = () => {}, canEdit = () => true }) {
  let active = null;
  let serial = 0;
  let sessionBlocked = false;
  const labels = { aufgabe: 'Aufgabenbewältigung', kommunikation: 'Kommunikative Gestaltung', richtigkeit: 'Formale Richtigkeit' };
  const message = (r) => pl(r?.status === 0 ? 'connection' : r?.status === 429 ? 'rateLimit' : 'requestFailed');
  const current = (s) => !sessionBlocked && active === s && s.host.isConnected;
  const say = (s, html) => { if (current(s)) { explanations?.dispose(s.status); readAloud?.clear(s.status); s.status.innerHTML = html; updatePracticeLocale(s.status); } };
  const button = (id, text, primary = false) => `<button type="button" class="btn${primary ? ' btn-primary' : ''}" id="${id}">${text}</button>`;
  const prompt = task => writingPrompt(task, esc, task?.exam_language || getExamLanguage() || 'und');
  const dirty = (s) => Boolean(s?.area && !s.submission && s.area.value !== s.saved);
  const contentRefused = response => ['rights_blocked', 'content_policy_blocked', 'review_blocked', 'exam_unavailable'].includes(response?.error);
  function blockContent(s, html) {
    s.blocked = true; s.task = {};
    clearTimeout(s.timer); clearTimeout(s.poll);
    if (s.area) s.area.readOnly = true;
    s.host.querySelector('.writing-prompt')?.replaceChildren();
    s.host.querySelector('#writing-rubric')?.remove();
    for (const id of ['writing-submit', 'writing-new', 'writing-retry', 'writing-revise']) {
      const control = s.host.querySelector('#' + id); if (control) control.disabled = true;
    }
    say(s, html);
  }
  window.addEventListener('hatoove:session-expired', () => {
    if (!active) { sessionBlocked = true; return; }
    clearTimeout(active.timer); clearTimeout(active.poll);
    if (active.area) active.area.readOnly = true;
    for (const control of active.host.querySelectorAll('button')) control.disabled = true;
    if (active.area && !active.submission) say(active, '<p class="err" data-practice-key="ui02">Dieses Fenster kann nicht mehr speichern. Ihr Text bleibt zum Kopieren sichtbar. Melden Sie sich danach erneut an.</p>');
    sessionBlocked = true;
  });
  function dispose() {
    if (active) explanations?.dispose(active.host);
    if (active) readAloud?.clear(active.host);
    if (active?.timer) clearTimeout(active.timer);
    if (active?.poll) clearTimeout(active.poll);
    if (active) { active.host.replaceChildren(); active.host.hidden = true; if (active.list) active.list.hidden = false; }
    active = null;
    serial++;
  }
  function compareConflict(s, error = '') {
    say(s, `<p class="err">${pl(error || 'conflict')}</p>` + button('writing-compare', pl('compare')));
    s.host.querySelector('#writing-compare').onclick = async () => {
      const remote = await api.writing.readAttempt(s.attempt);
      if (!current(s)) return;
      if (!remote?.ok) { compareConflict(s, 'conflictLoad'); return; }
      say(s, `<p class="err" data-practice-key="ui03">Speicherkonflikt – Ihre Eingabe bleibt im Textfeld.</p><details open><summary data-practice-key="ui04">Gespeicherter Text</summary><pre class="submitted-text" lang="${esc(s.task?.exam_language || getExamLanguage() || 'und')}" dir="${(s.task?.exam_language || getExamLanguage()) === 'ar' ? 'rtl' : 'ltr'}">${esc(remote.data.text || '')}</pre></details>` + button('writing-keep', pl('keep')) + button('writing-load', pl('load')));
      s.host.querySelector('#writing-keep').onclick = async () => { s.revision = remote.data.revision; s.conflict = false; await save(s); };
      s.host.querySelector('#writing-load').onclick = () => { s.area.value = remote.data.text || ''; s.saved = s.area.value; s.revision = remote.data.revision; s.conflict = false; say(s, '<p class="muted" data-practice-key="ui05">Gespeicherte Fassung übernommen.</p>'); };
    };
  }
  async function save(s) {
    if (sessionBlocked) return false;
    if (!current(s) || !s.attempt || s.submission) return true;
    if (s.blocked || s.readonly || !canEdit()) return !dirty(s);
    if (s.conflict) return false;
    if (s.saving) { await s.saving; return current(s) && (dirty(s) ? save(s) : !s.conflict); }
    if (!dirty(s)) return true;
    const text = s.area.value;
    say(s, '<p class="muted" data-practice-key="ui06">Wird gespeichert …</p>');
    s.saving = api.writing.saveDraft(s.attempt, s.revision, text);
    const res = await s.saving;
    s.saving = null;
    if (!current(s)) return false;
    if (res?.ok) {
      s.revision = res.data.revision;
      s.saved = text;
      if (dirty(s)) return save(s);
      say(s, '<p class="muted" data-practice-key="ui07">Gespeichert. Noch nichts abgegeben.</p>');
      return true;
    }
    if (sessionBlocked) return false;
    if (['mock_group_inactive', 'mock_expired', 'mock_finalised'].includes(res?.error)) {
      s.error = res.error; s.area.readOnly = true;
      say(s, '<p class="err" data-practice-key="ui08">Die Schreibzeit ist beendet. Ihre unbestätigte Eingabe bleibt zum Kopieren erhalten; sie wurde nicht als gespeichert bestätigt.</p>');
      onChange(); return false;
    }
    if (contentRefused(res)) {
      blockContent(s, '<p class="err" data-practice-key="ui09">Die Aufgabe ist zurzeit gesperrt. Ihre Eingabe bleibt hier zum Kopieren sichtbar; sie wurde nicht gespeichert.</p>');
      return false;
    }
    if (res?.status === 409 && res.error === 'draft_conflict') {
      s.conflict = true;
      compareConflict(s);
      return false;
    }
    say(s, `<p class="err">${message(res)} ${pl('saveUnconfirmed',{error:''})}</p>` + button('writing-save-again', pl('saveAgain')));
    s.host.querySelector('#writing-save-again').onclick = () => save(s);
    return false;
  }
  async function flush() { return active ? save(active) : true; }
  function bindClose(s) {
    const close = s.host.querySelector('#writing-close');
    if (!close) return;
    close.onclick = async () => {
      if (!(await save(s)) || !current(s)) return;
      if (s.onClose) { await s.onClose(); return; }
      dispose(); s.host.innerHTML = ''; s.host.hidden = true;
      if (s.list) s.list.hidden = false;
      onChange();
    };
  }
  async function rubric(s, value = null) {
    const target = s.host.querySelector('#writing-rubric-body');
    if (!target) return;
    const response = value ? { ok: true, data: value } : await api.rubrics.read(s.task.rubric_id, s.task.rubric_version);
    if (!current(s)) return;
    if (!response?.ok) { bindPracticeText(target,'rubricUnavailable'); return; }
    const r = response.data;
    s.rubric = r;
    target.innerHTML = `<p class="small muted"><span data-writing-rubric-notice>${esc(writingLabels(r).notice)}</span> <span data-writing-rubric-review>${esc(contentReviewLabel(r))}</span></p><ol class="rubric-criteria" lang="${esc(s.task?.exam_language || getExamLanguage() || 'und')}" dir="${(s.task?.exam_language || getExamLanguage()) === 'ar' ? 'rtl' : 'ltr'}">${(r.criteria || []).map(c => `<li><strong>${esc(c.label || c.name || labels[c.key] || c.key || '')}</strong>${c.description ? `<p>${esc(c.description)}</p>` : ''}<ul class="rubric-bands">${Object.entries(c.descriptors || {}).map(([band, text]) => `<li><span class="band">${esc(c.bandLabels?.[band] || band)}</span> ${esc(text)}</li>`).join('')}</ul></li>`).join('')}</ol>`;
  }
  async function showResult(s, submissionId, tries = 0) {
    if (!current(s)) return;
    clearTimeout(s.poll); const resultRequest = s.resultRequest = (s.resultRequest || 0) + 1;
    s.submission = submissionId;
    s.status.dataset.submissionId = submissionId;
    const discard = s.host.querySelector('#writing-new'); if (discard) { discard.hidden = true; discard.disabled = true; }
    const res = await api.writing.result(submissionId);
    if (!current(s) || resultRequest !== s.resultRequest) return;
    if (!res?.ok) {
      say(s, `<p class="err">${message(res)} ${pl('submittedPreserved',{error:''})}</p>` + button('writing-refresh', pl('refresh')));
      s.host.querySelector('#writing-refresh').onclick = () => showResult(s, submissionId);
      return;
    }
    const data = res.data, job = data.job || {}, assessment = data.assessment, state = writingFeedbackState(data);
    if (data.task) s.task = { ...s.task, ...data.task };
    if (data.rubric) s.rubric = data.rubric;
    if (data.blocked_reason) {
      s.blocked = true; s.task = {};
      s.host.querySelector('.writing-prompt')?.replaceChildren();
      s.host.querySelector('#writing-rubric')?.remove();
    }
    s.result = data;
    const text = data.submission?.text || '';
    const sent = `<details class="submitted"><summary data-practice-key="ui10">Ihr abgegebener Text</summary><pre class="submitted-text" lang="${esc(s.task?.exam_language || getExamLanguage() || 'und')}" dir="${(s.task?.exam_language || getExamLanguage()) === 'ar' ? 'rtl' : 'ltr'}">${esc(text)}</pre></details>`;
    if (s.area) { s.area.value = text; s.area.readOnly = true; s.area.disabled = false; }
    const submit = s.host.querySelector('#writing-submit'); if (submit) submit.disabled = true;
    const fresh = s.host.querySelector('#writing-new'); if (fresh) fresh.hidden = true;
    let html;
    if (state === 'assessed') {
      const f = assessment.feedback || {};
      html = `<p class="muted"><strong data-writing-feedback-heading>${esc(writingLabels(s.rubric, f.kind).heading)}</strong></p><p class="small muted" data-practice-key="ui11">Lokaler Pilot: Die Rückmeldung stammt derzeit aus einer technischen Simulation. Sie bewertet Ihre Sprachleistung nicht verlässlich.</p>`;
      const supported = f.kind === (s.rubric?.feedback_kind || 'telc-b1-bands');
      html += supported && Array.isArray(f.criteria)
        ? `<ul class="criteria">${f.criteria.map(c => { const view = writingCriterion(c, s.rubric); return `<li class="criterion"><div class="criterion-head"><strong lang="${esc(s.task?.exam_language || getExamLanguage() || 'und')}" dir="${(s.task?.exam_language || getExamLanguage()) === 'ar' ? 'rtl' : 'ltr'}">${esc(view.label || labels[c.key])}</strong><span class="band"><span class="sr-only" data-practice-key="ui12">Band </span>${esc(view.band)}</span></div>${c.evidence ? `<blockquote class="evidence" lang="${esc(s.task?.exam_language || getExamLanguage() || 'und')}" dir="${(s.task?.exam_language || getExamLanguage()) === 'ar' ? 'rtl' : 'ltr'}">${esc(c.evidence)}</blockquote>` : ''}</li>`; }).join('')}</ul>` : '';
      html += (data.review_withdrawn ? `<p class="hint" data-review-withdrawn>${esc(reviewHistoryNotice(data))}</p>` : '') + sent + (!s.readonly && !data.review_withdrawn ? button('writing-revise', pl('revise'), true) : '');
    } else if (state === 'blocked') {
      html = '<p class="err" data-practice-key="ui13">Die Aufgabe und Rückmeldung sind zurzeit gesperrt. Ihr abgegebener Text bleibt erhalten.</p>' + sent;
    } else if (state === 'unassessed') {
      const reason = job.failure_code === 'allowance_exhausted' ? pl('exhausted') : pl('noSubmission');
      html = `<p class="muted"><strong data-practice-key="ui14">Unbewertet.</strong> ${reason} ${pl('savedPreserved')}</p>` + sent + (!s.readonly ? button('writing-revise', pl('revise')) : '');
    } else if (state === 'failed') {
      const reason = job.failure_code === 'grader_unavailable' ? pl('graderUnavailable') : job.failure_code === 'retry_exhausted' ? pl('retriesExhausted') : pl('feedbackFailed');
      html = `<p class="err"><strong data-practice-key="ui14">Unbewertet.</strong> ${reason} ${pl('textPreserved')}</p>` + sent + (!s.readonly ? button('writing-retry', pl('retryGrade')) + button('writing-revise', pl('revise')) : '');
    } else {
      html = '<p class="muted" data-practice-key="ui15">Abgegeben. Die Rückmeldung wird vorbereitet. Sie können diese Seite verlassen und den Stand im Verlauf wieder öffnen.</p>' + sent + button('writing-refresh', pl('refreshNow'));
    }
    say(s, html + '<div data-writing-explanation></div>');
    explanations?.mount(s.status.querySelector('[data-writing-explanation]'), {
      view: data.explanation_view, labels: writingExplanationLabels(data), labelLanguage: s.task?.exam_language || getExamLanguage() || 'und', isCurrent: () => current(s) && s.submission === submissionId && resultRequest === s.resultRequest,
      read: async language => { const response = await api.writing.result(submissionId, language); return { ...response, data: response?.data?.explanation_view, parent: response?.data }; },
      onConfirmed: parent => {
        if (!parent || !current(s)) return;
        if (parent.review_withdrawn && !parent.blocked_reason) {
          s.host.querySelector('#writing-revise')?.remove();
          if (!s.status.querySelector('[data-review-withdrawn]')) { const notice = document.createElement('p'); notice.className = 'hint'; notice.dataset.reviewWithdrawn = ''; notice.textContent = reviewHistoryNotice(parent); s.status.prepend(notice); }
        }
        if (!parent.blocked_reason) return;
        s.blocked = true; s.task = {}; s.result = parent;
        s.host.querySelector('.writing-prompt')?.replaceChildren(); s.host.querySelector('#writing-rubric')?.remove();
        s.status.querySelector('.criteria')?.remove();
        s.status.querySelector('[data-review-withdrawn]')?.remove();
        s.host.querySelector('#writing-revise')?.remove();
      },
    });
    if (tries === 0) s.status.scrollIntoView({ block: 'nearest' });
    s.host.querySelector('#writing-refresh')?.addEventListener('click', () => showResult(s, submissionId));
    s.host.querySelector('#writing-retry')?.addEventListener('click', async (e) => {
      e.currentTarget.disabled = true;
      const retry = await api.writing.retry(submissionId);
      if (!current(s)) return;
      if (contentRefused(retry)) { blockContent(s, '<p class="err" data-practice-key="ui16">Die Aufgabe ist zurzeit gesperrt. Ihr abgegebener Text bleibt erhalten.</p>' + sent); return; }
      if (!retry?.ok) { say(s, `<p class="err">${message(retry)} ${pl('anotherUnavailable')}</p>` + sent + button('writing-refresh', pl('refreshNow'))); s.host.querySelector('#writing-refresh').onclick = () => showResult(s, submissionId); return; }
      await showResult(s, submissionId);
    });
    s.host.querySelector('#writing-revise')?.addEventListener('click', () => open(s.host, s.task, { parentSubmissionId: submissionId, onClose: s.attached ? () => open(s.host, s.task, { submissionId, attached: true }) : s.onClose }));
    if (state === 'pending' && (job.status === 'queued' || job.status === 'running') && tries < 10) s.poll = setTimeout(() => showResult(s, submissionId, tries + 1), 1800);
  }
  async function open(host, task, options = {}) {
    if (sessionBlocked) return false;
    if (!(await flush())) return false;
    dispose();
    const list = host.parentElement?.querySelector('.stack[id^="skill-"]');
    const s = { host, task: task || {}, list, saved: '', revision: 1, timer: null, poll: null, attempt: null, submission: null, saving: null, conflict: false, attached: Boolean(options.attached), readonly: Boolean(options.readonly), blocked: false, onClose: options.onClose, id: ++serial };
    active = s;
    if (list) list.hidden = true;
    host.hidden = false;
    const close = s.attached ? '' : button('writing-close', pl('close'));
    host.innerHTML = `<div class="card"><div class="writing-prompt">${prompt(s.task)}</div>${close}<div id="writing-state" class="writing-state" role="status" aria-live="polite" data-practice-key="ui17">Wird geladen …</div></div>`;
    s.status = host.querySelector('#writing-state'); updatePracticeLocale(host); bindClose(s);
    if (!s.attached) host.scrollIntoView({ block: 'start' });
    if (options.submissionId) {
      const r = await api.writing.result(options.submissionId);
      if (!current(s)) return false;
      if (r?.ok && r.data.task) s.task = { ...s.task, ...r.data.task };
      if (r?.data?.blocked_reason) s.task = {};
      host.querySelector('.card').innerHTML = '<div class="writing-prompt">' + prompt(s.task) + '</div>' + close + '<div id="writing-state" class="writing-state" role="status" aria-live="polite"></div><details class="rubric-panel" id="writing-rubric"><summary data-practice-key="ui18">Wie wird bewertet?</summary><div id="writing-rubric-body" data-practice-key="ui17">Wird geladen …</div></details>';
      s.status = host.querySelector('#writing-state'); updatePracticeLocale(host); bindClose(s);
      if (r?.ok && !r.data.blocked_reason) void rubric(s, r.data.rubric);
      await showResult(s, options.submissionId);
      return true;
    }
    let result;
    if (options.parentSubmissionId) result = await api.writing.createAttempt({ parentSubmissionId: options.parentSubmissionId });
    else if (options.attemptId) result = await api.writing.readAttempt(options.attemptId);
    else {
      const available = await api.writing.openAttempts();
      if (!current(s)) return false;
      if (!available?.ok) { say(s, `<p class="err">${message(available)} ${pl('draftsUnavailable')}</p>`); return false; }
      const old = available.data.attempts.find(a => !a.mock_run_id && a.task_id === s.task.task_id && a.task_version === s.task.version);
      result = old ? await api.writing.readAttempt(old.id) : await api.writing.createAttempt({ taskId: s.task.task_id, taskVersion: s.task.version, rubricId: s.task.rubric_id, rubricVersion: s.task.rubric_version });
    }
    if (!current(s)) return false;
    if (!result?.ok) {
      say(s, `<p class="err">${message(result)} ${pl('draftUnavailable')}</p>` + button('writing-open-retry', pl('loadDraft')));
      host.querySelector('#writing-open-retry').onclick = () => open(host, task, options);
      return false;
    }
    s.attempt = result.data.id; s.revision = result.data.revision; s.saved = result.data.text || '';
    s.blocked = Boolean(result.data.blocked_reason);
    if (s.blocked) s.task = {};
    if (result.data.task) s.task = { ...s.task, ...result.data.task };
    const linked = result.data.mock_run_id && !s.attached;
    if (linked) s.readonly = true;
    host.innerHTML = `<div class="card"><div class="writing-prompt">${s.blocked ? '<h3 data-practice-key="ui19">Gespeicherter Text</h3>' : prompt(s.task)}</div>${linked ? `<p data-practice-key="ui20">Dieser Text gehört zu einem gespeicherten Prüfungslauf.</p><a class="btn" href="#/lauf/${esc(result.data.mock_run_id)}" data-practice-key="ui21">Lauf öffnen</a>` : ''}<label class="field-label" for="writing-text" data-practice-key="ui22">Ihr Text</label><textarea id="writing-text" class="writing-text" lang="${esc(s.task?.exam_language || getExamLanguage() || 'und')}" dir="${(s.task?.exam_language || getExamLanguage()) === 'ar' ? 'rtl' : 'ltr'}" rows="12" maxlength="12000" aria-describedby="writing-state"></textarea><p class="small muted">${s.blocked ? pl('blockedCopy') : s.readonly ? pl('readOnly') : s.attached ? pl('attachedDraft') : pl('draftHelp')}</p><div class="row">${s.attached || s.readonly || s.blocked ? '' : button('writing-submit', pl('submit'), true) + button('writing-new', pl('restart'))}${close}</div><div id="writing-state" class="writing-state" role="status" aria-live="polite"><p class="muted">${s.saved ? pl('resumedDraft') : pl('notSubmitted')}</p></div>${s.blocked ? '' : '<details class="rubric-panel" id="writing-rubric"><summary data-practice-key="ui18">Wie wird bewertet?</summary><div id="writing-rubric-body" data-practice-key="ui17">Wird geladen …</div></details>'}</div>`;
    s.area = host.querySelector('#writing-text'); s.area.value = s.saved;
    s.area.readOnly = s.readonly || s.blocked || !canEdit();
    s.status = host.querySelector('#writing-state'); updatePracticeLocale(host);
    bindClose(s); void rubric(s, result.data.rubric);
    s.area.addEventListener('input', () => { clearTimeout(s.timer); if (s.conflict || !canEdit()) return; say(s, '<p class="muted" data-practice-key="ui23">Noch nicht gespeichert …</p>'); s.timer = setTimeout(() => save(s), 600); });
    const submitButton = host.querySelector('#writing-submit');
    if (submitButton) submitButton.onclick = async (e) => {
      const trigger = e.currentTarget;
      if (s.submitting || s.submission || s.blocked || s.readonly || !canEdit()) return;
      s.submitting = true; trigger.disabled = true; s.area.readOnly = true;
      const discard = host.querySelector('#writing-new'); discard.disabled = true;
      clearTimeout(s.timer);
      const saved = await save(s);
      if (!current(s)) return;
      if (!saved) { s.submitting = false; trigger.disabled = s.blocked || s.readonly || !canEdit(); s.area.readOnly = trigger.disabled; discard.disabled = trigger.disabled || Boolean(s.eventId); return; }
      s.eventId ||= crypto.randomUUID();
      const submit = await api.writing.submit(s.attempt, s.revision, s.eventId);
      if (!current(s)) return;
      s.submitting = false;
      if (!submit?.ok) {
        if (contentRefused(submit)) { blockContent(s, '<p class="err" data-practice-key="ui24">Die Aufgabe ist zurzeit gesperrt. Ihr Text bleibt zum Kopieren sichtbar. Die Abgabe wurde nicht bestätigt.</p>'); return; }
        // An uncertain POST keeps its identity and frozen text. Retrying it cannot create a second job.
        trigger.disabled = false; bindPracticeText(trigger, 'checkSubmit');
        if (submit?.status > 0 && submit.status < 500) s.area.readOnly = false;
        say(s, `<p class="err">${message(submit)} ${pl('submitUncertain')}</p>`);
        return;
      }
      onChange(); await showResult(s, submit.data.submissionId);
    };
    const newButton = host.querySelector('#writing-new');
    if (newButton) newButton.onclick = async () => {
      if (s.submitting || s.submission || s.eventId || s.discarding) return;
      if (!confirm(pt('discardConfirm'))) return;
      s.discarding = true;
      clearTimeout(s.timer); if (s.saving) await s.saving;
      const removed = await api.writing.deleteAttempt(s.attempt);
      if (!current(s)) return;
      if (!removed?.ok) {
        s.discarding = false;
        if (removed?.error === 'submitted_attempt') {
          s.area.readOnly = true;
          host.querySelector('#writing-new').disabled = true;
          host.querySelector('#writing-submit').disabled = true;
          say(s, '<p class="err" data-practice-key="ui25">Dieser Entwurf wurde bereits in einem anderen Fenster abgegeben. Er wurde nicht verworfen. Ihr Text bleibt hier zum Kopieren sichtbar. Die Abgabe finden Sie im Verlauf.</p>');
        } else say(s, `<p class="err">${message(removed)} ${pl('notDiscarded')}</p>`);
        return;
      }
      s.saved = s.area.value; dispose(); await open(host, s.task);
    };
    return true;
  }
  window.addEventListener('beforeunload', (event) => { if (dirty(active) || active?.saving) { event.preventDefault(); event.returnValue = ''; } });
  function updateLocale(locale = getLocale()) {
    const s = active; if (!s?.host?.isConnected) return;
    updatePracticeLocale(s.host,locale); translateInstructions(s.host,locale);
    for (const node of s.host.querySelectorAll('[data-writing-feedback-heading]')) node.textContent = writingLabels(s.rubric,s.result?.assessment?.feedback?.kind,locale).heading;
    for (const node of s.host.querySelectorAll('[data-writing-rubric-notice]')) node.textContent = writingLabels(s.rubric, null, locale).notice;
    for (const node of s.host.querySelectorAll('[data-writing-rubric-review]')) node.textContent = contentReviewLabel(s.rubric,locale);
    for (const node of s.host.querySelectorAll('[data-review-withdrawn]')) node.textContent = reviewHistoryNotice({review_withdrawn:true},locale);
  }
  return { open, flush, dispose, updateLocale,
    async settle() { const s = active; if (s?.saving) await s.saving; return active === s; },
    get localDraft() { return dirty(active) ? { attempt_id: active.attempt, revision: active.revision, text: active.area.value } : null; },
    freeze(value) { if (value && active) clearTimeout(active.timer); if (active?.area) active.area.readOnly = value || active.readonly || active.blocked || Boolean(active.submission) || !canEdit(); }, get active() { return active; } };
}

import { contentReviewLabel, reviewHistoryNotice } from './review-labels.js';

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
export function writingLabels(rubric, feedbackKind = null) {
  const boundKind = rubric?.feedback_kind || (rubric?.rubric_id === 'writing.telc-b1' ? 'telc-b1-bands' : null);
  const telc = (!rubric?.exam_id || rubric.exam_id === 'telc-deutsch-b1')
    && (boundKind ? boundKind === 'telc-b1-bands' && (!feedbackKind || feedbackKind === boundKind) : !rubric && feedbackKind === 'telc-b1-bands');
  return {
    heading: telc ? 'Übungsfeedback nach den telc-Kriterien – keine offizielle Bewertung' : 'Übungsfeedback – keine offizielle Bewertung',
    notice: 'Vorläufige Rubrik: eigene Beschreibungen, nicht die offizielle Formulierung' + (telc ? ' von telc' : '') + '.',
  };
}
export function writingPrompt(task, esc) {
  return `<div class="card-head"><h3>${esc(task.topic || 'Gespeicherter Text')}</h3><span class="chip">Schreiben</span></div><p lang="de">${esc(task.situation || '')}</p>${task.adressat ? `<p class="small muted" lang="de">Anrede: ${esc(task.adressat)}</p>` : ''}<ul class="leitpunkte" lang="de">${(task.leitpunkte || []).map(p => `<li>${esc(p)}</li>`).join('')}</ul>`;
}

/** Owned writing lifecycle. Drafts and submitted feedback stay on the server. */
export function writingExplanationLabels(data) {
  return Object.fromEntries((data?.assessment?.feedback?.criteria || []).map(c => ['criterion/' + (c.key || c.id) + '/comment', writingCriterion(c, data.rubric).label]));
}
export function createWritingController({ api, esc, readAloud = null, explanations = null, onChange = () => {}, canEdit = () => true }) {
  let active = null;
  let serial = 0;
  let sessionBlocked = false;
  const labels = { aufgabe: 'Aufgabenbewältigung', kommunikation: 'Kommunikative Gestaltung', richtigkeit: 'Formale Richtigkeit' };
  const message = (r) => r?.status === 0 ? 'Keine Verbindung zum Server.' : r?.status === 429 ? 'Bitte warte kurz und versuche es erneut.' : 'Die Anfrage konnte nicht abgeschlossen werden.';
  const current = (s) => !sessionBlocked && active === s && s.host.isConnected;
  const say = (s, html) => { if (current(s)) { explanations?.dispose(s.status); readAloud?.clear(s.status); s.status.innerHTML = html; } };
  const button = (id, text, primary = false) => `<button type="button" class="btn${primary ? ' btn-primary' : ''}" id="${id}">${text}</button>`;
  const prompt = task => writingPrompt(task, esc);
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
    if (active.area && !active.submission) say(active, '<p class="err">Dieses Fenster kann nicht mehr speichern. Dein Text bleibt zum Kopieren sichtbar. Melde dich danach erneut an.</p>');
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
    say(s, `<p class="err">${error || 'Dieser Entwurf wurde in einem anderen Fenster geändert. Dein Text bleibt hier erhalten. Vergleiche beide Fassungen, bevor du weiterschreibst.'}</p>` + button('writing-compare', 'Gespeicherten Text vergleichen'));
    s.host.querySelector('#writing-compare').onclick = async () => {
      const remote = await api.writing.readAttempt(s.attempt);
      if (!current(s)) return;
      if (!remote?.ok) { compareConflict(s, 'Die andere Fassung konnte nicht geladen werden. Dein Text bleibt erhalten. Versuche den Vergleich erneut.'); return; }
      say(s, `<p class="err">Speicherkonflikt – deine Eingabe bleibt im Textfeld.</p><details open><summary>Auf dem Server gespeicherte Fassung</summary><pre class="submitted-text">${esc(remote.data.text || '')}</pre></details>` + button('writing-keep', 'Meine Fassung speichern') + button('writing-load', 'Gespeicherte Fassung übernehmen'));
      s.host.querySelector('#writing-keep').onclick = async () => { s.revision = remote.data.revision; s.conflict = false; await save(s); };
      s.host.querySelector('#writing-load').onclick = () => { s.area.value = remote.data.text || ''; s.saved = s.area.value; s.revision = remote.data.revision; s.conflict = false; say(s, '<p class="muted">Gespeicherte Fassung übernommen.</p>'); };
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
    say(s, '<p class="muted">Wird gespeichert …</p>');
    s.saving = api.writing.saveDraft(s.attempt, s.revision, text);
    const res = await s.saving;
    s.saving = null;
    if (!current(s)) return false;
    if (res?.ok) {
      s.revision = res.data.revision;
      s.saved = text;
      if (dirty(s)) return save(s);
      say(s, '<p class="muted">Gespeichert. Noch nichts abgegeben.</p>');
      return true;
    }
    if (sessionBlocked) return false;
    if (['mock_group_inactive', 'mock_expired', 'mock_finalised'].includes(res?.error)) {
      s.error = res.error; s.area.readOnly = true;
      say(s, '<p class="err">Die Schreibzeit ist beendet. Deine unbestätigte Eingabe bleibt zum Kopieren erhalten; sie wurde nicht als gespeichert bestätigt.</p>');
      onChange(); return false;
    }
    if (contentRefused(res)) {
      blockContent(s, '<p class="err">Die Aufgabe ist zurzeit gesperrt. Deine Eingabe bleibt hier zum Kopieren sichtbar; sie wurde nicht gespeichert.</p>');
      return false;
    }
    if (res?.status === 409 && res.error === 'draft_conflict') {
      s.conflict = true;
      compareConflict(s);
      return false;
    }
    say(s, `<p class="err">${message(res)} Dein Text ist noch nicht gespeichert. Lass dieses Fenster geöffnet.</p>` + button('writing-save-again', 'Erneut speichern'));
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
    if (!response?.ok) { target.textContent = 'Die Bewertungskriterien sind gerade nicht verfügbar.'; return; }
    const r = response.data;
    s.rubric = r;
    target.innerHTML = `<p class="small muted">${esc(writingLabels(r).notice)} ${esc(contentReviewLabel(r))}</p><ol class="rubric-criteria">${(r.criteria || []).map(c => `<li><strong>${esc(c.label || c.name || labels[c.key] || c.key || '')}</strong>${c.description ? `<p>${esc(c.description)}</p>` : ''}<ul class="rubric-bands">${Object.entries(c.descriptors || {}).map(([band, text]) => `<li><span class="band">${esc(c.bandLabels?.[band] || band)}</span> ${esc(text)}</li>`).join('')}</ul></li>`).join('')}</ol>`;
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
      say(s, `<p class="err">${message(res)} Dein abgegebener Text bleibt gespeichert.</p>` + button('writing-refresh', 'Stand erneut laden'));
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
    const sent = `<details class="submitted"><summary>Dein abgegebener Text</summary><pre class="submitted-text">${esc(text)}</pre></details>`;
    if (s.area) { s.area.value = text; s.area.readOnly = true; s.area.disabled = false; }
    const submit = s.host.querySelector('#writing-submit'); if (submit) submit.disabled = true;
    const fresh = s.host.querySelector('#writing-new'); if (fresh) fresh.hidden = true;
    let html;
    if (state === 'assessed') {
      const f = assessment.feedback || {};
      html = `<p class="muted"><strong>${esc(writingLabels(s.rubric, f.kind).heading)}</strong></p><p class="small muted">Lokaler Pilot: Die Rückmeldung stammt derzeit aus einer technischen Simulation. Sie bewertet deine Sprachleistung nicht verlässlich.</p>`;
      const supported = f.kind === (s.rubric?.feedback_kind || 'telc-b1-bands');
      html += supported && Array.isArray(f.criteria)
        ? `<ul class="criteria">${f.criteria.map(c => { const view = writingCriterion(c, s.rubric); return `<li class="criterion"><div class="criterion-head"><strong>${esc(view.label || labels[c.key])}</strong><span class="band"><span class="sr-only">Band </span>${esc(view.band)}</span></div>${c.evidence ? `<blockquote class="evidence" lang="de" dir="ltr">${esc(c.evidence)}</blockquote>` : ''}</li>`; }).join('')}</ul>` : '';
      html += (data.review_withdrawn ? `<p class="hint" data-review-withdrawn>${esc(reviewHistoryNotice(data))}</p>` : '') + sent + (!s.readonly && !data.review_withdrawn ? button('writing-revise', 'Text überarbeiten', true) : '');
    } else if (state === 'blocked') {
      html = '<p class="err">Die Aufgabe und Rückmeldung sind zurzeit gesperrt. Dein abgegebener Text bleibt erhalten.</p>' + sent;
    } else if (state === 'unassessed') {
      const reason = job.failure_code === 'allowance_exhausted' ? 'Für diese Prüfung ist derzeit keine Rückmeldung mehr verfügbar.' : 'Es wurde kein Text zur Bewertung abgegeben.';
      html = `<p class="muted"><strong>Unbewertet.</strong> ${reason} Die gespeicherte Fassung bleibt erhalten.</p>` + sent + (!s.readonly ? button('writing-revise', 'Text überarbeiten') : '');
    } else if (state === 'failed') {
      const reason = job.failure_code === 'grader_unavailable' ? 'Der Bewertungsdienst ist gerade nicht verfügbar.' : job.failure_code === 'retry_exhausted' ? 'Die möglichen Wiederholungen sind aufgebraucht.' : 'Die Rückmeldung konnte nicht erstellt werden.';
      html = `<p class="err"><strong>Unbewertet.</strong> ${reason} Dein Text bleibt erhalten.</p>` + sent + (!s.readonly ? button('writing-retry', 'Erneut bewerten') + button('writing-revise', 'Text überarbeiten') : '');
    } else {
      html = '<p class="muted">Abgegeben. Die Rückmeldung wird vorbereitet. Du kannst diese Seite verlassen und den Stand im Verlauf wieder öffnen.</p>' + sent + button('writing-refresh', 'Stand aktualisieren');
    }
    say(s, html + '<div data-writing-explanation></div>');
    explanations?.mount(s.status.querySelector('[data-writing-explanation]'), {
      view: data.explanation_view, labels: writingExplanationLabels(data), isCurrent: () => current(s) && s.submission === submissionId && resultRequest === s.resultRequest,
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
      if (contentRefused(retry)) { blockContent(s, '<p class="err">Die Aufgabe ist zurzeit gesperrt. Dein abgegebener Text bleibt erhalten.</p>' + sent); return; }
      if (!retry?.ok) { say(s, `<p class="err">${message(retry)} Ein weiterer Versuch ist derzeit nicht möglich.</p>` + sent + button('writing-refresh', 'Stand aktualisieren')); s.host.querySelector('#writing-refresh').onclick = () => showResult(s, submissionId); return; }
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
    const close = s.attached ? '' : button('writing-close', 'Schließen');
    host.innerHTML = `<div class="card"><div class="writing-prompt">${prompt(s.task)}</div>${close}<div id="writing-state" class="writing-state" role="status" aria-live="polite">Wird geladen …</div></div>`;
    s.status = host.querySelector('#writing-state'); bindClose(s);
    if (!s.attached) host.scrollIntoView({ block: 'start' });
    if (options.submissionId) {
      const r = await api.writing.result(options.submissionId);
      if (!current(s)) return false;
      if (r?.ok && r.data.task) s.task = { ...s.task, ...r.data.task };
      if (r?.data?.blocked_reason) s.task = {};
      host.querySelector('.card').innerHTML = '<div class="writing-prompt">' + prompt(s.task) + '</div>' + close + '<div id="writing-state" class="writing-state" role="status" aria-live="polite"></div><details class="rubric-panel" id="writing-rubric"><summary>Wie wird bewertet?</summary><div id="writing-rubric-body">Wird geladen …</div></details>';
      s.status = host.querySelector('#writing-state'); bindClose(s);
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
      if (!available?.ok) { say(s, `<p class="err">${message(available)} Die gespeicherten Entwürfe konnten nicht geladen werden.</p>`); return false; }
      const old = available.data.attempts.find(a => !a.mock_run_id && a.task_id === s.task.task_id && a.task_version === s.task.version);
      result = old ? await api.writing.readAttempt(old.id) : await api.writing.createAttempt({ taskId: s.task.task_id, taskVersion: s.task.version, rubricId: s.task.rubric_id, rubricVersion: s.task.rubric_version });
    }
    if (!current(s)) return false;
    if (!result?.ok) {
      say(s, `<p class="err">${message(result)} Der Entwurf konnte nicht geöffnet werden.</p>` + button('writing-open-retry', 'Entwurf erneut laden'));
      host.querySelector('#writing-open-retry').onclick = () => open(host, task, options);
      return false;
    }
    s.attempt = result.data.id; s.revision = result.data.revision; s.saved = result.data.text || '';
    s.blocked = Boolean(result.data.blocked_reason);
    if (s.blocked) s.task = {};
    if (result.data.task) s.task = { ...s.task, ...result.data.task };
    const linked = result.data.mock_run_id && !s.attached;
    if (linked) s.readonly = true;
    host.innerHTML = `<div class="card"><div class="writing-prompt">${s.blocked ? '<h3>Gespeicherter Text</h3>' : prompt(s.task)}</div>${linked ? `<p>Dieser Text gehört zu einem gespeicherten Prüfungslauf.</p><a class="btn" href="#/lauf/${esc(result.data.mock_run_id)}">Lauf öffnen</a>` : ''}<label class="field-label" for="writing-text">Dein Text</label><textarea id="writing-text" class="writing-text" lang="de" rows="12" maxlength="12000" aria-describedby="writing-state"></textarea><p class="small muted">${s.blocked ? 'Die Aufgabe ist zurzeit gesperrt. Dein Text bleibt zum Kopieren sichtbar.' : s.readonly ? 'Gespeicherte Fassung · schreibgeschützt.' : s.attached ? 'Dein Entwurf wird während der Schreibzeit gespeichert. Mit dem Abschließen des Laufs gibst du die bestätigte Fassung unverändert ab.' : 'Dein Entwurf wird beim Schreiben gespeichert. Mit „Abgeben“ bleibt diese Fassung unverändert erhalten.'}</p><div class="row">${s.attached || s.readonly || s.blocked ? '' : button('writing-submit', 'Abgeben', true) + button('writing-new', 'Neu anfangen')}${close}</div><div id="writing-state" class="writing-state" role="status" aria-live="polite"><p class="muted">${s.saved ? 'Gespeicherter Entwurf fortgesetzt.' : 'Noch nichts abgegeben.'}</p></div>${s.blocked ? '' : '<details class="rubric-panel" id="writing-rubric"><summary>Wie wird bewertet?</summary><div id="writing-rubric-body">Wird geladen …</div></details>'}</div>`;
    s.area = host.querySelector('#writing-text'); s.area.value = s.saved;
    s.area.readOnly = s.readonly || s.blocked || !canEdit();
    s.status = host.querySelector('#writing-state');
    bindClose(s); void rubric(s, result.data.rubric);
    s.area.addEventListener('input', () => { clearTimeout(s.timer); if (s.conflict || !canEdit()) return; say(s, '<p class="muted">Noch nicht gespeichert …</p>'); s.timer = setTimeout(() => save(s), 600); });
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
        if (contentRefused(submit)) { blockContent(s, '<p class="err">Die Aufgabe ist zurzeit gesperrt. Dein Text bleibt zum Kopieren sichtbar. Die Abgabe wurde nicht bestätigt.</p>'); return; }
        // An uncertain POST keeps its identity and frozen text. Retrying it cannot create a second job.
        trigger.disabled = false; trigger.textContent = 'Abgabe erneut prüfen';
        if (submit?.status > 0 && submit.status < 500) s.area.readOnly = false;
        say(s, `<p class="err">${message(submit)} Dein Text bleibt erhalten. Eine unklare Abgabe wird mit derselben Kennung erneut geprüft.</p>`);
        return;
      }
      onChange(); await showResult(s, submit.data.submissionId);
    };
    const newButton = host.querySelector('#writing-new');
    if (newButton) newButton.onclick = async () => {
      if (s.submitting || s.submission || s.eventId || s.discarding) return;
      if (!confirm('Diesen Entwurf verwerfen und neu anfangen?')) return;
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
          say(s, '<p class="err">Dieser Entwurf wurde bereits in einem anderen Fenster abgegeben. Er wurde nicht verworfen. Dein Text bleibt hier zum Kopieren sichtbar. Die Abgabe findest du im Verlauf.</p>');
        } else say(s, `<p class="err">${message(removed)} Dein Entwurf wurde nicht verworfen.</p>`);
        return;
      }
      s.saved = s.area.value; dispose(); await open(host, s.task);
    };
    return true;
  }
  window.addEventListener('beforeunload', (event) => { if (dirty(active) || active?.saving) { event.preventDefault(); event.returnValue = ''; } });
  return { open, flush, dispose,
    async settle() { const s = active; if (s?.saving) await s.saving; return active === s; },
    get localDraft() { return dirty(active) ? { attempt_id: active.attempt, revision: active.revision, text: active.area.value } : null; },
    freeze(value) { if (value && active) clearTimeout(active.timer); if (active?.area) active.area.readOnly = value || active.readonly || active.blocked || Boolean(active.submission) || !canEdit(); }, get active() { return active; } };
}

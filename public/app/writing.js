/** Owned writing lifecycle. Drafts and submitted feedback stay on the server. */
export function createWritingController({ api, esc, readAloud = null, onChange = () => {} }) {
  let active = null;
  let serial = 0;
  let sessionBlocked = false;
  const labels = { aufgabe: 'Aufgabenbewältigung', kommunikation: 'Kommunikative Gestaltung', richtigkeit: 'Formale Richtigkeit' };
  const message = (r) => r?.status === 0 ? 'Keine Verbindung zum Server.' : r?.status === 429 ? 'Bitte warte kurz und versuche es erneut.' : 'Die Anfrage konnte nicht abgeschlossen werden.';
  const current = (s) => !sessionBlocked && active === s && s.host.isConnected;
  const say = (s, html) => { if (current(s)) { readAloud?.clear(s.status); s.status.innerHTML = html; } };
  const button = (id, text, primary = false) => `<button type="button" class="btn${primary ? ' btn-primary' : ''}" id="${id}">${text}</button>`;
  const prompt = (task) => `<div class="card-head"><h3>${esc(task.topic || 'Gespeicherter Text')}</h3><span class="chip">Schreiben</span></div><p>${esc(task.situation || '')}</p>${task.adressat ? `<p class="small muted">Anrede: ${esc(task.adressat)}</p>` : ''}<ul class="leitpunkte">${(task.leitpunkte || []).map(p => `<li>${esc(p)}</li>`).join('')}</ul>`;
  const dirty = (s) => Boolean(s?.area && !s.submission && s.area.value !== s.saved);
  window.addEventListener('hatoove:session-expired', () => {
    if (!active) { sessionBlocked = true; return; }
    clearTimeout(active.timer); clearTimeout(active.poll);
    if (active.area) active.area.readOnly = true;
    for (const control of active.host.querySelectorAll('button')) control.disabled = true;
    if (active.area && !active.submission) say(active, '<p class="err">Dieses Fenster kann nicht mehr speichern. Dein Text bleibt zum Kopieren sichtbar. Melde dich danach erneut an.</p>');
    sessionBlocked = true;
  });
  function dispose() {
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
    s.host.querySelector('#writing-close').onclick = async () => {
      if (!(await save(s)) || !current(s)) return;
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
    target.innerHTML = `<p class="small muted">Vorläufige Rubrik: eigene Beschreibungen, nicht die offizielle Formulierung von telc. Prüfstatus: ${esc(r.review_status || 'unreviewed')}</p><ol class="rubric-criteria">${(r.criteria || []).map(c => `<li><strong>${esc(c.label || c.name || labels[c.key] || c.key || '')}</strong>${c.description ? `<p>${esc(c.description)}</p>` : ''}<ul class="rubric-bands">${Object.entries(c.descriptors || {}).map(([band, text]) => `<li><span class="band">${esc(band)}</span> ${esc(text)}</li>`).join('')}</ul></li>`).join('')}</ol>`;
  }
  async function showResult(s, submissionId, tries = 0) {
    if (!current(s)) return;
    s.submission = submissionId;
    s.status.dataset.submissionId = submissionId;
    const discard = s.host.querySelector('#writing-new'); if (discard) { discard.hidden = true; discard.disabled = true; }
    const res = await api.writing.result(submissionId);
    if (!current(s)) return;
    if (!res?.ok) {
      say(s, `<p class="err">${message(res)} Dein abgegebener Text bleibt gespeichert.</p>` + button('writing-refresh', 'Stand erneut laden'));
      s.host.querySelector('#writing-refresh').onclick = () => showResult(s, submissionId);
      return;
    }
    const data = res.data, job = data.job || {}, assessment = data.assessment;
    if (data.task) s.task = { ...s.task, ...data.task };
    s.result = data;
    const text = data.submission?.text || '';
    const sent = `<details class="submitted"><summary>Dein abgegebener Text</summary><pre class="submitted-text">${esc(text)}</pre></details>`;
    if (s.area) { s.area.value = text; s.area.readOnly = true; s.area.disabled = false; }
    const submit = s.host.querySelector('#writing-submit'); if (submit) submit.disabled = true;
    const fresh = s.host.querySelector('#writing-new'); if (fresh) fresh.hidden = true;
    let html;
    if (job.status === 'succeeded' && assessment) {
      const f = assessment.feedback || {};
      const storedLanguage = f.language || data.submission?.explanation_language;
      const lang = ['de', 'en', 'uk', 'ar', 'tr'].includes(storedLanguage) ? storedLanguage : 'de';
      html = '<p class="muted"><strong>Übungsfeedback nach den telc-Kriterien – keine offizielle Bewertung</strong></p><p class="small muted">Lokaler Pilot: Die Rückmeldung stammt derzeit aus einer technischen Simulation. Sie bewertet deine Sprachleistung nicht verlässlich.</p>';
      html += f.kind === 'telc-b1-bands' && Array.isArray(f.criteria)
        ? `<ul class="criteria">${f.criteria.map(c => `<li class="criterion"><div class="criterion-head"><strong>${esc(labels[c.key] || c.label || c.key)}</strong><span class="band" aria-label="Band ${esc(c.band)}">${esc(c.band)}</span></div><p data-read-comment lang="${esc(lang)}" dir="${lang === 'ar' ? 'rtl' : 'ltr'}">${esc(c.comment || '')}</p>${c.evidence ? `<blockquote class="evidence" lang="de" dir="ltr">${esc(c.evidence)}</blockquote>` : ''}</li>`).join('')}</ul>`
        : `<p ${f.comment ? 'data-read-comment' : ''} lang="${esc(lang)}" dir="${lang === 'ar' ? 'rtl' : 'ltr'}">${esc(f.comment || 'Noch keine Rückmeldung verfügbar.')}</p>`;
      if (Array.isArray(f.corrections) && f.corrections.length) html += `<section lang="${lang}" dir="${lang === 'ar' ? 'rtl' : 'ltr'}"><h4>Korrekturhinweise</h4><ul>${f.corrections.map(text => `<li>${esc(text)}</li>`).join('')}</ul></section>`;
      html += sent + button('writing-revise', 'Text überarbeiten', true);
    } else if (job.status === 'failed') {
      const reason = job.failure_code === 'grader_unavailable' ? 'Der Bewertungsdienst ist gerade nicht verfügbar.' : job.failure_code === 'retry_exhausted' ? 'Die möglichen Wiederholungen sind aufgebraucht.' : 'Die Rückmeldung konnte nicht erstellt werden.';
      html = `<p class="err"><strong>Unbewertet.</strong> ${reason} Dein Text bleibt erhalten.</p>` + sent + button('writing-retry', 'Erneut bewerten') + button('writing-revise', 'Text überarbeiten');
    } else {
      html = '<p class="muted">Abgegeben. Die Rückmeldung wird vorbereitet. Du kannst diese Seite verlassen und den Stand im Verlauf wieder öffnen.</p>' + sent + button('writing-refresh', 'Stand aktualisieren');
    }
    say(s, html);
    for (const comment of s.status.querySelectorAll('[data-read-comment]')) readAloud?.mount(comment, { label: 'Kommentar', language: comment.lang });
    if (tries === 0) s.status.scrollIntoView({ block: 'nearest' });
    s.host.querySelector('#writing-refresh')?.addEventListener('click', () => showResult(s, submissionId));
    s.host.querySelector('#writing-retry')?.addEventListener('click', async (e) => {
      e.currentTarget.disabled = true;
      const retry = await api.writing.retry(submissionId);
      if (!current(s)) return;
      if (!retry?.ok) { say(s, `<p class="err">${message(retry)} Ein weiterer Versuch ist derzeit nicht möglich.</p>` + sent + button('writing-refresh', 'Stand aktualisieren')); s.host.querySelector('#writing-refresh').onclick = () => showResult(s, submissionId); return; }
      await showResult(s, submissionId);
    });
    s.host.querySelector('#writing-revise')?.addEventListener('click', () => open(s.host, s.task, { parentSubmissionId: submissionId }));
    if ((job.status === 'queued' || job.status === 'running') && tries < 10) s.poll = setTimeout(() => showResult(s, submissionId, tries + 1), 1800);
  }
  async function open(host, task, options = {}) {
    if (sessionBlocked) return false;
    if (!(await flush())) return false;
    dispose();
    const list = host.parentElement?.querySelector('.stack[id^="skill-"]');
    const s = { host, task: task || {}, list, saved: '', revision: 1, timer: null, poll: null, attempt: null, submission: null, saving: null, conflict: false, id: ++serial };
    active = s;
    if (list) list.hidden = true;
    host.hidden = false;
    host.innerHTML = `<div class="card">${prompt(s.task)}${button('writing-close', 'Schließen')}<div id="writing-state" class="writing-state" role="status" aria-live="polite">Wird geladen …</div></div>`;
    s.status = host.querySelector('#writing-state'); bindClose(s);
    host.scrollIntoView({ block: 'start' });
    if (options.submissionId) {
      const r = await api.writing.result(options.submissionId);
      if (!current(s)) return false;
      if (r?.ok && r.data.task) s.task = { ...s.task, ...r.data.task };
      host.querySelector('.card').innerHTML = prompt(s.task) + button('writing-close', 'Schließen') + '<div id="writing-state" class="writing-state" role="status" aria-live="polite"></div><details class="rubric-panel" id="writing-rubric"><summary>Wie wird bewertet?</summary><div id="writing-rubric-body">Wird geladen …</div></details>';
      s.status = host.querySelector('#writing-state'); bindClose(s);
      if (r?.ok) void rubric(s, r.data.rubric);
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
      const old = available.data.attempts.find(a => a.task_id === s.task.task_id && a.task_version === s.task.version);
      result = old ? await api.writing.readAttempt(old.id) : await api.writing.createAttempt({ taskId: s.task.task_id, taskVersion: s.task.version, rubricId: s.task.rubric_id, rubricVersion: s.task.rubric_version });
    }
    if (!current(s)) return false;
    if (!result?.ok) { say(s, `<p class="err">${message(result)} Der Entwurf konnte nicht geöffnet werden.</p>`); return false; }
    s.attempt = result.data.id; s.revision = result.data.revision; s.saved = result.data.text || '';
    if (result.data.task) s.task = { ...s.task, ...result.data.task };
    host.innerHTML = `<div class="card">${prompt(s.task)}<label class="field-label" for="writing-text">Dein Text</label><textarea id="writing-text" class="writing-text" rows="12" maxlength="12000" aria-describedby="writing-state"></textarea><p class="small muted">Dein Entwurf wird beim Schreiben gespeichert. Mit „Abgeben“ bleibt diese Fassung unverändert erhalten.</p><div class="row">${button('writing-submit', 'Abgeben', true)}${button('writing-new', 'Neu anfangen')}${button('writing-close', 'Schließen')}</div><div id="writing-state" class="writing-state" role="status" aria-live="polite"><p class="muted">${s.saved ? 'Gespeicherter Entwurf fortgesetzt.' : 'Noch nichts abgegeben.'}</p></div><details class="rubric-panel" id="writing-rubric"><summary>Wie wird bewertet?</summary><div id="writing-rubric-body">Wird geladen …</div></details></div>`;
    s.area = host.querySelector('#writing-text'); s.area.value = s.saved;
    s.status = host.querySelector('#writing-state');
    bindClose(s); void rubric(s, result.data.rubric);
    s.area.addEventListener('input', () => { clearTimeout(s.timer); if (s.conflict) return; say(s, '<p class="muted">Noch nicht gespeichert …</p>'); s.timer = setTimeout(() => save(s), 600); });
    host.querySelector('#writing-submit').onclick = async (e) => {
      const trigger = e.currentTarget;
      if (s.submitting || s.submission) return;
      s.submitting = true; trigger.disabled = true; s.area.readOnly = true;
      const discard = host.querySelector('#writing-new'); discard.disabled = true;
      clearTimeout(s.timer);
      const saved = await save(s);
      if (!current(s)) return;
      if (!saved) { s.submitting = false; trigger.disabled = false; s.area.readOnly = false; discard.disabled = Boolean(s.eventId); return; }
      s.eventId ||= crypto.randomUUID();
      const submit = await api.writing.submit(s.attempt, s.revision, s.eventId);
      if (!current(s)) return;
      s.submitting = false;
      if (!submit?.ok) {
        // An uncertain POST keeps its identity and frozen text. Retrying it cannot create a second job.
        trigger.disabled = false; trigger.textContent = 'Abgabe erneut prüfen';
        if (submit?.status > 0 && submit.status < 500) s.area.readOnly = false;
        say(s, `<p class="err">${message(submit)} Dein Text bleibt erhalten. Eine unklare Abgabe wird mit derselben Kennung erneut geprüft.</p>`);
        return;
      }
      onChange(); await showResult(s, submit.data.submissionId);
    };
    host.querySelector('#writing-new').onclick = async () => {
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
  return { open, flush, dispose, get active() { return active; } };
}

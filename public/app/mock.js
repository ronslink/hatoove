/** Saved section practice. Responses exist only in this document until the server acknowledges them. */
const clone = value => JSON.parse(JSON.stringify(value));
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const responseValues = rows => [...rows].sort((a,b) => key(a).localeCompare(key(b))).map(row => [row.setId, row.version, row.itemId, row.answer]);
const sameResponses = (a, b) => equal(responseValues(a), responseValues(b));
const samePosition = (a, b) => a?.member === b?.member && a?.item === b?.item;
const key = row => [row.setId, row.version, row.itemId].join('\u0000');
export function mockMember(member) {
  const p = member.payload || {};
  const options = rows => (rows || []).map(row => ({ id: String(row.id), label: String(row.text ?? row.word ?? '') }));
  const mapped = value => Object.entries(value || {}).map(([id, label]) => ({ id, label: String(label) }));
  switch (member.interaction) {
    case 'matching_headlines': return { passage: '', options: options(p.headlines), items: (p.texts || []).map(v => ({ id: String(v.id), text: v.text })) };
    case 'single_choice': return { passage: p.text || '', items: (p.questions || []).map(v => ({ id: String(v.n), text: v.question, options: mapped(v.options) })) };
    case 'matching_ads': return { passage: '', options: [...options(p.ads), { id: 'x', label: 'Keine passende Anzeige' }], items: (p.situations || []).map(v => ({ id: String(v.n), text: v.text })) };
    case 'gap_choice': return { passage: p.letter || '', items: (p.gaps || []).map(v => ({ id: String(v.n), text: v.prompt || 'Lücke ' + v.n, options: mapped(v.options) })) };
    case 'gap_bank': return { passage: p.letter || '', options: options(p.bank), items: (p.gaps || []).map(v => ({ id: String(v.n), text: 'Lücke ' + v.n })) };
    default: return null;
  }
}

/** Pure state/transport boundary; the view cannot replace local answers with an uncertain reply. */
export function createMockSession({ api, eventId = () => crypto.randomUUID(), onChange = () => {}, canEdit = () => true, now = () => Date.now() }) {
  let run = null, responses = [], position = { member: 0, item: 0 }, pending = null, flight = null;
  let flushing = null, clockOffset = 0, reloading = false;
  let epoch = 0, error = null, localCopy = '', finalising = false;
  const changed = () => onChange();
  const expired = () => Boolean(run?.expired || (run?.state === 'active' && run?.deadline_at && Date.parse(run.deadline_at) <= now() + clockOffset));
  const writable = () => run?.state === 'active' && !run.blocked_reason && !expired() && canEdit() && !finalising && !reloading && pending?.kind !== 'finalise';
  const dirty = () => Boolean(run && (!sameResponses(responses, run.responses) || !samePosition(position, run.position)));
  const state = () => ({ run, responses: clone(responses), position: { ...position }, dirty: dirty(), pending: Boolean(pending), busy: Boolean(flight) || reloading, loading: reloading, error, localCopy, finalising, expired: expired(), writable: writable() });
  function load(value, keepCopy = false) {
    epoch++; clockOffset = value.server_now ? Date.parse(value.server_now) - now() : 0; run = clone(value); responses = clone(value.responses || []); position = clone(value.position || { member: 0, item: 0 });
    run.responses = clone(responses); run.position = clone(position); pending = null; flight = null; flushing = null; reloading = false; error = null; finalising = false;
    if (!keepCopy) localCopy = ''; changed();
  }
  async function send() {
    if (flight) return flight;
    if (!pending) return true;
    const ticket = epoch, operation = pending;
    flight = (async () => {
      let response;
      try { response = await api.mock[operation.kind](run.id, clone(operation.body)); }
      catch { response = { ok: false, status: 0, error: 'network' }; }
      if (ticket !== epoch) return false;
      if (!response?.ok) { error = response || { status: 0, error: 'network' }; return false; }
      const value = response.data;
      if (!value || value.id !== run.id || !Number.isInteger(value.revision)) { error = { status: 0, error: 'invalid_response' }; return false; }
      if (operation.kind === 'save' && value.state === 'active' && (!sameResponses(value.responses || [], operation.body.responses) || !samePosition(value.position, operation.body.position))) {
        error = { status: 409, error: 'run_changed' }; return false;
      }
      // A finalised acknowledgement is authoritative. Retain any divergent local selection as a copy.
      if (value.state === 'finalised') {
        if (!sameResponses(responses, value.responses)) localCopy = JSON.stringify({ responses, position }, null, 2);
        responses = clone(value.responses || []); position = clone(value.position);
      }
      run = clone(value); pending = null; error = null; return true;
    })();
    changed();
    try { return await flight; } finally { if (ticket === epoch) { flight = null; changed(); } }
  }
  async function performFlush() {
    if (!run) return true;
    if (reloading) return false;
    if (flight && !(await flight)) return false;
    if (pending && !(await send())) return false;
    while (dirty()) {
      if (run.state !== 'active' || run.blocked_reason || expired() || !canEdit()) return false;
      pending = { kind: 'save', body: { expectedRevision: run.revision, eventId: eventId(), responses: clone(responses), position: clone(position) } };
      if (!(await send())) return false;
    }
    return true;
  }
  function flush() {
    if (flushing) return flushing;
    const ticket = epoch;
    flushing = performFlush().finally(() => { if (ticket === epoch) flushing = null; });
    return flushing;
  }
  return {
    state, load, flush,
    answer(member, itemId, answer) {
      if (!writable()) return false;
      const row = { setId: member.set_id, version: member.version, itemId: String(itemId), answer };
      responses = responses.filter(value => key(value) !== key(row)); if (answer !== null) responses.push(row);
      error = pending ? error : null; changed(); return true;
    },
    async move(next) {
      if (!(await flush())) return false;
      const previous = position; position = { ...next };
      // Keep the current question visible until the position itself is durable.
      if (!(await flush())) { position = previous; changed(); return false; }
      changed(); return true;
    },
    async finalise() {
      if (!run || run.state !== 'active' || run.blocked_reason || !canEdit() || finalising) return false;
      finalising = true; changed();
      try {
        if (!(await flush())) return false;
        if (run.state === 'finalised') return true;
        pending = { kind: 'finalise', body: { expectedRevision: run.revision, eventId: eventId() } };
        return await send();
      } finally { finalising = false; changed(); }
    },
    async reload() {
      if (!run || flight || reloading) return false;
      const ticket = epoch; reloading = true; localCopy = JSON.stringify({ responses, position }, null, 2); changed();
      const response = await api.mock.read(run.id);
      if (ticket !== epoch) return false;
      if (!response?.ok) { reloading = false; error = response; changed(); return false; }
      load(response.data, true); return true;
    },
    dispose() { epoch++; run = null; pending = null; flight = null; flushing = null; reloading = false; error = null; responses = []; localCopy = ''; finalising = false; },
  };
}

export function createMockController({ api, esc, setLabel = member => member.title, canEdit = () => true, isArchived = () => false, onOpen = () => {}, onChange = () => {} }) {
  let host = null, generation = 0, timer = null, deadlineTimer = null, startOperation = null, confirm = false;
  let displayPosition = null, serverOffset = 0, deadlineReached = false;
  const session = createMockSession({ api, canEdit, onChange: () => { render(); onChange(); } });
  const button = (action, label, primary = false) => '<button type="button" class="btn' + (primary ? ' btn-primary' : '') + '" data-mock-action="' + action + '">' + label + '</button>';
  const date = value => new Date(value).toLocaleString('de-DE', { dateStyle: 'medium', timeStyle: 'short' });
  function stopTimers() { clearTimeout(timer); clearInterval(deadlineTimer); timer = null; deadlineTimer = null; }
  function message(error) {
    if (!error) return '';
    if (error.status === 401 || ['account_changed', 'stale_session'].includes(error.error)) return 'Die Sitzung ist nicht mehr gültig. Deine Auswahl bleibt hier. Kopiere sie vor der erneuten Anmeldung.';
    if (error.status === 409) return 'Der gespeicherte Stand hat sich geändert oder der Lauf ist gesperrt. Deine Auswahl bleibt hier. Lade den Serverstand ausdrücklich neu; deine lokale Auswahl bleibt als Kopie erhalten.';
    if (error.status === 0) return 'Die Speicherbestätigung fehlt. Deine Auswahl bleibt hier. Wiederholen verwendet denselben Speichervorgang.';
    return 'Der Vorgang konnte nicht bestätigt werden. Deine Auswahl bleibt hier. Bitte versuche es erneut oder lade den Serverstand.';
  }
  function recovery(snapshot) {
    return (snapshot.error ? '<div class="err" role="alert"><p>' + esc(message(snapshot.error)) + '</p><div class="row">' + button('retry', 'Vorgang wiederholen') + button('reload', 'Serverstand laden · lokale Kopie behalten') + '</div></div>' : '')
      + '<details class="mock-copy"' + (snapshot.localCopy ? ' open' : '') + '><summary>Eigene Antworten kopieren</summary><label class="field-label" for="mock-local-copy">' + (snapshot.localCopy ? 'Lokale Auswahl vor dem Laden' : 'Auswahl in diesem Fenster') + '</label><textarea id="mock-local-copy" class="writing-text" readonly>' + esc(snapshot.localCopy || JSON.stringify({ responses: snapshot.responses, position: snapshot.position }, null, 2)) + '</textarea><div class="row">' + button('reload', 'Serverstand laden · lokale Kopie behalten') + '</div></details>';
  }
  function render() {
    if (!host) return;
    const snapshot = session.state(), run = snapshot.run;
    if (!run) return;
    // Save status updates must not steal keyboard focus from the selected radio.
    const focused = host.contains(document.activeElement) ? document.activeElement?.getAttribute('data-focus') : null;
    const readonly = !snapshot.writable, members = run.members || [], total = members.reduce((n, m) => n + m.item_count, 0);
    const selected = snapshot.responses.filter(row => row.answer !== null).length;
    const status = snapshot.loading ? 'Serverstand wird geladen …' : snapshot.busy ? 'Wird gespeichert …' : snapshot.error ? 'Noch nicht bestätigt' : snapshot.dirty ? 'Änderungen noch nicht gespeichert' : 'Gespeichert · Stand ' + run.revision;
    const position = displayPosition || snapshot.position;
    const member = members[position.member], form = member && mockMember(member), item = form?.items[position.item];
    let body = '';
    if (run.blocked_reason) body = '<section class="card"><h3>Dieser Abschnitt ist zurzeit gesperrt</h3><p>Die Inhalte sind nicht verfügbar. Deine gespeicherten Antworten bleiben erhalten und können über dein Konto exportiert werden.</p></section>';
    else if (run.state === 'finalised') {
      const result = run.result;
      body = '<section class="card stack" id="mock-result"><h3>Abschnitt abgeschlossen</h3>' + (result ? '<p><strong>' + esc(result.correct) + ' von ' + esc(result.total) + ' Antworten richtig</strong> · ' + esc(result.unanswered) + ' unbeantwortet.</p><p class="muted">Das ist die Rückmeldung zu diesem geübten Abschnitt.</p><ol class="mock-results">' + result.items.map(row => '<li><strong>Teil ' + esc((members.findIndex(member => member.set_id === row.set_id && member.version === row.version) + 1) || '–') + ' · Aufgabe ' + esc(row.item_id) + '</strong><span>' + (row.unanswered ? 'Unbeantwortet' : 'Deine Antwort: ' + esc(row.answer) + ' · ' + (row.correct ? 'Richtig' : 'Nicht richtig')) + '</span>' + (row.correct_answer !== null && row.correct_answer !== undefined ? '<span>Passende Antwort: ' + esc(row.correct_answer) + '</span>' : '') + (row.explanation ? '<p lang="de">' + esc(row.explanation) + '</p>' : '') + '</li>').join('') + '</ol>' : '<p>Die Rückmeldung ist derzeit nicht verfügbar.</p>') + (canEdit() ? '<a class="btn" href="#/abschnitt">Neue Wiederholung auswählen</a>' : '') + '</section>';
    } else if (item) {
      const answer = snapshot.responses.find(row => row.setId === member.set_id && row.version === member.version && row.itemId === item.id)?.answer;
      body = '<div class="mock-layout"><section class="card stack mock-question"><p class="kicker">Teil ' + (position.member + 1) + ' von ' + members.length + ' · Aufgabe ' + esc(item.id) + '</p><h3 id="mock-question-title" tabindex="-1">' + esc(setLabel(member)) + '</h3>'
        + (form.passage ? '<div class="stimulus mock-passage" lang="de">' + esc(form.passage) + '</div>' : '')
        + '<fieldset class="mock-options"' + (readonly ? ' disabled' : '') + '><legend>' + esc(item.text) + '</legend>'
        + (item.options || form.options || []).map((option, i) => '<label class="option' + (answer === option.id ? ' selected' : '') + '"><input type="radio" name="mock-answer" data-focus="option-' + i + '" value="' + esc(option.id) + '"' + (answer === option.id ? ' checked' : '') + '><span class="letter">' + esc(option.id) + '</span><span lang="de">' + esc(option.label) + '</span></label>').join('')
        + '</fieldset>' + (!readonly ? button('clear', 'Auswahl zurücknehmen') : '') + '<div class="row">' + button('previous', 'Zurück') + button('next', 'Weiter', true) + '</div></section>'
        + '<aside class="card-flat stack mock-overview"><h3>Deine Aufgaben</h3>' + members.map((m, mi) => '<div><p class="kicker">Teil ' + (mi + 1) + '</p><div class="qnav">' + (mockMember(m)?.items || []).map((q, qi) => {
          const done = snapshot.responses.some(row => row.setId === m.set_id && row.version === m.version && row.itemId === q.id && row.answer !== null);
          return '<button type="button" class="btn btn-small' + (done ? ' mock-answered' : '') + '" data-mock-member="' + mi + '" data-mock-item="' + qi + '" aria-label="Teil ' + (mi + 1) + ', Aufgabe ' + esc(q.id) + (done ? ', beantwortet' : ', unbeantwortet') + '"' + (position.member === mi && position.item === qi ? ' aria-current="step"' : '') + '>' + esc(q.id) + '</button>';
        }).join('') + '</div></div>').join('') + '<p class="small muted">Rückmeldung erst nach dem Abschließen.</p></aside></div>';
    } else body = '<section class="card"><p>Dieser Inhalt kann nicht angezeigt werden. Deine Antworten bleiben gespeichert.</p></section>';
    const expired = run.expired || (run.deadline_at && Date.parse(run.deadline_at) <= Date.now() + serverOffset);
    host.innerHTML = '<div class="card mock-heading"><div><p class="kicker">Gespeicherte Abschnittsübung · ' + esc(run.exam_id) + '</p><h2>' + esc(run.title) + '</h2><p class="small muted">Formular ' + esc(run.form_version) + ' · Ausgabe ' + esc(run.release_version) + ' · ' + (run.mode === 'untimed' ? 'Ohne Zeitlimit' : '<span id="mock-deadline"></span>') + '</p></div><p id="mock-save-state" role="status" aria-live="polite">' + esc(status) + '</p></div>'
      + (isArchived() ? '<p class="hint">Archivierte Vorbereitung · schreibgeschützt.</p>' : '')
      + (expired && run.state === 'active' ? '<p class="err">Die Zeit ist abgelaufen. Abschließen wertet nur bestätigte Antworten aus. Bei ungespeicherten Änderungen: erst die lokale Kopie sichern und den Serverstand laden.</p>' : '')
      + recovery(snapshot) + body
      + (run.state === 'active' && !run.blocked_reason && canEdit() ? '<section class="card stack mock-finish"><p>' + selected + ' von ' + total + ' beantwortet · ' + Math.max(0, total - selected) + ' unbeantwortet.</p>' + (confirm ? '<p>Jetzt abschließen? Danach kannst du diese Antworten nicht mehr ändern. Unbeantwortete Aufgaben bleiben als unbeantwortet erhalten.</p><div class="row">' + button('finalise', 'Verbindlich abschließen', true) + button('cancel', 'Weiter bearbeiten') + '</div>' : '<div class="row">' + button('save', 'Jetzt speichern') + button('confirm', 'Abschnitt abschließen', true) + '</div>') + '</section>' : '')
      + '<a class="btn" href="#/abschnitt">Zur Abschnittsübersicht</a>';
    if (snapshot.busy || snapshot.finalising) for (const b of host.querySelectorAll('[data-mock-action], [data-mock-member]')) b.disabled = true;
    if (focused) host.querySelector('[data-focus="' + focused + '"]')?.focus({ preventScroll: true });
    updateDeadline();
  }
  function updateDeadline() {
    const run = session.state().run, target = host?.querySelector('#mock-deadline');
    if (!run?.deadline_at || !target) return;
    if (run.state === 'finalised') {
      target.textContent = run.expired ? 'Nach Ablauf der Zeit abgeschlossen' : 'Innerhalb der Zeit abgeschlossen';
      return;
    }
    const seconds = Math.max(0, Math.ceil((Date.parse(run.deadline_at) - Date.now() - serverOffset) / 1000));
    target.textContent = seconds ? Math.floor(seconds / 60) + ':' + String(seconds % 60).padStart(2, '0') + ' verbleibend' : 'Zeit abgelaufen';
    if (!seconds && !deadlineReached) { deadlineReached = true; render(); return; }
    if (!seconds) for (const input of host.querySelectorAll('input[name="mock-answer"]')) input.disabled = true;
  }
  function attach(target) {
    host = target;
    host.onchange = event => {
      if (!event.target.matches('input[name="mock-answer"]')) return;
      const snapshot = session.state(), p = displayPosition || snapshot.position, m = snapshot.run?.members[p.member], item = m && mockMember(m)?.items[p.item];
      if (item && session.answer(m, item.id, event.target.value)) { clearTimeout(timer); timer = setTimeout(() => void session.flush(), 650); }
    };
    host.onclick = async event => {
      const element = event.target.closest('[data-mock-action], [data-mock-member]');
      if (!element || element.disabled) return;
      const snapshot = session.state(), run = snapshot.run;
      if (!run) return;
      const p = displayPosition || snapshot.position, m = run.members[p.member], form = m && mockMember(m);
      const action = element.dataset.mockAction;
      if (action === 'clear') { session.answer(m, form.items[p.item].id, null); await session.flush(); }
      if (['save', 'retry'].includes(action)) await session.flush();
      if (action === 'reload') { clearTimeout(timer); confirm = false; displayPosition = null; await session.reload(); }
      if (action === 'confirm') { confirm = true; render(); host.querySelector('[data-mock-action="finalise"]')?.focus(); }
      if (action === 'cancel') { confirm = false; render(); }
      if (action === 'finalise') { clearTimeout(timer); await session.finalise(); confirm = false; render(); }
      let next = null;
      if (element.dataset.mockMember !== undefined) next = { member: Number(element.dataset.mockMember), item: Number(element.dataset.mockItem) };
      if (action === 'next') next = p.item + 1 < form.items.length ? { member: p.member, item: p.item + 1 } : p.member + 1 < run.members.length ? { member: p.member + 1, item: 0 } : null;
      if (action === 'previous') next = p.item > 0 ? { member: p.member, item: p.item - 1 } : p.member > 0 ? { member: p.member - 1, item: mockMember(run.members[p.member - 1]).items.length - 1 } : null;
      if (next) {
        if (!canEdit() || snapshot.expired) { displayPosition = next; render(); }
        else { displayPosition = p; if (await session.move(next)) displayPosition = null; render(); }
        host.querySelector('#mock-question-title')?.focus();
      }
    };
  }
  async function showRun(target, id) {
    const ticket = ++generation; stopTimers(); attach(target); host.innerHTML = '<p class="muted" role="status">Gespeicherter Abschnitt wird geladen …</p>';
    const response = await api.mock.read(id);
    if (ticket !== generation) return false;
    if (!response?.ok) { host.innerHTML = '<p class="err">Der gespeicherte Abschnitt konnte nicht geladen werden.</p><a class="btn" href="#/abschnitt">Zur Übersicht</a>'; return false; }
    confirm = false; displayPosition = null; deadlineReached = false; serverOffset = response.data.server_now ? Date.parse(response.data.server_now) - Date.now() : 0;
    session.load(response.data); deadlineTimer = setInterval(updateDeadline, 1000); return true;
  }
  async function list(target) {
    const ticket = ++generation; stopTimers(); session.dispose(); attach(target); host.innerHTML = '<p class="muted" role="status">Abschnittsübungen werden geladen …</p>';
    const [forms, runs] = await Promise.all([api.mock.forms(), api.mock.list()]);
    if (ticket !== generation) return;
    const rows = runs?.ok ? runs.data?.runs || [] : [];
    host.innerHTML = '<div class="page-head"><div><p class="kicker">In deinem Tempo</p><h1>Gespeicherte Abschnittsübungen</h1><p>Bearbeite einen Abschnitt und erhalte die Rückmeldung am Ende. Deine bestätigten Antworten kannst du später fortsetzen.</p></div></div><div class="grid-dash"><section class="card stack"><h2>Einen Abschnitt beginnen</h2>'
      + (!canEdit() ? '<p>Diese Vorbereitung ist archiviert. Gespeicherte Abschnitte bleiben lesbar.</p>' : !forms?.ok ? '<p class="err">Die verfügbaren Abschnitte konnten nicht geladen werden.</p>' : !(forms.data?.forms || []).length ? '<p>Zurzeit ist kein Abschnitt für einen neuen Start verfügbar. Bereits gespeicherte Läufe findest du daneben.</p>' : forms.data.forms.map((form, i) => '<article class="mock-form"><h3>' + esc(form.title) + '</h3><p>' + esc(form.item_count) + ' Aufgaben · ' + (form.mode === 'untimed' ? 'Ohne Zeitlimit' : 'Mit Zeitlimit') + '</p><p class="small muted">' + esc(form.exam_id) + ' · Formular ' + esc(form.version) + ' · Ausgabe ' + esc(form.release_version) + '</p><button class="btn btn-primary" type="button" data-mock-start="' + i + '">Neuen Lauf beginnen</button></article>').join(''))
      + '<p id="mock-start-state" role="status"></p><button class="btn" type="button" data-mock-refresh>Übersicht erneut laden</button></section><section class="stack"><h2>Deine gespeicherten Abschnitte</h2>' + (!runs?.ok ? '<p class="err">Der Verlauf konnte nicht geladen werden.</p>' : historyMarkup(rows)) + '</section></div>';
    host.onclick = async event => {
      if (event.target.closest('[data-mock-refresh]')) { await list(target); return; }
      const trigger = event.target.closest('[data-mock-start]'); if (!trigger || trigger.disabled || !canEdit()) return;
      const form = forms.data.forms[Number(trigger.dataset.mockStart)]; if (!form) return;
      for (const b of host.querySelectorAll('[data-mock-start]')) b.disabled = true;
      const binding = { formId: form.form_id, formVersion: form.version, releaseVersion: form.release_version };
      if (!startOperation || !equal(startOperation.binding, binding)) startOperation = { binding, body: { ...binding, eventId: crypto.randomUUID() } };
      host.querySelector('#mock-start-state').textContent = 'Abschnitt wird angelegt …';
      const response = await api.mock.start(startOperation.body);
      if (ticket !== generation) return;
      if (!response?.ok) {
        host.querySelector('#mock-start-state').textContent = message(response); for (const b of host.querySelectorAll('[data-mock-start]')) b.disabled = false; return;
      }
      startOperation = null; onOpen(response.data);
    };
  }
  function historyMarkup(rows) {
    return rows.length ? rows.map(run => '<article class="card"><p class="kicker">' + esc(run.exam_id) + ' · Abschnittsübung</p><h3>' + esc(run.title) + '</h3><p class="small muted">Formular ' + esc(run.form_version) + ' · ' + esc(date(run.updated_at || run.created_at)) + '</p><p>' + (run.state === 'finalised' ? 'Abgeschlossen' : 'Gespeichert · noch offen') + '</p><a class="btn" data-mock-run="' + esc(run.id) + '" href="#/lauf/' + esc(run.id) + '">' + (run.state === 'finalised' || !canEdit() ? 'Ansehen' : 'Fortsetzen') + '</a></article>').join('') : '<article class="card"><p>Noch keine gespeicherten Abschnitte.</p></article>';
  }
  return {
    list, showRun, historyMarkup, refresh: render, flush: () => { clearTimeout(timer); return session.flush(); },
    get active() { return Boolean(session.state().run); }, get runId() { return session.state().run?.id; },
    dispose() { generation++; stopTimers(); session.dispose(); if (host) { host.onclick = null; host.onchange = null; } host = null; startOperation = null; },
    preserveOnUnload(event) { const state = session.state(); if (state.dirty || state.pending || state.busy) { event.preventDefault(); event.returnValue = ''; } },
  };
}

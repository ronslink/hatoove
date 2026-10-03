import { createWritingController, writingPrompt } from './writing.js';
import { createListeningController } from './listening.js';
import { contentReviewLabel, reviewHistoryNotice } from './review-labels.js';

/** Saved exam practice. Responses exist only in this document until the server acknowledges them. */
const clone = value => JSON.parse(JSON.stringify(value));
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const responseValues = rows => [...rows].sort((a,b) => key(a).localeCompare(key(b))).map(row => [row.setId, row.version, row.itemId, row.answer]);
const sameResponses = (a, b) => equal(responseValues(a), responseValues(b));
const samePosition = (a, b) => a?.member === b?.member && a?.item === b?.item;
const key = row => [row.setId, row.version, row.itemId].join('\u0000');
const wallNow = () => Date.now();
const steadyNow = () => globalThis.performance?.now() ?? Date.now();
export const mockScopeLabel = run => run?.scope === 'complete_supported_written' ? 'Schriftliche Probeprüfung' : 'Abschnittsübung';
export const mockWritingSection = run => run?.writing_task?.section || run?.writing_choices?.[0]?.section || 'writing';
export function mockWritingTask(run) {
  if (run?.writing?.binding_kind === 'assigned') return run.writing_task?.task || null;
  return run?.writing_choices?.find(group => group.id === run.writing?.choice_group_id)?.options.find(option => option.id === run.writing?.selected_option_id)?.task || null;
}
/** Immutable server windows, never client-selected timing or the DTO's potentially stale active ID. */
export function mockTiming(run, instant) {
  if (!run?.timing) return run?.scope === 'complete_supported_written' ? { valid: false, groups: [], active: null } : null;
  const source = run.timing.groups;
  if (run.timing.policy !== 'ordered-fixed-v1' || !Array.isArray(source) || !source.length) return { valid: false, groups: [], active: null };
  const ids = new Set(), sections = new Set(); let previous = null;
  const groups = source.map(group => {
    if (!group || typeof group !== 'object') return { valid: false };
    const start = Date.parse(group.starts_at), end = Date.parse(group.deadline_at);
    const valid = typeof group.id === 'string' && group.id && !ids.has(group.id) && Number.isFinite(start) && Number.isFinite(end) && start < end
      && (previous === null || previous === start) && Array.isArray(group.sections) && group.sections.length
      && group.sections.every(section => typeof section === 'string' && section && !sections.has(section)) && new Set(group.sections).size === group.sections.length;
    ids.add(group.id); for (const section of Array.isArray(group.sections) ? group.sections : []) sections.add(section); previous = end;
    return { ...group, start, end, valid: Boolean(valid), state: instant < start ? 'pending' : instant >= end ? 'closed' : 'active' };
  });
  const valid = groups.every(group => group.valid) && Number.isFinite(instant);
  return { valid, groups, active: valid ? groups.find(group => group.state === 'active') || null : null };
}
export function mockSectionWritable(run, section, instant) {
  const timing = mockTiming(run, instant);
  return !timing || Boolean(timing.valid && timing.active?.sections.includes(section));
}
export function mockReviewLabel(value) {
  const publication = { internal: 'Interner Entwurf', hidden: 'Nicht veröffentlicht', withdrawn: 'Zurückgezogene Ausgabe' }[value.release_state];
  const review = contentReviewLabel(value);
  return [publication, review].filter(Boolean).join(' · ');
}
export function mockWritingStatus(writing) {
  return ({ not_started: 'Schreibentwurf gespeichert', pending: 'Schreiben: Rückmeldung wird vorbereitet', assessed: 'Schreiben: Übungsfeedback gespeichert', failed: 'Schreiben: Rückmeldung fehlgeschlagen · Text erhalten', unassessed: 'Schreiben: Unbewertet · Text erhalten' })[writing?.assessment_state] || '';
}

/** Finalisation binds the last acknowledged draft; a failed save must never freeze older text. */
export async function finaliseMockWriting({ session, writing, language = 'de', ready = Promise.resolve(true) }) {
  const runId = session.state().run?.id;
  await ready;
  if (!(await writing.flush()) || session.state().run?.id !== runId || !(await session.flush())) return false;
  const run = session.state().run;
  if (!run || run.id !== runId) return false;
  const fields = run.writing_task || run.writing_choices?.length ? { explanationLanguage: language } : {};
  if (run.writing) {
    // Assigned writing already has a durable empty draft before its window opens.
    if (!writing.active && run.writing_task && Number.isInteger(run.writing.draft_revision)) fields.expectedWritingRevision = run.writing.draft_revision;
    else {
      if (writing.active?.attempt !== run.writing.attempt_id || !Number.isInteger(writing.active?.revision)) return false;
      fields.expectedWritingRevision = writing.active.revision;
    }
  }
  return session.finalise(fields);
}
export function mockMember(member) {
  const p = member.payload || {};
  const options = rows => (rows || []).map(row => ({ id: String(row.id), label: String(row.text ?? row.word ?? '') }));
  const mapped = value => Object.entries(value || {}).map(([id, label]) => ({ id, label: String(label) }));
  switch (member.interaction) {
    case 'fixed_audio': {
      if (!Array.isArray(p.recordings) || !p.recordings.length || !Array.isArray(member.recordings)) return null;
      const ids = new Set(), questions = new Set(), items = [];
      for (const recording of p.recordings) {
        const metadata = member.recordings.find(value => value.id === recording.id && value.media_id === recording.mediaId && value.media_version === recording.mediaVersion);
        if (!metadata || ids.has(recording.id) || !Array.isArray(recording.questions) || !recording.questions.length) return null;
        ids.add(recording.id);
        for (const question of recording.questions) {
          if (!question || !['string', 'number'].includes(typeof question.n) || questions.has(String(question.n)) || typeof question.question !== 'string'
            || !question.options || Array.isArray(question.options) || Object.keys(question.options).length < 2 || Object.values(question.options).some(value => typeof value !== 'string')) return null;
          questions.add(String(question.n));
          items.push({ id: String(question.n), text: question.question, options: mapped(question.options), recordingId: recording.id });
        }
      }
      return { passage: '', items };
    }
    case 'matching_headlines': return { passage: '', options: options(p.headlines), items: (p.texts || []).map(v => ({ id: String(v.id), text: v.text })) };
    case 'grouped_choice': {
      if (!Array.isArray(p.groups) || !p.groups.length) return null;
      const groups = new Set(), questions = new Set(), items = [];
      const token = value => (typeof value === 'string' && value.trim()) || (typeof value === 'number' && Number.isFinite(value));
      for (const group of p.groups) {
        if (!group || !token(group.id) || groups.has(String(group.id)) || typeof group.text !== 'string' || !group.text.trim()
          || !Array.isArray(group.questions) || !group.questions.length) return null;
        groups.add(String(group.id));
        for (const question of group.questions) {
          if (!question || !token(question.n) || questions.has(String(question.n)) || typeof question.question !== 'string' || !question.question.trim()
            || !question.options || typeof question.options !== 'object' || Array.isArray(question.options)
            || Object.keys(question.options).length < 2 || Object.entries(question.options).some(([id, label]) => !id.trim() || typeof label !== 'string' || !label.trim())) return null;
          questions.add(String(question.n));
          items.push({ id: String(question.n), text: question.question, options: mapped(question.options), passage: group.text, groupId: String(group.id) });
        }
      }
      return { passage: '', items };
    }
    case 'single_choice': return { passage: p.text || '', items: (p.questions || []).map(v => ({ id: String(v.n), text: v.question, options: mapped(v.options) })) };
    case 'matching_ads': return { passage: '', options: [...options(p.ads), { id: 'x', label: 'Keine passende Anzeige' }], items: (p.situations || []).map(v => ({ id: String(v.n), text: v.text })) };
    case 'gap_choice': return { passage: p.letter || '', items: (p.gaps || []).map(v => ({ id: String(v.n), text: v.prompt || 'Lücke ' + v.n, options: mapped(v.options) })) };
    case 'gap_bank': return { passage: p.letter || '', options: options(p.bank), items: (p.gaps || []).map(v => ({ id: String(v.n), text: 'Lücke ' + v.n })) };
    default: return null;
  }
}

/** Pure state/transport boundary; the view cannot replace local answers with an uncertain reply. */
export function createMockSession({ api, eventId = () => crypto.randomUUID(), onChange = () => {}, canEdit = () => true, now = wallNow, elapsedNow = now === wallNow ? steadyNow : now }) {
  let run = null, responses = [], position = { member: 0, item: 0 }, pending = null, flight = null;
  let flushing = null, serverBase = now(), elapsedBase = elapsedNow(), reloading = false;
  let epoch = 0, error = null, localCopy = '', finalising = false, choosing = false;
  const changed = () => onChange();
  const serverTime = () => serverBase + Math.max(0, elapsedNow() - elapsedBase);
  const clock = value => { const parsed = typeof value === 'number' ? value : Date.parse(value); serverBase = Number.isFinite(parsed) ? parsed : now(); elapsedBase = elapsedNow(); };
  const expired = () => Boolean(run?.expired || (run?.state === 'active' && run?.deadline_at && Date.parse(run.deadline_at) <= serverTime()));
  const writable = () => run?.state === 'active' && !run.blocked_reason && !expired() && canEdit() && !finalising && !choosing && !reloading && !['finalise', 'chooseWriting'].includes(pending?.kind);
  const dirty = () => Boolean(run && (!sameResponses(responses, run.responses) || !samePosition(position, run.position)));
  const state = () => ({ run, responses: clone(responses), position: { ...position }, dirty: dirty(), pending: Boolean(pending), pendingKind: pending?.kind || null, busy: Boolean(flight) || reloading || choosing, loading: reloading, error, localCopy, finalising, expired: expired(), writable: writable(), serverNow: serverTime() });
  function rememberLocal() {
    const value = JSON.stringify({ runId: run.id, responses, position }, null, 2);
    if (!localCopy.includes(value)) localCopy += (localCopy ? '\n\n' : '') + value;
  }
  function load(value, keepCopy = false) {
    const nextClock = value.id === run?.id ? Math.max(serverTime(), Date.parse(value.server_now)) : value.server_now;
    epoch++; clock(nextClock); run = clone(value); responses = clone(value.responses || []); position = clone(value.position || { member: 0, item: 0 });
    run.responses = clone(responses); run.position = clone(position); pending = null; flight = null; flushing = null; reloading = false; error = null; finalising = false; choosing = false;
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
      if (operation.kind === 'chooseWriting' && (value.writing?.choice_group_id !== operation.body.choiceGroupId || value.writing?.selected_option_id !== operation.body.optionId || !value.writing?.attempt_id)) {
        error = { status: 409, error: 'writing_choice_changed' }; return false;
      }
      // A finalised acknowledgement is authoritative. Retain any divergent local selection as a copy.
      if (value.state === 'finalised') {
        if (!sameResponses(responses, value.responses)) rememberLocal();
        responses = clone(value.responses || []); position = clone(value.position);
      }
      // A delayed acknowledgement must not move the elapsed clock backwards.
      if (value.server_now) clock(Math.max(serverTime(), Date.parse(value.server_now)));
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
      if (run.timing) {
        const before = new Map((run.responses || []).map(row => [key(row), row]));
        const after = new Map(responses.map(row => [key(row), row]));
        const changedOutside = [...new Set([...before.keys(), ...after.keys()])].some(id => {
          if ((before.get(id)?.answer ?? null) === (after.get(id)?.answer ?? null)) return false;
          const row = after.get(id) || before.get(id), member = run.members.find(value => value.set_id === row.setId && value.version === row.version);
          return !mockSectionWritable(run, member?.section, serverTime());
        });
        if (changedOutside) { error = { ok: false, status: 409, error: 'mock_group_inactive' }; changed(); return false; }
      }
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
    state, load, flush, now: serverTime,
    sectionWritable: section => writable() && mockSectionWritable(run, section, serverTime()),
    async settle() { const ticket = epoch; if (flight) await flight; return ticket === epoch; },
    answer(member, itemId, answer) {
      if (!writable() || !mockSectionWritable(run, member.section, serverTime())) return false;
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
    async chooseWriting(choiceGroupId, optionId) {
      if (!writable() || run.writing || run.writing_task || pending || !mockSectionWritable(run, mockWritingSection(run), serverTime())) return false;
      const choice = run.writing_choices?.find(group => group.id === choiceGroupId);
      if (!choice?.options?.some(option => option.id === optionId)) return false;
      const ticket = epoch; choosing = true; changed();
      try {
        if (!(await flush()) || ticket !== epoch) return false;
        pending = { kind: 'chooseWriting', body: { expectedRevision: run.revision, eventId: eventId(), choiceGroupId, optionId } };
        return await send();
      } finally { if (ticket === epoch) { choosing = false; changed(); } }
    },
    async finalise(writing = {}) {
      if (!run || run.state !== 'active' || run.blocked_reason || !canEdit() || finalising) return false;
      const ticket = epoch; finalising = true; changed();
      try {
        if (!(await flush()) || ticket !== epoch) return false;
        if (run.state === 'finalised') return true;
        pending = { kind: 'finalise', body: { expectedRevision: run.revision, eventId: eventId(), ...writing } };
        return await send();
      } finally { if (ticket === epoch) { finalising = false; changed(); } }
    },
    async reload({ preserveClean = true } = {}) {
      if (!run || flight || reloading) return false;
      const ticket = epoch; if (preserveClean || dirty() || pending) rememberLocal(); reloading = true; changed();
      const response = await api.mock.read(run.id);
      if (ticket !== epoch) return false;
      if (!response?.ok) { reloading = false; error = response; changed(); return false; }
      load(response.data, true); return true;
    },
    dispose() { epoch++; run = null; pending = null; flight = null; flushing = null; reloading = false; error = null; responses = []; localCopy = ''; finalising = false; choosing = false; },
  };
}

export function createMockController({ api, esc, setLabel = member => member.title, canEdit = () => true, isArchived = () => false, readAloud = null, explanations = null, explanationLanguage = () => 'de', onOpen = () => {}, onChange = () => {} }) {
  let host = null, generation = 0, timer = null, deadlineTimer = null, startOperation = null, confirm = false;
  let displayPosition = null, deadlineReached = false, workspace = 'objective', observedGroup = null;
  let boundaryChanging = false, boundaryMessage = '', boundaryFlight = null, boundaryAudioPending = false, copyPending = false, draftCopies = [];
  let writingBinding = null, writingReady = Promise.resolve(true), finishing = false;
  const writingAllowed = () => canEdit() && (writing.active && !writing.active.attached || session.state().run?.state === 'finalised' || session.sectionWritable(mockWritingSection(session.state().run)));
  const writing = createWritingController({ api, esc, readAloud, explanations, canEdit: writingAllowed, onChange: () => { onChange(); if (writing.active?.error === 'mock_group_inactive') void refreshTiming(); } });
  const listening = createListeningController({ api, esc, canEdit });
  const session = createMockSession({ api, canEdit, onChange: () => { render(); onChange(); } });
  const button = (action, label, primary = false) => '<button type="button" class="btn' + (primary ? ' btn-primary' : '') + '" data-mock-action="' + action + '">' + label + '</button>';
  const date = value => new Date(value).toLocaleString('de-DE', { dateStyle: 'medium', timeStyle: 'short' });
  function stopTimers() { clearTimeout(timer); clearInterval(deadlineTimer); timer = null; deadlineTimer = null; }
  function message(error) {
    if (!error) return '';
    if (error.status === 401 || ['account_changed', 'stale_session'].includes(error.error)) return 'Die Sitzung ist nicht mehr gültig. Deine Auswahl bleibt hier. Kopiere sie vor der erneuten Anmeldung.';
    if (error.error === 'mock_group_inactive') return 'Die Bearbeitungszeit dieses Abschnitts ist beendet oder noch nicht begonnen. Deine unbestätigte Auswahl bleibt als lokale Kopie erhalten.';
    if (error.status === 409) return 'Der gespeicherte Stand hat sich geändert oder der Lauf ist gesperrt. Deine Auswahl bleibt hier. Lade den Serverstand ausdrücklich neu; deine lokale Auswahl bleibt als Kopie erhalten.';
    if (error.status === 0) return 'Die Speicherbestätigung fehlt. Deine Auswahl bleibt hier. Wiederholen verwendet denselben Speichervorgang.';
    return 'Der Vorgang konnte nicht bestätigt werden. Deine Auswahl bleibt hier. Bitte versuche es erneut oder lade den Serverstand.';
  }
  function recovery(snapshot) {
    return (snapshot.error ? '<div class="err" role="alert"><p>' + esc(message(snapshot.error)) + '</p><div class="row">' + button('retry', 'Vorgang wiederholen') + button('reload', 'Serverstand laden · lokale Kopie behalten') + '</div></div>' : '')
      + '<details class="mock-copy"' + (snapshot.localCopy ? ' open' : '') + '><summary>Eigene Antworten kopieren</summary><label class="field-label" for="mock-local-copy">' + (snapshot.localCopy ? 'Lokale Auswahl vor dem Laden' : 'Auswahl in diesem Fenster') + '</label><textarea id="mock-local-copy" class="writing-text" readonly>' + esc(snapshot.localCopy || JSON.stringify({ responses: snapshot.responses, position: snapshot.position }, null, 2)) + '</textarea><div class="row">' + button('reload', 'Serverstand laden · lokale Kopie behalten') + '</div></details>';
  }
  function captureDraft() {
    const value = writing.localDraft;
    if (!value) return;
    if (!draftCopies.some(copy => copy.attempt_id === value.attempt_id && copy.text === value.text)) draftCopies.push(value);
    copyPending = true;
  }
  function chooseWorkspace() {
    const s = session.state(), timing = mockTiming(s.run, s.serverNow);
    if (!timing?.valid) return;
    const group = timing.active || timing.groups.find(value => value.state === 'pending') || timing.groups.at(-1);
    workspace = group?.sections.includes(mockWritingSection(s.run)) ? 'writing' : 'objective';
    const member = s.run.members?.findIndex(value => group?.sections.includes(value.section));
    displayPosition = member >= 0 ? { member, item: 0 } : null;
  }
  async function refreshTiming() {
    if (boundaryFlight) return boundaryFlight;
    if (!session.state().run || finishing) return false;
    const ticket = generation; boundaryChanging = true; clearTimeout(timer);
    listening.freeze(true); writing.freeze(true); captureDraft();
    if (session.state().dirty || session.state().pending) copyPending = true;
    boundaryMessage = 'Der Zeitabschnitt hat gewechselt. Der bestätigte Serverstand wird geladen; unbestätigte Eingaben bleiben als Kopie erhalten.';
    boundaryFlight = (async () => {
      // A terminal group refusal is an explicit stop, not a successful progress acknowledgement.
      const audioStopped = !listening.needsFlush || await listening.flush();
      if (ticket !== generation) return false;
      if (!audioStopped) {
        // Keep the exact playback receipt alive until retry yields an acknowledgement or
        // authoritative terminal refusal. Rendering another member would dispose it.
        boundaryAudioPending = true;
        boundaryMessage = 'Die Hörzeit ist beendet. Die Bestätigung des letzten Hörstands fehlt. Gleiche ihn erneut ab; die feste Prüfungszeit läuft weiter.';
        return false;
      }
      boundaryAudioPending = false;
      await writing.settle();
      if (ticket !== generation) return false;
      captureDraft();
      if (!(await session.settle()) || ticket !== generation) return false;
      writing.dispose(); writingBinding = null; writingReady = Promise.resolve(true);
      const loaded = await session.reload({ preserveClean: false });
      if (ticket !== generation) return false;
      if (loaded) {
        chooseWorkspace(); confirm = false;
        observedGroup = mockTiming(session.state().run, session.now())?.active?.id || null;
        boundaryMessage = audioStopped ? 'Der Zeitabschnitt hat gewechselt. Es gilt der bestätigte Serverstand. Die Zeit läuft ohne Pause weiter.' : 'Der Zeitabschnitt hat gewechselt. Der letzte Hörstand wurde nicht bestätigt. Es wird kein neuer Hörversuch gestartet.';
      } else boundaryMessage = 'Der neue Serverstand konnte nicht geladen werden. Unbestätigte Eingaben bleiben hier erhalten. Bitte lade den Stand erneut.';
      return loaded;
    })();
    try { return await boundaryFlight; } finally { if (ticket === generation) { boundaryFlight = null; boundaryChanging = false; render(); } }
  }
  function timingMarkup(snapshot) {
    const timing = mockTiming(snapshot.run, snapshot.serverNow);
    if (!timing) return '';
    if (!timing.valid) return '<p class="err" role="alert">Der Zeitplan konnte nicht geprüft werden. Bearbeiten ist gesperrt; deine Antworten bleiben erhalten.</p>';
    const finalised = snapshot.run.state === 'finalised';
    return '<section class="card-peach stack mock-timing" aria-label="Zeitplan"><h3>Feste Bearbeitungszeiten</h3><p>' + (finalised ? 'Gespeicherter Zeitplan · dieser Lauf ist abgeschlossen und schreibgeschützt.' : 'Die Abschnitte wechseln automatisch. Verlassen, Neuladen und Prüfungswechsel halten die Zeit nicht an. Ein früherer Wechsel der Bearbeitungszeit ist nicht möglich.') + '</p><ol class="mock-time-groups">'
      + timing.groups.map(group => '<li data-mock-group-state="' + group.state + '"><button class="btn" type="button" data-mock-group="' + esc(group.id) + '"' + (group.state === 'active' ? ' aria-current="step"' : '') + '>' + esc(group.sections.map(section => ({ LV: 'Lesen', SB: 'Sprachbausteine', HV: 'Hören', SA: 'Schreiben', writing: 'Schreiben' })[section] || section).join(' + ')) + ' · ' + Math.round((group.end - group.start) / 60000) + ' Min.</button><span>' + (finalised ? 'Gespeicherter Zeitabschnitt · schreibgeschützt' : ({ pending: 'Später · schreibgeschützt', active: 'Jetzt bearbeiten', closed: 'Beendet · schreibgeschützt' })[group.state]) + '</span></li>').join('')
      + '</ol><p data-mock-timing-status role="status" aria-live="polite">' + esc(boundaryChanging ? 'Serverstand wird abgeglichen …' : boundaryMessage) + '</p>' + (boundaryAudioPending ? button('reload', 'Hörstand abgleichen') : '') + '</section>';
  }
  function reviewContext(row, members) {
    const member = members.find(value => value.set_id === row.set_id && value.version === row.version);
    const form = member && mockMember(member), item = form?.items.find(value => value.id === String(row.item_id));
    if (!item) return '';
    const passage = item.passage ?? form.passage;
    return '<details class="mock-review-context" data-review-item="' + esc(row.item_id) + '"><summary>Aufgabe und Text ansehen</summary>'
      + (passage ? '<div class="stimulus mock-passage" lang="de">' + esc(passage) + '</div>' : '')
      + '<p class="mock-review-prompt" lang="de">' + esc(item.text) + '</p><dl class="mock-review-options">'
      + (item.options || form.options || []).map(option => '<div><dt>' + esc(option.id) + '</dt><dd>' + esc(option.label) + '</dd></div>').join('') + '</dl></details>';
  }
  function renderWriting(snapshot) {
    const target = host.querySelector('#mock-writing-host'), run = snapshot.run;
    const attachment = run.writing, groups = run.writing_choices || [];
    target.hidden = Boolean(run.timing && workspace !== 'writing' && run.state !== 'finalised');
    if (target.hidden) { freezeWriting(); return; }
    if (!attachment) {
      if (writing.active) writing.dispose();
      writingBinding = null;
      target.hidden = !groups.length && !run.writing_task;
      target.innerHTML = run.writing_task ? '<section class="card"><p class="err">Der zugewiesene Schreibentwurf konnte nicht geladen werden. Lade den Serverstand erneut.</p></section>' : !groups.length ? '' : run.blocked_reason ? '<section class="card"><p>Die Schreibaufgaben sind zurzeit gesperrt.</p></section>'
        : run.state === 'finalised' ? '<section class="card"><h3>Schreiben · Unbewertet</h3><p>Es wurde keine Schreibaufgabe ausgewählt. Der Abschnitt bleibt gespeichert.</p></section>'
        : '<section class="card stack"><h3>Schreiben · Wähle eine Aufgabe</h3><p>Lies beide Aufgaben. Deine bestätigte Auswahl bleibt für diesen Lauf verbindlich. Anschließend schreibst du zu genau dieser Aufgabe.</p>' + (!session.sectionWritable(mockWritingSection(run)) ? '<p class="hint">Außerhalb der Schreibzeit · Auswahl gesperrt.</p>' : '') + '<div class="mock-writing-choices">' + groups.map(group => group.options.map(option => '<article class="card-flat stack"><p class="kicker">Aufgabe ' + esc(option.id) + '</p>' + writingPrompt(option.task || {}, esc) + '<button type="button" class="btn btn-primary" data-mock-choice-group="' + esc(group.id) + '" data-mock-choice-option="' + esc(option.id) + '"' + (!session.sectionWritable(mockWritingSection(run)) || snapshot.pending || boundaryChanging ? ' disabled' : '') + '>Aufgabe ' + esc(option.id) + ' verbindlich wählen</button></article>').join('')).join('') + '</div></section>';
      return;
    }
    target.hidden = false;
    if (!target.querySelector('#mock-writing-editor')) target.innerHTML = '<p class="kicker" id="mock-writing-binding" tabindex="-1"></p><div id="mock-writing-editor"></div>';
    target.querySelector('#mock-writing-binding').textContent = (attachment.binding_kind === 'assigned' ? 'Zugewiesene Schreibaufgabe' : 'Aufgabe ' + attachment.selected_option_id + ' · verbindlich ausgewählt') + (run.state === 'active' && !session.sectionWritable(mockWritingSection(run)) ? ' · außerhalb der Schreibzeit, schreibgeschützt' : '');
    const binding = [run.id, attachment.attempt_id, attachment.submission_id, run.blocked_reason || '', isArchived()].join(':');
    if (writingBinding !== binding) {
      writingBinding = binding;
      const task = mockWritingTask(run) || {};
      writingReady = writing.open(target.querySelector('#mock-writing-editor'), task, { attached: true, readonly: !canEdit() || Boolean(run.blocked_reason), ...(attachment.submission_id ? { submissionId: attachment.submission_id } : { attemptId: attachment.attempt_id }) }).then(opened => { freezeWriting(); return opened; });
    }
    freezeWriting();
  }
  function freezeWriting() {
    const state = session.state();
    writing.freeze(!canEdit() || Boolean(state.run?.blocked_reason) || (state.run?.state === 'active' && !session.sectionWritable(mockWritingSection(state.run))) || finishing || boundaryChanging);
  }
  async function flushAll() {
    if (finishing) return false;
    if (boundaryFlight) await boundaryFlight;
    if (copyPending) { boundaryMessage = 'Sichere zuerst deine lokale Kopie und bestätige dies unten. Danach kannst du den Lauf verlassen.'; render(); return false; }
    clearTimeout(timer);
    if (!(await listening.flush())) return false;
    await writingReady;
    if (!(await writing.flush())) return false;
    return session.flush();
  }
  function render() {
    if (!host) return;
    const snapshot = session.state(), run = snapshot.run;
    if (!run) return;
    // Save status updates must not steal keyboard focus from the selected radio.
    const focused = host.contains(document.activeElement) ? document.activeElement?.getAttribute('data-focus') : null;
    const listeningFocus = host.contains(document.activeElement) ? document.activeElement?.getAttribute('data-listening-action') : null;
    const members = run.members || [], total = members.reduce((n, m) => n + m.item_count, 0);
    const selected = snapshot.responses.filter(row => row.answer !== null).length;
    const status = snapshot.loading ? 'Serverstand wird geladen …' : snapshot.busy ? 'Wird gespeichert …' : snapshot.error ? 'Noch nicht bestätigt' : snapshot.dirty ? 'Änderungen noch nicht gespeichert' : 'Gespeichert · Stand ' + run.revision;
    const position = displayPosition || snapshot.position;
    const member = members[position.member], form = member && mockMember(member), item = form?.items[position.item];
    const readonly = !snapshot.writable || finishing || boundaryChanging || !mockSectionWritable(run, member?.section, snapshot.serverNow);
    let body = '';
    if (run.blocked_reason) body = '<section class="card"><h3>Dieser Lauf ist zurzeit gesperrt</h3><p>Die Inhalte sind nicht verfügbar. Deine gespeicherten Antworten bleiben erhalten und können über dein Konto exportiert werden.</p></section>';
    else if (run.state === 'finalised') {
      const result = run.result;
      body = '<section class="card stack" id="mock-result"><h3>' + esc(mockScopeLabel(run)) + ' abgeschlossen</h3><p class="small muted mock-review-status">' + esc(mockReviewLabel(run)) + '</p>' + (result ? '<p><strong>' + esc(result.correct) + ' von ' + esc(result.total) + ' Antworten richtig</strong> · ' + esc(result.unanswered) + ' unbeantwortet.</p><p class="muted">' + (run.scope === 'complete_supported_written' ? 'Gezählte Aufgaben der schriftlichen Probeprüfung. Das Schreibfeedback steht getrennt darunter. Kein Gesamturteil und keine Bestehensprognose.' : 'Das ist die Rückmeldung zu diesem geübten Abschnitt.') + '</p><ol class="mock-results">' + result.items.map((row, index) => '<li><strong>Teil ' + esc((members.findIndex(member => member.set_id === row.set_id && member.version === row.version) + 1) || '–') + ' · Aufgabe ' + esc(row.item_id) + '</strong>' + reviewContext(row, members) + '<span>' + (row.unanswered ? 'Unbeantwortet' : 'Deine Antwort: ' + esc(row.answer) + ' · ' + (row.correct ? 'Richtig' : 'Nicht richtig')) + '</span>' + (row.correct_answer !== null && row.correct_answer !== undefined ? '<span>Passende Antwort: ' + esc(row.correct_answer) + '</span>' : '') + '<div data-mock-explanation="' + index + '"></div>' + '</li>').join('') + '</ol>' : ((run.writing_task || run.writing_choices?.length) && !members.length ? '<p>Dein Schreibteil ist gespeichert. Den Stand der Rückmeldung siehst du unten.</p>' : '<p>Die Rückmeldung ist derzeit nicht verfügbar.</p>')) + (canEdit() ? '<a class="btn" href="#/abschnitt">Neue Wiederholung auswählen</a>' : '') + '</section>';
    } else if (item && workspace !== 'writing') {
      const answer = snapshot.responses.find(row => row.setId === member.set_id && row.version === member.version && row.itemId === item.id)?.answer;
      body = '<div class="mock-layout"><section class="card stack mock-question"><p class="kicker">Teil ' + (position.member + 1) + ' von ' + members.length + ' · Aufgabe ' + esc(item.id) + '</p><h3 id="mock-question-title" tabindex="-1">' + esc(setLabel(member)) + '</h3>'
        + (item.recordingId ? '<div id="mock-listening-host"></div>' : '')
        + (run.timing && !mockSectionWritable(run, member.section, snapshot.serverNow) ? '<p class="hint" data-mock-readonly>Außerhalb der Bearbeitungszeit · nur ansehen. Deine bestätigten Antworten bleiben erhalten.</p>' : '')
        + ((item.passage ?? form.passage) ? '<div class="stimulus mock-passage" lang="de">' + esc(item.passage ?? form.passage) + '</div>' : '')
        + '<fieldset class="mock-options"' + (readonly ? ' disabled' : '') + '><legend>' + esc(item.text) + '</legend>'
        + (item.options || form.options || []).map((option, i) => '<label class="option' + (answer === option.id ? ' selected' : '') + '"><input type="radio" name="mock-answer" data-focus="option-' + i + '" value="' + esc(option.id) + '"' + (answer === option.id ? ' checked' : '') + '><span class="letter">' + esc(option.id) + '</span><span lang="de">' + esc(option.label) + '</span></label>').join('')
        + '</fieldset>' + (!readonly ? button('clear', 'Auswahl zurücknehmen') : '') + '<div class="row">' + button('previous', 'Zurück') + button('next', 'Weiter', true) + '</div></section>'
        + '<aside class="card-flat stack mock-overview"><h3>Deine Aufgaben</h3>' + members.map((m, mi) => '<div><p class="kicker">Teil ' + (mi + 1) + '</p><div class="qnav">' + (mockMember(m)?.items || []).map((q, qi) => {
          const done = snapshot.responses.some(row => row.setId === m.set_id && row.version === m.version && row.itemId === q.id && row.answer !== null);
          return '<button type="button" class="btn btn-small' + (done ? ' mock-answered' : '') + '" data-mock-member="' + mi + '" data-mock-item="' + qi + '" aria-label="Teil ' + (mi + 1) + ', Aufgabe ' + esc(q.id) + (done ? ', beantwortet' : ', unbeantwortet') + '"' + (position.member === mi && position.item === qi ? ' aria-current="step"' : '') + '>' + esc(q.id) + '</button>';
        }).join('') + '</div></div>').join('') + '<p class="small muted">Rückmeldung erst nach dem Abschließen.</p></aside></div>';
    } else body = run.writing_task || run.writing_choices?.length ? '' : '<section class="card"><p>Dieser Inhalt kann nicht angezeigt werden. Deine Antworten bleiben gespeichert.</p></section>';
    const expired = snapshot.expired;
    // Keep the editor node mounted: objective autosaves must not lose text, selection or IME focus.
    if (!host.querySelector('#mock-content')) host.innerHTML = '<div id="mock-content"></div><section id="mock-writing-host" class="stack" aria-label="Schreiben"></section><div id="mock-footer"></div>';
    explanations?.dispose(host.querySelector('#mock-content'));
    host.querySelector('#mock-content').innerHTML = '<div class="card mock-heading"><div><p class="kicker">' + esc(mockScopeLabel(run)) + ' · ' + esc(run.exam_id) + '</p><h2>' + esc(run.title) + '</h2><p class="small muted mock-review-status">' + esc(mockReviewLabel(run)) + '</p><p class="small muted">Formular ' + esc(run.form_version) + ' · Ausgabe ' + esc(run.release_version) + ' · ' + (run.mode === 'untimed' ? 'Ohne Zeitlimit' : '<span id="mock-deadline"></span>') + '</p></div><p id="mock-save-state" role="status" aria-live="polite">' + esc(status) + '</p></div>'
      + (isArchived() ? '<p class="hint">Archivierte Vorbereitung · schreibgeschützt.</p>' : '')
      + (run.state === 'finalised' && run.review_withdrawn ? '<p class="hint" data-review-withdrawn>' + esc(reviewHistoryNotice(run)) + '</p>' : '')
      + (expired && run.state === 'active' ? '<p class="err">Die Zeit ist abgelaufen. Abschließen wertet nur bestätigte Antworten aus. Bei ungespeicherten Änderungen: erst die lokale Kopie sichern und den Serverstand laden.</p>' : '')
      + timingMarkup(snapshot) + recovery(snapshot) + body;
    host.querySelector('#mock-footer').innerHTML = draftCopies.map((copy, i) => '<details class="mock-copy" open><summary>Unbestätigten Schreibtext kopieren</summary><label class="field-label" for="mock-draft-copy-' + i + '">Lokale Fassung · nicht als gespeichert bestätigt</label><textarea class="writing-text" id="mock-draft-copy-' + i + '" data-mock-draft-copy readonly>' + esc(copy.text) + '</textarea></details>').join('')
      + (copyPending ? '<section class="card-peach stack"><p>Eine lokale Kopie ist noch nicht gesichert. Kopiere die unbestätigten Antworten oder den Text, bevor du diesen Lauf verlässt. Diese Kopien bleiben nur in diesem Fenster.</p>' + button('ack-copy', 'Kopie gesichert · weiter') + '</section>' : '')
      + (run.state === 'active' && !run.blocked_reason && canEdit() ? '<section class="card stack mock-finish">' + (total ? '<p>' + selected + ' von ' + total + ' beantwortet · ' + Math.max(0, total - selected) + ' unbeantwortet.</p>' : '') + (confirm ? '<p>Jetzt abschließen? Danach kannst du diese Antworten und den abgegebenen Text nicht mehr ändern. Unbeantwortete Aufgaben und ein leerer Schreibteil bleiben unbewertet erhalten.</p><div class="row">' + button('finalise', 'Verbindlich abschließen', true) + button('cancel', 'Weiter bearbeiten') + '</div>' : '<div class="row">' + button('save', 'Jetzt speichern') + button('confirm', mockScopeLabel(run) + ' abschließen', true) + '</div>') + '</section>' : '')
      + '<a class="btn" href="#/abschnitt">Zur Übersicht der Läufe</a>';
    if (run.state === 'finalised' && !run.blocked_reason) {
      const ticket = generation, runId = run.id, reads = new Map();
      const readLanguage = language => {
        if (!reads.has(language)) reads.set(language, api.mock.read(runId, language).finally(() => reads.delete(language)));
        return reads.get(language);
      };
      for (const [index, row] of (run.result?.items || []).entries()) explanations?.mount(host.querySelector('[data-mock-explanation="' + index + '"]'), {
        view: row.explanation_view, isCurrent: () => ticket === generation && session.state().run?.id === runId,
        read: async language => {
          const response = await readLanguage(language);
          const item = response?.data?.result?.items?.find(value => value.set_id === row.set_id && value.version === row.version && String(value.item_id) === String(row.item_id));
          return { ...response, data: item?.explanation_view || response?.data?.explanation_view, parent: response?.data };
        },
        onConfirmed: parent => {
          if (!parent || ticket !== generation || session.state().run?.id !== runId) return;
          if (parent.blocked_reason) session.load(parent, true);
          else if (parent.review_withdrawn && !host.querySelector('[data-review-withdrawn]')) { const notice = document.createElement('p'); notice.className = 'hint'; notice.dataset.reviewWithdrawn = ''; notice.textContent = reviewHistoryNotice(parent); host.querySelector('#mock-result').before(notice); }
        },
      });
    }
    renderWriting(snapshot);
    const audioHost = host.querySelector('#mock-listening-host');
    const recording = item?.recordingId && member?.recordings?.find(value => value.id === item.recordingId);
    if (audioHost && recording && run.state === 'active' && !run.blocked_reason) {
      listening.mount(audioHost, run, recording);
      listening.freeze(!canEdit() || snapshot.expired || Boolean(snapshot.error) || finishing || boundaryChanging || !mockSectionWritable(run, member.section, snapshot.serverNow));
    } else listening.dispose();
    if (snapshot.busy || snapshot.finalising || finishing || boundaryChanging) for (const b of host.querySelectorAll('[data-mock-action], [data-mock-member], [data-mock-choice-option], [data-mock-group]')) b.disabled = true;
    if (focused) host.querySelector('[data-focus="' + focused + '"]')?.focus({ preventScroll: true });
    if (listeningFocus) host.querySelector('[data-listening-action="' + listeningFocus + '"]')?.focus({ preventScroll: true });
    updateDeadline();
  }
  function updateDeadline() {
    const snapshot = session.state(), run = snapshot.run, target = host?.querySelector('#mock-deadline');
    if (!run?.deadline_at || !target) return;
    if (run.state === 'finalised') {
      target.textContent = run.expired ? 'Nach Ablauf der Zeit abgeschlossen' : 'Innerhalb der Zeit abgeschlossen';
      return;
    }
    const timing = mockTiming(run, snapshot.serverNow), group = timing?.active;
    const groupId = group?.id || null;
    if (timing && !boundaryChanging && !finishing && (groupId !== observedGroup || snapshot.error?.error === 'mock_group_inactive')) {
      observedGroup = groupId; void refreshTiming();
    }
    const seconds = Math.max(0, Math.ceil(((group?.end || Date.parse(run.deadline_at)) - snapshot.serverNow) / 1000));
    target.textContent = seconds ? Math.floor(seconds / 60) + ':' + String(seconds % 60).padStart(2, '0') + (group ? ' im aktuellen Zeitabschnitt' : ' verbleibend') : 'Zeit abgelaufen';
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
      const element = event.target.closest('[data-mock-action], [data-mock-member], [data-mock-choice-option], [data-mock-group]');
      if (!element || element.disabled) return;
      const snapshot = session.state(), run = snapshot.run;
      if (!run) return;
      const p = displayPosition || snapshot.position, m = run.members[p.member], form = m && mockMember(m);
      const action = element.dataset.mockAction;
      if (action === 'ack-copy') { copyPending = false; render(); return; }
      if (element.dataset.mockGroup !== undefined) {
        const group = mockTiming(run, session.now())?.groups.find(value => value.id === element.dataset.mockGroup);
        if (!group || !(await listening.flush()) || !(await writing.flush()) || !(await session.flush())) return;
        workspace = group.sections.includes(mockWritingSection(run)) ? 'writing' : 'objective';
        const member = run.members.findIndex(value => group.sections.includes(value.section));
        displayPosition = member >= 0 ? { member, item: 0 } : null;
        render(); host.querySelector(workspace === 'writing' ? '#mock-writing-binding' : '#mock-question-title')?.focus(); return;
      }
      if (element.dataset.mockChoiceOption !== undefined) { await session.chooseWriting(element.dataset.mockChoiceGroup, element.dataset.mockChoiceOption); return; }
      if (action === 'clear') { session.answer(m, form.items[p.item].id, null); await session.flush(); }
      if (['save', 'retry'].includes(action)) await flushAll();
      if (action === 'reload') { if (run.timing) { await refreshTiming(); return; } if (!(await listening.flush()) || !(await writing.flush())) return; clearTimeout(timer); confirm = false; displayPosition = null; await session.reload(); }
      if (action === 'confirm') { confirm = true; render(); host.querySelector('[data-mock-action="finalise"]')?.focus(); }
      if (action === 'cancel') { confirm = false; render(); }
      if (action === 'finalise') {
        if (finishing) return;
        if (!(await listening.flush())) return;
        finishing = true; writing.freeze(true); render();
        try {
          clearTimeout(timer);
          await finaliseMockWriting({ session, writing, language: explanationLanguage(), ready: writingReady }); confirm = false;
        } finally { finishing = false; render(); }
      }
      let next = null;
      if (element.dataset.mockMember !== undefined) next = { member: Number(element.dataset.mockMember), item: Number(element.dataset.mockItem) };
      if (action === 'next' && form) next = p.item + 1 < form.items.length ? { member: p.member, item: p.item + 1 } : p.member + 1 < run.members.length ? { member: p.member + 1, item: 0 } : null;
      if (action === 'previous' && form) next = p.item > 0 ? { member: p.member, item: p.item - 1 } : p.member > 0 ? { member: p.member - 1, item: mockMember(run.members[p.member - 1]).items.length - 1 } : null;
      if (next) {
        if (!(await listening.flush()) || !(await writing.flush())) return;
        if (!canEdit() || snapshot.expired) { displayPosition = next; render(); }
        else { displayPosition = p; if (await session.move(next)) displayPosition = null; render(); }
        host.querySelector('#mock-question-title')?.focus();
      }
    };
  }
  async function showRun(target, id) {
    const ticket = ++generation; stopTimers(); listening.dispose(); writing.dispose(); writingBinding = null; writingReady = Promise.resolve(true); boundaryChanging = false; boundaryFlight = null; boundaryMessage = ''; boundaryAudioPending = false; copyPending = false; draftCopies = []; workspace = 'objective'; attach(target); host.innerHTML = '<p class="muted" role="status">Gespeicherter Lauf wird geladen …</p>';
    const response = await api.mock.read(id);
    if (ticket !== generation) return false;
    if (!response?.ok) { host.innerHTML = '<p class="err">Der gespeicherte Lauf konnte nicht geladen werden.</p><a class="btn" href="#/abschnitt">Zur Übersicht</a>'; return false; }
    confirm = false; displayPosition = null; deadlineReached = false;
    observedGroup = mockTiming(response.data, Date.parse(response.data.server_now))?.active?.id || null;
    session.load(response.data); chooseWorkspace(); render(); deadlineTimer = setInterval(updateDeadline, 250); return true;
  }
  async function list(target, { section = null } = {}) {
    const ticket = ++generation; stopTimers(); listening.dispose(); writing.dispose(); writingBinding = null; writingReady = Promise.resolve(true); boundaryChanging = false; boundaryFlight = null; boundaryMessage = ''; copyPending = false; draftCopies = []; session.dispose(); attach(target); host.innerHTML = '<p class="muted" role="status">Gespeicherte Übungen werden geladen …</p>';
    const [forms, runs] = await Promise.all([api.mock.forms(), api.mock.list()]);
    if (ticket !== generation) return;
    if (section && forms?.ok) forms.data.forms = (forms.data.forms || []).filter(form => form.sections?.includes(section));
    const rows = runs?.ok ? runs.data?.runs || [] : [];
    const complete = (forms?.data?.forms || []).some(form => form.scope === 'complete_supported_written');
    host.innerHTML = '<div class="page-head"><div><p class="kicker">Gespeicherte Vorbereitung</p><h1>' + (complete ? 'Abschnittsübungen und schriftliche Probeprüfungen' : 'Gespeicherte Abschnittsübungen') + '</h1><p>Umfang, Zeitplan und Prüfstatus stehen bei jedem Lauf. Die Rückmeldung erscheint erst nach dem Abschließen. Bestätigte Antworten bleiben gespeichert.</p></div></div><div class="grid-dash"><section class="card stack"><h2>Einen Lauf beginnen</h2>'
      + (!canEdit() ? '<p>Diese Vorbereitung ist archiviert. Gespeicherte Läufe bleiben lesbar.</p>' : !forms?.ok ? '<p class="err">Die verfügbaren Übungen konnten nicht geladen werden.</p>' : !(forms.data?.forms || []).length ? '<p>Zurzeit ist kein Lauf für einen neuen Start verfügbar. Bereits gespeicherte Läufe findest du daneben.</p>' : forms.data.forms.map((form, i) => '<article class="mock-form"><p class="kicker">' + esc(mockScopeLabel(form)) + '</p><h3>' + esc(form.title) + '</h3><p class="small muted mock-review-status">' + esc(mockReviewLabel(form)) + '</p><p>' + (form.item_count ? esc(form.item_count) + ' Aufgaben' : '') + (form.writing_task_count ? (form.item_count ? ' und ' : '') + 'eine zugewiesene Schreibaufgabe' : form.writing_choice_count ? (form.item_count ? ' und ' : '') + 'eine Schreibaufgabe mit Auswahl' : '') + ' · ' + (form.mode === 'untimed' ? 'Ohne Zeitlimit' : Number.isFinite(form.time_limit_seconds) ? Math.round(form.time_limit_seconds / 60) + ' Minuten' : 'Mit Zeitlimit') + '</p>' + (form.scope === 'complete_supported_written' ? '<p class="hint">Die Zeiten beginnen mit dem Start und wechseln automatisch. Keine Pause und kein Zurücksetzen beim Verlassen. Nur schriftliche Vorbereitung; kein Gesamtprüfungsurteil.</p>' : '') + '<p class="small muted">' + esc(form.exam_id) + ' · Formular ' + esc(form.version) + ' · Ausgabe ' + esc(form.release_version) + '</p><button class="btn btn-primary" type="button" data-mock-start="' + i + '">' + (form.scope === 'complete_supported_written' ? 'Schriftliche Probeprüfung beginnen' : 'Neuen Lauf beginnen') + '</button></article>').join(''))
      + '<p id="mock-start-state" role="status"></p><button class="btn" type="button" data-mock-refresh>Übersicht erneut laden</button></section><section class="stack"><h2>Deine gespeicherten Läufe</h2>' + (!runs?.ok ? '<p class="err">Der Verlauf konnte nicht geladen werden.</p>' : historyMarkup(rows)) + '</section></div>';
    host.onclick = async event => {
      if (event.target.closest('[data-mock-refresh]')) { await list(target, { section }); return; }
      const trigger = event.target.closest('[data-mock-start]'); if (!trigger || trigger.disabled || !canEdit()) return;
      const form = forms.data.forms[Number(trigger.dataset.mockStart)]; if (!form) return;
      for (const b of host.querySelectorAll('[data-mock-start]')) b.disabled = true;
      const binding = { formId: form.form_id, formVersion: form.version, releaseVersion: form.release_version };
      if (!startOperation || !equal(startOperation.binding, binding)) startOperation = { binding, body: { ...binding, eventId: crypto.randomUUID() } };
      host.querySelector('#mock-start-state').textContent = 'Lauf wird angelegt …';
      const response = await api.mock.start(startOperation.body);
      if (ticket !== generation) return;
      if (!response?.ok) {
        host.querySelector('#mock-start-state').textContent = message(response); for (const b of host.querySelectorAll('[data-mock-start]')) b.disabled = false; return;
      }
      startOperation = null; onOpen(response.data);
    };
  }
  function historyMarkup(rows) {
    return rows.length ? rows.map(run => '<article class="card"><p class="kicker">' + esc(run.exam_id) + ' · ' + esc(mockScopeLabel(run)) + '</p><h3>' + esc(run.title) + '</h3><p class="small muted">Formular ' + esc(run.form_version) + ' · ' + esc(date(run.updated_at || run.created_at)) + '</p><p>' + (run.state === 'finalised' ? 'Abgeschlossen' : 'Gespeichert · noch offen') + '</p>' + (run.writing ? '<p>' + esc(mockWritingStatus(run.writing)) + '</p>' : '') + '<a class="btn" data-mock-run="' + esc(run.id) + '" href="#/lauf/' + esc(run.id) + '">' + (run.state === 'finalised' || !canEdit() ? 'Ansehen' : 'Fortsetzen') + '</a></article>').join('') : '<article class="card"><p>Noch keine gespeicherten Läufe.</p></article>';
  }
  return {
    list, showRun, historyMarkup, refresh: render, flush: flushAll,
    get active() { return Boolean(session.state().run); }, get runId() { return session.state().run?.id; },
    dispose() { if (host) explanations?.dispose(host); generation++; stopTimers(); listening.dispose(); writing.dispose(); writingBinding = null; writingReady = Promise.resolve(true); boundaryChanging = false; boundaryFlight = null; boundaryMessage = ''; copyPending = false; draftCopies = []; session.dispose(); if (host) { host.onclick = null; host.onchange = null; } host = null; startOperation = null; },
    preserveOnUnload(event) { listening.preserveOnUnload(event); const state = session.state(); if (copyPending || state.dirty || state.pending || state.busy) { event.preventDefault(); event.returnValue = ''; } },
  };
}

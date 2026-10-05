import { getLocale } from '../assets/i18n/core.js';
import { pt, pl, updatePracticeLocale } from '../assets/i18n/practice-messages.js';
import { INSTRUCTIONS, instructionMarkup, translateInstructions } from '../assets/i18n/instructions.js';

/** Fixed recording playback. The server owns allowances; this module keeps only document-local state. */
const copy = value => structuredClone(value);
const failure = error => ({ ok: false, status: 0, error });
// Only an authoritative terminal refusal releases navigation. Unknown outcomes stay retryable.
const terminal = error => error?.status === 409 && ['mock_group_inactive', 'mock_expired', 'mock_finalised', 'preparation_archived', 'mock_rights_blocked', 'mock_content_unavailable'].includes(error.error);
const matches = (value, recording) => value?.media_id === recording?.media_id && value?.media_version === recording?.media_version;
const valid = (value, recording) => matches(value, recording) && Number.isInteger(value.revision) && value.revision >= 0
  && ['ready', 'playing', 'paused', 'completed'].includes(value.state) && Number.isInteger(value.plays_used)
  && value.plays_used >= 0 && value.max_plays === recording.max_plays && value.plays_used <= value.max_plays
  && Number.isInteger(value.position_ms) && value.position_ms >= 0 && value.position_ms <= recording.duration_ms
  && value.duration_ms === recording.duration_ms && (value.state === 'ready' || typeof value.playback_id === 'string');

/** A lost mutation acknowledgement retains the exact event and body until retried or explicitly re-read. */
export function createListeningSession({ api, eventId = () => crypto.randomUUID(), onChange = () => {} }) {
  let runId = null, recording = null, playback = null, error = null, pending = null, flight = null, epoch = 0, loading = false;
  const state = () => ({ runId, recording, playback: playback && copy(playback), error, pending: Boolean(pending), busy: Boolean(flight) || loading });
  async function read(id, value) {
    const ticket = ++epoch; runId = id; recording = copy(value); playback = null; pending = null; flight = null; error = null; loading = true; onChange();
    let response;
    try { response = await api.mock.playback(id); } catch { response = failure('network'); }
    if (ticket !== epoch) return false;
    loading = false;
    const found = response?.data?.items?.find(item => matches(item, value));
    if (!response?.ok || !valid(found, value)) { error = response?.ok ? failure('invalid_response') : response || failure('network'); onChange(); return false; }
    playback = copy(found); error = null; onChange(); return true;
  }
  async function send() {
    if (flight) return flight;
    if (!pending) return true;
    const ticket = epoch, operation = copy(pending);
    flight = (async () => {
      let response;
      try { response = await api.mock.playbackEvent(runId, operation); } catch { response = failure('network'); }
      if (ticket !== epoch) return false;
      const value = response?.data?.playback;
      if (!response?.ok || !valid(value, recording) || value.revision <= operation.expectedRevision || value.revision < playback.revision
        || (operation.action === 'begin' && value.plays_used !== playback.plays_used + 1)
        || (operation.action !== 'begin' && value.plays_used !== playback.plays_used)
        || (['checkpoint', 'pause', 'complete'].includes(operation.action) && (value.playback_id !== operation.playbackId || value.position_ms < operation.positionMs))) {
        error = response?.ok ? failure('invalid_response') : response || failure('network'); return false;
      }
      playback = copy(value); pending = null; error = null; return true;
    })();
    onChange();
    try { return await flight; } finally { if (ticket === epoch) { flight = null; onChange(); } }
  }
  async function act(action, positionMs) {
    if (!playback || loading || pending || flight) return false;
    if (action === 'begin' && (!['ready', 'completed'].includes(playback.state) || playback.plays_used >= playback.max_plays)) return false;
    if (action !== 'begin' && !playback.playback_id) return false;
    if (['checkpoint', 'pause', 'complete'].includes(action) && (playback.uncertain || playback.state !== 'playing')) return false;
    const body = { eventId: eventId(), mediaId: recording.media_id, mediaVersion: recording.media_version, expectedRevision: playback.revision, action };
    if (action !== 'begin') body.playbackId = playback.playback_id;
    if (['checkpoint', 'pause', 'complete'].includes(action)) {
      if (!Number.isInteger(positionMs) || positionMs < playback.position_ms || positionMs > playback.duration_ms) return false;
      body.positionMs = positionMs;
    }
    pending = body;
    return send();
  }
  return { state, read, act, retry: send,
    reload: () => runId && recording ? read(runId, recording) : Promise.resolve(false),
    dispose() { epoch++; runId = null; recording = null; playback = null; pending = null; flight = null; error = null; loading = false; },
  };
}

export function listeningMessage(state, locale = getLocale()) {
  const code = state.error?.error;
  if (code === 'mock_group_inactive') return pt('audioGroup',{},locale);
  if (['account_changed', 'stale_session', 'session_expired'].includes(code) || state.error?.status === 401) return pt('audioSession',{},locale);
  if (['mock_expired', 'mock_finalised', 'preparation_archived'].includes(code)) return pt('audioClosed',{},locale);
  if (['mock_rights_blocked', 'rights_blocked', 'media_unavailable', 'media_integrity', 'mock_content_unavailable'].includes(code)) return pt('audioUnavailable',{},locale);
  if (['playback_conflict', 'playback_recovery_required'].includes(code)) return pt('audioConflict',{},locale);
  if (code === 'play_rejected') return pt('audioRejected',{},locale);
  if (state.error) return state.pending ? pt('audioUnknown',{},locale) : pt('audioLoadFailed',{},locale);
  if (state.busy) return pt('audioConfirming',{},locale);
  if (state.playback?.uncertain) return pt('audioUncertain',{},locale);
  if (state.playback?.state === 'completed') return state.playback.plays_used < state.playback.max_plays ? pt('audioAnother',{},locale) : pt('audioNoMore',{},locale);
  if (state.playback?.state === 'paused') return pt('audioPaused',{},locale);
  return state.playback?.state === 'playing' ? pt('audioPlaying',{},locale) : pt('audioReady',{},locale);
}

/**
 * The player's own words for one state — shared by the mock controller and the practice player so the two
 * cannot drift, and so a state that is merely "the sitting was already used" does not borrow a sentence that
 * promises another play.
 */
export function listeningStatusText(state = {}, locale = getLocale()) {
  const code = state.error?.error;
  if (code === 'practice_check_required') return pt('partRunnerAudioCheckFirst', {}, locale);
  if (code === 'playback_exhausted') return pt('partRunnerAudioUsed', {}, locale);
  if (code === 'practice_playback_unavailable') return pt('partRunnerAudioUnavailable', {}, locale);
  return listeningMessage(state, locale);
}

/**
 * The player block, as markup — ONE renderer for the mock controller (below) and the practice player
 * (`practice-listening.js`). Extracted verbatim from the mock's `render()` so the existing player keeps its
 * exact DOM, attributes and copy; the practice path only supplies a different state.
 *
 * `options.attemptMode` is the only new member: the mock passes its run DTO (which carries `attempt_mode`),
 * the practice player passes `'practice'`, and the chip follows.
 */
export function listeningPlayerMarkup(state = {}, recording = {}, options = {}) {
  const {
    run = null, examLanguage = 'und', esc, locale = getLocale(), instruction = null,
    canEdit = () => true, frozen = false, loading = false, arming = false, playing = false,
    terminal = () => false, message = listing => listeningStatusText(listing, locale),
    labels = {}, attemptMode = null, actions = null, time = formatDuration, position = null,
  } = options;
  const p = state.playback;
  const ended = terminal(state.error);
  const stopped = !canEdit() || frozen || ended;
  const busy = state.busy || loading || arming;
  const currentPosition = () => position ? position() : Math.min(recording?.duration_ms || 0,
    Math.max(state.playback?.position_ms || 0));
  const btn = (action, label, disabled = false) => '<button type="button" class="btn'
    + (['play', 'recover'].includes(action) ? ' btn-primary' : '')
    + '" data-listening-action="' + action + '"' + (disabled ? ' disabled' : '') + '>' + label + '</button>';
  let controls = '';
  if (!stopped) {
    if (typeof actions === 'function') controls = actions({ button: btn, busy, stopped, playback: p, playing, state, recording, labels });
    else if (!p) controls = btn('reload', labels.reload ?? pl('audioReload'), busy);
    else if (playing) controls = btn('pause', labels.pause ?? pl('audioPause'));
    else if (state.pending) controls = btn('retry', labels.retry ?? pl('audioRetry'), busy) + btn('reload', labels.server ?? pl('audioServer'), busy);
    else if (state.error && ['playback_conflict', 'playback_recovery_required'].includes(state.error.error)) controls = btn('reload', labels.server ?? pl('audioServer'), busy);
    else if (!options.ready) controls = btn('load', labels.load ?? pl('audioLoad'), busy);
    else if (p.state !== 'completed' || p.plays_used < p.max_plays) controls = btn(['playing', 'paused'].includes(p.state) ? 'recover' : 'play', p.state === 'ready' ? pl('audioPlay') : p.state === 'completed' ? pl('audioNext') : pl('audioResume'), busy);
  }
  const chip = run?.scope === 'complete_supported_written' ? pl('mockScope')
    : (attemptMode ?? run?.attempt_mode) === 'mock' ? pl('audioMock') : pl('audioPractice');
  return '<section class="card-flat listening-player stack" aria-label="Höraufnahme" data-practice-aria-label="recording"><div class="spread"><h3 lang="' + esc(run?.exam_language || examLanguage || 'und') + '" dir="' + ((run?.exam_language || examLanguage) === 'ar' ? 'rtl' : 'ltr') + '">' + esc(recording?.label ?? '') + '</h3><span class="chip">' + chip + '</span></div>'
    + (run?.release_state === 'internal' ? '<p class="small muted" data-practice-key="ui68">Internes Testmaterial · fachliche und Audio-Prüfung ausstehend.</p>' : '')
    + (instruction ?? instructionMarkup({ id: 'listening.playback', examLanguage: run?.exam_language || examLanguage || 'und', original: INSTRUCTIONS['listening.playback'].examLanguage === (run?.exam_language || examLanguage) ? INSTRUCTIONS['listening.playback'].original : '', parameters: { maxPlays: recording?.max_plays } }))
    + '<div class="listening-progress"><progress data-listening-progress max="' + (recording?.duration_ms || 0) + '" value="' + currentPosition() + '" aria-label="Gespeicherter und aktueller Hörfortschritt" data-practice-aria-label="progress"></progress><span class="num">' + time(currentPosition()) + ' / ' + time(recording?.duration_ms || 0) + '</span></div>'
    + '<p data-listening-status class="listening-status' + (state.error ? ' err' : ' muted') + '" role="status" aria-live="polite">' + esc(ended ? message(state) : stopped ? pt('audioBlocked', {}, locale) : loading ? pt('audioLoading', {}, locale) : message(state)) + '</p><div class="row listening-controls">' + controls + '</div></section>';
}

/** `m:ss`, for the progress readout. Exported so the practice player prints the same format. */
function formatDuration(ms) {
  return Math.floor(ms / 60000) + ':' + String(Math.floor(ms / 1000) % 60).padStart(2, '0');
}

/**
 * Put the keyboard focus back on the SAME control after a re-render replaced the block's DOM. Shared for the
 * same reason as the markup: a learner who taps "Pause" with a keyboard must not lose their place, in either
 * path. `action` is the previous `data-listening-action`, or null.
 */
export function restoreListeningFocus(host, action) {
  if (!action || !host?.querySelector) return false;
  host.querySelector('[data-listening-action="' + action + '"]')?.focus({ preventScroll: true });
  return true;
}

/** The action the learner was focused on before a re-render, or null. */
export function focusedListeningAction(host) {
  return host?.contains?.(globalThis.document?.activeElement)
    ? globalThis.document.activeElement.dataset.listeningAction ?? null
    : null;
}

/** Custom controls have no seek/rate affordance. Audio bytes never enter public routes or browser storage. */
export function createListeningController({ getExamLanguage = () => null, api, esc, canEdit = () => true, createAudio = () => new Audio(),
  createObjectURL = blob => URL.createObjectURL(blob), revokeObjectURL = url => URL.revokeObjectURL(url),
  eventId, now = () => Date.now(), onChange = () => {} }) {
  let host = null, binding = null, run = null, recording = null, audio = null, objectUrl = null, generation = 0;
  let ready = false, loading = false, localError = null, playing = false, arming = false, confirmed = false, lastPosition = 0, lastCheckpoint = 0;
  let playFlight = null, flushing = null, frozen = false, listeners = [], timer = null, loadTimer = null, resumeRequested = false;
  const session = createListeningSession({ api, eventId, onChange: () => { render(); onChange(); } });
  const state = () => ({ ...session.state(), error: localError || session.state().error, ready, loading, playing, arming });
  const position = () => Math.min(recording?.duration_ms || 0, Math.max(lastPosition, session.state().playback?.position_ms || 0, Math.floor((audio?.currentTime || 0) * 1000)));
  function halt() { playing = false; audio?.pause(); }
  function resetAudio() {
    halt(); clearInterval(timer); clearTimeout(loadTimer); timer = null; loadTimer = null; resumeRequested = false;
    for (const [name, handler] of listeners) audio?.removeEventListener(name, handler);
    listeners = [];
    if (audio) { audio.removeAttribute('src'); audio.load(); audio.remove?.(); }
    if (objectUrl) revokeObjectURL(objectUrl);
    audio = null; objectUrl = null; ready = false; loading = false; confirmed = false; arming = false; playFlight = null; lastPosition = 0;
  }
  const active = ticket => ticket === generation && canEdit() && !frozen;
  const time = ms => Math.floor(ms / 60000) + ':' + String(Math.floor(ms / 1000) % 60).padStart(2, '0');
  function render() {
    if (!host || !recording) return;
    const s = state();
    const examLanguage = run.exam_language || getExamLanguage() || 'und';
    const focus = focusedListeningAction(host);
    /*
     * The block itself is built by the SHARED renderer (above), which the practice player uses too: the mock
     * keeps only what is genuinely its own — its own `terminal` list, its own copy for a closed run, and the
     * actions it offers. The DOM, the attributes and the wording are therefore identical in both paths by
     * construction rather than by two copies that can drift.
     */
    host.innerHTML = listeningPlayerMarkup(s, recording, {
      run, examLanguage, esc, locale: getLocale(),
      instruction: instructionMarkup({ id: 'listening.playback', examLanguage,
        original: INSTRUCTIONS['listening.playback'].examLanguage === examLanguage ? INSTRUCTIONS['listening.playback'].original : '',
        parameters: { maxPlays: recording.max_plays } }),
      canEdit, frozen, loading, playing, arming, terminal, position, ready,
      message: listing => listeningStatusText(listing, getLocale()),
    });
    restoreListeningFocus(host, focus);
    updateLocale();
    host.onclick = event => {
      const button = event.target.closest('[data-listening-action]'); if (!button || button.disabled) return;
      event.stopPropagation();
      const action = button.dataset.listeningAction;
      if (action === 'load') void loadMedia();
      if (['play', 'recover'].includes(action)) void play();
      if (action === 'pause') void flush();
      if (action === 'retry') void retry();
      if (action === 'reload') void reload();
    };
  }
  function listen(name, handler) { audio.addEventListener(name, handler); listeners.push([name, handler]); }
  async function loadMedia() {
    if (!binding || loading || !canEdit() || frozen || session.state().pending) return false;
    const ticket = generation; resetAudio(); loading = true; localError = null; render();
    let result;
    try { result = await api.mock.media(run.id, recording.media_id, recording.media_version); } catch { result = failure('network'); }
    if (!active(ticket)) { if (ticket === generation) { loading = false; render(); } return false; }
    if (!result?.ok) { loading = false; localError = result || failure('network'); render(); return false; }
    objectUrl = createObjectURL(result.data); audio = createAudio(); audio.preload = 'auto'; audio.controls = false;
    audio.hidden = true; audio.setAttribute?.('data-listening-audio', recording.media_id);
    globalThis.document?.body?.append(audio);
    audio.playbackRate = 1; audio.defaultPlaybackRate = 1;
    listen('canplay', () => { if (active(ticket)) { clearTimeout(loadTimer); loading = false; ready = true; render(); } });
    listen('error', () => { if (ticket === generation) { halt(); loading = false; ready = false; localError = failure('media_unavailable'); render(); } });
    listen('ratechange', () => { if (audio && audio.playbackRate !== 1) audio.playbackRate = 1; });
    listen('seeking', () => { if (audio && audio.currentTime * 1000 < lastPosition - 100) audio.currentTime = lastPosition / 1000; });
    listen('playing', () => { if (active(ticket)) { if (arming) void acknowledgePlay(ticket); else if (confirmed) { playing = true; render(); } else halt(); } else halt(); });
    listen('pause', () => { if (active(ticket) && playing && confirmed && !audio.ended) void flush(); });
    listen('timeupdate', () => { if (playing) { lastPosition = position(); const progress = host?.querySelector('progress'); if (progress) progress.value = lastPosition; } });
    listen('ended', () => { if (active(ticket) && confirmed) { halt(); confirmed = false; void finish(); } });
    audio.src = objectUrl; audio.load();
    loadTimer = setTimeout(() => { if (ticket === generation && loading) { loading = false; ready = false; localError = failure('media_unavailable'); render(); } }, 20000);
    timer = setInterval(() => { if (playing && !session.state().busy && now() - lastCheckpoint >= 2000) void checkpoint(); }, 500);
    return true;
  }
  async function acknowledgePlay(ticket) {
    if (playFlight) return playFlight;
    halt(); arming = false;
    const p = session.state().playback, action = ['ready', 'completed'].includes(p?.state) ? 'begin' : 'recover';
    playFlight = (async () => {
      const acknowledged = await session.act(action);
      if (ticket !== generation) return false;
      if (!acknowledged || !active(ticket)) { halt(); confirmed = false; return false; }
      const next = session.state().playback;
      lastPosition = next.position_ms; audio.currentTime = lastPosition / 1000; lastCheckpoint = now();
      if (next.state === 'completed') { confirmed = false; render(); return true; }
      if (!resumeRequested) { confirmed = false; return pauseSaved(); }
      confirmed = true;
      try { await audio.play(); if (ticket !== generation) return false; if (!active(ticket)) { halt(); return false; } return true; }
      catch { if (ticket !== generation) return false; halt(); await pauseSaved(); if (ticket === generation) localError = failure('play_interrupted'); return false; }
    })();
    try { return await playFlight; } finally { if (ticket === generation) { playFlight = null; render(); } }
  }
  async function play() {
    const p = session.state().playback;
    if (!ready || !p || playing || arming || session.state().pending || session.state().busy || !canEdit() || frozen) return false;
    const ticket = generation, initialRevision = p.revision; localError = null; resumeRequested = true;
    if (p.position_ms >= p.duration_ms && p.state !== 'completed') { const ok = await session.act('recover'); render(); return ok; }
    lastPosition = p.state === 'completed' ? 0 : p.position_ms;
    audio.currentTime = lastPosition / 1000; arming = true; confirmed = false; render();
    try { await audio.play(); return active(ticket); }
    catch {
      // Pausing at the first playing event may reject the original browser play promise. The
      // acknowledgement already in flight, rather than that promise, decides consumption.
      if (playFlight) return playFlight;
      if (ticket === generation && session.state().playback?.revision > initialRevision) return confirmed || session.state().playback.state === 'completed';
      if (ticket === generation) { arming = false; halt(); localError = failure('play_rejected'); render(); }
      return false;
    }
  }
  async function checkpoint() {
    if (!playing || session.state().busy || session.state().pending) return false;
    const ticket = generation;
    lastCheckpoint = now();
    const ok = await session.act('checkpoint', position());
    if (ticket !== generation) return false;
    if (!ok) { halt(); confirmed = false; render(); }
    return ok;
  }
  async function pauseSaved() {
    const s = session.state();
    if (!s.playback || s.playback.state !== 'playing' || s.playback.uncertain) return !s.pending;
    return session.act('pause', position());
  }
  async function finish() {
    const ticket = generation;
    if (session.state().busy && !(await session.retry())) return false;
    if (ticket !== generation) return false;
    const ok = await session.act('complete', recording.duration_ms); render(); return ok;
  }
  async function retry() {
    const ticket = generation;
    halt(); resumeRequested = false; confirmed = false; localError = null;
    if (!(await session.retry())) return false;
    if (ticket !== generation) return false;
    const ok = await pauseSaved(); render(); return ok;
  }
  async function flush() {
    if (flushing) return flushing;
    const ticket = generation;
    halt(); arming = false; resumeRequested = false;
    flushing = (async () => {
      if (playFlight) await playFlight;
      if (ticket !== generation) return false;
      halt(); confirmed = false;
      if (terminal(session.state().error)) return true;
      if (session.state().pending || session.state().busy) {
        const acknowledged = await session.retry();
        if (ticket !== generation) return false;
        if (!acknowledged) return terminal(session.state().error);
      }
      if (ticket !== generation) return false;
      const saved = await pauseSaved();
      if (ticket !== generation) return false;
      // Retain the rejected receipt and last confirmed progress for inspection. The server
      // refuses further playback, but objective finalisation and leaving the page remain usable.
      return saved || terminal(session.state().error);
    })();
    try { return await flushing; } finally { if (ticket === generation) { flushing = null; render(); } }
  }
  async function reload() {
    const ticket = generation;
    halt(); resumeRequested = false; confirmed = false; arming = false; localError = null;
    if (session.state().busy) return false;
    const ok = await session.reload();
    if (ticket !== generation) return false;
    lastPosition = session.state().playback?.position_ms || 0; render(); return ok;
  }
  function updateLocale(locale = getLocale()) {
    if (!host?.isConnected) return;
    updatePracticeLocale(host,locale); translateInstructions(host,locale);
    const snapshot=state(),ended=terminal(snapshot.error),stopped=!canEdit() || frozen || ended;
    const target=host.querySelector('[data-listening-status]');
    if (target) target.textContent=ended ? listeningMessage(snapshot,locale) : stopped ? pt('audioBlocked',{},locale) : loading ? pt('audioLoading',{},locale) : listeningMessage(snapshot,locale);
  }
  return {
    state, play, loadMedia, flush, retry, reload, updateLocale,
    mount(target, value, clip) {
      host = target; run = value;
      const next = [value.id, clip.media_id, clip.media_version].join(':');
      if (next === binding) { render(); return; }
      generation++; resetAudio(); session.dispose(); binding = next; recording = copy(clip); localError = null; frozen = false;
      void session.read(value.id, clip); render();
    },
    freeze(value = true) { if (value && !frozen) { halt(); resumeRequested = false; arming = false; confirmed = false; } frozen = value; render(); },
    get needsFlush() { const s = session.state(); return !terminal(s.error) && (playing || arming || s.pending || s.busy || s.playback?.state === 'playing'); },
    preserveOnUnload(event) { if (this.needsFlush) { halt(); event.preventDefault(); event.returnValue = ''; } },
    dispose() { generation++; resetAudio(); session.dispose(); if (host) host.onclick = null; host = null; binding = null; recording = null; run = null; localError = null; flushing = null; },
  };
}

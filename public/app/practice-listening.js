/**
 * PRACTICE-MEDIA-transport — the PRACTICE-bound listening player.
 *
 * WHY THIS EXISTS, AND WHY IT IS NOT `listening.js` WITH A DIFFERENT URL. The mock player
 * (`public/app/listening.js`) plays a run's recording and writes its accounting into
 * `listening_playback`, keyed to a mock run. Practice has its own transport — already shipped:
 * `GET|POST /api/v1/practice/attempts/<attemptId>/playback` and
 * `GET /api/v1/practice/attempts/<attemptId>/media/<mediaId>/<version>` — and two rules that the mock
 * path does not have:
 *
 *   1. BYTES NEED A PLAY IN PROGRESS. The practice media route serves the file only while an acknowledged
 *      play of that recording is `playing` or `paused` (deliberately: otherwise "a second listen before
 *      Auswerten is refused" would be true of the state machine while the file stayed re-fetchable). The
 *      mock route serves bytes to the owner of an active run. So the order here is
 *      **begin → bytes → play**, and there is no separate "load the recording" step the learner has to
 *      understand: pressing play does all three.
 *   2. THE ALLOWANCE IS A SITTING, NOT A RUN. `practice_check_required` (a second listen before
 *      "Auswerten"), `playback_exhausted` (the family's exam allowance spent) and
 *      `practice_playback_unavailable` (this deployment cannot play the set at all) are decisions the
 *      sitting makes. Each one is rendered as its own true sentence — never as a promise of a play that
 *      the server will refuse, and never as "the recording does not exist", which it does.
 *
 * WHAT IS SHARED, AND WHY: the block's DOM, its attributes and its wording come from
 * `listeningPlayerMarkup` / `listeningStatusText` in `listening.js`, so the two players cannot drift.
 * The state machine here is the practice one; it is not a copy of the mock's, because a copy is exactly
 * what would let the two rules disagree.
 */
import { getLocale } from '../assets/i18n/core.js';
import { pt, pl, updatePracticeLocale } from '../assets/i18n/practice-messages.js';
import { listeningPlayerMarkup, restoreListeningFocus, focusedListeningAction } from './listening.js';

const copy = value => structuredClone(value);
const failure = error => ({ ok: false, status: 0, error });
/*
 * Only an authoritative terminal refusal releases the block. An unknown outcome stays retryable, which is
 * the mock path's own rule and the reason a dropped connection cannot leave the learner stuck for ever.
 */
const TERMINAL = ['practice_playback_unavailable', 'media_unavailable', 'media_integrity',
  'practice_rights_blocked', 'preparation_archived', 'exam_unavailable'];
const terminal = error => error?.status === 409 && TERMINAL.includes(error.error);
const matches = (value, recording) => value?.media_id === recording?.media_id
  && value?.media_version === recording?.media_version;
/**
 * The served playback state of ONE recording, validated against what the release authored — the media id and
 * version, which ARE known before the read.
 *
 * `duration_ms` is deliberately NOT compared here: the authored binding carries no duration (the descriptor
 * does, and the server serves it on the playback DTO), so the first read would fail its own validation and
 * the learner would meet "the recording could not be loaded" for a recording that is perfectly fine. The DTO's
 * duration then becomes the recording's own, and `position_ms <= duration_ms` is checked against the DTO.
 */
const valid = (value, recording) => matches(value, recording) && Number.isInteger(value.revision) && value.revision >= 0
  && ['ready', 'playing', 'paused', 'completed'].includes(value.state) && Number.isInteger(value.plays_used)
  && value.plays_used >= 0 && Number.isInteger(value.max_plays) && value.max_plays >= 1
  && value.plays_used <= value.max_plays && Number.isInteger(value.duration_ms) && value.duration_ms > 0
  && Number.isInteger(value.position_ms) && value.position_ms >= 0
  && value.position_ms <= value.duration_ms
  && (value.state === 'ready' || typeof value.playback_id === 'string');

/**
 * The sentences only the PRACTICE path can say. `exhausted` uses `pl` rather than `pt` because it reports
 * the allowance itself (`{max}`), not a state name.
 */
export function practicePlaybackMessage(state, locale = getLocale()) {
  const code = state?.error?.error;
  if (code === 'practice_check_required') return pt('partRunnerAudioCheckFirst', {}, locale);
  if (code === 'playback_exhausted') return pt('partRunnerAudioUsed', {}, locale);
  /* The sitting's own plan is spent: the same sentence, whether or not it was ever evaluated. */
  if (state?.playback?.state === 'completed' && state.playback.plays_used >= state.playback.max_plays) {
    return pt('partRunnerAudioUsed', {}, locale);
  }
  if (code === 'practice_playback_unavailable') return pt('partRunnerAudioUnavailable', {}, locale);
  if (code === 'playback_conflict' || code === 'playback_recovery_required') return pt('audioConflict', {}, locale);
  if (code === 'play_rejected') return pt('audioRejected', {}, locale);
  const playback = state?.playback;
  if (state?.error) return state.pending ? pt('audioUnknown', {}, locale) : pt('audioLoadFailed', {}, locale);
  if (state?.busy) return pt('audioConfirming', {}, locale);
  if (!playback) return pt('partRunnerAudioLoading', {}, locale);
  if (playback.state === 'completed') {
    if (playback.plays_used < playback.max_plays) return pt('audioAnother', {}, locale);
    return state.checked ? pt('partRunnerAudioChecked', {}, locale) : pt('partRunnerAudioUsed', {}, locale);
  }
  if (state.playing) return pt('audioPlaying', {}, locale);
  if (playback.state === 'ready' && playback.plays_used === 0) return pt('partRunnerAudioReady', {}, locale);
  if (playback.state === 'paused' && state.mediaReady) return pt('audioPaused', {}, locale);
  /*
   * Anything else means the server already has a play of this recording that THIS document has not
   * finished — a reload, a lost acknowledgement, a failed byte fetch. The honest word is "resume", and
   * the control below re-reads the server's own position rather than pretending the play never happened.
   */
  return pt('partRunnerAudioResume', {}, locale);
}

/**
 * The practice player. `mount` is called with the current served state on EVERY host re-render of the part
 * runner, so the block survives the runner re-rendering the page around it.
 */
export function createPracticeListeningPlayer({
  api, esc, canEdit = () => true, getExamLanguage = () => null,
  createAudio = () => new Audio(),
  createObjectURL = blob => URL.createObjectURL(blob), revokeObjectURL = url => URL.revokeObjectURL(url),
  eventId = () => crypto.randomUUID(), now = () => Date.now(), onChange = () => {},
}) {
  let host = null, attemptId = null, recording = null, playback = null, error = null, pending = null;
  let flight = null, epoch = 0, loading = false, playing = false, mediaReady = false, localError = null;
  let audio = null, objectUrl = null, listeners = [], timer = null, frozen = false, lastCheckpoint = 0;
  let checked = false, busy = false;

  const state = () => ({
    playback, error: localError || error, pending: Boolean(pending), busy: busy || loading,
    loading, playing, mediaReady, checked, recording,
  });
  const emit = () => { render(); onChange(); };
  const emitChange = () => onChange();
  const position = () => {
    const fromAudio = audio && !audio.paused ? Math.floor((audio.currentTime || 0) * 1000) : 0;
    return Math.min(recording?.duration_ms || 0, Math.max(fromAudio, playback?.position_ms || 0));
  };
  const halt = () => { playing = false; try { audio?.pause(); } catch { /* a detached element cannot pause */ } };
  function resetAudio() {
    halt();
    clearInterval(timer); timer = null;
    for (const [name, handler] of listeners) audio?.removeEventListener(name, handler);
    listeners = [];
    try { if (audio) { audio.removeAttribute('src'); audio.load(); audio.remove?.(); } } catch { /* detached */ }
    if (objectUrl) revokeObjectURL(objectUrl);
    audio = null; objectUrl = null; mediaReady = false; lastCheckpoint = 0;
  }
  /* ------------------------------------------------------------------------------- transport */

  async function read() {
    const ticket = ++epoch;
    loading = true; localError = null; playback = null; resetAudio(); emit();
    let response;
    try { response = await api.practice.playback(attemptId); } catch { response = failure('network'); }
    if (ticket !== epoch) return false;
    loading = false;
    const found = response?.data?.items?.find(item => matches(item, recording));
    if (!response?.ok || !valid(found, recording)) {
      error = response?.ok ? failure('invalid_response') : response || failure('network');
      emit(); return false;
    }
    playback = copy(found); checked = response.data?.sitting?.checked === true; error = null;
    /* The DTO is the authority on the recording's own facts: its length and the sitting's allowance. */
    recording = { ...recording, duration_ms: playback.duration_ms, max_plays: playback.max_plays };
    emit(); return true;
  }

  /** One acknowledged event. `playback` only advances on a receipt the state machine accepts. */
  async function send() {
    if (flight) return flight;
    if (!pending) return true;
    const ticket = epoch, operation = copy(pending);
    flight = (async () => {
      let response;
      try { response = await api.practice.playbackEvent(attemptId, operation); } catch { response = failure('network'); }
      if (ticket !== epoch) return false;
      const value = response?.data?.playback;
      if (!response?.ok || !valid(value, recording) || value.revision <= operation.expectedRevision
        || value.revision < playback.revision
        || (operation.action === 'begin' && value.plays_used !== playback.plays_used + 1)
        || (operation.action !== 'begin' && value.plays_used !== playback.plays_used)) {
        error = response?.ok ? failure('invalid_response') : response || failure('network');
        return false;
      }
      playback = copy(value); pending = null; error = null; return true;
    })();
    emitChange();
    try { return await flight; } finally { if (ticket === epoch) { flight = null; emit(); } }
  }

  async function act(action, positionMs, flushing = false) {
    if (!playback || loading || pending || flight || (!flushing && !canEdit()) || frozen) return false;
    if (action === 'begin' && (!['ready', 'completed'].includes(playback.state) || playback.plays_used >= playback.max_plays)) return false;
    if (action !== 'begin' && !playback.playback_id) return false;
    const body = {
      eventId: eventId(), mediaId: recording.media_id, mediaVersion: recording.media_version,
      expectedRevision: playback.revision, action,
    };
    if (action !== 'begin') body.playbackId = playback.playback_id;
    if (['checkpoint', 'pause', 'complete'].includes(action)) {
      if (!Number.isInteger(positionMs) || positionMs < playback.position_ms || positionMs > playback.duration_ms) return false;
      body.positionMs = positionMs;
    }
    pending = body;
    return send();
  }

  /* --------------------------------------------------------------------------------- bytes */

  async function loadBytes() {
    const ticket = epoch;
    loading = true; emit();
    let result;
    try { result = await api.practice.media(attemptId, recording.media_id, recording.media_version); } catch { result = failure('network'); }
    if (ticket !== epoch) return false;
    loading = false;
    if (!result?.ok) { localError = result || failure('media_unavailable'); emit(); return false; }
    resetAudio();
    objectUrl = createObjectURL(result.data);
    audio = createAudio(); audio.preload = 'auto'; audio.controls = false; audio.hidden = true;
    audio.setAttribute?.('data-listening-audio', recording.media_id);
    globalThis.document?.body?.append(audio);
    audio.playbackRate = 1; audio.defaultPlaybackRate = 1;
    const listen = (name, handler) => { audio.addEventListener(name, handler); listeners.push([name, handler]); };
    listen('canplay', () => { if (ticket === epoch) { mediaReady = true; emit(); } });
    listen('error', () => { if (ticket === epoch) { resetAudio(); localError = failure('media_unavailable'); emit(); } });
    listen('ratechange', () => { if (audio && audio.playbackRate !== 1) audio.playbackRate = 1; });
    listen('seeking', () => {
      const floor = playback?.position_ms || 0;
      if (audio && audio.currentTime * 1000 < floor - 100) audio.currentTime = floor / 1000;
    });
    listen('timeupdate', () => {
      if (!playing) return;
      const progress = host?.querySelector?.('[data-listening-progress]');
      if (progress) progress.value = position();
    });
    listen('ended', () => { if (ticket === epoch) void finish(); });
    audio.src = objectUrl; audio.load();
    /*
     * The checkpoint ticker is a PROGRESS POLLER, not a reason for the document to stay alive: in the browser
     * it is cleared by `resetAudio`/`dispose`, and in the check's Node process an un-cleared one would keep the
     * event loop open after the last assertion (a mutated copy made exactly that visible). `unref` says so
     * without changing what the timer does.
     */
    timer = setInterval(() => { if (playing && !pending && !flight && now() - lastCheckpoint >= 2000) void checkpoint(); }, 500);
    timer.unref?.();
    emit();
    return true;
  }

  /** The half of "pause" that only the browser can do; the durable half is `pauseSaved` below. */
  function pauseLocally() {
    halt();
    const progress = host?.querySelector?.('[data-listening-progress]');
    if (progress) progress.value = position();
  }

  async function pauseSaved(flushing = false) {
    const current = playback;
    if (!current || current.state !== 'playing') return true;
    return act('pause', position(), flushing);
  }

  async function checkpoint() {
    if (!playing || pending || flight) return false;
    lastCheckpoint = now();
    return act('checkpoint', position());
  }

  async function finish() {
    const ticket = epoch;
    halt();
    if (playback?.state === 'playing') { const ok = await act('complete', recording.duration_ms); if (ticket !== epoch) return false; return ok; }
    emit(); return true;
  }

  /* ------------------------------------------------------------------------------- actions */

  async function play() {
    if (!playback || loading || pending || flight || playing || !canEdit() || frozen) return false;
    /*
     * NO AFFORDANCE, NO REQUEST. `control()` is the single place that knows whether a play is available
     * (the allowance, and whether the sitting is checked); if it offers nothing, the client must not send a
     * `begin` the server would refuse. That is the difference between "the button is gone" and "the button
     * was there and lied".
     */
    if (!control()) return false;
    const ticket = epoch;
    localError = null;
    /*
     * ALREADY OURS, ALREADY LOADED: a play the server acknowledges and this document is still holding (paused
     * or still buffered) continues WITHOUT another event. Every other state goes through the server first,
     * because the allowance — not the client — decides whether a play may start.
     */
    if (mediaReady && ['playing', 'paused'].includes(playback.state)) {
      busy = true; emit();
      audio.currentTime = (playback.position_ms || 0) / 1000;
      lastCheckpoint = now();
      try {
        await audio.play();
        if (ticket !== epoch) return false;
        playing = true; busy = false; emit(); return true;
      } catch {
        busy = false; halt(); localError = failure('play_rejected'); emit(); return false;
      }
    }
    /*
     * THE ORDER IS THE RULE. `begin` for a state the server has not started (ready) or has finished; for
     * anything else the same play is RECOVERED, which rotates the playback identity without debiting a second
     * one. The bytes are fetched only AFTER the server has acknowledged a play in progress, because that is the
     * only window in which it serves them.
     */
    busy = true; emit();
    const action = ['ready', 'completed'].includes(playback.state) ? 'begin' : 'recover';
    const acknowledged = await act(action);
    if (ticket !== epoch) return false;
    if (!acknowledged) { busy = false; halt(); emit(); return false; }
    const next = playback;
    const startAt = next.state === 'completed' ? 0 : next.position_ms;
    if (!mediaReady) {
      const loaded = await loadBytes();
      if (ticket !== epoch) return false;
      if (!loaded) { busy = false; emit(); return false; }
    }
    if (ticket !== epoch) return false;
    if (startAt >= 0) audio.currentTime = startAt / 1000;
    lastCheckpoint = now();
    try {
      await audio.play();
      if (ticket !== epoch) return false;
      playing = true; busy = false; emit();
      return true;
    } catch {
      busy = false; halt(); localError = failure('play_rejected'); emit(); return false;
    }
  }

  async function pause() {
    if (pending || flight) { await send(); }
    pauseLocally();
    const saved = await pauseSaved();
    emit();
    return saved;
  }

  async function retry() {
    if (!(await send())) { emit(); return false; }
    emit();
    return true;
  }

  async function reload() {
    if (flight) return false;
    halt(); localError = null;
    return read();
  }

  /** Everything the runner must be sure of before it freezes the page for "Auswerten". */
  async function flush() {
    halt();
    playing = false;
    if (pending || flight) { const ok = await send(); if (!ok && !terminal(error)) { emit(); return false; } }
    if (playback?.state === 'playing') { const ok = await pauseSaved(true); emit(); return ok || terminal(error); }
    emit();
    return true;
  }

  /* -------------------------------------------------------------------------------- render */

  /** The one control the practice path offers, from the state the SERVER last reported. */
  function control() {
    const current = playback;
    /*
     * A SPENT ALLOWANCE OFFERS NOTHING, EVEN WHEN THE SITTING IS CHECKED. `playback_exhausted` is the
     * server's answer for both "you have not evaluated" and "there is nothing left", and a client that
     * showed a play button for the second case would be inviting a request it already knows fails.
     */
    if (current?.state === 'completed' && current.plays_used >= current.max_plays) return null;
    if (!current) return 'reload';
    if (playing) return 'pause';
    if (['playing', 'paused'].includes(current.state)) return 'play';
    if (current.state === 'completed') return 'play';
    if (current.state === 'ready') return current.plays_used < current.max_plays ? 'play' : null;
    return null;
  }

  function render() {
    if (!host || !recording) return;
    if (host.isConnected === false) return;
    const focus = focusedListeningAction(host);
    const snapshot = state();
    const action = control();
    const examLanguage = getExamLanguage() || 'und';
    const labels = { play: action === 'play' ? pl(playback?.state === 'ready' && playback?.plays_used === 0 ? 'partRunnerPlayFirst' : 'partRunnerResume') : pl('partRunnerPlay') };
    host.innerHTML = listeningPlayerMarkup(snapshot, recording, {
      run: { exam_language: examLanguage, release_state: 'internal' },
      examLanguage, esc, locale: getLocale(), attemptMode: 'practice',
      instruction: null, canEdit, frozen, playing, loading, ready: mediaReady,
      terminal, position, message: listing => practicePlaybackMessage(listing, getLocale()),
      actions: ({ button, busy: isBusy }) => (action ? button(action, labels.play, Boolean(isBusy)) : ''),
    });
    restoreListeningFocus(host, focus);
    updatePracticeLocale(host, getLocale());
  }

  return {
    state,
    /**
     * Re-render into the host after the runner rebuilt the page around the block.
     *
     * The runner replaces its whole subtree on every state change, so the block's element is a NEW node each
     * time. The sitting and the recording — not the node — decide whether this is a new attempt (fresh state,
     * a read) or the same one (re-render only). Nothing is re-read and nothing is debited on a re-render.
     */
    mount(target, binding) {
      if (!target) return false;
      const nextAttempt = binding.attemptId;
      const sameAttempt = attemptId === nextAttempt
        && recording?.media_id === binding.recording.media_id
        && recording?.media_version === binding.recording.media_version;
      if (sameAttempt) { host = target; render(); return true; }
      epoch++;
      resetAudio();
      host = target; attemptId = nextAttempt; recording = copy(binding.recording);
      playback = null; error = null; pending = null; localError = null; checked = false; flight = null;
      render();
      void read();
      return true;
    },
    play, pause, retry, reload, flush, send,
    freeze(value = true) { if (value && !frozen) { halt(); playing = false; } frozen = value; render(); },
    /** "Auswerten" has been accepted: the sitting is checked, so the replay sentence changes. */
    markChecked() { checked = true; render(); },
    updateLocale() { if (host?.isConnected) render(); },
    get needsFlush() { return playing || Boolean(pending) || Boolean(flight) || playback?.state === 'playing'; },
    preserveOnUnload(event) { if (this.needsFlush) { halt(); event.preventDefault(); event.returnValue = ''; } },
    /** The one string the runner must be able to read without a DOM (the check drives this). */
    statusText(locale = getLocale()) { return practicePlaybackMessage(state(), locale); },
    dispose() {
      epoch++; resetAudio();
      if (host) { host.onclick = null; host.innerHTML = ''; }
      host = null; attemptId = null; recording = null; playback = null; error = null; pending = null; flight = null;
    },
  };
}

/** The authored recording of a served set, or null when the set carries none. */
export function servedRecording(set) {
  const rows = set?.material && Array.isArray(set.material.recordings) ? set.material.recordings : [];
  const found = rows.find(row => row && typeof row.mediaId === 'string' && typeof row.mediaVersion === 'string');
  if (!found) return null;
  return {
    media_id: found.mediaId, media_version: found.mediaVersion,
    label: typeof found.label === 'string' && found.label ? found.label : '',
  };
}

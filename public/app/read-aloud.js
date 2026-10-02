/** Optional speech for visible text. No remote voices, requests, persistence or automatic playback. */
export const READ_ALOUD_LIMIT = 4000;
const languages = { de: 'Deutsch', en: 'Englisch', uk: 'Ukrainisch', ar: 'Arabisch', tr: 'Türkisch' };
const primary = value => String(value || '').toLowerCase().split('-')[0];

export function createLocalSpeech({ synthesis = globalThis.speechSynthesis, Utterance = globalThis.SpeechSynthesisUtterance,
  later = setTimeout, cancelLater = clearTimeout } = {}) {
  let active = null, serial = 0;
  const listeners = new Set();
  const supported = Boolean(synthesis && typeof synthesis.getVoices === 'function' && typeof synthesis.speak === 'function'
    && typeof synthesis.cancel === 'function' && typeof Utterance === 'function');
  function availability(language) {
    const lang = primary(language);
    if (!supported) return { message: 'Vorlesen wird in diesem Browser nicht unterstützt.' };
    if (!languages[lang]) return { message: 'Für diese Textsprache ist Vorlesen nicht verfügbar.' };
    let voices;
    try { voices = synthesis.getVoices(); } catch { return { message: 'Die Stimmen auf diesem Gerät konnten nicht geladen werden.' }; }
    const matching = Array.from(voices || []).filter(voice => voice.localService === true && primary(voice.lang) === lang);
    const voice = matching.find(voice => voice.default) || matching[0];
    return voice ? { voice, lang } : { message: `Auf diesem Gerät ist noch keine lokale Stimme für ${languages[lang]} verfügbar.` };
  }
  function finish(state, message) {
    const old = active;
    active = null;
    serial++;
    if (old) { cancelLater(old.timer); old.report({ state, message }); }
  }
  function stop() {
    if (!active) return;
    finish('stopped', 'Vorlesen gestoppt.'); // invalidate callbacks before cancel dispatches an event
    try { synthesis.cancel(); } catch { /* no fallback voice */ }
  }
  function play(text, language, report) {
    stop();
    if (typeof text !== 'string' || !text.trim()) { report({ state: 'error', message: 'Kein sichtbarer Text zum Vorlesen.' }); return; }
    if (text.length > READ_ALOUD_LIMIT) { report({ state: 'error', message: `Dieser Text ist zum Vorlesen zu lang (höchstens ${READ_ALOUD_LIMIT} Zeichen).` }); return; }
    const choice = availability(language);
    if (!choice.voice) { report({ state: 'unavailable', message: choice.message }); return; }
    const token = ++serial;
    try {
      const utterance = new Utterance(text.trim());
      utterance.voice = choice.voice;
      utterance.lang = choice.voice.lang;
      active = { report, utterance, timer: null };
      const current = () => active?.utterance === utterance && serial === token;
      utterance.onstart = () => { if (current()) { cancelLater(active.timer); report({ state: 'playing', message: 'Wird vorgelesen …' }); } };
      utterance.onend = () => { if (current()) finish('ended', 'Vorlesen beendet.'); };
      utterance.onerror = event => {
        if (!current()) return;
        finish('error', ['canceled', 'interrupted'].includes(event.error) ? 'Vorlesen unterbrochen.' : 'Vorlesen fehlgeschlagen. Bitte versuche es erneut.');
      };
      report({ state: 'starting', message: 'Vorlesen wird gestartet …' });
      active.timer = later(() => {
        if (!current()) return;
        finish('error', 'Vorlesen konnte nicht gestartet werden. Bitte versuche es erneut.');
        try { synthesis.cancel(); } catch { /* no remote fallback */ }
      }, 8000);
      synthesis.speak(utterance);
    } catch {
      if (active) finish('error', 'Vorlesen fehlgeschlagen. Bitte versuche es erneut.');
      else report({ state: 'error', message: 'Vorlesen fehlgeschlagen. Bitte versuche es erneut.' });
      try { synthesis.cancel(); } catch { /* no remote fallback */ }
    }
  }
  const changed = () => { for (const listener of listeners) listener(); };
  synthesis?.addEventListener?.('voiceschanged', changed);
  return { availability, play, stop, subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    destroy() { stop(); listeners.clear(); synthesis?.removeEventListener?.('voiceschanged', changed); } };
}

/** Mount beside the precise rendered paragraph; language comes from that paragraph's metadata. */
export function createReadAloud({ speech = createLocalSpeech(), doc = globalThis.document, events = globalThis.window } = {}) {
  const controls = new Set();
  let selected = null, counter = 0;
  function stop() { speech.stop(); selected = null; }
  function clear(container) {
    for (const control of [...controls]) {
      if (!control.text.isConnected || container?.contains(control.text)) {
        if (selected === control) stop();
        control.unsubscribe(); control.box.remove(); controls.delete(control);
      }
    }
  }
  function mount(text, { language = text.lang, label = 'Text' } = {}) {
    if (!text?.textContent?.trim()) return;
    const box = doc.createElement('div'); box.className = 'read-aloud'; box.lang = 'de'; box.dir = 'ltr';
    const button = doc.createElement('button'); button.type = 'button'; button.className = 'btn btn-small';
    const status = doc.createElement('span'); status.className = 'read-aloud-status small muted';
    status.id = `read-aloud-status-${++counter}`; status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
    button.setAttribute('aria-describedby', status.id);
    box.append(button, status); text.after(box);
    const control = { text, box, unsubscribe: () => {}, busy: false, tried: false };
    const update = ({ state, message }) => {
      control.busy = state === 'starting' || state === 'playing';
      button.textContent = control.busy ? 'Stoppen' : 'Vorlesen';
      button.setAttribute('aria-label', control.busy ? `${label}: Vorlesen stoppen` : `${label} vorlesen`);
      button.setAttribute('aria-pressed', String(control.busy));
      status.textContent = message;
      if (!control.busy && selected === control) selected = null;
    };
    update({ state: 'idle', message: '' });
    button.addEventListener('click', () => {
      if (control.busy) { stop(); return; }
      stop();
      // Read only a currently rendered paragraph, never hidden submitted text or another view.
      if (!text.isConnected || text.closest('[hidden]') || !text.getClientRects().length) return;
      control.tried = true; selected = control;
      speech.play(text.innerText, language, update);
    });
    control.unsubscribe = speech.subscribe(() => {
      if (!control.tried || control.busy) return;
      const available = speech.availability(language);
      update({ state: 'idle', message: available.voice ? 'Eine lokale Stimme ist verfügbar. Wähle Vorlesen zum Starten.' : available.message });
    });
    controls.add(control);
    return box;
  }
  for (const event of ['hashchange', 'pagehide', 'hatoove:session-expired']) events?.addEventListener(event, stop);
  return { mount, stop, clear, destroy() {
    stop(); for (const control of controls) { control.unsubscribe(); control.box.remove(); } controls.clear();
    for (const event of ['hashchange', 'pagehide', 'hatoove:session-expired']) events?.removeEventListener(event, stop);
    speech.destroy();
  } };
}

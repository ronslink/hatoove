import { getLocale, LANGUAGE_NAMES } from '../assets/i18n/core.js';
import { pt } from '../assets/i18n/practice-messages.js';
const message = (messageKey,parameters={}) => ({messageKey,parameters,message:pt(messageKey,parameters)});
/** Optional speech for visible text. No remote voices, requests, persistence or automatic playback. */
export const READ_ALOUD_LIMIT = 4000;
const languages = LANGUAGE_NAMES;
const primary = value => String(value || '').toLowerCase().split('-')[0];

export function createLocalSpeech({ synthesis = globalThis.speechSynthesis, Utterance = globalThis.SpeechSynthesisUtterance,
  later = setTimeout, cancelLater = clearTimeout } = {}) {
  let active = null, serial = 0;
  const listeners = new Set();
  const supported = Boolean(synthesis && typeof synthesis.getVoices === 'function' && typeof synthesis.speak === 'function'
    && typeof synthesis.cancel === 'function' && typeof Utterance === 'function');
  function availability(language) {
    const lang = primary(language);
    if (!supported) return message('speechUnsupported');
    if (!languages[lang]) return message('speechLanguage');
    let voices;
    try { voices = synthesis.getVoices(); } catch { return message('speechVoices'); }
    const matching = Array.from(voices || []).filter(voice => voice.localService === true && primary(voice.lang) === lang);
    const voice = matching.find(voice => voice.default) || matching[0];
    return voice ? { voice, lang } : message('speechNoVoice',{language:languages[lang]});
  }
  function finish(state, messageKey) {
    const old = active;
    active = null;
    serial++;
    if (old) { cancelLater(old.timer); old.report({ state, ...message(messageKey) }); }
  }
  function stop() {
    if (!active) return;
    finish('stopped', 'speechStopped'); // invalidate callbacks before cancel dispatches an event
    try { synthesis.cancel(); } catch { /* no fallback voice */ }
  }
  function play(text, language, report) {
    stop();
    if (typeof text !== 'string' || !text.trim()) { report({ state: 'error', ...message('speechEmpty') }); return; }
    if (text.length > READ_ALOUD_LIMIT) { report({ state: 'error', ...message('speechLong',{limit:READ_ALOUD_LIMIT}) }); return; }
    const choice = availability(language);
    if (!choice.voice) { report({ state: 'unavailable', ...choice }); return; }
    const token = ++serial;
    try {
      const utterance = new Utterance(text);
      utterance.voice = choice.voice;
      utterance.lang = choice.voice.lang;
      active = { report, utterance, timer: null };
      const current = () => active?.utterance === utterance && serial === token;
      utterance.onstart = () => { if (current()) { cancelLater(active.timer); report({ state: 'playing', ...message('speechPlaying') }); } };
      utterance.onend = () => { if (current()) finish('ended', 'speechEnded'); };
      utterance.onerror = event => {
        if (!current()) return;
        finish('error', ['canceled', 'interrupted'].includes(event.error) ? 'speechInterrupted' : 'speechFailed');
      };
      report({ state: 'starting', ...message('speechStarting') });
      active.timer = later(() => {
        if (!current()) return;
        finish('error', 'speechStartFailed');
        try { synthesis.cancel(); } catch { /* no remote fallback */ }
      }, 8000);
      synthesis.speak(utterance);
    } catch {
      if (active) finish('error', 'speechFailed');
      else report({ state: 'error', ...message('speechFailed') });
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
  function mount(text, { language = text.lang, label = null, labelKey = label ? null : 'text' } = {}) {
    if (!text?.textContent?.trim()) return;
    const box = doc.createElement('div'); box.className = 'read-aloud'; box.lang = getLocale(); box.dir = getLocale() === 'ar' ? 'rtl' : 'ltr';
    const button = doc.createElement('button'); button.type = 'button'; button.className = 'btn btn-small';
    const status = doc.createElement('span'); status.className = 'read-aloud-status small muted';
    status.id = `read-aloud-status-${++counter}`; status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
    button.setAttribute('aria-describedby', status.id);
    box.append(button, status); text.after(box);
    const control = { text, box, unsubscribe: () => {}, busy: false, tried: false, latest: {state:'idle',message:''}, paint: null };
    const paint = (locale = getLocale()) => {
      const shown = labelKey ? pt(labelKey,{},locale) : label;
      box.lang = locale; box.dir = locale === 'ar' ? 'rtl' : 'ltr';
      button.textContent = pt(control.busy ? 'stop' : 'readAloud',{},locale);
      button.setAttribute('aria-label',pt(control.busy ? 'stopLabel' : 'readLabel',{label:shown},locale));
      button.setAttribute('aria-pressed',String(control.busy));
      status.textContent = control.latest.messageKey ? pt(control.latest.messageKey,control.latest.parameters || {},locale) : control.latest.message || '';
    };
    control.paint = paint;
    const update = value => {
      control.latest = value; control.busy = value.state === 'starting' || value.state === 'playing'; paint();
      if (!control.busy && selected === control) selected = null;
    };
    update({ state: 'idle', message: '' });
    button.addEventListener('click', () => {
      if (control.busy) { stop(); return; }
      stop();
      // Read only a currently rendered paragraph, never hidden submitted text or another view.
      if (!text.isConnected || text.closest('[hidden]') || !text.getClientRects().length) return;
      control.tried = true; selected = control;
      speech.play(text.textContent, language, update);
    });
    control.unsubscribe = speech.subscribe(() => {
      if (!control.tried || control.busy) return;
      const available = speech.availability(language);
      update({ state: 'idle', ...(available.voice ? message('speechAvailable') : available) });
    });
    controls.add(control);
    return box;
  }
  for (const event of ['hashchange', 'pagehide', 'hatoove:session-expired']) events?.addEventListener(event, stop);
  return { mount, stop, clear, updateLocale(locale = getLocale()) { for (const control of controls) if (control.box.isConnected) control.paint(locale); }, destroy() {
    stop(); for (const control of controls) { control.unsubscribe(); control.box.remove(); } controls.clear();
    for (const event of ['hashchange', 'pagehide', 'hatoove:session-expired']) events?.removeEventListener(event, stop);
    speech.destroy();
  } };
}

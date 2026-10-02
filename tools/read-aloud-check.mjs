/** Deterministic browser-speech adapter checks. Synthetic voices; no audio, network, files or provider. */
import assert from 'node:assert/strict';
import { createLocalSpeech, READ_ALOUD_LIMIT } from '../public/app/read-aloud.js';

const local = (lang, extra = {}) => ({ lang, localService: true, name: 'Synthetic local voice', ...extra });
function fixture(voices = [local('de-DE')]) {
  const spoken = [], timers = new Map(), changes = new Set();
  let nextTimer = 0, cancelled = 0;
  const synthesis = {
    voices, getVoices() { return this.voices; }, speak(utterance) { spoken.push(utterance); },
    cancel() { cancelled++; spoken.at(-1)?.onerror?.({ error: 'canceled' }); },
    addEventListener(name, fn) { assert.equal(name, 'voiceschanged'); changes.add(fn); },
    removeEventListener(name, fn) { changes.delete(fn); },
  };
  const speech = createLocalSpeech({ synthesis, Utterance: class { constructor(text) { this.text = text; } },
    later(fn) { const id = ++nextTimer; timers.set(id, fn); return id; }, cancelLater(id) { timers.delete(id); } });
  return { speech, synthesis, spoken, changes, timers, get cancelled() { return cancelled; } };
}
const results = [];
async function check(name, fn) {
  try { await fn(); results.push(true); console.log(`PASS ${name}`); }
  catch (error) { results.push(false); console.log(`FAIL ${name}: ${error.message}`); }
}
await check('all five languages require an exact primary match and a confirmed local service', () => {
  for (const lang of ['de', 'en', 'uk', 'ar', 'tr']) {
    const chosen = local(lang + '-XX');
    const f = fixture([{ lang: lang + '-ZZ', localService: false, default: true }, { lang, name: 'Unconfirmed' }, local('fr-FR'), chosen]);
    f.speech.play('Sichtbarer Beispieltext.', lang, () => {});
    assert.equal(f.spoken.length, 1); assert.equal(f.spoken[0].voice, chosen); assert.equal(f.spoken[0].lang, chosen.lang);
    f.speech.destroy();
  }
});
await check('no German fallback, remote voice, unknown language or implicit default', () => {
  const f = fixture([local('de-DE'), { lang: 'ar-SA', localService: false }]);
  for (const lang of ['ar', 'en', 'uk', 'tr', 'xx', '']) {
    const states = []; f.speech.play('Text', lang, state => states.push(state));
    assert.equal(states.at(-1).state, 'unavailable');
  }
  assert.equal(f.spoken.length, 0); f.speech.destroy();
});
await check('delayed voice discovery notifies availability without autoplay', () => {
  const f = fixture([]), states = []; let changed = 0;
  f.speech.subscribe(() => changed++);
  f.speech.play('Satz.', 'de', state => states.push(state));
  assert.equal(states.at(-1).state, 'unavailable');
  f.synthesis.voices = [local('de-AT')]; for (const listener of f.changes) listener();
  assert.equal(changed, 1); assert.equal(f.spoken.length, 0);
  f.speech.play('Satz.', 'de', () => {}); assert.equal(f.spoken.length, 1); f.speech.destroy();
});
await check('new selection cancels old speech and stale callbacks cannot replace its state', () => {
  const f = fixture(), first = [], second = [];
  f.speech.play('Erster Satz.', 'de', state => first.push(state)); const old = f.spoken[0];
  old.onstart(); assert.equal(first.at(-1).state, 'playing');
  f.speech.play('Zweiter Satz.', 'de', state => second.push(state));
  assert.equal(f.cancelled, 1); assert.equal(first.at(-1).state, 'stopped');
  old.onerror({ error: 'network' }); old.onend(); old.onstart();
  assert.equal(first.at(-1).state, 'stopped'); assert.equal(second.at(-1).state, 'starting');
  f.spoken[1].onstart(); f.spoken[1].onend(); assert.equal(second.at(-1).state, 'ended'); f.speech.destroy();
});
await check('explicit stop clears pending start and rejects late events', () => {
  const f = fixture(), states = [];
  f.speech.play('Satz.', 'de', state => states.push(state)); const old = f.spoken[0];
  f.speech.stop(); assert.equal(f.timers.size, 0); assert.equal(f.cancelled, 1);
  old.onstart(); old.onend(); assert.equal(states.at(-1).state, 'stopped'); f.speech.destroy();
});
await check('API absence, getVoices failure and empty/oversized text fail without speaking', () => {
  const unsupported = createLocalSpeech({ synthesis: null, Utterance: null });
  assert.match(unsupported.availability('de').message, /nicht unterstützt/); unsupported.destroy();
  const f = fixture(), states = [];
  for (const text of ['', '   ', null, 'a'.repeat(READ_ALOUD_LIMIT + 1)]) f.speech.play(text, 'de', state => states.push(state));
  assert.equal(f.spoken.length, 0); assert.ok(states.every(state => state.state === 'error'));
  f.synthesis.getVoices = () => { throw new Error('synthetic'); };
  f.speech.play('Satz.', 'de', state => states.push(state)); assert.equal(states.at(-1).state, 'unavailable'); f.speech.destroy();
});
await check('playback exceptions, error events and stalled starts recover without a fallback', () => {
  const f = fixture(), states = [];
  f.speech.play('Satz.', 'de', state => states.push(state)); f.spoken.at(-1).onerror({ error: 'audio-busy' });
  assert.equal(states.at(-1).state, 'error'); assert.equal(f.timers.size, 0);
  f.speech.play('Satz.', 'de', state => states.push(state)); [...f.timers.values()][0]();
  assert.equal(states.at(-1).state, 'error'); assert.equal(f.cancelled, 1);
  f.synthesis.speak = () => { throw new Error('synthetic playback error'); };
  f.speech.play('Satz.', 'de', state => states.push(state)); assert.equal(states.at(-1).state, 'error');
  assert.equal(f.spoken.length, 2); f.speech.destroy();
});
await check('successful boundary text is unchanged except surrounding whitespace; destroy unsubscribes', () => {
  const f = fixture(); const text = 'x'.repeat(READ_ALOUD_LIMIT);
  f.speech.play(text, 'de', () => {}); assert.equal(f.spoken[0].text, text);
  f.speech.destroy(); assert.equal(f.changes.size, 0); assert.equal(f.timers.size, 0);
});
const passed = results.filter(Boolean).length;
console.log(`\n${passed} passed, ${results.length - passed} failed`);
process.exitCode = passed === results.length ? 0 : 1;

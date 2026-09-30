/**
 * Browser speech: text-to-speech for Hoerverstehen, speech recognition for Sprechen.
 *
 * Using the built-in Web Speech APIs keeps the app free to run and needs no extra
 * key. Both degrade gracefully: if there is no German voice installed we show the
 * script instead of pretending to play it.
 */

let currentUtterances = [];
let playing = false;
let stopRequested = false;

export function ttsSupported() {
  return typeof window !== 'undefined' && 'speechSynthesis' in window;
}

export function voices() {
  if (!ttsSupported()) return [];
  return window.speechSynthesis.getVoices() || [];
}

export function germanVoices() {
  return voices().filter((v) => /^de/i.test(v.lang || ''));
}

export function waitForVoices(timeoutMs = 1500) {
  return new Promise((resolve) => {
    if (!ttsSupported()) return resolve([]);
    const existing = voices();
    if (existing.length) return resolve(existing);
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      resolve(voices());
    };
    window.speechSynthesis.addEventListener('voiceschanged', finish, { once: true });
    setTimeout(finish, timeoutMs);
  });
}

export function pickVoice(preferName) {
  const de = germanVoices();
  if (!de.length) return null;
  if (preferName) {
    const hit = de.find((v) => v.name === preferName);
    if (hit) return hit;
  }
  // Prefer higher-quality local voices when the platform exposes them.
  const ranked = de.slice().sort((a, b) => {
    const score = (v) => (v.localService ? 2 : 0) + (/natural|premium|enhanced|neural/i.test(v.name) ? 3 : 0);
    return score(b) - score(a);
  });
  return ranked[0];
}

/**
 * Split a Hoerverstehen script into speakable turns.
 * Scripts look like: "[Moderator]: Guten Tag ...\n[Gast]: ..."
 */
export function parseScript(script) {
  const lines = String(script || '')
    .split(/\n+/)
    .map((l) => l.trim())
    .filter(Boolean);

  const turns = [];
  for (const line of lines) {
    const m = line.match(/^\[([^\]]+)\]\s*:?\s*(.*)$/);
    if (m) {
      turns.push({ speaker: m[1].trim(), text: m[2].trim() });
    } else if (turns.length) {
      turns[turns.length - 1].text += ` ${line}`;
    } else {
      turns.push({ speaker: '', text: line });
    }
  }
  return turns.filter((t) => t.text);
}

/**
 * Chrome has historically cut long utterances off mid-sentence. On current Chrome
 * speech time was measured as linear well past 40 seconds (see tools/tts-check.js),
 * so this only splits pathologically long turns; normal turns are spoken whole to
 * keep the prosody natural.
 */
export function chunkForSpeech(text, maxChars = 600) {
  const t = String(text || '').trim();
  if (!t) return [];
  if (t.length <= maxChars) return [t];
  const sentences = t.match(/[^.!?]+[.!?]*\s*/g) || [t];
  const out = [];
  let buf = '';
  for (const s of sentences) {
    if (buf && (buf + s).length > maxChars) {
      out.push(buf.trim());
      buf = s;
    } else {
      buf += s;
    }
  }
  if (buf.trim()) out.push(buf.trim());
  return out;
}

export function isPlaying() {
  return playing;
}

export function stopSpeaking() {
  stopRequested = true;
  playing = false;
  currentUtterances = [];
  if (ttsSupported()) {
    try {
      window.speechSynthesis.cancel();
    } catch {
      /* ignore */
    }
  }
}

/**
 * Play a script. Returns a promise that resolves when playback ends or is stopped.
 * @param {string} script
 * @param {object} opts
 * @param {number} opts.rate        0.1 - 2
 * @param {string} opts.voiceName
 * @param {Function} opts.onTurn    (turn, index) => void
 * @param {Function} opts.onProgress (index, total) => void
 */
export async function speakScript(script, opts = {}) {
  if (!ttsSupported()) throw new Error('Dieser Browser unterstützt keine Sprachausgabe.');
  stopSpeaking();
  stopRequested = false;
  playing = true;

  const turns = parseScript(script);
  if (!turns.length) {
    playing = false;
    throw new Error('Kein Skript zum Vorlesen vorhanden.');
  }

  await waitForVoices();
  const voice = pickVoice(opts.voiceName);
  const speakers = [...new Set(turns.map((t) => t.speaker).filter(Boolean))];

  const speakerProfile = (name) => {
    const idx = Math.max(0, speakers.indexOf(name));
    return { pitch: idx % 2 === 0 ? 1.0 : 0.82, rateOffset: idx % 2 === 0 ? 0 : -0.03 };
  };

  for (let i = 0; i < turns.length; i++) {
    if (stopRequested) break;
    const turn = turns[i];
    const profile = speakerProfile(turn.speaker);
    if (opts.onProgress) opts.onProgress(i, turns.length);
    if (opts.onTurn) opts.onTurn(turn, i);
    for (const chunk of chunkForSpeech(turn.text)) {
      if (stopRequested) break;
      await speakOne(chunk, {
        voice,
        lang: voice?.lang || 'de-DE',
        rate: Math.max(0.5, Math.min(1.6, (opts.rate ?? 0.95) + profile.rateOffset)),
        pitch: profile.pitch,
      });
    }
  }

  playing = false;
  if (opts.onProgress) opts.onProgress(turns.length, turns.length);
  return { stopped: stopRequested, turns: turns.length };
}

function speakOne(text, { voice, lang, rate, pitch }) {
  return new Promise((resolve) => {
    const u = new SpeechSynthesisUtterance(text);
    if (voice) u.voice = voice;
    u.lang = lang;
    u.rate = rate;
    u.pitch = pitch;
    u.onend = () => resolve();
    u.onerror = () => resolve();
    currentUtterances.push(u);
    window.speechSynthesis.speak(u);
    // Safety net: some engines never fire onend for long strings.
    const guard = Math.max(4000, text.length * 120);
    setTimeout(() => resolve(), guard);
  });
}

/** Auto-pause-friendly single utterance, used for model answers and vocab. */
export function speak(text, { rate = 0.95, voiceName } = {}) {
  if (!ttsSupported()) return Promise.resolve();
  return new Promise((resolve) => {
    try {
      window.speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(String(text || '').slice(0, 3000));
      const v = pickVoice(voiceName);
      if (v) {
        u.voice = v;
        u.lang = v.lang;
      } else {
        u.lang = 'de-DE';
      }
      u.rate = rate;
      u.onend = resolve;
      u.onerror = resolve;
      window.speechSynthesis.speak(u);
    } catch {
      resolve();
    }
  });
}

/* ----------------------------------------------------- speech recognition */

const RecognitionCtor =
  typeof window !== 'undefined' ? window.SpeechRecognition || window.webkitSpeechRecognition || null : null;

export function sttSupported() {
  return Boolean(RecognitionCtor);
}

/** Errors that mean restarting is pointless. */
const FATAL_STT = new Set(['not-allowed', 'service-not-allowed', 'audio-capture', 'language-not-supported']);

/** Errors that just mean Chrome stopped listening and should be resumed. */
const RECOVERABLE_STT = new Set(['no-speech', 'aborted', 'audio-busy']);

const STT_MESSAGES = {
  'not-allowed': 'Mikrofonzugriff wurde verweigert. Erlaube das Mikrofon im Browser und versuche es erneut.',
  'service-not-allowed': 'Die Spracherkennung ist in diesem Browser deaktiviert.',
  'audio-capture': 'Kein Mikrofon gefunden. Prüfe, ob eines angeschlossen und aktiviert ist.',
  'language-not-supported': 'Deutsch wird von der Spracherkennung dieses Browsers nicht unterstützt.',
  network: 'Die Spracherkennung braucht eine Internetverbindung.',
};

/**
 * Live dictation in German, with automatic resumption.
 *
 * Chrome's SpeechRecognition stops on its own after a few seconds without speech,
 * and again at a hard limit of roughly a minute - even with `continuous = true`. The
 * first version treated that as the learner having finished, so the recording appeared
 * to start and then simply stop mid-answer. This keeps listening until the caller
 * explicitly stops it, and accumulates the transcript across every internal restart so
 * nothing said before a restart is lost.
 *
 * @param {object} opts
 * @param {Function} opts.onTranscript ({final, interim}) => void
 * @param {Function} [opts.onRestart]  (count) => void, for UI feedback
 * @param {Function} [opts.onEnd]      (finalText) => void, only on a real stop
 * @param {Function} [opts.onError]
 * @param {Function} [opts.Recognition] test seam: inject a fake constructor
 */
export function startDictation(opts = {}) {
  const Ctor = opts.Recognition || RecognitionCtor;
  if (!Ctor) {
    opts.onError?.(new Error('Spracherkennung wird von diesem Browser nicht unterstützt. Bitte tippe deinen Text.'));
    return null;
  }

  // Timings are overridable so the resume logic can be tested quickly.
  const RESTART_DELAY_MS = Number.isFinite(opts.restartDelayMs) ? opts.restartDelayMs : 300;
  // If the engine fails and restarts in a tight loop, give up rather than spin.
  const RUNAWAY_WINDOW_MS = Number.isFinite(opts.runawayWindowMs) ? opts.runawayWindowMs : 4000;
  const RUNAWAY_LIMIT = Number.isFinite(opts.runawayLimit) ? opts.runawayLimit : 12;

  let finalText = String(opts.initialText || '');
  let stopped = false;
  let restartCount = 0;
  let restartTimer = null;
  let rec = null;
  let restartTimes = [];

  const build = () => {
    const r = new Ctor();
    r.lang = opts.lang || 'de-DE';
    r.continuous = true;
    r.interimResults = true;
    r.maxAlternatives = 1;

    r.onresult = (event) => {
      let interim = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const res = event.results[i];
        if (res.isFinal) finalText += `${res[0].transcript} `;
        else interim += res[0].transcript;
      }
      opts.onTranscript?.({ final: finalText.trim(), interim: interim.trim() });
    };

    r.onerror = (e) => {
      const code = e?.error || 'unknown';
      if (RECOVERABLE_STT.has(code)) return; // onend will resume
      if (FATAL_STT.has(code)) stopped = true;
      const msg = STT_MESSAGES[code] ?? `Spracherkennungsfehler: ${code}`;
      opts.onError?.(new Error(msg));
    };

    r.onend = () => {
      if (stopped) {
        opts.onEnd?.(finalText.trim());
        return;
      }
      // Resume. Chrome needs a moment after ending before start() is legal again.
      const now = Date.now();
      restartTimes = [...restartTimes.filter((t) => now - t < RUNAWAY_WINDOW_MS), now];
      if (restartTimes.length > RUNAWAY_LIMIT) {
        stopped = true;
        opts.onError?.(new Error('Die Spracherkennung bricht ständig ab. Bitte tippe deinen Text stattdessen.'));
        opts.onEnd?.(finalText.trim());
        return;
      }
      restartCount += 1;
      opts.onRestart?.(restartCount);
      restartTimer = setTimeout(() => {
        restartTimer = null;
        if (stopped) return;
        try {
          r.start();
        } catch {
          /* already running, or the engine refused: onend will fire again */
        }
      }, RESTART_DELAY_MS);
    };

    return r;
  };

  rec = build();
  try {
    rec.start();
  } catch (err) {
    opts.onError?.(err);
    return null;
  }

  return {
    /** Stop deliberately. onEnd fires once, with everything transcribed. */
    stop() {
      if (stopped) return finalText.trim();
      stopped = true;
      if (restartTimer) {
        clearTimeout(restartTimer);
        restartTimer = null;
      }
      try {
        rec.stop();
      } catch {
        /* not running */
      }
      opts.onEnd?.(finalText.trim());
      return finalText.trim();
    },
    get text() {
      return finalText.trim();
    },
    get restarts() {
      return restartCount;
    },
    get running() {
      return !stopped;
    },
  };
}

/** Rough words-per-minute estimate for speaking feedback. */
export function speakingRate(transcript, seconds) {
  const words = String(transcript || '').trim().split(/\s+/).filter(Boolean).length;
  if (!seconds) return null;
  return Math.round((words / seconds) * 60);
}

/* ------------------------------------------------------------ timer sound */

export function beep(kind = 'end') {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.frequency.value = kind === 'end' ? 660 : 440;
    gain.gain.setValueAtTime(0.0001, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.15, ctx.currentTime + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.5);
    osc.start();
    osc.stop(ctx.currentTime + 0.55);
    setTimeout(() => ctx.close(), 800);
  } catch {
    /* audio is a nicety, never a requirement */
  }
}

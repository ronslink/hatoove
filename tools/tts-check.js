/**
 * TTS diagnostic for B1 Prep.
 *
 * Headless Chrome has no audio stack and reports no speech voices, so this probe
 * runs a real browser parked off-screen. It answers four questions:
 *
 *   1. Which voices can the browser actually see?
 *   2. Is there a German one? Chrome ships "Google Deutsch" as a NETWORK voice,
 *      which never appears in the Windows SAPI registry - so checking Windows
 *      alone gives the wrong answer, and "install a voice" is usually bad advice.
 *   3. Does Chrome truncate long utterances? The classic bug cuts speech at ~15s,
 *      which would silently break a long Hoerverstehen script mid-text. Speech
 *      timing is linear in length plus a fixed network latency, so this fits a
 *      line through two samples and checks whether a third, longer one lands on it.
 *   4. Does the app's own listening player actually start audio?
 *
 * Usage: node tools/tts-check.js [baseUrl] [--audible]
 */

import { findBrowser, launchBrowser, connectToPage, sleep } from './cdp.js';

const argv = process.argv.slice(2);
const audible = argv.includes('--audible');
const BASE = argv.find((a) => a.startsWith('http')) || 'http://127.0.0.1:4321';
const PORT = 9225;

const SHORT_TEXT = 'Guten Tag. Wie geht es Ihnen?';
const MEDIUM_TEXT =
  'Ich arbeite seit drei Jahren in einem Pflegeheim in Leipzig. Früher war ich Verkäuferin, ' +
  'doch nach der Schließung des Geschäfts musste ich mich neu orientieren. Über eine Umschulung ' +
  'bin ich dann in die Pflege gekommen. Am Anfang war die Arbeit körperlich sehr anstrengend.';
const LONG_TEXT =
  `${MEDIUM_TEXT} Heute möchte ich nicht mehr wechseln, obwohl die Schichten lang sind. Besonders ` +
  'gefällt mir der Kontakt mit den Bewohnern. Die Bezahlung ist inzwischen besser geworden, aber ' +
  'noch nicht gut genug, finde ich. Mein Arbeitgeber bietet Fortbildungen an, die ich regelmäßig ' +
  'nutze. Für die Zukunft wünsche ich mir mehr Kolleginnen und Kollegen, denn der Personalmangel ' +
  'macht allen zu schaffen. Trotzdem empfehle ich den Beruf weiter.';

const median = (xs) => xs.slice().sort((a, b) => a - b)[Math.floor(xs.length / 2)];

async function main() {
  if (!findBrowser()) {
    console.error('No Chrome or Edge found.');
    process.exit(2);
  }

  console.log('\n=== B1 Prep TTS diagnostic ===');
  console.log(`Browser: real window, parked off-screen, audio ${audible ? 'ON' : 'muted'}\n`);

  const { cleanup } = await launchBrowser(PORT, {
    headless: false, // the speech engine only exists in a real window
    muteAudio: !audible,
    autoPlay: true,
    extraArgs: ['--window-position=-32000,-32000', '--window-size=1024,768'],
  });

  let cdp = null;
  let german = [];
  try {
    cdp = await connectToPage(PORT);
    await cdp.send('Page.navigate', { url: BASE });
    await cdp.waitFor(`!!document.querySelector('#view .card')`, 20000, 'app to load');

    // Chrome ignores speechSynthesis.speak() without user activation. Grant it the
    // same way the app does: a real click on the page.
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 500, y: 300, button: 'left', clickCount: 1 });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 500, y: 300, button: 'left', clickCount: 1 });
    await sleep(200);

    /* ------------------------------------------------ 1 + 2: voice inventory */
    const inv = await cdp.evaluate(`
      return new Promise((resolve) => {
        const out = { supported: 'speechSynthesis' in window, voices: [], german: [] };
        if (!out.supported) return resolve(out);
        let done = false;
        const finish = () => {
          if (done) return;
          done = true;
          const vs = speechSynthesis.getVoices() || [];
          out.voices = vs.map((v) => ({ name: v.name, lang: v.lang, local: !!v.localService, def: !!v.default }));
          out.german = out.voices.filter((v) => /^de/i.test(v.lang));
          resolve(out);
        };
        if ((speechSynthesis.getVoices() || []).length) finish();
        else {
          speechSynthesis.addEventListener('voiceschanged', finish, { once: true });
          setTimeout(finish, 5000);
        }
      });
    `);

    german = inv.german;
    console.log(`speechSynthesis available : ${inv.supported}`);
    console.log(`voices visible to Chrome : ${inv.voices.length}`);
    for (const v of inv.voices) {
      console.log(`   ${v.lang.padEnd(7)} ${v.name}${v.local ? '' : '  (network)'}${v.def ? '  [default]' : ''}`);
    }
    console.log('');
    console.log(`GERMAN VOICES FOUND      : ${german.length}${german.length ? ' -> ' + german.map((v) => v.name).join(', ') : ''}`);
    if (german.length && german.every((v) => !v.local)) {
      console.log('                           (network voice: needs an internet connection)');
    }

    /* ------------------------------------------------- 3: truncation check */
    console.log('\n--- synthesis timing ---');
    const speakProbe = (label, text) =>
      cdp.evaluate(`
        return new Promise((resolve) => {
          const text = ${JSON.stringify(text)};
          const voice = (speechSynthesis.getVoices() || []).find((v) => /^de/i.test(v.lang)) || null;
          const u = new SpeechSynthesisUtterance(text);
          u.lang = 'de-DE';
          if (voice) u.voice = voice;
          const t0 = performance.now();
          let started = false;
          let settled = false;
          const done = (extra) => {
            if (settled) return;
            settled = true;
            resolve({ label: ${JSON.stringify(label)}, chars: text.length, started, ms: Math.round(performance.now() - t0), ...extra });
          };
          u.onstart = () => { started = true; };
          u.onend = () => done({ ended: true });
          u.onerror = (e) => done({ ended: false, error: String(e.error || e) });
          setTimeout(() => done({ ended: false, timeout: true }), 50000);
          try { speechSynthesis.speak(u); } catch (err) { done({ ended: false, error: String(err) }); }
        });
      `);

    const samples = [['short', SHORT_TEXT], ['short2', SHORT_TEXT], ['medium', MEDIUM_TEXT], ['long', LONG_TEXT]];
    const timing = { speak: [] };
    for (const [label, text] of samples) {
      const r = await speakProbe(label, text).catch((e) => ({ label, chars: text.length, ended: false, error: e.message }));
      timing.speak.push(r);
      console.log(
        `   ${r.label.padEnd(7)} ${String(r.chars).padStart(4)} chars  started=${r.started}  ended=${r.ended}` +
        `${r.timeout ? '  (TIMED OUT)' : ''}${r.error ? '  error=' + r.error : ''}  ${r.ms} ms`
      );
      await sleep(250);
    }

    // Speech time = fixed network latency + rate * chars. Fit on the two shorter
    // samples, then check whether the longest one lands on that line.
    const shorts = timing.speak.filter((s) => s.label.startsWith('short') && s.ended).map((s) => s.ms);
    const medium = timing.speak.find((s) => s.label === 'medium' && s.ended);
    const long = timing.speak.find((s) => s.label === 'long' && s.ended);
    let truncation = null;
    if (shorts.length && medium && long) {
      const shortMs = median(shorts);
      const rate = (medium.ms - shortMs) / (medium.chars - SHORT_TEXT.length);
      const latency = shortMs - SHORT_TEXT.length * rate;
      const predicted = latency + long.chars * rate;
      const ratio = long.ms / predicted;
      console.log('');
      console.log(`   fitted speech rate ${rate.toFixed(1)} ms/char, fixed latency ~${Math.round(latency)} ms`);
      console.log(`   longest read took ${long.ms} ms; the line through the shorter samples predicts ${Math.round(predicted)} ms (ratio ${ratio.toFixed(2)})`);
      if (ratio < 0.8) {
        truncation = true;
        console.log('   >> TRUNCATED: Chrome cut the long utterance short.');
        console.log('      Long Hoerverstehen turns must be chunked into sentences before speaking.');
      } else {
        truncation = false;
        console.log('   >> No truncation: speech time scales linearly with length.');
      }
    } else {
      console.log('   (not enough completed samples to check for truncation)');
    }

    /* ------------------------------------- 4: the real listening section */
    console.log('\n--- listening section (real UI) ---');
    let ui = { reached: false, hasPlay: false, disabled: false, warning: false, started: false, status: '', lockedAfterOnePlay: false, secondPlayBlocked: false };
    try {
      ui = await cdp.evaluate(`
        return (async () => {
          const out = { reached: false, hasPlay: false, disabled: false, warning: false, started: false, status: '', lockedAfterOnePlay: false, secondPlayBlocked: false };
          document.querySelector('[data-view="listening"]')?.click();
          await new Promise((r) => setTimeout(r, 700));
          const partBtn = document.querySelector('[data-part="HV1"]');
          if (!partBtn) return out;
          partBtn.click();
          for (let i = 0; i < 80 && !document.querySelector('[data-play]'); i++) {
            await new Promise((r) => setTimeout(r, 250));
          }
          const play = document.querySelector('[data-play]');
          if (!play) return out;
          out.hasPlay = true;
          out.disabled = play.disabled;
          // Give the app time to finish its async German-voice check.
          await new Promise((r) => setTimeout(r, 1200));
          out.warning = !!document.querySelector('#tts-note .feedback');
          play.click();
          for (let i = 0; i < 40; i++) {
            const s = document.querySelector('#play-status')?.textContent || '';
            if (s.includes('Läuft')) { out.started = true; out.status = s.trim(); break; }
            await new Promise((r) => setTimeout(r, 250));
          }
          out.reached = true;
          document.querySelector('[data-stop]')?.click();
          // HV1 is played ONCE in the real exam, so after one run the player must
          // refuse a second - even though the learner stopped it early.
          for (let i = 0; i < 50; i++) {
            const label = document.querySelector('[data-play]')?.textContent || '';
            if (label.includes('Kein weiteres')) { out.lockedAfterOnePlay = true; break; }
            await new Promise((r) => setTimeout(r, 200));
          }
          const again = document.querySelector('[data-play]');
          out.secondPlayBlocked = !!again && again.disabled === true;
          return out;
        })();
      `);
    } catch (err) {
      console.log(`   probe failed: ${err.message}`);
    }
    console.log(`   listening part opened    : ${ui.reached}`);
    console.log(`   play button present      : ${ui.hasPlay} (disabled=${ui.disabled})`);
    console.log(`   German-voice warning     : ${ui.warning}`);
    console.log(`   playback actually began  : ${ui.started}${ui.status ? ` — status "${ui.status}"` : ''}`);
    console.log(`   play limit enforced      : ${ui.secondPlayBlocked}${ui.lockedAfterOnePlay ? ' (locked after the single allowed play, as in the real exam)' : ''}`);

    /* ------------------------------------------------------------ verdict */
    console.log('\n--- verdict ---');
    if (!inv.supported) {
      console.log('   speechSynthesis is unavailable. The app must fall back to transcripts.');
    } else if (!german.length) {
      console.log('   NO GERMAN VOICE. TTS would read German with an English voice — unusable for exam');
      console.log('   listening practice and actively harmful, because it teaches wrong pronunciation.');
    } else {
      console.log(`   German TTS works (${german[0].name}). Listening practice is usable.`);
      if (ui.started) console.log('   The Hoerverstehen player starts real audio from the app UI.');
      else if (ui.reached) console.log('   WARNING: the listening UI did not start playback — investigate.');
      if (ui.reached && !ui.secondPlayBlocked) console.log('   WARNING: the exam play limit is not being enforced.');
      if (truncation) console.log('   WARNING: long utterances are truncated; chunking is required.');
    }
    console.log('');
  } catch (err) {
    console.error('probe failed:', err.message);
  } finally {
    await cleanup();
    if (cdp) {
      try {
        cdp.ws.close();
      } catch {
        /* ignore */
      }
    }
    await sleep(200);
  }
  process.exit(german.length ? 0 : 1);
}

main();

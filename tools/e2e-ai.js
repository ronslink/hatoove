/**
 * End-to-end test for the AI path.
 *
 * Points the app at tools/mock-deepseek.js instead of the real DeepSeek API, then
 * checks that generated parts actually reach the UI, that grading renders, and that
 * a full mock exam survives the round trip.
 *
 * Usage:
 *   1. node tools/mock-deepseek.js            (terminal 1)
 *   2. DEEPSEEK_API_KEY=test DEEPSEEK_BASE_URL=http://127.0.0.1:4399 node server.js
 *   3. node tools/e2e-ai.js
 */

import { findBrowser, launchBrowser, connectToPage, makeRecorder, sleep } from './cdp.js';

const BASE = process.argv[2] || 'http://127.0.0.1:4321';
const MOCK = process.argv[3] || 'http://127.0.0.1:4399';
const PORT = 9223;

const { record, summary } = makeRecorder();

async function main() {
  if (!findBrowser()) {
    console.error('No Chrome/Edge found. Skipping AI browser test.');
    process.exit(2);
  }

  const health = await fetch(`${BASE}/api/health`).then((r) => r.json()).catch(() => null);
  if (!health) {
    console.error(`Server not reachable at ${BASE}. Start it first.`);
    process.exit(2);
  }
  if (!health.configured) {
    console.error('Server is not configured with an API key. Start it with DEEPSEEK_API_KEY set.');
    process.exit(2);
  }
  record('server reports an AI key is configured', true, `model=${health.model}, base=${health.baseUrl}`);

  const mockUp = await fetch(`${MOCK}/stats`).then((r) => r.json()).catch(() => null);
  record('mock DeepSeek server is reachable', Boolean(mockUp));

  const { cleanup } = await launchBrowser(PORT);
  let cdp = null;
  try {
    cdp = await connectToPage(PORT);
    await cdp.send('Page.navigate', { url: BASE });
    await cdp.waitFor(`!!document.querySelector('#view .card')`, 15000, 'dashboard');

    /* ------------------------------------------- the app sees the key */
    const offlineBanner = await cdp.evaluate(`return document.body.innerText.includes('Offline-Modus')`);
    record('dashboard does not show the offline banner when a key is set', offlineBanner === false);

    /* ------------------------------------------- AI-generated paper part */
    await cdp.click('[data-view="paper"]');
    await cdp.waitFor(`document.querySelectorAll('[data-part]').length >= 8`, 10000, 'paper index');
    await cdp.click('[data-part="LV1"]');
    await cdp.waitFor(`!!document.querySelector('.headline')`, 25000, 'AI LV1 set');

    const lv1Text = await cdp.text();
    record('AI-generated LV1 renders', lv1Text.includes('MOCK Leseverstehen Teil 1'));
    record('AI-generated content is labelled as such', lv1Text.includes('KI-generiert'));
    record('LV1 keeps the exam layout (10 headlines, 5 selects)',
      (await cdp.evaluate(`return document.querySelectorAll('.headline').length`)) === 10 &&
      (await cdp.evaluate(`return document.querySelectorAll('select[data-item]').length`)) === 5);

    /* ------------------------------------------- AI drill cards */
    await cdp.click('[data-view="drill"]');
    await cdp.waitFor(`!!document.querySelector('.drill-prompt')`, 12000, 'drill');
    await cdp.click('#options .option');
    await cdp.waitFor(`!!document.querySelector('[data-next]')`, 8000, 'feedback');
    await cdp.click('[data-next]');
    let aiCard = false;
    try {
      await cdp.waitFor(`document.body.innerText.includes('KI-generiert')`, 8000, 'AI-generated drill card');
      aiCard = true;
    } catch {
      aiCard = false;
    }
    record('the drill upgrades cards with fresh AI questions', aiCard === true);

    /* ------------------------------------------- writing correction */
    await cdp.evaluate(`return import('/js/store.js').then(s => {s.getState().settings.writingTaskIndex = 0; s.saveNow(); return true;})`);
    await cdp.click('[data-view="writing"]');
    await cdp.waitFor(`!!document.querySelector('#writing-text')`, 25000, 'writing view');
    const writingTaskText = await cdp.text();
    record('AI writing task reaches the view', writingTaskText.includes('Deutschkurs') || writingTaskText.includes('Aufgabe'));
    record('AI rotation starts with an informal task', writingTaskText.includes('informell · du') && writingTaskText.includes('KI-generiert'));
    record('informal AI task has four guiding points', (await cdp.evaluate(`return document.querySelectorAll('.card ol li').length`)) === 4);
    record('informal AI task offers a personal salutation', (await cdp.evaluate(`return document.querySelector('#writing-text').placeholder`)).startsWith('Liebe/r'));
    await cdp.click('[data-new-task]');
    await cdp.waitFor(`!!document.querySelector('#writing-text') && document.querySelector('#view').textContent.includes('halbformell · Sie')`, 25000, 'semi-formal writing task');
    record('next AI task alternates to Sie', (await cdp.text()).includes('KI-generiert'));

    await cdp.evaluate(`
      const t = document.querySelector('#writing-text');
      t.value = 'Sehr geehrte Frau Berger, ich möchte mich herzlich für den Kurs bedanken, weil er mir sehr geholfen hat. Leider konnte ich an den letzten beiden Terminen nicht teilnehmen, denn ich war krank. Deshalb möchte ich Sie fragen, ob ich die Unterlagen noch bekommen könnte. Außerdem würde ich gern wissen, wann der nächste Kurs beginnt. Über eine kurze Antwort würde ich mich sehr freuen. Mit freundlichen Grüßen Sara';
      t.dispatchEvent(new Event('input'));
      return true;
    `);
    await cdp.click('[data-grade]');
    await cdp.waitFor(`document.body.innerText.includes('Aufgabenbewältigung')`, 25000, 'AI grading');

    const graded = await cdp.text();
    record('AI grading returns all four telc criteria', graded.includes('Aufgabenbewältigung') && graded.includes('Formale Richtigkeit'));
    record('AI grading reports a score out of 45', graded.includes('34') && graded.includes('/ 45'));
    record('AI grading lists concrete corrections', graded.includes('Korrigieren') || graded.includes('Ich habe gefehlt'));
    record('AI grading offers a model answer', graded.includes('Musterbrief'));
    record('writing score feeds the weakness model', graded.includes('befriedigend'));

    /* ------------------------------------------- speaking feedback */
    await cdp.click('[data-view="speaking"]');
    await cdp.waitFor(`!!document.querySelector('[data-grade-speak]')`, 25000, 'speaking view');
    await cdp.evaluate(`
      const t = document.querySelector('#spoken-text');
      t.value = 'Ich möchte Ihnen meine Heimatstadt vorstellen. Sie liegt im Süden und hat etwa zweihunderttausend Einwohner. Besonders bekannt ist der alte Marktplatz. Ein Vorteil ist, dass alles gut zu Fuß erreichbar ist. Andererseits gibt es wenig Arbeitsplätze. Zusammenfassend kann man sagen, dass ich gern dort lebe.';
      t.dispatchEvent(new Event('input'));
      return true;
    `);
    await cdp.click('[data-grade-speak]');
    // Headings are styled uppercase and innerText reflects that, so compare
    // case-insensitively. Stop early and capture the reason if it fails loudly.
    let speakOk = false;
    let speakDiag = '';
    const deadline = Date.now() + 25000;
    while (Date.now() < deadline) {
      const t = (await cdp.text()).toLowerCase();
      if (t.includes('so klingt es besser') || t.includes('nächste schritte')) {
        speakOk = true;
        break;
      }
      if (t.includes('feedback fehlgeschlagen') || t.includes('kein ki-feedback')) {
        speakDiag = (await cdp.evaluate(`return document.querySelector('#s-result')?.innerText || 'no #s-result'`))
          .replace(/\s+/g, ' ')
          .slice(0, 300);
        break;
      }
      await sleep(250);
    }
    record('speaking feedback renders', speakOk, speakDiag);

    const spoken = (await cdp.text()).toLowerCase();
    record('speaking feedback returns a score out of 25', spoken.includes('/ 25'));
    record('speaking feedback rewrites weak phrases', spoken.includes('so klingt es besser'));
    record('speaking feedback admits pronunciation is not judgeable', spoken.includes('nicht beurteilbar') || spoken.includes('aussprache'));

    /* ------------------------------------------- full mock exam */
    await cdp.click('[data-view="mock"]');
    await cdp.waitFor(`!!document.querySelector('[data-start-mock]')`, 12000, 'mock intro');
    await cdp.click('[data-start-mock]');

    await cdp.waitFor(`document.querySelector('#view h2')?.textContent.includes('Leseverstehen')`, 60000, 'mock block 1');
    const block1 = await cdp.evaluate(`return document.querySelector('#view h2').textContent`);
    record('mock block 1 renders all five reading/language parts', block1.includes('Leseverstehen'));

    const mockParts = await cdp.evaluate(`return document.querySelectorAll('[data-mock-part]').length`);
    record('mock block 1 contains five parts', mockParts === 5, `parts=${mockParts}`);

    // The per-block exam countdown had never been exercised.
    const mockTimerBefore = await cdp.evaluate(`return document.querySelector('#mock-timer')?.textContent || ''`);
    await cdp.click('[data-toggle-mock]');
    await sleep(2300);
    const mockTimerAfter = await cdp.evaluate(`return document.querySelector('#mock-timer')?.textContent || ''`);
    await cdp.click('[data-toggle-mock]');
    record(
      'mock exam runs the per-block countdown (90 min for reading + language)',
      mockTimerBefore === '90:00' && mockTimerAfter !== mockTimerBefore,
      `${mockTimerBefore} -> ${mockTimerAfter}`
    );

    // answer a couple of items so the scorecard is not empty
    await cdp.evaluate(`
      const sel = document.querySelector('select[data-item]');
      if (sel) { sel.value = sel.options[1]?.value || ''; sel.dispatchEvent(new Event('change')); }
      const btn = document.querySelector('[data-q]');
      if (btn) btn.click();
      const tf = document.querySelector('[data-tfval="true"]');
      if (tf) tf.click();
      return true;
    `);
    await cdp.click('[data-end-block]');

    await cdp.waitFor(`document.querySelector('#view h2')?.textContent.includes('Hörverstehen')`, 30000, 'mock block 2');
    record('mock advances to the listening block', true);
    await cdp.click('[data-end-block]');

    await cdp.waitFor(`document.querySelector('#view h2')?.textContent.includes('Schreiben')`, 30000, 'mock block 3');
    record('mock advances to the writing block', true);

    await cdp.evaluate(`
      const t = document.querySelector('#mock-writing');
      t.value = 'Sehr geehrte Frau Berger, ich möchte mich herzlich für den Kurs bedanken, weil er mir sehr geholfen hat. Leider konnte ich an den letzten beiden Terminen nicht teilnehmen, denn ich war krank. Deshalb möchte ich Sie fragen, ob ich die Unterlagen noch bekommen könnte. Mit freundlichen Grüßen Sara';
      t.dispatchEvent(new Event('input'));
      return true;
    `);
    await cdp.click('[data-end-block]');

    await cdp.waitFor(`document.body.innerText.includes('Mocktest-Ergebnis')`, 40000, 'mock result');
    // statCard labels render uppercase, so compare case-insensitively.
    const result = (await cdp.text()).toLowerCase();
    record('mock reports a total out of 225', result.includes('/ 225'));
    record('mock reports pass/fail against 135 points', result.includes('bestanden') && (result.includes('ja') || result.includes('nein')));
    record('mock lists per-part points', result.includes('leseverstehen') && result.includes('sprachbausteine'));
    record('mock grades the writing with the rubric', result.includes('schreiben im detail') && result.includes('/ 45'));

    const mockAfter = await fetch(`${MOCK}/stats`).then((r) => r.json());
    record('mock exam issued many AI generation calls', mockAfter.calls >= 9, `calls=${mockAfter.calls}`);

    /* ------------------------------------------- resilience */
    const health2 = await fetch(`${BASE}/api/health`).then((r) => r.json());
    record('server stayed healthy throughout', health2.ok === true);

    const errors = cdp.consoleErrors();
    record('no console errors during the AI flow', errors.length === 0, errors.slice(0, 3).join(' | '));
  } catch (err) {
    record('AI test run completed without a harness error', false, err.message);
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

  process.exit(summary() ? 1 : 0);
}

main();

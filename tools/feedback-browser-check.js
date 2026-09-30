/** Speaking feedback regressions against an isolated offline app; no paid calls or saved learner data. */
import assert from 'node:assert/strict';
import { launchBrowser, connectToPage, makeRecorder } from './cdp.js';

const BASE = process.argv[2] || 'http://127.0.0.1:4329';
const target = new URL(BASE);
if (!['127.0.0.1', 'localhost'].includes(target.hostname) || target.protocol !== 'http:'
  || !target.port || ['4321', '4381'].includes(target.port)) {
  throw new Error('Use a separate local test server, never the main or portable app ports.');
}
const { record, summary } = makeRecorder();
const transcript = 'Ich möchte Ihnen meine Heimatstadt vorstellen. Sie liegt im Süden und hat etwa zweihunderttausend Einwohner. Besonders bekannt ist der alte Marktplatz. Ein Vorteil ist, dass alles gut zu Fuß erreichbar ist. Andererseits gibt es wenig Arbeitsplätze. Zusammenfassend kann man sagen, dass ich gern dort lebe.';
const grade = {
  points: 19, band: 'gut',
  criteria: ['struktur', 'wortschatz', 'fluessigkeit', 'interaktion', 'aussprache'].map((key) => ({
    key, score: key === 'aussprache' ? null : 76,
    comment: key === 'aussprache' ? 'Aus Transkript nicht beurteilbar.' : 'Klar und verständlich.',
  })),
  corrections: [{ original: 'wenig Arbeitsplätze', corrected: 'wenige Arbeitsplätze', explanation: 'Pluralendung beachten.' }],
  betterPhrases: [{ said: 'Sie liegt im Süden.', better: 'Meine Heimatstadt liegt im Süden Deutschlands.' }],
  strengths: ['Browser regression fixture: complete feedback.'], priorities: ['Weiter frei sprechen.'],
};
const good = { content: JSON.stringify(grade), finishReason: 'stop' };
const malformed = { content: '{"criteria":[{"key":"struktur","score":0-100', finishReason: 'stop' };
const truncated = { content: JSON.stringify(grade), finishReason: 'length' };

// Install before app startup: all API traffic is synthetic, including progress reads/writes.
const interceptor = `(() => {
  const originalFetch = window.fetch.bind(window);
  const fixture = window.__feedbackCheck = { configured: false, queue: [], requests: [], pending: [], unexpected: [], progressWrites: 0 };
  const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
  window.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url, location.href);
    if (url.origin !== location.origin) throw new Error('External network disabled by feedback test');
    if (url.pathname === '/api/config') return json({ configured: fixture.configured, model: 'mock-feedback', keyMasked: '', examDate: '' });
    if (url.pathname === '/api/progress') {
      if ((init.method || 'GET') !== 'GET') fixture.progressWrites++;
      return json({ ok: true, found: false });
    }
    if (url.pathname === '/api/ai') {
      const request = JSON.parse(init.body);
      fixture.requests.push(request);
      if (!request.messages?.some(message => message.content.includes('Bewerte diese mündliche Leistung'))) {
        fixture.unexpected.push('Unexpected AI request');
        return json({ ok: false, error: 'Only grading is allowed in this fixture', code: 'FIXTURE_ERROR' }, 400);
      }
      const next = fixture.queue.shift();
      if (!next) {
        fixture.unexpected.push('Unscripted AI request');
        return json({ ok: false, error: 'No scripted answer', code: 'FIXTURE_ERROR' }, 400);
      }
      if (next.hold) await new Promise(resolve => fixture.pending.push(resolve));
      return json({ ok: true, content: next.content, finishReason: next.finishReason });
    }
    if (url.pathname.startsWith('/api/')) {
      fixture.unexpected.push(url.pathname);
      return json({ ok: false, error: 'Unexpected API request' }, 400);
    }
    return originalFetch(input, init);
  };
})();`;

async function main() {
  const health = await fetch(`${target.origin}/api/health`).then(response => response.json());
  assert.equal(health.configured, false, 'Test server must be offline and have no configured API key');
  const { cleanup } = await launchBrowser(9234);
  let cdp;
  try {
    cdp = await connectToPage(9234);
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: interceptor });
    await cdp.send('Page.navigate', { url: target.origin });
    await cdp.waitFor(`!!document.querySelector('#view .card')`, 15000, 'dashboard');
    await cdp.click('[data-view="speaking"]');
    await cdp.waitFor(`!!document.querySelector('[data-grade-speak]')`, 10000, 'offline speaking task');

    const history = () => cdp.evaluate(`return import('/js/store.js').then(store => ({ history: store.getState().history.length, errors: store.getState().errors.length, attempts: store.getState().counters.attempts }))`);
    const configured = (value) => cdp.evaluate(`window.__feedbackCheck.configured = ${value}; return import('/js/ai.js').then(ai => ai.refreshStatus()).then(() => true)`);
    const queue = (responses) => cdp.evaluate(`window.__feedbackCheck.queue = ${JSON.stringify(responses)}; return window.__feedbackCheck.requests.length`);
    const fill = () => cdp.evaluate(`document.querySelector('#spoken-text').value = ${JSON.stringify(transcript)}; return true`);
    const release = () => cdp.evaluate(`window.__feedbackCheck.pending.shift()(); return true`);
    const done = () => cdp.waitFor(`!document.querySelector('[data-grade-speak]').disabled`, 10000, 'feedback completion');
    const requestCount = () => cdp.evaluate(`return window.__feedbackCheck.requests.length`);
    const result = () => cdp.evaluate(`return document.querySelector('#s-result')?.textContent || ''`);
    await configured(true);
    await fill();
    const initial = await history();
    assert.deepEqual(initial, { history: 0, errors: 0, attempts: 0 });

    let before = await queue([{ ...malformed, hold: true }, malformed]);
    await cdp.evaluate(`const button = document.querySelector('[data-grade-speak]'); button.click(); button.dispatchEvent(new MouseEvent('click', { bubbles: true })); return true`);
    await cdp.waitFor(`window.__feedbackCheck.pending.length === 1`, 5000, 'held feedback request');
    record('duplicate click sends one request and disables feedback',
      await requestCount() === before + 1 && await cdp.evaluate(`return document.querySelector('[data-grade-speak]').disabled`));
    await release();
    await done();
    record('two invalid JSON replies stop after one automatic retry', await requestCount() === before + 2 && (await result()).includes('Feedback fehlgeschlagen'));
    record('failed feedback preserves transcript and learner history',
      await cdp.evaluate(`return document.querySelector('#spoken-text').value === ${JSON.stringify(transcript)}`)
      && JSON.stringify(await history()) === JSON.stringify(initial));

    before = await queue([good]);
    await cdp.click('[data-grade-speak]');
    await done();
    let progress = await history();
    record('manual retry renders all criteria and records only valid feedback',
      await requestCount() === before + 1 && (await result()).includes('/ 25')
      && await cdp.evaluate(`return document.querySelectorAll('#s-result tbody tr').length === 5`)
      && progress.history === 4 && progress.errors === 1 && progress.attempts === 4);

    for (const [label, broken] of [['malformed JSON', malformed], ['truncated completion', truncated]]) {
      before = await queue([broken, good]);
      const prior = await history();
      await cdp.click('[data-grade-speak]');
      await done();
      const after = await history();
      record(`${label} automatically recovers with one complete assessment`,
        await requestCount() === before + 2 && (await result()).includes('/ 25')
        && after.history === prior.history + 4 && after.attempts === prior.attempts + 4
        && after.errors === prior.errors); // The same correction is deduplicated in the notebook.
    }

    progress = await history();
    await queue([{ ...good, hold: true }]);
    await cdp.click('[data-grade-speak]');
    await cdp.waitFor(`window.__feedbackCheck.pending.length === 1`, 5000, 'request before changing task');
    await cdp.evaluate(`window.__feedbackCheck.oldButton = document.querySelector('[data-grade-speak]'); return true`);
    await configured(false);
    await cdp.click('[data-sp="SP2"]');
    await cdp.waitFor(`!!document.querySelector('#spoken-text') && document.querySelector('#spoken-text').value === ''`, 10000, 'new offline task');
    const newView = await cdp.evaluate(`return document.querySelector('#view').innerHTML`);
    await release();
    await cdp.waitFor(`window.__feedbackCheck.oldButton.disabled === false`, 10000, 'stale success cleanup');
    record('late success cannot change the new task or learner history',
      (await cdp.evaluate(`return document.querySelector('#view').innerHTML`)) === newView
      && JSON.stringify(await history()) === JSON.stringify(progress));

    await configured(true);
    await fill();
    before = await queue([{ ...malformed, hold: true }, malformed]);
    await cdp.click('[data-grade-speak]');
    await cdp.waitFor(`window.__feedbackCheck.pending.length === 1`, 5000, 'request before navigation');
    await cdp.evaluate(`window.__feedbackCheck.oldButton = document.querySelector('[data-grade-speak]'); return true`);
    await cdp.click('[data-view="home"]');
    await cdp.waitFor(`!document.querySelector('#spoken-text')`, 10000, 'dashboard navigation');
    const dashboard = await cdp.evaluate(`return document.querySelector('#view').innerHTML`);
    await release();
    await cdp.waitFor(`window.__feedbackCheck.oldButton.disabled === false`, 10000, 'stale error cleanup');
    record('late failure cannot replace another view or alter learner history',
      await requestCount() === before + 2
      && (await cdp.evaluate(`return document.querySelector('#view').innerHTML`)) === dashboard
      && JSON.stringify(await history()) === JSON.stringify(progress));
    record('every AI request was scripted and browser had no unhandled errors',
      await cdp.evaluate(`return window.__feedbackCheck.unexpected.length === 0 && window.__feedbackCheck.queue.length === 0`)
      && cdp.consoleErrors().length === 0, cdp.consoleErrors().join('; '));
    return summary();
  } finally {
    cdp?.ws.close();
    await cleanup();
  }
}

main().then(failed => process.exit(failed ? 1 : 0)).catch(error => {
  console.error(error.stack || error);
  process.exit(1);
});

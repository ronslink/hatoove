#!/usr/bin/env node
/**
 * MOCK-01 focused check — the Probeprüfung intro page (MIRROR-B1PREP-01 slice D).
 *
 * Offline, deterministic, dependency-free: no server, no database, no browser, no network, no `.env`.
 * It imports the real module, renders its real markup into a stub host, and drives the real click handler
 * with a stubbed api client, so the assertions are about observable output and the exact request the module
 * issues — not about how the module is written.
 *
 * WHAT IT PINS, AND WHY EACH ONE MATTERS
 *  1. Interface      `createMockIntroView(ctx)` returns `{ mount(host), unmount() }` (§4.2, frozen).
 *  2. Blocks         three block rows with their official minutes, and the written total: 90/30/30 →
 *                    150 minutes, 105/75/45 → 225 points. A silent change here is a false exam statement.
 *  3. Total points   225 of 300 written, 75 oral, present as text.
 *  4. Pass rule      the official 60 % rule is present as a FACT.
 *  5. Oral note      Sprechen is named as not part of it (it is out of the pilot).
 *  6. One start      exactly ONE start control (`data-mock-intro-start`); the history rows never start a run.
 *  7. Unchanged run  the click issues today's request and nothing else: `api.mock.forms()` (GET) then
 *                    `api.mock.start({formId, formVersion, releaseVersion, eventId})`, then navigates to
 *                    `#/lauf/<id>`. A UUID-shaped eventId is required by `server/mock-contract.mjs`.
 *  8. Idempotency    a retry after an unanswered start reuses the SAME eventId (no second run).
 *  9. Failure        a refused start shows a message, navigates nowhere, and never reuses a lost answer.
 * 10. History        the saved runs come from `api.mock.list()` and are labelled with the exported
 *                    `mockScopeLabel`/`mockReviewLabel` helpers of `mock.js`; finished vs still open and the
 *                    withdrawn-review notice are all visible.
 * 11. Empty/failed   no runs → "no saved runs"; a refused list → the history error, not an empty list.
 * 12. Degradation    no complete form → the documented unavailable notice and NO start control; an archived
 *                    preparation → the archived notice and NO start control; a missing api never throws.
 * 13. D22           the rendered text of ALL FIVE locales contains no prediction, forecast, probability or
 *                    readiness vocabulary. A "chance of passing" sentence fails this leg.
 * 14. Five locales  every locale renders the blocks, the rule and the oral note (no untranslated key).
 * 15. RTL           the Arabic render is `dir="rtl"` while the German run title stays an LTR island.
 * 16. Register      the German render uses the formal address (the i18n register gate covers the catalogue;
 *                    this covers what the page actually renders).
 * 17. Module CSS    tokens only: every `var(--x)` is defined by the pinned system or the shell, no rule
 *                    hard-codes a colour or a font family, and the module's 420 px narrow-phone step only
 *                    styles this module instead of becoming a second layout opinion for the shell.
 *
 * MUTATION PROOF. `--module=<path>` loads the module under test from another file, so a mutated copy in
 * `%TEMP%` can be run through the same legs (the copy must sit in a directory tree with the same relative
 * layout, because the module imports its catalogue by relative path):
 *
 *   Copy-Item -Recurse public $env:TEMP\mock-intro-mutation\
 *   # edit $env:TEMP\mock-intro-mutation\public\app\mock-intro.js
 *   node tools/mock-intro-check.mjs --module=$env:TEMP\mock-intro-mutation\public\app\mock-intro.js
 *
 * Usage: node tools/mock-intro-check.mjs [--module=<file>] [--css=<file>]
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = new URL('../', import.meta.url);
const target = name => {
  const flag = process.argv.find(value => value.startsWith('--' + name + '='));
  const fromEnv = process.env['MOCK_INTRO_' + name.toUpperCase()];
  const value = flag ? flag.slice(name.length + 3) : fromEnv;
  return value ? path.resolve(value) : fileURLToPath(new URL('public/app/mock-intro.' + (name === 'module' ? 'js' : 'css'), root));
};
const MODULE_PATH = target('module');
const CSS_PATH = target('css');
/*
 * The locale runtime is resolved FROM THE MODULE UNDER TEST, not from this check. A mutated module copied
 * to another tree imports its own copy of the catalogue and the runtime, so driving `setLocale` on the
 * repository's instance would leave the copy rendering in the browser-inferred locale and bury the real
 * mutation in noise.
 */
const moduleUrl = pathToFileURL(MODULE_PATH);
const { setLocale, getLocale } = await import(new URL('../assets/i18n/core.js', moduleUrl).href);
const view = await import(moduleUrl.href);

const LOCALES = ['de', 'en', 'uk', 'ar', 'tr'];
let failed = 0;
let passed = 0;
const results = [];
function leg(name, fn) {
  try {
    fn();
    passed++;
    results.push({ name, ok: true });
    console.log('PASS  ' + name);
  } catch (error) {
    failed++;
    results.push({ name, ok: false, detail: error.message });
    console.log('FAIL  ' + name + '  [' + String(error.message).slice(0, 220) + ']');
  }
}
async function asyncLeg(name, fn) {
  try {
    await fn();
    passed++;
    results.push({ name, ok: true });
    console.log('PASS  ' + name);
  } catch (error) {
    failed++;
    results.push({ name, ok: false, detail: error.message });
    console.log('FAIL  ' + name + '  [' + String(error.message).slice(0, 220) + ']');
  }
}

/* ------------------------------------------------------------------ helpers */

const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const decode = value => String(value).replace(/&(amp|lt|gt|quot|#39|nbsp|hellip|mdash|ndash|bdquo|ldquo|rdquo|szlig);/g,
  (_, key) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", nbsp: ' ', hellip: '…', mdash: '—', ndash: '–', bdquo: '„', ldquo: '“', rdquo: '”', szlig: 'ß' }[key]));
const textOf = markup => decode(String(markup).replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
const UI = { m006: 'Gespeicherte Prüfungsläufe' };
const uiText = (key, parameters = {}) => String(UI[key] ?? key).replace(/\{([a-zA-Z][a-zA-Z0-9_]*)\}/g, (_, name) => String(parameters[name] ?? ''));
const count = (markup, needle) => markup.split(needle).length - 1;
const row = (markup, id) => {
  const match = new RegExp('<tr data-mock-intro-block="' + id + '"[\\s\\S]*?</tr>').exec(markup);
  return match ? match[0] : '';
};

const PREDICTION = [
  // German
  'prognose', 'prognosen', 'prognostiziert', 'vorhersage', 'vorhersagen', 'voraussage', 'hochrechnung',
  'wahrscheinlich', 'wahrscheinlichkeit', 'wahrscheinlichkeiten', 'chance', 'chancen', 'schätzung',
  'schätzungen', 'geschätzt', 'schätzwert', 'trefferquote', 'erfolgsquote', 'durchfallquote',
  'bestehenswahrscheinlichkeit', 'bestehschance', 'erfolgsaussicht', 'erfolgsaussichten',
  'bestehensaussicht', 'bestehensaussichten', 'aussicht', 'aussichten', 'prozentchance',
  // English
  'readiness', 'forecast', 'forecasts', 'predict', 'predicts', 'predicted', 'prediction', 'predictions',
  'predictive', 'probability', 'probabilities', 'likelihood', 'odds', 'estimate', 'estimates', 'estimated',
  'prognosis', 'chance of passing', 'likely to pass', 'on track to pass', 'pass probability',
  // Ukrainian
  'прогноз', 'прогнози', 'ймовірність', 'ймовірно', 'шанс', 'шанси',
  // Turkish
  'tahmin', 'tahminler', 'olasılık', 'şans', 'hazırlık düzeyi', 'hazırlık puanı',
  // Arabic
  'توقع', 'توقعات', 'احتمال', 'احتمالات', 'جاهزية', 'ترجيح',
];
const predictionPattern = new RegExp('(?<![\\p{L}\\p{N}])(?:' + PREDICTION.join('|') + ')(?![\\p{L}\\p{N}])', 'iu');
const INFORMAL = /(?<![\p{L}\p{N}])(du|dich|dir|dein|deine|deinem|deinen|deiner|deines|kannst|musst|willst|hast|bist|wirst|weißt|weisst|siehst|sollst|darfst|möchtest|wähle|waehle|trage|prüfe|pruefe|speichere|verwende|versuche|melde|beginne|schließe|schliesse|höre|hoere|lade|lies|fordere|fülle|fuelle|lass|laß|aktiviere|gib|nutze|warte|nimm|lege|stelle|achte|öffne|oeffne|klicke|rufe|sende|schau|bleib|geh|komm|mach|brauch|zeig|sag|denk|merk|wende|besuche|probiere)(?![\p{L}\p{N}])/iu;

function stubApi({ forms = { ok: true, status: 200, data: { forms: [completeForm()] } }, runs = { ok: true, status: 200, data: { runs: [] } }, startResult } = {}) {
  const calls = [];
  let startCalls = 0;
  return {
    calls,
    mock: {
      forms: async () => { calls.push({ method: 'forms' }); return forms; },
      list: async () => { calls.push({ method: 'list' }); return runs; },
      start: async body => {
        calls.push({ method: 'start', body });
        startCalls++;
        return typeof startResult === 'function' ? startResult(startCalls, body) : (startResult ?? { ok: true, status: 201, data: { id: 'run-final' } });
      },
    },
  };
}
const completeForm = (over = {}) => ({
  form_id: 'telc-complete', version: 'v3', release_version: 'v2', scope: 'complete_supported_written',
  title: 'Schriftliche Prüfung · Technologiesimulation', item_count: 61, mode: 'timed', time_limit_seconds: 9000, ...over,
});
const sectionForm = over => ({ form_id: 'lv-section', version: 'v1', release_version: 'v1', scope: 'section_practice', title: 'Leseverstehen', item_count: 5, mode: 'timed', ...over });
const finishedRun = (over = {}) => ({
  id: '11111111-2222-4333-8444-555555555555', exam_id: 'telc-deutsch-b1', title: 'Schriftliche Prüfung',
  form_version: 'v3', state: 'finalised', scope: 'complete_supported_written', release_state: 'internal',
  review_status: 'generated', review_basis: null, review_withdrawn: false, created_at: '2026-10-05T09:00:00.000Z',
  updated_at: '2026-10-05T11:30:00.000Z', ...over,
});
const openRun = (over = {}) => finishedRun({ id: '99999999-8888-4777-8666-555555555555', state: 'active', updated_at: '2026-10-05T10:00:00.000Z', ...over });

class StubNode {
  constructor() { this.textContent = ''; this.dataset = {}; this.disabled = false; this.hidden = false; this.attrs = {}; }
  setAttribute(key, value) { this.attrs[key] = String(value); }
}
class StubHost {
  constructor() { this.innerHTML = ''; this.onclick = null; this.nodes = new Map(); }
  querySelector(selector) {
    if (selector === '[data-mock-intro-start]') {
      if (!this.innerHTML.includes('data-mock-intro-start=')) return null;
      if (!this.startNode) this.startNode = new StubNode();
      return this.startNode;
    }
    if (!this.nodes.has(selector)) this.nodes.set(selector, new StubNode());
    return this.nodes.get(selector);
  }
}
const clickTarget = selectorName => ({ target: { closest: selector => (selector === selectorName ? { disabled: false } : null) } });
function renderModel(model) {
  return view.introMarkup({ esc, uiText, examLanguage: 'de', model });
}

/* -------------------------------------------------------------------- 1-6 */

leg('1 interface: createMockIntroView(ctx) returns { mount, unmount }', () => {
  assert.equal(typeof view.createMockIntroView, 'function', 'createMockIntroView must be exported');
  const instance = view.createMockIntroView({});
  assert.equal(typeof instance.mount, 'function');
  assert.equal(typeof instance.unmount, 'function');
  assert.deepEqual(Object.keys(instance).sort(), ['mount', 'unmount']);
});

setLocale('de');
const page = renderModel({ form: completeForm(), runs: [finishedRun()], startPhase: 'idle' });

leg('2 blocks: three rows, official minutes and points, and the written total', () => {
  const text = textOf(page);
  for (const [id, label, minutes, points] of [['written', 'Leseverstehen + Sprachbausteine', 90, 105], ['listening', 'Hörverstehen', 30, 75], ['writing', 'Schreiben', 30, 45]]) {
    const body = row(page, id);
    assert.ok(body, 'no block row for ' + id);
    assert.match(body, new RegExp('data-minutes="' + minutes + '"'), id + ' row minutes attribute');
    assert.match(body, new RegExp('data-points="' + points + '"'), id + ' row points attribute');
    assert.equal(textOf(body), label + ' ' + minutes + ' Minuten ' + points, id + ' row text');
  }
  assert.match(row(page, 'total'), /data-minutes="150"/);
  assert.match(row(page, 'total'), /data-points="225"/);
  assert.ok(text.includes('Schriftliche Prüfung 150 Minuten 225'), 'written total row in the rendered text');
  assert.equal(count(page, '<tr data-mock-intro-block='), 4, 'three block rows plus the written total row');
});

leg('3 total points: 225 of 300 written, 75 oral, and read aloud as text', () => {
  const note = /<p class="small muted" data-mock-intro-total-note>([\s\S]*?)<\/p>/.exec(page);
  assert.ok(note, 'the total-points note is missing');
  const text = textOf(note[1]);
  for (const fragment of ['225', '300', '75']) assert.ok(text.includes(fragment), 'total note omits ' + fragment + ': ' + text);
});

leg('4 pass rule: the official 60 % threshold is present as a fact', () => {
  const rule = /<p data-mock-intro-rule>([\s\S]*?)<\/p>/.exec(page);
  assert.ok(rule, 'the official rule paragraph is missing');
  const text = textOf(rule[1]);
  for (const fragment of ['60 %', '135', '225', '45', '75']) assert.ok(text.includes(fragment), 'rule omits ' + fragment + ': ' + text);
  const heading = /<h2 id="mock-intro-rule-title">([\s\S]*?)<\/h2>/.exec(page);
  assert.equal(textOf(heading?.[1] ?? ''), 'Offizielle Regel');
});

leg('5 oral note: Sprechen is named as not part of this mock', () => {
  const oral = /<p data-mock-intro-oral>([\s\S]*?)<\/p>/.exec(page);
  assert.ok(oral, 'the oral-exam note is missing');
  const text = textOf(oral[1]);
  assert.ok(text.includes('Sprechen'), 'the note must name Sprechen: ' + text);
  assert.match(text, /nicht Teil/);
});

leg('6 exactly one start control, and the history rows are links not starters', () => {
  assert.equal(count(page, 'data-mock-intro-start='), 1, 'one start control');
  assert.equal(count(page, '<button type="button" class="btn btn-primary" data-mock-intro-start="1"'), 1);
  const history = /<div class="mock-intro-runs" data-mock-intro-runs>([\s\S]*?)<\/div>/.exec(page);
  assert.ok(history, 'the history list is missing');
  assert.ok(!history[1].includes('data-mock-intro-start='), 'a history row must not be able to start a run');
  assert.ok(history[1].includes('href="#/lauf/11111111-2222-4333-8444-555555555555"'), 'history rows link to the run route');
});

/* ------------------------------------------------------------------- 7-11 */

await asyncLeg('7 unchanged run request: forms (GET) then start with the exact four fields, then navigate', async () => {
  const api = stubApi();
  const navigated = [];
  const host = new StubHost();
  const instance = view.createMockIntroView({ api, uiText, esc, language: 'de', navigate: href => navigated.push(href), state: { preparation: { state: 'active' } } });
  await instance.mount(host);
  assert.deepEqual(api.calls.map(call => call.method), ['forms', 'list'], 'the page reads the forms and the saved runs, and nothing else');
  await host.onclick(clickTarget('[data-mock-intro-start]'));
  const starts = api.calls.filter(call => call.method === 'start');
  assert.equal(starts.length, 1, 'exactly one start request');
  assert.deepEqual(Object.keys(starts[0].body).sort(), ['eventId', 'formId', 'formVersion', 'releaseVersion'], 'the request carries only today\'s four fields');
  assert.equal(starts[0].body.formId, 'telc-complete');
  assert.equal(starts[0].body.formVersion, 'v3');
  assert.equal(starts[0].body.releaseVersion, 'v2');
  assert.match(starts[0].body.eventId, /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i, 'the server validates the eventId as a UUID');
  assert.deepEqual(api.calls.map(call => call.method), ['forms', 'list', 'start'], 'starting uses no other endpoint');
  assert.deepEqual(navigated, ['#/lauf/run-final'], 'the created run opens on the existing run route');
  instance.unmount();
});

await asyncLeg('8 idempotency: a retry after an unanswered start reuses the same eventId', async () => {
  let attempt = 0;
  const api = stubApi({ startResult: () => { attempt++; return attempt === 1 ? { ok: false, status: 0, error: 'network' } : { ok: true, status: 201, data: { id: 'run-final' } }; } });
  const navigated = [];
  const host = new StubHost();
  const instance = view.createMockIntroView({ api, uiText, esc, navigate: href => navigated.push(href), state: { preparation: { state: 'active' } } });
  await instance.mount(host);
  await host.onclick(clickTarget('[data-mock-intro-start]'));
  assert.ok(textOf(host.innerHTML).includes('Der Lauf konnte nicht angelegt werden'), 'the failure is shown');
  assert.deepEqual(navigated, [], 'a failed start navigates nowhere');
  await host.onclick(clickTarget('[data-mock-intro-start]'));
  const ids = api.calls.filter(call => call.method === 'start').map(call => call.body.eventId);
  assert.equal(ids.length, 2);
  assert.equal(ids[0], ids[1], 'the retry must reuse the same eventId');
  assert.deepEqual(navigated, ['#/lauf/run-final']);
  instance.unmount();
});

await asyncLeg('9 a refused start shows a message and never navigates', async () => {
  for (const [result, message] of [
    [{ ok: false, status: 409, error: 'preparation_archived' }, 'Diese Vorbereitung ist archiviert'],
    [{ ok: false, status: 401, error: 'session_expired' }, 'Die Sitzung ist nicht mehr gültig'],
    [{ ok: false, status: 500, error: 'server_error' }, 'Der Lauf konnte nicht angelegt werden'],
  ]) {
    const api = stubApi({ startResult: result });
    const navigated = [];
    const host = new StubHost();
    const instance = view.createMockIntroView({ api, uiText, esc, navigate: href => navigated.push(href), state: { preparation: { state: 'active' } } });
    await instance.mount(host);
    await host.onclick(clickTarget('[data-mock-intro-start]'));
    assert.ok(textOf(host.innerHTML).includes(message), 'expected "' + message + '" for ' + JSON.stringify(result));
    assert.deepEqual(navigated, []);
    instance.unmount();
  }
});

await asyncLeg('10 history: api.mock.list, the exported labels, finished vs open, withdrawn notice', async () => {
  const api = stubApi({ runs: { ok: true, status: 200, data: { runs: [finishedRun({ writing: { assessment_state: 'unassessed' } }), openRun(), finishedRun({ id: '22222222-3333-4444-8555-666666666666', review_withdrawn: true })] } } });
  const host = new StubHost();
  const instance = view.createMockIntroView({ api, uiText, esc, navigate: () => {}, state: { preparation: { state: 'active' } } });
  await instance.mount(host);
  const text = textOf(host.innerHTML);
  assert.ok(api.calls.some(call => call.method === 'list'), 'the history must come from api.mock.list()');
  assert.ok(text.includes('Gespeicherte Prüfungsläufe'), 'the history keeps the existing Prüfungsläufe heading: ' + text.slice(0, 200));
  assert.ok(text.includes('Interner Entwurf · Fachliche Prüfung ausstehend'), 'the scope/review labels are the exported helpers');
  assert.ok(text.includes('Abgeschlossen'), 'a finalised run is labelled finished');
  assert.ok(text.includes('Gespeichert · noch offen'), 'an open run is labelled open');
  assert.ok(text.includes('Schreiben: Unbewertet · Text erhalten'), 'the writing status is the exported helper');
  assert.ok(text.includes('Die fachliche Freigabe dieser Inhalte wurde zurückgezogen'), 'the withdrawn notice comes from review-labels.js');
  assert.equal(count(host.innerHTML, 'data-mock-intro-run="finalised"'), 2);
  assert.equal(count(host.innerHTML, 'data-mock-intro-run="open"'), 1);
  instance.unmount();
});

await asyncLeg('11 empty and refused history are different answers', async () => {
  const empty = new StubHost();
  const emptyView = view.createMockIntroView({ api: stubApi(), uiText, esc, navigate: () => {}, state: {} });
  await emptyView.mount(empty);
  assert.ok(textOf(empty.innerHTML).includes('Noch keine gespeicherten Läufe.'), 'empty history');
  emptyView.unmount();
  const refused = new StubHost();
  const refusedView = view.createMockIntroView({ api: stubApi({ runs: { ok: false, status: 500, error: 'server_error' } }), uiText, esc, navigate: () => {}, state: {} });
  await refusedView.mount(refused);
  assert.ok(textOf(refused.innerHTML).includes('Der Verlauf konnte nicht geladen werden.'), 'refused history is not shown as empty');
  refusedView.unmount();
});

/* -------------------------------------------------------------------- 12 */

await asyncLeg('12 degradation: no complete form, archived preparation, missing api', async () => {
  const noForm = new StubHost();
  const noFormView = view.createMockIntroView({ api: stubApi({ forms: { ok: true, status: 200, data: { forms: [sectionForm()] } } }), uiText, esc, navigate: () => {}, state: {} });
  await noFormView.mount(noForm);
  assert.ok(textOf(noForm.innerHTML).includes('Zurzeit ist kein Lauf für einen neuen Start verfügbar'), 'no complete form notice');
  assert.ok(!noForm.innerHTML.includes('data-mock-intro-start='), 'no start control without a complete form');
  assert.ok(noForm.innerHTML.includes('data-mock-intro-reload='), 'a reload control is offered');
  noFormView.unmount();

  const archivedHost = new StubHost();
  const archivedView = view.createMockIntroView({ api: stubApi(), uiText, esc, navigate: () => {}, state: { preparation: { state: 'archived' } } });
  await archivedView.mount(archivedHost);
  assert.ok(textOf(archivedHost.innerHTML).includes('Diese Vorbereitung ist archiviert'), 'archived notice');
  assert.ok(!archivedHost.innerHTML.includes('data-mock-intro-start='), 'no start control on an archived preparation');
  archivedView.unmount();

  const bareHost = new StubHost();
  const bareView = view.createMockIntroView({ uiText, esc, navigate: () => {}, state: {} });
  await bareView.mount(bareHost);
  assert.ok(textOf(bareHost.innerHTML).includes('Die verfügbaren Übungen konnten nicht geladen werden'), 'a missing api degrades instead of throwing');
  bareView.unmount();
});

/* ----------------------------------------------------------------- 13-16 */

leg('13 D22: no prediction vocabulary in ANY of the five locales', () => {
  const previous = getLocale();
  const offenders = [];
  for (const locale of LOCALES) {
    setLocale(locale);
    const markup = renderModel({ form: completeForm(), runs: [finishedRun(), openRun()], startPhase: 'failed' });
    const text = textOf(markup);
    const hit = predictionPattern.exec(text);
    if (hit) offenders.push(locale + ' -> "' + hit[0] + '"');
  }
  setLocale(previous);
  assert.deepEqual(offenders, [], 'prediction wording reached the learner: ' + offenders.join(', '));
});

leg('14 five locales: blocks, rule and oral note all render, and none of them is untranslated', () => {
  const previous = getLocale();
  const seen = new Set();
  for (const locale of LOCALES) {
    setLocale(locale);
    const markup = renderModel({ form: completeForm(), runs: [], startPhase: 'idle' });
    const text = textOf(markup);
    assert.ok(!text.includes('Übersetzung nicht verfügbar'), locale + ' leaked the unavailable message');
    assert.ok(!text.includes('Translation unavailable'), locale + ' leaked the unavailable message');
    assert.equal(count(markup, '<tr data-mock-intro-block='), 4, locale + ' lost a block row');
    assert.ok(/data-mock-intro-rule/.test(markup) && textOf(/<p data-mock-intro-rule>([\s\S]*?)<\/p>/.exec(markup)[1]).length > 40, locale + ' lost the rule text');
    assert.ok(textOf(/<p data-mock-intro-oral>([\s\S]*?)<\/p>/.exec(markup)[1]).length > 30, locale + ' lost the oral note');
    seen.add(textOf(/<h1 id="mock-intro-title">([\s\S]*?)<\/h1>/.exec(markup)[1]));
  }
  setLocale(previous);
  assert.equal(seen.size, LOCALES.length, 'the five titles must be five different translations');
});

leg('15 RTL: the Arabic page is RTL and the German run title stays an LTR island', () => {
  const previous = getLocale();
  setLocale('ar');
  const markup = renderModel({ form: completeForm(), runs: [finishedRun()], startPhase: 'idle' });
  setLocale(previous);
  assert.match(markup, /<section class="mock-intro" data-mock-intro lang="ar" dir="rtl"/);
  assert.match(markup, /<h3 lang="de" dir="ltr">Schriftliche Prüfung<\/h3>/);
});

leg('16 register: the German page addresses the reader formally', () => {
  const markup = renderModel({ form: completeForm(), runs: [finishedRun()], startPhase: 'idle' });
  const hit = INFORMAL.exec(textOf(markup));
  assert.equal(hit, null, 'informal address in the rendered page: ' + (hit && hit[0]));
});

/* -------------------------------------------------------------------- 17 */

leg('17 module CSS: tokens only, no raw colour, no second font face, module-scoped breakpoints', () => {
  const css = fs.readFileSync(CSS_PATH, 'utf8');
  const defined = new Set();
  for (const file of ['public/assets/design/hatoove.css', 'public/app/app.css']) {
    const source = fs.readFileSync(fileURLToPath(new URL(file, root)), 'utf8');
    for (const match of source.matchAll(/(--[A-Za-z0-9-]+)\s*:/g)) defined.add(match[1]);
  }
  const used = [...css.matchAll(/var\((--[A-Za-z0-9-]+)/g)].map(match => match[1]);
  const undefinedTokens = [...new Set(used)].filter(token => !defined.has(token));
  assert.deepEqual(undefinedTokens, [], 'undefined design token(s): ' + undefinedTokens.join(', '));
  const rawColour = [...css.matchAll(/(?:^|[:\s(,])(#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\()/gm)].map(match => match[0].trim());
  assert.deepEqual(rawColour, [], 'raw colour in a rule: ' + rawColour.join(', '));
  for (const match of css.matchAll(/font-family\s*:\s*([^;]+)/gi)) assert.match(match[1], /var\(--(display|font)\s*[,)]/, 'un-tokenised font family: ' + match[1]);
  const breakpoints = [...css.matchAll(/max-width\s*:\s*(\d+)px/g)].map(match => Number(match[1]));
  // 1100/860 are the design system's. 420 is this module's narrow-phone step: below it the block table
  // switches to a fixed layout so the points column stays on screen instead of behind a scroll. It may not
  // become a second layout opinion for the shell, so every selector inside it must be module-scoped.
  assert.deepEqual([...new Set(breakpoints)].filter(px => ![1100, 860, 420].includes(px)), [], 'a second breakpoint opinion');
  const narrow = /@media\s*\(max-width:\s*420px\)\s*\{([\s\S]*?)\n\}/.exec(css);
  if (narrow) {
    const selectors = [...narrow[1].replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/(?:^|\})\s*([^{}]+)\{/g)].map(match => match[1].trim()).filter(Boolean);
    assert.ok(selectors.length, 'the 420 px step declares no rule');
    for (const list of selectors) for (const selector of list.split(',')) assert.ok(selector.trim().startsWith('.mock-intro'), 'the module breakpoint must only style this module, found: ' + selector.trim());
  }
});

/* ------------------------------------------------------------------ report */

setLocale('de');
console.log('\n' + passed + ' passed, ' + failed + ' failed  (' + path.basename(MODULE_PATH) + ', ' + path.basename(CSS_PATH) + ')\n');
if (failed) {
  for (const entry of results.filter(item => !item.ok)) console.log('  ' + entry.name + '\n      ' + entry.detail);
  process.exit(1);
}
console.log('The intro page states the exam facts, starts today\'s unchanged run request, reuses the existing');
console.log('history and makes no claim about this learner. Rendered 1366/390 px evidence and the independent');
console.log('review remain separate gates.\n');

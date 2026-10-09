#!/usr/bin/env node
/**
 * PRACTICE-01 (slice C) focused check — the part runner.
 *
 * Offline and dependency-free. No database, no browser, no network, no `.env`.
 *
 *   node tools/practice-runner-check.mjs
 *   node tools/practice-runner-check.mjs --module=<copy of public/app/part-runner.js> --css=<copy> …
 *
 * WHAT IT PINS, AND WHY
 *  1. THE DTO THE SERVER IS REQUIRED TO EMIT, on its own legs: one page, every task, one "Auswerten",
 *     the full review (prompt, ALL options, the key marked, the learner's pick marked, the explanation in
 *     the chosen language), and exactly three actions in the documented order.
 *  2. THE REQUIRED DTO OVER THE REAL CORPUS: the check parses the 24 `objective_set` payloads AND their
 *     `objective_key` answers out of `server/migrations/0010-objective-catalogue.sql` — the file the
 *     database is seeded from — and asserts, per set, that the DTO the server must build reaches every
 *     answer key with a non-empty option list. That is the assertion that would have caught the shape gap
 *     reported to the Lead; it does NOT depend on `normalisePracticeSet`, which today cannot serve 7 of
 *     the 8 families at all (see the implementation note).
 *  3. THE RENDERING BRIDGE, labelled as such: the AUTHORED per-item shapes the corpus is stored in
 *     (`{n,question,options:{…}}`, `{n,statement}`, `{id,text}` + set-level `headlines`, `{n,text}` +
 *     `ads`, `{n}` + `bank` with `word`) still render, so a page is never blank while the server half is
 *     fixed. Legs marked [bridge] pass only because of that layer.
 *  4. THE WRAP (amendment A1): the check drives the SERVER's own `practiceRoundState` for four taps of a
 *     three-set part and asserts the fourth tap is announced with the contract's exact copy instead of
 *     silently restarting, and that taps one to three are not.
 *  5. LISTENING: the exam play rule comes from the parts payload (`playback.mock`), playback is DISABLED
 *     with a message that names the missing practice playback path, and no replay control exists before
 *     "Auswerten" — replay appears only in the review.
 *  6. D22: no prediction, forecast, probability, readiness or streak vocabulary in any of the five
 *     locales, and no percentage.
 *  7. THE TRANSPORT: `api.practice.next()` is byte-identical to before the slice, `next('LV2')` adds only
 *     `?family=`, and `practice.check` is a preparation-scoped POST. No URL and no `fetch(` in the runner.
 *  8. THE COMPOSITION: a tile opens the runner into the SAME host by dynamic import, and "Zur Auswahl"
 *     hands the host back to the index with fresh counts. No shell change, no new ctx member.
 *  9. i18n: every new key exists and is non-empty in all five locales, the German is formal, and the
 *     stylesheet uses design tokens only with no breakpoint of its own.
 * 10. A REFUSED "Auswerten" IS AN ERROR: `role="alert"`, the copy promises a retry only where a retry can
 *     succeed, "Auswerten" is disabled when it cannot, and a 409 recovers the held review or says what is
 *     true instead of looping.
 * 11. THE DRILL (contract A9): the migration-`0022` grammar drill is part of the 25-set corpus, renders its
 *     12 tasks, and its disclosure is echoed when the served set carries one.
 *
 * THE SERVER CROSS-CHECK RUNS BY DEFAULT (review F2). Leg 12d compares the served DTO against
 * `server/practice-sets.mjs` — the repository's own normaliser, which after integration IS the rewritten
 * one — and `--server=<path>` only repoints it. It FAILS if that file cannot serve the corpus, so the
 * strongest leg cannot go dark behind a green summary; the summary line names the file it used.
 *
 * MUTATION PROOF: `--mutations` automates the six (a copy of `public/` per mutation in %TEMP%, each
 * hash-verified as changed, then this check re-run as a child). Each must fail ONE leg:
 *   M1 the review drops the key marker          -> leg 2 fails
 *   M2 the fourth tap gets the silent restart   -> leg 6 fails
 *   M3 replay is offered before "Auswerten"     -> leg 7 fails
 *   M4 the served option `value` is stringified -> leg 7 fails
 *   M5 the practice refusal stops being read    -> leg 7g fails (POOL-01)
 *   M6 the bytes are fetched before the play    -> leg 7f fails (POOL-01)
 * M5/M6 mutate `practice-listening.js` rather than the runner, so each mutation names the file it edits.
 * Run `node tools/practice-runner-check.mjs --mutations` for the proof; the child runs add a
 * `--no-mutations` guard so the proof cannot recurse.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const arg = (name) => {
  const flag = process.argv.find((value) => value.startsWith('--' + name + '='));
  const env = process.env['PRACTICE_RUNNER_' + name.toUpperCase()];
  const value = flag ? flag.slice(name.length + 3) : env;
  return value ? path.resolve(value) : null;
};
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

const MODULE_PATH = arg('module') ?? path.join(root, 'public', 'app', 'part-runner.js');
const INDEX_PATH = arg('index') ?? path.join(root, 'public', 'app', 'part-index.js');
const CSS_PATH = arg('css') ?? path.join(root, 'public', 'app', 'part-runner.css');
const API_PATH = arg('api') ?? path.join(root, 'public', 'app', 'api.js');
const MESSAGES_PATH = arg('messages') ?? path.join(root, 'public', 'assets', 'i18n', 'practice-messages.js');
const SETS_PATH = arg('sets') ?? path.join(root, 'server', 'practice-sets.mjs');
const MIGRATION_PATH = arg('migration') ?? path.join(root, 'server', 'migrations', '0010-objective-catalogue.sql');
/* The DRILL's migration (contract A9): the corpus is not all in 0010, and a comment saying it is would be
   wrong. Both files are parsed; `--drill` repoints it so the corpus legs can be driven from a copy. */
const DRILL_MIGRATION_PATH = arg('drill') ?? path.join(root, 'server', 'migrations', '0022-recovered-grammar-drills.sql');
/** The normaliser the cross-check drives. DEFAULTED, not optional (review F2): after integration this is
 *  the repository's own rewritten `normalisePracticeSet`, so the guard runs on every invocation. */
const SERVER_SETS_PATH = arg('server') ?? SETS_PATH;
const NO_MUTATIONS = process.argv.includes('--no-mutations');
const RUN_MUTATIONS = process.argv.includes('--mutations');

const runner = await import(pathToFileURL(MODULE_PATH).href);
const indexModule = await import(pathToFileURL(INDEX_PATH).href);
const { setLocale, getLocale } = await import(pathToFileURL(path.join(path.dirname(MODULE_PATH), '..', 'assets', 'i18n', 'core.js')).href);
/* The copy legs read German. Node exposes a `navigator`, so the runtime's own default could be anything;
   pin it instead of inheriting whatever the host reports. */
setLocale('de');
const { pt, PRACTICE_MESSAGES } = await import(pathToFileURL(MESSAGES_PATH).href);
const { practiceRoundState } = await import(pathToFileURL(SETS_PATH).href);
const { createApi } = await import(pathToFileURL(API_PATH).href);

const LOCALES = ['de', 'en', 'uk', 'ar', 'tr'];
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const decode = value => String(value).replace(/&(?:amp|lt|gt|quot|#39);/g, c => ({ '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'" }[c]));
const textOf = markup => decode(String(markup).replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
/** What the learner SEES: `.sr-only` content is for assistive tech, not for the page. */
const visibleTextOf = markup => textOf(String(markup).replace(/<[^>]*class="[^"]*sr-only[^"]*"[^>]*>[\s\S]*?<\/[a-z]+>/g, ' '));
const countOf = (markup, pattern) => [...String(markup).matchAll(pattern)].length;
const SHELL_TEXT = { m002: 'Leseverstehen', m003: 'Sprachbausteine', m004: 'Hörverstehen' };
const uiText = key => SHELL_TEXT[key] ?? key;
const UUID = '11111111-1111-4111-8111-111111111111';
const HASH = 'a'.repeat(64);

let passed = 0; const failures = [];
/* Every leg is queued and awaited in order, so an async leg cannot report PASS before its assertions ran
   and the five-locale legs never interleave their global locale. */
const queue = [];
const leg = (name, run) => {
  queue.push(async () => {
    try {
      await run();
      passed++; console.log('PASS  ' + name);
    } catch (error) {
      failures.push({ name, error });
      console.log('FAIL  ' + name + '  [' + String(error && error.message).slice(0, 300) + ']');
    }
  });
};
const aLeg = leg;

/* ------------------------------------------------------------------ fixtures: the required DTO */

const t = (key, parameters = {}, locale = 'de') => pt(key, parameters, locale);
const explanationView = (language = 'de') => ({
  schema: 'explanation-view-v1',
  source: { kind: 'objective', source_sha256: HASH, exam_id: 'telc-deutsch-b1', set_id: 'telc-deutsch-b1.lv2.01', set_version: 'v1', item_id: '6' },
  requested_language: language,
  original_language: 'de',
  displayed_language: language,
  state: language === 'de' ? 'original' : 'translated',
  requested_status: 'available',
  reason: null,
  representation: {
    version: 'v1', payload_sha256: 'b'.repeat(64), persisted: true, provenance_kind: 'builtin-built',
    payload: { schema: 'explanation-text-v1', blocks: [{ slot: 'explanation/why', text: 'EXPLANATION-' + language.toUpperCase() }] },
  },
  review: {
    educational: { review_status: 'unreviewed', review_basis: 'none', blocked: false, explicit_negative: false, decision_ids: [] },
    native_language: { review_status: 'unreviewed', review_basis: 'none', blocked: false, explicit_negative: false, decision_ids: [] },
  },
  languages: LOCALES.map(locale => ({ language: locale, status: 'available' })),
  operation: null,
});

/** The DTO `normalisePracticeSet` serves, for one LV2-shaped set (server/practice-sets.mjs shape). */
function dtoSet(overrides = {}) {
  const items = overrides.items ?? [
    { item_id: '6', ordinal: 1, prompt: 'Was soll sich in der Innenstadt ändern?', prompt_en: null, answer_kind: 'choice', options: [{ id: 'a', text: 'Autos dürfen dort bald überall fahren.', value: 'a' }, { id: 'b', text: 'In einigen Straßen sollen Radwege entstehen.', value: 'b' }, { id: 'c', text: 'Der Busverkehr wird ganz eingestellt.', value: 'c' }] },
    { item_id: '7', ordinal: 2, prompt: 'Wie hat sich die Zahl der Radfahrer entwickelt?', prompt_en: null, answer_kind: 'choice', options: [{ id: 'a', text: 'Sie ist in fünf Jahren um fast die Hälfte gestiegen.', value: 'a' }, { id: 'b', text: 'Sie ist in den letzten Jahren leicht gesunken.', value: 'b' }, { id: 'c', text: 'Sie ist gleich geblieben.', value: 'c' }] },
    { item_id: '8', ordinal: 3, prompt: 'Warum gibt es Kritik an den Plänen?', prompt_en: null, answer_kind: 'choice', options: [{ id: 'a', text: 'Die Geschäftsleute befürchten weniger Kunden.', value: 'a' }, { id: 'b', text: 'Die Radfahrer wollen breitere Wege.', value: 'b' }, { id: 'c', text: 'Die Bauarbeiten sind zu teuer.', value: 'c' }] },
  ];
  return {
    set_id: 'telc-deutsch-b1.lv2.01', version: 'v1', title: 'Mehr Platz für Fahrräder in der Innenstadt',
    family: 'LV2', section: 'LV', part: 2, item_count: items.length, media_required: false, playback: null,
    material: { text: MATERIAL_TEXT },
    ...overrides, items,
  };
}

const MATERIAL_TEXT = 'Die Stadt Freiburg will den Verkehr in der Innenstadt neu ordnen. Ab dem nächsten Frühjahr sollen Autofahrerinnen und Autofahrer einige Straßen nicht mehr benutzen dürfen.\n\nNach Angaben der Stadtverwaltung fahren täglich etwa 25.000 Menschen mit dem Rad zur Arbeit.';

/** One judgement set, exactly as the server serves it: booleans in `value`, and an EMPTY option text. */
function judgementSet() {
  return dtoSet({
    set_id: 'telc-deutsch-b1.hv2.01', family: 'HV2', section: 'HV', part: 2, title: 'Gesundheit und Wohlbefinden',
    media_required: true, material: {},
    items: [{ item_id: '46', ordinal: 1, prompt: 'Frau Baum empfiehlt, sofort mit einer strengen Diät zu beginnen.', prompt_en: null, answer_kind: 'judgement', options: [{ id: 'true', text: '', value: true }, { id: 'false', text: '', value: false }] }],
  });
}

const EXAM_PARTS_FIXTURE = [
  { family: 'LV2', section: 'LV', part: 2, itemCount: 5, points: 25, playback: null },
  { family: 'HV1', section: 'HV', part: 1, itemCount: 5, points: 25, playback: { practice: 1, mock: 1 } },
  { family: 'HV2', section: 'HV', part: 2, itemCount: 10, points: 25, playback: { practice: 1, mock: 2 } },
];

function nextResponse({ set = dtoSet(), family = null, round = { setCount: 3, checkedSets: 0, wrapped: false, round: 1, notice: null }, reason = 'unseen', evidence = { seen: 0, wrong: 0, first_seen_at: null } } = {}) {
  const resolved = family ?? set.family;
  return {
    ok: true, status: 200, error: null,
    data: {
      preparation_id: 'prep', exam_id: 'telc-deutsch-b1', family: resolved, section: set.section,
      reason, evidence, attempt: { attempt_id: UUID, state: 'open' }, round, set,
    },
  };
}

/** The server's checked response, derived from what the client POSTED — never from client-side marking. */
function checkedFromPayload(payload, set, { explanationLanguage = 'de', allCorrect = false } = {}) {
  const items = payload.answers.map((entry, position) => {
    const item = set.items.find(candidate => candidate.item_id === entry.item_id);
    const correct = allCorrect || position === 0;
    const alternative = item.options.find(option => String(option.id) !== String(entry.answer));
    const answerKind = item.answer_kind ?? (item.options.some(option => typeof option.value === 'boolean') ? 'judgement' : 'choice');
    return {
      item_id: entry.item_id,
      correct,
      chosen: entry.answer,
      expected: correct ? entry.answer : (alternative ? alternative.id : entry.answer),
      /* The fixed route discloses the review's own kind and serves `explanation: null` for a judgement
         answer: the choice-family reader cannot read it, and null is the honest value. */
      answer_kind: answerKind,
      evidence_id: '22222222-2222-4222-8222-22222222222' + position,
      explanation: answerKind === 'judgement' ? null : explanationView(explanationLanguage),
    };
  });
  return {
    attempt_id: payload.attemptId, set_id: set.set_id, version: set.version, family: set.family, section: set.section,
    state: 'checked', checked_at: '2026-10-05T12:00:00.000Z', item_count: set.items.length,
    answered_count: items.length, correct_count: items.filter(item => item.correct).length, items,
  };
}

/** A stub transport: the two practice routes and the per-evidence explanation read, nothing else. */
function stubApi({ responses = [], set = dtoSet(), examParts = EXAM_PARTS_FIXTURE, published = false, allCorrect = false } = {}) {
  const calls = { next: [], check: [], explanation: [] };
  const queue = [...responses];
  return {
    calls,
    api: {
      examParts: { list: async () => ({ ok: true, status: 200, data: { exam_id: 'telc-deutsch-b1', parts: examParts } }) },
      practice: {
        next: async (family) => {
          calls.next.push(family ?? null);
          if (queue.length) return queue.shift();
          return nextResponse({ set, family });
        },
        check: async (payload) => {
          calls.check.push(payload);
          return { ok: true, status: 200, data: checkedFromPayload(payload, set, { explanationLanguage: payload.language ?? 'de', allCorrect }) };
        },
        explanation: async (evidenceId, language) => {
          calls.explanation.push({ evidenceId, language });
          return { ok: true, status: 200, data: explanationView(language ?? 'de') };
        },
      },
    },
    published,
  };
}

/** A host stub: enough for `createPartRunnerView` / `createPartIndexView`, no DOM library.
 *  `querySelector` hands back a small stand-in node per selector, so the runner's in-place updates (the
 *  answered mark, the progress line, the evaluate button) can be observed without a DOM.
 *
 *  POOL-01 made this stateful in ONE respect: assigning `innerHTML` replaces the element's children for real,
 *  so every node handed out before the assignment is marked DISCONNECTED (`isConnected === false`, and
 *  `querySelector` then returns a fresh node). That is what the practice player checks before it renders into
 *  a mount point the runner has already replaced — without it a stub would let a stale-node bug pass. */
function hostStub(id = 'part-index-host') {
  let nodes = new Map();
  const state = { innerHTML: '' };
  return {
    id, onclick: null, onchange: null, dataset: {}, hidden: false, className: '',
    get innerHTML() { return state.innerHTML; },
    set innerHTML(value) {
      for (const node of nodes.values()) node.isConnected = false;
      nodes = new Map();
      state.innerHTML = value;
    },
    querySelector: (selector) => {
      if (!nodes.has(selector)) {
        /*
         * The practice player renders INTO a host node of its own (`listeningPlayerMarkup` returns markup, the
         * player assigns it to `[data-listening-mount]`). A plain stub node would swallow that assignment and
         * the composition could not be observed here, so the mount node keeps its own innerHTML — which is the
         * ONE piece of DOM behaviour this check models, and it says so.
         */
        const node = { dataset: {}, textContent: '', disabled: false, isConnected: true, setAttribute() {}, querySelectorAll: () => [], children: [], innerHTML: '' };
        if (selector === '[data-listening-mount]') {
          let markup = '';
          Object.defineProperty(node, 'innerHTML', {
            get: () => markup,
            set: (value) => { markup = String(value); node.isConnected = true; },
            enumerable: true, configurable: true,
          });
        }
        nodes.set(selector, node);
      }
      return nodes.get(selector);
    },
    querySelectorAll: () => [], contains: () => false, matches: () => false,
    get nodes() { return nodes; },
  };
}
const clickEvent = selector => ({ target: { closest: (wanted) => (wanted === selector ? { dataset: {} } : null) } });
const actionEvent = action => ({ target: { closest: (wanted) => (wanted === '[data-runner-action]' ? { dataset: { runnerAction: action } } : null) } });
const answerEvent = (itemId, key) => ({ target: { closest: (wanted) => (wanted === '[data-answer-item]' ? { dataset: { answerItem: itemId, answerKey: key } } : null) } });

const CTX = { esc, uiText, language: 'de', examLanguage: 'de' };
const renderState = (state, extra = {}) => runner.runnerMarkup(state, { esc, uiText, examLanguage: 'de', locale: 'de', ...extra });

/** Drive one whole run: mount, answer every task, evaluate, return the host and the view. */
async function runOne({ set = dtoSet(), round, examParts = EXAM_PARTS_FIXTURE, language = 'de', wrongFrom = 0, allCorrect = false } = {}) {
  const stub = stubApi({ set, examParts, allCorrect });
  const host = hostStub('part-runner-host');
  const view = runner.createPartRunnerView({ ...CTX, language, family: set.family, examParts, api: stub.api });
  await view.mount(host);
  for (const [position, item] of set.items.entries()) {
    const option = position < wrongFrom ? item.options[0] : item.options[item.options.length - 1];
    host.onchange(answerEvent(item.item_id, option.id));
  }
  await view.evaluate();
  return { stub, host, view, state: view.snapshot() };
}

/* ------------------------------------------------------- 1. one page, one Auswerten, all tasks */

leg('1 [dto] the whole part on one page: every task present, exactly one "Auswerten"', () => {
  const set = dtoSet();
  const state = runner.runnerStateFromServed({ family: 'LV2', response: nextResponse({ set }), examRule: { family: 'LV2', section: 'LV', part: 2, playback: null } });
  const markup = renderState(state);
  assert.equal(state.phase, 'answering');
  assert.match(markup, /data-runner-phase="answering"/);
  assert.equal(countOf(markup, /data-item-id="/g), set.items.length, 'every task of the set is on the page');
  assert.deepEqual([...markup.matchAll(/data-item-id="([^"]+)"/g)].map(m => m[1]), set.items.map(item => item.item_id), 'in the served order');
  assert.equal(countOf(markup, /data-runner-evaluate[ >]/g), 1, 'exactly one evaluate control');
  assert.equal(countOf(markup, /data-runner-actions/g), 0, 'no actions before the review');
  assert.equal(countOf(markup, /data-runner-retry/g), 0, 'no retry in the answering phase');
  assert.ok(!/data-runner-next-item|data-runner-step|data-runner-page/.test(markup), 'no stepper or pagination');
  assert.ok(textOf(markup).includes('Teilübung · ohne Zeitmessung'), 'the untimed claim is on screen');
  /* The task label appears once: the radio group's accessible name is sr-only, not a second visible line. */
  assert.equal(countOf(markup, /class="part-runner-legend sr-only"/g), set.items.length, 'each group carries an accessible name');
  assert.equal((visibleTextOf(markup).match(/Aufgabe \d+/g) ?? []).length, set.items.length, 'the task label is printed once per task');
  // The control stays disabled until every task is answered — never a silent no-op.
  assert.match(markup, /data-runner-evaluate-ready="false"[^>]*disabled/, 'evaluate is disabled while tasks are open');
});

aLeg('1b [dto] all options of every task are rendered, and the progress line counts answers', async () => {
  const set = dtoSet();
  const stub = stubApi({ set });
  const host = hostStub();
  const view = runner.createPartRunnerView({ ...CTX, family: 'LV2', examParts: EXAM_PARTS_FIXTURE, api: stub.api });
  await view.mount(host);
  const totalOptions = set.items.reduce((sum, item) => sum + item.options.length, 0);
  assert.equal(countOf(host.innerHTML, /data-answer-item="/g), totalOptions, 'every option of every task');
  assert.equal(countOf(host.innerHTML, /type="radio"/g), totalOptions);
  assert.ok(textOf(host.innerHTML).includes('0 von 3 beantwortet'));
  assert.match(host.innerHTML, /data-runner-evaluate-ready="false"[^>]*disabled/, 'evaluate waits for every answer');
  host.onchange(answerEvent('6', 'b'));
  assert.deepEqual(view.snapshot().answers['6'], { key: 'b', value: 'b' }, 'the answer is held client-side');
  assert.equal(host.querySelector('[data-item-id="6"]').dataset.answered, 'true', 'the answered task is marked in place');
  assert.ok(host.querySelector('[data-runner-progress]').textContent.includes('1 von 3 beantwortet'), 'the progress line counts up without a re-render');
  host.onchange(answerEvent('7', 'a'));
  host.onchange(answerEvent('8', 'c'));
  assert.ok(host.querySelector('[data-runner-progress]').textContent.includes('3 von 3 beantwortet'));
  assert.equal(host.querySelector('[data-runner-progress]').dataset.complete, 'true');
  assert.equal(host.querySelector('[data-runner-evaluate]').disabled, false, 'evaluate opens once every task is answered');
  assert.match(view.markup(), /data-runner-evaluate-ready="true"/, 'the render agrees with the in-place state');
});

/* ------------------------------------------------------------------ 2. the full review (DTO) */

leg('2 [dto] the review is the FULL review: prompt, ALL options, key marked, pick marked', async () => {
  const set = dtoSet();
  const { host, state } = await runOne({ set, wrongFrom: 1 });
  assert.equal(state.phase, 'review');
  const markup = host.innerHTML;
  assert.match(markup, /data-runner-phase="review"/);
  assert.equal(countOf(markup, /data-review-item="/g), set.items.length, 'every task is reviewed');
  assert.equal(countOf(markup, /data-option-id="/g), set.items.reduce((sum, item) => sum + item.options.length, 0), 'ALL options, not only the right one');
  assert.equal(countOf(markup, /data-option-marker="key"/g), set.items.length, 'the key is marked on every task');
  assert.equal(countOf(markup, /data-option-marker="chosen"/g), set.items.length, 'the learner\'s pick is marked on every task');
  const checked = state.checked;
  /* Split on the review item's own opening tag: an option is a nested <li>, so a non-greedy block would
     stop at the first option. */
  const blocks = markup.split('<li class="part-runner-review-item"').slice(1);
  for (const item of checked.items) {
    const block = blocks.filter(part => part.startsWith(' data-review-item="' + item.item_id + '"'));
    assert.equal(block.length, 1, 'exactly one block per reviewed item: ' + item.item_id);
    assert.match(block[0], new RegExp('data-option-id="' + item.expected + '"[^>]*data-option-state="key(-chosen)?"'), 'the key option is marked for ' + item.item_id);
    assert.ok(block[0].includes('data-option-id="' + item.chosen + '"'), 'the chosen option is present');
    assert.match(block[0], new RegExp('data-review-verdict="' + (item.correct ? 'correct' : 'wrong') + '"'), 'the server verdict, not a client guess');
  }
  assert.ok(textOf(markup).includes(t('partRunnerKey')) && textOf(markup).includes(t('partRunnerYourPick')), 'both markers are labelled with the shipped catalogue copy');
  assert.match(markup, /data-runner-result data-correct="1" data-total="3"/, 'the result is a count of the server verdicts');
  assert.ok(!/%|Prozent|percent/i.test(textOf(markup)), 'no percentage');
});

leg('3 [dto] the explanation is rendered in the chosen language, from the projected view DTO', async () => {
  const set = dtoSet();
  const { host, state } = await runOne({ set, language: 'uk' });
  const markup = host.innerHTML;
  for (const item of state.checked.items) {
    assert.match(markup, new RegExp('data-explanation-for="' + item.evidence_id + '"'), 'each reviewed item carries its explanation card');
  }
  assert.ok(markup.includes('data-explanation-slot="explanation/why"'), 'the projected block is rendered');
  assert.ok(markup.includes('lang="uk" dir="ltr"'), 'the prose carries the DISPLAYED language, not the interface one');
  assert.ok(markup.includes('EXPLANATION-UK'), 'the text is the chosen language\'s text');
  assert.equal(countOf(markup, /data-runner-explanation-language/g), 1, 'one language control for the review');
  assert.deepEqual([...markup.matchAll(/<option value="([a-z]+)"/g)].map(m => m[1]), LOCALES, 'all five explanation languages are offered');
  assert.match(markup, /<option value="uk"[^>]*selected/, 'the chosen language is the selected one');
});

leg('3b [dto] changing the explanation language re-reads each item through the per-evidence route', async () => {
  const set = dtoSet();
  const { host, view, stub, state } = await runOne({ set, language: 'de' });
  assert.equal(stub.calls.explanation.length, 0, 'no read before the learner asks for another language');
  const before = state.checked.items.map(item => item.explanation.displayed_language);
  await view.reloadExplanations('tr');
  assert.equal(stub.calls.explanation.length, set.items.length, 'one read per reviewed item');
  assert.deepEqual(stub.calls.explanation.map(call => call.language), LOCALES.map(() => 'tr').slice(0, set.items.length));
  assert.ok(before.every(language => language === 'de'), 'the first pass was the requested interface language');
  assert.ok(host.innerHTML.includes('EXPLANATION-TR'), 'the new language is on screen');
});

/* ---------------------------------------------------------- 4. exactly three actions, in order */

leg('4 [dto] exactly three actions, in the documented order', async () => {
  const { host } = await runOne({ set: dtoSet(), wrongFrom: 1 });
  assert.equal(countOf(host.innerHTML, /data-runner-actions/g), 1, 'one action row');
  assert.equal(countOf(host.innerHTML, /data-runner-action="/g), 3, 'exactly three actions');
  assert.deepEqual([...host.innerHTML.matchAll(/data-runner-action="([a-z]+)"/g)].map(m => m[1]), runner.RUNNER_ACTIONS, 'in order');
  const text = textOf(host.innerHTML);
  assert.ok(text.includes('Noch ein Satz') && text.includes('Fehler üben') && text.includes('Zur Auswahl'), 'the three documented labels');
  assert.ok(host.innerHTML.indexOf('Noch ein Satz') < host.innerHTML.indexOf('Fehler üben'), 'order on the page follows the contract');
  assert.ok(host.innerHTML.indexOf('Fehler üben') < host.innerHTML.indexOf('Zur Auswahl'), 'order on the page follows the contract');
});

leg('4b a review with nothing wrong disables "Fehler üben" and says why', async () => {
  const { host, state } = await runOne({ set: dtoSet(), allCorrect: true });
  assert.equal(state.checked.correct_count, state.checked.answered_count, 'every task was right');
  assert.equal(countOf(host.innerHTML, /data-runner-action="/g), 3, 'the action is present even when it cannot run');
  assert.match(host.innerHTML, /data-runner-action="mistakes"[^>]*disabled[^>]*data-runner-action-reason="partRunnerMistakesNone"/, 'disabled with a reason');
});

leg('4c "Fehler üben" opens a fresh sitting narrowed to the wrong tasks, and says so', async () => {
  const set = dtoSet();
  const stub = stubApi({ set });
  const host = hostStub();
  const view = runner.createPartRunnerView({ ...CTX, family: 'LV2', examParts: EXAM_PARTS_FIXTURE, api: stub.api });
  await view.mount(host);
  for (const [position, item] of set.items.entries()) host.onchange(answerEvent(item.item_id, item.options[0].id));
  await view.evaluate();
  const wrong = view.snapshot().mistakesOf;
  assert.equal(wrong.length, 2, 'two tasks were wrong');
  host.onclick(actionEvent('mistakes'));
  await new Promise(resolve => setImmediate(resolve));
  const state = view.snapshot();
  assert.equal(state.phase, 'answering');
  assert.equal(state.mode, 'mistakes');
  assert.equal(state.set.items.length, 2, 'only the wrong tasks are served again');
  assert.ok(host.innerHTML.includes('data-runner-notice="partRunnerMistakesRound"'), 'the round says what it is');
  assert.equal(stub.calls.next.length, 2, 'a fresh sitting, not a re-check of the old one');
});

/* ------------------------------------------------------------------- 5. the wrap (A1) */

leg('5 [dto] the four taps of a three-set part: taps 1-3 do not wrap, tap 4 announces it', () => {
  const taps = [0, 1, 2, 3].map(checked => practiceRoundState({ setCount: 3, checkedSets: checked }));
  assert.deepEqual(taps.slice(0, 3).map(round => round.wrapped), [false, false, false], 'the first three taps do not wrap');
  assert.equal(taps[3].wrapped, true, 'the FOURTH tap of a three-set part wraps');
  assert.equal(taps[3].notice, runner.WRAP_KEY, 'the server names the notice key the client renders');
  assert.deepEqual(taps.map(round => round.round), [1, 2, 3, 3], 'the round numbers the server attaches');

  const set = dtoSet();
  for (const [index, round] of taps.slice(0, 3).entries()) {
    const state = runner.runnerStateFromServed({ family: 'LV2', response: nextResponse({ set, round }), examRule: null });
    assert.equal(state.wrapNotice, false, 'tap ' + (index + 1) + ' is not a wrap');
    assert.ok(!renderState(state).includes('data-runner-wrap-notice'), 'no wrap notice on tap ' + (index + 1));
  }
  const fourth = runner.runnerStateFromServed({ family: 'LV2', response: nextResponse({ set, round: taps[3] }), examRule: null });
  assert.equal(fourth.wrapNotice, true, 'the fourth tap carries the wrap');
  const markup = renderState(fourth);
  assert.ok(markup.includes('data-runner-wrap-notice'), 'the wrap is announced, not silent');
  assert.ok(textOf(markup).includes('Alle Sätze dieses Teils geübt — von vorn'), 'the contract\'s exact wrap copy');
  assert.equal(t('practiceAllSets'), 'Alle Sätze dieses Teils geübt — von vorn');
});

leg('6 [dto] after the fourth tap the restart action carries the wrap copy, never the silent label', () => {
  const set = dtoSet();
  const taps = [0, 1, 2, 3].map(checked => practiceRoundState({ setCount: 3, checkedSets: checked }));
  const wrapped = runner.applyChecked(
    runner.runnerStateFromServed({ family: 'LV2', response: nextResponse({ set, round: taps[3] }), examRule: null }),
    checkedFromPayload({ attemptId: UUID, answers: set.items.map(item => ({ item_id: item.item_id, answer: item.options[0].id })) }, set),
  );
  const markup = renderState(wrapped);
  assert.match(markup, /data-runner-action="next" data-runner-wrap="true"/, 'the next action is marked as the wrap');
  const nextBlock = /data-runner-action="next"[^>]*>([^<]*)</.exec(markup);
  assert.equal(decode(nextBlock[1]), 'Alle Sätze dieses Teils geübt — von vorn', 'the wrap copy replaces the silent restart');
  assert.ok(!markup.includes('>Noch ein Satz<'), 'the silent restart label is gone');
  const actions = runner.runnerActions(wrapped, 'de');
  assert.equal(actions.length, 3);
  assert.equal(actions[0].key, runner.WRAP_KEY);
  assert.deepEqual(actions.map(action => action.action), runner.RUNNER_ACTIONS);

  const third = runner.applyChecked(
    runner.runnerStateFromServed({ family: 'LV2', response: nextResponse({ set, round: taps[2] }), examRule: null }),
    checkedFromPayload({ attemptId: UUID, answers: set.items.map(item => ({ item_id: item.item_id, answer: item.options[0].id })) }, set),
  );
  assert.match(renderState(third), />Noch ein Satz</, 'the third round still offers the next set');
});

/* ------------------------------------------------------------------- 6b. states and honesty */

leg('6b empty, refused and unanswerable sets degrade honestly', async () => {
  const emptyView = runner.createPartRunnerView({ ...CTX, family: 'LV3', api: { practice: { next: async () => ({ ok: true, status: 200, data: { reason: 'nothing_available', set: null } }) } } });
  const host = hostStub();
  await emptyView.mount(host);
  assert.ok(host.innerHTML.includes('data-runner-empty'), 'the empty state names itself');
  assert.equal(emptyView.snapshot().phase, 'empty');

  const failing = runner.createPartRunnerView({ ...CTX, family: 'LV2', api: { practice: { next: async () => ({ ok: false, status: 503, error: 'practice_unavailable' }) } } });
  const host2 = hostStub();
  await failing.mount(host2);
  assert.ok(host2.innerHTML.includes('data-runner-error="practice_unavailable"'), 'the failure is named, not swallowed');
  assert.ok(host2.innerHTML.includes('data-runner-retry'), 'a retry is offered');
  assert.ok(!host2.innerHTML.includes('data-runner-evaluate'), 'no evaluate control over a failed load');

  const broken = runner.runnerStateFromServed({ family: 'LV2', response: nextResponse({ set: { ...dtoSet(), items: [{ prompt: 'ohne id' }] } }), examRule: null });
  assert.equal(broken.blocked, 'item_id', 'an item the server could not mark is refused');
  assert.ok(renderState(broken).includes('data-runner-blocked="item_id"'), 'and it is said on screen');
  const optionless = runner.runnerStateFromServed({ family: 'LV2', response: nextResponse({ set: { ...dtoSet(), items: [{ item_id: '9', prompt: 'ohne Optionen' }] } }), examRule: null });
  assert.equal(optionless.blocked, 'options');
});

/* ------------------------------------------------------------------------- 7. listening */

leg('7 [dto] listening shows the EXAM play rule, posts BOOLEAN answers and disables playback honestly', async () => {
  const set = judgementSet();
  const { host, stub, state } = await runOne({ set, examParts: EXAM_PARTS_FIXTURE, wrongFrom: 1, allCorrect: true });
  const answering = runner.runnerStateFromServed({ family: 'HV2', response: nextResponse({ set }), examRule: { family: 'HV2', section: 'HV', part: 2, playback: { practice: 1, mock: 2 } } });
  const markup = renderState(answering);
  assert.ok(markup.includes('data-runner-audio'), 'the player block is rendered');
  assert.ok(markup.includes('data-runner-player'), 'the player itself is rendered');
  assert.match(markup, /data-playback-mock="2"/, 'the EXAM play rule is the served mock number');
  assert.match(markup, /data-playback-practice="1"/, 'and the practice rule the server will apply is on the block too');
  assert.ok(textOf(markup).includes('Prüfungsregel: 2-mal hören'), 'the exam rule is printed, not the practice one');
  assert.equal(countOf(markup, /data-runner-replay[ >]/g), 0, 'NO replay control before "Auswerten"');
  assert.ok(textOf(markup).includes('Eine Wiederholung ist erst nach dem Auswerten möglich.'));
  const honest = textOf(markup);
  /*
   * FIX-F1 — THE COPY IS LEARNER-FACING NOW, and after POOL-01 the block has TWO honest states. This DTO is a
   * listening set whose recording is NOT bound to any `exam_media` row (the server would refuse to serve it
   * at all — `practiceSetForPart`'s admission rule), so the block says the recording cannot be played here
   * rather than offering a player that cannot start.
   */
  assert.ok(/noch nicht üben/.test(honest), 'it says what the learner cannot do here, in their language');
  assert.ok(!/Wiedergabeweg|Abspielweg|playback path/.test(honest), 'it names no internal path');
  assert.ok(!/nicht vorhanden|existiert nicht|does not exist|no recording/i.test(honest), 'it must never claim the recording is missing');
  /*
   * The served judgement options carry an EMPTY text and boolean values: the control is decided by
   * `answer_kind`, the labels are the exam's own words, and the POSTed answer keeps its type.
   */
  assert.equal(answering.set.items[0].answer_kind, 'judgement', 'the served answer_kind decides the control');
  assert.deepEqual(answering.set.items[0].options.map(option => option.value), [true, false]);
  assert.ok(markup.includes('data-answer-kind="judgement"'), 'the control is a judgement pair');
  assert.deepEqual([...markup.matchAll(/data-answer-key="([^"]+)"/g)].map(m => m[1]), ['true', 'false'], 'exactly the two answers');
  assert.equal(countOf(markup, /data-answer-key="/g), 2, 'a judgement item offers two answers, not more');
  const optionText = textOf(markup);
  assert.ok(optionText.includes('richtig') && optionText.includes('falsch'), 'the empty served text is filled with the exam labels');
  assert.equal(typeof stub.calls.check[0].answers[0].answer, 'boolean', 'a boolean is POSTed, never the string "true"');
  assert.equal(stub.calls.check[0].answers[0].answer, true, 'the option VALUE is posted');
  assert.equal(state.phase, 'review');
  assert.ok(!textOf(host.innerHTML).includes('Eine Wiederholung ist erst nach dem Auswerten möglich.'), 'the pre-review replay rule is gone once reviewed');
  /*
   * A judgement item's explanation is `null` on purpose (the choice-family reader cannot read it), and the
   * review must say something TRUE about that rather than rendering an empty card or "not loaded yet".
   */
  assert.match(host.innerHTML, /data-explanation-status="unavailable"/, 'the missing explanation is named as such');
  assert.ok(textOf(host.innerHTML).includes('Für diese Aufgabe ist keine Erklärung verfügbar.'), 'with the honest copy');
  assert.ok(!textOf(host.innerHTML).includes('noch nicht geladen'), 'and never the "not loaded yet" promise');
  assert.equal(countOf(host.innerHTML, /data-runner-explanation-language/g), 0, 'no language control when there is nothing to re-read');
  assert.equal(countOf(host.innerHTML, /data-explanation-slot/g), 0, 'and no explanation prose is invented');
  assert.equal(countOf(host.innerHTML, /data-runner-action="/g), 3, 'the review is still complete: three actions');
});

/*
 * POOL-01 — THE PRACTICE PLAYBACK TRANSPORT, AS THE RUNNER RENDERS IT.
 *
 * The set below is the shape the release actually serves: `media_required`, a `material.recordings[]` binding
 * and an open sitting. Here the runner must render a REAL player (the mount point the practice player fills),
 * print the ONE-PLAY-BEFORE-"AUSWERTEN" rule instead of the exam allowance line, and never promise a second
 * play before "Auswerten". The mutation proof at the end of this file removes the one-play sentence and this
 * leg must fail by name.
 */
function boundJudgementSet() {
  return {
    ...judgementSet(),
    set_id: 'telc-deutsch-b1.hv1.04', family: 'HV1', section: 'HV', part: 1,
    title: 'Nachrichten von Kolleginnen und Kollegen',
    material: { recordings: [{ id: 'hv1.04-recording', mediaId: 'telc-deutsch-b1.hv1.04.audio', mediaVersion: 'v1', label: 'Nachrichten von Kolleginnen und Kollegen' }] },
  };
}

leg('7e [dto] a listening set with a recording gets a REAL player and the one-play-before-Auswerten rule', () => {
  const set = boundJudgementSet();
  const state = runner.runnerStateFromServed({
    family: 'HV1', response: nextResponse({ set }),
    examRule: { family: 'HV1', section: 'HV', part: 1, playback: { practice: 1, mock: 1 } },
  });
  const markup = renderState(state);
  assert.match(markup, /data-runner-audio-source="practice"/, 'the block declares which path plays it');
  assert.match(markup, /data-audio-state="player"/, 'and that a player is what it is');
  assert.match(markup, /data-listening-mount/, 'the practice player has a mount point');
  assert.ok(!markup.includes('data-runner-playback-missing'), 'the "cannot play here" sentence is not printed for a playable set');
  const text = textOf(markup);
  assert.ok(text.includes('Erster Höreindruck'), 'the ONE-play-before-Auswerten rule is printed');
  assert.ok(text.includes('einmal abspielen'), 'and it says how many plays are available before "Auswerten"');
  assert.ok(text.includes('erst nach „Auswerten“'), 'and what unlocks the rest');
  assert.ok(!/noch nicht üben/.test(text), 'the unavailable sentence is NOT printed for a playable set');
  assert.ok(!/Wiedergabeweg|Abspielweg|playback path/.test(text), 'and no internal path is named');
  /*
   * The STATIC sentence must not offer a play the server would refuse: it may name the sitting's rule (one
   * play, the rest after "Auswerten") but must never borrow the EXAM allowance line, which is a different
   * number and a different rule.
   */
  const ruleSentence = text.slice(text.indexOf('Erster Höreindruck'), text.indexOf('Eine Wiederholung'));
  assert.ok(!/-mal hören/.test(ruleSentence), 'the practice rule does not inherit the exam allowance line');
});

/*
 * THE HONEST SENTENCE, DRIVEN THROUGH THE PLAYER ITSELF. The stub below is the practice transport the server
 * ships: a `ready` sitting with an allowance, `begin`/`pause`/`complete` transitions, and the byte route that
 * only answers while a play is in progress. Every assertion below fails if the client promises a play the
 * server would refuse.
 */
function practicePlaybackStub({ state = 'ready', playsUsed = 0, maxPlays = 1, checked = false, fail = null } = {}) {
  const calls = { read: [], post: [], media: [] };
  let revision = 0;
  const current = {
    media_id: 'telc-deutsch-b1.hv1.04.audio', media_version: 'v1', revision, state, plays_used: playsUsed,
    max_plays: maxPlays, position_ms: 0, duration_ms: 75657, playback_id: state === 'ready' ? null : 'play-1',
    uncertain: false, server_now: '2026-10-05T12:00:00.000Z',
  };
  const api = {
    practice: {
      playback: async (attemptId) => {
        calls.read.push(attemptId);
        if (fail === 'read') return { ok: false, status: 503, error: 'practice_playback_unavailable', data: null };
        return { ok: true, status: 200, data: { items: [{ ...current }], sitting: { attempt_id: attemptId, state: checked ? 'checked' : 'open', checked, plays_used: current.plays_used, replay_used: false } } };
      },
      playbackEvent: async (attemptId, body) => {
        calls.post.push({ attemptId, body });
        if (fail === 'begin') return { ok: false, status: 409, error: 'practice_check_required', data: null };
        if (fail === 'exhausted') return { ok: false, status: 409, error: 'playback_exhausted', data: null };
        if (body.action === 'begin') {
          current.state = 'playing'; current.plays_used += 1; current.playback_id = 'play-' + (++revision);
        } else if (body.action === 'pause') {
          current.state = 'paused'; current.position_ms = body.positionMs;
        } else if (body.action === 'complete') {
          current.state = 'completed'; current.position_ms = current.duration_ms;
        } else if (body.action === 'checkpoint') {
          current.position_ms = body.positionMs;
        }
        current.revision = ++revision;
        return { ok: true, status: 200, data: { playback: { ...current } } };
      },
      media: async (attemptId, mediaId, version) => {
        calls.media.push({ attemptId, mediaId, version });
        return { ok: true, status: 200, data: { size: 1024 } };
      },
    },
  };
  return { api, calls, current };
}

/** A DOM-free audio element, like the s5 client check's: enough for play/pause and the event listeners. */
function fakeAudio() {
  const handlers = new Map();
  return {
    currentTime: 0, paused: true, ended: false, playbackRate: 1, defaultPlaybackRate: 1, preload: '', controls: false,
    addEventListener: (name, handler) => handlers.set(name, handler),
    removeEventListener: (name) => handlers.delete(name),
    setAttribute() {}, removeAttribute() {}, load() {}, remove() {},
    play: async () => { return true; },
    pause() { this.paused = true; },
    fire(name) { handlers.get(name)?.(); },
  };
}

/** Drive the practice player directly, without the runner's DOM, so each state can be inspected. */
async function drivePlayer(binding, stub, overrides = {}) {
  /* Resolved from the RUNNER's own directory, so a mutation copy (--module=<copy>) drives the mutated player. */
  const { createPracticeListeningPlayer } = await import(new URL('./practice-listening.js', pathToFileURL(MODULE_PATH)).href);
  /* The player reads the locale at render time; the copy legs read German, so pin it as the corpus legs do. */
  setLocale('de');
  const player = createPracticeListeningPlayer({
    api: stub.api, esc, getExamLanguage: () => 'de', createAudio: fakeAudio,
    createObjectURL: () => 'blob:test', revokeObjectURL: () => {},
    eventId: (() => { let n = 0; return () => 'event-' + (++n); })(),
    ...overrides,
  });
  return player;
}

leg('7f the practice transport: the client asks for the bytes only AFTER the server acknowledges a play', async () => {
  const stub = practicePlaybackStub({ maxPlays: 1 });
  const clip = { media_id: 'telc-deutsch-b1.hv1.04.audio', media_version: 'v1', label: 'Aufnahme' };
  const player = await drivePlayer({ attemptId: UUID, recording: clip }, stub);
  const host = hostStub('player-host');
  player.mount(host, { attemptId: UUID, recording: clip });
  await tick();
  assert.deepEqual(stub.calls.read, [UUID], 'the sitting is read once on mount');
  assert.equal(stub.calls.post.length, 0, 'and nothing is debited by reading');
  assert.equal(stub.calls.media.length, 0, 'and no bytes are asked for before a play exists');
  assert.ok(textOf(host.innerHTML).includes('Erster Höreindruck'), 'the ready copy is the one-play rule');
  assert.equal(countOf(host.innerHTML, /data-listening-action="play"/g), 1, 'exactly one play control');
  const started = await player.play();
  assert.equal(started, true, 'the first play starts');
  assert.deepEqual(stub.calls.post.map(call => call.body.action), ['begin'], 'begin FIRST');
  assert.equal(stub.calls.media.length, 1, 'and only then the bytes');
  assert.equal(stub.calls.post[0].body.mediaId, clip.media_id, 'the event names the served recording');
  assert.equal(stub.calls.media[0].attemptId, UUID, 'the bytes are addressed by the SITTING, not by the run');
  player.dispose();
});

leg('7g the refused second listen is shown as the server\u2019s own decision, never as an available play', async () => {
  const stub = practicePlaybackStub({ state: 'completed', playsUsed: 1, maxPlays: 2, checked: false, fail: 'begin' });
  const clip = { media_id: 'telc-deutsch-b1.hv1.04.audio', media_version: 'v1', label: 'Aufnahme' };
  const player = await drivePlayer({ attemptId: UUID, recording: clip }, stub);
  const host = hostStub('player-host');
  player.mount(host, { attemptId: UUID, recording: clip });
  await tick();
  const started = await player.play();
  assert.equal(started, false, 'a refused play does not start');
  const text = textOf(host.innerHTML);
  assert.ok(text.includes('erst nach „Auswerten“'), 'the refusal says what unlocks the next play');
  assert.ok(!text.includes('Erster Höreindruck'), 'and never repeats the ready sentence, which would promise a play');
  assert.equal(stub.calls.media.length, 0, 'no bytes are fetched for a play the server refused');
  assert.equal(stub.current.plays_used, 1, 'and the refusal debits nothing');
  player.dispose();
});

leg('7h an exhausted allowance is its own sentence, and the transport refusal keeps the FIX-F1 path', async () => {  const clip = { media_id: 'telc-deutsch-b1.hv1.04.audio', media_version: 'v1', label: 'Aufnahme' };
  const spent = practicePlaybackStub({ state: 'completed', playsUsed: 2, maxPlays: 2, checked: true, fail: 'exhausted' });
  const player = await drivePlayer({ attemptId: UUID, recording: clip }, spent);
  const host = hostStub('player-host');
  player.mount(host, { attemptId: UUID, recording: clip });
  await tick();
  await player.play();
  assert.ok(textOf(host.innerHTML).includes('Hörversuch verbraucht'), 'the spent allowance is named');
  assert.ok(!textOf(host.innerHTML).includes('Erster Höreindruck'), 'and no further play is offered');
  const spentAgain = await player.play();
  assert.equal(spentAgain, false, 'a spent allowance cannot be played again');
  player.dispose();

  /* The transport itself is absent (503 `practice_playback_unavailable`): the FIX-F1 sentence must survive. */
  const refused = practicePlaybackStub({ fail: 'read' });
  const gone = await drivePlayer({ attemptId: UUID, recording: clip }, refused);
  const goneHost = hostStub('player-host');
  gone.mount(goneHost, { attemptId: UUID, recording: clip });
  await tick();
  assert.ok(textOf(goneHost.innerHTML).includes('noch nicht üben'), 'the honest unavailable sentence is printed');
  assert.equal(countOf(goneHost.innerHTML, /data-listening-action="play"/g), 0, 'and no play is offered');
  gone.dispose();
});

/*
 * THE RUNNER ITSELF COMPOSES THE PLAYER. The legs above prove the practice player's own states; this one proves
 * the COMPOSITION the runner owns: a served listening set puts the player into the mount point the audio block
 * carries, the player renders its own control with the practice transport behind it, and no mock route is
 * touched.
 *
 * WHAT THIS LEG DOES NOT PROVE, stated rather than implied: it does not dispatch a real click through the
 * runner's delegated handler (the stub host is not a DOM), and it does not render CSS. The handler's routing is
 * four lines that call `player.play()`; a browser run of `app-browser-check.mjs` against a disposable stack is
 * the evidence for the rendered path, and this offline leg does not replace it.
 */
leg('7i the runner composes the practice player markup into the mount point, with no mock route in the path', async () => {
  const set = boundJudgementSet();
  const playback = practicePlaybackStub({ maxPlays: 1 });
  const mockCalls = [];
  const practiceCalls = { next: [] };
  const api = {
    examParts: { list: async () => ({ ok: true, status: 200, data: { exam_id: 'telc-deutsch-b1', parts: EXAM_PARTS_FIXTURE } }) },
    practice: {
      ...playback.api.practice,
      next: async (family) => { practiceCalls.next.push(family); return nextResponse({ set, family }); },
      check: async (payload) => ({ ok: true, status: 200, data: checkedFromPayload(payload, set, { allCorrect: true }) }),
      explanation: async () => ({ ok: true, status: 200, data: explanationView('de') }),
    },
    mock: {
      playback: async (...args) => { mockCalls.push(['playback', ...args]); return { ok: false, status: 500, error: 'mock_must_not_be_used' }; },
      playbackEvent: async (...args) => { mockCalls.push(['playbackEvent', ...args]); return { ok: false, status: 500, error: 'mock_must_not_be_used' }; },
      media: async (...args) => { mockCalls.push(['media', ...args]); return { ok: false, status: 500, error: 'mock_must_not_be_used' }; },
    },
  };
  const host = hostStub('part-runner-host');
  await runner.createPartRunnerView({ ...CTX, family: 'HV1', examParts: EXAM_PARTS_FIXTURE, api }).mount(host);
  await tick();
  assert.equal(practiceCalls.next[0], 'HV1', 'the runner asked the server for the part');
  assert.match(host.innerHTML, /data-listening-mount/, 'the player mount point is in the audio block');
  /* The player's own subtree, read back from the mount node the runner handed it. */
  const playerMarkup = host.querySelector('[data-listening-mount]').innerHTML;
  assert.match(playerMarkup, /data-listening-action="play"/, 'and the practice player rendered its own control');
  assert.match(playerMarkup, /Erster Höreindruck/, 'with the one-play-before-Auswerten sentence');
  assert.deepEqual(mockCalls, [], 'nothing mocked the run: the block is bound to the practice sitting');
  assert.equal(playback.calls.read[0], UUID, 'the playback state was read for the ATTEMPT the server opened');
  assert.match(host.innerHTML, /data-audio-state="player"/, 'the block reports itself as a player, not as unavailable');
});

/*
 * FIX-F1 — AN EMPTY ANSWER MUST SAY WHICH EMPTY IT IS. `practiceSetForPart` no longer serves a listening part
 * (there is no playback path), so `HV*` arrives as `reason: 'nothing_available'`. "Für diesen Teil ist zurzeit
 * kein Satz verfügbar" would be misleading for a part that HAS released sets; the listening sentence says what
 * is actually going on, and the generic sentence stays for a part that genuinely has no released set.
 */
leg('7c [dto] FIX-F1: an empty LISTENING part says why, and a part with no released set says something else', () => {
  const listening = textOf(renderState({ phase: 'empty', family: 'HV1', section: 'HV', emptyReason: 'listening' }));
  assert.ok(/noch keine Übungen/.test(listening), 'the listening sentence is rendered');
  assert.ok(!/kein Satz verfügbar/.test(listening), 'not the generic "no set" sentence');
  assert.ok(!/Wiedergabeweg|Abspielweg|playback path/.test(listening), 'and it names no internal path');
  const other = textOf(renderState({ phase: 'empty', family: 'LV1', section: 'LV', emptyReason: null }));
  assert.ok(/kein Satz verfügbar/.test(other), 'a reading part with no released set keeps the generic sentence');
  assert.ok(!/noch keine Übungen/.test(other), 'and does not claim to be about listening');
});

leg('7d [dto] the served material is rendered: LV2\'s text and SB1/SB2\'s letter', () => {  const lv2 = renderState(runner.runnerStateFromServed({ family: 'LV2', response: nextResponse({ set: dtoSet() }), examRule: null }));
  assert.match(lv2, /data-runner-material data-material-kind="text"/, 'the reading passage is rendered');
  assert.ok(lv2.includes('Die Stadt Freiburg will den Verkehr'), 'the served passage text is on screen');
  assert.equal(countOf(lv2, /data-runner-material /g), 1, 'once, not per task');
  assert.equal(countOf(lv2, /data-material-kind="text"[\s\S]*?<p>/g), 1, 'the paragraphs are split, not one run-on line');
  const sb1 = renderState(runner.runnerStateFromServed({
    family: 'SB1',
    response: nextResponse({ set: dtoSet({ family: 'SB1', section: 'SB', part: 1, set_id: 'telc-deutsch-b1.sb1.01', material: { letter: 'Liebe Frau Meier,\n\nich schreibe Ihnen wegen des Kurses.' } }) }),
    examRule: null,
  }));
  assert.match(sb1, /data-material-kind="letter"/, 'the letter is rendered');
  const hv = renderState(runner.runnerStateFromServed({ family: 'HV2', response: nextResponse({ set: judgementSet() }), examRule: { family: 'HV2', section: 'HV', part: 2, playback: { practice: 1, mock: 2 } } }));
  assert.ok(!hv.includes('data-runner-material'), 'a listening set has no passage, and the transcript is NOT served');
});

leg('7b a non-listening part renders no audio block at all', () => {
  const state = runner.runnerStateFromServed({ family: 'LV2', response: nextResponse({ set: dtoSet() }), examRule: { family: 'LV2', section: 'LV', part: 2, playback: null } });
  const markup = renderState(state);
  assert.ok(!markup.includes('data-runner-audio'), 'no player on a reading part');
});

leg('7c the exam rule really comes from the parts payload, per family', async () => {
  const stub = stubApi({ set: dtoSet({ family: 'HV1', section: 'HV', media_required: true }), examParts: EXAM_PARTS_FIXTURE });
  const rule = await runner.readExamRule(stub.api, 'HV1', null);
  assert.deepEqual(rule.playback, { practice: 1, mock: 1 }, 'HV1 plays once in the exam');
  const hv2 = await runner.readExamRule(stub.api, 'HV2', null);
  assert.deepEqual(hv2.playback, { practice: 1, mock: 2 }, 'HV2 plays twice in the exam');
  assert.equal((await runner.readExamRule(stub.api, 'LV2', EXAM_PARTS_FIXTURE)).playback, null, 'a reading part carries no play rule');
  const view = runner.createPartRunnerView({ ...CTX, family: 'HV2', api: stub.api });
  const host = hostStub();
  await view.mount(host);
  assert.match(host.innerHTML, /data-playback-mock="2"/, 'the view reads the rule through the parts route when it is not handed one');
});

/* ------------------------------------------------------------------------------ 8. D22 */

const PREDICTION = ['prognose', 'vorhersage', 'wahrscheinlich', 'chance', 'schätzung', 'quote', 'bereitschaft',
  'erfolgsaussicht', 'aussicht', 'readiness', 'forecast', 'predict', 'prediction', 'probability', 'likelihood', 'odds',
  'прогноз', 'ймовірн', 'tahmin', 'olasılık', 'توقع', 'احتمال'];
leg('8 D22: no prediction, readiness or streak surface in any of the five locales', async () => {
  const previous = getLocale();
  const pattern = new RegExp('(?<![\\p{L}\\p{N}])(?:' + PREDICTION.join('|') + ')(?![\\p{L}\\p{N}])', 'iu');
  const offenders = [];
  for (const locale of LOCALES) {
    setLocale(locale);
    const { host } = await runOne({ set: dtoSet(), wrongFrom: 1 });
    const text = textOf(host.innerHTML);
    const hit = pattern.exec(text);
    if (hit) offenders.push(locale + ' -> ' + hit[0]);
    if (/%/.test(text)) offenders.push(locale + ' -> %');
    if (/data-(readiness|streak|prediction|forecast)/.test(host.innerHTML)) offenders.push(locale + ' -> readiness attribute');
  }
  setLocale(previous);
  assert.deepEqual(offenders, [], offenders.join(', '));
});

leg('8b D22: the review reports counts, never a score out of the exam total', async () => {
  const { host } = await runOne({ set: dtoSet(), wrongFrom: 1 });
  const text = textOf(host.innerHTML);
  assert.ok(text.includes('1 von 3 richtig'), 'the count comes from the server verdicts');
  assert.ok(!/\/\s*45|Gesamtpunktzahl|bestanden|nicht bestanden/i.test(text), 'no overall score or pass claim');
});

/* ------------------------------------------------- 9. listening rule leg, then the transport */

leg('9 the transport: next() is unchanged, next(family) adds only ?family=, check() is scoped', async () => {
  const calls = [];
  const api = createApi({
    fetchImpl: async (url, init = {}) => {
      calls.push({ url, method: init.method, body: init.body });
      if (url === '/api/auth/get-session') return { ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => ({ user: { id: 'user-1' } }) };
      return { ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => ({ ok: true }) };
    },
  });
  await api.session();
  assert.equal(api.preparations.select({ id: UUID, state: 'active' }), true, 'a preparation context is selected');
  await api.practice.next();
  assert.equal(calls.at(-1).url, '/api/v1/practice/next?preparationId=' + UUID, 'no-argument next() is byte-identical to before the slice');
  await api.practice.next('LV2');
  assert.equal(calls.at(-1).url, '/api/v1/practice/next?family=LV2&preparationId=' + UUID, 'the family is the only added member');
  await api.practice.next('');
  assert.equal(calls.at(-1).url, '/api/v1/practice/next?preparationId=' + UUID, 'an empty family adds nothing');
  await api.practice.check({ attemptId: UUID, answers: [{ item_id: '6', answer: 'b' }], language: 'de' });
  const check = calls.at(-1);
  assert.equal(check.url, '/api/v1/practice/check', 'the check path');
  assert.equal(check.method, 'POST');
  assert.deepEqual(JSON.parse(check.body), { attemptId: UUID, answers: [{ item_id: '6', answer: 'b' }], language: 'de', preparationId: UUID }, 'preparation-scoped, allowlisted body');
});

leg('9b the runner knows no URL and never fetches on its own', () => {
  /* Comments may NAME the routes; only the code must not know them. */
  const source = fs.readFileSync(MODULE_PATH, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
  assert.ok(!/\bfetch\s*\(/.test(source), 'no raw fetch in the runner');
  assert.ok(!/['"`]\/api\//.test(source), 'no URL literal in the runner');
  assert.ok(source.includes("ctx.api?.practice?.next"), 'the runner goes through the transport layer');
});

leg('9c the runner injects its OWN stylesheet, because the shell only loads the routed module\'s', () => {
  const appended = [];
  const previous = globalThis.document;
  globalThis.document = {
    querySelector: () => null,
    createElement: () => ({ dataset: {} }),
    head: { append: (node) => appended.push(node) },
  };
  try {
    assert.equal(runner.ensureStylesheet(), true, 'the stylesheet is injected');
    assert.equal(appended.length, 1, 'exactly one link');
    assert.match(appended[0].href, /\/public\/app\/part-runner\.css$|\/app\/part-runner\.css$/, 'the module\'s own file');
    assert.equal(appended[0].rel, 'stylesheet');
    assert.equal(appended[0].dataset.moduleStyle, appended[0].href, 'the shell\'s own guard attribute');
    globalThis.document = { querySelector: () => ({}), createElement: () => ({ dataset: {} }), head: { append: () => { throw new Error('duplicate link'); } } };
    assert.equal(runner.ensureStylesheet(), true, 'a second call is a no-op');
  } finally {
    globalThis.document = previous;
  }
  assert.equal(runner.ensureStylesheet(), false, 'no document, no injection (Node)');
});

/* --------------------------------------------------------------------- 10. the composition */

leg('10 the tile opens the runner into the SAME host, and "Zur Auswahl" returns to the index', async () => {
  const indexMarkup = indexModule.indexMarkup({ esc, uiText, examLanguage: 'de', model: indexModule.buildIndexModel({ parts: EXAM_PARTS_FIXTURE, partsSource: 'payload', counts: { source: 'unavailable', parts: null, sections: null } }) });
  const buttons = [...indexMarkup.matchAll(/data-part-open="([A-Za-z0-9]+)"/g)].map(m => m[1]);
  assert.deepEqual(buttons, ['LV2', 'HV1', 'HV2'], 'one open control per tile, carrying the part');
  assert.ok(indexMarkup.includes('Teil üben'), 'the control is labelled');
  for (const forbidden of ['data-set=', 'data-open=', 'data-version=', 'set_id']) assert.ok(!indexMarkup.includes(forbidden), 'still no per-set control: ' + forbidden);

  const stub = stubApi({ set: dtoSet(), examParts: EXAM_PARTS_FIXTURE });
  stub.api.practice.progress = async () => ({ ok: true, status: 200, data: { parts: [{ family: 'LV2', attempts: 2, correct: 1 }] } });
  const host = hostStub('part-index-host');
  const view = indexModule.createPartIndexView({ ...CTX, api: stub.api });
  await view.mount(host);
  assert.ok(host.innerHTML.includes('data-part-index'), 'the index renders first');
  assert.equal(typeof host.onclick, 'function', 'the index is listening for a tile');
  /* The tile's own handler, not a seam: exactly what a click does. */
  host.onclick({ target: { closest: (wanted) => (wanted === '[data-part-open]' ? { dataset: { partOpen: 'LV2' } } : null) } });
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(host.innerHTML.includes('data-part-runner'), 'the runner composed into the SAME host');
  assert.match(host.innerHTML, /data-runner-family="LV2"/, 'the opened part is the tile\'s part');
  assert.ok(!host.innerHTML.includes('data-part-index'), 'the index composed out, no second route');
  assert.equal(stub.calls.next[0], 'LV2', 'the runner asked the server for that part only');
  host.onclick(actionEvent('index'));
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(host.innerHTML.includes('data-part-index'), '"Zur Auswahl" hands the host back to the index');
  assert.ok(host.innerHTML.includes('data-part="LV2"'), 'the index is fully rendered again');
  view.unmount();
  assert.equal(host.innerHTML, '', 'unmount clears the host');
});

/* --------------------------------------------------------------------------- 11. i18n, CSS */

const RUNNER_KEYS = ['partRunnerKicker', 'partRunnerLead', 'partRunnerItem', 'partRunnerProgress', 'partRunnerAnswerAll',
  'partRunnerEvaluate', 'partRunnerEvaluating', 'partRunnerResult', 'partRunnerYourPick', 'partRunnerKey', 'partRunnerCorrect',
  'partRunnerWrong', 'partRunnerUnanswered', 'partRunnerStillOneSet', 'partRunnerPractiseMistakes', 'partRunnerBackToIndex',
  'practiceAllSets', 'partRunnerMistakesRound', 'partRunnerMistakesNone', 'partRunnerMistakesElsewhere', 'partRunnerLoading',
  'partRunnerEmpty', 'partRunnerFailed', 'partRunnerRetry', 'partRunnerCheckFailed', 'partRunnerAlreadyChecked',
  'partRunnerListening', 'partRunnerAudioRule', 'partRunnerAudioUnavailable', 'partRunnerNoReplay', 'partRunnerReplay',
  'partRunnerPlay', 'partRunnerNoOptions', 'partRunnerOpen', 'partRunnerReasonUnseen', 'partRunnerReasonMostWrong',
  'partRunnerReasonOldest', 'partRunnerMaterial', 'partRunnerNoMatch',
  'partRunnerCheckClosed', 'partRunnerCheckArchived', 'partRunnerCheckBlocked', 'partRunnerExplanationUnavailable'];

leg('11 i18n: every new key exists and is non-empty in all five locales, and the German is formal', () => {
  const INFORMAL = /(?<![\p{L}\p{N}])(du|dich|dir|dein|deine|deinem|deinen|deiner|deines|kannst|musst|willst|hast|bist|wirst|weißt|weisst|wähle|waehle|trage|prüfe|pruefe|speichere|verwende|versuche|melde|beginne|schließe|schliesse|höre|hoere|lade|lies|fordere|fülle|fuelle|lass|laß|aktiviere|gib|nutze|warte|nimm|lege|stelle|achte|öffne|oeffne|klicke|rufe|sende|schau|bleib|geh|komm|mach|brauch|zeig|sag|denk|merk|probier)(?![\p{L}\p{N}])/iu;
  for (const key of RUNNER_KEYS) {
    const row = Object.entries(PRACTICE_MESSAGES.de).find(([name]) => name === key);
    assert.ok(row, 'the key exists in the catalogue: ' + key);
    for (const locale of LOCALES) {
      const value = PRACTICE_MESSAGES[locale]?.[key];
      assert.ok(typeof value === 'string' && value.trim(), key + ' is empty in ' + locale);
    }
  }
  const informal = RUNNER_KEYS.filter(key => INFORMAL.test(PRACTICE_MESSAGES.de[key]));
  assert.deepEqual(informal, [], 'informal address in: ' + informal.join(', '));
  assert.equal(PRACTICE_MESSAGES.de.practiceAllSets, 'Alle Sätze dieses Teils geübt — von vorn');
  assert.equal(PRACTICE_MESSAGES.en.practiceAllSets, 'Every set of this part practised — start over');
});

leg('11b the stylesheet: design tokens only, module-scoped, no breakpoint of its own', () => {
  const css = fs.readFileSync(CSS_PATH, 'utf8');
  assert.ok(!/#[0-9a-fA-F]{3,8}\b/.test(css), 'no raw colour');
  assert.ok(!/\brgba?\(|\bhsla?\(/.test(css), 'no raw colour function');
  assert.ok(!/font-family/.test(css), 'no second brand face');
  const breakpoints = [...css.matchAll(/@media[^{]*?(\d+)px/g)].map(m => m[1]);
  assert.deepEqual([...new Set(breakpoints)], ['860'], 'only the design system breakpoint');
  const tokens = new Set([...read('public/assets/design/hatoove.css').matchAll(/--([a-z0-9-]+)\s*:/g)].map(m => m[1]));
  const used = [...new Set([...css.matchAll(/var\(--([a-z0-9-]+)\)/g)].map(m => m[1]))];
  const undefined_ = used.filter(token => !tokens.has(token));
  assert.deepEqual(undefined_, [], 'undefined tokens: ' + undefined_.join(', '));
  assert.ok(used.length >= 8, 'the layer really uses the design system');
  const scoped = [...css.matchAll(/^\.([a-z-]+)/gm)].map(m => m[1]);
  assert.ok(scoped.every(name => name.startsWith('part-runner')), 'every rule is module-scoped: ' + scoped.filter(n => !n.startsWith('part-runner')).join(', '));
});

/* --------------------------------- 12. the required DTO over the real corpus (0010 + 0022) */

/** Every `objective_set` row of ONE migration. The corpus is NOT all in 0010 (contract A9). */
function parseStoredSets(sql) {
  const start = sql.indexOf('INSERT INTO "__SCHEMA__".objective_set');
  assert.ok(start > 0, 'the objective_set insert is in the migration');
  const end = sql.indexOf('ON CONFLICT', start);
  const body = sql.slice(start, end > 0 ? end : sql.length);
  const rows = [...body.matchAll(/\(\s*'([^']+)',\s*'v1',\s*'([^']+)',\s*'([A-Z]+[0-9])',\s*'([A-Z]+)',\s*(\d+),\s*'((?:[^']|'')*)',\s*'(\{.*?\})'::jsonb,\s*(\d+),\s*(true|false),\s*'([^']+)'\)/gs)];
  return rows.map(m => ({
    set_id: m[1], family: m[3], section: m[4], part: Number(m[5]), title: m[6].replace(/''/g, "'"),
    payload: JSON.parse(m[7]), item_count: Number(m[8]), media_required: m[9] === 'true',
  }));
}
function parseStoredKeys(sql) {
  const start = sql.indexOf('INSERT INTO "__SCHEMA__".objective_key');
  assert.ok(start > 0, 'the objective_key insert is in the migration');
  const body = sql.slice(start);
  return new Map([...body.matchAll(/\('([^']+)',\s*'v1',\s*'(\{.*?\})'::jsonb,\s*'(\{.*?\})'::jsonb,\s*(?:NULL|'[^']*')\)/gs)].map(m => [m[1], JSON.parse(m[2])]));
}

/** The DTO the server builds from one stored payload — mirrored from `server/practice-sets.mjs`
 *  (`optionEntry`, `authoredOptions`, `normalisePracticeSet`): typed `value`, `answer_kind`, `material`.
 *  NOTE the honest limit kept from the review: this is a REPLICA, so leg 12d proves the client and the
 *  server AGREE; that either is right against the corpus is carried by 12b, whose facts come from
 *  `objective_key` and the migration itself. */
function requiredDto(stored) {
  const payload = stored.payload;
  const member = ['items', 'texts', 'questions', 'situations', 'gaps'].find(name => Array.isArray(payload[name]) && payload[name].length);
  assert.ok(member, stored.set_id + ': a known item member');
  const banks = [{ member: 'headlines', text: 'text' }, { member: 'ads', text: 'text' }, { member: 'bank', text: 'word' }];
  const optionEntry = (id, text, value) => ({ id: String(id), text: typeof text === 'string' ? text : '', value: value === undefined ? String(id) : value });
  const requiredOptions = (item) => {
    if (item.options && typeof item.options === 'object' && !Array.isArray(item.options)) {
      return Object.entries(item.options).map(([id, text]) => optionEntry(id, text));
    }
    const bank = banks.find(candidate => Array.isArray(payload[candidate.member]) && payload[candidate.member].length);
    if (bank) {
      const options = payload[bank.member].map(row => optionEntry(row?.id ?? '', row?.[bank.text]));
      if (bank.member === 'ads' && !options.some(option => option.id === 'x')) options.push({ id: 'x', text: '', value: 'x' });
      return options;
    }
    if (typeof item.statement === 'string') return [optionEntry('true', '', true), optionEntry('false', '', false)];
    return [];
  };
  const items = payload[member].map((item, index) => {
    /*
     * Mirrors the server's `PROMPT_FIELDS`, which now reads `prompt` FIRST. The `0022` grammar drill's twelve
     * sentences live in `prompt` and the server previously dropped them (12 authored, 0 served); task-25
     * fixed the field list, and leg 12d caught the difference the moment the fix merged — which is what this
     * cross-check is for. The order matters: `prompt` first, then the 0010 shapes.
     */
    const promptField = ['prompt', 'question', 'statement', 'text'].find(field => typeof item[field] === 'string');
    const options = requiredOptions(item).filter(option => option.id);
    return {
      item_id: String(item.id ?? item.n),
      ordinal: Number.isInteger(item.ordinal) ? item.ordinal : index + 1,
      prompt: promptField ? item[promptField] : '',
      prompt_en: typeof item.prompt_en === 'string' ? item.prompt_en : null,
      answer_kind: options.some(option => typeof option.value === 'boolean') ? 'judgement' : 'choice',
      options,
    };
  });
  const material = Object.fromEntries(['text', 'letter', 'headlines', 'ads', 'bank', 'practice_kind', 'instruction', 'recordings']
    .filter(name => payload[name] !== undefined).map(name => [name, payload[name]]));
  return {
    set_id: stored.set_id, version: 'v1', title: stored.title, family: stored.family, section: stored.section,
    /* `part: nonEmpty(row.part)` in the server is null for the integer column (amendment A6's gap). */
    part: null, item_count: stored.item_count, media_required: stored.media_required, playback: null, material, items,
  };
}

/*
 * EVERY MIGRATION THAT TOUCHES OBJECTIVE CONTENT, discovered rather than listed: the corpus legs used to name
 * `0010` and the `0022` drill explicitly, which made them correct for exactly those two files and silently
 * blind to the next content migration — the same failure mode `bootstrap.mjs` records for the fixture. POOL-01
 * batch 1 (`0047`) is the first migration that would have been missed. Discovery means a future batch is
 * covered the moment it lands; `POOL_FIGURES` below is the documented expectation that then fails loudly, so
 * the pool can never change without this check being updated on purpose.
 *
 * A RELEASE DOES NOT HAVE TO BE AN INSERT. A later batch can release a held set by flipping a flag with
 * `UPDATE … objective_set` rather than re-inserting it, so discovery matches an INSERT **or** an UPDATE on that
 * table — and leg 12 refuses to let such a file be parsed into zero sets unless it is declared in
 * `RELEASE_ONLY_MIGRATIONS` with its reason. Silence is what this guards against, not a shape.
 */
const touchesObjectiveSet = (sql) => /INSERT INTO "__SCHEMA__"\.objective_set|UPDATE\s+"__SCHEMA__"\.objective_set/.test(sql);
const OBJECTIVE_MIGRATIONS = fs.readdirSync(path.join(root, 'server', 'migrations'))
  .filter((name) => /^\d{4}-.*\.sql$/.test(name))
  .filter((name) => touchesObjectiveSet(fs.readFileSync(path.join(root, 'server', 'migrations', name), 'utf8')))
  .sort();
/** Migrations that touch `objective_set` WITHOUT publishing a new set (a pure release or flag change).
 *  Declaring one here is a decision with a reason, because the corpus legs cannot see inside it. */
const RELEASE_ONLY_MIGRATIONS = Object.freeze([]);
const migrationText = (name) => fs.readFileSync(path.join(root, 'server', 'migrations', name), 'utf8');
/**
 * ONE ROW PER SET, EVEN WHEN A LATER MIGRATION REPLAYS AN EARLIER ONE'S ROWS.
 *
 * `0048-pool-01-listening-release.sql` is generated from the same batch source as 0047, so it carries the
 * three LV1 sets again — a no-op in the database (`ON CONFLICT … DO NOTHING`), and `tools/pool-01-check.mjs`
 * asserts the replayed rows are byte-identical to the ones 0047 applied, so the replay cannot be a silent
 * edit. The CORPUS view here is one row per set, because a replayed row is not a second set: without this
 * the pool would read 34 sets with LV1 at nine. The FIRST migration that published a set wins, which is the
 * one that actually applied it on a fresh database.
 */
const STORED_SETS = (() => {
  const byId = new Map();
  for (const name of OBJECTIVE_MIGRATIONS) {
    for (const stored of parseStoredSets(migrationText(name))) if (!byId.has(stored.set_id)) byId.set(stored.set_id, stored);
  }
  return [...byId.values()];
})();
const STORED_KEYS = new Map(OBJECTIVE_MIGRATIONS.flatMap((name) => [...parseStoredKeys(migrationText(name))]));
/**
 * The RELEASED pool per part, as `work/implementation/POOL-01-INVENTORY.md` records it.
 *
 * POOL-01 batch 1 (tasks 37 + 48) releases SIX sets. The three LV1 sets were imported by
 * `0047-pool-01-batch-1.sql`; the three listening sets were authored and HELD until their recordings existed,
 * and task-48 built them and released all three through `0048-pool-01-listening-release.sql` — which also
 * carries the `exam_media` rows their `recordings[]` bindings resolve against. So each HV part now has its
 * seeded three PLUS one released batch set, and the pool is 31 sets.
 */
const POOL_FIGURES = Object.freeze({ LV1: 6, LV2: 3, LV3: 3, SB1: 4, SB2: 3, HV1: 4, HV2: 4, HV3: 4 });
/** The key values the payload's own options cannot reach. The server resolves LV3's "no ad fits" with the
 *  `x` sentinel, so this is EMPTY; a non-empty map means a part whose key can never be given correctly. */
const EXPECTED_UNREACHABLE = {};
/** The drill, by id: contract A9's fourth SB1 set. */
export const DRILL_ID = 'telc-deutsch-b1.sb1.grammar-wortstellung-v1';
const DRILL = STORED_SETS.find(stored => stored.set_id === DRILL_ID) ?? null;
const POOL_TOTAL = Object.values(POOL_FIGURES).reduce((total, sets) => total + sets, 0);

leg('12 corpus: every migration that publishes content is parsed, and the pool matches the inventory', () => {
  assert.deepEqual(OBJECTIVE_MIGRATIONS, ['0010-objective-catalogue.sql', '0022-recovered-grammar-drills.sql', '0047-pool-01-batch-1.sql', '0048-pool-01-listening-release.sql'],
    'the content-publishing migrations, discovered from the directory (INSERT or UPDATE on objective_set)');
  /* A migration that touches objective_set but yields no parsed set must be a DECLARED release-only change:
     this is what makes a release done by UPDATE visible instead of silently uncovered. */
  const silent = OBJECTIVE_MIGRATIONS.filter((name) => parseStoredSets(migrationText(name)).length === 0
    && !RELEASE_ONLY_MIGRATIONS.includes(name));
  assert.deepEqual(silent, [], 'a migration that touches objective_set but publishes no set must be declared in RELEASE_ONLY_MIGRATIONS');
  assert.equal(STORED_SETS.length, POOL_TOTAL, `the released pool is ${POOL_TOTAL} sets`);
  assert.equal(STORED_KEYS.size, STORED_SETS.length, 'one key row per set');
  const perFamily = {};
  for (const stored of STORED_SETS) perFamily[stored.family] = (perFamily[stored.family] ?? 0) + 1;
  assert.deepEqual(perFamily, POOL_FIGURES, 'the released sets per part (POOL-01-INVENTORY.md)');
  assert.ok(DRILL, 'the migration-0022 drill is in the corpus: ' + DRILL_ID);
  assert.equal(DRILL.family, 'SB1', 'the drill belongs to SB1');
  assert.equal(DRILL.item_count, 12, 'the drill has twelve items');
  assert.equal(DRILL.item_count, DRILL.payload.gaps.length, 'the declared count matches the authored rows');
  assert.equal(DRILL.payload.practice_kind, 'grammar-drill', 'the drill is labelled as practice, not an exam set');
  assert.match(DRILL.payload.instruction ?? '', /kein telc/, 'the drill carries its own disclosure');
  /* POOL-01 batch 1: all six authored sets are released — three LV1 (0047) and the three listening sets (0048). */
  for (const setId of ['telc-deutsch-b1.lv1.04', 'telc-deutsch-b1.lv1.05', 'telc-deutsch-b1.lv1.06']) {
    assert.ok(STORED_SETS.some((stored) => stored.set_id === setId), `${setId} is in the released pool`);
  }
  for (const setId of ['telc-deutsch-b1.hv1.04', 'telc-deutsch-b1.hv2.04', 'telc-deutsch-b1.hv3.04']) {
    const stored = STORED_SETS.find((entry) => entry.set_id === setId);
    assert.ok(stored, `${setId} is RELEASED (task-48): the authored listening set is in the pool, not held`);
    assert.equal(stored.media_required, true, `${setId}: released as audio material`);
    /*
     * A RELEASED LISTENING SET MUST CARRY ITS AUDIO BINDING. The runner's playback path resolves
     * `material.recordings[].mediaId` against `exam_media`; a released set with items and no recording is a
     * Hörverstehen task that cannot be heard, which is exactly what 'held' existed to prevent.
     */
    assert.ok(Array.isArray(stored.payload.recordings) && stored.payload.recordings.length === 1,
      `${setId}: the released set carries its recordings[] binding`);
    assert.equal(stored.payload.recordings[0].mediaId, `${setId}.audio`, `${setId}: bound to its own recording`);
  }
  /* The listening half is imported by 0048, and the LV1 half by the frozen 0047 — not by the same file. */
  for (const setId of ['telc-deutsch-b1.hv1.04', 'telc-deutsch-b1.hv2.04', 'telc-deutsch-b1.hv3.04']) {
    assert.ok(migrationText('0048-pool-01-listening-release.sql').includes(`'${setId}'`), `${setId} comes from 0048`);
    assert.ok(!migrationText('0047-pool-01-batch-1.sql').includes(`'${setId}'`), `${setId} must NOT be in the frozen 0047`);
  }
  console.log(`      corpus: ${POOL_TOTAL} sets from ${OBJECTIVE_MIGRATIONS.length} migration(s); SB1: 4; drill=${DRILL_ID} (practice_kind=grammar-drill)`);
});

leg('12b [dto] the served DTO reaches every answer key, every ITEM, for all ' + STORED_SETS.length + ' sets', () => {
  const unreachableBySet = {};
  const kinds = new Set();
  for (const stored of STORED_SETS) {
    const dto = requiredDto(stored);
    const answers = STORED_KEYS.get(stored.set_id);
    assert.ok(answers, 'a key row exists for ' + stored.set_id);
    const keyIds = Object.keys(answers);
    assert.deepEqual(dto.items.map(item => item.item_id), keyIds, stored.set_id + ': the item ids ARE the answer keys, in order');
    assert.equal(dto.items.length, stored.item_count, stored.set_id + ': the item count matches');
    for (const item of dto.items) {
      assert.ok(item.options.length >= 2, stored.set_id + '/' + item.item_id + ': at least two options');
      assert.ok(item.options.every(option => option.id && (option.text || item.answer_kind === 'judgement' || option.id === 'x')), stored.set_id + '/' + item.item_id + ': every option has an id, and a text unless it is a known sentinel');
      assert.ok(['choice', 'judgement'].includes(item.answer_kind), stored.set_id + ': answer_kind is the server\'s literal');
      kinds.add(item.answer_kind);
      /* The TYPE is the contract: a judgement answer must not be a string, or the key can never be matched. */
      if (item.answer_kind === 'judgement') assert.ok(item.options.every(option => typeof option.value === 'boolean'), stored.set_id + ': judgement values are booleans');
      else assert.ok(item.options.every(option => typeof option.value === 'string'), stored.set_id + ': choice values are strings');
      /* EVERY item, not just the first: a later item with a smaller option set could hold an unreachable key
         (review F3). The key must be offered by THIS item's own options. */
      const offered = new Set(item.options.map(option => String(option.id)));
      const key = answers[item.item_id];
      if (key !== undefined && !offered.has(String(key))) {
        (unreachableBySet[stored.set_id] ||= []).push(item.item_id + '=' + String(key));
      }
    }
    /* The material the three passage families need. */
    if (['LV2'].includes(stored.family)) assert.ok(typeof dto.material.text === 'string' && dto.material.text, stored.set_id + ': material.text');
    if (['SB1', 'SB2'].includes(stored.family)) assert.ok(typeof dto.material.letter === 'string' && dto.material.letter, stored.set_id + ': material.letter');
    if (stored.section === 'HV') assert.ok(!('script' in dto.material) && !('script' in dto), stored.set_id + ': the transcript is NOT served');
    /* The drill's disclosure travels INSIDE material (server/practice-sets.mjs MATERIAL_MEMBERS). */
    if (stored.set_id === DRILL_ID) {
      assert.equal(dto.material.practice_kind, 'grammar-drill', stored.set_id + ': material.practice_kind');
      assert.match(dto.material.instruction ?? '', /kein telc/, stored.set_id + ': material.instruction');
    }
  }
  assert.deepEqual([...kinds].sort(), ['choice', 'judgement'], 'both answer kinds occur in the corpus');
  assert.deepEqual(unreachableBySet, EXPECTED_UNREACHABLE, 'every answer key is reachable from ITS OWN item\'s options');
});

/**
 * The cross-slice guard, ALWAYS ACTIVE (review F2).
 *
 * `SERVER_SETS_PATH` defaults to the repository's own `server/practice-sets.mjs`, so no flag is needed at
 * integration; `--server=<path>` only repoints it. When the file cannot serve the corpus the leg FAILS with
 * the reason, because a guard that silently stops running is worse than no guard.
 */
leg('12d [dto] the served DTO equals the SERVER normaliser over all ' + STORED_SETS.length + ' stored sets (' + path.basename(path.dirname(SERVER_SETS_PATH)) + '/' + path.basename(SERVER_SETS_PATH) + ')', async () => {
  let server;
  try {
    server = await import(pathToFileURL(SERVER_SETS_PATH).href);
  } catch (error) {
    assert.fail('the normaliser ' + SERVER_SETS_PATH + ' could not be imported: ' + String(error && error.message));
  }
  assert.equal(typeof server.normalisePracticeSet, 'function', SERVER_SETS_PATH + ' must export normalisePracticeSet');
  /* The default really is the repository's own file: a future refactor cannot repoint the guard at a copy. */
  if (!arg('server')) assert.equal(path.resolve(SERVER_SETS_PATH), path.resolve(SETS_PATH), 'with no --server the guard drives the repository normaliser');
  for (const stored of STORED_SETS) {
    let served;
    try {
      served = server.normalisePracticeSet({ ...stored, version: 'v1' }, null);
    } catch (error) {
      assert.fail(stored.set_id + ': the normaliser at ' + SERVER_SETS_PATH + ' refused the stored payload ('
        + String(error && error.message) + '). If that file is the repository copy from BEFORE the'
        + ' practice-01-pg fixes, this failure is the guard telling the truth: integrate the server branch.'
        + ' Meanwhile, `--server=<path to the fixed normaliser>` points the guard at it without disarming it.');
    }
    assert.deepEqual(served, requiredDto(stored), stored.set_id + ': the served DTO equals the client\'s expectation');
  }
});

leg('12e [dto] the migration-0022 drill renders, and the corpus\'s drift from the server field list is pinned', () => {
  assert.ok(DRILL, 'the drill is in the corpus');
  const dto = requiredDto(DRILL);
  assert.equal(dto.items.length, 12, 'twelve tasks');
  assert.equal(dto.items.reduce((sum, item) => sum + item.options.length, 0), 36, 'three options each');
  assert.deepEqual(dto.items.map(item => item.item_id), Object.keys(STORED_KEYS.get(DRILL_ID)), 'the ids are the drill\'s answer keys');
  assert.equal(typeof dto.material.letter, 'string', 'the drill carries its letter');
  const state = runner.runnerStateFromServed({ family: 'SB1', response: nextResponse({ family: 'SB1', set: dto }), examRule: null });
  const markup = renderState(state);
  assert.equal(state.blocked, null, 'the drill renders');
  assert.equal(countOf(markup, /data-item-id="/g), 12, 'every one of the twelve tasks');
  assert.equal(countOf(markup, /data-answer-item="/g), 36, 'every option');
  assert.equal(countOf(markup, /data-runner-evaluate[ >]/g), 1, 'one evaluate control');

  /*
   * The gap is CLOSED (task-25): the server's `PROMPT_FIELDS` now reads `prompt`, so the served DTO carries
   * all twelve sentences. The leg asserts the invariant that matters — served equals authored — rather than
   * a frozen count, so a future field-list change fails here instead of silently emptying a shipped set.
   */
  const authoredPrompts = DRILL.payload.gaps.map(gap => (typeof gap.prompt === 'string' ? gap.prompt.trim() : '')).filter(Boolean);
  assert.equal(authoredPrompts.length, 12, 'every authored drill item carries a prompt');
  const servedPrompts = dto.items.map(item => item.prompt).filter(Boolean);
  assert.deepEqual(servedPrompts, authoredPrompts, 'the served prompts are the authored ones, in order');
  const bridged = runner.readServedItems({ family: 'SB1', payload: DRILL.payload, items: undefined });
  assert.equal(bridged.items.length, 12, 'the bridge reads the authored payload');
  assert.ok(bridged.items.every(item => item.prompt), 'and the client renders the authored prompt when the payload carries it');
  console.log('      drill: 12 items, 36 options, material.letter present; prompts served == authored (12/12)');
});

leg('12f [dto] the drill\'s disclosure is echoed when the served set carries one (A9(c): labelled, not filtered)', () => {
  /* A set with NO disclosure invents nothing. */
  const plain = renderState(runner.runnerStateFromServed({ family: 'LV2', response: nextResponse({ set: dtoSet() }), examRule: null }));
  assert.ok(!plain.includes('data-runner-disclosure'), 'nothing is invented when the server serves no disclosure');
  /* The drill's DTO always carries it now: the server serves the disclosure inside `material` (905cc89). */
  const dto = requiredDto(DRILL);
  assert.equal(dto.material.practice_kind, 'grammar-drill', 'the DTO carries the kind');
  const markup = renderState(runner.runnerStateFromServed({ family: 'SB1', response: nextResponse({ family: 'SB1', set: dto }), examRule: null }));
  assert.match(markup, /data-runner-disclosure data-runner-practice-kind="grammar-drill"/, 'the drill is labelled with the served kind');
  assert.ok(textOf(markup).includes('kein telc'), 'the authored instruction reaches the learner');
  assert.match(markup, /data-runner-instruction[^>]*lang="de"/, 'the instruction stays an exam-language island');
  /* A top-level disclosure (the shape before the server move) still renders: the bridge, not the contract. */
  const topLevel = renderState(runner.runnerStateFromServed({ family: 'SB1', response: nextResponse({ family: 'SB1', set: { ...dto, material: {}, practice_kind: 'grammar-drill', instruction: 'kein telc-Prüfungssatz' } }), examRule: null }));
  assert.match(topLevel, /data-runner-practice-kind="grammar-drill"/, 'the top-level fallback still works');
});

leg('12c [dto] the client renders the required DTO for every one of the ' + STORED_SETS.length + ' sets', () => {
  for (const stored of STORED_SETS) {
    const dto = requiredDto(stored);
    const state = runner.runnerStateFromServed({
      family: stored.family,
      response: nextResponse({ set: dto, family: stored.family }),
      examRule: stored.section === 'HV' ? { family: stored.family, section: 'HV', part: stored.part, playback: { practice: 1, mock: 2 } } : { family: stored.family, section: stored.section, part: stored.part, playback: null },
    });
    const markup = renderState(state);
    assert.equal(state.blocked, null, stored.set_id + ': the DTO is renderable');
    assert.equal(countOf(markup, /data-item-id="/g), dto.items.length, stored.set_id + ': every task');
    assert.equal(countOf(markup, /data-runner-evaluate[ >]/g), 1, stored.set_id + ': one evaluate control');
    const pickers = ['LV1', 'LV3', 'SB2'].includes(stored.family);
    assert.equal(countOf(markup, /data-answer-item="/g), pickers ? dto.items.length : dto.items.reduce((sum, item) => sum + item.options.length, 0), stored.set_id + ': every task is answerable');
    for (const item of dto.items) for (const option of item.options) {
      assert.ok(markup.includes('value="' + option.id + '"'), stored.set_id + '/' + item.item_id + ': option is selectable');
    }
    if (stored.section === 'HV') assert.ok(markup.includes('data-runner-audio'), stored.set_id + ': listening block');
  }
});

/* ----------------------------------------------------- 13. the rendering bridge (labelled) */

leg('13 [bridge] the AUTHORED per-item shapes still render, so no family is a blank page', () => {
  const stubs = [
    { label: 'LV2 questions + options object', family: 'LV2', section: 'LV', payload: { title: 't', text: 'x', questions: [{ n: 6, question: 'W?', options: { a: 'A', b: 'B', c: 'C' } }] }, expect: { id: '6', prompt: 'W?', options: 3 } },
    { label: 'LV1 texts + headlines', family: 'LV1', section: 'LV', payload: { title: 't', headlines: [{ id: 'a', text: 'A' }, { id: 'b', text: 'B' }], texts: [{ id: '1', text: 'Anzeige' }] }, expect: { id: '1', prompt: 'Anzeige', options: 2 } },
    { label: 'LV3 situations + ads', family: 'LV3', section: 'LV', payload: { ads: [{ id: 'a', text: 'A' }, { id: 'b', text: 'B' }], situations: [{ n: 11, text: 'Sie ziehen um.' }] }, expect: { id: '11', prompt: 'Sie ziehen um.', options: 2 } },
    { label: 'SB1 gaps + options object', family: 'SB1', section: 'SB', payload: { letter: 'x', gaps: [{ n: 21, options: { a: 'haben', b: 'sind', c: 'werden' } }] }, expect: { id: '21', prompt: '', options: 3 } },
    { label: 'SB2 gaps + bank with word', family: 'SB2', section: 'SB', payload: { letter: 'x', bank: [{ id: 'a', word: 'DESHALB' }, { id: 'b', word: 'TROTZDEM' }], gaps: [{ n: 31 }] }, expect: { id: '31', prompt: '', options: 2 } },
    { label: 'HV items + statement', family: 'HV1', section: 'HV', payload: { title: 't', items: [{ n: 41, statement: 'Anna kann nicht.' }] }, expect: { id: '41', prompt: 'Anna kann nicht.', options: 2 } },
  ];
  for (const stub of stubs) {
    const state = runner.runnerStateFromServed({
      family: stub.family,
      response: nextResponse({ family: stub.family, set: { set_id: 's', version: 'v1', title: 't', family: stub.family, section: stub.section, part: 1, item_count: 1, media_required: stub.section === 'HV', playback: null, payload: stub.payload } }),
      examRule: { family: stub.family, section: stub.section, part: 1, playback: stub.section === 'HV' ? { practice: 1, mock: 1 } : null },
    });
    assert.equal(state.blocked, null, stub.label + ': renders');
    assert.equal(state.set.items[0].item_id, stub.expect.id, stub.label + ': the id comes from id/n');
    assert.equal(state.set.items[0].prompt, stub.expect.prompt, stub.label + ': the prompt comes from question/statement/text');
    assert.equal(state.set.items[0].options.length, stub.expect.options, stub.label + ': the options come from the item or the set list');
    assert.ok(textOf(renderState(state)).length > 0, stub.label + ': the page is not blank');
  }
  // The HV bridge must POST booleans, because mark_objective_item compares JSONB.
  const hv = runner.readServedItems({ family: 'HV1', items: [{ n: 41, statement: 'x' }] });
  assert.deepEqual(hv.items[0].options.map(option => option.value), [true, false], 'richtig/falsch post as booleans');
  assert.deepEqual(runner.readOptions({ a: 'A' }).map(option => option.value), ['a'], 'a letter option posts its letter');
  assert.deepEqual(runner.readOptions([{ id: 'a', word: 'W' }]).map(option => option.text), ['W'], 'word is read as the option text');
});

leg('13b [bridge] a served set that cannot be answered is refused, never half rendered', () => {
  const noId = runner.readServedItems({ items: [{ prompt: 'x', options: { a: 'A' } }] });
  assert.deepEqual(noId, { items: [], blocked: 'item_id' });
  const noOptions = runner.readServedItems({ items: [{ item_id: '1', prompt: 'x' }] });
  assert.deepEqual(noOptions, { items: [], blocked: 'options' });
});

/* ------------------------------------------- 14. a refused "Auswerten" is an ERROR (review F1) */

/** Mount, answer every task, and post a CHECK response the caller chooses. */
async function runCheckFailure(checkResponse, { set = dtoSet(), existingReview = false } = {}) {
  const stub = stubApi({ set });
  let calls = 0;
  const api = { ...stub.api, practice: { ...stub.api.practice, check: async (payload) => { calls++; return checkResponse(payload); } } };
  const host = hostStub();
  const view = runner.createPartRunnerView({ ...CTX, family: set.family, examParts: EXAM_PARTS_FIXTURE, api });
  await view.mount(host);
  for (const item of set.items) host.onchange(answerEvent(item.item_id, item.options[0].id));
  if (existingReview) await view.evaluate();
  await view.evaluate();
  return { host, view, stub, state: view.snapshot(), calls };
}
const checkFails = (status, error) => () => ({ ok: false, status, error, data: null });
const checkPasses = (set) => (payload) => ({ ok: true, status: 200, data: checkedFromPayload(payload, set) });
const recoverEvent = (name) => ({ target: { closest: (wanted) => (wanted === '[data-runner-recover]' ? { dataset: { runnerRecover: name } } : null) } });
const tick = () => new Promise(resolve => setImmediate(resolve));

leg('14 a transport/5xx check failure is RETRYABLE: alert, retry promise, "Auswerten" still the retry', async () => {
  const { host, state } = await runCheckFailure(checkFails(0, 'network'));
  assert.equal(state.checkFailure.kind, 'retryable');
  assert.equal(state.phase, 'answering');
  assert.match(host.innerHTML, /role="alert"[^>]*data-runner-check-error="network"/, 'the failure is an ALERT, not a muted notice');
  assert.match(host.innerHTML, /data-runner-check-error="network"/);
  assert.match(host.innerHTML, /data-retryable="true"/);
  assert.ok(textOf(host.innerHTML).includes('bitte versuchen Sie es erneut'), 'the retry promise is shown where a retry can succeed');
  assert.equal(countOf(host.innerHTML, /data-runner-recovery/g), 0, 'no recovery row when retrying is right');
  assert.match(host.innerHTML, /data-runner-evaluate-ready="true"/, 'the Auswerten control IS the retry');
  assert.equal(countOf(host.innerHTML, /data-runner-action="/g), 0, 'still no post-review actions before a review');
  assert.equal(countOf(host.innerHTML, /data-item-id="/g), 3, 'the answers stay on the page');
});

leg('14b a 5xx failure is retryable too, and a 404 is NOT: the copy stops promising a retry', async () => {
  const retry = await runCheckFailure(checkFails(503, 'practice_unavailable'));
  assert.equal(retry.state.checkFailure.kind, 'retryable');
  const blocked = await runCheckFailure(checkFails(404, 'not_found'));
  assert.equal(blocked.state.checkFailure.kind, 'blocked');
  assert.match(blocked.host.innerHTML, /role="alert"[^>]*data-runner-check-error="not_found"/, 'still an alert');
  assert.match(blocked.host.innerHTML, /data-retryable="false"/);
  assert.ok(!textOf(blocked.host.innerHTML).includes('versuchen Sie es erneut'), 'the copy promises NO retry that cannot succeed');
  assert.ok(textOf(blocked.host.innerHTML).includes('Ihre Antworten bleiben auf dieser Seite erhalten.'), 'and says what is true');
  assert.match(blocked.host.innerHTML, /data-runner-evaluate-ready="false"[^>]*disabled/, '"Auswerten" is disabled, so the learner is not invited to loop');
  assert.match(blocked.host.innerHTML, /data-runner-recovery/, 'two ways forward are offered');
  assert.deepEqual([...blocked.host.innerHTML.matchAll(/data-runner-recover="([a-z]+)"/g)].map(m => m[1]), ['next', 'index'], 'and they are the two that can work');
  assert.equal(countOf(blocked.host.innerHTML, /data-runner-action="/g), 0, 'the post-review actions stay reserved for a review');
});

leg('14c 409 with NO review: the sitting is closed, so say so — do not loop, do not promise a retry', async () => {
  const { host, stub, state, calls } = await runCheckFailure(checkFails(409, 'attempt_already_checked'));
  assert.equal(state.checkFailure.kind, 'closed');
  assert.equal(calls, 1, 'the check was attempted exactly once, and no loop follows');
  assert.match(host.innerHTML, /role="alert"[^>]*data-runner-check-error="attempt_already_checked"/);
  assert.ok(textOf(host.innerHTML).includes('bereits ausgewertet'), 'the copy tells the truth about a closed sitting');
  assert.ok(!textOf(host.innerHTML).includes('versuchen Sie es erneut'), 'and promises no retry');
  assert.match(host.innerHTML, /data-runner-evaluate-ready="false"[^>]*disabled/, '"Auswerten" cannot be tapped again');
  assert.match(host.innerHTML, /data-runner-recovery/, 'the learner can still move on');
  /* The recovery controls are real: they ask for another set rather than repeating the refused request. */
  const asks = stub.calls.next.length;
  const savedConfirm = globalThis.confirm;
  globalThis.confirm = () => false;
  host.onclick(recoverEvent('next'));
  assert.equal(stub.calls.next.length, asks, 'cancelling preserves unchecked picks');
  globalThis.confirm = () => true;
  try { host.onclick(recoverEvent('next')); } finally { globalThis.confirm = savedConfirm; }
  await tick();
  assert.ok(stub.calls.next.length > asks, '"Noch ein Satz" asks the server for another set');
  assert.equal(calls, 1, 'and the refused check is never re-sent');
});

leg('14d 409 WITH a held review still recovers it, and says why it came back', async () => {
  const set = dtoSet();
  const stub = stubApi({ set });
  let calls = 0;
  const api = {
    ...stub.api,
    practice: {
      ...stub.api.practice,
      check: async (payload) => {
        calls++;
        return calls === 1 ? { ok: true, status: 200, data: checkedFromPayload(payload, set) } : { ok: false, status: 409, error: 'attempt_already_checked' };
      },
    },
  };
  const host = hostStub();
  const view = runner.createPartRunnerView({ ...CTX, family: 'LV2', examParts: EXAM_PARTS_FIXTURE, api });
  await view.mount(host);
  for (const item of set.items) host.onchange(answerEvent(item.item_id, item.options[0].id));
  await view.evaluate();
  assert.equal(view.snapshot().phase, 'review', 'the review arrives once');
  /* The SAME attempt is evaluated again (a stale tab, a double submit): the server says checked, and the
     review this view already holds is shown again rather than replaced by an error. */
  await view.evaluate();
  assert.equal(view.snapshot().phase, 'review', 'the held review is recovered, not lost');
  assert.match(host.innerHTML, /data-runner-notice="partRunnerAlreadyChecked"/, 'and the learner is told why');
  assert.equal(countOf(host.innerHTML, /data-runner-action="/g), 3, 'the three actions are back');
});

leg('14e an archived preparation says so, and offers no retry', async () => {
  const { host, state } = await runCheckFailure(checkFails(409, 'preparation_archived'));
  assert.equal(state.checkFailure.kind, 'archived');
  assert.ok(textOf(host.innerHTML).includes('archiviert'), 'the copy names the real reason');
  assert.match(host.innerHTML, /data-retryable="false"/);
  assert.match(host.innerHTML, /data-runner-recovery/);
});

leg('14f the classification is pure and total, so no refusal can fall through to a notice', () => {
  assert.deepEqual(runner.checkFailureOf({ status: 0, error: 'network' }, {}), { code: 'network', status: 0, kind: 'retryable' });
  assert.equal(runner.checkFailureOf({ status: 500 }, {}).kind, 'retryable');
  assert.equal(runner.checkFailureOf({ status: 409, error: 'attempt_already_checked' }, {}).kind, 'closed');
  assert.equal(runner.checkFailureOf({ status: 409, error: 'attempt_already_checked' }, { hasReview: true }).kind, 'recover-review');
  assert.equal(runner.checkFailureOf({ status: 409, error: 'preparation_archived' }, {}).kind, 'archived');
  for (const status of [400, 401, 403, 404, 409, 415, 422, 428]) {
    assert.equal(runner.checkFailureOf({ status, error: 'x' }, {}).kind, 'blocked', 'status ' + status + ' is a blocked refusal');
  }
  for (const kind of ['retryable', 'closed', 'archived', 'blocked']) {
    assert.ok(typeof PRACTICE_MESSAGES.de[runner.CHECK_FAILURE_KEYS[kind]] === 'string', 'a copy exists for ' + kind);
  }
  assert.ok(!/versuchen Sie es erneut/i.test(PRACTICE_MESSAGES.de[runner.CHECK_FAILURE_KEYS.blocked]), 'the blocked copy carries no retry promise');
  assert.ok(!/versuchen Sie es erneut/i.test(PRACTICE_MESSAGES.de[runner.CHECK_FAILURE_KEYS.closed]), 'the closed copy carries no retry promise');
});

/* --------------------------------------------------- 15. the mutation proof (--mutations) */

/** The four mutations, with the ONE leg each must break. Kept next to the check so a later reader can
 *  re-run the proof instead of trusting a table in a note. */
const MUTATIONS = Object.freeze([
  Object.freeze({ id: 'M1', what: 'the review drops the key marker', file: 'task-layout.js', from: '<span class="chip" data-option-marker="key"', to: '<span class="chip" data-option-marker="key-disabled"', leg: '2' }),
  Object.freeze({ id: 'M2', what: 'the exhausted part gets the silent restart label', from: 'key: wrapped ? WRAP_KEY : ACTION_KEYS.next', to: 'key: ACTION_KEYS.next', leg: '6' }),
  Object.freeze({ id: 'M3', what: 'replay is offered before "Auswerten"', from: "const reviewed = state.phase === 'review';", to: 'const reviewed = true;', leg: '7' }),
  Object.freeze({ id: 'M4', what: 'the served option value is stringified (HV would mark wrong)', from: 'return (typeof value === \'boolean\' || typeof value === \'string\' || typeof value === \'number\') ? value : typed(id);', to: 'return String(value ?? typed(id));', leg: '7' }),
  /*
   * M5/M6 cover the POOL-01 practice playback transport. Each removes ONE client-side guarantee that leg 7f or
   * 7g exists for: M5 lets the client stop understanding the server's "a second listen needs Auswerten"
   * refusal (so the sentence it prints would promise a play), and M6 asks for the bytes BEFORE the play is
   * acknowledged — the exact order the practice media route refuses.
   */
  Object.freeze({ id: 'M5', what: 'the practice refusal "check first" is no longer understood', file: 'practice-listening.js', from: "  if (code === 'practice_check_required') return pt('partRunnerAudioCheckFirst', {}, locale);\n", to: '', leg: '7g' }),
  Object.freeze({ id: 'M6', what: 'the bytes are fetched BEFORE the play is acknowledged', file: 'practice-listening.js', from: "    if (!mediaReady) {\n      const loaded = await loadBytes();\n      if (ticket !== epoch) return false;\n      if (!loaded) { busy = false; emit(); return false; }\n    }", to: "    if (!mediaReady) {\n      const loaded = await loadBytes();\n      if (ticket !== epoch) return false;\n      if (!loaded) { busy = false; emit(); return false; }\n      await loadBytes();\n    }", leg: '7f' }),
]);

async function runMutations() {
  const base = path.join(os.tmpdir(), 'practice-runner-mutations-' + process.pid);
  const hash = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  let broken = 0;
  try {
    for (const mutation of MUTATIONS) {
      const dir = path.join(base, mutation.id);
      /* A FRESH copy per mutation: `cpSync` merges into an existing tree, so a leftover from an interrupted run
         could mutate a file the previous run already patched and the proof would judge the wrong bytes. */
      fs.rmSync(dir, { recursive: true, force: true });
      fs.mkdirSync(dir, { recursive: true });
      fs.cpSync(path.join(root, 'public'), path.join(dir, 'public'), { recursive: true });
      /* Most mutations break the runner; M5/M6 break the practice player it composes, so the file is a member. */
      const file = path.join(dir, 'public', 'app', mutation.file ?? 'part-runner.js');
      const before = hash(file);
      const source = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
      const occurrences = source.split(mutation.from).length - 1;
      if (occurrences !== 1) { console.log('FAIL  ' + mutation.id + ' the mutation does not apply exactly once (' + occurrences + ')'); broken++; continue; }
      fs.writeFileSync(file, source.replace(mutation.from, mutation.to));
      const after = hash(file);
      const applied = before !== after;
      /* The child runs a check that is not expected to hang; a hang is reported as a FAILURE, not waited out. */
      /* Mutations are applied to `mutation.file`; the check under test always runs the RUNNER. */
      const runnerPath = path.join(dir, 'public', 'app', 'part-runner.js');
      const spawnArgs = [fileURLToPath(import.meta.url),
        '--module=' + runnerPath,
        '--index=' + path.join(dir, 'public', 'app', 'part-index.js'),
        '--messages=' + path.join(dir, 'public', 'assets', 'i18n', 'practice-messages.js'),
        '--css=' + path.join(dir, 'public', 'app', 'part-runner.css'),
        '--server=' + SERVER_SETS_PATH,
        '--no-mutations'];
      for (const required of [file, runnerPath]) {
        if (!fs.existsSync(required)) {
          console.log('FAIL  ' + mutation.id + ' the copy is incomplete, missing ' + required);
          broken++;
          continue;
        }
      }
      if (process.env.PRACTICE_RUNNER_MUT_DEBUG === '1') console.log('DEBUG spawn ' + JSON.stringify(spawnArgs));
      const child = spawnSync(process.execPath, spawnArgs, { encoding: 'utf8', cwd: root, timeout: 120000 });      const output = String(child.stdout) + String(child.stderr);
      if (child.error) {
        console.log('FAIL  ' + mutation.id + ' the mutated check did not finish: ' + String(child.error.code || child.error.message));
        if (output.trim()) console.log(output.split('\n').slice(-8).join('\n'));
        broken++;
        continue;
      }
      /* The child prints each failure twice (the live line and the summary); dedupe so ONE leg means one. */
      const failedLegs = [...new Set([...output.matchAll(/^FAIL\s+(\d+[a-z]?)\b/gm)].map(match => match[1]))];
      const ok = applied && failedLegs.length === 1 && failedLegs[0] === mutation.leg;
      console.log((ok ? 'PASS' : 'FAIL') + '  ' + mutation.id + ' ' + mutation.what + ' -> leg ' + (failedLegs.join(',') || 'none') + ' (expected ' + mutation.leg + '); changed=' + applied);
      if (!ok) { broken++; console.log(output.split('\n').slice(-8).join('\n')); }
    }
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
  console.log('\n' + (MUTATIONS.length - broken) + '/' + MUTATIONS.length + ' mutations failed exactly the intended leg' + (broken ? ' — the proof is BROKEN' : ''));
  if (broken) process.exitCode = 1;
}

/* ------------------------------------------------------------------------------- summary */

for (const task of queue) await task();

console.log('\n' + passed + ' passed, ' + failures.length + ' failed');
console.log('server cross-check (leg 12d): ' + SERVER_SETS_PATH);

if (RUN_MUTATIONS && !NO_MUTATIONS) {
  console.log('\nmutation proof (copies in ' + os.tmpdir() + ', this worktree untouched):');
  await runMutations();
} else if (!NO_MUTATIONS) {
  console.log('mutation proof: not run — `node tools/practice-runner-check.mjs --mutations` runs the four (M1->2, M2->6, M3->7, M4->7)');
}

if (failures.length) {
  console.log('\n' + failures.map(entry => 'FAIL ' + entry.name + '\n     ' + String(entry.error && entry.error.message)).join('\n'));
  process.exitCode = 1;
}

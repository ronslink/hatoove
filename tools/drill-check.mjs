#!/usr/bin/env node
/**
 * DRILL-01 (MIRROR-B1PREP-01 slice H) — the Einzelübungen drill, offline and against a disposable database.
 *
 *   node tools/drill-check.mjs                 the offline legs, plus the built-in mutation proof
 *   node tools/drill-check.mjs --postgres      adds the PostgreSQL legs (needs a disposable database)
 *   node tools/drill-check.mjs --no-mutations  the legs only
 *
 * WHAT THE OFFLINE LEGS PROVE. The weighting rule is a pure function of crafted evidence
 * (`server/drill-sets.mjs`), so "a weak part wins" is decided by rows rather than by a narrative: weak
 * before unseen before strong, weakest accuracy first, then more recorded answers, then family — a TOTAL
 * order, so identical evidence always yields the identical part. The client legs drive the real module with
 * a stubbed transport: ONE item on screen, no key before the answer is committed, the server's own verdict,
 * and the option's typed VALUE posted (a judgement item's key is a JSON boolean).
 *
 * WHAT THE POSTGRES LEGS PROVE. The same rule through the SHIPPED SQL: the served item IS a key in
 * `objective_key.answers`; `mark_objective_item` marks a choice and a judgement item; the key comes back
 * only after the evidence row exists; an out-of-order or double answer is refused; the sitting closes on its
 * last item with its counts frozen; and `mode='drill'` keeps the drill's row and the runner's row apart.
 * Migration 0046 is proved the hard way — applied ALONE to a 0045 head that already holds a sitting.
 *
 * MUTATION PROOF. The shipped modules are copied into throwaway directories, one rule is broken in each
 * copy, and every mutation must fail at least one leg while the pristine copies keep passing.
 *
 * Everything here is synthetic and disposable; nothing points at a learner's data.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PURE = 'server/drill-sets.mjs';
const CLIENT = 'public/app/drill.js';
const CSS = 'public/app/drill.css';
const API = 'public/app/api.js';
const ROUTES = 'server/owned-api.mjs';
const PORT = 'server/drill-pg.mjs';
const ADAPTER = 'server/owned-postgres/adapter.mjs';
const MESSAGES = 'public/assets/i18n/practice-messages.js';
const MIGRATION = 'server/migrations/0046-drill-mode.sql';
const LOCALES = ['de', 'en', 'uk', 'ar', 'tr'];
const UUID = '11111111-1111-4111-8111-111111111111';

const read = (relative) => fs.readFileSync(path.join(ROOT, relative), 'utf8');
const stripComments = (source) => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
const firstLine = (error) => String(error && error.message).split('\n')[0];

/* --------------------------------------------------------------- the shared harness */

const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));
const decode = (value) => String(value).replace(/&(?:amp|lt|gt|quot|#39);/g, (c) => ({
  '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'",
}[c]));
const textOf = (markup) => decode(String(markup).replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
const countOf = (markup, pattern) => [...String(markup).matchAll(pattern)].length;
const uiText = (key) => key;

/** A host stub: enough for `createDrillView` without a DOM library. */
function hostStub(id = 'drill-host') {
  const nodes = new Map();
  return {
    id, innerHTML: '', onclick: null, onchange: null, dataset: {}, hidden: false, className: '',
    querySelector: (selector) => {
      if (!nodes.has(selector)) nodes.set(selector, { dataset: {}, textContent: '', disabled: false, setAttribute() {}, remove() {} });
      return nodes.get(selector);
    },
    querySelectorAll: () => [], contains: () => false, matches: () => false, nodes,
  };
}

/** The two served item shapes, exactly as `normalisePracticeSet` emits them. */
const CHOICE_ITEM = Object.freeze({
  item_id: '6', ordinal: 1, prompt: 'Was soll sich in der Innenstadt ändern?', prompt_en: null, answer_kind: 'choice',
  options: [
    { id: 'a', text: 'Autos dürfen dort bald überall fahren.', value: 'a' },
    { id: 'b', text: 'In einigen Straßen sollen Radwege entstehen.', value: 'b' },
    { id: 'c', text: 'Der Busverkehr wird ganz eingestellt.', value: 'c' },
  ],
});
const JUDGEMENT_ITEM = Object.freeze({
  item_id: '41', ordinal: 1, prompt: 'Anna kann am Freitag nicht ins Kino gehen.', prompt_en: null,
  answer_kind: 'judgement',
  options: [{ id: 'true', text: '', value: true }, { id: 'false', text: '', value: false }],
});

const setDto = (overrides = {}) => ({
  set_id: 'telc-deutsch-b1.lv2.01', version: 'v1', title: 'Mehr Platz für Fahrräder in der Innenstadt',
  family: 'LV2', section: 'LV', part: 2, item_count: 5, media_required: false, playback: null,
  material: { text: 'Die Stadt Freiburg will den Verkehr in der Innenstadt neu ordnen.' },
  ...overrides,
});

const ROUND = { setCount: 3, checkedSets: 0, wrapped: false, round: 1, notice: null };

function serveResponse({ item = CHOICE_ITEM, set = setDto(), family = null, reason = 'weak', evidence = { attempts: 4, correct: 1, accuracy: 0.25 }, progress = { answered: 0, total: 5 }, round = ROUND, attempt = null } = {}) {
  return {
    ok: true, status: 200, error: null,
    data: {
      preparation_id: 'prep', exam_id: 'telc-deutsch-b1', family: family ?? set.family, section: set.section,
      reason, evidence,
      attempt: attempt ?? { attempt_id: UUID, state: 'open', answered_count: 0, item_count: set.item_count, resumed: false },
      round, set, item, progress,
    },
  };
}

/** A transport stub that MARKS NOTHING ITSELF: `correct` is the posted value against the key it was given. */
function stubApi({ item = CHOICE_ITEM, key = 'b', set = setDto(), next = null, checkFailure = null } = {}) {
  const calls = { next: [], check: [], explanation: [] };
  const api = {
    practice: {
      drillNext: async () => {
        calls.next.push(true);
        return next ?? serveResponse({ item, set });
      },
      drillCheck: async (payload) => {
        calls.check.push(payload);
        if (checkFailure) return checkFailure;
        const correct = payload.answer === key;
        return {
          ok: true, status: 200, error: null,
          data: {
            attempt_id: UUID, set_id: set.set_id, version: set.version, family: set.family, section: set.section,
            item_id: payload.itemId, correct, chosen: payload.answer, expected: key,
            answer_kind: item.answer_kind, media_required: set.media_required === true,
            evidence_id: 'ev-1', explanation: null, answered_count: 1, correct_count: correct ? 1 : 0,
            item_count: set.item_count, complete: false, checked_at: null,
          },
        };
      },
      explanation: async (evidenceId, locale = null) => {
        calls.explanation.push({ evidenceId, language: locale });
        return { ok: true, status: 200, error: null, data: null };
      },
    },
  };
  return { api, calls };
}

/* ------------------------------------------------------------------------- the legs */

/**
 * Every offline leg, over the modules it was handed. Pure functions of `pure`/`client`, so the SAME legs run
 * against a mutated copy in the mutation proof.
 */
function buildLegs({ pure, client, pt, catalogues }) {
  const ptOf = pt ?? (() => '');
  return [
    ['1 the weak part is drilled first: a part with a wrong answer beats unseen and strong parts', () => {
      const families = [['LV1', 3], ['LV2', 3], ['LV3', 3], ['SB1', 4], ['SB2', 3], ['HV1', 3], ['HV2', 3], ['HV3', 3]]
        .map(([family, sets]) => ({ family, sets }));
      const parts = [
        { family: 'LV2', attempts: 4, correct: 1 },   // weak: 0.25
        { family: 'HV1', attempts: 4, correct: 4 },   // strong: 1.0
        { family: 'SB1', attempts: 2, correct: 1 },   // weak: 0.5
      ];
      const picked = pure.selectDrillPart({ families, parts });
      assert.equal(picked.family, 'LV2', 'the weakest recorded part must win');
      assert.equal(picked.tier, 'weak');
      assert.equal(picked.accuracy, 0.25);
      const ranked = pure.rankDrillParts({ families, parts: [{ family: 'HV1', attempts: 4, correct: 4 }] });
      assert.deepEqual(ranked.at(-1).family, 'HV1', 'the strong part is ranked last');
      assert.equal(ranked.at(-1).tier, 'strong');
      assert.equal(ranked[0].family, 'HV2', 'an unseen part comes first when nothing is weak');
      assert.equal(ranked[0].tier, 'unseen');
    }],
    ['2 within the weak tier the lowest accuracy wins', () => {
      const families = [{ family: 'LV1', sets: 3 }, { family: 'LV2', sets: 3 }];
      const ranked = pure.rankDrillParts({ families, parts: [
        { family: 'LV1', attempts: 10, correct: 5 },  // 0.5
        { family: 'LV2', attempts: 4, correct: 1 },   // 0.25
      ] });
      assert.deepEqual(ranked.map((row) => row.family), ['LV2', 'LV1'], 'the lower accuracy is the weaker part');
    }],
    ['3 an unseen part is not weak (no accuracy), and is not strong either', () => {
      const families = [{ family: 'LV1', sets: 3 }, { family: 'HV2', sets: 3 }];
      const fresh = pure.rankDrillParts({ families, parts: [] });
      assert.deepEqual(fresh.map((row) => row.tier), ['unseen', 'unseen'], 'no evidence is not a diagnosis');
      assert.deepEqual(fresh.map((row) => row.accuracy), [null, null], 'accuracy is null, never 0');
      const withStrong = pure.rankDrillParts({ families, parts: [{ family: 'LV1', attempts: 3, correct: 3 }] });
      assert.deepEqual(withStrong.map((row) => row.family), ['HV2', 'LV1'], 'unseen before strong');
      assert.deepEqual(withStrong.map((row) => row.tier), ['unseen', 'strong']);
    }],
    ['4 tie-break: equal accuracy, MORE recorded answers wins', () => {
      const families = [{ family: 'LV1', sets: 3 }, { family: 'LV2', sets: 3 }];
      const ranked = pure.rankDrillParts({ families, parts: [
        { family: 'LV1', attempts: 8, correct: 4 },  // 0.5 on eight answers
        { family: 'LV2', attempts: 2, correct: 1 },  // 0.5 on two
      ] });
      assert.deepEqual(ranked.map((row) => row.family), ['LV1', 'LV2'], 'more evidence of the same weakness first');
    }],
    ['5 the ranking is TOTAL: identical evidence always yields the identical order', () => {
      const families = [{ family: 'SB2', sets: 3 }, { family: 'HV1', sets: 3 }, { family: 'LV3', sets: 3 }];
      const parts = [{ family: 'HV1', attempts: 2, correct: 1 }, { family: 'LV3', attempts: 2, correct: 1 }];
      const a = pure.rankDrillParts({ families, parts });
      const b = pure.rankDrillParts({ families, parts });
      assert.deepEqual(a, b);
      assert.deepEqual(a.map((row) => row.family), ['HV1', 'LV3', 'SB2'], 'family ascending breaks the remaining tie');
    }],
    ['6 evidence for a family the deployment does not release is ignored, not guessed at', () => {
      const ranked = pure.rankDrillParts({
        families: [{ family: 'LV1', sets: 3 }],
        parts: [{ family: 'HV1', attempts: 9, correct: 0 }, { family: null, attempts: 3, correct: 0 }],
      });
      assert.equal(ranked.length, 1, 'no phantom candidate');
      assert.equal(ranked[0].family, 'LV1');
      assert.equal(ranked[0].attempts, 0, 'foreign evidence must not mark a released part as practised');
      assert.equal(ranked[0].tier, 'unseen');
      assert.equal(pure.selectDrillPart({ families: [], parts: [] }), null, 'no released part is not an error');
    }],
    ['7 the sitting: the NEWEST open drill sitting wins, and a malformed row is not a sitting', () => {
      const picked = pure.pickDrillSitting([
        { attempt_id: 'aaa', set_id: 's1', version: 'v1', item_count: 5, answered_count: 2, created_at: '2026-10-01T10:00:00Z' },
        { attempt_id: 'bbb', set_id: 's2', version: 'v1', item_count: 5, answered_count: 1, created_at: '2026-10-03T10:00:00Z' },
        { attempt_id: null, set_id: 's3', version: 'v1', answered_count: 4, created_at: '2026-10-09T10:00:00Z' },
        { attempt_id: 'ccc', set_id: null, version: 'v1', answered_count: 4, created_at: '2026-10-09T10:00:00Z' },
      ]);
      assert.equal(picked.attempt_id, 'bbb', 'the most recent usable sitting');
      assert.equal(picked.answered_count, 1);
      assert.equal(pure.pickDrillSitting([]), null);
      assert.equal(pure.pickDrillSitting(null), null);
      const tie = pure.pickDrillSitting([
        { attempt_id: 'zzz', set_id: 's1', version: 'v1', answered_count: 1, created_at: '2026-10-03T10:00:00Z' },
        { attempt_id: 'aaa', set_id: 's2', version: 'v1', answered_count: 1, created_at: '2026-10-03T10:00:00Z' },
      ]);
      assert.equal(tie.attempt_id, 'aaa', 'a timestamp tie is broken by attempt id, so it is total');
    }],
    ['8 the item: the NEXT one in SERVED order, and nothing once the sitting is exhausted', () => {
      const items = [{ item_id: '6' }, { item_id: '7' }, { item_id: '8' }];
      assert.equal(pure.nextDrillItem(items, 0).item_id, '6');
      assert.equal(pure.nextDrillItem(items, 2).item_id, '8');
      assert.equal(pure.nextDrillItem(items, 3), null, 'an exhausted sitting serves no item');
      assert.equal(pure.nextDrillItem([], 0), null);
      assert.equal(pure.nextDrillItem(items, -1).item_id, '6', 'a nonsense count is treated as none answered');
    }],
    ['9 progress is a count of what happened: clamped, and never a score', () => {
      assert.deepEqual(pure.drillProgress({ answeredCount: 2, itemCount: 5 }), { answered: 2, total: 5, complete: false });
      assert.deepEqual(pure.drillProgress({ answeredCount: 5, itemCount: 5 }), { answered: 5, total: 5, complete: true });
      assert.deepEqual(pure.drillProgress({ answeredCount: 9, itemCount: 5 }), { answered: 5, total: 5, complete: true });
      assert.deepEqual(pure.drillProgress({}), { answered: 0, total: 0, complete: false });
    }],

    /* ------------------------------------------------------------------ the client module */

    ['10 [client] ONE item on screen and NO key before the answer is committed', async () => {
      const { api } = stubApi({});
      const host = hostStub();
      const view = client.createDrillView({ esc, uiText, language: 'de', examLanguage: 'de', api });
      await view.mount(host);
      assert.equal(view.snapshot().phase, 'answering');
      const markup = view.markup();
      assert.match(markup, /data-drill-phase="answering"/);
      assert.equal(countOf(markup, /data-drill-item[ >]/g), 1, 'exactly one task is on the page');
      assert.equal(countOf(markup, /type="radio"/g), CHOICE_ITEM.options.length, 'every option of that one task');
      assert.equal(countOf(markup, /data-drill-check[ >]/g), 1, 'exactly one check control');
      assert.ok(!/data-drill-next|data-drill-step|data-drill-page/.test(markup), 'no stepper and no pagination');
      assert.ok(!/data-drill-feedback/.test(markup), 'no verdict before the answer');
      assert.ok(!/data-drill-key-line|data-drill-pick-line/.test(markup), 'THE KEY IS NOT ON THE PAGE while answering');
      assert.match(markup, /data-drill-check-ready="false"[^>]*disabled/, 'check waits for an answer');
      assert.ok(textOf(markup).includes('Einzelübung · ohne Zeitmessung'), 'the untimed claim is on screen');
      assert.ok(textOf(markup).includes('Ihr schwächster Teil: LV2 — 1 von 4 richtig.'), 'the reason is the server\'s, with its numbers');
      assert.ok(textOf(markup).includes('Aufgabe 1 von 5'), 'the task position is a count of this set');
      view.unmount();
      assert.equal(host.innerHTML, '', 'unmount clears the host');
    }],
    ['11 [client] instant feedback: the SERVER verdict, the key, the learner\'s pick, all options marked', async () => {
      const { api, calls } = stubApi({ key: 'b' });
      const host = hostStub();
      const view = client.createDrillView({ esc, uiText, language: 'de', examLanguage: 'de', api });
      await view.mount(host);
      view.choose(CHOICE_ITEM.options.find((option) => option.id === 'b'));
      assert.equal(view.snapshot().answer.value, 'b');
      assert.equal(await view.check(), true);
      assert.equal(view.snapshot().phase, 'feedback');
      assert.equal(calls.check.length, 1, 'ONE request marks the ONE item');
      const markup = view.markup();
      assert.match(markup, /data-drill-feedback data-verdict="correct"/);
      assert.equal(countOf(markup, /data-option-id="/g), CHOICE_ITEM.options.length, 'ALL options, not only the right one');
      assert.match(markup.match(/<label[^>]*data-option-id="b"[^>]*>[\s\S]*?<\/label>/)?.[0] ?? '', /data-option-marker="key"/, 'the key option is marked');
      assert.equal(countOf(markup, /data-option-marker="key"/g), 1);
      assert.ok(textOf(markup).includes('Lösung: b'), 'the key is printed');
      assert.ok(textOf(markup).includes('Ihre Wahl: b'), 'the learner\'s pick is printed');
      assert.ok(textOf(markup).includes('Richtig.'));
      assert.match(markup, /data-drill-next[ >]/, 'exactly one way forward');
      assert.ok(!/%|Prozent|percent|\/ ?45|Gesamtpunktzahl|bestanden/i.test(textOf(markup)), 'no percentage and no pass claim');
    }],
    ['12 [client] a WRONG answer is reported from the server verdict, never guessed by the client', async () => {
      const { api } = stubApi({ key: 'b' });
      const host = hostStub();
      const view = client.createDrillView({ esc, uiText, language: 'de', examLanguage: 'de', api });
      await view.mount(host);
      view.choose(CHOICE_ITEM.options.find((option) => option.id === 'a'));
      await view.check();
      const markup = view.markup();
      assert.match(markup, /data-drill-feedback data-verdict="wrong"/);
      assert.match(markup.match(/<label[^>]*data-option-id="b"[^>]*>[\s\S]*?<\/label>/)?.[0] ?? '', /data-option-marker="key"/, 'the key is still marked');
      assert.match(markup.match(/<label[^>]*data-option-id="a"[^>]*>[\s\S]*?<\/label>/)?.[0] ?? '', /data-option-marker="chosen"/, 'the wrong pick is marked as the pick');
      assert.equal(view.snapshot().checked.correct, false);
      assert.notEqual(view.snapshot().checked.expected, view.snapshot().checked.chosen, 'the wrong pick and the key are different options');
    }],
    ['13 [client] the answer posted is the option\'s TYPED value — a boolean for a judgement item', async () => {
      /*
       * The corpus's judgement items ARE listening items, and H1 (leg 24) means this client never renders one
       * as an exercise while its audio cannot be played. The CLIENT contract still has to be right — a
       * judgement item posts the option's boolean `value`, never the string — because that is exactly what the
       * drill will do the day the practice-playback transport lands, and because the DTO allows a
       * non-media judgement item. So this leg serves one (`media_required: false`, a richtig/falsch statement)
       * and leg 24 proves the media case is blocked instead of answerable.
       */
      const judgementSet = setDto({ family: 'LV1', section: 'LV', part: 1, media_required: false, material: {} });
      const { api, calls } = stubApi({ item: JUDGEMENT_ITEM, key: true, set: judgementSet });
      const host = hostStub();
      const view = client.createDrillView({ esc, uiText, language: 'de', examLanguage: 'de', api });
      await view.mount(host);
      const state = view.snapshot();
      assert.equal(state.item.answer_kind, 'judgement', 'the served answer_kind decides the control');
      assert.deepEqual(state.item.options.map((option) => option.value), [true, false]);
      view.choose(state.item.options.find((option) => option.value === true));
      await view.check();
      assert.equal(typeof calls.check[0].answer, 'boolean', 'a boolean is POSTed, never the string "true"');
      assert.equal(calls.check[0].answer, true, 'the option VALUE is posted, not its id');
      assert.equal(view.snapshot().checked.correct, true, 'the boolean key marks right');
      assert.equal(countOf(view.markup(), /data-explanation-slot/g), 0, 'a judgement item invents no explanation prose');
      const choice = stubApi({ key: 'b' });
      const host2 = hostStub();
      const view2 = client.createDrillView({ esc, uiText, language: 'de', examLanguage: 'de', api: choice.api });
      await view2.mount(host2);
      view2.choose(CHOICE_ITEM.options.find((option) => option.id === 'c'));
      await view2.check();
      assert.equal(choice.calls.check[0].answer, 'c', 'a choice item posts its string value');
    }],
    ['14 [client] empty, unavailable, refused and unrenderable states are honest', async () => {
      const empty = stubApi({ next: { ok: true, status: 200, error: null, data: { reason: 'nothing_available', family: null, item: null, set: null } } });
      const hostA = hostStub();
      const viewA = client.createDrillView({ esc, uiText, language: 'de', examLanguage: 'de', api: empty.api });
      await viewA.mount(hostA);
      assert.equal(viewA.snapshot().phase, 'empty');
      assert.ok(hostA.innerHTML.includes('data-drill-empty'), 'the empty state names itself');
      assert.ok(!hostA.innerHTML.includes('data-drill-check'), 'no check control over an empty pool');
      const hostB = hostStub();
      const viewB = client.createDrillView({ esc, uiText, language: 'de', examLanguage: 'de', api: { practice: {} } });
      await viewB.mount(hostB);
      assert.equal(viewB.snapshot().phase, 'unavailable');
      assert.ok(hostB.innerHTML.includes('data-drill-unavailable'), 'a missing transport is a state, not a crash');
      assert.equal(viewB.transportReady(), false);
      const failed = stubApi({ next: { ok: false, status: 503, error: 'practice_unavailable' } });
      const hostC = hostStub();
      const viewC = client.createDrillView({ esc, uiText, language: 'de', examLanguage: 'de', api: failed.api });
      await viewC.mount(hostC);
      assert.equal(viewC.snapshot().phase, 'error');
      assert.ok(hostC.innerHTML.includes('data-drill-error="practice_unavailable"'), 'the failure is named, not swallowed');
      assert.ok(hostC.innerHTML.includes('data-drill-retry'), 'a retry is offered');
      assert.ok(!hostC.innerHTML.includes('data-drill-check'), 'no check control over a failed load');
      const broken = stubApi({ item: { item_id: '9', ordinal: 1, prompt: 'Ohne Optionen', answer_kind: 'choice', options: [] } });
      const hostD = hostStub();
      const viewD = client.createDrillView({ esc, uiText, language: 'de', examLanguage: 'de', api: broken.api });
      await viewD.mount(hostD);
      assert.equal(viewD.snapshot().blocked, 'options');
      assert.ok(hostD.innerHTML.includes('data-drill-blocked="options"'), 'and it is said on screen');
      const refused = stubApi({ checkFailure: { ok: false, status: 422, error: 'invalid_answer' } });
      const hostE = hostStub();
      const viewE = client.createDrillView({ esc, uiText, language: 'de', examLanguage: 'de', api: refused.api });
      await viewE.mount(hostE);
      viewE.choose(CHOICE_ITEM.options[0]);
      await viewE.check();
      assert.equal(viewE.snapshot().phase, 'answering');
      assert.ok(hostE.innerHTML.includes('data-drill-check-error="invalid_answer"'), 'the refusal is an error on the page');
      assert.ok(viewE.snapshot().answer, 'the answer is still held');
      const order = stubApi({ checkFailure: { ok: false, status: 409, error: 'item_out_of_order' } });
      const hostF = hostStub();
      const viewF = client.createDrillView({ esc, uiText, language: 'de', examLanguage: 'de', api: order.api });
      await viewF.mount(hostF);
      viewF.choose(CHOICE_ITEM.options[0]);
      await viewF.check();
      assert.equal(order.calls.next.length, 2, 'a stale item re-reads the next one instead of re-sending the same body');
      assert.equal(viewF.snapshot().phase, 'answering');
    }],
    ['15 [client] D22: no readiness, streak, study-plan or prediction surface in any of the five locales', async () => {
      const dangerous = /readiness|streak|study ?plan|lernplan|forecast|prediction|prognose|vorhersage|bestanden|bestehen Sie|schaffen Sie|voraussichtlich|prozent|percent|%|\/ ?45/i;
      const { api } = stubApi({ key: 'b' });
      const host = hostStub();
      const view = client.createDrillView({ esc, uiText, language: 'de', examLanguage: 'de', api });
      await view.mount(host);
      view.choose(CHOICE_ITEM.options[1]);
      await view.check();
      const offenders = [];
      for (const locale of LOCALES) {
        const answering = client.drillMarkup(client.drillStateFromServed({ response: serveResponse({}) }), { esc, uiText, examLanguage: 'de', locale });
        const feedback = client.drillMarkup(view.snapshot(), { esc, uiText, examLanguage: 'de', locale });
        for (const [where, markup] of [['answering', answering], ['feedback', feedback]]) {
          const text = textOf(markup);
          if (dangerous.test(text)) offenders.push(`${locale}/${where}: ${text.slice(0, 120)}`);
        }
      }
      assert.deepEqual(offenders, [], offenders.join(' | '));
      for (const reason of ['weak', 'unseen', 'strong']) {
        const line = client.drillReasonLine({ reason, family: 'LV2', evidence: { attempts: 4, correct: 1 } }, 'de');
        assert.ok(line && line.length > 0, `${reason} has a reason line`);
        assert.ok(!dangerous.test(line), `${reason} is a count, not a forecast`);
        /*
         * A PLACEHOLDER MISMATCH RENDERS AS "Übersetzung nicht verfügbar." (`core.js#t` requires the parameter
         * set to equal the template's placeholders exactly). The first SHELL render caught exactly that on the
         * strong tier — the catalogue string carried `{family}` while the call passed `{attempts}` too — and a
         * bare "length > 0" assertion had let it through. So the reason lines are now checked for the family,
         * for the rendered numbers, and for the absence of the fallback and of any unfilled token.
         */
        assert.ok(line.includes('LV2'), `${reason} names the part`);
        assert.ok(!/Übersetzung nicht verfügbar|Translation unavailable/.test(line), `${reason} is not the fallback`);
        assert.ok(!/[{}]/.test(line), `${reason} leaves no unfilled placeholder`);
      }
      const strong = client.drillReasonLine({ reason: 'strong', family: 'SB2', evidence: { attempts: 7, correct: 7 } }, 'de');
      assert.ok(strong.includes('SB2') && strong.includes('7'), `the strong line renders its own numbers: ${strong}`);
      const listening = client.drillReasonLine({ reason: 'weak', family: 'HV1', evidence: { attempts: 3, correct: 0 } }, 'de');
      assert.ok(listening.includes('HV1') && listening.includes('0') && listening.includes('3'), 'and so does the blocked one');
    }],
    ['16 [client] no URL literal and no fetch in the module: it goes through ctx.api.practice', () => {
      const source = stripComments(read(CLIENT));
      assert.ok(!/\bfetch\s*\(/.test(source), 'no raw fetch in the drill');
      assert.ok(!/['"`]\/api\//.test(source), 'no URL literal in the drill');
      assert.ok(source.includes('ctx.api?.practice'), 'the drill goes through the transport layer');
      assert.ok(source.includes('transport.drillNext') && source.includes('transport.drillCheck'), 'both drill calls are the transport\'s');
      const api = stripComments(read(API));
      assert.ok(api.includes("practiceDrillNext: '/api/v1/practice/drill/next'"), 'the path lives in api.js');
      assert.ok(api.includes("practiceDrillCheck: '/api/v1/practice/drill/check'"), 'the path lives in api.js');
      assert.ok(api.includes('drillNext: () => scopedCall(') && api.includes('drillCheck: (payload) => scopedCall('), 'both are preparation-scoped');
    }],
    ['17 [client] the stylesheet is injected once, and recognises the link the shell already added', () => {
      const previous = globalThis.document;
      const appended = [];
      const doc = {
        links: [],
        querySelectorAll: (selector) => (selector === 'link[rel="stylesheet"]' ? doc.links : []),
        createElement: () => ({ dataset: {}, getAttribute: () => null }),
        head: { append: (node) => { doc.links.push(node); appended.push(node); } },
      };
      try {
        globalThis.document = undefined;
        assert.equal(client.ensureStylesheet(), false, 'no document, no injection (Node)');
        assert.equal(client.ensureStylesheet(doc), true, 'the stylesheet is injected');
        assert.equal(appended.length, 1, 'exactly one link');
        assert.match(appended[0].href, /\/app\/drill\.css$/);
        assert.equal(appended[0].dataset.moduleStyle, appended[0].href);
        assert.equal(client.ensureStylesheet(doc), true, 'a second call is a no-op');
        assert.equal(appended.length, 1);
        const shellDoc = {
          links: [{ dataset: { moduleStyle: 'drill.css' }, href: appended[0].href, getAttribute: () => 'drill.css' }],
          querySelectorAll: (selector) => (selector === 'link[rel="stylesheet"]' ? shellDoc.links : []),
          createElement: () => ({ dataset: {}, getAttribute: () => null }),
          head: { append: () => { throw new Error('the module must NOT inject a second drill.css'); } },
        };
        assert.equal(client.ensureStylesheet(shellDoc), true, 'the link the SHELL added is recognised');
      } finally {
        globalThis.document = previous;
      }
    }],
    ['18 [css] the module layer is tokens only, module-scoped, and adds no second breakpoint', () => {
      const css = read(CSS);
      assert.ok(!/#[0-9a-fA-F]{3,8}\b/.test(css), 'no raw colour');
      assert.ok(!/\brgba?\(|\bhsla?\(/.test(css), 'no raw colour function');
      assert.ok(!/font-family/.test(css), 'no second brand face');
      const breakpoints = [...css.matchAll(/max-width\s*:\s*(\d+)px/g)].map((match) => match[1]);
      assert.deepEqual([...new Set(breakpoints)], ['860'], 'only the design system breakpoint');
      const tokens = new Set([...css.matchAll(/var\((--[a-z0-9-]+)\)/g)].map((match) => match[1]));
      assert.ok(tokens.size >= 8, `the layer really uses the design system (${tokens.size} tokens)`);
      const rules = [...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/(?:^|\})\s*([^{}@]+)\{/g)]
        .map((match) => match[1].trim()).filter(Boolean);
      const unscoped = rules.flatMap((selector) => selector.split(',')).map((part) => part.trim())
        .filter((part) => part && !part.startsWith('.drill'));
      assert.deepEqual(unscoped, [], 'every rule is module-scoped');
    }],
    ['19 [i18n] every drill key exists and is non-empty in all five locales, and the German is formal', () => {
      const keys = Object.keys(catalogues.practice.de).filter((key) => key.startsWith('drill'));
      assert.ok(keys.length >= 20, `the drill keys are registered (${keys.length})`);
      const informal = /(?<![\p{L}\p{N}])(du|dich|dir|dein|deine|kannst|musst|willst|hast|bist|wirst|wähle|waehle|trage|prüfe|versuche|melde|beginne|lade|lies|gib|nutze|warte|nimm|klick|schau|geh|komm|mach|brauch|zeig|sag|denk|merk|probiere)(?![\p{L}\p{N}])/iu;
      const missing = [];
      for (const key of keys) {
        for (const locale of LOCALES) {
          const value = catalogues.practice[locale]?.[key];
          if (typeof value !== 'string' || !value.trim()) missing.push(`${locale}.${key}`);
        }
        if (informal.test(catalogues.practice.de[key])) missing.push(`informal address in de.${key}`);
      }
      assert.deepEqual(missing, [], missing.join(', '));
      const source = stripComments(read(CLIENT));
      const used = new Set([
        ...[...source.matchAll(/t\(esc,\s*'([A-Za-z0-9_]+)'/g)].map((match) => match[1]),
        ...[...source.matchAll(/pt\('([A-Za-z0-9_]+)'/g)].map((match) => match[1]),
      ]);
      const unknown = [...used].filter((key) => typeof catalogues.practice.de[key] !== 'string');
      assert.deepEqual(unknown, [], `keys rendered but not registered: ${unknown.join(', ')}`);
      assert.ok(used.has('drillReasonWeak') && used.has('drillKey') && used.has('drillYourPick'));
      assert.equal(ptOf('practiceAllSets'), 'Alle Sätze dieses Teils geübt — von vorn', 'the wrap notice reuses slice C\'s copy');
      assert.ok(source.includes('state.round.notice'), 'and it is the server\'s key the client renders');
    }],
    ['20 [routes] the two drill routes exist, are guarded, and enrich the explanation behind the same guards', () => {
      const source = stripComments(read(ROUTES));
      assert.ok(source.includes("pathname === '/api/v1/practice/drill/next' && method === 'GET'"), 'the next route');
      assert.ok(source.includes("pathname === '/api/v1/practice/drill/check' && method === 'POST'"), 'the check route');
      assert.ok(/typeof datastore\.drillNext !== 'function'/.test(source), 'next is refused when the datastore has no drill');
      assert.ok(/typeof datastore\.drillCheckItem !== 'function'/.test(source), 'check is refused when the datastore has no drill');
      assert.ok(/onlyFields\(body, \['preparationId', 'attemptId', 'itemId', 'answer', 'latencyMs', 'language'\]\)/.test(source), 'the body is allowlisted');
      assert.ok(/checked\.media_required !== true/.test(source), 'a media set is not asked for an explanation');
      assert.ok(/checked\.answer_kind === 'choice'/.test(source), 'a judgement item is not asked for one either');
      assert.ok(/checked\.explanation = null;/.test(source), 'any reader failure is the honest null, never a failed verdict');
      assert.ok(source.includes("pathname === '/api/v1/practice/check' && method === 'POST'"), 'the whole-set check is untouched');
      const adapter = stripComments(read(ADAPTER));
      assert.ok(adapter.includes("import { drillMethods } from '../drill-pg.mjs';"), 'the adapter composes the drill port');
      assert.ok(adapter.includes('...drillMethods({ settle, note, catalogue: examCatalogue })'), 'and spreads it into the port');
    }],
    ['21 [schema] the drill adds no table: it writes practice_attempt and item_evidence only', () => {
      const source = stripComments(read(PORT));
      assert.ok(!/CREATE\s+TABLE/i.test(source), 'no table of its own');
      assert.ok(!/ALTER\s+TABLE/i.test(source), 'no schema change at runtime');
      assert.ok(!/DELETE\s+FROM/i.test(source), 'the drill never deletes evidence');
      assert.ok(/INSERT INTO practice_attempt/.test(source), 'the sitting is a practice_attempt');
      assert.ok(/INSERT INTO item_evidence/.test(source), 'the answer is an item_evidence row');
      assert.ok(/mode = 'drill'/.test(source), 'only the drill\'s own sittings are continued');
      assert.ok(/mark_objective_item/.test(source), 'marking is the existing SECURITY DEFINER function');
      assert.ok(/reveal_objective_answer/.test(source), 'the key is the existing SECURITY DEFINER reader');
      assert.ok(/attempt\.answered_count/.test(source), 'the served order is pinned to the sitting\'s own count');
      const sql = read(MIGRATION);
      assert.ok(/ADD COLUMN IF NOT EXISTS mode text NOT NULL DEFAULT 'part'/.test(sql), 'mode defaults to the runner\'s path');
      assert.ok(/practice_attempt_mode_check CHECK \(mode IN \('part', 'drill'\)\)/.test(sql), 'two paths and no more');
      assert.ok(/NEW\.mode/.test(sql), 'mode is part of the trigger\'s immutable identity row');
      assert.ok(/GRANT INSERT \([^)]*mode\)/.test(sql), 'the learner may insert the mode and not update it');
    }],
    ['22 [client] a LISTENING set that somehow arrives still shows the EXAM play rule and disables playback', async () => {
      /*
       * FIX-F1: the drill no longer serves a listening set at all (`selectDrillTarget` passes a media part
       * over), so this leg is DEFENCE IN DEPTH — if an item of a media set ever reaches the client, the player
       * is present and disabled and the sentence is one a learner can understand. It no longer asserts that the
       * copy talks about a "practice playback path": that is engineering text.
       */
      const partRules = [{ family: 'HV1', section: 'HV', part: 1, itemCount: 5, points: 25, playback: { practice: 1, mock: 1 } }];
      const listeningSet = setDto({ set_id: 'telc-deutsch-b1.hv1.01', family: 'HV1', section: 'HV', part: 1, media_required: true, material: {} });
      const { api } = stubApi({ item: JUDGEMENT_ITEM, key: true, set: listeningSet });
      const host = hostStub();
      const view = client.createDrillView({ esc, uiText, language: 'de', examLanguage: 'de', api, examParts: partRules });
      await view.mount(host);
      const markup = view.markup();
      assert.ok(markup.includes('data-drill-audio'), 'the listening block is rendered');
      assert.match(markup, /data-playback-mock="1"/, 'the EXAM play rule is the served mock number');
      assert.ok(textOf(markup).includes('Prüfungsregel: 1-mal hören'), 'the exam rule is printed, not the practice one');
      assert.match(markup, /data-drill-play[^-][^>]*disabled/, 'playback is disabled rather than pretending');
      const honest = textOf(markup);
      assert.ok(!/Wiedergabeweg|playback path|Abspielweg/.test(honest), 'the copy names no internal path');
      assert.ok(/noch nicht üben/.test(honest), 'it says what the learner can and cannot do here');
      assert.ok(!/nicht vorhanden|existiert nicht|does not exist|no recording/i.test(honest), 'it must never claim the recording is missing');
      const choice = stubApi({});
      const host2 = hostStub();
      const view2 = client.createDrillView({ esc, uiText, language: 'de', examLanguage: 'de', api: choice.api, examParts: [] });
      await view2.mount(host2);
      assert.ok(!view2.markup().includes('data-drill-audio'), 'a reading item renders no audio block at all');
    }],
    ['23 (F1, pure) a part whose audio cannot be played is PASSED OVER — never a target, never a dead end', () => {
      const families = [
        { family: 'HV1', sets: 3, media: true },
        { family: 'LV1', sets: 3, media: false },
        { family: 'LV2', sets: 3, media: false },
      ];
      /*
       * THE CORRECTION (FIX-F1). The first H1 rule BLOCKED at the first weak media part. That was wrong about
       * what feeds the ranking: the part runner was recording listening guesses, so HV was usually the weakest
       * part and the block closed Einzelübungen for almost every learner who had opened Hören — and sent them
       * back to Hören to guess again. A weak listening part is now walked PAST, silently, and the weakest part
       * the learner can actually play is served.
       */
      const weakListening = pure.selectDrillTarget(pure.rankDrillParts({ families, parts: [{ family: 'HV1', attempts: 3, correct: 0 }] }));
      assert.equal(weakListening.kind, 'item', 'a weak listening part does not stop the walk');
      assert.equal(weakListening.part.family, 'LV1', 'the weakest PLAYABLE part is the target');
      assert.equal(weakListening.part.media, false);
      /* The case the old rule got wrong: a weak listening part AND a weak playable part. */
      const both = pure.selectDrillTarget(pure.rankDrillParts({ families, parts: [
        { family: 'HV1', attempts: 4, correct: 0 }, { family: 'LV2', attempts: 4, correct: 1 },
      ] }));
      assert.equal(both.kind, 'item', 'the learner is given an exercise, not a report');
      assert.equal(both.part.family, 'LV2', 'the weakest part they can play');
      /* An unseen listening part is skipped as well — the fresh-learner case, unchanged by the correction. */
      const fresh = pure.selectDrillTarget(pure.rankDrillParts({ families, parts: [] }));
      assert.equal(fresh.kind, 'item');
      assert.equal(fresh.part.family, 'LV1');
      /* A strong listening part is skipped too: nothing wrong there is a weakness to report. */
      const strongMedia = pure.selectDrillTarget(pure.rankDrillParts({ families, parts: [{ family: 'HV1', attempts: 4, correct: 4 }] }));
      assert.equal(strongMedia.kind, 'item');
      assert.equal(strongMedia.part.family, 'LV1');
      /*
       * The honest note is reserved for the case where NOTHING playable is left: a deployment whose released
       * parts are listening parts. It names the highest-ranked one and serves nothing.
       */
      const onlyMedia = pure.selectDrillTarget(pure.rankDrillParts({
        families: [{ family: 'HV1', sets: 3, media: true }, { family: 'HV2', sets: 3, media: true }],
        parts: [{ family: 'HV1', attempts: 4, correct: 0 }, { family: 'HV2', attempts: 4, correct: 1 }],
      }));
      assert.equal(onlyMedia.kind, 'listening_only', 'nothing playable: the state is named, not guessed at');
      assert.equal(onlyMedia.part.family, 'HV1', 'the highest-ranked listening part');
      assert.equal(pure.selectDrillTarget(pure.rankDrillParts({ families: [{ family: 'HV1', sets: 3, media: true }], parts: [] })).kind, 'listening_only');
      assert.equal(pure.selectDrillTarget(pure.rankDrillParts({ families: [], parts: [] })).kind, 'none');
      assert.equal(pure.selectDrillTarget([]).kind, 'none');
      assert.equal(pure.selectDrillTarget(null).kind, 'none');
      /* FAIL CLOSED: a caller that omits the media flag does not get an item from a part it never declared
         playable — and does not get a block either; it is simply not a target. */
      const unspecified = pure.selectDrillTarget(pure.rankDrillParts({ families: [{ family: 'LV1', sets: 3 }], parts: [] }));
      assert.notEqual(unspecified.kind, 'item', 'an undeclared part is treated as unplayable');
      assert.equal(unspecified.kind, 'listening_only', 'and with nothing else, the state is still honest');
      /*
       * THE EVIDENCE RULE (requirement 4): a guess about inaudible audio must not make a part look weak. The
       * filter is pure, so it is proved here; the database leg proves the same rule through the port.
       */
      const candidates = [
        { set_id: 'telc-deutsch-b1.lv1.01', version: 'v1', media_required: false },
        { set_id: 'telc-deutsch-b1.hv1.01', version: 'v1', media_required: true },
      ];
      const rows = [
        { set_id: 'telc-deutsch-b1.lv1.01', version: 'v1', family: 'LV1', correct: false },
        { set_id: 'telc-deutsch-b1.hv1.01', version: 'v1', family: 'HV1', correct: false },
        { set_id: 'telc-deutsch-b1.hv1.01', version: 'v1', family: 'HV1', correct: false },
        { set_id: 'telc-deutsch-b1.lv9.01', version: 'v1', family: 'LV9', correct: false },
      ];
      const kept = pure.playableEvidence(rows, candidates);
      assert.deepEqual(kept.map((row) => row.set_id), ['telc-deutsch-b1.lv1.01'],
        'listening guesses and evidence for a set this deployment does not serve are both ignored');
      assert.deepEqual(pure.drillStatsFromEvidence(kept), [{ family: 'LV1', attempts: 1, correct: 0 }],
        'so the listening part never becomes the weakest part by guessing');
      assert.deepEqual(pure.playableEvidence(rows, []), [], 'with nothing servable, nothing counts');
      assert.deepEqual(pure.drillStatsFromEvidence(pure.playableEvidence(rows, candidates)).map((row) => row.family), ['LV1']);
      /*
       * FIX-N1 — AND A PROBEPRÜFUNG LISTENING RESULT DOES COUNT. The row's `mock_run_id` is the difference: in
       * the mock the recording played, so the answering is real evidence even though nothing in the practice
       * surface can play that set. Mutation M9 removes this clause and fails THIS leg.
       */
      const withMock = [...rows, { set_id: 'telc-deutsch-b1.hv1.01', version: 'v1', family: 'HV1', correct: false, mock_run_id: 'run-1' }];
      const counted = pure.playableEvidence(withMock, candidates);
      assert.deepEqual(counted.map((row) => row.mock_run_id ?? null), [null, 'run-1'],
        'the blind guesses are dropped and the mock result is kept — the set cannot be played HERE, but it was played there');
      assert.deepEqual(pure.drillStatsFromEvidence(counted), [{ family: 'LV1', attempts: 1, correct: 0 }, { family: 'HV1', attempts: 1, correct: 0 }],
        'so a real listening weakness is visible to the ranking again');
      /* An answer is judged by the ROW, not by the set: a mock row for a playable set counts once, not twice. */
      const mockOnPlayable = [{ set_id: 'telc-deutsch-b1.lv1.01', version: 'v1', family: 'LV1', correct: true, mock_run_id: 'run-2' }];
      assert.deepEqual(pure.drillStatsFromEvidence(pure.playableEvidence(mockOnPlayable, candidates)), [{ family: 'LV1', attempts: 1, correct: 1 }],
        'a mock result on a playable set is one row, exactly like a practice answer');
    }],
    ['24 [client] F1: the listening note appears only when nothing playable is left, and offers no controls', async () => {
      /* (1) The server's own note for that state: the part is named, no item, no controls, and a way forward. */
      const blockedResponse = {
        ok: true, status: 200, error: null,
        data: {
          preparation_id: 'prep', exam_id: 'telc-deutsch-b1', blocked: 'listening', family: 'HV1', section: 'HV',
          reason: 'weak', evidence: { attempts: 3, correct: 0, accuracy: 0 }, attempt: null, round: null,
          set: null, item: null, progress: null,
        },
      };
      const navigated = [];
      const { api } = stubApi({ next: blockedResponse });
      const host = hostStub();
      const view = client.createDrillView({
        esc, uiText, language: 'de', examLanguage: 'de', api,
        navigate: (hash) => navigated.push(hash),
        examParts: [{ family: 'HV1', section: 'HV', part: 1, itemCount: 5, playback: { practice: 1, mock: 1 } }],
      });
      await view.mount(host);
      assert.equal(view.snapshot().phase, 'empty');
      assert.equal(view.snapshot().poolBlocked, 'listening');
      const markup = view.markup();
      assert.ok(markup.includes('data-drill-listening-blocked'), 'the honest blocked card is rendered');
      assert.equal(countOf(markup, /data-drill-item[ >]/g), 0, 'NO item is offered');
      assert.equal(countOf(markup, /type="radio"/g), 0, 'NO answer options');
      assert.equal(countOf(markup, /data-drill-check[ >]/g), 0, 'NO check control, so nothing can be guessed into evidence');
      const text = textOf(markup);
      assert.ok(text.includes('HV1'), 'the part is named');
      assert.ok(text.includes('0 von 3 richtig'), 'with the learner\'s own numbers');
      assert.ok(/nur Hörteile/.test(text), 'it says the available parts are listening parts — and spells Hörteile correctly');
      assert.ok(!/Hörtelle/.test(text), 'the shipped typo is gone');
      assert.ok(!/Wiedergabeweg|Abspielweg|playback path/.test(text), 'and names no engineering concept');
      assert.match(markup, /data-drill-play[^-][^>]*disabled/, 'the player is present and disabled');
      host.onclick({ target: { closest: (wanted) => (wanted === '[data-drill-part-index]' ? {} : null) } });
      assert.deepEqual(navigated, ['#/pruefungsteile'], 'the way forward is the part practice');
      /*
       * FIX-N1 — NO CONTRADICTION IN THE NUMBERS. The server sends the same counts it ranked with, so a part
       * with counted results prints them and a part with none says so instead of being called "the weakest of
       * them" while displaying "0 von 0 richtig".
       */
      const noCount = { ...blockedResponse, data: { ...blockedResponse.data, evidence: { attempts: 0, correct: 0, accuracy: null }, reason: 'unseen' } };
      const noCountView = client.createDrillView({
        esc, uiText, language: 'de', examLanguage: 'de', api: stubApi({ next: noCount }).api,
        navigate: () => {}, examParts: [{ family: 'HV1', section: 'HV', part: 1, itemCount: 5, playback: { practice: 1, mock: 1 } }],
      });
      await noCountView.mount(hostStub());
      const noCountMarkup = noCountView.markup();
      assert.match(noCountMarkup, /data-drill-listening-counted="false"/, 'the card knows it has no counted result');
      assert.ok(!/0 von 0 richtig/.test(textOf(noCountMarkup)), 'and does not print "0 von 0 richtig"');
      assert.ok(/kein gezähltes Ergebnis/.test(textOf(noCountMarkup)), 'it says there is no counted result yet');
      assert.ok(!/schwächste/.test(textOf(noCountMarkup)), 'it does not call a part with no counted result the weakest');
      /* (2) Defence in depth: even if a server ever SERVES a media item, it is never an exercise here. */
      const listeningSet = setDto({ family: 'HV1', section: 'HV', part: 1, media_required: true, material: {} });
      const served = stubApi({ item: JUDGEMENT_ITEM, key: true, set: listeningSet });
      const host2 = hostStub();
      const view2 = client.createDrillView({ esc, uiText, language: 'de', examLanguage: 'de', api: served.api, examParts: [] });
      await view2.mount(host2);
      assert.equal(view2.snapshot().item, null, 'the unplayable item is not held as an answerable item');
      assert.equal(countOf(view2.markup(), /type="radio"/g), 0, 'no options for it');
      assert.equal(await view2.check(), false, 'and the check refuses, so no evidence row can be written');
      assert.equal(served.calls.check.length, 0, 'nothing was posted');
    }],
  ];
}

/** Run every offline leg over the modules it was handed. Returns `[result, name]` rows and never throws. */
async function runLegs(label, deps) {
  const results = [];
  for (const [name, run] of buildLegs(deps)) {
    try {
      await run();
      results.push(['PASS', name]);
    } catch (error) {
      results.push(['FAIL', `${label}${name}  [${firstLine(error).slice(0, 220)}]`]);
    }
  }
  return results;
}

/* ------------------------------------------------------------------ the PostgreSQL legs */

const runNode = (args, extraEnv, timeoutMs = 180000) => new Promise((resolve) => {
  const child = spawn(process.execPath, args, { cwd: ROOT, env: { ...process.env, ...extraEnv }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (chunk) => { out += String(chunk); });
  child.stderr.on('data', (chunk) => { out += String(chunk); });
  const timer = setTimeout(() => { child.kill('SIGKILL'); }, timeoutMs);
  child.once('exit', (code) => { clearTimeout(timer); resolve({ code, out }); });
});

const appliedCount = (out) => Number((String(out).match(/applied=(\d+)/) ?? [])[1] ?? 0);

async function postgresLegs() {
  if (process.env.OWNAPI_PG_ALLOW !== '1' || process.env.OWNAPI_PG_HOST !== '127.0.0.1') {
    throw new Error('explicit local disposable PostgreSQL required (OWNAPI_PG_ALLOW=1, OWNAPI_PG_HOST=127.0.0.1)');
  }
  const { createFixture } = await import('../server/owned-postgres/bootstrap.mjs');
  const { createPostgresWorld } = await import('../server/owned-postgres/fixture.mjs');
  const { normalisePracticeSet } = await import('../server/practice-sets.mjs');
  const EXAM = 'telc-deutsch-b1';
  const outcome = [];
  const pgLeg = async (name, run) => {
    try { await run(); outcome.push(['PASS', name]); } catch (error) { outcome.push(['FAIL', `${name}: ${firstLine(error)}`]); }
  };
  const policyKeys = ['B1PREP_CONTENT_MODE', 'B1PREP_SERVE_REVIEW', 'B1PREP_SERVE_RIGHTS'];
  const savedPolicy = Object.fromEntries(policyKeys.map((key) => [key, process.env[key]]));
  const restorePolicy = () => {
    for (const key of policyKeys) {
      if (savedPolicy[key] === undefined) delete process.env[key];
      else process.env[key] = savedPolicy[key];
    }
  };
  process.env.B1PREP_CONTENT_MODE = 'internal-preview';
  delete process.env.B1PREP_SERVE_REVIEW;
  delete process.env.B1PREP_SERVE_RIGHTS;

  let db = null;
  try {
    db = await createFixture();
    const world = await createPostgresWorld({ fixture: db });
    const port = world.store.port;
    const signup = await world.sessions.signUp({
      name: 'Drill', email: `drill-${Date.now()}@example.invalid`, password: 'synthetic-drill-check-password',
    });
    const cookie = String(signup.setCookie).split(';')[0];
    const owner = (await world.sessions.getSession({ cookie })).userId;
    const created = await port.createPreparation(owner, EXAM);
    const preparationId = (created.preparation ?? created).id;

    /* Crafted evidence must be written the way a LEARNER writes it: `item_evidence` carries the row guard
       `guard_review_use` (0036), which raises `not_found` unless `hatoove.owner_id` is bound. */
    const asOwner = async (run) => {
      const client = await db.learner.connect();
      try {
        await client.query('BEGIN');
        await client.query("SELECT set_config('hatoove.owner_id', $1, true)", [owner]);
        const result = await run(client);
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw error;
      } finally {
        client.release();
      }
    };
    const families = (await db.admin.query(
      `SELECT s.family, s.section, count(*)::int AS sets FROM objective_set s
         JOIN reviewed_content_version c USING (content_version_id)
        WHERE s.exam_id = $1 GROUP BY s.family, s.section ORDER BY s.family`, [EXAM])).rows;
    const setOf = async (family) => (await db.admin.query(
      `SELECT s.set_id, s.version, s.title, s.family, s.section, s.part, s.item_count, s.media_required, s.payload
         FROM objective_set s JOIN reviewed_content_version c USING (content_version_id)
        WHERE s.exam_id = $1 AND s.family = $2 ORDER BY s.set_id LIMIT 1`, [EXAM, family])).rows[0];
    const servedItemsOf = async (setId, version) => {
      const row = (await db.admin.query(
        `SELECT set_id, version, title, family, section, part, item_count, media_required, payload
           FROM objective_set WHERE set_id = $1 AND version = $2`, [setId, version])).rows[0];
      return normalisePracticeSet({ ...row, items: undefined }, null).items;
    };
    const keysFor = async (setId, version) => {
      const row = (await db.admin.query('SELECT answers FROM objective_key WHERE set_id = $1 AND version = $2', [setId, version])).rows[0];
      assert.ok(row, `the fixture has no objective_key for ${setId}@${version}`);
      return row.answers;
    };
    /* The learner role has no DELETE on `item_evidence` (by design, 0015: evidence is append-only), so the
       synthetic evidence is cleared as the admin role — exactly as `practice-selection-check` does. */
    const clearEvidence = () => db.admin.query('DELETE FROM item_evidence WHERE owner_id = $1', [owner]);
    /**
     * Drop the learner's OPEN drill sittings, so a leg that needs a KNOWN-fresh sitting gets one.
     *
     * The drill resumes its own open sitting by design, so without this a later leg would continue the
     * sitting an earlier leg left behind — which is the behaviour under test elsewhere, not a fixture.
     * CHECKED sittings are kept: they are what the wrap counter and the progress DTO read.
     */
    const resetDrillSittings = () => db.admin.query(
      "DELETE FROM practice_attempt WHERE owner_id = $1 AND mode = 'drill' AND state = 'open'", [owner]);
    const craft = async (family, section, setId, version, wrong, correct) => {
      await asOwner(async (client) => {
        for (let index = 0; index < wrong + correct; index += 1) {
          await client.query(
            `INSERT INTO item_evidence
               (evidence_id, owner_id, exam_id, set_id, version, item_id, family, section, answer, correct,
                latency_ms, preparation_id, answered_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, NULL, $11, now())`,
            [randomUUID(), owner, EXAM, setId, version, `crafted-${randomUUID().slice(0, 8)}`, family, section,
              JSON.stringify('a'), index >= wrong, preparationId]);
        }
      });
    };
    const attemptRow = async (attemptId) => (await db.admin.query(
      `SELECT attempt_id, set_id, version, family, section, item_count, state, answered_count, correct_count,
              checked_at, mode
         FROM practice_attempt WHERE attempt_id = $1`, [attemptId])).rows[0];

    const WEAK = 'LV2';
    /* A playable family to use as the "strong" comparison. HV1 can no longer be the strong one: REVIEW-DRILL-01
       H1 removed media parts from the drill's candidates, and P11/P12 prove that below. */
    const STRONG = 'LV1';

    await pgLeg('P1 SQL: the weakest part is served, with the numbers behind the choice', async () => {
      await clearEvidence();
      await resetDrillSittings();
      const first = await port.drillNext(owner, { preparationId });
      assert.ok(first, 'a fresh preparation must be served a task');
      assert.equal(first.reason, 'unseen');
      assert.equal(first.family, 'LV1', `with no evidence every part is unseen; the playable families decide by family order (${families.map((row) => row.family).join(',')})`);
      assert.equal(first.set.media_required, false, 'H1: a fresh learner\'s FIRST task is a playable one, never HV');
      const weakSet = await setOf(WEAK);
      await craft(WEAK, 'LV', weakSet.set_id, weakSet.version, 3, 1);
      const strongSet = await setOf(STRONG);
      await craft(STRONG, 'LV', strongSet.set_id, strongSet.version, 0, 5);
      const drill = await port.drillNext(owner, { preparationId });
      assert.equal(drill.family, WEAK, 'the part with recorded wrong answers must win');
      assert.equal(drill.reason, 'weak');
      assert.equal(drill.evidence.attempts, 4);
      assert.equal(drill.evidence.correct, 1);
      assert.equal(drill.evidence.accuracy, 0.25);
      assert.ok(drill.item && typeof drill.item.item_id === 'string', 'exactly one item is served');
      assert.ok(Array.isArray(drill.item.options) && drill.item.options.length >= 2);
      assert.equal(drill.progress.answered, 0);
      assert.equal(drill.progress.total, drill.set.item_count);
      const row = await attemptRow(drill.attempt.attempt_id);
      assert.equal(row.mode, 'drill', 'the sitting is the drill\'s own');
      assert.equal(row.state, 'open');
      assert.equal(row.answered_count, 0);
      assert.equal(row.family, WEAK);
    });

    await pgLeg('P2 SQL: an unseen part yields to the weak one and outranks the strong one', async () => {
      const drill = await port.drillNext(owner, { preparationId });
      assert.equal(drill.family, WEAK, 'LV2 is still the weakest recorded part');
      await clearEvidence();
      const strongSet = await setOf(STRONG);
      await craft(STRONG, 'LV', strongSet.set_id, strongSet.version, 0, 3);
      const withStrong = await port.drillNext(owner, { preparationId });
      assert.notEqual(withStrong.family, STRONG, 'a strong part is drilled last');
      assert.equal(withStrong.reason, 'unseen');
    });

    await pgLeg('P3 SQL: the served item IS a key, and the response carries no key of its own', async () => {
      await clearEvidence();
      const weakSet = await setOf(WEAK);
      await craft(WEAK, 'LV', weakSet.set_id, weakSet.version, 3, 1);
      const drill = await port.drillNext(owner, { preparationId });
      const keys = await keysFor(drill.set.set_id, drill.set.version);
      assert.ok(Object.hasOwn(keys, drill.item.item_id), 'the served item id IS a key in objective_key.answers');
      assert.ok(drill.item.options.some((option) => option.value === keys[drill.item.item_id]),
        'and the served options offer the answer the KEY holds, typed the way the key holds it');
      const serialised = JSON.stringify({ item: drill.item, set: { ...drill.set, material: undefined } });
      assert.ok(!serialised.includes('"expected"'), 'no key rides along with the served item');
      const before = await asOwner((client) => client.query(
        'SELECT reveal_objective_answer($1, $2, $3) AS expected', [drill.set.set_id, drill.set.version, drill.item.item_id]));
      assert.equal(before.rows[0].expected, null, 'reveal_objective_answer returns NOTHING before the answer is committed');
    });

    await pgLeg('P4 SQL: a CHOICE item is marked from the option VALUE, and the key comes back after the commit', async () => {
      const drill = await port.drillNext(owner, { preparationId });
      const keys = await keysFor(drill.set.set_id, drill.set.version);
      const key = keys[drill.item.item_id];
      assert.equal(typeof key, 'string', 'this family keys by a choice letter');
      const marked = await port.drillCheckItem(owner, {
        preparationId, attemptId: drill.attempt.attempt_id, itemId: drill.item.item_id, answer: key, latencyMs: 1234,
      });
      assert.equal(marked.correct, true, 'the key value marks right');
      assert.equal(marked.expected, key, 'the key is returned only now');
      assert.equal(marked.answer_kind, 'choice');
      assert.equal(marked.chosen, key);
      assert.equal(marked.complete, false);
      assert.ok(marked.evidence_id, 'an evidence row was written');
      const evidence = (await db.admin.query(
        `SELECT item_id, family, section, correct, latency_ms, mock_run_id
           FROM item_evidence WHERE evidence_id = $1`, [marked.evidence_id])).rows[0];
      assert.equal(evidence.item_id, drill.item.item_id);
      assert.equal(evidence.family, drill.family);
      assert.equal(evidence.correct, true);
      assert.equal(evidence.latency_ms, 1234);
      assert.equal(evidence.mock_run_id, null, 'a practice answer names no mock run');
      const second = await port.drillNext(owner, { preparationId });
      assert.equal(second.attempt.attempt_id, drill.attempt.attempt_id, 'the open sitting is continued');
      assert.equal(second.attempt.resumed, true);
      assert.equal(second.attempt.answered_count, 1);
      assert.equal(second.progress.answered, 1);
      assert.notEqual(second.item.item_id, drill.item.item_id, 'the NEXT item, not the same one again');
    });

    await pgLeg('P5 SQL (F1): a listening sitting cannot be marked through the drill either — no evidence is written', async () => {
      /*
       * This leg used to prove the JSON-BOOLEAN key by driving a crafted HV sitting through `drillCheckItem`.
       * FIX-F1 refuses that marking (a guess about inaudible audio must not enter `item_evidence` through ANY
       * path), so the leg now proves the REFUSAL, and the boolean-keying fact stays proved at the marking layer
       * (`practice-selection-check` P10) where no serving path is involved.
       */
      await clearEvidence();
      await resetDrillSittings();
      const hvSet = (await db.admin.query(
        `SELECT s.set_id, s.version, s.item_count FROM objective_set s
           JOIN reviewed_content_version c USING (content_version_id)
          WHERE s.exam_id = $1 AND s.family = 'HV1' ORDER BY s.set_id LIMIT 1`, [EXAM])).rows[0];
      assert.ok(hvSet, 'the fixture publishes an HV1 set');
      const attemptId = randomUUID();
      await db.admin.query(
        `INSERT INTO practice_attempt
           (attempt_id, owner_id, exam_id, preparation_id, set_id, version, family, section, item_count, mode)
         VALUES ($1, $2, $3, $4, $5, $6, 'HV1', 'HV', $7, 'drill')`,
        [attemptId, owner, EXAM, preparationId, hvSet.set_id, hvSet.version, hvSet.item_count]);
      const items = await servedItemsOf(hvSet.set_id, hvSet.version);
      const keys = await keysFor(hvSet.set_id, hvSet.version);
      const first = items[0];
      assert.equal(first.answer_kind, 'judgement', 'a listening item IS a judgement item (the shape is unchanged)');
      assert.deepEqual(first.options.map((option) => option.value), [true, false]);
      assert.equal(typeof keys[first.item_id], 'boolean');
      await assert.rejects(
        port.drillCheckItem(owner, { preparationId, attemptId, itemId: first.item_id, answer: keys[first.item_id] }),
        (error) => error.status === 409 && error.code === 'media_unavailable',
        'the drill refuses to mark an exercise the learner could not hear');
      const after = await attemptRow(attemptId);
      assert.equal(after.state, 'open', 'the sitting is untouched');
      assert.equal(after.answered_count, 0, 'and nothing advanced');
      const rows = (await db.admin.query(
        'SELECT count(*)::int AS n FROM item_evidence WHERE owner_id = $1', [owner])).rows[0].n;
      assert.equal(rows, 0, 'NOT ONE evidence row was written');
    });

    await pgLeg('P11 SQL (F1): a weak LISTENING part does not block — the weakest PLAYABLE part is served', async () => {
      await clearEvidence();
      await resetDrillSittings();
      /* The learner's ONLY recorded weakness is a listening part: exactly the case the reviewer measured. That
         used to close Einzelübungen on them; now the listening part is passed over. */
      const hvSet = await setOf('HV1');
      await craft('HV1', 'HV', hvSet.set_id, hvSet.version, 3, 0);
      const before = (await db.admin.query(
        `SELECT (SELECT count(*)::int FROM item_evidence WHERE owner_id = $1) AS evidence,
                (SELECT count(*)::int FROM practice_attempt WHERE owner_id = $1) AS sittings`, [owner])).rows[0];
      const drill = await port.drillNext(owner, { preparationId });
      assert.ok(drill, 'the drill answers with an exercise');
      assert.equal(drill.blocked, undefined, 'NO block: the listening weakness is passed over, not reported');
      assert.notEqual(drill.family, 'HV1', 'and the target is not the listening part');
      assert.equal(drill.family, 'LV1', 'it is the weakest part the learner can actually play');
      assert.equal(drill.reason, 'unseen', 'the playable parts have no evidence of their own');
      assert.equal(drill.set.media_required, false, 'the served set needs no audio');
      assert.ok(drill.item && typeof drill.item.item_id === 'string', 'and an item IS served');
      assert.ok(Array.isArray(drill.item.options) && drill.item.options.length >= 2);
      assert.equal(drill.attempt && drill.attempt.state, 'open', 'a sitting is opened for it');
      /* The listening guesses are still there and still ignored: they are the learner's own record. */
      const kept = (await db.admin.query(
        `SELECT count(*)::int AS n FROM item_evidence WHERE owner_id = $1 AND family = 'HV1'`, [owner])).rows[0].n;
      assert.equal(kept, 3, 'the stored listening guesses are KEPT');
      const after = (await db.admin.query(
        `SELECT (SELECT count(*)::int FROM item_evidence WHERE owner_id = $1) AS evidence,
                (SELECT count(*)::int FROM practice_attempt WHERE owner_id = $1) AS sittings`, [owner])).rows[0];
      assert.equal(after.evidence, before.evidence, 'serving the playable part writes no evidence of its own yet');
      assert.equal(after.sittings, before.sittings + 1, 'and opens exactly one sitting');
      /* The same call twice is stable (the drill resumes its own sitting rather than re-choosing). */
      const again = await port.drillNext(owner, { preparationId });
      assert.equal(again.family, 'LV1');
      assert.equal(again.attempt.attempt_id, drill.attempt.attempt_id, 'the drill continues its own sitting');
    });

    await pgLeg('P12 SQL (F1): a listening guess cannot steer the drill at all — playable evidence decides', async () => {
      await clearEvidence();
      await resetDrillSittings();
      /* (d1) ONLY listening evidence, and it is wrong: the served family is decided by the playable evidence,
         which is empty, so it is the unseen-order part — and never HV. */
      const hvSet = await setOf('HV1');
      await craft('HV1', 'HV', hvSet.set_id, hvSet.version, 4, 0);
      const first = await port.drillNext(owner, { preparationId });
      assert.equal(first.family, 'LV1', 'the listening part is passed over, not named as a block');
      assert.equal(first.set.media_required, false, 'and what is served is playable');
      assert.notEqual(first.family, 'HV1', 'HV is never the chosen family from listening evidence');
      /* (d2) listening evidence that is STRONG (nothing wrong) never becomes the chosen family either. */
      await clearEvidence();
      await resetDrillSittings();
      await craft('HV1', 'HV', hvSet.set_id, hvSet.version, 0, 4);
      const weakSet = await setOf(WEAK);
      await craft(WEAK, 'LV', weakSet.set_id, weakSet.version, 3, 1);
      const served = await port.drillNext(owner, { preparationId });
      assert.equal(served.family, WEAK, 'the playable weak part is served');
      assert.notEqual(served.family, 'HV1', 'HV is never the chosen family');
      assert.equal(served.set.media_required, false, 'the served set needs no audio');
      /* (d3) a listening part that is merely UNSEEN does not even enter the decision for a fresh learner. */
      await clearEvidence();
      await resetDrillSittings();
      const fresh = await port.drillNext(owner, { preparationId });
      assert.equal(fresh.blocked, undefined, 'an unseen listening part is not a weakness to report');
      assert.equal(fresh.set.media_required, false);
      /* (d4) ...and the guesses never even reach the ranking: the pure filter drops them. */
      const candidate = (await db.admin.query(
        `SELECT set_id, version FROM objective_set WHERE family = 'HV1' ORDER BY set_id LIMIT 1`)).rows[0];
      await craft('HV1', 'HV', candidate.set_id, candidate.version, 5, 0);
      assert.equal((await db.admin.query(
        `SELECT count(*)::int AS n FROM item_evidence WHERE owner_id = $1 AND family = 'HV1'`, [owner])).rows[0].n, 5,
      'five listening guesses are stored');
      const pureModule = await import(pathToFileURL(path.join(ROOT, PURE)).href);
      const stats = pureModule.drillStatsFromEvidence(pureModule.playableEvidence(
        (await db.admin.query('SELECT set_id, version, family, correct FROM item_evidence WHERE owner_id = $1', [owner])).rows,
        (await db.admin.query('SELECT set_id, version, media_required FROM objective_set')).rows));
      assert.deepEqual(stats, [], 'and NOT ONE of them is allowed to make a part look weak');
    });

    await pgLeg('P6 SQL: an out-of-order or unknown item is refused, and nothing is written', async () => {
      await clearEvidence();
      await resetDrillSittings();
      const weakSet = await setOf(WEAK);
      await craft(WEAK, 'LV', weakSet.set_id, weakSet.version, 2, 0);
      const drill = await port.drillNext(owner, { preparationId });
      const items = await servedItemsOf(drill.set.set_id, drill.set.version);
      assert.ok(items.length > 1, 'the set has more than one item');
      const later = items.find((item) => item.item_id !== drill.item.item_id);
      await assert.rejects(
        port.drillCheckItem(owner, { preparationId, attemptId: drill.attempt.attempt_id, itemId: later.item_id, answer: later.options[0].value }),
        (error) => error.code === 409 || error.status === 409);
      const stillOpen = await attemptRow(drill.attempt.attempt_id);
      assert.equal(stillOpen.answered_count, 0, 'a refused answer advances nothing');
      await assert.rejects(
        port.drillCheckItem(owner, { preparationId, attemptId: drill.attempt.attempt_id, itemId: 'no-such-item', answer: 'a' }),
        (error) => error.code === 422 || error.status === 422);
      await assert.rejects(
        port.drillCheckItem(owner, { preparationId, attemptId: randomUUID(), itemId: drill.item.item_id, answer: 'a' }),
        (error) => error.code === 404 || error.status === 404);
    });

    await pgLeg('P7 SQL: the sitting closes on its LAST item, counts frozen, and cannot be reopened', async () => {
      await clearEvidence();
      await resetDrillSittings();
      const weakSet = await setOf(WEAK);
      await craft(WEAK, 'LV', weakSet.set_id, weakSet.version, 2, 0);
      let drill = await port.drillNext(owner, { preparationId });
      const sittingId = drill.attempt.attempt_id;
      const setRow = (await db.admin.query(
        'SELECT item_count FROM objective_set WHERE set_id = $1 AND version = $2',
        [drill.set.set_id, drill.set.version])).rows[0];
      const keys = await keysFor(drill.set.set_id, drill.set.version);
      const servedIds = [];
      for (let index = 0; index < setRow.item_count; index += 1) {
        assert.equal(drill.attempt.attempt_id, sittingId, 'the same sitting is continued throughout');
        assert.equal(drill.attempt.answered_count, index, 'the sitting advances one item at a time');
        servedIds.push(drill.item.item_id);
        const answer = index === 0 ? 'zzz-not-the-key' : keys[drill.item.item_id];
        const result = await port.drillCheckItem(owner, { preparationId, attemptId: sittingId, itemId: drill.item.item_id, answer });
        assert.equal(result.answered_count, index + 1);
        if (index === 0) assert.equal(result.correct, false, 'a wrong answer is recorded as wrong');
        if (index < setRow.item_count - 1) drill = await port.drillNext(owner, { preparationId });
      }
      const closed = await attemptRow(sittingId);
      assert.equal(closed.state, 'checked', 'the sitting closed itself on the last item');
      assert.equal(closed.answered_count, setRow.item_count);
      assert.equal(closed.correct_count, setRow.item_count - 1);
      assert.ok(closed.checked_at, 'a checked sitting carries its timestamp');
      assert.equal(new Set(servedIds).size, setRow.item_count, 'every item was served exactly once');
      await assert.rejects(
        db.admin.query("UPDATE practice_attempt SET state = 'open', checked_at = NULL WHERE attempt_id = $1", [sittingId]),
        /practice_attempt_reopen_refused/);
      await assert.rejects(
        db.admin.query('UPDATE practice_attempt SET correct_count = 0 WHERE attempt_id = $1', [sittingId]),
        /practice_attempt_counts_frozen/);
      const after = await port.drillNext(owner, { preparationId });
      assert.ok(after, 'the drill goes on after a finished set');
      assert.notEqual(after.attempt.attempt_id, sittingId, 'a new sitting, not the frozen one');
      assert.equal((await attemptRow(after.attempt.attempt_id)).mode, 'drill');
    });

    await pgLeg('P8 SQL: mode keeps the drill and the runner apart in BOTH directions', async () => {
      await clearEvidence();
      const weakSet = await setOf(WEAK);
      await craft(WEAK, 'LV', weakSet.set_id, weakSet.version, 2, 0);
      /* A runner-style sitting, written the way `practiceSetForPart` writes it: no mode at all. */
      const runnerAttempt = randomUUID();
      await db.admin.query(
        `INSERT INTO practice_attempt
           (attempt_id, owner_id, exam_id, preparation_id, set_id, version, family, section, item_count)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [runnerAttempt, owner, EXAM, preparationId, weakSet.set_id, weakSet.version, WEAK, 'LV', weakSet.item_count]);
      const runnerRow = await attemptRow(runnerAttempt);
      assert.equal(runnerRow.mode, 'part', 'a row written without a mode is the RUNNER\'s');
      assert.equal(runnerRow.answered_count, 0);
      /* 1. The drill never adopts it, and refuses to check it. */
      const drill = await port.drillNext(owner, { preparationId });
      assert.notEqual(drill.attempt.attempt_id, runnerAttempt, 'the drill NEVER adopts the runner\'s sitting');
      assert.equal((await attemptRow(drill.attempt.attempt_id)).mode, 'drill');
      await assert.rejects(
        port.drillCheckItem(owner, { preparationId, attemptId: runnerAttempt, itemId: drill.item.item_id, answer: 'a' }),
        (error) => (error.code === 409 || error.status === 409) && /not_a_drill_sitting/.test(String(error.message)));
      /* 2. The runner never adopts the drill's sitting either: `practiceSetForPart` opens its OWN. */
      const runnerSitting = await port.practiceSetForPart(owner, { preparationId, family: WEAK });
      assert.ok(runnerSitting, 'the part still serves a set');
      assert.notEqual(runnerSitting.attempt.attempt_id, drill.attempt.attempt_id, 'the runner gets its own sitting');
      assert.equal((await attemptRow(runnerSitting.attempt.attempt_id)).mode, 'part');
      /* 3. And the whole-set check REFUSES a drill sitting, so a client cannot double-fill one. */
      await assert.rejects(
        port.checkPracticeAttempt(owner, { preparationId, attemptId: drill.attempt.attempt_id, answers: [{ item_id: drill.item.item_id, answer: 'a' }] }),
        (error) => (error.code === 409 || error.status === 409) && /not_a_part_sitting/.test(String(error.message)));
      /* 4. The mode of a sitting is immutable. */
      await assert.rejects(
        db.admin.query("UPDATE practice_attempt SET mode = 'part' WHERE attempt_id = $1", [drill.attempt.attempt_id]),
        /practice_attempt_identity_immutable/);
    });

    await pgLeg('P9 SQL: the drill\'s answers reach the progress DTO the part tiles read', async () => {
      const progress = await port.practiceProgress(owner, { preparationId });
      const part = progress.parts.find((row) => row.family === WEAK);
      assert.ok(part, 'the drilled part appears in `parts`');
      assert.ok(part.attempts > 0, 'and its attempts are counted');
      assert.ok(part.accuracy !== null, 'accuracy is a number once there is evidence');
      assert.ok(progress.totals.attempts >= part.attempts);
      const mistakes = await port.listMistakes(owner, { preparationId, limit: 50 });
      assert.ok(mistakes.count >= 1, 'the deliberately wrong answer is in the mistakes list');
    });

    await pgLeg('P10 SQL: the part\'s rounds come from the SHARED counter, not a second one', async () => {
      await clearEvidence();
      const weakSet = await setOf(WEAK);
      await craft(WEAK, 'LV', weakSet.set_id, weakSet.version, 2, 0);
      const drill = await port.drillNext(owner, { preparationId });
      assert.ok(drill.round && typeof drill.round.wrapped === 'boolean', 'the round state is served');
      assert.equal(drill.round.setCount, families.find((row) => row.family === WEAK).sets, 'setCount is the part\'s released set count');
      const checked = (await db.admin.query(
        `SELECT count(DISTINCT set_id)::int AS n FROM practice_attempt
          WHERE owner_id = $1 AND preparation_id = $2 AND family = $3 AND state = 'checked'`, [owner, preparationId, WEAK])).rows[0].n;
      assert.equal(drill.round.checkedSets, checked, 'the wrap counter is the SAME count the runner reads');
    });
  } finally {
    if (db && typeof db.cleanup === 'function') {
      try { await db.cleanup(); } catch (error) { console.log(`postgres: cleanup reported ${firstLine(error)}`); }
    }
    restorePolicy();
  }
  return outcome;
}

/* ------------------------------------------------- the 0046 migration, from a 0045 head */

/**
 * Migration 0046 proved the hard way: a scratch schema is migrated to the 0045 HEAD, a RUNNER sitting is
 * written into it (the table has no `mode` column yet), and only then is 0046 applied. Every pre-existing row
 * must read `part`, the new column must default to `part`, `mode` must be immutable, and the check
 * constraint must refuse a third path.
 */
async function migrationLegs() {
  const { persistentConfig, createAdminPool, checksumOf } = await import('../server/owned-postgres/provision.mjs');
  const outcome = [];
  const leg = 'drill46';
  const push = (ok, name) => outcome.push([ok ? 'PASS' : 'FAIL', name]);
  const config = persistentConfig({ ...process.env, OWNAPI_PG_SCHEMA: leg, OWNAPI_PG_ROLE_PREFIX: leg });
  const admin = createAdminPool(config, { applicationName: `${leg}:checker` });
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'drill-46-'));
  const reset = async () => {
    await admin.query(`DROP SCHEMA IF EXISTS "${leg}" CASCADE`);
    const roles = (await admin.query('SELECT rolname FROM pg_roles WHERE rolname LIKE $1', [`${leg}\\_%`])).rows;
    for (const { rolname } of roles) {
      await admin.query(`DROP OWNED BY "${rolname}" CASCADE`).catch(() => {});
      await admin.query(`DROP ROLE IF EXISTS "${rolname}"`).catch(() => {});
    }
  };
  const migrate = (dir) => runNode(['server/migrate.mjs'], {
    OWNAPI_PG_SCHEMA: leg, OWNAPI_PG_ROLE_PREFIX: leg, OWNAPI_PG_ALLOW: '1', OWNAPI_MIGRATIONS_DIR: dir,
  });
  const insertSitting = (mode) => admin.query(
    `INSERT INTO "${leg}".practice_attempt
       (attempt_id, owner_id, exam_id, preparation_id, set_id, version, family, section, item_count, mode)
     VALUES ($1, $2, 'telc-deutsch-b1', $3, $4, 'v1', 'LV2', 'LV', 3, $5)`,
    [randomUUID(), insertSitting.owner, randomUUID(), `set-${randomUUID()}`, mode])
    .then(() => null).catch((error) => String(error.message));
  /**
   * A sitting written the way `practiceSetForPart` wrote it BEFORE 0046: no `mode` column in the statement
   * at all, which is the only way to prove that the migration's DEFAULT is what labels those rows.
   */
  const insertLegacySitting = () => admin.query(
    `INSERT INTO "${leg}".practice_attempt
       (attempt_id, owner_id, exam_id, preparation_id, set_id, version, family, section, item_count)
     VALUES ($1, $2, 'telc-deutsch-b1', $3, $4, 'v1', 'LV2', 'LV', 3)`,
    [randomUUID(), insertSitting.owner, randomUUID(), `set-${randomUUID()}`])
    .then(() => null).catch((error) => String(error.message));
  try {
    for (const name of fs.readdirSync(path.join(ROOT, 'server', 'migrations')).filter((entry) => /^\d{4}-.*\.sql$/.test(entry)).sort()) {
      if (name.startsWith('0046')) continue;
      fs.copyFileSync(path.join(ROOT, 'server', 'migrations', name), path.join(directory, name));
    }
    await reset();
    const head = await migrate(directory);
    if (head.code !== 0) throw new Error(`the 0045 head did not migrate: ${head.out.slice(-300)}`);
    const headCount = appliedCount(head.out);
    if (!headCount) throw new Error(`the 0045 head applied nothing: ${head.out.slice(-200)}`);

    insertSitting.owner = randomUUID();
    await admin.query(
      `INSERT INTO "${leg}"."user" (id, name, email, "emailVerified") VALUES ($1, 'Drill 46', $2, true)`,
      [insertSitting.owner, `${insertSitting.owner}@example.invalid`]);
    const before = await insertLegacySitting();
    if (before !== null) throw new Error(`a sitting could not be written on the 0045 head: ${before}`);
    const columns = (await admin.query(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = $1 AND table_name = 'practice_attempt' AND column_name = 'mode'`, [leg])).rows;
    assert.deepEqual(columns, [], 'the 0045 head has no mode column yet');

    fs.copyFileSync(path.join(ROOT, MIGRATION), path.join(directory, '0046-drill-mode.sql'));
    const after = await migrate(directory);
    if (after.code !== 0) throw new Error(`0046 did not apply alone: ${after.out.slice(-300)}`);
    assert.equal(appliedCount(after.out), 1, 'exactly ONE migration applied to the 0045 head');
    push(true, 'M1 0046 applies ALONE to a 0045 head, where the table already holds a sitting');

    const pre = (await admin.query(`SELECT mode FROM "${leg}".practice_attempt WHERE mode IS NOT NULL ORDER BY created_at LIMIT 1`)).rows[0];
    assert.equal(pre.mode, 'part', 'the PRE-EXISTING sitting reads "part" — never "drill" and never NULL');
    push(true, 'M2 every pre-existing sitting reads "part": the runner\'s rows keep their exact meaning');

    const defaulted = await insertLegacySitting();
    if (defaulted !== null) throw new Error(`an insert without a mode failed: ${defaulted}`);
    const parts = (await admin.query(`SELECT count(*)::int AS n FROM "${leg}".practice_attempt WHERE mode = 'part'`)).rows[0].n;
    assert.ok(parts >= 2, 'a row inserted without a mode defaults to "part"');
    push(true, 'M3 the column DEFAULTs to "part", so a runner insert needs no change');

    const drilled = await insertSitting('drill');
    if (drilled !== null) throw new Error(`an insert with mode=drill failed: ${drilled}`);
    push(true, 'M4 the drill path can insert mode=drill');
    const third = await insertSitting('practice');
    assert.match(String(third), /practice_attempt_mode_check/, 'a THIRD mode is refused by the check constraint');
    push(true, 'M5 only "part" and "drill" exist, and the constraint says so');

    const rewritten = await admin.query(`UPDATE "${leg}".practice_attempt SET mode = 'drill' WHERE mode = 'part'`)
      .then(() => null).catch((error) => String(error.message));
    assert.match(String(rewritten), /practice_attempt_identity_immutable/, 'a sitting\'s mode cannot be re-labelled');
    push(true, 'M6 the trigger refuses to re-label a sitting: mode joins the immutable identity row');

    const recorded = JSON.parse(read('server/migrations/MANIFEST.json')).migrations['0046-drill-mode'];
    const actual = checksumOf(fs.readFileSync(path.join(ROOT, MIGRATION)));
    assert.equal(recorded, actual, 'the MANIFEST entry is the migrator\'s own sha256 of the reviewed bytes');
    push(true, 'M7 the MANIFEST line is the sha256 of the migration\'s bytes');
  } catch (error) {
    outcome.push(['FAIL', `the 0046 migration legs could not run: ${firstLine(error)}`]);
  } finally {
    await reset().catch(() => {});
    await admin.end().catch(() => {});
    fs.rmSync(directory, { recursive: true, force: true });
  }
  return outcome;
}

/* ----------------------------------------------------------------------- mutations */

const MUTATIONS = [
  ['M1 the weak tier no longer outranks unseen and strong', (source) => source.replace(
    '    const at = DRILL_TIERS.indexOf(a.tier);\n    const bt = DRILL_TIERS.indexOf(b.tier);\n    if (at !== bt) return at - bt;',
    '    /* M1: the tier order is gone */')],
  ['M2 the drill serves the FIRST item instead of the next one', (source) => source.replace(
    '  return answered < list.length ? list[answered] : null;',
    '  return list.length ? list[0] : null;')],
  ['M3 the OLDEST sitting wins instead of the newest', (source) => source.replace(
    '    if (at !== bt) return at < bt ? 1 : -1; // newest first',
    '    if (at !== bt) return at < bt ? -1 : 1; // M3: oldest first')],
  ['M4 an unseen part is called weak', (source) => source.replace(
    "  if (attempts === 0) return 'unseen';",
    "  if (attempts === 0) return 'weak';")],
  /*
   * FIX-F1 MUTATION A: the SKIP IS TURNED BACK INTO A BLOCK. This is the rule the first H1 fix got wrong, so
   * the mutation restores exactly that behaviour: a weak listening part stops the walk and is named. The legs
   * that must fail are the drill ones that now assert a playable part is SERVED.
   */
  ['M7 a weak listening part blocks the drill again (the corrected H1 rule)', (source) => source.replace(
    '    if (part.media === true) {\n      if (!mediaPart) mediaPart = part;\n      continue;\n    }\n'
    + '    return { kind: \'item\', part };',
    '    if (part.media === true && part.tier === \'weak\') return { kind: \'listening_blocked\', part }; // M7\n'
    + '    if (part.media !== true) return { kind: \'item\', part };')],
  /*
   * FIX-F1 MUTATION B: THE EVIDENCE FILTER IS REMOVED, so a guess about inaudible audio makes the listening
   * part look weak again and can steer the choice. The pure legs that assert the filter must fail.
   */
  ['M8 the playability filter is removed, so blind listening guesses count', (source) => source.replace(
    '    if (nonEmpty(row.mock_run_id)) return true;\n    return !mediaBound.has(key);',
    '    return true; // M8: unplayable sets count again')],
  /*
   * FIX-N1 MUTATION: THE MOCK CLAUSE IS REMOVED, which is the defect the second-pass review found — real
   * Probeprüfung listening results thrown away by a rule meant for blind guesses. THIS leg must fail by name.
   */
  ['M9 the mock_run_id clause is removed, so a Probeprüfung listening result is dropped again', (source) => source.replace(
    '    if (nonEmpty(row.mock_run_id)) return true;\n    return !mediaBound.has(key);',
    '    return !mediaBound.has(key); // M9: mock evidence filtered out again')],
];

const CLIENT_MUTATIONS = [
  ['M5 the drill posts the option ID instead of its typed VALUE', (source) => source.replace(
    'attemptId, itemId: item.item_id, answer: picked.value, language, latencyMs: latency,',
    'attemptId, itemId: item.item_id, answer: picked.key, language, latencyMs: latency,')],
  ['M6 the client marks its own answer instead of reading the server verdict', (source) => source.replace(
    "data-verdict=\"' + (checked.correct ? 'correct' : 'wrong') + '\"",
    'data-verdict="correct"')],
];

const tempTree = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

/* --------------------------------------------------------------------------- main */

/** The real modules, plus the catalogue the i18n legs read. */
async function loadRoot() {
  const core = await import(pathToFileURL(path.join(ROOT, 'public/assets/i18n/core.js')).href);
  if (typeof core.setLocale === 'function') core.setLocale('de');
  const messages = await import(pathToFileURL(path.join(ROOT, MESSAGES)).href);
  return {
    pure: await import(pathToFileURL(path.join(ROOT, PURE)).href),
    client: await import(pathToFileURL(path.join(ROOT, CLIENT)).href),
    pt: messages.pt,
    catalogues: { practice: messages.PRACTICE_MESSAGES },
  };
}

const main = async () => {
  /* A MISSING FILE IS A NAMED FAILURE, NOT AN UNCAUGHT IMPORT ERROR. REVIEW-DRILL-01 measured exit 1 with a
     Node stack trace and no tally when `public/app/drill.js` was removed: loud in outcome, useless in form.
     This is the first thing the gate does, so the tally explains itself either way. */
  const required = [PURE, CLIENT, CSS, API, ROUTES, PORT, ADAPTER, MESSAGES, MIGRATION];
  const missing = required.filter((relative) => !fs.existsSync(path.join(ROOT, relative)));
  if (missing.length) {
    for (const relative of missing) console.log(`FAIL the slice module is missing: ${relative}`);
    console.log(`${missing.length} legs, ${missing.length} failed`);
    return 1;
  }
  /* The mutation proof runs by default, like `practice-selection-check`'s: a rule this slice depends on is
     only proved by breaking it. `--no-mutations` exists for a fast loop. */
  const runMutations = !process.argv.includes('--no-mutations');
  const deps = await loadRoot();
  const legNames = [];
  const failures = [];
  const report = (results) => {
    for (const [result, name] of results) {
      console.log(`${result} ${name}`);
      legNames.push(name);
      if (result === 'FAIL') failures.push(name);
    }
  };

  report(await runLegs('', deps));

  if (process.argv.includes('--postgres')) {
    try {
      report(await postgresLegs());
    } catch (error) {
      console.log(`postgres: legs could not run: ${firstLine(error)}`);
      console.log(String((error && error.stack) || error).split('\n').slice(0, 12).join('\n'));
      report([['FAIL', `postgres legs could not run: ${firstLine(error)}`]]);
    }
    try {
      report(await migrationLegs());
    } catch (error) {
      report([['FAIL', `the 0046 migration legs could not run: ${firstLine(error)}`]]);
    }
  }

  const mutationNote = [];
  if (runMutations) {
    /* Control: the pristine copies must keep passing in the throwaway trees. */
    const pureControl = tempTree('drill-control-pure-');
    fs.mkdirSync(path.join(pureControl, path.dirname(PURE)), { recursive: true });
    fs.copyFileSync(path.join(ROOT, PURE), path.join(pureControl, PURE));
    const pureControlResults = (await runLegs('', { ...deps, pure: await import(pathToFileURL(path.join(pureControl, PURE)).href) }))
      .filter(([result]) => result === 'FAIL');
    assert.deepEqual(pureControlResults, [], `the pristine pure copy must pass: ${JSON.stringify(pureControlResults.slice(0, 2))}`);
    fs.rmSync(pureControl, { recursive: true, force: true });

    const clientControl = tempTree('drill-control-client-');
    fs.cpSync(path.join(ROOT, 'public'), path.join(clientControl, 'public'), { recursive: true });
    const controlCore = await import(pathToFileURL(path.join(clientControl, 'public/assets/i18n/core.js')).href);
    if (typeof controlCore.setLocale === 'function') controlCore.setLocale('de');
    const controlClientResults = (await runLegs('', { ...deps, client: await import(pathToFileURL(path.join(clientControl, CLIENT)).href) }))
      .filter(([result]) => result === 'FAIL');
    assert.deepEqual(controlClientResults, [], `the pristine client copy must pass: ${JSON.stringify(controlClientResults.slice(0, 2))}`);
    fs.rmSync(clientControl, { recursive: true, force: true });

    for (const [label, mutate] of MUTATIONS) {
      /* Compare and mutate on LF: the working copy may carry CRLF (core.autocrlf), and a mutation written
         with `\n` would silently match nothing and "pass" without changing the module. */
      const source = fs.readFileSync(path.join(ROOT, PURE), 'utf8').replaceAll('\r\n', '\n');
      const mutated = mutate(source);
      assert.notEqual(mutated, source, `${label}: the mutation must change the module`);
      const tree = tempTree('drill-mut-pure-');
      fs.mkdirSync(path.join(tree, path.dirname(PURE)), { recursive: true });
      fs.writeFileSync(path.join(tree, PURE), mutated);
      const broken = (await runLegs('', { ...deps, pure: await import(pathToFileURL(path.join(tree, PURE)).href) }))
        .filter(([result]) => result === 'FAIL').map(([, name]) => name);
      fs.rmSync(tree, { recursive: true, force: true });
      assert.ok(broken.length > 0, `${label}: no leg failed on the mutated module`);
      mutationNote.push(`${label} -> ${broken.length} leg(s) fail: ${broken[0]}`);
    }
    for (const [label, mutate] of CLIENT_MUTATIONS) {
      const source = fs.readFileSync(path.join(ROOT, CLIENT), 'utf8').replaceAll('\r\n', '\n');
      const mutated = mutate(source);
      assert.notEqual(mutated, source, `${label}: the mutation must change the module`);
      const tree = tempTree('drill-mut-client-');
      fs.cpSync(path.join(ROOT, 'public'), path.join(tree, 'public'), { recursive: true });
      fs.writeFileSync(path.join(tree, CLIENT), mutated);
      const mutatedCore = await import(pathToFileURL(path.join(tree, 'public/assets/i18n/core.js')).href);
      if (typeof mutatedCore.setLocale === 'function') mutatedCore.setLocale('de');
      const broken = (await runLegs('', { ...deps, client: await import(pathToFileURL(path.join(tree, CLIENT)).href) }))
        .filter(([result]) => result === 'FAIL').map(([, name]) => name);
      fs.rmSync(tree, { recursive: true, force: true });
      assert.ok(broken.length > 0, `${label}: no leg failed on the mutated module`);
      mutationNote.push(`${label} -> ${broken.length} leg(s) fail: ${broken[0]}`);
    }
  }

  for (const failure of failures) console.log(`FAIL ${failure}`);
  console.log(`${legNames.length} legs, ${failures.length} failed`);
  for (const note of mutationNote) console.log(`MUTATION ${note}`);
  return failures.length ? 1 : 0;
};

process.exitCode = await main();

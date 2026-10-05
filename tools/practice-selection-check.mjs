#!/usr/bin/env node
/**
 * PRACTICE-01 (slice C) — the selection rule and the runner's wrap rule, proved against CRAFTED evidence
 * rows rather than a narrative, and mutation-proved.
 *
 *   node tools/practice-selection-check.mjs            the legs, plus the built-in mutation proof
 *   node tools/practice-selection-check.mjs --list      leg names only
 *
 * OFFLINE. `server/practice-sets.mjs` is pure by design (no SQL, no policy, no connection), so the three
 * tiers can be driven with fabricated evidence here; the SQL that must agree with it is exercised by
 * tools/practice-selection-check.mjs --postgres in the disposable database.
 *
 * MUTATION PROOF. The shipped module is copied into a temporary directory, one rule is broken in the copy,
 * and the same legs are re-run against it: a leg that does not fail on a broken rule is not a leg. The
 * mutations are the rule's own three tiers plus the wrap, so the proof covers exactly the behaviour the
 * slice claims.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MODULE = 'server/practice-sets.mjs';

const legNames = [];
const failures = [];
const leg = (name, run) => {
  legNames.push(name);
  try { run(); } catch (error) { failures.push(`${name}: ${error.message.split('\n')[0]}`); }
};

/** Three released sets of LV2, the A1 shape: three sets per part, five items each. */
const candidates = () => ([
  { set_id: 'lv2-set-a', version: 'v1', item_count: 5, media_required: false },
  { set_id: 'lv2-set-b', version: 'v1', item_count: 5, media_required: false },
  { set_id: 'lv2-set-c', version: 'v1', item_count: 5, media_required: false },
]);
const evidence = (spec) => spec.flatMap(([setId, wrong, correct, answeredAt]) => ([
  ...Array.from({ length: wrong }, () => ({ set_id: setId, correct: false, answered_at: answeredAt })),
  ...Array.from({ length: correct }, () => ({ set_id: setId, correct: true, answered_at: answeredAt })),
]));

const legs = (mod) => [
  ['1 tier 1: an unseen set is chosen over a set with wrong answers', () => {
    const chosen = mod.selectPracticeSet(candidates(), evidence([['lv2-set-a', 3, 0, '2026-10-01T10:00:00Z']]));
    assert.equal(chosen.set_id, 'lv2-set-b', 'an unseen set must win');
    assert.equal(chosen.tier, 'unseen');
  }],
  ['2 tier 1: with every set unseen, the choice is deterministic (set id)', () => {
    const chosen = mod.selectPracticeSet(candidates(), []);
    assert.equal(chosen.set_id, 'lv2-set-a');
    assert.deepEqual(mod.selectPracticeSet(candidates(), []).set_id, mod.selectPracticeSet(candidates(), []).set_id);
  }],
  ['3 tier 2: with all sets seen, the most wrong items win', () => {
    const chosen = mod.selectPracticeSet(candidates(), evidence([
      ['lv2-set-a', 2, 3, '2026-10-01T10:00:00Z'],
      ['lv2-set-b', 4, 1, '2026-10-05T10:00:00Z'],
      ['lv2-set-c', 1, 4, '2026-10-03T10:00:00Z'],
    ]));
    assert.equal(chosen.set_id, 'lv2-set-b', 'four wrong must beat two and one');
    assert.equal(chosen.tier, 'most-wrong');
    assert.equal(chosen.wrong, 4);
  }],
  ['4 tier 3: equal wrong counts fall back to the OLDEST set', () => {
    const chosen = mod.selectPracticeSet(candidates(), evidence([
      ['lv2-set-a', 2, 3, '2026-10-04T10:00:00Z'],
      ['lv2-set-b', 2, 3, '2026-10-02T10:00:00Z'],
      ['lv2-set-c', 2, 3, '2026-10-06T10:00:00Z'],
    ]));
    assert.equal(chosen.set_id, 'lv2-set-b', 'the oldest first touch must win');
    assert.equal(chosen.first_seen_at, '2026-10-02T10:00:00.000Z');
  }],
  ['5 a set with no wrong answers is not treated as "most wrong"', () => {
    const ranked = mod.rankPracticeSets(candidates(), evidence([
      ['lv2-set-a', 0, 5, '2026-10-01T10:00:00Z'],
      ['lv2-set-b', 1, 4, '2026-10-05T10:00:00Z'],
      ['lv2-set-c', 0, 5, '2026-10-02T10:00:00Z'],
    ]));
    assert.deepEqual(ranked.map((row) => row.set_id), ['lv2-set-b', 'lv2-set-a', 'lv2-set-c']);
    assert.equal(ranked[0].tier, 'most-wrong');
    assert.equal(ranked[1].tier, 'oldest', 'zero wrong is the oldest tier, not the wrong tier');
  }],
  ['6 evidence for another set is ignored, not guessed at', () => {
    const ranked = mod.rankPracticeSets(candidates(), [
      { set_id: 'lv3-set-a', correct: false, answered_at: '2026-10-01T10:00:00Z' },
      { set_id: null, correct: false, answered_at: '2026-10-01T10:00:00Z' },
    ]);
    assert.equal(ranked.length, 3, 'no phantom candidate');
    assert.ok(ranked.every((row) => row.seen === 0), 'foreign evidence must not mark a set as seen');
  }],
  ['7 the ranking is total: identical evidence always yields the identical order', () => {
    const a = mod.rankPracticeSets(candidates(), evidence([['lv2-set-a', 1, 0, '2026-10-01T10:00:00Z']]));
    const b = mod.rankPracticeSets(candidates(), evidence([['lv2-set-a', 1, 0, '2026-10-01T10:00:00Z']]));
    assert.deepEqual(a, b);
  }],
  ['8 wrap: the fourth "Noch ein Satz" of a three-set part wraps instead of restarting', () => {
    const wrap = mod.practiceRoundState({ setCount: 3, checkedSets: 3 });
    assert.equal(wrap.wrapped, true, 'three of three checked must wrap');
    assert.equal(wrap.notice, 'practiceAllSets', 'the wrap must carry the notice key, not a restart');
    assert.equal(wrap.round, 3);
    /* REVIEW-PRACTICE-01-SERVER D4: a wrap begins no further round, so `round` never exceeds `setCount`. A
       client rendering "Runde {round} von {setCount}" therefore needs no special case, and the doc now says
       exactly that instead of promising the round the next tap begins. */
    assert.ok(wrap.round <= wrap.setCount, 'a wrap must not report a round beyond the part');
  }],
  ['9 wrap: before the part is exhausted the next round is a normal round', () => {
    assert.deepEqual(mod.practiceRoundState({ setCount: 3, checkedSets: 0 }), { setCount: 3, checkedSets: 0, wrapped: false, round: 1, notice: null });
    assert.deepEqual(mod.practiceRoundState({ setCount: 3, checkedSets: 2 }), { setCount: 3, checkedSets: 2, wrapped: false, round: 3, notice: null });
  }],
  ['10 wrap: an unknown set count does not claim the part is finished', () => {
    assert.equal(mod.practiceRoundState({ setCount: 0, checkedSets: 4 }).wrapped, false);
    assert.equal(mod.practiceRoundState({ setCount: null, checkedSets: 1 }).wrapped, false);
  }],
  /*
   * The served DTO is built from the authored corpus in `server/migrations/0010-objective-catalogue.sql`.
   * These legs use the REAL shape of each part family rather than an invented one, because the first version
   * of the normaliser passed its own fiction while serving seven of eight families as a 500.
   */
  ['11 HV (items): the item id IS the answer key and a richtig/falsch value must be a BOOLEAN', () => {
    const served = mod.normalisePracticeSet({
      set_id: 'telc-deutsch-b1.hv1.01', version: 'v1', family: 'HV1', section: 'HV', part: '1', item_count: 2,
      payload: { title: 'Nachrichten von Freunden', items: [
        { n: 41, statement: 'Anna kann am Freitag nicht ins Kino gehen.' },
        { n: 42, statement: 'Ben sagt das Fußballtreffen am Samstag ab.' },
      ] },
    });
    assert.deepEqual(served.items.map((item) => item.item_id), ['41', '42'], 'objective_key.answers is keyed "41"');
    assert.equal(served.items[0].prompt, 'Anna kann am Freitag nicht ins Kino gehen.');
    assert.deepEqual(served.items[0].options.map((option) => option.id), ['true', 'false']);
    assert.deepEqual(served.items[0].options.map((option) => option.value), [true, false],
      'mark_objective_item compares jsonb, so a HV answer posted as the string "true" is marked wrong');
    assert.equal(served.items[0].answer_kind, 'judgement');
    assert.deepEqual(served.material, {}, 'HV carries no set-level material');
  }],
  ['12 LV1 (texts): the prompt is the item text and the options are the set-level headlines', () => {
    const served = mod.normalisePracticeSet({
      set_id: 'telc-deutsch-b1.lv1.01', version: 'v1', family: 'LV1', section: 'LV', part: '1', item_count: 1,
      payload: {
        title: 'Wohnung', texts: [{ id: '1', text: 'Wir suchen eine Mitbewohnerin.' }],
        headlines: [{ id: 'a', text: 'Ferienhaus' }, { id: 'b', text: 'WG-Zimmer' }],
      },
    });
    assert.deepEqual(served.items.map((item) => item.item_id), ['1']);
    assert.equal(served.items[0].prompt, 'Wir suchen eine Mitbewohnerin.');
    assert.deepEqual(served.items[0].options.map((option) => [option.id, option.text]),
      [['a', 'Ferienhaus'], ['b', 'WG-Zimmer']]);
    assert.equal(served.items[0].answer_kind, 'choice');
    assert.equal(served.material.headlines.length, 2);
  }],
  ['13 LV2 (questions): per-item OBJECT options become an ordered choice list', () => {
    const served = mod.normalisePracticeSet({
      set_id: 'telc-deutsch-b1.lv2.01', version: 'v1', family: 'LV2', section: 'LV', part: '2', item_count: 1,
      payload: { title: 'Verkehr', text: 'Die Stadt Freiburg will den Verkehr neu ordnen.', questions: [
        { n: 6, question: 'Was soll sich ändern?', options: { a: 'Autos überall', b: 'Radwege', c: 'Kein Bus' } },
      ] },
    });
    assert.deepEqual(served.items.map((item) => item.item_id), ['6']);
    assert.equal(served.items[0].prompt, 'Was soll sich ändern?');
    assert.deepEqual(served.items[0].options.map((option) => option.id), ['a', 'b', 'c']);
    assert.equal(served.items[0].options[1].text, 'Radwege');
    assert.equal(served.material.text, 'Die Stadt Freiburg will den Verkehr neu ordnen.');
  }],
  ['14 LV3 (situations): the ads are the options and the no-match sentinel is offered', () => {
    const served = mod.normalisePracticeSet({
      set_id: 'telc-deutsch-b1.lv3.01', version: 'v1', family: 'LV3', section: 'LV', part: '3', item_count: 1,
      payload: { title: 'Anzeigen', ads: [{ id: 'a', text: 'Umzugshilfe' }], situations: [{ n: 11, text: 'Sie brauchen Hilfe.' }] },
    });
    assert.deepEqual(served.items.map((item) => item.item_id), ['11']);
    assert.equal(served.items[0].prompt, 'Sie brauchen Hilfe.');
    assert.deepEqual(served.items[0].options.map((option) => option.id), ['a', 'x'],
      'the key uses "x" for "no ad fits", so it must be offered');
  }],
  ['15 SB1 (gaps): a gap carries its OWN options and no prompt text — the letter does', () => {
    const served = mod.normalisePracticeSet({
      set_id: 'telc-deutsch-b1.sb1.01', version: 'v1', family: 'SB1', section: 'SB', part: '1', item_count: 1,
      payload: {
        letter: 'Am Freitag {21} wir in Neapel angekommen.',
        gaps: [{ n: 21, options: { a: 'haben', b: 'sind', c: 'werden' } }],
      },
    });
    assert.deepEqual(served.items.map((item) => item.item_id), ['21']);
    assert.deepEqual(served.items[0].options.map((option) => option.id), ['a', 'b', 'c']);
    assert.equal(served.items[0].prompt, '');
    assert.equal(served.material.letter, 'Am Freitag {21} wir in Neapel angekommen.');
  }],
  ['16 SB2 (gaps + bank): a gap with no own options draws the set-level bank', () => {
    const served = mod.normalisePracticeSet({
      set_id: 'telc-deutsch-b1.sb2.01', version: 'v1', family: 'SB2', section: 'SB', part: '2', item_count: 2,
      payload: { letter: '{31} schreibe ich Ihnen.', gaps: [{ n: 31 }, { n: 32 }], bank: [
        { id: 'a', word: 'DESHALB' }, { id: 'b', word: 'WEIL' }, { id: 'c', word: 'OBWOHL' },
      ] },
    });
    assert.deepEqual(served.items.map((item) => item.item_id), ['31', '32']);
    assert.deepEqual(served.items[0].options.map((option) => [option.id, option.text]),
      [['a', 'DESHALB'], ['b', 'WEIL'], ['c', 'OBWOHL']]);
    assert.equal(served.items[0].answer_kind, 'choice');
  }],
  ['17 a served item is REBUILT, so an authored answer/transcript/explanation cannot ride along', () => {
    const served = mod.normalisePracticeSet({
      set_id: 'telc-deutsch-b1.lv2.01', version: 'v1', family: 'LV2', section: 'LV', part: '2', item_count: 1,
      payload: { title: 'x', text: 'y', questions: [
        { n: 6, question: 'Was?', options: { a: 'A', b: 'B' }, answer: 'b', transcript: 'geheim', explanation: 'weil' },
      ] },
    });
    /* A whitelist, not a blacklist: a broad /answer/ scan would flag the DTO's own `answer_kind`. */
    const ITEM_KEYS = ['item_id', 'ordinal', 'prompt', 'prompt_en', 'answer_kind', 'options'];
    const OPTION_KEYS = ['id', 'text', 'value'];
    for (const item of served.items) {
      assert.deepEqual(Object.keys(item).filter((key) => !ITEM_KEYS.includes(key)), [],
        `${item.item_id} may only carry the served contract`);
      for (const option of item.options) {
        assert.deepEqual(Object.keys(option).filter((key) => !OPTION_KEYS.includes(key)), [], 'option contract');
      }
    }
    const withPlayback = mod.normalisePracticeSet(
      { set_id: 's', version: 'v1', item_count: 1, payload: { items: [{ n: 1, statement: 'a' }] } }, { exam: 2, practice: 1 });
    assert.deepEqual(withPlayback.playback, { exam: 2, practice: 1 });
    assert.equal(mod.normalisePracticeSet({ set_id: 's', version: 'v1', item_count: 1, payload: { items: [{ n: 1, statement: 'a' }] } }).playback, null);
  }],
  ['18 a malformed set throws instead of serving a page the learner cannot answer', () => {
    assert.throws(
      () => mod.normalisePracticeSet({ set_id: 's', version: 'v1', item_count: 3, payload: { items: [{ n: 1, statement: 'a' }, { n: 2, statement: 'b' }] } }),
      /practice_set_invalid/, 'the declared count disagrees with the authored rows');
    assert.throws(() => mod.normalisePracticeSet({ set_id: 's', version: 'v1', payload: { title: 'nothing authored' } }),
      /practice_set_items_unknown/);
    assert.throws(() => mod.normalisePracticeSet({ set_id: 's', version: 'v1', item_count: 1, payload: { gaps: [{ n: 7 }] } }),
      /practice_set_invalid/, 'a gap with no options and no bank is unanswerable');
    assert.throws(() => mod.normalisePracticeSet({ version: 'v1' }), /practice_set_invalid/);
  }],
  /*
   * REVIEW-PRACTICE-01-SERVER D2 — SB1 has FOUR released sets, not three. `0010` seeds 24 sets; the 25th is
   * `telc-deutsch-b1.sb1.grammar-wortstellung-v1`, the recovered grammar drill from migration `0022`. It is
   * released practice content, so it is disclosed rather than filtered out: the drill's own `practice_kind`
   * and `instruction` say in as many words that it is not a telc exam set, and both used to be dropped.
   */
  ['19 the recovered grammar drill DISCLOSES itself in the served material', () => {
    const served = mod.normalisePracticeSet({
      set_id: 'telc-deutsch-b1.sb1.grammar-wortstellung-v1', version: 'v1', family: 'SB1', section: 'SB', part: '1',
      item_count: 2,
      payload: {
        practice_kind: 'grammar-drill',
        instruction: 'Ergänze die Sätze. Dies sind einzelne Grammatikübungen, kein telc-Prüfungssatz.',
        letter: 'Ich weiß nicht, {1} er kommt.',
        gaps: [{ n: 1, options: { a: 'ob', b: 'dass', c: 'weil' } }, { n: 2, options: { a: 'ob', b: 'dass', c: 'weil' } }],
      },
    });
    assert.equal(served.material.practice_kind, 'grammar-drill', 'the set must say what kind of practice it is');
    assert.match(served.material.instruction, /kein telc-Prüfungssatz/,
      'and must carry its own "not an exam set" instruction to the learner');
    assert.equal(served.items.length, 2);
    assert.equal(served.items[0].answer_kind, 'choice');
  }],
  ['20 the wrap counts what the part SERVES: SB1 wraps on the FIFTH tap, a three-set part on the fourth', () => {
    const sb1 = mod.practiceRoundState({ setCount: 4, checkedSets: 3 });
    assert.deepEqual([sb1.wrapped, sb1.notice, sb1.round], [false, null, 4], 'three of SB1 four is not yet a wrap');
    const wrapped = mod.practiceRoundState({ setCount: 4, checkedSets: 4 });
    assert.deepEqual([wrapped.wrapped, wrapped.notice, wrapped.round], [true, 'practiceAllSets', 4],
      'the fifth tap of SB1 wraps, and no round beyond the part is reported');
  }],
];

const load = async (directory) => {
  const url = new URL(`file://${path.join(directory, MODULE).replaceAll('\\', '/')}`);
  return import(url.href);
};

const MUTATIONS = [
  ['M1 unseen no longer wins', (source) => source.replace('if ((a.seen === 0) !== (b.seen === 0)) return a.seen === 0 ? -1 : 1;', '/* M1: tier 1 removed */')],
  ['M2 most wrong becomes most correct', (source) => source.replace('if (a.wrong !== b.wrong) return b.wrong - a.wrong;', 'if (a.wrong !== b.wrong) return a.wrong - b.wrong;')],
  ['M3 oldest becomes newest', (source) => source.replace('if (at !== bt) return at - bt;', 'if (at !== bt) return bt - at;')],
  ['M4 the wrap never fires', (source) => source.replace("const wrapped = total > 0 && done >= total;", 'const wrapped = false;')],
  ['M5 the served item stops being rebuilt and the raw authored row rides along', (source) => source.replace('      item_id: String(rawId),', '      ...item,\n      item_id: String(rawId),')],
  /*
   * REVIEW-PRACTICE-MEDIA F7 fallout: matching the whole MATERIAL_MEMBERS line broke the moment the media
   * merge added `recordings` to it — the mutation silently stopped changing anything and the harness caught
   * it ("the mutation must change the module"). The regex keeps the mutation honest as the member list grows.
   */
  ['M6 the set stops disclosing what kind of practice it is (D2)', (source) => source.replace(
    /const MATERIAL_MEMBERS = Object\.freeze\(\[[^\]]*\]\);/,
    "const MATERIAL_MEMBERS = Object.freeze(['text', 'letter', 'headlines', 'ads', 'bank']);")],
];

/**
 * The PostgreSQL legs: the SAME rule through the SHIPPED SQL, with crafted evidence rows.
 *
 * The offline legs prove the pure rule; these prove the SQL the adapter runs agrees with it — the three
 * tiers, the wrap state, the sitting's separation from mock runs, and the state trigger. Everything is
 * synthetic: the evidence is inserted by the admin role, and the fixture database is disposable.
 */
const postgresLegs = async () => {
  if (process.env.OWNAPI_PG_ALLOW !== '1' || process.env.OWNAPI_PG_HOST !== '127.0.0.1') {
    throw new Error('explicit local disposable PostgreSQL required (OWNAPI_PG_ALLOW=1, OWNAPI_PG_HOST=127.0.0.1)');
  }
  const { randomUUID } = await import('node:crypto');
  const { createFixture } = await import('../server/owned-postgres/bootstrap.mjs');
  const { createPostgresWorld } = await import('../server/owned-postgres/fixture.mjs');
  const EXAM = 'telc-deutsch-b1';
  const outcome = [];
  const pgLeg = async (name, run) => {
    try { await run(); outcome.push(['PASS', name]); } catch (error) { outcome.push(['FAIL', `${name}: ${String(error.message).split('\n')[0]}`]); }
  };

  /*
   * The fixture publishes UNREVIEWED, generated content. The default content mode is `public`, which serves
   * APPROVED content only — so with the mode unset every candidate query correctly returned nothing and the
   * legs reported a null service rather than a defect. Pin the preview policy in-process, exactly as the
   * other disposable-fixture checks do (`exam-s4-pg-check`, `owned-api-pg-check`, `objective-key-access-check`),
   * and restore the caller's environment afterwards so this check cannot leak policy into a later one.
   */
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
    const step = async (label, run) => {
      try { return await run(); } catch (error) { throw new Error(`setup step "${label}" failed: ${error.code || ''} ${String(error.message).split('\n')[0]}`); }
    };
    const signup = await step('signUp', () => world.sessions.signUp({
      name: 'Practice selection', email: `practice-selection-${Date.now()}@example.invalid`,
      password: 'synthetic-practice-selection-password',
    }));
    const cookie = String(signup.setCookie).split(';')[0];
    const owner = (await world.sessions.getSession({ cookie })).userId;
    const created = await step('createPreparation', () => port.createPreparation(owner, EXAM));
    const preparationId = (created.preparation ?? created).id;

    const sets = (await db.admin.query(
      `SELECT set_id, version, family, item_count, media_required FROM objective_set
        WHERE exam_id = $1 AND family LIKE 'HV%' ORDER BY family, set_id, version`, [EXAM])).rows;
    console.log(`postgres: ${sets.length} released HV set row(s) published by the fixture`);
    if (sets.length < 3) throw new Error(`the fixture publishes ${sets.length} HV sets, so the rule cannot be exercised`);

    const family = sets[0].family;
    const familySets = sets.filter((row) => row.family === family);
    const [a, b] = familySets;
    /*
     * Crafted evidence must be written the way a LEARNER writes it — the root cause of the `not_found` abort.
     *
     * `item_evidence` carries the row guard `guard_review_use` (0036), which raises `not_found` when
     * `hatoove.owner_id` is unbound. The guard is SECURITY DEFINER and does NOT test `current_user`, so it
     * fires on the admin connection too: inserting through `db.admin` aborted the whole fixture before any
     * tier leg could report, and pg-pool then replaced the stack, so the wrapper printed a bare `not_found`.
     *
     * The fix is NOT to weaken the guard but to write the rows through the same owner-bound transaction the
     * shipped adapter uses, so the crafted evidence passes the same RLS `WITH CHECK` and the same triggers
     * (`require_active_preparation`, `protect_mock_evidence`, `a_s6_new_admission`) as a real answer. The
     * remaining admin reads and the P4/P6 state mutations are deliberate: those legs test the table and its
     * trigger, and must not be able to lean on the owner policy to pass.
     */
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
    const craft = async (row, wrong, correct, answeredAt) => {
      await asOwner(async (client) => {
        for (let index = 0; index < wrong + correct; index += 1) {
          await client.query(
            `INSERT INTO item_evidence
               (evidence_id, owner_id, exam_id, set_id, version, item_id, family, section, answer, correct,
                latency_ms, preparation_id, answered_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, NULL, $11, $12)`,
            [randomUUID(), owner, EXAM, row.set_id, row.version, `crafted-${index}`, family, 'HV',
              JSON.stringify('a'), index >= wrong, preparationId, answeredAt]);
        }
      });
    };
    const servedNow = (part = family) => port.practiceSetForPart(owner, { preparationId, family: part });
    /**
     * The shipped key, read the way the product stores it: `objective_key.answers` is a JSONB object keyed by
     * exactly the item ids the DTO serves (`"41"`, `"6"`, …) and valued `true`/`false` for a listening part
     * and a choice letter otherwise. Every identity leg below is an assertion against THIS, not against the
     * check's own expectations.
     */
    const keysFor = async (setId) => {
      const row = (await db.admin.query(
        'SELECT answers FROM objective_key WHERE set_id = $1 AND version = $2', [setId, 'v1'])).rows[0];
      assert.ok(row, `the fixture has no objective_key for ${setId}`);
      return row.answers;
    };

    await pgLeg('P1 SQL tier 1: an unseen set is served, and the reason says so', async () => {
      const served = await servedNow();
      assert.equal(served.reason, 'unseen', 'an untouched part must report the unseen tier');
      assert.equal(served.set.set_id, familySets.map((row) => row.set_id).sort()[0], 'total tie-break by set id');
      assert.equal(served.attempt.state, 'open', 'serving a set opens the sitting');
      assert.deepEqual([served.round.checkedSets, served.round.wrapped], [0, false]);
    });

    await craft(a, 2, 0, '2026-10-01T10:00:00Z');
    await craft(b, 3, 0, '2026-10-02T10:00:00Z');
    await craft(familySets[2], 0, 1, '2026-10-03T10:00:00Z');
    await pgLeg('P2 SQL tier 2: with every set seen, the most wrong is served', async () => {
      const served = await servedNow();
      assert.equal(served.reason, 'most-wrong');
      assert.equal(served.set.set_id, b.set_id, 'three wrong must beat two and zero');
      assert.equal(served.evidence.wrong, 3);
    });

    await db.admin.query('DELETE FROM item_evidence WHERE owner_id = $1', [owner]);
    await craft(a, 2, 0, '2026-10-04T10:00:00Z');
    await craft(b, 2, 0, '2026-10-01T10:00:00Z');
    await craft(familySets[2], 2, 0, '2026-10-06T10:00:00Z');
    await pgLeg('P3 SQL tier 3: equal wrong counts fall back to the oldest first touch', async () => {
      const served = await servedNow();
      assert.equal(served.set.set_id, b.set_id, 'the earliest first touch must win');
      assert.equal(served.evidence.wrong, 2);
    });

    /*
     * The A1 wrap, built the way a LEARNER builds it: three sittings, each CHECKED through the shipped
     * method, then the fourth tap. This replaces a raw `UPDATE practice_attempt SET state='checked'`, which
     * had two faults. It bypassed the shipped path; and because the rule had served hv1.02 in both P2 and P3,
     * only TWO distinct sets could ever be checked — so the leg's own setup could not satisfy its assertion.
     * It had never been executed. Clearing the crafted evidence first makes the rule serve unseen sets, so
     * three rounds genuinely check three distinct sets.
     */
    await step('three checked practice rounds', async () => {
      await db.admin.query('DELETE FROM item_evidence WHERE owner_id = $1', [owner]);
      const rounded = [];
      for (let round = 1; round <= 3; round += 1) {
        const serving = await servedNow();
        if (!serving) throw new Error(`round ${round} served nothing`);
        const keys = await keysFor(serving.set.set_id);
        await port.checkPracticeAttempt(owner, {
          preparationId, attemptId: serving.attempt.attempt_id,
          answers: serving.set.items.map((item) => ({ item_id: item.item_id, answer: keys[item.item_id] })),
        });
        rounded.push(serving.set.set_id);
      }
      if (new Set(rounded).size !== 3) throw new Error(`three rounds checked ${new Set(rounded).size} distinct set(s): ${rounded.join(', ')}`);
    });
    await pgLeg('P4 SQL wrap: three checked sets make the fourth tap a wrap, not a restart', async () => {
      const checked = (await db.admin.query(
        `SELECT count(DISTINCT set_id)::int AS n FROM practice_attempt
          WHERE owner_id = $1 AND family = $2 AND state = 'checked'`, [owner, family])).rows[0].n;
      const served = await servedNow();
      assert.ok(checked >= 3, `expected three checked sets, found ${checked}`);
      assert.equal(served.round.wrapped, true, 'the part must report itself finished');
      assert.equal(served.round.notice, 'practiceAllSets');
      assert.equal(served.round.round, served.round.setCount);
    });

    await pgLeg('P5 SQL: the sitting is its own table and its evidence names no mock run', async () => {
      const row = (await db.admin.query(
        `SELECT (SELECT count(*)::int FROM practice_attempt WHERE owner_id = $1) AS sittings,
                (SELECT count(*)::int FROM item_evidence WHERE owner_id = $1 AND mock_run_id IS NULL) AS practice_evidence,
                (SELECT count(*)::int FROM item_evidence WHERE owner_id = $1 AND mock_run_id IS NOT NULL) AS mock_evidence`,
        [owner])).rows[0];
      assert.ok(row.sittings >= 4, `every served set opened a sitting (got ${row.sittings})`);
      assert.ok(row.practice_evidence > 0, 'practice evidence exists');
      assert.equal(row.mock_evidence, 0, 'no practice answer may be attributed to a mock run');
    });

    await pgLeg('P6 SQL: a checked sitting cannot be reopened (the trigger refuses)', async () => {
      /* A CHECKED sitting specifically: the oldest attempt of the family is still open, and reopening an open
         sitting is not what the trigger forbids — the reopen it must refuse is checked -> open. */
      const attempt = (await db.admin.query(
        `SELECT attempt_id FROM practice_attempt
          WHERE owner_id = $1 AND state = 'checked' ORDER BY created_at LIMIT 1`, [owner])).rows[0];
      assert.ok(attempt, 'the fixture must have a checked sitting to try to reopen');
      await assert.rejects(
        db.admin.query(`UPDATE practice_attempt SET state = 'open', checked_at = NULL WHERE attempt_id = $1`, [attempt.attempt_id]),
        /practice_attempt_reopen_refused/);
    });

    await pgLeg('P7 SQL: checkPracticeAttempt refuses an unknown sitting rather than inventing one', async () => {
      await assert.rejects(
        port.checkPracticeAttempt(owner, { preparationId, attemptId: randomUUID(), answers: [{ item_id: 'crafted-0', answer: 'a' }] }),
        (error) => error.code === 404 || error.status === 404);
    });

    /*
     * ----------------------------------------------------------------------------------------------------
     * THE CORPUS, ONE LEG PER PART FAMILY. This is the whole point of the lease: the two methods had never
     * been executed against a database, and when they finally were, `normalisePracticeSet` was wrong for
     * seven of the eight families. Each leg is identity, not shape: the served `item_id` must BE a key in
     * `objective_key.answers` for the same set/version, and every item must offer an answer the key can match.
     * ----------------------------------------------------------------------------------------------------
     */
    const FAMILIES = ['LV1', 'LV2', 'LV3', 'SB1', 'SB2', 'HV1', 'HV2', 'HV3'];
    for (const name of FAMILIES) {
      await pgLeg(`P8 ${name}: the served item ids ARE the answer keys, and every item offers an answer`, async () => {
        const served = await servedNow(name);
        assert.ok(served, `${name} served nothing`);
        assert.equal(served.family, name);
        const keys = await keysFor(served.set.set_id);
        assert.deepEqual(served.set.items.map((item) => item.item_id).sort(), Object.keys(keys).sort(),
          'every served item_id must be a key in objective_key.answers');
        assert.equal(served.set.items.length, served.set.item_count, 'the served count is the authored count');
        for (const item of served.set.items) {
          assert.ok(item.options.length >= 2, `${name} item ${item.item_id} offers fewer than two answers`);
          assert.equal(new Set(item.options.map((option) => option.id)).size, item.options.length, 'no duplicate option id');
          assert.ok(item.options.some((option) => option.value === keys[item.item_id]),
            `${name} item ${item.item_id} must offer the answer the KEY holds, typed the way the key holds it`);
          if (name.startsWith('HV')) {
            assert.equal(item.answer_kind, 'judgement');
            assert.deepEqual(item.options.map((option) => option.value), [true, false], 'HV answers are JSON booleans');
            assert.ok(item.prompt.length > 0, 'an HV item is its statement');
          } else {
            assert.equal(item.answer_kind, 'choice');
            assert.ok(item.options.every((option) => typeof option.value === 'string'));
            if (name !== 'SB1' && name !== 'SB2') assert.ok(item.prompt.length > 0, 'the item carries its text');
          }
        }
        if (name === 'SB1' || name === 'SB2') assert.ok(served.set.material.letter, 'the gap-fill letter is served');
        if (name === 'LV2') assert.ok(served.set.material.text, 'the single-choice passage is served');
      });
    }

    await pgLeg('P9 HV: a BOOLEAN answer marks every item correctly and closes the sitting once', async () => {
      const served = await servedNow('HV1');
      const keys = await keysFor(served.set.set_id);
      const answers = served.set.items.map((item) => ({ item_id: item.item_id, answer: keys[item.item_id] }));
      const checked = await port.checkPracticeAttempt(owner, { preparationId, attemptId: served.attempt.attempt_id, answers });
      assert.equal(checked.answered_count, answers.length);
      assert.equal(checked.correct_count, answers.length, 'every boolean answer must mark correct');
      assert.ok(checked.items.every((item) => item.correct === true));
      assert.ok(checked.items.every((item) => typeof item.expected === 'boolean'), 'the revealed key is a boolean');
      assert.equal(checked.state, 'checked');
      await assert.rejects(
        port.checkPracticeAttempt(owner, { preparationId, attemptId: served.attempt.attempt_id, answers }),
        (error) => error.code === 'attempt_already_checked' || error.status === 409,
        'a second check of the same sitting is refused');
    });

    await pgLeg('P10 HV: the STRING "true" is WRONG — mark_objective_item compares JSONB, not text', async () => {
      const served = await servedNow('HV1');
      const answers = served.set.items.map((item) => ({ item_id: item.item_id, answer: 'true' }));
      const checked = await port.checkPracticeAttempt(owner, { preparationId, attemptId: served.attempt.attempt_id, answers });
      assert.equal(checked.correct_count, 0, 'the string "true" is not the boolean true');
      assert.ok(checked.items.every((item) => item.correct === false));
    });

    await pgLeg('P11 a choice family marks every answer and records each evidence row exactly ONCE', async () => {
      const served = await servedNow('SB2');
      const keys = await keysFor(served.set.set_id);
      const answers = served.set.items.map((item) => ({ item_id: item.item_id, answer: keys[item.item_id] }));
      const checked = await port.checkPracticeAttempt(owner, { preparationId, attemptId: served.attempt.attempt_id, answers });
      assert.equal(checked.correct_count, answers.length);
      const rows = (await db.admin.query(
        `SELECT item_id, count(*)::int AS n FROM item_evidence
          WHERE owner_id = $1 AND set_id = $2 GROUP BY item_id ORDER BY item_id`, [owner, served.set.set_id])).rows;
      assert.equal(rows.length, answers.length, 'one evidence row per answered item');
      assert.ok(rows.every((row) => row.n === 1), 'no item may be recorded twice');
      assert.equal((await db.admin.query(
        'SELECT count(*)::int AS n FROM item_evidence WHERE owner_id = $1 AND set_id = $2 AND mock_run_id IS NOT NULL',
        [owner, served.set.set_id])).rows[0].n, 0, 'no practice answer is attributed to a mock run');
    });

    await pgLeg('P12 the key is WITHHELD until the learner has evidence of their own', async () => {
      const served = await servedNow('SB1');
      const { set_id: setId, version } = served.set;
      const itemId = served.set.items[0].item_id;
      const reveal = async () => asOwner(async (client) => (await client.query(
        'SELECT reveal_objective_answer($1, $2, $3) AS expected', [setId, version, itemId])).rows[0].expected);
      assert.equal(await reveal(), null, 'no key without the learner\'s own evidence');
      const keys = await keysFor(setId);
      await port.checkPracticeAttempt(owner, {
        preparationId, attemptId: served.attempt.attempt_id,
        answers: served.set.items.map((item) => ({ item_id: item.item_id, answer: keys[item.item_id] })),
      });
      assert.deepEqual(await reveal(), keys[itemId], 'the key is revealed once the learner\'s own evidence exists');
    });

    await pgLeg('P13 HTTP end to end: GET /api/v1/practice/next?family= then POST /api/v1/practice/check', async () => {
      const call = (method, path, payload) => world.api.handle({
        method, path, originChecked: true,
        headers: { cookie, accept: 'application/json', ...(payload === undefined ? {} : { 'content-type': 'application/json' }) },
        ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
      });
      const next = await call('GET', `/api/v1/practice/next?preparationId=${preparationId}&family=LV1`);
      assert.equal(next.status, 200, next.body);
      const body = JSON.parse(next.body);
      assert.equal(body.family, 'LV1');
      assert.equal(body.reason, 'unseen');
      assert.ok(body.attempt && body.attempt.attempt_id, 'the route returns the sitting it opened');
      assert.ok(body.set.items.length > 0, 'the route serves the authored items');
      const keys = await keysFor(body.set.set_id);
      const check = await call('POST', '/api/v1/practice/check', {
        preparationId, attemptId: body.attempt.attempt_id,
        answers: body.set.items.map((item) => ({ item_id: item.item_id, answer: keys[item.item_id] })),
      });
      assert.equal(check.status, 200, check.body);
      const review = JSON.parse(check.body);
      assert.equal(review.state, 'checked');
      assert.equal(review.correct_count, body.set.items.length, 'the review marks the whole set through the route');
      assert.equal(review.attempt_id, body.attempt.attempt_id);
    });

    const callRoute = (method, route, payload) => world.api.handle({
      method, path: route, originChecked: true,
      headers: { cookie, accept: 'application/json', ...(payload === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
    });

    /*
     * REVIEW-PRACTICE-01-SERVER D1. P13 drove LV1 — a family whose explanations exist — which is exactly why
     * the suite missed that the route answered 404 for EVERY listening set AFTER committing the check. This
     * leg drives the family that was broken, over HTTP, and asserts the review the learner is owed.
     */
    await pgLeg('P14 HTTP: the LISTENING check answers 200 with its review instead of 404 after committing', async () => {
      const serving = await servedNow('HV2');
      assert.ok(serving, 'HV2 must serve a set');
      const keys = await keysFor(serving.set.set_id);
      const answers = serving.set.items.map((item) => ({ item_id: item.item_id, answer: keys[item.item_id] }));
      const response = await callRoute('POST', '/api/v1/practice/check', { preparationId, attemptId: serving.attempt.attempt_id, answers });
      assert.equal(response.status, 200, `a listening check must return its review, got ${response.status} ${response.body}`);
      const review = JSON.parse(response.body);
      assert.equal(review.state, 'checked');
      assert.equal(review.media_required, true, 'the review discloses that the set is media-bound');
      assert.equal(review.items.length, serving.set.items.length);
      assert.ok(review.items.every((item) => item.correct === true), 'every answer is marked');
      assert.ok(review.items.every((item) => typeof item.expected === 'boolean'), 'the key is revealed as a boolean');
      assert.ok(review.items.every((item) => item.answer_kind === 'judgement'), 'so the item says which reader can serve it');
      assert.ok(review.items.every((item) => item.explanation === null),
        'a choice-family reader cannot serve a judgement/media item: null, never an error');
      const sitting = (await db.admin.query('SELECT state FROM practice_attempt WHERE attempt_id=$1', [serving.attempt.attempt_id])).rows[0];
      assert.equal(sitting.state, 'checked');
      const retry = await callRoute('POST', '/api/v1/practice/check', { preparationId, attemptId: serving.attempt.attempt_id, answers });
      assert.equal(retry.status, 409, 'a retry is refused — which is why losing the review was unrecoverable');
      assert.equal(JSON.parse(retry.body).error, 'attempt_already_checked');
      /* ...and the CHOICE families keep their explanations: the fix skips, it does not disable. */
      const choice = await servedNow('LV1');
      const choiceKeys = await keysFor(choice.set.set_id);
      const choiceResponse = await callRoute('POST', '/api/v1/practice/check', {
        preparationId, attemptId: choice.attempt.attempt_id,
        answers: choice.set.items.map((item) => ({ item_id: item.item_id, answer: choiceKeys[item.item_id] })),
      });
      assert.equal(choiceResponse.status, 200, choiceResponse.body);
      const choiceReview = JSON.parse(choiceResponse.body);
      assert.equal(choiceReview.media_required, false);
      assert.equal(choiceReview.items.length, choice.set.items.length);
      assert.ok(choiceReview.items.every((item) => item.answer_kind === 'choice'));
      assert.ok(choiceReview.items.every((item) => item.explanation !== null),
        'a choice-family item still receives its explanation');
      return `HV2 ${review.items.length} items → 200 with explanation:null; LV1 keeps ${choiceReview.items.length} explanations`;
    });

    /*
     * The mutation that makes P14 bite: put the DEFECT back in a COPY of the route (inside a throwaway copy of
     * the whole `server/` tree, so the copied route and the copied adapter share one `Fault` class and the
     * reproduction is exact) and drive the same call. Without the guard the route answers 404 while the sitting
     * is already `checked` — the review computed and thrown away. Nothing in the repository is modified.
     */
    await pgLeg('P15 MUTATION: the same listening check answers 404 with the sitting committed, without the guard', async () => {
      const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'practice-route-mutation-'));
      try {
        fs.cpSync(path.join(ROOT, 'server'), path.join(sandbox, 'server'), { recursive: true, dereference: true });
        const target = path.join(sandbox, 'server', 'owned-api.mjs');
        // The working copy has CRLF (core.autocrlf); normalise the throwaway COPY so a multi-line mutation matches.
        const source = fs.readFileSync(target, 'utf8').replaceAll('\r\n', '\n');
        let mutated = source;
        for (const [from, to] of [
          ['&& checked.media_required !== true', '&& true'],
          ["if (!explainable || answerKind !== 'choice')", 'if (!explainable)'],
          ['        } catch {\n          // A withheld, missing or unsupported explanation is null. It is never a failed review.\n          item.explanation = null;\n        }',
            '        } catch (error) { throw error; }'],
        ]) {
          const next = mutated.replace(from, to);
          assert.notEqual(next, mutated, `the D1 mutation must apply: ${from}`);
          mutated = next;
        }
        fs.writeFileSync(target, mutated);
        const legacy = await import(pathToFileURL(target).href);
        const legacyAdapter = await import(pathToFileURL(path.join(sandbox, 'server', 'owned-postgres', 'adapter.mjs')).href);
        const legacyPort = legacyAdapter.createPostgresDatastore({ pool: db.learner });
        const legacyApi = legacy.createOwnedApi({ datastore: legacyPort, sessions: world.sessions, settings: world.settings, accountDeletion: world.deletion });
        const serving = await legacyPort.practiceSetForPart(owner, { preparationId, family: 'HV3' });
        const keys = await keysFor(serving.set.set_id);
        const response = await legacyApi.handle({
          method: 'POST', path: '/api/v1/practice/check', originChecked: true,
          headers: { cookie, accept: 'application/json', 'content-type': 'application/json' },
          body: JSON.stringify({ preparationId, attemptId: serving.attempt.attempt_id,
            answers: serving.set.items.map((item) => ({ item_id: item.item_id, answer: keys[item.item_id] })) }),
        });
        assert.equal(response.status, 404, `the defect must reproduce exactly: expected 404, got ${response.status} ${response.body}`);
        const row = (await db.admin.query('SELECT state, correct_count FROM practice_attempt WHERE attempt_id=$1', [serving.attempt.attempt_id])).rows[0];
        assert.equal(row.state, 'checked', 'and it committed the check anyway: the review existed and was thrown away');
        assert.equal(Number(row.correct_count), serving.set.items.length, 'the answers are marked even though the learner saw 404');
        return 'the old route answers 404 with the sitting checked and every answer marked; the guard is what prevents it';
      } finally { fs.rmSync(sandbox, { recursive: true, force: true }); }
    });

    /*
     * REVIEW-PRACTICE-01-SERVER D2. SB1 has FOUR released sets: the three `0010` sets and the recovered grammar
     * drill from `0022`. It is released practice content, so it is DISCLOSED rather than filtered out — and the
     * wrap therefore fires on the FIFTH tap of SB1, not the fourth.
     */
    await pgLeg('P16 SB1: four released sets, the fourth is the recovered drill, and its disclosure is served', async () => {
      const sets = (await db.admin.query(
        `SELECT s.set_id, s.item_count, s.payload->>'practice_kind' AS practice_kind, c.source_path
           FROM objective_set s JOIN reviewed_content_version c ON c.content_version_id = s.content_version_id
          WHERE s.exam_id = $1 AND s.family = 'SB1' ORDER BY s.set_id`, [EXAM])).rows;
      assert.equal(sets.length, 4, `SB1 has four released sets, found ${sets.length}`);
      const drill = sets.find((row) => row.set_id.endsWith('grammar-wortstellung-v1'));
      assert.ok(drill, 'the fourth set is the recovered grammar drill');
      assert.equal(drill.practice_kind, 'grammar-drill');
      assert.match(drill.source_path, /^content\/drills\//, 'and it does NOT come from migration 0010');
      const served = [];
      /*
       * Earlier legs legitimately check an SB1 sitting (P12 proves the key is withheld on this family), so this
       * leg drives taps until the part serves the drill rather than assuming it is the fourth TAP — what it
       * asserts is the CORPUS (four sets, the fourth being the drill) and the WRAP (the tap after all four).
       */
      let fourth = null;
      for (let tap = 0; tap < 4 && !fourth; tap += 1) {
        const serving = await servedNow('SB1');
        assert.ok(serving, `SB1 tap ${tap + 1} served nothing`);
        served.push(serving.set.set_id);
        assert.equal(serving.round.setCount, 4, 'SB1 must report the four sets it serves');
        if (serving.set.set_id === drill.set_id) { fourth = serving; break; }
        const keys = await keysFor(serving.set.set_id);
        await port.checkPracticeAttempt(owner, {
          preparationId, attemptId: serving.attempt.attempt_id,
          answers: serving.set.items.map((item) => ({ item_id: item.item_id, answer: keys[item.item_id] })),
        });
      }
      assert.ok(fourth, `the drill must be served within four taps; saw [${served.join(', ')}]`);
      assert.equal(fourth.set.item_count, 12, 'and it is 12 gap items');
      assert.equal(fourth.set.material.practice_kind, 'grammar-drill', 'the DTO must disclose what kind of practice it is');
      assert.match(fourth.set.material.instruction, /kein telc-Prüfungssatz/, 'and its own instruction must reach the learner');
      assert.deepEqual([fourth.round.checkedSets, fourth.round.wrapped], [3, false],
        'three of four checked is not yet a wrap');
      const keys = await keysFor(fourth.set.set_id);
      await port.checkPracticeAttempt(owner, {
        preparationId, attemptId: fourth.attempt.attempt_id,
        answers: fourth.set.items.map((item) => ({ item_id: item.item_id, answer: keys[item.item_id] })),
      });
      const fifth = await servedNow('SB1');
      assert.equal(fifth.round.wrapped, true, 'the FIFTH tap of SB1 wraps, not the fourth');
      assert.equal(fifth.round.notice, 'practiceAllSets');
      assert.equal(fifth.round.round, 4, 'and no round beyond the part is reported');
      return `${served.join(', ')} → the drill (12 items, disclosed); the tap after all four wraps at round 4/4`;
    });

    /*
     * REVIEW-PRACTICE-01-SERVER D5: the note claimed an imported listening set "would 500". It is proven here
     * instead of asserted: a `content/exams/%` set with no package membership is EXCLUDED by `importedSetGate`
     * and the route says `nothing_available`, while the normaliser's own refusal of that payload shape stands
     * separately (which is what the reviewer measured).
     */
    await pgLeg('P17 D5 PROVEN: an unimported content/exams set is invisible (nothing_available), not a 500', async () => {
      const contentVersion = 'synthetic.exams.unimported@v1';
      await db.admin.query(
        `INSERT INTO content_version (content_version_id, kind, family, source_path, review_status, rights_status, content_sha256, exam_id)
         VALUES ($1, 'task', 'hv', 'content/exams/telc-deutsch-b1/synthetic/unimported.json', 'unreviewed', 'generated', $2, $3)
         ON CONFLICT DO NOTHING`, [contentVersion, 'a'.repeat(64), EXAM]);
      await db.admin.query(
        `INSERT INTO objective_set (set_id, version, exam_id, family, section, part, title, payload, item_count, media_required, content_version_id)
         VALUES ('synthetic.unimported.hv', 'v1', $1, 'HV4', 'HV', 4, 'Unimported', $2::jsonb, 1, false, $3)
         ON CONFLICT DO NOTHING`,
        [EXAM, JSON.stringify({ recordings: [{ id: 'r', mediaId: 'synthetic.m', mediaVersion: 'v1', label: 'x',
          questions: [{ n: 1, question: 'q', options: { a: 'A', b: 'B' } }] }] }), contentVersion]);
      assert.equal(await servedNow('HV4'), null, 'a content/exams set with no package membership is excluded');
      const response = await callRoute('GET', `/api/v1/practice/next?preparationId=${preparationId}&family=HV4`);
      assert.equal(response.status, 200, response.body);
      assert.equal(JSON.parse(response.body).reason, 'nothing_available', 'the route says so honestly rather than erroring');
      const { normalisePracticeSet } = await import('../server/practice-sets.mjs');
      assert.throws(() => normalisePracticeSet({ set_id: 'synthetic.unimported.hv', version: 'v1', item_count: 1, payload: { recordings: [] } }),
        /practice_set_items_unknown/, 'the normaliser does refuse a payload with no items — separately from the route');
      return 'excluded by importedSetGate → nothing_available; the recordings-only shape is refused by the normaliser';
    });
    return outcome;
  } finally {
    /* The fixture's teardown must not be able to mask the legs' real results, and a failure before or during
       `createFixture` must still restore the caller's content policy. */
    if (db && typeof db.cleanup === 'function') { try { await db.cleanup(); } catch (error) { console.log(`postgres: cleanup reported ${String(error.message).split('\n')[0]}`); } }
    restorePolicy();
  }
};

const main = async () => {
  const mod = await load(ROOT);
  if (process.argv.includes('--list')) {
    for (const [name] of legs(mod)) console.log(name);
    return 0;
  }
  for (const [name, run] of legs(mod)) leg(name, run);

  if (process.argv.includes('--postgres')) {
    let outcome;
    try {
      outcome = await postgresLegs();
    } catch (error) {
      /* A one-line message with no stack sent the previous lease hunting blind: a fixture failure must
         name the statement. Print the label chain AND the stack, then keep the single line for the tally. */
      const label = error && error.practiceStep ? ` [${error.practiceStep}]` : '';
      console.log(`postgres: legs could not run${label}: ${String(error && error.message).split('\n')[0]}`);
      console.log(String((error && error.stack) || error).split('\n').slice(0, 14).join('\n'));
      outcome = [['FAIL', `postgres legs could not run${label}: ${String(error.message).split('\n')[0]}`]];
    }
    for (const [result, name] of outcome) {
      console.log(`${result} ${name}`);
      legNames.push(name);
      if (result === 'FAIL') failures.push(name);
    }
  }

  /* Mutation proof: each mutation must fail at least one leg, and the pristine copy must keep passing. */
  const control = fs.mkdtempSync(path.join(os.tmpdir(), 'practice-selection-'));
  fs.mkdirSync(path.join(control, 'server'), { recursive: true });
  fs.copyFileSync(path.join(ROOT, MODULE), path.join(control, MODULE));
  const controlFailures = [];
  for (const [name, run] of legs(await load(control))) {
    try { run(); } catch (error) { controlFailures.push(name); }
  }
  assert.deepEqual(controlFailures, [], 'the pristine copy must pass every leg');
  fs.rmSync(control, { recursive: true, force: true });

  const mutationNote = [];
  for (const [label, mutate] of MUTATIONS) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'practice-selection-mut-'));
    fs.mkdirSync(path.join(directory, 'server'), { recursive: true });
    const source = fs.readFileSync(path.join(ROOT, MODULE), 'utf8');
    const mutated = mutate(source);
    assert.notEqual(mutated, source, `${label}: the mutation must change the module`);
    fs.writeFileSync(path.join(directory, MODULE), mutated);
    const broken = [];
    for (const [name, run] of legs(await load(directory))) {
      try { run(); } catch { broken.push(name); }
    }
    fs.rmSync(directory, { recursive: true, force: true });
    assert.ok(broken.length > 0, `${label}: no leg failed on the mutated module`);
    mutationNote.push(`${label} -> ${broken.length} leg(s) fail: ${broken[0]}`);
  }

  const total = legNames.length;
  console.log(failures.length ? `FAIL ${failures.length}` : '');
  for (const failure of failures) console.log(`FAIL ${failure}`);
  console.log(`${total} legs, ${failures.length} failed (${MODULE})`);
  for (const note of mutationNote) console.log(`MUTATION ${note}`);
  return failures.length ? 1 : 0;
};

process.exitCode = await main();

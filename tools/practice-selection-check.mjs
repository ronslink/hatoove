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
import { fileURLToPath } from 'node:url';

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

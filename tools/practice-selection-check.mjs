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
  ['11 a served set never carries the key, the transcript or the explanation', () => {
    const served = mod.normalisePracticeSet({
      set_id: 'lv2-set-a', version: 'v1', family: 'LV2', section: 'LV', part: '2', item_count: 2,
      payload: { items: [
        { item_id: 'i1', prompt: 'Was ist richtig?', options: [{ id: 'a', text: 'A' }, { id: 'b', text: 'B' }], answer: 'b', transcript: 'geheim', explanation: 'weil' },
        { item_id: 'i2', prompt: 'Und hier?', options: [{ id: 'a', text: 'A' }] },
      ] },
    }, { exam: 2, practice: 1 });
    assert.equal(served.items.length, 2);
    assert.equal(served.item_count, 2);
    for (const item of served.items) {
      const json = JSON.stringify(item);
      assert.ok(!/answer|transcript|explanation|correct/i.test(json), `${item.item_id} must not carry answer material`);
    }
    assert.deepEqual(served.playback, { exam: 2, practice: 1 });
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
  ['M5 the served set leaks the key', (source) => source.replace('prompt: typeof item.prompt === \'string\' ? item.prompt : \'\',', "prompt: typeof item.prompt === 'string' ? item.prompt : '', answer: item.answer,")],
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

  const db = await createFixture();
  try {
    const world = await createPostgresWorld({ fixture: db });
    const port = world.store.port;
    const step = async (label, run) => {
      try { return await run(); } catch (error) { throw new Error(`setup step "${label}" failed: ${error.code || ''} ${String(error.message).split('\n')[0]}`); }
    };
    const signup = await step('signUp', () => world.sessions.signUp({
      name: 'Practice selection', email: `practice-selection-${Date.now()}@example.invalid`,
      password: 'synthetic-practice-selection-password',
    }));
    const owner = (await world.sessions.getSession({ cookie: String(signup.setCookie).split(';')[0] })).userId;
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
    const craft = async (row, wrong, correct, answeredAt) => {
      for (let index = 0; index < wrong + correct; index += 1) {
        await db.admin.query(
          `INSERT INTO item_evidence
             (evidence_id, owner_id, exam_id, set_id, version, item_id, family, section, answer, correct,
              latency_ms, preparation_id, answered_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, NULL, $11, $12)`,
          [randomUUID(), owner, EXAM, row.set_id, row.version, `crafted-${index}`, family, 'HV',
            JSON.stringify('a'), index >= wrong, preparationId, answeredAt]);
      }
    };
    const servedNow = () => port.practiceSetForPart(owner, { preparationId, family });

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

    await db.admin.query(
      `UPDATE practice_attempt SET state = 'checked', checked_at = now(), answered_count = 1, correct_count = 0
        WHERE owner_id = $1 AND preparation_id = $2 AND family = $3`, [owner, preparationId, family]);
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
      const attempt = (await db.admin.query(
        'SELECT attempt_id FROM practice_attempt WHERE owner_id = $1 ORDER BY created_at LIMIT 1', [owner])).rows[0];
      await assert.rejects(
        db.admin.query(`UPDATE practice_attempt SET state = 'open', checked_at = NULL WHERE attempt_id = $1`, [attempt.attempt_id]),
        /practice_attempt_reopen_refused/);
    });

    await pgLeg('P7 SQL: checkPracticeAttempt refuses an unknown sitting rather than inventing one', async () => {
      await assert.rejects(
        port.checkPracticeAttempt(owner, { preparationId, attemptId: randomUUID(), answers: [{ item_id: 'crafted-0', answer: 'a' }] }),
        (error) => error.code === 404 || error.status === 404);
    });
    return outcome;
  } finally {
    /* The fixture's teardown must not be able to mask the legs' real results. */
    if (typeof db.cleanup === 'function') { try { await db.cleanup(); } catch (error) { console.log(`postgres: cleanup reported ${String(error.message).split('\n')[0]}`); } }
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
      outcome = [['FAIL', `postgres legs could not run: ${String(error.message).split('\n')[0]}`]];
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

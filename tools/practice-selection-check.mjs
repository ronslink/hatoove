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

const main = async () => {
  const mod = await load(ROOT);
  if (process.argv.includes('--list')) {
    for (const [name] of legs(mod)) console.log(name);
    return 0;
  }
  for (const [name, run] of legs(mod)) leg(name, run);

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

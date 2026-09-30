/**
 * Tests for tools/objective-fixture-check.mjs (USER-04 Task 3).
 *
 * Corrupt cases mutate a deep copy of the real fixtures. The suite asserts that the
 * validator catches structural defects in objective marking while the shipped fixture
 * stays sound, and that the score arithmetic it recomputes matches the declared
 * expectations (including exact half-point aggregates).
 *
 * Run: node --test tools/objective-fixture-check.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { validateObjectiveCases, DEFAULT_FIXTURE_PATH, REQUIRED_FAMILIES } from './objective-fixture-check.mjs';

const raw = JSON.parse(fs.readFileSync(DEFAULT_FIXTURE_PATH, 'utf8'));
const clone = () => JSON.parse(JSON.stringify(raw));
const famById = (fx, id) => fx.families.find((f) => f.id === id);
const caseById = (fx, id) => fx.cases.find((c) => c.id === id);

function expectFailure(result, pattern, label) {
  assert.equal(result.ok, false, `${label}: expected validation to fail`);
  assert.ok(
    result.errors.some((e) => pattern.test(e)),
    `${label}: expected an error matching ${pattern}; got:\n  ${result.errors.join('\n  ')}`
  );
}

/* ------------------------------------------------------------- baseline */

test('the shipped objective fixtures are structurally sound', () => {
  const r = validateObjectiveCases(clone());
  assert.deepEqual(r.errors, [], `unexpected errors:\n  ${r.errors.join('\n  ')}`);
  assert.equal(r.ok, true);
  assert.equal(r.summary.families, 8);
  assert.equal(r.summary.objectiveItems, 60, 'the eight families must cover items 1-60');
  assert.equal(r.summary.objectivePoints, 180, 'LV 75 + SB 30 + HV 75 = 180 objective points');
});

test('the fixtures claim to be synthetic, unreviewed and free of real exam text', () => {
  assert.equal(raw.synthetic, true);
  assert.equal(raw.reviewed, false);
  assert.equal(raw.containsRealExamText, false);
});

test('all eight required families are defined with weight and key type', () => {
  for (const id of REQUIRED_FAMILIES) {
    const f = famById(raw, id);
    assert.ok(f, `${id} must be defined`);
    assert.ok(f.pointsMax > 0, `${id} needs pointsMax`);
    assert.ok(f.keyType, `${id} needs a keyType`);
    assert.ok(Array.isArray(f.items) && f.items.length > 0, `${id} needs key items`);
  }
  assert.equal(famById(raw, 'LV1').pointsMax + famById(raw, 'LV2').pointsMax + famById(raw, 'LV3').pointsMax, 75);
  assert.equal(famById(raw, 'SB1').pointsMax + famById(raw, 'SB2').pointsMax, 30);
  assert.equal(famById(raw, 'HV1').pointsMax + famById(raw, 'HV2').pointsMax + famById(raw, 'HV3').pointsMax, 75);
});

test('listening play counts stay non-uniform at 1 / 2 / 2', () => {
  assert.equal(famById(raw, 'HV1').permittedPlays, 1);
  assert.equal(famById(raw, 'HV2').permittedPlays, 2);
  assert.equal(famById(raw, 'HV3').permittedPlays, 2);
});

/* --------------------------------------------------- weight arithmetic */

test('recomputes exact item weights, including fractional ones', () => {
  // SB1: 15 points over 10 items = 1.5 per item, so 7 correct = 10.5
  const sb1 = caseById(raw, 'OMC-SB1-03');
  assert.equal(sb1.expectedCorrectCount, 7);
  assert.equal(sb1.expectedPoints, 10.5);
  // HV2: 25 points over 10 items = 2.5 per item, so 7 correct = 17.5
  const hv2 = caseById(raw, 'OMC-HV2-02');
  assert.equal(hv2.expectedCorrectCount, 7);
  assert.equal(hv2.expectedPoints, 17.5);
  // LV3: 25 points over 10 items = 2.5 per item, so 9 correct = 22.5
  const lv3 = caseById(raw, 'OMC-LV3-02');
  assert.equal(lv3.expectedCorrectCount, 9);
  assert.equal(lv3.expectedPoints, 22.5);

  const r = validateObjectiveCases(clone());
  assert.equal(r.ok, true, 'the validator must agree with these declared aggregates');
});

test('rejects a declared correct count that contradicts the key', () => {
  const fx = clone();
  caseById(fx, 'OMC-LV1-01').expectedCorrectCount = 4;
  expectFailure(validateObjectiveCases(fx), /case\.correct-count/, 'wrong correct count');
});

test('rejects declared points that contradict item weight', () => {
  const fx = clone();
  caseById(fx, 'OMC-SB1-03').expectedPoints = 10;
  expectFailure(validateObjectiveCases(fx), /case\.points/, 'wrong point aggregate');
});

test('rejects an aggregate case whose family weights do not total 180', () => {
  const fx = clone();
  famById(fx, 'HV3').pointsMax = 20;
  expectFailure(validateObjectiveCases(fx), /case\.aggregate-total/, 'objective total mismatch');
});

/* --------------------------------------------------- keys and numbering */

test('rejects a key outside its option pool', () => {
  const fx = clone();
  famById(fx, 'LV1').items[0].key = 'z';
  expectFailure(validateObjectiveCases(fx), /item\.key-outside-pool/, 'key outside pool');
});

test('allows the no-match marker only where the family supports it', () => {
  const lv3 = famById(raw, 'LV3');
  assert.equal(lv3.noMatchSupported, true);
  assert.equal(lv3.noMatchMarker, 'x');
  assert.ok(lv3.items.some((i) => i.key === 'x'), 'LV3 key must use the marker');
  assert.equal(famById(raw, 'LV1').noMatchSupported, false);

  // A marker inside a pool key is fine; an unknown key is not.
  const fx = clone();
  famById(fx, 'LV1').items[0].key = 'x';
  expectFailure(validateObjectiveCases(fx), /item\.key-outside-pool/, 'marker used in a family without no-match');
});

test('rejects duplicate item numbers and non-contiguous numbering', () => {
  const dupe = clone();
  famById(dupe, 'LV2').items[1].n = 6;
  expectFailure(validateObjectiveCases(dupe), /item\.duplicate-number|item\.not-contiguous/, 'duplicate item number');

  const gap = clone();
  famById(gap, 'LV1').items[1].n = 9;
  expectFailure(validateObjectiveCases(gap), /item\.not-contiguous|coverage\.item-gap/, 'numbering gap');
});

test('rejects a single-use family that repeats a key', () => {
  const fx = clone();
  famById(fx, 'LV1').items[1].key = famById(fx, 'LV1').items[0].key;
  expectFailure(validateObjectiveCases(fx), /family\.key-reuse/, 'repeated key under reuseLimit 1');
});

test('rejects a missing required family and a duplicate family', () => {
  const missing = clone();
  missing.families = missing.families.filter((f) => f.id !== 'SB2');
  expectFailure(validateObjectiveCases(missing), /coverage\.missing-family/, 'missing family');

  const dupe = clone();
  dupe.families.push(JSON.parse(JSON.stringify(dupe.families[0])));
  expectFailure(validateObjectiveCases(dupe), /family\.duplicate-id/, 'duplicate family');
});

/* ------------------------------------------------------- case integrity */

test('rejects duplicate case ids and malformed ids', () => {
  const dupe = clone();
  dupe.cases[1].id = dupe.cases[0].id;
  expectFailure(validateObjectiveCases(dupe), /case\.duplicate-id/, 'duplicate case id');

  const bad = clone();
  bad.cases[0].id = 'case-one';
  expectFailure(validateObjectiveCases(bad), /case\.id-format/, 'unstable case id');
});

test('rejects an unknown family, scenario, outcome or error classification on a case', () => {
  const fam = clone(); fam.cases[0].family = 'LV9';
  expectFailure(validateObjectiveCases(fam), /case\.family-unknown/, 'unknown family');

  const sc = clone(); sc.cases[0].scenario = 'mostly-fine';
  expectFailure(validateObjectiveCases(sc), /case\.scenario-unknown/, 'unknown scenario');

  const out = clone(); out.cases[0].expectedOutcome = 'passed';
  expectFailure(validateObjectiveCases(out), /case\.outcome/, 'unknown outcome');

  const er = clone(); er.cases[0].expectedError = 'oops';
  expectFailure(validateObjectiveCases(er), /case\.error/, 'unknown error classification');
});

test('rejects an answer that references an item outside its family', () => {
  const fx = clone();
  caseById(fx, 'OMC-LV1-01').answers['40'] = 'b';
  expectFailure(validateObjectiveCases(fx), /case\.answer-unknown-item/, 'answer for foreign item');
});

test('rejects an illegal answer token where the scenario does not permit one', () => {
  const fx = clone();
  caseById(fx, 'OMC-LV1-01').answers['1'] = 'z';
  expectFailure(validateObjectiveCases(fx), /case\.answer-illegal/, 'illegal token on a correct-scenario case');

  // ...but the dedicated invalid-choice case is allowed to carry one.
  assert.equal(caseById(raw, 'OMC-LV1-04').scenario, 'invalid-choice');
  assert.equal(caseById(raw, 'OMC-LV1-04').answers['2'], 'z');
});

test('allows the unsupported-no-match probe only in its own scenario', () => {
  const probe = caseById(raw, 'OMC-LV2-04');
  assert.equal(probe.scenario, 'unsupported-no-match');
  assert.equal(probe.answers['7'], 'x');
  assert.equal(famById(raw, 'LV2').noMatchSupported, false);
  assert.equal(probe.expectedError, 'no-match-not-supported');
});

test('rejects a case that is not labelled synthetic or lacks a rationale', () => {
  const syn = clone(); syn.cases[0].synthetic = false;
  expectFailure(validateObjectiveCases(syn), /case\.synthetic/, 'unlabelled case');

  const rat = clone(); delete rat.cases[0].rationale;
  expectFailure(validateObjectiveCases(rat), /case\.rationale/, 'missing rationale');
});

/* ------------------------------------------- unassessed / writing safety */

test('unassessed cases must carry no points and no correct count', () => {
  const pts = clone();
  caseById(pts, 'OMC-SA1-01').expectedPoints = 22;
  expectFailure(validateObjectiveCases(pts), /case\.unassessed-points/, 'unassessed case with points');

  const cc = clone();
  caseById(cc, 'OMC-SA1-02').expectedCorrectCount = 1;
  expectFailure(validateObjectiveCases(cc), /case\.unassessed-correct/, 'unassessed case with a count');
});

test('the writing family cannot be asserted as assessed', () => {
  const fx = clone();
  caseById(fx, 'OMC-SA1-01').unassessed = false;
  expectFailure(validateObjectiveCases(fx), /case\.non-objective-assessed/, 'writing asserted as assessed');
});

test('provider failure for writing stays unassessed rather than becoming a mark', () => {
  const c = caseById(raw, 'OMC-SA1-02');
  assert.equal(c.expectedOutcome, 'unassessed');
  assert.equal(c.expectedError, 'provider_unavailable');
  assert.equal(c.expectedPoints, null);
  assert.equal(c.unassessed, true);
});

test('no case defines an overall pass, fail or grade band', () => {
  for (const c of raw.cases) {
    assert.ok(
      !['passed', 'failed', 'bestanden', 'nicht bestanden', 'sehr gut', 'gut'].includes(String(c.expectedOutcome)),
      `${c.id} must not assert an overall result`
    );
    assert.equal(Object.prototype.hasOwnProperty.call(c, 'gradeBand'), false, `${c.id} must not carry a grade band`);
  }
});

test('aggregate cases carry no per-item answers', () => {
  for (const c of raw.cases.filter((x) => x.family === 'ALL')) {
    assert.equal(c.answers, null, `${c.id} must not carry answers`);
  }
  const fx = clone();
  caseById(fx, 'OMC-AGG-01').answers = { 1: 'b' };
  expectFailure(validateObjectiveCases(fx), /case\.aggregate-answers/, 'aggregate case with answers');
});

/* ------------------------------------------------------------- structure */

test('rejects a non-object fixture and missing blocks', () => {
  assert.equal(validateObjectiveCases(null).ok, false);
  assert.equal(validateObjectiveCases([]).ok, false);

  const f = clone(); delete f.families;
  expectFailure(validateObjectiveCases(f), /families\.missing/, 'no families');

  const c = clone(); delete c.cases;
  expectFailure(validateObjectiveCases(c), /cases\.missing/, 'no cases');

  const p = clone(); delete p.optionPools;
  expectFailure(validateObjectiveCases(p), /optionPools\.missing/, 'no option pools');
});

test('rejects real-exam-text or reviewed flags being set', () => {
  const a = clone(); a.containsRealExamText = true;
  expectFailure(validateObjectiveCases(a), /synthetic\.real-text/, 'real exam text flag');

  const b = clone(); b.reviewed = true;
  expectFailure(validateObjectiveCases(b), /reviewed\.flag/, 'reviewed flag');
});

test('rejects an unsupported play count above two', () => {
  const fx = clone();
  famById(fx, 'HV2').permittedPlays = 3;
  expectFailure(validateObjectiveCases(fx), /family\.plays-unsupported/, 'three plays');
});

/* ----------------------------------------------------------- CLI surface */

test('CLI exits zero on the real fixtures and nonzero on a missing file', async () => {
  const { runCli } = await import('./objective-fixture-check.mjs');
  const quiet = { log() {}, error() {} };
  assert.equal(runCli([DEFAULT_FIXTURE_PATH], quiet), 0, 'real fixtures should pass');
  assert.equal(runCli(['no-such-fixture.json'], quiet), 1, 'missing file should fail');
});

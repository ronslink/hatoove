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

/* ==================================================================== */
/* Second independent-review regressions                                */
/* ==================================================================== */

test('review O1: a marked case must declare both its correct count and its points', () => {
  // Before: deleting expectedCorrectCount left expectedPoints unchecked, so 999 was accepted.
  const noCount = clone();
  const c = caseById(noCount, 'OMC-LV1-01');
  delete c.expectedCorrectCount;
  c.expectedPoints = 999;
  expectFailure(validateObjectiveCases(noCount), /case\.expectation-missing/, 'missing correct count with points');

  const noPoints = clone();
  delete caseById(noPoints, 'OMC-LV1-01').expectedPoints;
  expectFailure(validateObjectiveCases(noPoints), /case\.expectation-missing/, 'missing points');

  // Explicit nulls remain valid only for non-marked cases.
  assert.equal(caseById(raw, 'OMC-SA1-01').expectedPoints, null);
  assert.equal(caseById(raw, 'OMC-AGG-01').expectedPoints, null);
});

test('review O2: numeric strings and non-finite point values are rejected', () => {
  const strPoints = clone();
  caseById(strPoints, 'OMC-LV1-01').expectedPoints = '25';
  expectFailure(validateObjectiveCases(strPoints), /case\.points-type/, 'numeric string points');

  const strCount = clone();
  caseById(strCount, 'OMC-LV1-01').expectedCorrectCount = '5';
  expectFailure(validateObjectiveCases(strCount), /case\.correct-count-type/, 'numeric string count');

  const infinite = clone();
  caseById(infinite, 'OMC-LV1-01').expectedPoints = Infinity;
  expectFailure(validateObjectiveCases(infinite), /case\.points-type/, 'infinite points');
});

test('review O3: only the no-match marker may repeat in a single-use family', () => {
  // LV3 legitimately repeats x, so the shipped fixture must pass.
  const lv3 = famById(raw, 'LV3');
  const xs = lv3.items.filter((i) => i.key === 'x').length;
  assert.ok(xs >= 2, 'LV3 should legitimately repeat the no-match marker');
  assert.equal(validateObjectiveCases(clone()).ok, true, 'repeated x must be allowed');

  // A repeated real option is a defect even in a family that supports no-match.
  const repeatedOption = clone();
  const items = famById(repeatedOption, 'LV3').items;
  const firstOption = items.find((i) => i.key !== 'x').key;
  const secondOption = items.filter((i) => i.key !== 'x')[1];
  secondOption.key = firstOption;
  expectFailure(validateObjectiveCases(repeatedOption), /family\.key-reuse/, 'repeated real option in LV3');

  // A repeated option in a family without no-match is likewise rejected.
  const lv1 = clone();
  famById(lv1, 'LV1').items[1].key = famById(lv1, 'LV1').items[0].key;
  expectFailure(validateObjectiveCases(lv1), /family\.key-reuse/, 'repeated option in LV1');
});

test('review O4: null and primitive entries never throw', () => {
  const shapes = [
    ['null item', (o) => { o.families[0].items[1] = null; }],
    ['string item', (o) => { o.families[0].items[1] = 'a'; }],
    ['null family', (o) => { o.families[1] = null; }],
    ['null case', (o) => { o.cases[2] = null; }],
    ['null answers', (o) => { caseById(o, 'OMC-LV1-01').answers = null; }],
    ['null pool entry', (o) => { o.optionPools.headlines = null; }],
  ];
  for (const [label, mutate] of shapes) {
    const o = clone();
    mutate(o);
    let r;
    assert.doesNotThrow(() => { r = validateObjectiveCases(o); }, `${label} must not throw`);
    assert.equal(r.ok, false, `${label} must be rejected`);
  }
});

test('review O5: no fixture may assert a prohibited learner-score claim', () => {
  // The pilot cannot compute an overall pass, grade or readiness because oral is unassessed.
  for (const c of raw.cases) {
    assert.ok(
      !['passed', 'failed', 'pass', 'fail', 'bestanden', 'sehr gut', 'gut', 'readiness', 'grade'].includes(String(c.expectedOutcome)),
      `${c.id} must not assert an overall result`
    );
    assert.equal(Object.prototype.hasOwnProperty.call(c, 'gradeBand'), false, `${c.id} must not carry a grade band`);
    if (c.expected === undefined) continue; // aggregate cases carry no per-case expectation block
    for (const field of ['grade', 'gradeBand', 'readiness', 'passed', 'overallResult', 'learnerScore', 'percentage']) {
      assert.equal(c.expected[field], undefined, `${c.id} must not carry expected.${field}`);
    }
  }

  const topLevel = clone();
  caseById(topLevel, 'OMC-AGG-01').expectedOutcome = 'passed';
  expectFailure(validateObjectiveCases(topLevel), /case\.outcome|case\.prohibited-learner-claim/, 'outcome claims a pass');

  const graded = clone();
  caseById(graded, 'OMC-AGG-02').expected = {
    outcome: 'aggregate', errorClassification: 'none', gradeBand: 'sehr gut', numericScorePermitted: false,
  };
  expectFailure(validateObjectiveCases(graded), /case\.prohibited-learner-claim/, 'aggregate claims a grade band');

  const readiness = clone();
  caseById(readiness, 'OMC-AGG-01').readiness = 'likely to pass';
  expectFailure(validateObjectiveCases(readiness), /case\.prohibited-learner-claim/, 'aggregate claims readiness');
});

test('PR26 F6 residual: an aggregate case must not carry a per-item learner score', () => {
  // The review's original F6 probe: OMC-AGG-01 with a fabricated count and total.
  const fabricated = clone();
  const agg = caseById(fabricated, 'OMC-AGG-01');
  agg.expectedCorrectCount = 42;
  agg.expectedPoints = 150;
  expectFailure(validateObjectiveCases(fabricated), /case\.aggregate-learner-score/, 'aggregate with counts');

  const pointsOnly = clone();
  caseById(pointsOnly, 'OMC-AGG-02').expectedPoints = 999;
  expectFailure(validateObjectiveCases(pointsOnly), /case\.aggregate-learner-score/, 'aggregate with points only');

  // The shipped aggregate cases keep both fields null.
  for (const c of raw.cases.filter((x) => x.family === 'ALL')) {
    assert.equal(c.expectedCorrectCount, null, `${c.id}.expectedCorrectCount must stay null`);
    assert.equal(c.expectedPoints, null, `${c.id}.expectedPoints must stay null`);
  }
});

test('review O6 (N1): numeric and boolean learner-result claims are rejected, not just strings', () => {
  // Before: the top-level guard scanned String(value) against a word list, so numeric or
  // boolean claims escaped while the nested expectation block flagged mere presence.
  const cases = [
    ['learnerScore number', (o) => { caseById(o, 'OMC-AGG-01').learnerScore = 42; }],
    ['passed boolean false', (o) => { caseById(o, 'OMC-AGG-01').passed = false; }],
    ['readiness number', (o) => { caseById(o, 'OMC-AGG-01').readiness = 0.9; }],
    ['percentage number on a marked case', (o) => { caseById(o, 'OMC-LV1-01').percentage = 55; }],
    ['overallPassed boolean', (o) => { caseById(o, 'OMC-LV1-01').overallPassed = true; }],
    ['certificate string', (o) => { caseById(o, 'OMC-AGG-02').certificate = 'B1'; }],
    ['finalGrade string', (o) => { caseById(o, 'OMC-AGG-02').finalGrade = 'gut'; }],
    ['expectedGrade string', (o) => { caseById(o, 'OMC-AGG-01').expectedGrade = 'sehr gut'; }],
  ];
  for (const [label, mutate] of cases) {
    const o = clone();
    mutate(o);
    let r;
    assert.doesNotThrow(() => { r = validateObjectiveCases(o); }, `${label} must not throw`);
    assert.equal(r.ok, false, `${label} must be rejected`);
    assert.ok(r.errors.some((e) => /case\.prohibited-learner-claim/.test(e)), `${label} must raise the claim error`);
  }

  // The legitimate outcome vocabulary must still be accepted.
  assert.equal(validateObjectiveCases(clone()).ok, true);
});

test('review O7 (NEW-1): bare `grade` is rejected at both guard levels', () => {
  // Regression for an independent review finding (Clawdbot, USER04-R3): the c8c86dc rewrite
  // replaced a nested literal that contained 'grade' with a shared claimFields list that did not,
  // so the bare name `grade` lost its guard. It is now in both lists.
  // Top level (how the shipped suite actually stores claim fields on a marked case):
  for (const [field, value] of [['grade', 'sehr gut'], ['band', 'B1'], ['readiness', 'likely'],
    ['learnerScore', 42], ['passed', false], ['percentage', 55]]) {
    const o = clone();
    caseById(o, 'OMC-LV1-01')[field] = value;
    expectFailure(validateObjectiveCases(o), /case\.prohibited-learner-claim/, `top-level ${field}`);
  }
  // Nested expectation block (the level that regressed at c8c86dc):
  for (const [field, value] of [['grade', 'sehr gut'], ['band', 'B1'], ['learnerScore', 42]]) {
    const o = clone();
    const agg = caseById(o, 'OMC-AGG-02');
    agg.expected = { outcome: 'aggregate', errorClassification: 'none', numericScorePermitted: false, [field]: value };
    expectFailure(validateObjectiveCases(o), /case\.prohibited-learner-claim/, `nested expected.${field}`);
  }
  // The legitimate fixture must still pass, and NEW-2 stays an accepted limitation.
  assert.equal(validateObjectiveCases(clone()).ok, true, 'shipped fixture must stay green');
});

test('CLI exits zero on the real fixtures and nonzero on a missing file', async () => {
  const { runCli } = await import('./objective-fixture-check.mjs');
  const quiet = { log() {}, error() {} };
  assert.equal(runCli([DEFAULT_FIXTURE_PATH], quiet), 0, 'real fixtures should pass');
  assert.equal(runCli(['no-such-fixture.json'], quiet), 1, 'missing file should fail');
});

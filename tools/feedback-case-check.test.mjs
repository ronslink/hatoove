/**
 * Tests for tools/feedback-case-check.mjs (USER-03 Task 3).
 *
 * Corrupt cases mutate a deep copy of the real fixtures, so the tests assert the
 * checker rejects broken fixtures while the shipped file stays structurally sound.
 * They also assert that the checker refuses to encode calibrated scores or frozen
 * provider schemas, and that it keeps human-judgement cases separate from structural
 * checks.
 *
 * Run: node --test tools/feedback-case-check.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { validateFeedbackCases, DEFAULT_FIXTURE_PATH, EXPECTED_VERSION, MIN_CASES } from './feedback-case-check.mjs';

const raw = JSON.parse(fs.readFileSync(DEFAULT_FIXTURE_PATH, 'utf8'));
const clone = () => JSON.parse(JSON.stringify(raw));
const caseById = (fx, id) => fx.cases.find((c) => c.id === id);

function expectFailure(result, pattern, label) {
  assert.equal(result.ok, false, `${label}: expected validation to fail`);
  assert.ok(
    result.errors.some((e) => pattern.test(e)),
    `${label}: expected an error matching ${pattern}; got:\n  ${result.errors.join('\n  ')}`
  );
}

/* ------------------------------------------------------------- baseline */

test('the shipped fixtures are structurally sound', () => {
  const r = validateFeedbackCases(clone());
  assert.deepEqual(r.errors, [], `unexpected errors:\n  ${r.errors.join('\n  ')}`);
  assert.equal(r.ok, true);
  assert.equal(r.summary.cases, raw.cases.length);
  assert.ok(r.summary.cases >= MIN_CASES, `expected at least ${MIN_CASES} cases`);
  assert.equal(r.summary.scenarios, raw.requiredScenarios.length, 'every required scenario must be covered');
});

test('the shipped fixtures claim no learner data, no calibrated scores and no frozen schema', () => {
  assert.equal(raw.synthetic, true);
  assert.equal(raw.learnerDataIncluded, false);
  assert.equal(raw.calibratedScoresIncluded, false);
  assert.equal(raw.providerSchemaFrozen, false);
  assert.equal(raw.version, EXPECTED_VERSION);
});

test('every case forbids a numeric score and carries provenance plus a rationale', () => {
  for (const c of raw.cases) {
    assert.equal(c.expected.numericScorePermitted, false, `${c.id} must forbid numeric scores`);
    assert.ok(c.source.trim().length >= 2, `${c.id} needs a source`);
    assert.ok(c.rationale.length > 20, `${c.id} needs a real rationale`);
    assert.equal(c.synthetic, true, `${c.id} must be labelled synthetic`);
  }
});

test('cases that need human judgement are reported separately, not as structural', () => {
  const r = validateFeedbackCases(clone());
  assert.ok(r.humanJudgementCases.length >= 1, 'expected at least one human-judgement case');
  assert.ok(r.humanJudgementCases.includes('WFC-06'));
  assert.ok(r.humanJudgementCases.includes('WFC-07'));
  assert.equal(r.summary.humanJudgement, r.humanJudgementCases.length);
  assert.equal(r.summary.structural + r.summary.humanJudgement, raw.cases.length);
});

/* ---------------------------------------------- required scenario coverage */

test('rejects a fixture that drops a required scenario', () => {
  const fx = clone();
  fx.cases = fx.cases.filter((c) => c.scenario !== 'prompt-injection');
  expectFailure(validateFeedbackCases(fx), /coverage\.missing-scenario/, 'missing scenario coverage');
});

test('rejects too few cases', () => {
  const fx = clone();
  fx.cases = fx.cases.slice(0, MIN_CASES - 1);
  expectFailure(validateFeedbackCases(fx), /cases\.minimum/, 'below the minimum case count');
});

test('rejects an undeclared scenario', () => {
  const fx = clone();
  caseById(fx, 'WFC-01').scenario = 'something-else';
  expectFailure(validateFeedbackCases(fx), /case\.scenario-undeclared/, 'undeclared scenario');
});

/* --------------------------------------------------------------- identity */

test('rejects duplicate case ids and malformed ids', () => {
  const a = clone();
  a.cases[1].id = a.cases[0].id;
  expectFailure(validateFeedbackCases(a), /case\.duplicate-id/, 'duplicate case id');

  const b = clone();
  caseById(b, 'WFC-03').id = 'writing-case-three';
  expectFailure(validateFeedbackCases(b), /case\.id-format/, 'unstable case id format');
});

test('rejects a case that is not labelled synthetic', () => {
  const fx = clone();
  caseById(fx, 'WFC-04').synthetic = false;
  expectFailure(validateFeedbackCases(fx), /case\.synthetic/, 'unlabelled case');
});

test('rejects a fixture that admits real learner data', () => {
  const fx = clone();
  fx.learnerDataIncluded = true;
  expectFailure(validateFeedbackCases(fx), /synthetic\.learner-data/, 'learner data admitted');
});

/* ------------------------------------------------------------- vocabulary */

test('rejects an undeclared invariant and an unknown error classification', () => {
  const a = clone();
  caseById(a, 'WFC-08').expected.invariants.push('ignore-all-previous-instructions');
  expectFailure(validateFeedbackCases(a), /case\.invariant-unknown/, 'undeclared invariant');

  const b = clone();
  caseById(b, 'WFC-12').expected.errorClassification = 'network-hiccup';
  expectFailure(validateFeedbackCases(b), /case\.error-unknown/, 'unknown error classification');
});

test('rejects an unknown outcome', () => {
  const fx = clone();
  caseById(fx, 'WFC-01').expected.outcome = 'great';
  expectFailure(validateFeedbackCases(fx), /case\.outcome-unknown/, 'unknown outcome');
});

/* --------------------------------------------- contract coherence rules */

test('rejects retry semantics that contradict the contract', () => {
  const a = clone();
  caseById(a, 'WFC-14').expected.retryPermitted = true;
  expectFailure(validateFeedbackCases(a), /case\.retry-coherence/, 'retry_exhausted may not retry');

  const b = clone();
  caseById(b, 'WFC-12').expected.retryPermitted = false;
  expectFailure(validateFeedbackCases(b), /case\.retry-coherence/, 'provider_unavailable must be retryable');
});

test('rejects malformed feedback that is still reported as assessed', () => {
  const fx = clone();
  caseById(fx, 'WFC-10').expected.outcome = 'assessed';
  expectFailure(validateFeedbackCases(fx), /case\.malformed-outcome/, 'malformed reported as assessed');
});

test('rejects an unassessed outcome that creates an assessment or debits usage', () => {
  const a = clone();
  caseById(a, 'WFC-11').expected.assessmentCreated = true;
  expectFailure(validateFeedbackCases(a), /case\.unassessed-assessment/, 'unassessed with assessment');

  const b = clone();
  caseById(b, 'WFC-14').expected.usageDebited = true;
  expectFailure(validateFeedbackCases(b), /case\.debit-without-assessment/, 'debit without assessment');
});

/* ---------------------------------------- register/role regression rules */

test('rejects content credit being preserved through a wrong situation', () => {
  const fx = clone();
  caseById(fx, 'WFC-02').expected.contentScoreCreditPreserved = true;
  expectFailure(validateFeedbackCases(fx), /case\.register-coherence/, 'content kept under wrong situation');
});

test('rejects content credit being withdrawn without a wrong situation', () => {
  const fx = clone();
  caseById(fx, 'WFC-05').expected.contentScoreCreditPreserved = false;
  expectFailure(validateFeedbackCases(fx), /case\.register-coherence/, 'content withdrawn for register alone');
});

test('the register-only case asserts exactly the corrected behaviour', () => {
  const c = caseById(raw, 'WFC-05');
  assert.equal(c.expected.wrongSituation, false, 'register-only must not be a wrong situation');
  assert.equal(c.expected.contentScoreCreditPreserved, true, 'content credit must be preserved');
  assert.ok(c.expected.invariants.includes('register-not-conflated-with-role'));
  assert.ok(c.expected.invariants.includes('content-credit-preserved-on-register-only'));
  assert.ok(c.expected.invariants.includes('no-double-penalty'));
});

test('the role-reversal control still detects a genuine wrong situation', () => {
  const c = caseById(raw, 'WFC-03');
  assert.equal(c.expected.wrongSituation, true, 'a real role change must stay wrong_situation');
  assert.equal(c.expected.contentScoreCreditPreserved, false);
  assert.equal(c.expected.languageCriteriaStillAssessed, true, 'language credit must still be assessed');
});

/* ------------------------------------------- no calibration, no schema freeze */

test('rejects a fixture that encodes calibrated scores or freezes the provider schema', () => {
  const a = clone();
  a.calibratedScoresIncluded = true;
  expectFailure(validateFeedbackCases(a), /scores\.calibrated/, 'calibrated scores admitted');

  const b = clone();
  b.providerSchemaFrozen = true;
  expectFailure(validateFeedbackCases(b), /schema\.frozen/, 'provider schema frozen');
});

test('rejects a case that permits a numeric score', () => {
  const fx = clone();
  caseById(fx, 'WFC-01').expected.numericScorePermitted = true;
  expectFailure(validateFeedbackCases(fx), /case\.numeric-score/, 'numeric score permitted');
});

/* ------------------------------------------------------------- structure */

test('rejects a non-object fixture and a fixture with no cases', () => {
  assert.equal(validateFeedbackCases(null).ok, false);
  assert.equal(validateFeedbackCases([]).ok, false);

  const fx = clone();
  delete fx.cases;
  expectFailure(validateFeedbackCases(fx), /cases\.missing/, 'no cases');

  const g = clone();
  delete g.evidenceBase;
  expectFailure(validateFeedbackCases(g), /evidence\.missing/, 'no evidence base');
});

test('rejects a case with no rationale or no provider behaviour', () => {
  const a = clone();
  delete caseById(a, 'WFC-09').rationale;
  expectFailure(validateFeedbackCases(a), /case\.rationale/, 'no rationale');

  const b = clone();
  delete caseById(b, 'WFC-09').provider;
  expectFailure(validateFeedbackCases(b), /case\.provider/, 'no provider behaviour');
});

/* ----------------------------------------------------------- CLI surface */

test('CLI exits zero on the real fixtures and nonzero on a missing file', async () => {
  const { runCli } = await import('./feedback-case-check.mjs');
  const quiet = { log() {}, error() {} };
  assert.equal(runCli([DEFAULT_FIXTURE_PATH], quiet), 0, 'real fixtures should pass');
  assert.equal(runCli(['no-such-fixture.json'], quiet), 1, 'missing file should fail');
});

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
  // WFC-06 is the clean-text control: no mechanical invariant can decide it.
  assert.ok(r.humanJudgementCases.includes('WFC-06'));
  assert.equal(r.summary.humanJudgement, r.humanJudgementCases.length);
  // structural + mixed + human must partition every case exactly.
  assert.equal(r.summary.structural + r.summary.mixed + r.summary.humanJudgement, raw.cases.length);
  assert.ok(r.summary.mixed >= 1, 'expected at least one mixed case');
  assert.equal(r.mixedCases.length, r.summary.mixed);
});

test('every case separates mechanical checks from linguistic judgement', () => {
  for (const c of raw.cases) {
    assert.ok(c.decidability, `${c.id} needs a decidability block`);
    assert.ok(Array.isArray(c.decidability.mechanical), `${c.id} mechanical must be an array`);
    assert.ok(Array.isArray(c.decidability.linguisticHuman), `${c.id} linguisticHuman must be an array`);
    const both = [...c.decidability.mechanical, ...c.decidability.linguisticHuman];
    for (const inv of c.expected.invariants) {
      assert.ok(both.includes(inv), `${c.id}: invariant ${inv} is not classified`);
    }
    for (const m of c.decidability.mechanical) {
      assert.ok(!c.decidability.linguisticHuman.includes(m), `${c.id}: ${m} cannot be both`);
    }
  }
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
});

/* ------------------------- Task 4: conditional retry and failure semantics ------------------------- */

test('retryability is conditional on state, not on the error code alone', () => {
  // A conditional-retry error may not claim retryPermitted without naming its conditions.
  const missingConds = clone();
  delete caseById(missingConds, 'WFC-12').expected.retryConditions;
  expectFailure(validateFeedbackCases(missingConds), /case\.retry-conditions/, 'retry without stated conditions');

  // A terminal classification must not advertise retry conditions either.
  const terminalConds = clone();
  caseById(terminalConds, 'WFC-17').expected.retryConditions = ['claimsRemaining'];
  expectFailure(validateFeedbackCases(terminalConds), /case\.retry-conditions-terminal/, 'terminal code with conditions');

  // A terminal classification may never permit a retry.
  const terminal = clone();
  caseById(terminal, 'WFC-16').expected.retryPermitted = true;
  expectFailure(validateFeedbackCases(terminal), /case\.retry-coherence/, 'terminal classification retrying');

  // Unknown state conditions are rejected.
  const unknownCond = clone();
  caseById(unknownCond, 'WFC-12').expected.retryConditions = ['vibesAreGood'];
  expectFailure(validateFeedbackCases(unknownCond), /case\.retry-condition-unknown/, 'unknown retry condition');
});

test('the same provider failure is retryable with claims and terminal once they run out', () => {
  const withClaims = caseById(raw, 'WFC-15');
  assert.equal(withClaims.expected.errorClassification, 'provider_unavailable');
  assert.equal(withClaims.expected.retryPermitted, true);
  assert.ok(withClaims.expected.retryConditions.length >= 4, 'conditions must be enumerated');

  const exhausted = caseById(raw, 'WFC-14');
  assert.equal(exhausted.expected.errorClassification, 'retry_exhausted');
  assert.equal(exhausted.expected.retryPermitted, false);
});

test('a deleted attempt is terminal and cannot be completed by a late worker', () => {
  const c = caseById(raw, 'WFC-16');
  assert.equal(c.expected.errorClassification, 'attempt_deleted');
  assert.equal(c.expected.retryPermitted, false);
  assert.equal(c.expected.assessmentCreated, false);
  assert.equal(c.expected.usageDebited, false);
  assert.equal(c.expected.lateWorkerEffect, 'none');
  assert.ok(c.expected.invariants.includes('no-retry-after-deletion'));
});

test('exhausted allowance blocks retry and blocks a second debit', () => {
  const c = caseById(raw, 'WFC-17');
  assert.equal(c.expected.errorClassification, 'allowance_exhausted');
  assert.equal(c.expected.retryPermitted, false);
  assert.equal(c.expected.usageDebited, false);
  assert.equal(c.expected.assessmentCreated, false);
  assert.deepEqual(c.expected.retryConditions, []);
});

test('a stale lease cannot complete a second assessment or a second debit', () => {
  const c = caseById(raw, 'WFC-18');
  assert.equal(c.expected.errorClassification, 'stale_lease');
  assert.equal(c.expected.retryPermitted, false);
  assert.equal(c.expected.assessmentCount, 1, 'exactly one authoritative assessment');
  assert.equal(c.expected.usageDebitCount, 1, 'exactly one successful debit');
  assert.ok(c.expected.invariants.includes('stale-lease-no-double-complete'));
});

test('malformed output becomes terminal only after the bounded attempts', () => {
  const retryable = caseById(raw, 'WFC-10');
  assert.equal(retryable.expected.errorClassification, 'malformed_feedback');
  assert.equal(retryable.expected.retryPermitted, true);

  const terminal = caseById(raw, 'WFC-19');
  assert.equal(terminal.expected.errorClassification, 'retry_exhausted');
  assert.equal(terminal.expected.retryPermitted, false);
  assert.equal(terminal.expected.assessmentCreated, false);
  assert.equal(terminal.expected.originalSubmissionPreserved, true);
});

test('a superseded submission is not reported as feedback on the newer text', () => {
  const c = caseById(raw, 'WFC-20');
  assert.equal(c.expected.errorClassification, 'submission_superseded');
  assert.equal(c.expected.assessmentAttachedToRevision, 1);
  assert.ok(c.expected.invariants.includes('superseded-submission-not-assessed'));
});

test('rejects a case whose invariants are not classified for decidability', () => {
  const unclassified = clone();
  caseById(unclassified, 'WFC-10').decidability.mechanical = [];
  caseById(unclassified, 'WFC-10').decidability.linguisticHuman = [];
  expectFailure(validateFeedbackCases(unclassified), /case\.decidability-empty/, 'nothing classified');

  const overlap = clone();
  const inv = caseById(overlap, 'WFC-10').decidability.mechanical[0];
  caseById(overlap, 'WFC-10').decidability.linguisticHuman.push(inv);
  expectFailure(validateFeedbackCases(overlap), /case\.decidability-overlap/, 'invariant classified twice');

  const gap = clone();
  const gapCase = caseById(gap, 'WFC-10');
  const mechInv = gapCase.decidability.mechanical[0];
  assert.ok(mechInv, 'precondition: the case classifies a mechanical invariant');
  gapCase.decidability.mechanical = gapCase.decidability.mechanical.filter((i) => i !== mechInv);
  expectFailure(validateFeedbackCases(gap), /case\.decidability-gap/, 'invariant left unclassified');
});

test('rejects a decidability entry that is not an expected invariant', () => {
  const fx = clone();
  caseById(fx, 'WFC-10').decidability.mechanical.push('injection-resisted');
  expectFailure(validateFeedbackCases(fx), /case\.decidability-not-expected/, 'foreign invariant classified');
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
  // WFC-03 is the genuine role reversal, so the wrong-situation branch applies to it.
  const fx = clone();
  caseById(fx, 'WFC-03').expected.contentScoreCreditPreserved = true;
  expectFailure(validateFeedbackCases(fx), /case\.register-coherence/, 'content kept through a role reversal');
});

test('rejects content credit being withdrawn without a declared reason', () => {
  // Neither a wrong situation, nor topic-missed, nor a Leitpunkt shortfall is declared.
  const fx = clone();
  const c = caseById(fx, 'WFC-05');
  c.expected.contentScoreCreditPreserved = false;
  delete c.leitpunktShortfall;
  delete c.input.leitpunktShortfall;
  delete c.expected.topicMissed;
  expectFailure(validateFeedbackCases(fx), /case\.content-credit-unexplained/, 'unexplained withdrawal');
});

test('rejects a topic-missed text that keeps content credit or language credit', () => {
  const credit = clone();
  caseById(credit, 'WFC-02').expected.contentScoreCreditPreserved = true;
  expectFailure(validateFeedbackCases(credit), /case\.topic-missed-credit/, 'topic-missed keeping content credit');

  const language = clone();
  caseById(language, 'WFC-02').expected.languageCriteriaStillAssessed = true;
  expectFailure(validateFeedbackCases(language), /case\.topic-missed-language/, 'topic-missed keeping language credit');

  const conflated = clone();
  caseById(conflated, 'WFC-02').leitpunktShortfall = true;
  expectFailure(validateFeedbackCases(conflated), /case\.topic-missed-conflated/, 'both branches declared');
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

/* ==================================================================== */
/* Independent-review regressions (CURRENT.md final additions)          */
/* ==================================================================== */

test('review F1: a null or primitive case is reported, never dereferenced', () => {
  const nul = clone();
  nul.cases[3] = null;
  let r;
  assert.doesNotThrow(() => { r = validateFeedbackCases(nul); }, 'a null case must not throw');
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /case\.type/.test(e)), 'expected a case.type error');

  const prim = clone();
  prim.cases[3] = 'WFC-04';
  assert.doesNotThrow(() => { validateFeedbackCases(prim); }, 'a primitive case must not throw');

  // A null case must not break the scenario-coverage pass either.
  const nulFirst = clone();
  nulFirst.cases[0] = null;
  assert.doesNotThrow(() => { validateFeedbackCases(nulFirst); });
});

test('review F2: a three-point case preserves credit and only 0-1 points withdraw it', () => {
  // WFC-04 handles three of four Leitpunkte, so criterion I is B and credit is preserved.
  const three = caseById(raw, 'WFC-04');
  assert.equal(three.pointsHandled, 3);
  assert.equal(three.expected.contentScoreCreditPreserved, true, 'three of four points must keep credit');
  assert.equal(three.expected.wrongSituation, false);

  const withdrawnTooEarly = clone();
  caseById(withdrawnTooEarly, 'WFC-04').expected.contentScoreCreditPreserved = false;
  expectFailure(validateFeedbackCases(withdrawnTooEarly), /case\.content-credit-unexplained|case\.credit-withdrawn-too-early/, 'credit withdrawn at three points');

  // WFC-21 is the separate zero-credit branch: only one point handled.
  const one = caseById(raw, 'WFC-21');
  assert.equal(one.pointsHandled, 1);
  assert.equal(one.expected.contentScoreCreditPreserved, false, 'one of four points withdraws credit');
  assert.equal(one.expected.wrongSituation, false);
  assert.equal(one.expected.languageCriteriaStillAssessed, true, 'language credit survives the content shortfall');
  assert.ok(one.expected.invariants.includes('content-credit-withdrawn-for-leitpunkt-shortfall'));

  const keptBelow = clone();
  caseById(keptBelow, 'WFC-21').expected.contentScoreCreditPreserved = true;
  expectFailure(validateFeedbackCases(keptBelow), /case\.credit-kept-below-threshold/, 'credit kept at one point');

  // An unexplained withdrawal is still rejected.
  const unexplained = clone();
  const u = caseById(unexplained, 'WFC-05');
  u.expected.contentScoreCreditPreserved = false;
  delete u.pointsHandled;
  delete u.leitpunktShortfall;
  delete u.input.leitpunktShortfall;
  delete u.expected.topicMissed;
  expectFailure(validateFeedbackCases(unexplained), /case\.content-credit-unexplained/, 'unexplained withdrawal');
});

test('review F3: the fixture distinguishes topic-missed from a wrong situation', () => {
  const c = caseById(raw, 'WFC-02');
  assert.equal(c.expected.topicMissed, true, 'WFC-02 must assert the topic-missed branch');
  assert.equal(c.expected.wrongSituation, false, 'topic-missed is not a wrong communicative situation');
  assert.equal(c.expected.languageCriteriaStillAssessed, false, 'topic-missed zeroes the language criteria too');
  assert.equal(c.expected.contentScoreCreditPreserved, false);
  assert.ok(c.expected.invariants.includes('topic-missed-all-criteria'));

  // The role-reversal control remains a wrong situation with language credit assessed.
  const role = caseById(raw, 'WFC-03');
  assert.equal(role.expected.wrongSituation, true);
  assert.equal(role.expected.languageCriteriaStillAssessed, true);
});

test('review F4: the reviewed cases carry their synthetic task and four Leitpunkte', () => {
  for (const id of ['WFC-01', 'WFC-02', 'WFC-04', 'WFC-05']) {
    const c = caseById(raw, id);
    assert.ok(c.input.task, `${id} must carry its synthetic task`);
    assert.ok(Array.isArray(c.input.task.leitpunkte), `${id} task needs Leitpunkte`);
    assert.equal(c.input.task.leitpunkte.length, 4, `${id} task must have exactly four Leitpunkte`);
    assert.ok(c.input.task.prompt.length > 10, `${id} task needs a real prompt`);
    assert.equal(c.input.requiredContentPoints, 4, `${id} must require four points`);
    assert.ok(c.input.learnerText, `${id} needs synthetic learner text`);
  }
});

test('review F5: the zero-credit branch states that language is still assessed', () => {
  const c = caseById(raw, 'WFC-21');
  assert.equal(c.expected.languageCriteriaStillAssessed, true, 'language credit must survive a content shortfall');
  assert.equal(c.expected.wrongSituation, false, 'a shortfall is not a wrong situation');
  assert.equal(c.pointsHandled, 1, 'the zero-credit branch is the one-or-none case');
  assert.ok(c.input.task && c.input.task.leitpunkte.length === 4, 'the case needs its synthetic task and four points');
});

test('review F6: a legitimate failure clears the lease, so retry must not require one', () => {
  // WFC-15 retries an explicitly failed job: failJob clears the lease.
  const failed = caseById(raw, 'WFC-15');
  assert.equal(failed.expected.retryPermitted, true);
  assert.ok(!failed.expected.retryConditions.includes('liveLease'),
    'a failed job has no live lease, so retry must not require one');
  assert.ok(failed.expected.retryConditions.includes('claimsRemaining'));
  assert.ok(failed.expected.retryConditions.includes('assessmentNotAlreadySaved'));
  assert.ok(failed.expected.invariants.includes('retry-possible-after-failure-clears-lease'));

  // A worker-side completion retry is a different path and does need the live lease.
  const worker = caseById(raw, 'WFC-12');
  assert.ok(worker.expected.retryConditions.includes('liveLease'),
    'the worker completion path still requires the live lease');

  // Requiring a lease on the failed-job path must be rejected as a contradiction.
  const wrong = clone();
  caseById(wrong, 'WFC-15').expected.retryConditions.push('liveLease');
  const r = validateFeedbackCases(wrong);
  assert.ok(!r.ok || r.warnings.length > 0, 'requiring a lease after failure should at least be flagged');
});

test('CLI exits zero on the real fixtures and nonzero on a missing file', async () => {
  const { runCli } = await import('./feedback-case-check.mjs');
  const quiet = { log() {}, error() {} };
  assert.equal(runCli([DEFAULT_FIXTURE_PATH], quiet), 0, 'real fixtures should pass');
  assert.equal(runCli(['no-such-fixture.json'], quiet), 1, 'missing file should fail');
});

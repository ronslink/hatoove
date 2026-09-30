/**
 * Tests for tools/mock-outcome-check.mjs (WRITING-OUTCOMES-02).
 *
 * Runs the same checks twice: once against the current module (all must pass) and once
 * against the real pre-fix public/js/exam.js materialized from git (the defect checks
 * must fail, the controls must still pass). The two runs together are the only thing that
 * makes the probe meaningful: a suite that is green on both broken and fixed code proves
 * nothing.
 *
 * It is a module + source-substring proof only: no browser, so no real page lifecycle.
 *
 * Run: node --test tools/mock-outcome-check.test.mjs
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  runMockOutcomeChecks,
  materializePrefixTree,
  REQUIRED_CHECKS,
  CONTROL_CHECKS,
  PREFIX_MUST_FAIL,
  DISCRIMINATION_CHECK,
  PREFIX_EXAM_SHA256,
} from './mock-outcome-check.mjs';

const current = await runMockOutcomeChecks();
const currentByName = new Map(current.results.map((result) => [result.name, result]));

let prefix = null;
let prefixReport = null;
let materialized = null;
try {
  materialized = materializePrefixTree();
  prefix = fs.readFileSync(materialized.file, 'utf8');
  prefixReport = await runMockOutcomeChecks({ prefixExamSource: prefix });
} finally {
  if (materialized) fs.rmSync(materialized.root, { recursive: true, force: true });
}

const prefixByName = new Map(prefixReport.results.map((result) => [result.name, result]));

after(() => {});

/* ------------------------------------------------------------ acceptance */

for (const name of REQUIRED_CHECKS) {
  test(`mock-outcome: ${name}`, () => {
    const result = currentByName.get(name);
    assert.ok(result, `check "${name}" did not run`);
    assert.ok(result.ok, `${name}: ${result.detail}`);
  });
}

test('every current-tree check passed', () => {
  const failed = current.results.filter((result) => !result.ok);
  assert.deepEqual(
    failed.map((failure) => `${failure.name}: ${failure.detail}`),
    [],
    'the mock-outcome suite must pass end to end'
  );
  assert.ok(current.ok);
  assert.ok(current.results.length >= REQUIRED_CHECKS.length + CONTROL_CHECKS.length);
});

test('the run is dependency-free offline: no env file and no browser', () => {
  assert.equal(current.envPath, null, 'the suite must not create or read an env file');
  assert.equal(current.treeLayer, 'module');
});

/* -------------------------------------------------------- discrimination */

test('the pre-fix exam.js is the recorded base blob, byte-for-byte', () => {
  const report = prefixReport.results.find((result) => result.name === DISCRIMINATION_CHECK);
  assert.ok(report, 'the discrimination check did not run');
  assert.equal(prefixReport.examSha256, PREFIX_EXAM_SHA256);
});

test('the probe discriminates: every defect check fails on the pre-fix exam.js', () => {
  for (const name of PREFIX_MUST_FAIL) {
    const result = prefixByName.get(name);
    assert.ok(result, `check "${name}" did not run on the pre-fix tree`);
    assert.equal(result.ok, false, `pre-fix "${name}" should fail, but it passed: ${result.detail}`);
  }
});

test('the probe is not a constant: the control checks still pass on the pre-fix exam.js', () => {
  for (const name of CONTROL_CHECKS) {
    const result = prefixByName.get(name);
    assert.ok(result, `control "${name}" did not run on the pre-fix tree`);
    assert.ok(result.ok, `control "${name}" must pass on the pre-fix tree, got: ${result.detail}`);
  }
});

test('the discrimination check records how many defect checks failed pre-fix', () => {
  const result = prefixByName.get(DISCRIMINATION_CHECK);
  assert.ok(result, 'the discrimination check did not run');
  assert.ok(result.ok, `discrimination check failed: ${result.detail}`);
  assert.equal(prefixReport.mustFailObserved, PREFIX_MUST_FAIL.length);
});

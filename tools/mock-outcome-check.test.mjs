/**
 * node:test wrapper for tools/mock-outcome-check.mjs (WRITING-OUTCOMES-02).
 *
 * Asserts the fixed tree passes every acceptance check, and that the same checks
 * discriminate: run against the pre-fix `public/js/exam.js` materialized
 * byte-for-byte from git, the recorded set fails and the recorded literal values
 * still hold. A probe that passed on both trees would prove nothing, so the
 * failing set and the literals are compared exactly.
 *
 * Module level only - no browser, no provider, no learner record.
 *
 * Run: node --test tools/mock-outcome-check.test.mjs
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import {
  runMockOutcomeChecks,
  materializePrefixTree,
  collectPrefixLiterals,
  makeImpl,
  REQUIRED_CHECKS,
  PREFIX_FAILURES,
  PREFIX_LITERALS,
  PREFIX_EXAM_SHA256,
} from './mock-outcome-check.mjs';

let prefix = null;
let prefixError = null;
try {
  prefix = materializePrefixTree();
} catch (err) {
  prefixError = err.message;
}

const report = await runMockOutcomeChecks({ prefixSource: prefix ? prefix.source : null });
const byName = new Map(report.results.map((result) => [result.name, result]));

after(() => {
  if (prefix) fs.rmSync(prefix.root, { recursive: true, force: true });
});

/* ------------------------------------------------------------ acceptance */

for (const name of REQUIRED_CHECKS) {
  test(`mock-outcome: ${name}`, () => {
    const result = byName.get(name);
    assert.ok(result, `check "${name}" did not run`);
    assert.ok(result.ok, `${name}: ${result.detail}`);
  });
}

test('every required mock-outcome check ran and passed', () => {
  assert.ok(REQUIRED_CHECKS.length >= 15, 'the suite was not silently truncated');
  assert.deepEqual(report.results.filter((r) => !r.ok).map((r) => `${r.name}: ${r.detail}`), []);
  assert.equal(report.results.length, REQUIRED_CHECKS.length);
});

/* -------------------------------------------------------- discrimination */

test('the pre-fix exam.js is materialized from git and verified byte-for-byte', () => {
  if (!prefix) {
    assert.ok(prefixError, 'materialization failed and no reason was recorded');
    return; // skip: no git/base available in a shallow checkout
  }
  assert.equal(prefix.sha256, PREFIX_EXAM_SHA256, 'pre-fix exam.js changed under the probe');
});

test('the probe fails on the pre-fix tree exactly where it must', () => {
  if (!prefix) return; // skip
  assert.ok(report.prefixResults, 'the discrimination run did not happen');
  const failed = report.prefixResults.filter((r) => !r.ok).map((r) => r.name).sort();
  assert.deepEqual(failed, [...PREFIX_FAILURES].sort());
  assert.ok(failed.length >= 10, 'the probe must fail on the pre-fix tree for the fix to mean anything');
});

test('the pre-fix tree still produces the recorded literal defects', async () => {
  if (!prefix) return; // skip
  const impl = makeImpl('prefix-literal-check', prefix.source, { fixed: false });
  const literals = await collectPrefixLiterals(impl);
  assert.deepEqual(literals, PREFIX_LITERALS);
  // Literal, not logical: absent writing was scored as a hard zero, not "missing".
  assert.strictEqual(literals.missingWritingPoints, 0);
  assert.strictEqual(literals.resultViewWholeExamDenominator, '/ 225');
});

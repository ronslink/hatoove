/**
 * Tests for tools/progress-equal-check.mjs (PM-01: `progressEqual` was key-order sensitive).
 *
 * The suite drives the real `public/js/progress-merge.js` and the real `server.js` in-process
 * with a throwaway env/progress file, and asserts that `progressEqual` answers the question it
 * claims to: equal for logically identical records regardless of key order, unequal for
 * genuinely different ones, symmetric, and reflected in the HTTP response (no `state` on a
 * no-op merge, `state` when the merge recovered something).
 *
 * It also runs the *same* check-1 shapes against the pre-fix `progress-merge.js` materialized
 * byte-for-byte from git and asserts they fail there (strict `=== false`), and that the pre-fix
 * server returns `state` on an identical POST. A probe that passes on both trees proves nothing;
 * this programme already had to reject one such probe.
 *
 * It is an HTTP + module proof only: no browser, so no real page lifecycle.
 *
 * Run: node --test tools/progress-equal-check.test.mjs
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  runProgressEqualChecks,
  materializePrefixTree,
  closeAll,
  REQUIRED_CHECKS,
  DISCRIMINATION_CHECK,
  DISCRIMINATION_HTTP_CHECK,
  PREFIX_MERGE_SHA256,
} from './progress-equal-check.mjs';

// The pre-fix tree is materialized from git. If git or the base commit is unavailable (a
// shallow checkout), the discrimination tests are skipped with a reason rather than silently
// passing - and the CLI reports that it could not prove discrimination.
let prefix = null;
let prefixError = null;
try {
  prefix = materializePrefixTree();
} catch (err) {
  prefixError = err.message;
}

const report = await runProgressEqualChecks({ legacyRoot: prefix ? prefix.root : null });
const byName = new Map(report.results.map((result) => [result.name, result]));

after(async () => {
  await closeAll();
  if (prefix) fs.rmSync(prefix.root, { recursive: true, force: true });
});

/* ------------------------------------------------------------ acceptance */

for (const name of REQUIRED_CHECKS) {
  test(`progress-equal: ${name}`, () => {
    const result = byName.get(name);
    assert.ok(result, `check "${name}" did not run`);
    assert.ok(result.ok, `${name}: ${result.detail}`);
  });
}

test('every progress-equal check passed', () => {
  const failed = report.results.filter((result) => !result.ok);
  assert.deepEqual(
    failed.map((failure) => `${failure.name}: ${failure.detail}`),
    [],
    'the progress-equal suite must pass end to end'
  );
  assert.ok(report.ok);
  assert.ok(report.results.length >= REQUIRED_CHECKS.length);
});

test('the suite never uses the repository .env', () => {
  const tempRoot = path.resolve(os.tmpdir());
  assert.ok(
    path.resolve(report.envPath).startsWith(tempRoot + path.sep),
    `suite env file must live under the temp directory, got ${report.envPath}`
  );
  assert.notEqual(path.resolve(report.envPath), path.resolve(report.root, '.env'));
});

/* -------------------------------------------------------- discrimination */

/**
 * The point of the exercise. The pre-fix module must fail every check-1 shape and the pre-fix
 * server must return the state on an identical POST. If either passes on the pre-fix tree, the
 * probe is worthless and the fix is unproven.
 */
test(`progress-equal: ${DISCRIMINATION_CHECK}`, { skip: prefixError ? `pre-fix tree unavailable: ${prefixError}` : false }, () => {
  const result = byName.get(DISCRIMINATION_CHECK);
  assert.ok(result, `check "${DISCRIMINATION_CHECK}" did not run`);
  assert.ok(result.ok, `${DISCRIMINATION_CHECK}: ${result.detail}`);
  assert.equal(report.prefixSha, PREFIX_MERGE_SHA256, 'the pre-fix module must be the recorded base blob');
});

test(`progress-equal: ${DISCRIMINATION_HTTP_CHECK}`, { skip: prefixError ? `pre-fix tree unavailable: ${prefixError}` : false }, () => {
  const result = byName.get(DISCRIMINATION_HTTP_CHECK);
  assert.ok(result, `check "${DISCRIMINATION_HTTP_CHECK}" did not run`);
  assert.ok(result.ok, `${DISCRIMINATION_HTTP_CHECK}: ${result.detail}`);
  assert.ok(report.prefix, 'the pre-fix probe must have produced observations');
  assert.equal(report.prefix.identicalHasState, true, 'the pre-fix server returns state on an identical POST');
});

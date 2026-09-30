/**
 * Tests for tools/progress-scope-check.mjs (F4-SCOPE-01: the legacy progress store is
 * account-scoped, with a one-time legacy migration and explicit signed-out behaviour).
 *
 * The suite drives the real public/js/store.js and the real server.js in-process with a
 * throwaway env/progress file and asserts the six acceptance checks ran and passed. It also
 * runs the *same* probe against the pre-fix tree, materialised byte-for-byte from git (its
 * store.js/server.js sha256 are recorded and asserted): the four account-scope checks must
 * fail there and the two controls must pass. A probe that is green on both trees proves
 * nothing; this programme already had to reject one such probe.
 *
 * It is an HTTP + client-module proof only: no browser, so no real page lifecycle, onscreen
 * keyboard or audio path is exercised.
 *
 * Run: node --test tools/progress-scope-check.test.mjs
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  runProgressScopeChecks,
  materializePrefixTree,
  closeAll,
  REQUIRED_CHECKS,
  SCOPE_CHECKS,
  CONTROL_CHECKS,
  DISCRIMINATION_CHECK,
  PREFIX_STORE_SHA256,
  PREFIX_SERVER_SHA256,
} from './progress-scope-check.mjs';

// The pre-fix tree is materialised from git. If git or the base commit is unavailable (a
// shallow checkout), the discrimination test is skipped with a reason rather than silently
// passing - and the CLI reports that it could not prove discrimination.
let prefix = null;
let prefixError = null;
try {
  prefix = materializePrefixTree();
} catch (err) {
  prefixError = err.message;
}

const report = await runProgressScopeChecks({ prefix: prefix ? { root: prefix.root } : null });
const byName = new Map(report.results.map((result) => [result.name, result]));

after(async () => {
  await closeAll();
  if (prefix) fs.rmSync(prefix.root, { recursive: true, force: true });
});

/* ------------------------------------------------------------ acceptance */

for (const name of REQUIRED_CHECKS) {
  test(`progress-scope: ${name}`, () => {
    const result = byName.get(name);
    assert.ok(result, `check "${name}" did not run`);
    assert.ok(result.ok, `${name}: ${result.detail}`);
  });
}

test('every progress-scope check passed', () => {
  const failed = report.results.filter((result) => !result.ok);
  assert.deepEqual(
    failed.map((failure) => `${failure.name}: ${failure.detail}`),
    [],
    'the progress-scope suite must pass end to end'
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
 * The point of the exercise: the four account-scope checks must fail on the pre-fix tree
 * while the two controls keep passing, and the pre-fix blobs must be the recorded ones.
 */
test(`progress-scope: ${DISCRIMINATION_CHECK}`, { skip: prefixError ? `pre-fix tree unavailable: ${prefixError}` : false }, () => {
  const result = byName.get(DISCRIMINATION_CHECK);
  assert.ok(result, `check "${DISCRIMINATION_CHECK}" did not run`);
  assert.ok(result.ok, `${DISCRIMINATION_CHECK}: ${result.detail}`);
  assert.ok(report.prefix, 'the pre-fix probe must have produced observations');
  assert.equal(report.prefixSha.store, PREFIX_STORE_SHA256, 'the pre-fix store.js must be the recorded base blob');
  assert.equal(report.prefixSha.server, PREFIX_SERVER_SHA256, 'the pre-fix server.js must be the recorded base blob');
  assert.deepEqual(
    SCOPE_CHECKS.filter((name) => !report.prefix.results.find((r) => r.name === name)?.ok),
    SCOPE_CHECKS,
    'every account-scope check must fail on the pre-fix tree'
  );
  assert.deepEqual(
    CONTROL_CHECKS.filter((name) => report.prefix.results.find((r) => r.name === name)?.ok),
    CONTROL_CHECKS,
    'every control must still pass on the pre-fix tree'
  );
});

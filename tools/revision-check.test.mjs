/**
 * Tests for tools/revision-check.mjs (SEC-05 fix for the F-2 reset/in-flight-save race).
 *
 * The suite drives the real client (public/js/store.js) against the real server
 * (server.js) in-process, with a throwaway .env/progress file, and asserts that a reset
 * is not resurrected by a save that was already on the wire - the exact scenario the
 * independent SEC-02R review reproduced with a single tab.
 *
 * It also runs the *same probe* against the pre-fix tree materialized from git
 * (`8a71f71:server.js` + the pre-fix `public/js/store.js`) and asserts it DOES resurrect
 * there. A probe that passes on both trees proves nothing; this programme already had to
 * reject one such probe.
 *
 * It is an HTTP + client-module proof only: no browser, so no real page lifecycle.
 *
 * Run: node --test tools/revision-check.test.mjs
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  runRevisionChecks,
  materializePrefixTree,
  closeAll,
  REQUIRED_CHECKS,
  DISCRIMINATION_CHECK,
} from './revision-check.mjs';

// The pre-fix tree is materialized from git. If git or the base commit is unavailable
// (a shallow checkout), the discrimination test is skipped with a reason rather than
// silently passing - and the CLI reports that it could not prove discrimination.
let prefix = null;
let prefixError = null;
try {
  prefix = materializePrefixTree();
} catch (err) {
  prefixError = err.message;
}

const report = await runRevisionChecks({ legacyRoot: prefix ? prefix.root : null });
const byName = new Map(report.results.map((result) => [result.name, result]));

after(async () => {
  await closeAll();
  if (prefix) fs.rmSync(prefix.root, { recursive: true, force: true });
});

/* ------------------------------------------------------------ acceptance */

for (const name of REQUIRED_CHECKS) {
  test(`revision: ${name}`, () => {
    const result = byName.get(name);
    assert.ok(result, `check "${name}" did not run`);
    assert.ok(result.ok, `${name}: ${result.detail}`);
  });
}

test('every revision check passed', () => {
  const failed = report.results.filter((result) => !result.ok);
  assert.deepEqual(
    failed.map((failure) => `${failure.name}: ${failure.detail}`),
    [],
    'the revision suite must pass end to end'
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
 * The point of the whole exercise. The pre-fix tree must fail the probe: a reset racing one
 * in-flight save is resurrected there. If this test ever passes on the pre-fix tree, the
 * probe is worthless and the "fix" is unproven.
 */
test(`revision: ${DISCRIMINATION_CHECK}`, { skip: prefixError ? `pre-fix tree unavailable: ${prefixError}` : false }, () => {
  const result = byName.get(DISCRIMINATION_CHECK);
  assert.ok(result, `check "${DISCRIMINATION_CHECK}" did not run`);
  assert.ok(result.ok, `${DISCRIMINATION_CHECK}: ${result.detail}`);

  const probe = report.prefix;
  assert.ok(probe, 'the pre-fix probe must have produced observations');
  assert.equal(probe.inFlightAtReset, true, 'the pre-fix probe must also catch the save in flight');
  assert.equal(probe.afterResetFound, false, 'the pre-fix DELETE did run (the defect is the resurrection, not the delete)');
  assert.equal(probe.markerInCacheAfterReset, true, 'the pre-fix in-flight save folds the record back into the cache');
  assert.equal(probe.afterReloadFound, true, 'the pre-fix tree must resurrect the deleted record on reload');
});

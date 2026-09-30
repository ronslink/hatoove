/**
 * Tests for tools/deletion-scope-check.mjs (F-5 fix for finding F-5).
 *
 * The suite drives the real client (public/js/store.js) against the real server
 * (server.js) in-process, with a throwaway .env/progress file. It creates the copies the
 * app leaves beside the record first (a second save makes `.bak`; tools/recover-progress.js
 * makes `.pre-recovery`), then runs the user-visible delete and asserts, file by file,
 * that no local copy survives - while a copy on simulated removable media is reported as
 * out of scope rather than assumed deleted.
 *
 * It also runs the *same probe* against the pre-fix tree materialized from git and asserts
 * it leaves a copy behind there. A probe that passes on both trees proves nothing.
 *
 * It is an HTTP + client-module proof only: no browser, so no real page lifecycle.
 *
 * Run: node --test tools/deletion-scope-check.test.mjs
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  runDeletionScopeChecks,
  materializePrefixTree,
  closeAll,
  REQUIRED_CHECKS,
  DISCRIMINATION_CHECK,
  PREFIX_SERVER_SHA256,
} from './deletion-scope-check.mjs';

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

const report = await runDeletionScopeChecks({ legacyRoot: prefix ? prefix.root : null });
const byName = new Map(report.results.map((result) => [result.name, result]));

after(async () => {
  await closeAll();
  if (prefix) fs.rmSync(prefix.root, { recursive: true, force: true });
});

/* ------------------------------------------------------------ acceptance */

for (const name of REQUIRED_CHECKS) {
  test(`deletion-scope: ${name}`, () => {
    const result = byName.get(name);
    assert.ok(result, `check "${name}" did not run`);
    assert.ok(result.ok, `${name}: ${result.detail}`);
  });
}

test('every deletion-scope check passed', () => {
  const failed = report.results.filter((result) => !result.ok);
  assert.deepEqual(
    failed.map((failure) => `${failure.name}: ${failure.detail}`),
    [],
    'the deletion-scope suite must pass end to end'
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
 * The point of the whole exercise. The pre-fix tree must fail the probe: a full delete
 * there leaves the app-created copies behind. If the pre-fix probe also removed every
 * copy, the probe would be worthless.
 */
test(
  `deletion-scope: ${DISCRIMINATION_CHECK}`,
  { skip: prefixError ? `pre-fix tree unavailable: ${prefixError}` : false },
  () => {
    const result = byName.get(DISCRIMINATION_CHECK);
    assert.ok(result, `check "${DISCRIMINATION_CHECK}" did not run`);
    assert.ok(result.ok, `${DISCRIMINATION_CHECK}: ${result.detail}`);

    const probe = report.prefix;
    assert.ok(probe, 'the pre-fix probe must have produced observations');
    assert.equal(report.prefixSha, PREFIX_SERVER_SHA256, 'the pre-fix server.js must be the recorded base blob (byte-for-byte)');
    assert.equal(probe.allCreatedFirst, true, 'the pre-fix probe must create every copy first');
    assert.equal(probe.anyCopySurvived, true, 'the pre-fix delete must leave an app-created copy behind');
    assert.equal(probe.survivesAfterReset['progress.json.pre-recovery'], true, 'the pre-fix tree must leave .pre-recovery behind');
  }
);

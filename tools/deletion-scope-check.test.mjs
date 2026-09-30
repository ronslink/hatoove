/**
 * Tests for tools/deletion-scope-check.mjs (F-5, re-scoped for the SaaS target).
 *
 * The suite drives the real client (public/js/store.js) against the real server (server.js)
 * in-process, with a throwaway .env and progress record. It creates the copies the server itself
 * writes first (a second real save makes the one-generation `.bak`), runs the user-visible delete,
 * and asserts file by file what was removed, what was reported, and what the response says it
 * cannot reach - while a copy another tool left in the same directory survives, as the merged
 * `reset-check` boundary asserts.
 *
 * It then runs the *same* probe against the pre-fix tree materialised from git, verified
 * byte-for-byte by sha256, and asserts the honesty checks fail there while every control passes.
 * A probe that passes on both trees proves nothing.
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
  HONESTY_CHECKS,
  CONTROL_CHECKS,
  DISCRIMINATION_CHECK,
  PREFIX_SERVER_SHA256,
} from './deletion-scope-check.mjs';

// The pre-fix tree is materialised from git. If git or the base commit is unavailable (a shallow
// or exported checkout), the discrimination test is skipped *with a reason* rather than silently
// passing - and the CLI reports that it could not prove discrimination.
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
 * The point of the whole exercise. The pre-fix tree must fail the honesty checks - it deleted the
 * files but never said what it removed or what it could not reach - while every control still
 * passes there. If the pre-fix run failed wholesale the probe would not discriminate the fix.
 */
test(
  `deletion-scope: ${DISCRIMINATION_CHECK}`,
  { skip: prefixError ? `pre-fix tree unavailable: ${prefixError}` : false },
  () => {
    const result = byName.get(DISCRIMINATION_CHECK);
    assert.ok(result, `check "${DISCRIMINATION_CHECK}" did not run`);
    assert.ok(result.ok, `${DISCRIMINATION_CHECK}: ${result.detail}`);

    const run = report.prefix;
    assert.ok(run, 'the pre-fix probe must have produced observations');
    assert.equal(run.sha256, PREFIX_SERVER_SHA256, 'the pre-fix server.js must be the recorded base blob (byte-for-byte)');

    const prefixResults = new Map(run.results.map((entry) => [entry.name, entry]));
    for (const name of HONESTY_CHECKS) {
      assert.equal(prefixResults.get(name)?.ok, false, `${name} must fail on the pre-fix tree`);
    }
    for (const name of CONTROL_CHECKS) {
      assert.equal(prefixResults.get(name)?.ok, true, `${name} must still pass on the pre-fix tree`);
    }
  }
);

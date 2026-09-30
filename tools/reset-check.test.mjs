/**
 * Tests for tools/reset-check.mjs (SEC-02 fix for finding F-2).
 *
 * The suite drives the real client (public/js/store.js) against the real server
 * (server.js) in-process, with a throwaway .env/progress file, and asserts that
 * "Alles zurücksetzen" and "Fehlerheft leeren" actually delete while the ordinary save
 * merge keeps protecting a partial write.
 *
 * It is an HTTP + client-module proof only: no browser, so no real page lifecycle.
 *
 * Run: node --test tools/reset-check.test.mjs
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';

import { runResetChecks, closeAll, REQUIRED_CHECKS } from './reset-check.mjs';

const report = await runResetChecks({ mode: 'tree' });
const byName = new Map(report.results.map((result) => [result.name, result]));

after(async () => {
  await closeAll();
});

/* ------------------------------------------------------------ acceptance */

for (const name of REQUIRED_CHECKS) {
  test(`reset: ${name}`, () => {
    const result = byName.get(name);
    assert.ok(result, `check "${name}" did not run`);
    assert.ok(result.ok, `${name}: ${result.detail}`);
  });
}

test('every reset check passed', () => {
  const failed = report.results.filter((result) => !result.ok);
  assert.deepEqual(
    failed.map((failure) => `${failure.name}: ${failure.detail}`),
    [],
    'the reset/delete suite must pass end to end'
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
 * A probe that cannot tell the fixed code from the broken code proves nothing, so the
 * same checks are run once more with the pre-SEC-02 client call sequence (empty state
 * posted, nothing deleted). The deletion checks must fail there while the merge check
 * still passes, which shows the failure is the deletion, not a broken probe.
 */
test('the probe discriminates: the pre-fix call sequence fails the deletion checks', async () => {
  const prefix = await runResetChecks({ mode: 'prefix' });
  const failed = new Set(prefix.results.filter((result) => !result.ok).map((result) => result.name));

  for (const name of [
    'reset-deletes-server-record',
    'reset-clears-browser-cache',
    'reset-not-undone-on-next-load',
    'reset-preserves-configuration',
    'clear-notebook-removes-entries-keeps-history',
  ]) {
    assert.ok(failed.has(name), `pre-fix sequence should fail "${name}", but it passed`);
  }
  assert.ok(
    !failed.has('normal-post-still-merges'),
    'the merge check must still pass without the fix, or the probe is not isolating the deletion'
  );
});

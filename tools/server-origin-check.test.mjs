/**
 * Tests for tools/server-origin-check.mjs (SEC-01 fix for finding F-1).
 *
 * The suite starts server.js in-process on an ephemeral port with a throwaway
 * .env/progress file and asserts the origin/authorization boundary over node:http.
 * It is an HTTP-layer proof only: no browser is involved, so it does not prove any
 * browser's behaviour.
 *
 * Run: node --test tools/server-origin-check.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';

import { runOriginChecks, REQUIRED_CHECKS } from './server-origin-check.mjs';

const report = await runOriginChecks();
const byName = new Map(report.results.map((r) => [r.name, r]));

/* ------------------------------------------------------------ acceptance */

for (const name of REQUIRED_CHECKS) {
  test(`boundary: ${name}`, () => {
    const result = byName.get(name);
    assert.ok(result, `check "${name}" did not run`);
    assert.ok(result.ok, `${name}: ${result.detail}`);
  });
}

test('every boundary check passed', () => {
  const failed = report.results.filter((r) => !r.ok);
  assert.deepEqual(
    failed.map((f) => `${f.name}: ${f.detail}`),
    [],
    'the HTTP-layer boundary suite must pass end to end'
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
});

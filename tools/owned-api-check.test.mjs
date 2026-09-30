/**
 * node:test wrapper for tools/owned-api-check.mjs (OWNAPI-01).
 *
 * Drives the real public/js/owned-client.js against server/owned-api.mjs with an
 * in-memory, test-only datastore and session port, then through server.js on an
 * ephemeral loopback port. No database, browser, provider or repository `.env`.
 * It carries no PostgreSQL/RLS evidence.
 *
 * Run: node --test tools/owned-api-check.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { runOwnedApiChecks, REQUIRED_CHECKS } from './owned-api-check.mjs';

const report = await runOwnedApiChecks();
const byName = new Map(report.results.map((r) => [r.name, r]));

for (const name of REQUIRED_CHECKS) {
  test(`owned-api: ${name}`, () => {
    const result = byName.get(name);
    assert.ok(result, `check "${name}" did not run`);
    assert.ok(result.ok, `${name}: ${result.detail}`);
  });
}

test('every owned-api check ran and passed', () => {
  assert.ok(REQUIRED_CHECKS.length >= 20, 'the suite was not silently truncated');
  assert.deepEqual(report.results.filter((r) => !r.ok).map((r) => `${r.name}: ${r.detail}`), []);
  assert.equal(report.results.length, REQUIRED_CHECKS.length);
});

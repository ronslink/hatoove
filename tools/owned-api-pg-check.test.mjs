/**
 * node:test wrapper for tools/owned-api-pg-check.mjs (OWNAPI-02).
 *
 * Runs the PostgreSQL ownership + RLS proof. Needs the `server/owned-postgres`
 * package installed and a disposable database (see its README.md). Synthetic
 * records only; it drops every schema and role it creates.
 *
 * Run: node --test tools/owned-api-pg-check.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { runOwnedApiPgChecks, REQUIRED_CHECKS } from './owned-api-pg-check.mjs';

const report = await runOwnedApiPgChecks();
const byName = new Map(report.results.map((r) => [r.name, r]));

for (const name of REQUIRED_CHECKS) {
  test(`owned-api-pg: ${name}`, () => {
    const result = byName.get(name);
    assert.ok(result, `check "${name}" did not run`);
    assert.ok(result.ok, `${name}: ${result.detail}`);
  });
}

test('every owned-api-pg check ran and passed', () => {
  assert.deepEqual(report.results.filter((r) => !r.ok).map((r) => `${r.name}: ${r.detail}`), []);
  assert.equal(report.results.length, REQUIRED_CHECKS.length);
});

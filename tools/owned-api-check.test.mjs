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

/*
 * THE NOTE MUST MATCH THE BACKEND THAT RAN.
 *
 * Added 2026-10-01 by the coordinator, from the combined-head re-execution. The note was
 * `backend === 'postgres' ? <postgres note> : <memory note>`, and `postgres-persistent` is a third
 * backend that `runOwnedApiChecks` accepts (:922) — and it is the one the CI `postgres` job runs
 * (`.github/workflows/ci.yml:141`). So the run that proves the durable property on real PostgreSQL
 * printed "in-memory datastore and session fakes only; no PostgreSQL/RLS evidence. Add
 * --backend=postgres for that." Every check in that run was correct; the sentence was false.
 *
 * This is the defect shape this programme keeps recording — the artefact that reports the result
 * does not report what it did — so it gets a check rather than a one-line fix.
 */
test('the backend note describes the backend that actually ran', async () => {
  const { backendNote } = await import('./owned-api-check.mjs');

  // The backend CI actually uses for the durable proof must NOT claim there is no PostgreSQL.
  assert.match(backendNote('postgres-persistent'), /real PostgreSQL/);
  assert.doesNotMatch(backendNote('postgres-persistent'), /in-memory/);
  assert.match(backendNote('postgres'), /real PostgreSQL/);

  // The memory backend must still say it carries no PostgreSQL evidence: that sentence is correct
  // and load-bearing, and a fix that removed it would be the opposite defect.
  assert.match(backendNote('memory'), /in-memory/);
  assert.doesNotMatch(backendNote('memory'), /real PostgreSQL/);

  // A backend nobody has taught this function about makes no claim at all, rather than inheriting a
  // true-sounding one it did not earn.
  assert.match(backendNote('something-new'), /unrecognised backend/);
  assert.match(backendNote('something-new'), /NO claim/);
});

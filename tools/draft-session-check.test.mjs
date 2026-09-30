/**
 * node:test wrapper for tools/draft-session-check.mjs (DRAFT-SESSION-01).
 *
 * Two things are proven here:
 *   1. every check passes on this tree, check by check; and
 *   2. the checks discriminate. The same suite is run against
 *        (a) a scratch copy of public/js/draft-session.js whose revision check is
 *            disabled: every save is sent on top of whatever revision the server
 *            currently holds (last writer wins) instead of the revision the session
 *            last saw; and
 *        (b) the real module over a datastore whose revision check is disabled.
 *      Both must fail exactly `stale-save-rejected-writes-nothing` and
 *      `conflict-resolved-to-server-adopts-server-copy`, and every other check must
 *      still pass, so the failure is specific and not a broken run. A suite that
 *      passed on both broken and fixed code would prove nothing.
 *
 * Offline: no browser, database, provider or `.env`. The scratch copy lives in a
 * temp directory and is removed as soon as the mutant run ends; the checkout is never modified.
 *
 * Run: node --test tools/draft-session-check.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { DEFAULT_MODULE, REQUIRED_CHECKS, runDraftSessionChecks } from './draft-session-check.mjs';

/* ------------------------------------------------------------ this tree */

const report = await runDraftSessionChecks();
const byName = new Map(report.results.map((r) => [r.name, r]));

for (const name of REQUIRED_CHECKS) {
  test(`draft-session: ${name}`, () => {
    const result = byName.get(name);
    assert.ok(result, `check "${name}" did not run`);
    assert.ok(result.ok, `${name}: ${result.detail}`);
  });
}

test('every draft-session check ran and passed', () => {
  assert.ok(REQUIRED_CHECKS.length >= 15, 'the suite was not silently truncated');
  assert.deepEqual(report.results.filter((r) => !r.ok).map((r) => `${r.name}: ${r.detail}`), []);
  assert.equal(report.results.length, REQUIRED_CHECKS.length);
});

/* ------------------------------------------------------- discrimination */

/** The exact line that sends the session's last-seen revision. */
export const REVISION_LINE = 'saved = await client.saveDraft(s.attemptId, { expectedRevision: s.revision, text });';
/** Mutant: fetch the server's current revision first, i.e. no revision check at all. */
export const MUTANT_LINE = 'saved = await client.saveDraft(s.attemptId, { expectedRevision: (await client.readAttempt(s.attemptId)).revision, text });';

const original = fs.readFileSync(DEFAULT_MODULE, 'utf8');
const mutantSource = original.replace(REVISION_LINE, MUTANT_LINE);

// The scratch copy exists only while the mutant suite runs, then is removed. (An
// `after()` hook is too late: node:test can run it before top-level awaits settle.)
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'draft-session-mutant-'));
let mutantReport;
try {
  const mutantPath = path.join(scratch, 'draft-session.mutant.js');
  fs.writeFileSync(mutantPath, mutantSource);
  mutantReport = await runDraftSessionChecks({ modulePath: mutantPath });
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}

/** Datastore mutant: ignore the caller's expectedRevision and save on the current one. */
const lastWriterWins = (port) => ({
  ...port,
  async save(owner, id, _expected, text) {
    const current = await port.read(owner, id);
    return port.save(owner, id, current.revision, text);
  },
});
const serverMutantReport = await runDraftSessionChecks({ wrapDatastore: lastWriterWins });

/** The checks that depend on the revision check; nothing else may fail on a mutant. */
const EXPECTED_FAILURES = ['stale-save-rejected-writes-nothing', 'conflict-resolved-to-server-adopts-server-copy'];
const failedNames = (r) => r.results.filter((x) => !x.ok).map((x) => x.name);
const resultOf = (r, name) => r.results.find((x) => x.name === name);

test('the scratch mutant really differs from the module, and only on the revision line', () => {
  assert.equal(original.split(REVISION_LINE).length, 2, 'the revision line exists exactly once');
  assert.notEqual(mutantSource, original);
  assert.equal(mutantSource.replace(MUTANT_LINE, REVISION_LINE), original);
  assert.ok(!fs.existsSync(scratch), 'the scratch copy was removed');
  assert.equal(fs.readFileSync(DEFAULT_MODULE, 'utf8'), original, 'the checkout was not modified');
});

test('a session without its revision check fails the stale-save check', (t) => {
  t.diagnostic(`mutant failures: ${failedNames(mutantReport).join(', ')}`);
  const stale = resultOf(mutantReport, 'stale-save-rejected-writes-nothing');
  assert.equal(stale.ok, false, 'the stale-save check must catch a session that saves over newer text');
  assert.match(stale.detail, /stale save must conflict/);
  // Exactly the revision checks fail; every other check still passes on the mutant, so
  // the failure is specific and not a module that failed to load.
  assert.deepEqual(failedNames(mutantReport), EXPECTED_FAILURES);
});

test('a datastore without its revision check fails the stale-save check', (t) => {
  t.diagnostic(`datastore-mutant failures: ${failedNames(serverMutantReport).join(', ')}`);
  const stale = resultOf(serverMutantReport, 'stale-save-rejected-writes-nothing');
  assert.equal(stale.ok, false);
  assert.match(stale.detail, /stale save must conflict/);
  assert.deepEqual(failedNames(serverMutantReport), EXPECTED_FAILURES);
});

/**
 * node:test wrapper for tools/writing-surface-check.mjs (WRITING-SURFACE-01B).
 *
 * Proves two things:
 *   1. every writing-surface check passes on this tree; and
 *   2. the checks DISCRIMINATE: the same suite is run against a scratch copy of
 *      public/js/writing-surface.js in which the restore leg is disabled - the surface
 *      ignores the server's snapshot on entering and keeps whatever text the view passed
 *      in. The leave-and-return check must fail there, and only the checks that depend on
 *      restore may fail; everything else must still pass, so the failure is specific and
 *      not a module that failed to load.
 *
 * Offline: no browser, database, provider or `.env`. The scratch copy lives in a temp
 * directory and is removed as soon as the mutant run ends; the checkout is never modified.
 *
 * LINE ENDINGS (fixed 2026-10-01, CI `Offline baseline (windows-latest)`):
 *   The first version matched RESTORE_BLOCK literally against the file as read. On a
 *   Windows checkout git writes CRLF, so `String.replace` matched NOTHING, the "mutant"
 *   was byte-identical to the original, and the discrimination suite failed on Windows
 *   while passing on Linux. That is the defect this programme keeps finding - a check
 *   whose *mutation* silently did not happen, so it could not discriminate - and the
 *   guard for it is now in place and asserted below: the mutation is applied to an
 *   LF-normalised copy AND the result is asserted to differ. The mutant is written back
 *   with LF, which is what the module itself is committed as.
 *
 * Run: node --test tools/writing-surface-check.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { DEFAULT_MODULE, REQUIRED_CHECKS, runWritingSurfaceChecks } from './writing-surface-check.mjs';

/* ------------------------------------------------------------ this tree */

const report = await runWritingSurfaceChecks();
const byName = new Map(report.results.map((r) => [r.name, r]));

for (const name of REQUIRED_CHECKS) {
  test(`writing-surface: ${name}`, () => {
    const result = byName.get(name);
    assert.ok(result, `check "${name}" did not run`);
    assert.ok(result.ok, `${name}: ${result.detail}`);
  });
}

test('every writing-surface check ran and passed', () => {
  assert.ok(REQUIRED_CHECKS.length >= 7, 'the suite was not silently truncated');
  assert.deepEqual(report.results.filter((r) => !r.ok).map((r) => `${r.name}: ${r.detail}`), []);
  assert.equal(report.results.length, REQUIRED_CHECKS.length);
});

/* ------------------------------------------------------- discrimination */

/** The span that lets the server's saved text win on entering a task (unique: the block
 *  right after `reason = '';`, which appears only in enter()). */
export const RESTORE_BLOCK = "    reason = '';\n    const snap = session.snapshot();\n    if (snap && typeof snap.text === 'string') text = snap.text;";
/** Mutant: keep the text the view passed in; the saved draft is never restored. */
export const MUTANT_BLOCK = "    reason = '';\n    const snap = session.snapshot();\n    if (snap && typeof snap.text === 'string') text = String(initialText ?? '');";

/** CRLF-safe comparison: the checkout's line endings are git's business, not the check's. */
export const toLf = (text) => String(text).replace(/\r\n/g, '\n');

const original = fs.readFileSync(DEFAULT_MODULE, 'utf8');
const originalLf = toLf(original);
const mutantSource = originalLf.replace(RESTORE_BLOCK, MUTANT_BLOCK);

/** The mutation must actually have happened, or the discrimination is vacuous. A
 *  mutation that silently no-ops is a check that cannot fail - the exact defect shape
 *  this programme has recorded five times, and this file's own Windows failure. */
if (mutantSource === originalLf) {
  throw new Error('the restore-block mutation did not apply: RESTORE_BLOCK does not appear in '
    + `${DEFAULT_MODULE} (line endings or a moved block). Without it the discrimination leg is vacuous.`);
}

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'writing-surface-mutant-'));
let mutantReport;
try {
  const mutantPath = path.join(scratch, 'writing-surface.mutant.js');
  fs.writeFileSync(mutantPath, mutantSource);
  mutantReport = await runWritingSurfaceChecks({ modulePath: mutantPath });
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}

/** The checks that depend on restore; nothing else may fail on the mutant. */
const EXPECTED_FAILURES = ['enter-restores-the-saved-text-on-return'];
const failedNames = (r) => r.results.filter((x) => !x.ok).map((x) => x.name);
const resultOf = (r, name) => r.results.find((x) => x.name === name);

test('the scratch mutant really differs from the module, and only on the restore line', () => {
  assert.equal(originalLf.split(RESTORE_BLOCK).length, 2, 'the restore block exists exactly once');
  assert.notEqual(mutantSource, originalLf, 'the mutation must change the module');
  assert.equal(mutantSource.replace(MUTANT_BLOCK, RESTORE_BLOCK), originalLf);
  assert.ok(!fs.existsSync(scratch), 'the scratch copy was removed');
  assert.equal(fs.readFileSync(DEFAULT_MODULE, 'utf8'), original, 'the checkout was not modified');
});

test('a surface that cannot restore fails the leave-and-return check', (t) => {
  t.diagnostic(`mutant failures: ${failedNames(mutantReport).join(', ')}`);
  const restore = resultOf(mutantReport, 'enter-restores-the-saved-text-on-return');
  assert.equal(restore.ok, false, 'the leave-and-return check must catch a surface that cannot restore');
  assert.match(restore.detail, /restored on return/);
  assert.deepEqual(failedNames(mutantReport), EXPECTED_FAILURES, 'only the restore-dependent checks may fail');
});

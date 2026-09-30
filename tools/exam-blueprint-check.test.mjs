/**
 * Tests for tools/exam-blueprint-check.mjs (USER-03 Task 2).
 *
 * Every corrupt case mutates a deep copy of the real draft blueprint, so the tests
 * assert that the checker rejects genuine contradictions/missing data while the
 * shipped artifact stays consistent. Unresolved fields are asserted to stay
 * explicitly unresolved rather than being fabricated into facts.
 *
 * Run: node --test tools/exam-blueprint-check.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { validateBlueprint, DEFAULT_BLUEPRINT_PATH, EXPECTED_VERSION } from './exam-blueprint-check.mjs';

const raw = JSON.parse(fs.readFileSync(DEFAULT_BLUEPRINT_PATH, 'utf8'));
const clone = () => JSON.parse(JSON.stringify(raw));

/** Assert that validation failed and that at least one error matches the pattern. */
function expectFailure(result, pattern, label) {
  assert.equal(result.ok, false, `${label}: expected validation to fail`);
  const hit = result.errors.some((e) => pattern.test(e));
  assert.ok(hit, `${label}: expected an error matching ${pattern}; got:\n  ${result.errors.join('\n  ')}`);
}

const sectionById = (bp, id) => bp.sections.find((s) => s.id === id);
const partById = (bp, id) => bp.sections.flatMap((s) => s.parts).find((p) => p.id === id);

/* ------------------------------------------------------------- baseline */

test('the shipped draft blueprint is internally consistent', () => {
  const result = validateBlueprint(clone());
  assert.deepEqual(result.errors, [], `unexpected errors:\n  ${result.errors.join('\n  ')}`);
  assert.equal(result.ok, true);
  assert.equal(result.summary.sections, 4);
  assert.equal(result.summary.parts, 9);
  assert.equal(result.summary.writtenPoints, 225);
  assert.equal(result.summary.totalMinutes, 150);
  assert.equal(result.summary.objectiveItemsLast, 60);
});

test('the shipped draft keeps an explicit no-oral / no-overall-pass limitation', () => {
  const result = validateBlueprint(clone());
  assert.equal(result.ok, true);
  assert.equal(raw.scope.overallPassInference.allowed, false);
  assert.match(raw.scope.overallPassInference.reason, /oral/i);
});

/* --------------------------------------------------- schema and version */

test('rejects a missing or unexpected version', () => {
  const a = clone(); delete a.version;
  expectFailure(validateBlueprint(a), /version\.missing/, 'missing version');

  const b = clone(); b.version = '1.0.0';
  expectFailure(validateBlueprint(b), /version\.unexpected/, 'wrong version');

  const c = clone(); c.version = EXPECTED_VERSION;
  assert.equal(validateBlueprint(c).ok, true);
});

test('rejects a non-object blueprint and missing required blocks', () => {
  assert.equal(validateBlueprint(null).ok, false);
  assert.equal(validateBlueprint([]).ok, false);

  const a = clone(); delete a.sources;
  expectFailure(validateBlueprint(a), /sources\.missing/, 'no sources block');

  const b = clone(); delete b.sections;
  expectFailure(validateBlueprint(b), /sections\.missing/, 'no sections block');

  const c = clone(); delete c.writtenExam;
  expectFailure(validateBlueprint(c), /writtenExam\.missing/, 'no writtenExam block');

  const d = clone(); delete d.unresolved;
  expectFailure(validateBlueprint(d), /unresolved\.missing/, 'no unresolved block');

  const e = clone(); delete e.gates;
  expectFailure(validateBlueprint(e), /gates\.missing/, 'no gates block');
});

/* ------------------------------------------------------ approval guards */

test('never elevates approval: forbidden review status is rejected', () => {
  for (const status of ['approved', 'published', 'validated', 'certified']) {
    const bp = clone();
    bp.review.status = status;
    expectFailure(validateBlueprint(bp), /review\.approval-claim/, `status ${status}`);
  }
  const unknown = clone();
  unknown.review.status = 'looks-fine-to-me';
  expectFailure(validateBlueprint(unknown), /review\.status-unknown/, 'unknown status');
});

test('never elevates approval: approvedBy must stay null', () => {
  const bp = clone();
  bp.review.approvedBy = 'someone';
  expectFailure(validateBlueprint(bp), /review\.approved-by/, 'approvedBy set');
});

test('never elevates approval: a gate may not mark itself satisfied', () => {
  const bp = clone();
  bp.gates.audioAndReuseRights.satisfied = true;
  expectFailure(validateBlueprint(bp), /gate\.self-approval/, 'self-satisfied gate');
});

test('an allowApproved option cannot be used to bypass the approval guards', () => {
  const bp = clone();
  bp.review.status = 'approved';
  const result = validateBlueprint(bp, { allowApproved: true });
  assert.equal(result.ok, false, 'allowApproved must not relax the approval guard');
  assert.ok(result.warnings.some((w) => /allowApproved is ignored/.test(w)));
});

/* ------------------------------------------------------- source integrity */

test('rejects a missing source reference on a part', () => {
  const bp = clone();
  delete partById(bp, 'lv-t1').sources;
  expectFailure(validateBlueprint(bp), /sources\.missing-refs/, 'part without sources');
});

test('rejects an empty source reference list on a section', () => {
  const bp = clone();
  sectionById(bp, 'sb').sources = [];
  expectFailure(validateBlueprint(bp), /sources\.empty/, 'section with empty sources');
});

test('rejects a reference to an unknown source and a malformed locator', () => {
  const a = clone();
  a.sections[0].sources = ['S99-p1-p1'];
  expectFailure(validateBlueprint(a), /sources\.ref-unknown/, 'unknown source id');

  const b = clone();
  b.sections[0].sources = ['printed page five'];
  expectFailure(validateBlueprint(b), /sources\.ref-format/, 'malformed locator');
});

test('rejects a duplicate source id and a bad retrieved date', () => {
  const a = clone();
  a.sources.push({ ...a.sources[0] });
  expectFailure(validateBlueprint(a), /sources\.duplicate-id/, 'duplicate source id');

  const b = clone();
  b.sources[0].retrieved = '30.09.2026';
  expectFailure(validateBlueprint(b), /sources\.retrieved-format/, 'non-ISO retrieved date');
});

/* ------------------------------------------------------- count arithmetic */

test('rejects a broken item-count sum inside a section', () => {
  const bp = clone();
  sectionById(bp, 'lv').parts[0].items.count = 4;
  expectFailure(validateBlueprint(bp), /section\.items\.sum|part\.items\.range-count/, 'item sum broken');
});

test('rejects a part range that does not match its count', () => {
  const bp = clone();
  partById(bp, 'lv-t3').items.last = 19;
  expectFailure(validateBlueprint(bp), /part\.items\.range-count/, 'range vs count');
});

test('rejects non-contiguous objective item numbering across sections', () => {
  const bp = clone();
  const sb = sectionById(bp, 'sb');
  sb.items.first = 25;
  sb.items.last = 44;
  sb.parts[0].items = { count: 10, first: 25, last: 34 };
  sb.parts[1].items = { count: 10, first: 35, last: 44 };
  expectFailure(validateBlueprint(bp), /items\.objective-gap/, 'objective numbering gap');
});

test('rejects a section point maximum that contradicts its parts', () => {
  const bp = clone();
  sectionById(bp, 'hv').points.max = 70;
  expectFailure(validateBlueprint(bp), /section\.points\.sum|writtenExam\.points-mismatch/, 'section points');
});

test('rejects a broken writing band-to-total multiplication', () => {
  const a = clone();
  partById(a, 'sa-t1').bandToTotal.multiplier = 2;
  expectFailure(validateBlueprint(a), /band-to-total\.subtest-mismatch|band-to-total\.formula/, 'bad multiplier');

  const b = clone();
  partById(b, 'sa-t1').criteria[0].bandPoints.A = 6;
  expectFailure(validateBlueprint(b), /band-to-total\.raw-mismatch/, 'criterion max changed');

  const c = clone();
  partById(c, 'sa-t1').bandToTotal.subtestMax = 40;
  expectFailure(validateBlueprint(c), /band-to-total\.points-mismatch|band-to-total\.subtest-mismatch/, 'subtest max mismatch');
});

test('rejects a criterion band that has no point value', () => {
  const bp = clone();
  const crit = partById(bp, 'sa-t1').criteria[1];
  delete crit.bandPoints.B;
  expectFailure(validateBlueprint(bp), /criterion\.band-missing-points/, 'band without points');
});

/* ------------------------------------------------------------ duplicates */

test('rejects duplicate part ids and duplicate part order within a section', () => {
  const a = clone();
  sectionById(a, 'lv').parts[1].id = 'lv-t1';
  expectFailure(validateBlueprint(a), /part\.duplicate-id/, 'duplicate part id');

  const b = clone();
  sectionById(b, 'lv').parts[1].order = 1;
  expectFailure(validateBlueprint(b), /part\.duplicate-order/, 'duplicate part order');
});

test('rejects duplicate section ids', () => {
  const bp = clone();
  bp.sections.push(JSON.parse(JSON.stringify(bp.sections[0])));
  expectFailure(validateBlueprint(bp), /section\.duplicate-id|section\.duplicate-order/, 'duplicate section');
});

/* ------------------------------------------------- timings and playback */

test('rejects a timing total that does not match the written examination', () => {
  const a = clone();
  sectionById(a, 'sa').timing.minutes = 20;
  expectFailure(validateBlueprint(a), /writtenExam\.minutes-mismatch/, 'written minutes');

  const b = clone();
  sectionById(b, 'sb').timing.minutes = 60;
  expectFailure(validateBlueprint(b), /timing\.shared-block-mismatch/, 'shared block mismatch');
});

test('rejects an invalid permitted-play count and an unsupported one', () => {
  const a = clone();
  partById(a, 'hv-t2').permittedPlays = 0;
  expectFailure(validateBlueprint(a), /plays\.invalid|part\.plays/, 'zero plays');

  const b = clone();
  partById(b, 'hv-t2').permittedPlays = 3;
  expectFailure(validateBlueprint(b), /plays\.unsupported/, 'three plays');

  const c = clone();
  delete partById(c, 'hv-t3').permittedPlays;
  expectFailure(validateBlueprint(c), /part\.plays/, 'missing plays on an audio part');
});

test('keeps the per-part play pattern explicit (1 / 2 / 2)', () => {
  assert.equal(partById(raw, 'hv-t1').permittedPlays, 1);
  assert.equal(partById(raw, 'hv-t2').permittedPlays, 2);
  assert.equal(partById(raw, 'hv-t3').permittedPlays, 2);
});

/* ----------------------------------------------------- unsupported claims */

test('rejects an unsupported task family', () => {
  const bp = clone();
  partById(bp, 'lv-t2').taskFamily = 'essay';
  expectFailure(validateBlueprint(bp), /part\.task-family-unsupported/, 'unsupported family');
});

test('rejects a section that asserts an oral or overall component', () => {
  const a = clone();
  sectionById(a, 'sa').subtest = 'Mündlicher Ausdruck';
  expectFailure(validateBlueprint(a), /section\.oral-claim/, 'oral subtest');

  const b = clone();
  sectionById(b, 'sa').subtestEn = 'Speaking and overall result';
  expectFailure(validateBlueprint(b), /section\.oral-claim/, 'overall claim');
});

test('rejects a blueprint that allows an overall pass inference', () => {
  const bp = clone();
  bp.scope.overallPassInference.allowed = true;
  expectFailure(validateBlueprint(bp), /scope\.overall-pass-claim/, 'overall pass allowed');
});

test('rejects the threshold being applied per subtest', () => {
  const bp = clone();
  bp.writtenExam.thresholdAppliesPerSubtest = true;
  expectFailure(validateBlueprint(bp), /writtenExam\.threshold-scope/, 'threshold per subtest');
});

/* ------------------------------------------------------- pass arithmetic */

test('rejects pass marks that contradict the stated percentage', () => {
  const a = clone();
  a.writtenExam.writtenPassPoints = 130;
  expectFailure(validateBlueprint(a), /writtenExam\.pass-mismatch/, 'written pass mark');

  const b = clone();
  b.writtenExam.oralPassPoints = 40;
  expectFailure(validateBlueprint(b), /writtenExam\.oral-pass-mismatch/, 'oral pass mark');

  const c = clone();
  c.writtenExam.writtenWeightPercent = 70;
  c.writtenExam.oralWeightPercent = 30;
  expectFailure(validateBlueprint(c), /weight-inconsistent|weight-sum/, 'weight inconsistency');
});

/* ------------------------------------------- unresolved stays unresolved */

test('preserves each unresolved edge and rejects a fabricated resolution', () => {
  assert.ok(Array.isArray(raw.unresolved) && raw.unresolved.length >= 5);
  for (const u of raw.unresolved) {
    assert.equal(u.status, 'unresolved', `${u.id} must stay explicitly unresolved`);
    assert.ok(u.question.length > 10, `${u.id} needs a real question`);
  }
  const ids = raw.unresolved.map((u) => u.id);
  assert.equal(new Set(ids).size, ids.length, 'unresolved ids must be unique');

  const bp = clone();
  bp.unresolved[0].status = 'resolved';
  expectFailure(validateBlueprint(bp), /unresolved\.status/, 'fabricated resolution');
});

test('rejects duplicate unresolved ids', () => {
  const bp = clone();
  bp.unresolved.push({ ...bp.unresolved[0] });
  expectFailure(validateBlueprint(bp), /unresolved\.duplicate-id/, 'duplicate unresolved id');
});

/* ----------------------------------------------------------- CLI surface */

test('CLI exits nonzero on a corrupt file and zero on the real artifact', async () => {
  const { runCli } = await import('./exam-blueprint-check.mjs');
  const quiet = { log() {}, error() {} };
  assert.equal(runCli([DEFAULT_BLUEPRINT_PATH], quiet), 0, 'real artifact should pass');
  assert.equal(runCli(['no-such-file.json'], quiet), 1, 'missing file should fail');
});

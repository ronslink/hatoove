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
const isPlainObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);

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

test('approval guards cannot be relaxed by any option', () => {
  // The former no-op `allowApproved` option has been removed: it had no effect and only
  // advertised a bypass. Passing it must not change the outcome.
  const bp = clone();
  const strict = validateBlueprint(bp);
  const withOption = validateBlueprint(bp, { allowApproved: true });
  assert.deepEqual(withOption.errors, strict.errors);
  assert.deepEqual(withOption.warnings, strict.warnings);

  const bad = clone();
  bad.review.status = 'approved';
  assert.equal(validateBlueprint(bad, { allowApproved: true }).ok, false, 'no call shape may accept an approval claim');
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

/* ==================================================================== */
/* Adversarial regression suite (USER-04 Task 2)                        */
/* Each block below records a defect that the earlier checker accepted. */
/* ==================================================================== */

test('defect 1: a page locator whose arithmetic contradicts the declared offset is rejected', () => {
  // The regex accepted any two page numbers. "S2-p39-p5" is not a real page pair:
  // S2's verified convention is printedPage + 2 = PDF page.
  const bad = clone();
  bad.sections[0].sources = ['S2-p39-p5'];
  expectFailure(validateBlueprint(bad), /sources\.locator-offset/, 'offset mismatch');

  const reversed = clone();
  reversed.sections[0].sources = ['S2-p5-p39'];
  expectFailure(validateBlueprint(reversed), /sources\.locator-offset/, 'reversed page pair');

  const good = clone();
  good.sections[0].sources = ['S2-p39-p37'];
  assert.equal(validateBlueprint(good).ok, true, 'a correct page pair must still pass');
});

test('defect 2: a zero page number is rejected because pages are one-based', () => {
  const bad = clone();
  bad.sections[0].sources = ['S2-p0-p0'];
  expectFailure(validateBlueprint(bad), /sources\.locator-zero/, 'zero page numbers');
});

test('defect 3: a page locator beyond the source page count is rejected', () => {
  const bad = clone();
  bad.sections[0].sources = ['S2-p99-p97'];
  expectFailure(validateBlueprint(bad), /sources\.locator-range/, 'page beyond source length');
});

test('a two-page locator on a source with no verified offset warns rather than silently passing', () => {
  const bp = clone();
  bp.sections[0].sources = ['S3-p4-p4'];
  const r = validateBlueprint(bp);
  assert.ok(r.warnings.some((w) => /locator-unverifiable/.test(w)), 'expected an unverifiable-locator warning');
});

test('defect 4: writing-shaped data on a non-writing task family is rejected', () => {
  const bad = clone();
  bad.sections[3].parts[0].taskFamily = 'multiple-choice';
  expectFailure(validateBlueprint(bad), /part\.writing-shape-family/, 'criteria kept on a non-writing family');
});

test('defect 5: a retrieval date in the future is rejected', () => {
  const bad = clone();
  bad.sources[0].retrieved = '2099-01-01';
  expectFailure(validateBlueprint(bad), /sources\.retrieved-future/, 'future retrieval date');

  const ok = clone();
  ok.sources[0].retrieved = '2026-09-30';
  assert.equal(validateBlueprint(ok).ok, true);
});

/* ---------------- deeper adversarial shapes around the same surfaces ---------------- */

test('rejects null, primitive and nested-missing data instead of throwing', () => {
  const shapes = [
    ['null parts array', (b) => { b.sections[0].parts = null; }],
    ['null part items', (b) => { b.sections[0].parts[0].items = null; }],
    ['null source entry', (b) => { b.sources[0] = null; }],
    ['primitive source entry', (b) => { b.sources[0] = 'S1'; }],
    ['null section', (b) => { b.sections[0] = null; }],
    ['null part', (b) => { b.sections[0].parts[0] = null; }],
    ['null criterion', (b) => { b.sections[3].parts[0].criteria[0] = null; }],
    ['null rule', (b) => { b.answerRules[0] = null; }],
    ['null unresolved entry', (b) => { b.unresolved[0] = null; }],
    ['null gate', (b) => { b.gates.examFidelityApproval = null; }],
    ['null writtenExam', (b) => { b.writtenExam = null; }],
    ['null scope', (b) => { b.scope = null; }],
    ['null timing', (b) => { b.sections[0].timing = null; }],
    ['null points', (b) => { b.sections[0].points = null; }],
  ];
  for (const [label, mutate] of shapes) {
    const b = clone();
    mutate(b);
    let r;
    assert.doesNotThrow(() => { r = validateBlueprint(b); }, `${label} must not throw`);
    assert.equal(r.ok, false, `${label} must be rejected`);
  }
});

test('rejects non-finite and otherwise invalid numbers', () => {
  const cases = [
    ['NaN section points', (b) => { b.sections[0].points.max = NaN; }],
    ['Infinity timing', (b) => { b.sections[0].timing.minutes = Infinity; }],
    ['-Infinity weight', (b) => { b.sections[0].points.weightPercent = -Infinity; }],
    ['negative weight', (b) => { b.sections[0].points.weightPercent = -25; }],
    ['string number', (b) => { b.sections[0].points.max = '75'; }],
    ['float item count', (b) => { b.sections[0].parts[0].items.count = 5.5; }],
    ['boolean minutes', (b) => { b.sections[1].timing.minutes = true; }],
  ];
  for (const [label, mutate] of cases) {
    const b = clone();
    mutate(b);
    let r;
    assert.doesNotThrow(() => { r = validateBlueprint(b); }, `${label} must not throw`);
    assert.equal(r.ok, false, `${label} must be rejected`);
  }
});

test('rejects overlapping and duplicated item ranges within a section', () => {
  const overlap = clone();
  overlap.sections[0].parts[1].items = { count: 5, first: 1, last: 5 };
  expectFailure(validateBlueprint(overlap), /part\.items\.not-contiguous|part\.items\.range-count/, 'overlapping ranges');

  const duplicateSection = clone();
  const sb = duplicateSection.sections[1];
  sb.items = { count: 20, first: 1, last: 20 };
  sb.parts[0].items = { count: 10, first: 1, last: 10 };
  sb.parts[1].items = { count: 10, first: 11, last: 20 };
  expectFailure(validateBlueprint(duplicateSection), /items\.objective-gap/, 'range reused across sections');
});

test('rejects writing criterion and band structure defects', () => {
  const missingBand = clone();
  missingBand.sections[3].parts[0].criteria[0].bands = ['A', 'B', 'C'];
  expectFailure(validateBlueprint(missingBand), /criterion\.band-missing-points|criterion\.points-extra-band|criterion\.band-no-zero|band-to-total\.raw-mismatch/, 'band list and bandPoints disagree');

  const extraBand = clone();
  extraBand.sections[3].parts[0].criteria[0].bandPoints.E = 7;
  expectFailure(validateBlueprint(extraBand), /criterion\.points-extra-band|band-to-total\.raw-mismatch/, 'bandPoints has an undeclared band');

  const duplicateBand = clone();
  duplicateBand.sections[3].parts[0].criteria[0].bands = ['A', 'A', 'C', 'D'];
  expectFailure(validateBlueprint(duplicateBand), /criterion\.band-duplicate/, 'duplicate band entry');

  const negativeBand = clone();
  negativeBand.sections[3].parts[0].criteria[0].bandPoints.D = -1;
  expectFailure(validateBlueprint(negativeBand), /criterion\.band-point-invalid|criterion\.band-negative/, 'negative band points');

  const noZero = clone();
  noZero.sections[3].parts[0].criteria[0].bandPoints.D = 1;
  const r = validateBlueprint(noZero);
  assert.ok(r.warnings.some((w) => /band-no-zero/.test(w)), 'a missing zero band should warn');
});

test('rejects altered section weights and unsupported claims', () => {
  const weights = clone();
  weights.sections[0].points.weightPercent = 50;
  weights.writtenExam.writtenWeightPercent = 50;
  weights.writtenExam.oralWeightPercent = 50;
  expectFailure(validateBlueprint(weights), /weight-inconsistent|weight-sum/, 'altered weights');

  const oral = clone();
  oral.sections.push({
    id: 'ma', order: 5, subtest: 'Mündlicher Ausdruck', subtestEn: 'Speaking', assessedInPilot: true, objective: true,
    timing: { kind: 'own-block', sharedBlockId: null, minutes: 15, minutesIsApproximate: true, breakWithinBlock: false },
    points: { raw: 25, rawIsPerPart: true, max: 75, weightPercent: 25 },
    items: { count: 3, first: 1, last: 3 }, sources: ['S1'],
    parts: [{ id: 'ma-t1', order: 1, title: 'T1', skill: 'x', taskFamily: 'matching', responseFormat: 'matching', items: { count: 3, first: 1, last: 3 }, points: 75, sources: ['S1'] }],
  });
  expectFailure(validateBlueprint(oral), /section\.oral-claim/, 'oral section added');
});

test('source-integrity surface: unverified offsets, bad gate shape, non-array rule refs', () => {
  const unverified = clone();
  unverified.sources[1].pageOffset = { printedToPdf: 2, verified: false };
  expectFailure(validateBlueprint(unverified), /sources\.page-offset-unverified/, 'unverified offset used for validation');

  const gateShape = clone();
  delete gateShape.gates.audioAndReuseRights.satisfied;
  expectFailure(validateBlueprint(gateShape), /gate\.satisfied/, 'gate without satisfied flag');

  const ruleRefs = clone();
  ruleRefs.sections[0].answerRuleRefs = 'ar-lv-single-use';
  expectFailure(validateBlueprint(ruleRefs), /rule\.unknown-reference/, 'non-array rule refs');

  const emptyApplies = clone();
  emptyApplies.answerRules[0].appliesTo = [];
  expectFailure(validateBlueprint(emptyApplies), /rule\.applies-to/, 'rule with no targets');
});

test('unresolved entries may legitimately cite no source, but must stay unresolved', () => {
  // U8 records an out-of-scope comparison with no document behind it. That is an
  // honest unknown, not a defect, so an empty source list is permitted there.
  const bp = clone();
  bp.unresolved[7].sources = [];
  assert.equal(validateBlueprint(bp).ok, true, 'an explicitly out-of-scope unknown may cite nothing');

  const fabricated = clone();
  fabricated.unresolved[0].status = 'closed';
  expectFailure(validateBlueprint(fabricated), /unresolved\.status/, 'unresolved entry claiming closure');
});

test('every shipped page locator is arithmetically consistent with its source', () => {
  const withLocators = [];
  const walk = (v) => {
    if (Array.isArray(v)) return v.forEach(walk);
    if (isPlainObject(v)) {
      for (const [k, val] of Object.entries(v)) {
        if (k === 'sources' && Array.isArray(val)) withLocators.push(...val.filter((s) => typeof s === 'string'));
        else walk(val);
      }
    }
  };
  walk(raw);
  const paged = withLocators.filter((s) => /^S2-p\d+-p\d+$/.test(s));
  assert.ok(paged.length > 10, `expected many S2 page locators, found ${paged.length}`);
  for (const ref of paged) {
    const m = ref.match(/^S2-p(\d+)-p(\d+)$/);
    assert.equal(Number(m[1]) - Number(m[2]), 2, `${ref} must satisfy PDF = printed + 2`);
    assert.ok(Number(m[1]) >= 1 && Number(m[2]) >= 1, `${ref} must be one-based`);
  }
});

/* ==================================================================== */
/* Independent-review regressions (CURRENT.md "final independent-review */
/* additions"). Each test names the defect and proves it now fails.     */
/* ==================================================================== */

test('review R1: section maximum must equal the real sum of part points', () => {
  // Before: every LV part could change 25 -> 1 while section max stayed 75, because the
  // checker only compared part points with each other.
  const allWrong = clone();
  for (const p of sectionById(allWrong, 'lv').parts) p.points = 1;
  expectFailure(validateBlueprint(allWrong), /section\.points\.sum/, 'all part points reduced');

  const oneWrong = clone();
  sectionById(oneWrong, 'lv').parts[0].points = 10;
  expectFailure(validateBlueprint(oneWrong), /section\.points\.sum|section\.part-points-vary/, 'one part point changed');

  // ...and a consistent reduction that also updates every aggregate must still pass.
  const consistent = clone();
  for (const p of consistent.sections[0].parts) p.points = 1;
  consistent.sections[0].points.raw = 1;
  consistent.sections[0].points.max = 3;
  consistent.writtenExam.writtenAggregatePoints = 153;
  consistent.writtenExam.writtenWeightPercent = 51;
  const r = validateBlueprint(consistent);
  assert.equal(r.errors.some((e) => /section\.points\.sum/.test(e)), false, 'a fully consistent resize must not raise a point-sum error');
});

test('review R2: source integrity covers nested writing and aggregate sources', () => {
  const inCriteria = clone();
  inCriteria.sections[3].parts[0].criteria[0].sources = ['S99-p1-p1'];
  expectFailure(validateBlueprint(inCriteria), /sources\.ref-unknown/, 'unknown source inside criteria');

  const inBandToTotal = clone();
  inBandToTotal.sections[3].parts[0].bandToTotal.sources = ['S99'];
  expectFailure(validateBlueprint(inBandToTotal), /sources\.ref-unknown/, 'unknown source inside bandToTotal');

  const inRating = clone();
  inRating.sections[3].parts[0].ratingProcedure.sources = ['S99'];
  expectFailure(validateBlueprint(inRating), /sources\.ref-unknown/, 'unknown source inside ratingProcedure');

  const inWritten = clone();
  inWritten.writtenExam.sources = ['S99'];
  expectFailure(validateBlueprint(inWritten), /sources\.ref-unknown/, 'unknown source inside writtenExam');

  const nestedTiming = clone();
  nestedTiming.sections[0].timing.sources = ['S99'];
  expectFailure(validateBlueprint(nestedTiming), /sources\.ref-unknown/, 'unknown source nested in timing');

  // The top-level source *definition* list must not be mistaken for references.
  assert.equal(validateBlueprint(clone()).ok, true, 'the real artifact must still pass');
});

test('review R3: a null section or part never throws', () => {
  const nullSection = clone();
  nullSection.sections[2] = null;
  let r;
  assert.doesNotThrow(() => { r = validateBlueprint(nullSection); }, 'null section must not throw');
  assert.equal(r.ok, false);

  const nullPart = clone();
  nullPart.sections[0].parts[1] = null;
  assert.doesNotThrow(() => { r = validateBlueprint(nullPart); }, 'null part must not throw');
  assert.equal(r.ok, false);
});

test('review R4: writing arithmetic inputs must exist before arithmetic is attempted', () => {
  for (const field of ['multiplier', 'rawCriterionMax', 'subtestMax']) {
    const bp = clone();
    delete bp.sections[3].parts[0].bandToTotal[field];
    expectFailure(validateBlueprint(bp), /band-to-total\.missing-field/, `missing bandToTotal.${field}`);
  }

  const noFormula = clone();
  delete noFormula.sections[3].parts[0].bandToTotal.formula;
  expectFailure(validateBlueprint(noFormula), /band-to-total\.formula-missing/, 'missing formula');

  const noRating = clone();
  delete noRating.sections[3].parts[0].ratingProcedure;
  expectFailure(validateBlueprint(noRating), /part\.rating-procedure/, 'missing ratingProcedure');

  const wrongRaters = clone();
  wrongRaters.sections[3].parts[0].ratingProcedure.independentRaters = 1;
  expectFailure(validateBlueprint(wrongRaters), /part\.rating-procedure-raters/, 'wrong rater count');
});

test('review R5: written pass-rule inputs must exist', () => {
  for (const field of ['writtenPassPoints', 'writtenPassPercent', 'oralPassPoints', 'oralPassPercent',
    'writtenAggregatePoints', 'totalPointsAllParts', 'writtenWeightPercent', 'oralWeightPercent', 'totalMinutes']) {
    const bp = clone();
    delete bp.writtenExam[field];
    expectFailure(validateBlueprint(bp), /writtenExam\.missing-field/, `missing writtenExam.${field}`);
  }

  const flags = clone();
  delete flags.writtenExam.thresholdAppliesPerPart;
  expectFailure(validateBlueprint(flags), /writtenExam\.missing-flag/, 'missing threshold flag');
});

test('CLI exits nonzero on a corrupt file and zero on the real artifact', async () => {
  const { runCli } = await import('./exam-blueprint-check.mjs');
  const quiet = { log() {}, error() {} };
  assert.equal(runCli([DEFAULT_BLUEPRINT_PATH], quiet), 0, 'real artifact should pass');
  assert.equal(runCli(['no-such-file.json'], quiet), 1, 'missing file should fail');
});

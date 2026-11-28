#!/usr/bin/env node
/**
 * Offline verification for `server/owned-postgres/dtz-review-approval.mjs`.
 *
 * Ensures:
 *   1. All 25 pinned DTZ listening + reading subjects match `packageHash` in `listening-package.json`.
 *   2. All 7 pinned DTZ writing tasks, rubric, blueprint v4 and form subjects match `listening-package.json`.
 *   3. Metadata, evidence SHA-256 and deterministic event UUIDs satisfy the 0035 review contract.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { packageHash } from '../server/package-contract.mjs';
import {
  DTZ_APPROVED_SUBJECTS,
  DTZ_APPROVED_WRITING_FORMAT_SUBJECTS,
  DTZ_APPROVAL_META,
  DTZ_WRITING_FORMAT_APPROVAL_META,
  deterministicEventUuid,
} from '../server/owned-postgres/dtz-review-approval.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(await readFile(path.join(ROOT, 'content', 'exams', 'dtz-a2-b1', 'listening-package.json'), 'utf8'));

const expectedLR = [
  ...pkg.sets.map((s) => ({ kind: 'content', id: `${s.setId}@${s.version}`, version: '', sha256: packageHash(s), category: 'educational', language: '' })),
  ...pkg.media.map((m) => ({ kind: 'content', id: `${m.mediaId}@${m.version}`, version: '', sha256: packageHash(m), category: 'audio', language: 'de' })),
].sort((a, b) => a.id.localeCompare(b.id));

const expectedWF = [
  ...[
    ...pkg.writingTasks.map((t) => ({ kind: 'content', id: `${t.taskId}@${t.version}`, version: '', sha256: packageHash(t), category: 'educational', language: '' })),
    ...pkg.rubrics.map((r) => ({ kind: 'content', id: `${r.rubricId}@${r.version}`, version: '', sha256: packageHash(r), category: 'educational', language: '' })),
  ].sort((a, b) => a.id.localeCompare(b.id)),
  { kind: 'blueprint', id: pkg.exam.id, version: pkg.blueprint.version, sha256: packageHash({ exam: pkg.exam, blueprint: pkg.blueprint }), category: 'exam_format', language: '' },
  ...pkg.forms.map((f) => ({ kind: 'form', id: f.id, version: f.version, sha256: packageHash({ blueprintVersion: pkg.blueprint.version, form: f }), category: 'exam_format', language: '' })),
];

assert.equal(DTZ_APPROVED_SUBJECTS.length, 25, 'expected 4 HV sets + 16 HV WAVs + 5 LV sets = 25 subjects');
assert.deepEqual(DTZ_APPROVED_SUBJECTS, expectedLR, 'pinned DTZ listening+reading hashes must match listening-package.json verbatim');

assert.equal(DTZ_APPROVED_WRITING_FORMAT_SUBJECTS.length, 7, 'expected 2 writing tasks + 1 rubric + 1 blueprint + 3 forms = 7 subjects');
assert.deepEqual(DTZ_APPROVED_WRITING_FORMAT_SUBJECTS, expectedWF, 'pinned DTZ writing+format hashes must match listening-package.json verbatim');

for (const meta of [DTZ_APPROVAL_META, DTZ_WRITING_FORMAT_APPROVAL_META]) {
  assert.equal(meta.reviewerId, 'ron-product-owner');
  assert(/^[0-9a-f]{64}$/.test(meta.evidenceSha256));
}
for (const entry of [...DTZ_APPROVED_SUBJECTS, ...DTZ_APPROVED_WRITING_FORMAT_SUBJECTS]) {
  assert(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(deterministicEventUuid(`${entry.kind}/${entry.id}/${entry.version}`)));
}

console.log('DTZ review approval check: 32 exact subjects verified (25 listening+reading, 7 writing+rubric+blueprint+forms).');

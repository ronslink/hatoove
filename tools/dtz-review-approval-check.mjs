#!/usr/bin/env node
/**
 * Offline verification for `server/owned-postgres/dtz-review-approval.mjs`.
 *
 * Ensures:
 *   1. All 25 pinned DTZ listening + reading subjects match `packageHash` in `listening-package.json`.
 *   2. DTZ writing tasks, rubric, blueprint and forms are excluded (never silently approved).
 *   3. Metadata, evidence SHA-256 and deterministic event UUIDs satisfy the 0035 review contract.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { packageHash } from '../server/package-contract.mjs';
import { DTZ_APPROVED_SUBJECTS, DTZ_APPROVAL_META, deterministicEventUuid } from '../server/owned-postgres/dtz-review-approval.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(await readFile(path.join(ROOT, 'content', 'exams', 'dtz-a2-b1', 'listening-package.json'), 'utf8'));

const expected = [
  ...pkg.sets.map((s) => ({ id: `${s.setId}@${s.version}`, sha256: packageHash(s), category: 'educational', language: '' })),
  ...pkg.media.map((m) => ({ id: `${m.mediaId}@${m.version}`, sha256: packageHash(m), category: 'audio', language: 'de' })),
].sort((a, b) => a.id.localeCompare(b.id));

assert.equal(DTZ_APPROVED_SUBJECTS.length, 25, 'expected 4 HV sets + 16 HV WAVs + 5 LV sets = 25 subjects');
assert.deepEqual(DTZ_APPROVED_SUBJECTS, expected, 'pinned DTZ approval hashes must match listening-package.json verbatim');

const excludedIds = new Set([
  ...pkg.writingTasks.map((t) => `${t.taskId}@${t.version}`),
  ...pkg.rubrics.map((r) => `${r.rubricId}@${r.version}`),
]);
for (const entry of DTZ_APPROVED_SUBJECTS) {
  assert(!excludedIds.has(entry.id), `writing/rubric subject must not be in listening+reading approval: ${entry.id}`);
  assert(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(deterministicEventUuid(entry.id)));
}

assert.equal(DTZ_APPROVAL_META.reviewerId, 'ron-product-owner');
assert(/^[0-9a-f]{64}$/.test(DTZ_APPROVAL_META.evidenceSha256));
console.log(`DTZ review approval check: 25 exact subjects verified (writing/rubric/blueprint/forms excluded).`);

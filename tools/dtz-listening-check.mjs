#!/usr/bin/env node
/**
 * DTZ-LISTENING-01 — offline contract, determinism and privacy check for `content/exams/dtz-a2-b1/listening-package.json`.
 *
 * Verifies:
 *   1. `listening-package.json` validates against `server/package-contract.mjs#validatePackage`.
 *   2. Rebuilding deterministically via `tools/dtz-listening-package-build.mjs` matches `packageHash` verbatim.
 *   3. No transcript, answer key or explanation leaks into any public `payload` (`assertPublicPayload`).
 *   4. Exact DTZ Hören shape: HV1 (4 items, 4 recordings), HV2 (5 items, 5 recordings), HV3 (8 items, 4 recordings,
 *      each pairing a richtig/falsch item with an a/b/c item), HV4 (3 items, 3 recordings, a-f options), IDs 1..20,
 *      16 distinct WAV recordings, `playback: { practice: 1, mock: 1 }`.
 *   5. Complete written form `dtz-a2-b1.complete.original01@v1` matches the `0034-complete-dtz-admission.sql` contract:
 *      sections ["HV","LV","SA"], timeGroups 1500/2700/1800 (6000s), 9 members in HV1..HV4 + LV1..LV5 order,
 *      1 writingChoices group (A/B), `ordered-fixed-v1`, `release.state === 'internal'`.
 *   6. All authored content and media remain honestly marked `reviewStatus: 'unreviewed'` and `rightsStatus: 'generated'`.
 *
 * Usage: node tools/dtz-listening-check.mjs
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validatePackage, packageHash, assertPublicPayload } from '../server/package-contract.mjs';
import { buildDtzListeningPackage } from './dtz-listening-package-build.mjs';
import { buildBundledDtzAvailablePackage } from '../server/owned-postgres/package-importer.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PKG_PATH = path.join(ROOT, 'content', 'exams', 'dtz-a2-b1', 'listening-package.json');

let passed = 0;
async function check(name, fn) {
  await fn();
  passed += 1;
  console.log('PASS ' + name);
}

const pkg = JSON.parse(await readFile(PKG_PATH, 'utf8'));

await check('package validates under server/package-contract.mjs', async () => {
  validatePackage(pkg);
  assert.equal(pkg.exam.id, 'dtz-a2-b1');
  assert.equal(pkg.release.state, 'internal');
});

await check('listening-package.json matches deterministic builder hash', async () => {
  const rebuilt = await buildDtzListeningPackage();
  assert.equal(
    packageHash(rebuilt),
    packageHash(pkg),
    'content/exams/dtz-a2-b1/listening-package.json is stale: re-run node tools/dtz-listening-package-build.mjs'
  );
});

await check('public payloads carry no transcripts, answers or explanations', async () => {
  for (const set of pkg.sets) {
    assertPublicPayload(set.payload);
    const json = JSON.stringify(set.payload);
    assert(!json.includes('[Durchsage]') && !json.includes('[Moderator'), `${set.setId} leaked speaker transcript`);
  }
});

await check('HV1-HV4 match exact DTZ counts, playback rules and question shapes', async () => {
  const hvSection = pkg.blueprint.sections.find((s) => s.id === 'HV');
  assert(hvSection, 'missing HV section');
  assert.deepEqual(
    hvSection.parts.map((p) => [p.family, p.itemCount, p.interaction, p.mediaRequired, p.playback]),
    [
      ['HV1', 4, 'fixed_audio', true, { practice: 1, mock: 1 }],
      ['HV2', 5, 'fixed_audio', true, { practice: 1, mock: 1 }],
      ['HV3', 8, 'fixed_audio', true, { practice: 1, mock: 1 }],
      ['HV4', 3, 'fixed_audio', true, { practice: 1, mock: 1 }],
    ]
  );

  const hvSets = pkg.sets.filter((s) => s.section === 'HV');
  assert.equal(hvSets.length, 4);
  const expectedRecCounts = [4, 5, 4, 3];
  const seenIds = [];
  const seenMedia = new Set();

  hvSets.forEach((set, idx) => {
    assert.equal(set.payload.recordings.length, expectedRecCounts[idx], `${set.family} recording count`);
    for (const rec of set.payload.recordings) {
      const key = `${rec.mediaId}@${rec.mediaVersion}`;
      assert(!seenMedia.has(key), `duplicate media ${key}`);
      seenMedia.add(key);
      if (set.family === 'HV3') {
        assert.equal(rec.questions.length, 2, `${rec.id} must have 2 questions`);
        assert.deepEqual(Object.keys(rec.questions[0].options), ['richtig', 'falsch']);
        assert.deepEqual(Object.keys(rec.questions[1].options), ['a', 'b', 'c']);
      } else if (set.family === 'HV4') {
        assert.equal(rec.questions.length, 1);
        assert.deepEqual(Object.keys(rec.questions[0].options), ['a', 'b', 'c', 'd', 'e', 'f']);
      } else {
        assert.equal(rec.questions.length, 1);
        assert.deepEqual(Object.keys(rec.questions[0].options), ['a', 'b', 'c']);
      }
      for (const q of rec.questions) {
        seenIds.push(q.n);
        assert(Object.prototype.hasOwnProperty.call(set.answers, String(q.n)), `missing answer for ${q.n}`);
        assert(Object.prototype.hasOwnProperty.call(q.options, set.answers[String(q.n)]), `answer outside options for ${q.n}`);
        assert(typeof set.explanations[String(q.n)] === 'string' && set.explanations[String(q.n)].trim().length > 0, `missing explanation for ${q.n}`);
      }
    }
  });

  assert.deepEqual(seenIds, Array.from({ length: 20 }, (_, i) => i + 1));
  assert.equal(seenMedia.size, 16);
  assert.equal(pkg.media.length, 16);
});

await check('complete written form satisfies 0034-complete-dtz-admission structure', async () => {
  assert.deepEqual(pkg.blueprint.timeGroups, [
    { id: 'dtz-hv-25', seconds: 1500, sections: ['HV'] },
    { id: 'dtz-lv-45', seconds: 2700, sections: ['LV'] },
    { id: 'dtz-sa-30', seconds: 1800, sections: ['SA'] },
  ]);
  const complete = pkg.forms.find((f) => f.scope === 'complete_supported_written');
  assert(complete, 'missing complete_supported_written form');
  assert.deepEqual(complete.sections, ['HV', 'LV', 'SA']);
  assert.equal(complete.mode, 'timed');
  assert.equal(complete.timeLimitSeconds, 6000);
  assert.equal(complete.attemptMode, 'mock');
  assert.equal(complete.timingPolicy, 'ordered-fixed-v1');
  assert.equal(complete.feedback, 'finalise');
  assert.equal(complete.members.length, 9);
  assert.equal(complete.writingChoices.length, 1);
  assert.deepEqual(complete.writingChoices[0].options.map((o) => o.id), ['A', 'B']);
});

await check('provenance stays honestly unreviewed and generated', async () => {
  for (const row of [...pkg.sets, ...pkg.media, ...pkg.writingTasks, ...pkg.rubrics]) {
    assert.equal(row.reviewStatus, 'unreviewed');
    assert.equal(row.rightsStatus, 'generated');
  }
});

await check('reference-only v5 available promotion package validates cleanly', async () => {
  const available = buildBundledDtzAvailablePackage(pkg);
  validatePackage(available);
  assert.equal(available.release.version, 'v5');
  assert.equal(available.release.state, 'available');
  assert.deepEqual(available.sets, []);
  assert.deepEqual(available.media, []);
  assert.deepEqual(available.writingTasks, []);
  assert.deepEqual(available.rubrics, []);
  assert.equal(available.forms.some((f) => f.scope === 'complete_supported_written'), true);
});

console.log(`DTZ listening check: ${passed} passed, 0 failed.`);

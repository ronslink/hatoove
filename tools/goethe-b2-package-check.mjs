#!/usr/bin/env node
/**
 * Offline verification of the Goethe-Zertifikat B2 exam package:
 * - LV1–LV5 (30 items) + Writing (Tasks A/B + writing.goethe-b2@v1 rubric)
 * - Listening transcripts & speaker mapping (HV1–HV4, 30 items across 8 recordings, playback 1/2/1/2)
 * - Complete written form v2 (LV 65m + HV 40m + SA 75m = 180m) + all 8 WAV hashes & PCM durations
 * - Stub grader + DeepSeek live grader compatibility
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { validatePackage, validateCompleteForm } from '../server/package-contract.mjs';
import { parsePcmWav } from '../server/media-contract.mjs';
import { supportedWritingPolicy, GOETHE_B2_POLICY, GOETHE_B2_KIND, GOETHE_B2_KEYS } from '../server/writing-policy.mjs';
import { stubGrade, validateAssessment } from '../server/owned-postgres/worker.mjs';
import { buildWritingPrompt, parseDeepSeekAssessment } from '../server/writing-grader-deepseek.mjs';
import { segmentTranscript } from './goethe-b2-listening-tts-build.mjs';

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log('PASS ' + name);
}

const manifest = JSON.parse(readFileSync(new URL('../content/exams/goethe-zertifikat-b2/manifest.json', import.meta.url), 'utf8'));
const listeningSource = JSON.parse(readFileSync(new URL('../content/exams/goethe-zertifikat-b2/listening-source.json', import.meta.url), 'utf8'));

check('manifest.json passes validatePackage with 30 LV items, 2 writing tasks and rubric v1', () => {
  const validated = validatePackage(manifest);
  assert.equal(validated.exam.id, 'goethe-zertifikat-b2');
  assert.equal(validated.release.state, 'internal');
  assert.equal(validated.sets.length, 5);
  assert.equal(validated.sets.reduce((n, s) => n + s.itemCount, 0), 30);
  assert.deepEqual(validated.sets.map((s) => [s.family, s.itemCount, s.interaction]), [
    ['LV1', 9, 'single_choice'],
    ['LV2', 6, 'gap_bank'],
    ['LV3', 6, 'single_choice'],
    ['LV4', 6, 'matching_headlines'],
    ['LV5', 3, 'single_choice'],
  ]);
  for (const s of validated.sets) assert.equal(Object.keys(s.explanations).length, s.itemCount, `${s.setId} missing explanations`);
  assert.equal(validated.writingTasks.length, 2);
  assert.equal(validated.rubrics.length, 1);
});

check('writing.goethe-b2@v1 passes supportedWritingPolicy, stubGrade and DeepSeek parser validation', () => {
  const rawRubric = manifest.rubrics[0];
  const rubric = { ...rawRubric, feedback_kind: rawRubric.feedbackKind };
  assert.equal(supportedWritingPolicy(rubric, 'goethe-zertifikat-b2'), true);
  assert.equal(supportedWritingPolicy(rubric, 'goethe-zertifikat-b1'), false);

  const sampleText = 'Künstliche Intelligenz kann das Lernen sinnvoll unterstützen, sofern klare Regeln gelten. Besonders hilfreich sind individuelle Rückmeldungen zu eigenen Texten. Gleichzeitig sollten Lernende stets kritisch prüfen, ob die Ergebnisse sachlich zutreffen.';
  const stub = stubGrade({ text: sampleText, explanationLanguage: 'de', rubric, policy: GOETHE_B2_POLICY });
  assert.equal(stub.feedback.kind, GOETHE_B2_KIND);
  assert.equal(stub.modelVersion, 'goethe-b2-simulation-v1');
  assert.equal(validateAssessment(stub, { rubric, text: sampleText }).feedback.criteria.length, 4);

  const prompt = buildWritingPrompt({ text: sampleText, rubric, policy: GOETHE_B2_POLICY, explanationLanguage: 'en', task: manifest.writingTasks[0] });
  assert(prompt.system.includes('Goethe-Zertifikat B2'));
  const parsed = parseDeepSeekAssessment(
    JSON.stringify({
      criteria: GOETHE_B2_KEYS.map((key) => ({
        key,
        band: 'B',
        evidence: 'Besonders hilfreich sind individuelle Rückmeldungen zu eigenen Texten.',
        comment: 'Well-structured B2 argumentation.',
      })),
      corrections: ['Überzeugende Verknüpfung der Argumente.'],
    }),
    { text: sampleText, rubric, policy: GOETHE_B2_POLICY, model: 'deepseek-chat' },
  );
  assert.equal(validateAssessment(parsed, { rubric, text: sampleText }).feedback.kind, GOETHE_B2_KIND);
});

check('listening-source.json has 30 HV items across 8 recordings with valid speaker turns and 1/2/1/2 playback', () => {
  assert.equal(listeningSource.examId, 'goethe-zertifikat-b2');
  assert.equal(listeningSource.parts.length, 4);
  assert.deepEqual(listeningSource.parts.map((p) => p.recordings.reduce((n, r) => n + r.questions.length, 0)), [10, 6, 6, 8]);
  assert.equal(listeningSource.parts.reduce((n, p) => n + p.recordings.length, 0), 8);
  assert.deepEqual(listeningSource.parts.map((p) => [p.family, p.playback.practice, p.playback.mock]), [
    ['HV1', 1, 1],
    ['HV2', 1, 2],
    ['HV3', 1, 1],
    ['HV4', 1, 2],
  ]);
  for (const part of listeningSource.parts) {
    for (const rec of part.recordings) {
      assert(segmentTranscript(rec.transcript).length > 0, `${rec.id} has no turns`);
      for (const q of rec.questions) {
        assert(Object.hasOwn(q.options, q.answer), `${rec.id} Q${q.n} answer not in options`);
        assert(typeof q.explanation === 'string' && q.explanation.trim().length > 0);
      }
    }
  }
});

check('listening-package.json (v2) passes validatePackage, validateCompleteForm and all 8 WAV byte/hash/PCM checks', () => {
  const pkg = JSON.parse(readFileSync(new URL('../content/exams/goethe-zertifikat-b2/listening-package.json', import.meta.url), 'utf8'));
  const validated = validatePackage(pkg);
  assert.equal(validated.release.version, 'v2');
  assert.equal(validated.release.state, 'internal');
  assert.equal(validated.forms.length, 3);
  assert.equal(validated.sets.length, 9);
  assert.equal(validated.media.length, 8);
  const complete = validated.forms.find((f) => f.scope === 'complete_supported_written');
  assert(complete, 'missing complete_supported_written form');
  validateCompleteForm(validated.exam, validated.blueprint, complete);

  const badBlueprint = structuredClone(validated.blueprint);
  badBlueprint.sections[1].parts[0].playback.mock = 2; // Goethe B2 HV1 is 1x only
  assert.throws(() => validateCompleteForm(validated.exam, badBlueprint, complete), /incorrect target playback policy/);

  for (const m of validated.media) {
    const bytes = readFileSync(new URL('../' + m.path, import.meta.url));
    assert.equal(bytes.length, m.byteLength, `${m.mediaId} byteLength mismatch`);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), m.sha256, `${m.mediaId} sha256 mismatch`);
    assert.equal(parsePcmWav(bytes).durationMs, m.durationMs, `${m.mediaId} durationMs mismatch`);
  }
});

console.log(`Goethe-Zertifikat B2 package check: ${passed} passed, 0 failed.`);

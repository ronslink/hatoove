#!/usr/bin/env node
/**
 * Offline verification of the telc Deutsch B2 exam package:
 * - LV1–LV3 + SB1–SB2 (40 items) + Writing (Tasks A/B + writing.telc-b2@v1 rubric)
 * - Listening transcripts & speaker mapping (HV1–HV3, 20 items across 11 recordings, 1x playback)
 * - Complete written form v2 (LV+SB 90m + HV 20m + SA 30m = 140m) + all 11 WAV hashes & PCM durations
 * - Stub grader + DeepSeek live grader compatibility
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { validatePackage, validateCompleteForm, packageHash } from '../server/package-contract.mjs';
import { parsePcmWav } from '../server/media-contract.mjs';
import { TELC_B2_APPROVED_SUBJECTS } from '../server/owned-postgres/telc-b2-review-approval.mjs';
import { buildBundledTelcB2AvailablePackage } from '../server/owned-postgres/package-importer.mjs';
import { supportedWritingPolicy, TELC_B2_POLICY, TELC_B2_KIND, TELC_B2_KEYS } from '../server/writing-policy.mjs';
import { stubGrade, validateAssessment } from '../server/owned-postgres/worker.mjs';
import { buildWritingPrompt, parseDeepSeekAssessment } from '../server/writing-grader-deepseek.mjs';
import { segmentTranscript } from './telc-b2-listening-tts-build.mjs';

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log('PASS ' + name);
}

const manifest = JSON.parse(readFileSync(new URL('../content/exams/telc-deutsch-b2/manifest.json', import.meta.url), 'utf8'));
const listeningSource = JSON.parse(readFileSync(new URL('../content/exams/telc-deutsch-b2/listening-source.json', import.meta.url), 'utf8'));

check('manifest.json passes validatePackage with 40 LV+SB items, 2 writing tasks and rubric v1', () => {
  const validated = validatePackage(manifest);
  assert.equal(validated.exam.id, 'telc-deutsch-b2');
  assert.equal(validated.release.state, 'internal');
  assert.equal(validated.sets.length, 5);
  assert.equal(validated.sets.reduce((n, s) => n + s.itemCount, 0), 40);
  assert.deepEqual(validated.sets.map((s) => [s.family, s.itemCount, s.interaction]), [
    ['LV1', 5, 'matching_headlines'],
    ['LV2', 5, 'single_choice'],
    ['LV3', 10, 'matching_ads'],
    ['SB1', 10, 'gap_choice'],
    ['SB2', 10, 'gap_bank'],
  ]);
  for (const s of validated.sets) assert.equal(Object.keys(s.explanations).length, s.itemCount, `${s.setId} missing explanations`);
  assert.equal(validated.writingTasks.length, 2);
  assert.equal(validated.rubrics.length, 1);
});

check('writing.telc-b2@v1 passes supportedWritingPolicy, stubGrade and DeepSeek parser validation', () => {
  const rawRubric = manifest.rubrics[0];
  const rubric = { ...rawRubric, feedback_kind: rawRubric.feedbackKind };
  assert.equal(supportedWritingPolicy(rubric, 'telc-deutsch-b2'), true);
  assert.equal(supportedWritingPolicy(rubric, 'goethe-zertifikat-b1'), false);

  const sampleText = 'Sehr geehrte Damen und Herren, ich interessiere mich sehr für Ihre berufsbegleitende Weiterbildung im Projektmanagement. Da ich seit vier Jahren in der Logistik arbeite, möchte ich meine Kenntnisse gezielt erweitern. Könnten Sie mir bitte mitteilen, wie hoch die Gesamtkosten sind?';
  const stub = stubGrade({ text: sampleText, explanationLanguage: 'de', rubric, policy: TELC_B2_POLICY });
  assert.equal(stub.feedback.kind, TELC_B2_KIND);
  assert.equal(stub.modelVersion, 'telc-b2-simulation-v1');
  assert.equal(validateAssessment(stub, { rubric, text: sampleText }).feedback.criteria.length, 4);

  const prompt = buildWritingPrompt({ text: sampleText, rubric, policy: TELC_B2_POLICY, explanationLanguage: 'en', task: manifest.writingTasks[0] });
  assert(prompt.system.includes('telc Deutsch B2'));
  const parsed = parseDeepSeekAssessment(
    JSON.stringify({
      criteria: TELC_B2_KEYS.map((key) => ({
        key,
        band: 'B',
        evidence: 'Da ich seit vier Jahren in der Logistik arbeite, möchte ich meine Kenntnisse gezielt erweitern.',
        comment: 'Clear formal B2 register and structure.',
      })),
      corrections: ['Guter Einstieg und höfliche Formulierung.'],
    }),
    { text: sampleText, rubric, policy: TELC_B2_POLICY, model: 'deepseek-chat' },
  );
  assert.equal(validateAssessment(parsed, { rubric, text: sampleText }).feedback.kind, TELC_B2_KIND);
});

check('listening-source.json has 20 HV items across 11 recordings with valid speaker turns and 1x playback', () => {
  assert.equal(listeningSource.examId, 'telc-deutsch-b2');
  assert.equal(listeningSource.parts.length, 3);
  assert.deepEqual(listeningSource.parts.map((p) => p.recordings.reduce((n, r) => n + r.questions.length, 0)), [5, 10, 5]);
  assert.equal(listeningSource.parts.reduce((n, p) => n + p.recordings.length, 0), 11);
  for (const part of listeningSource.parts) {
    assert.deepEqual(part.playback, { practice: 1, mock: 1 });
    for (const rec of part.recordings) {
      assert(segmentTranscript(rec.transcript).length > 0, `${rec.id} has no turns`);
      for (const q of rec.questions) {
        assert(Object.hasOwn(q.options, q.answer), `${rec.id} Q${q.n} answer not in options`);
        assert(typeof q.explanation === 'string' && q.explanation.trim().length > 0);
      }
    }
  }
});

check('listening-package.json (v2) passes validatePackage, validateCompleteForm and all 11 WAV byte/hash/PCM checks', () => {
  const pkg = JSON.parse(readFileSync(new URL('../content/exams/telc-deutsch-b2/listening-package.json', import.meta.url), 'utf8'));
  const validated = validatePackage(pkg);
  assert.equal(validated.release.version, 'v2');
  assert.equal(validated.release.state, 'internal');
  assert.equal(validated.forms.length, 3);
  assert.equal(validated.sets.length, 8);
  assert.equal(validated.media.length, 11);
  const complete = validated.forms.find((f) => f.scope === 'complete_supported_written');
  assert(complete, 'missing complete_supported_written form');
  validateCompleteForm(validated.exam, validated.blueprint, complete);

  const badBlueprint = structuredClone(validated.blueprint);
  badBlueprint.sections[2].parts[0].playback.mock = 2; // telc B2 HV is 1x only
  assert.throws(() => validateCompleteForm(validated.exam, badBlueprint, complete), /incorrect target playback policy/);

  for (const m of validated.media) {
    const bytes = readFileSync(new URL('../' + m.path, import.meta.url));
    assert.equal(bytes.length, m.byteLength, `${m.mediaId} byteLength mismatch`);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), m.sha256, `${m.mediaId} sha256 mismatch`);
    assert.equal(parsePcmWav(bytes).durationMs, m.durationMs, `${m.mediaId} durationMs mismatch`);
  }

  const expected = new Map([
    ...validated.media.map((m) => [`content:${m.mediaId}@${m.version}:`, packageHash(m)]),
    ...validated.sets.map((s) => [`content:${s.setId}@${s.version}:`, packageHash(s)]),
    ...validated.writingTasks.map((t) => [`content:${t.taskId}@${t.version}:`, packageHash(t)]),
    ...validated.rubrics.map((r) => [`content:${r.rubricId}@${r.version}:`, packageHash(r)]),
    [`blueprint:${validated.exam.id}:${validated.blueprint.version}`, packageHash({ exam: validated.exam, blueprint: validated.blueprint })],
    ...validated.forms.map((f) => [`form:${f.id}:${f.version}`, packageHash({ blueprintVersion: validated.blueprint.version, form: f })]),
  ]);
  assert.equal(TELC_B2_APPROVED_SUBJECTS.length, expected.size, 'approval list covers every v2 subject');
  for (const item of TELC_B2_APPROVED_SUBJECTS) {
    const key = `${item.kind}:${item.id}:${item.version}`;
    assert.equal(item.sha256, expected.get(key), `approved sha mismatch for ${key}`);
  }
  const availablePkg = validatePackage(buildBundledTelcB2AvailablePackage(validated));
  assert.equal(availablePkg.release.version, 'v3');
  assert.equal(availablePkg.release.state, 'available');
  assert.equal(availablePkg.sets.length, 0);
  assert.equal(availablePkg.media.length, 0);
});

console.log(`telc Deutsch B2 package check: ${passed} passed, 0 failed.`);

#!/usr/bin/env node
/**
 * Offline verification of the Goethe-Zertifikat B1 exam package:
 * - Reading (LV1–LV5, 30 items) + Writing (Tasks A/B + writing.goethe-b1@v1 rubric)
 * - Listening transcripts & speaker mapping (HV1–HV4, 30 items across 8 recordings)
 * - Complete written form contract (LV 65m + HV 40m + SA 60m = 165m, playback 2/1/1/2)
 * - Stub grader + DeepSeek live grader prompt/parser compatibility
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validatePackage, validateCompleteForm } from '../server/package-contract.mjs';
import { supportedWritingPolicy, GOETHE_B1_POLICY, GOETHE_B1_KIND, GOETHE_B1_KEYS } from '../server/writing-policy.mjs';
import { stubGrade, validateAssessment } from '../server/owned-postgres/worker.mjs';
import { buildWritingPrompt, parseDeepSeekAssessment } from '../server/writing-grader-deepseek.mjs';
import { segmentTranscript } from './goethe-b1-listening-tts-build.mjs';

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log('PASS ' + name);
}

const manifest = JSON.parse(readFileSync(new URL('../content/exams/goethe-zertifikat-b1/manifest.json', import.meta.url), 'utf8'));
const listeningSource = JSON.parse(readFileSync(new URL('../content/exams/goethe-zertifikat-b1/listening-source.json', import.meta.url), 'utf8'));

check('manifest.json passes validatePackage with 30 LV items, 2 writing tasks and rubric v1', () => {
  const validated = validatePackage(manifest);
  assert.equal(validated.exam.id, 'goethe-zertifikat-b1');
  assert.equal(validated.release.state, 'internal');
  assert.equal(validated.sets.length, 5);
  assert.equal(validated.sets.reduce((n, s) => n + s.itemCount, 0), 30);
  assert.deepEqual(validated.sets.map((s) => [s.family, s.itemCount, s.interaction]), [
    ['LV1', 6, 'single_choice'],
    ['LV2', 6, 'grouped_choice'],
    ['LV3', 7, 'matching_ads'],
    ['LV4', 7, 'single_choice'],
    ['LV5', 4, 'single_choice'],
  ]);
  for (const s of validated.sets) {
    assert.equal(Object.keys(s.explanations).length, s.itemCount, `${s.setId} missing explanations`);
  }
  assert.equal(validated.writingTasks.length, 2);
  assert.equal(validated.rubrics.length, 1);
  assert.equal(validated.forms.length, 3);
});

check('writing.goethe-b1@v1 passes supportedWritingPolicy, stubGrade and DeepSeek parser validation', () => {
  const rawRubric = manifest.rubrics[0];
  const rubric = { ...rawRubric, feedback_kind: rawRubric.feedbackKind };
  assert.equal(supportedWritingPolicy(rubric, 'goethe-zertifikat-b1'), true);
  assert.equal(supportedWritingPolicy(rubric, 'dtz-a2-b1'), false);

  const sampleText = 'Lieber Tobias, ich bin endlich in meine neue Wohnung eingezogen! Sie ist sehr hell und liegt direkt am Park. Am Samstag um 18 Uhr mache ich eine kleine Einweihungsfeier. Sag mir bitte Bescheid, ob du kommen kannst.';
  const stub = stubGrade({ text: sampleText, explanationLanguage: 'de', rubric, policy: GOETHE_B1_POLICY });
  assert.equal(stub.feedback.kind, GOETHE_B1_KIND);
  assert.equal(stub.modelVersion, 'goethe-b1-simulation-v1');
  const validatedStub = validateAssessment(stub, { rubric, text: sampleText });
  assert.equal(validatedStub.feedback.criteria.length, 4);

  const prompt = buildWritingPrompt({ text: sampleText, rubric, policy: GOETHE_B1_POLICY, explanationLanguage: 'en', task: manifest.writingTasks[0] });
  assert(prompt.system.includes('Goethe-Zertifikat B1'));
  const parsed = parseDeepSeekAssessment(
    JSON.stringify({
      criteria: GOETHE_B1_KEYS.map((key) => ({
        key,
        band: 'B',
        evidence: 'Sie ist sehr hell und liegt direkt am Park.',
        comment: 'Clear and appropriate B1 response.',
      })),
      corrections: ['Gute Struktur und passende Anrede.'],
    }),
    {
      text: sampleText,
      rubric,
      policy: GOETHE_B1_POLICY,
      model: 'deepseek-chat',
    },
  );
  const validatedLive = validateAssessment(parsed, { rubric, text: sampleText });
  assert.equal(validatedLive.feedback.kind, GOETHE_B1_KIND);
  assert.equal(validatedLive.feedback.criteria.length, 4);
});

check('listening-source.json has 30 HV items across 8 recordings with valid speaker turns and playback rules', () => {
  assert.equal(listeningSource.examId, 'goethe-zertifikat-b1');
  assert.equal(listeningSource.parts.length, 4);
  const counts = listeningSource.parts.map((p) => p.recordings.reduce((n, r) => n + r.questions.length, 0));
  assert.deepEqual(counts, [10, 5, 7, 8]);
  const totalRecordings = listeningSource.parts.reduce((n, p) => n + p.recordings.length, 0);
  assert.equal(totalRecordings, 8);
  assert.deepEqual(listeningSource.parts.map((p) => [p.family, p.playback.practice, p.playback.mock]), [
    ['HV1', 1, 2],
    ['HV2', 1, 1],
    ['HV3', 1, 1],
    ['HV4', 1, 2],
  ]);
  for (const part of listeningSource.parts) {
    for (const rec of part.recordings) {
      const turns = segmentTranscript(rec.transcript);
      assert(turns.length > 0, `${rec.id} has no turns`);
      for (const q of rec.questions) {
        assert(Object.hasOwn(q.options, q.answer), `${rec.id} Q${q.n} answer not in options`);
        assert(typeof q.explanation === 'string' && q.explanation.trim().length > 0, `${rec.id} Q${q.n} missing explanation`);
      }
    }
  }
});

check('validateCompleteForm accepts valid complete Goethe B1 v2 blueprint and refuses wrong playback', () => {
  const completeBlueprint = {
    version: 'v2',
    timeGroups: [
      { id: 'goethe-b1-lv-65', seconds: 3900, sections: ['LV'] },
      { id: 'goethe-b1-hv-40', seconds: 2400, sections: ['HV'] },
      { id: 'goethe-b1-sa-60', seconds: 3600, sections: ['SA'] },
    ],
    sections: [
      manifest.blueprint.sections[0],
      {
        id: 'HV',
        title: 'Hören',
        timeGroup: 'goethe-b1-hv-40',
        parts: [
          { family: 'HV1', itemCount: 10, interaction: 'fixed_audio', mediaRequired: true, playback: { practice: 1, mock: 2 } },
          { family: 'HV2', itemCount: 5, interaction: 'fixed_audio', mediaRequired: true, playback: { practice: 1, mock: 1 } },
          { family: 'HV3', itemCount: 7, interaction: 'fixed_audio', mediaRequired: true, playback: { practice: 1, mock: 1 } },
          { family: 'HV4', itemCount: 8, interaction: 'fixed_audio', mediaRequired: true, playback: { practice: 1, mock: 2 } },
        ],
      },
      manifest.blueprint.sections[1],
    ],
    assessment: manifest.blueprint.assessment,
    sources: manifest.blueprint.sources,
  };
  const completeForm = {
    id: 'goethe-zertifikat-b1.complete.original01',
    version: 'v1',
    title: 'Goethe-Zertifikat B1 — Vollständige schriftliche Probeprüfung',
    scope: 'complete_supported_written',
    sections: ['LV', 'HV', 'SA'],
    mode: 'timed',
    attemptMode: 'mock',
    timingPolicy: 'ordered-fixed-v1',
    timeLimitSeconds: 9900,
    feedback: 'finalise',
    members: [
      { setId: 'goethe-zertifikat-b1.lv1.original01', version: 'v1', interaction: 'single_choice', itemCount: 6 },
      { setId: 'goethe-zertifikat-b1.lv2.original01', version: 'v1', interaction: 'grouped_choice', itemCount: 6 },
      { setId: 'goethe-zertifikat-b1.lv3.original01', version: 'v1', interaction: 'matching_ads', itemCount: 7 },
      { setId: 'goethe-zertifikat-b1.lv4.original01', version: 'v1', interaction: 'single_choice', itemCount: 7 },
      { setId: 'goethe-zertifikat-b1.lv5.original01', version: 'v1', interaction: 'single_choice', itemCount: 4 },
      { setId: 'goethe-zertifikat-b1.hv1.original01', version: 'v1', interaction: 'fixed_audio', itemCount: 10 },
      { setId: 'goethe-zertifikat-b1.hv2.original01', version: 'v1', interaction: 'fixed_audio', itemCount: 5 },
      { setId: 'goethe-zertifikat-b1.hv3.original01', version: 'v1', interaction: 'fixed_audio', itemCount: 7 },
      { setId: 'goethe-zertifikat-b1.hv4.original01', version: 'v1', interaction: 'fixed_audio', itemCount: 8 },
    ],
    writingChoices: [
      {
        id: 'SA1',
        section: 'SA',
        options: [
          { id: 'A', taskId: 'goethe-zertifikat-b1.writing.original01.a', taskVersion: 'v1' },
          { id: 'B', taskId: 'goethe-zertifikat-b1.writing.original01.b', taskVersion: 'v1' },
        ],
      },
    ],
  };
  validateCompleteForm(manifest.exam, completeBlueprint, completeForm);

  const badBlueprint = structuredClone(completeBlueprint);
  badBlueprint.sections[1].parts[0].playback.mock = 1; // HV1 must be 2 plays in mock
  assert.throws(() => validateCompleteForm(manifest.exam, badBlueprint, completeForm), /incorrect target playback policy/);
});

console.log(`Goethe-Zertifikat B1 package check: ${passed} passed, 0 failed.`);

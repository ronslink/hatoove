#!/usr/bin/env node
/**
 * DTZ-LISTENING-01 — deterministic builder for `content/exams/dtz-a2-b1/listening-package.json`.
 *
 * Combines:
 *   - `content/exams/dtz-a2-b1/listening-source.json` (HV1-HV4 questions, keys, explanations; transcripts stripped)
 *   - `content/exams/dtz-a2-b1/listening-media.json`  (verified WAV descriptors)
 *   - `content/exams/dtz-a2-b1/manifest.json`         (LV1-LV5 reading blueprint & sets)
 *   - `content/exams/dtz-a2-b1/writing-manifest.json` (SA writing tasks, rubric & blueprint)
 *
 * Emits blueprint `v4` / release `v4` (`state: "internal"`) containing:
 *   1. `dtz-a2-b1.listening.practice@v1`  (untimed HV section practice)
 *   2. `dtz-a2-b1.listening.mock@v1`      (timed 1500s HV section mock)
 *   3. `dtz-a2-b1.complete.original01@v1` (complete_supported_written: HV 1500s + LV 2700s + SA 1800s = 6000s,
 *                                          9 objective members + writingChoices A/B, ordered-fixed-v1)
 *
 * Deterministic: no clock, no network, no provider. Run it after updating source/media, then validate.
 *
 * Usage: node tools/dtz-listening-package-build.mjs
 */
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validatePackage } from '../server/package-contract.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXAM = 'dtz-a2-b1';
const DIR = path.join(ROOT, 'content', 'exams', EXAM);
const SOURCE_PATH = path.join(DIR, 'listening-source.json');
const MEDIA_PATH = path.join(DIR, 'listening-media.json');
const READING_PATH = path.join(DIR, 'manifest.json');
const WRITING_PATH = path.join(DIR, 'writing-manifest.json');
const OUT_PATH = path.join(DIR, 'listening-package.json');

const BLUEPRINT_VERSION = 'v4';
const RELEASE_VERSION = 'v4';
const HV_SECONDS = 1500;
const LV_SECONDS = 2700;
const SA_SECONDS = 1800;

export async function buildDtzListeningPackage() {
  const [source, mediaDoc, reading, writing] = await Promise.all([
    readFile(SOURCE_PATH, 'utf8').then(JSON.parse),
    readFile(MEDIA_PATH, 'utf8').then(JSON.parse),
    readFile(READING_PATH, 'utf8').then(JSON.parse),
    readFile(WRITING_PATH, 'utf8').then(JSON.parse),
  ]);

  const descriptors = new Map((mediaDoc.media || []).map((m) => [m.mediaId, m]));
  const hvSets = [];
  const hvParts = [];
  const setVersion = source.setVersion || 'v1';

  for (const part of source.parts) {
    const recordings = [];
    const answers = {};
    const explanations = {};
    let itemCount = 0;

    for (const rec of part.recordings) {
      const desc = descriptors.get(rec.mediaId);
      if (!desc) throw new Error(`missing media descriptor for ${rec.mediaId}`);
      const questions = [];
      for (const q of rec.questions) {
        const options = q.options ?? part.statementBank;
        if (!options) throw new Error(`missing options for item ${q.n}`);
        questions.push({ n: q.n, question: q.question, options });
        answers[String(q.n)] = q.answer;
        explanations[String(q.n)] = q.explanation;
        itemCount += 1;
      }
      recordings.push({
        id: rec.id,
        mediaId: desc.mediaId,
        mediaVersion: desc.version,
        label: rec.label,
        questions,
      });
    }

    hvParts.push({
      family: part.family,
      itemCount,
      interaction: 'fixed_audio',
      mediaRequired: true,
      playback: { practice: 1, mock: 1 },
    });

    hvSets.push({
      setId: part.setId,
      version: setVersion,
      examId: EXAM,
      family: part.family,
      section: 'HV',
      part: part.part,
      title: part.title,
      payload: { recordings },
      itemCount,
      interaction: 'fixed_audio',
      answers,
      explanations,
      reviewStatus: source.provenance.reviewStatus,
      rightsStatus: source.provenance.rightsStatus,
      source: source.provenance.source,
    });
  }

  const lvSection = structuredClone(reading.blueprint.sections.find((s) => s.id === 'LV'));
  const saSection = structuredClone(writing.blueprint.sections.find((s) => s.id === 'SA'));
  lvSection.timeGroup = 'dtz-lv-45';
  saSection.timeGroup = 'dtz-sa-30';

  const hvSection = {
    id: 'HV',
    title: 'Hörverstehen',
    timeGroup: 'dtz-hv-25',
    parts: hvParts,
  };

  const hvMembers = hvSets.map((s) => ({
    setId: s.setId,
    version: s.version,
    interaction: s.interaction,
    itemCount: s.itemCount,
  }));
  const lvMembers = structuredClone(reading.forms[0].members);
  const writingChoices = structuredClone(writing.forms[0].writingChoices);

  const pkg = {
    schemaVersion: 1,
    exam: structuredClone(reading.exam),
    blueprint: {
      version: BLUEPRINT_VERSION,
      timeGroups: [
        { id: 'dtz-hv-25', seconds: HV_SECONDS, sections: ['HV'] },
        { id: 'dtz-lv-45', seconds: LV_SECONDS, sections: ['LV'] },
        { id: 'dtz-sa-30', seconds: SA_SECONDS, sections: ['SA'] },
      ],
      sections: [hvSection, lvSection, saSection],
      assessment: structuredClone(reading.blueprint.assessment),
      sources: [
        source.provenance.formatReference,
        ...(writing.blueprint.sources || []),
      ],
    },
    release: {
      version: RELEASE_VERSION,
      state: 'internal',
      resumeBlockedReleases: [],
    },
    forms: [
      {
        id: 'dtz-a2-b1.complete.original01',
        version: 'v1',
        title: 'Schriftliche Prüfung · DTZ A2–B1 (Hören, Lesen, Schreiben)',
        scope: 'complete_supported_written',
        sections: ['HV', 'LV', 'SA'],
        mode: 'timed',
        timeLimitSeconds: HV_SECONDS + LV_SECONDS + SA_SECONDS,
        attemptMode: 'mock',
        timingPolicy: 'ordered-fixed-v1',
        feedback: 'finalise',
        members: [...hvMembers, ...lvMembers],
        writingChoices,
      },
      {
        id: 'dtz-a2-b1.listening.practice',
        version: 'v1',
        title: 'Hören · Übung (DTZ A2–B1)',
        scope: 'section',
        sections: ['HV'],
        mode: 'untimed',
        timeLimitSeconds: null,
        attemptMode: 'practice',
        feedback: 'finalise',
        members: hvMembers,
      },
      {
        id: 'dtz-a2-b1.listening.mock',
        version: 'v1',
        title: 'Hören · Prüfungsmodus (DTZ A2–B1)',
        scope: 'section',
        sections: ['HV'],
        mode: 'timed',
        timeLimitSeconds: HV_SECONDS,
        attemptMode: 'mock',
        feedback: 'finalise',
        members: hvMembers,
      },
    ],
    sets: [...hvSets, ...structuredClone(reading.sets)],
    media: structuredClone(mediaDoc.media),
    writingTasks: structuredClone(writing.writingTasks),
    rubrics: structuredClone(writing.rubrics),
  };

  validatePackage(pkg);
  return pkg;
}

async function main() {
  const pkg = await buildDtzListeningPackage();
  await writeFile(OUT_PATH, JSON.stringify(pkg, null, 2) + '\n', 'utf8');
  console.log(`Wrote ${path.relative(ROOT, OUT_PATH)} (${pkg.forms.length} forms, ${pkg.sets.length} sets, ${pkg.media.length} media, ${pkg.writingTasks.length} writing tasks)`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error('FAILED: ' + error.message); process.exitCode = 1; });
}
